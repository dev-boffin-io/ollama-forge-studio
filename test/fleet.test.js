'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FleetManager, render } = require('../lib/fleet');
const { EventBus, TYPES } = require('../lib/events');

const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function make(over = {}) {
  const bus = new EventBus();
  const started = [];
  const running = new Set();
  let n = 0;
  const fm = new FleetManager({ bus }).configure({
    createSession: async ({ agent }) => ({ id: `ses_${agent}${++n}` }),
    start: async (id, text) => { started.push({ id, text }); running.add(id); return true; },
    isRunning: (id) => running.has(id),
    ...over,
  }).attach();
  const finish = (id, final = 'ok') => { running.delete(id); bus.emit(TYPES.AGENT_FINISHED, { sessionId: id, final, isChild: false }); };
  return { bus, fm, started, finish, running };
}

test('event bus: seq, history replay, and a throwing listener does not break the others', () => {
  const bus = new EventBus(3);
  let hits = 0;
  bus.on('a', () => { throw new Error('boom'); });
  bus.on('a', () => hits++);
  for (let i = 0; i < 5; i++) bus.emit('a', { i });
  assert.equal(hits, 5);
  assert.deepEqual(bus.since(0).map((e) => e.seq), [3, 4, 5]);
  assert.deepEqual(bus.since(4).map((e) => e.i), [4]);
});

test('create a fleet, dispatch to one member and to all idle members', async () => {
  const { fm, started } = make();
  const f = await fm.create({ name: 'crew', members: [{ agent: 'build' }, { agent: 'plan' }] });
  assert.equal(f.members.length, 2);
  const [a, b] = f.members;
  assert.deepEqual((await fm.dispatch(f.id, { member: a.sessionId, task: 'do x' })).map((r) => r.status), ['started']);
  assert.equal((await fm.dispatch(f.id, { member: a.sessionId, task: 'again' }))[0].status, 'busy');
  const all = await fm.dispatch(f.id, { member: 'all', task: 'everyone' });
  assert.deepEqual(all.map((r) => r.sessionId), [b.sessionId]);
  assert.equal(started.length, 2);
  assert.equal(fm.status().counts.running, 2);
  await assert.rejects(fm.dispatch(f.id, { member: 'all', task: '  ' }), /empty/);
});

test('maxParallel queues extra members and starts them when a slot frees up', async () => {
  const { fm, started, finish } = make();
  fm.configure({ maxParallel: 2 });
  const f = await fm.create({ members: [{ agent: 'a' }, { agent: 'b' }, { agent: 'c' }] });
  const r = await fm.dispatch(f.id, { task: 'go' });
  assert.deepEqual(r.map((x) => x.status), ['started', 'started', 'queued']);
  assert.equal(fm.status().queued, 1);
  finish(f.members[0].sessionId);
  await wait();
  assert.equal(started.length, 3);
  assert.equal(fm.status().queued, 0);
});

test('a link triggers the next agent with the previous report; failures only trigger on=failed|any', async () => {
  const { fm, started, finish, bus } = make();
  const f = await fm.create({ members: [{ agent: 'build' }, { agent: 'review' }, { agent: 'fixer' }] });
  const [b, r, x] = f.members;
  fm.link(f.id, { from: b.sessionId, to: r.sessionId, template: 'Review this:\n{{result}}' });
  fm.link(f.id, { from: b.sessionId, to: x.sessionId, on: 'failed' });
  await fm.dispatch(f.id, { member: b.sessionId, task: 'build it' });
  finish(b.sessionId, 'built the thing');
  await wait();
  assert.equal(started.length, 2);
  assert.equal(started[1].id, r.sessionId);
  assert.equal(started[1].text, 'Review this:\nbuilt the thing');
  assert.equal(fm.status().fleets[0].members[0].status, 'done');
  // failure path
  bus.emit(TYPES.AGENT_FAILED, { sessionId: r.sessionId, error: 'x' });
  await wait();
  assert.equal(started.length, 2, 'review failed: no on=done link fires');
  const f2 = fm.status().fleets[0];
  assert.equal(f2.members[1].status, 'failed');
});

test('loop guard stops an A -> B -> A chain', async () => {
  const { fm, started, finish } = make();
  fm.configure({ maxChain: 3 });
  const f = await fm.create({ members: [{ agent: 'a' }, { agent: 'b' }] });
  const [a, b] = f.members;
  fm.link(f.id, { from: a.sessionId, to: b.sessionId });
  fm.link(f.id, { from: b.sessionId, to: a.sessionId });
  await fm.dispatch(f.id, { member: a.sessionId, task: 'start' });
  for (let i = 0; i < 10; i++) { const last = started[started.length - 1]; finish(last.id); await wait(); }
  assert.equal(started.length, 4, '1 user dispatch + 3 automatic hops');
});

test('link validation, subagent events ignored, remove member cleans links', async () => {
  const { fm, bus, started } = make();
  const f = await fm.create({ members: [{ agent: 'a' }, { agent: 'b' }] });
  const [a, b] = f.members;
  assert.throws(() => fm.link(f.id, { from: a.sessionId, to: a.sessionId }), /itself/);
  assert.throws(() => fm.link(f.id, { from: a.sessionId, to: 'ses_nope' }), /not a member/);
  fm.link(f.id, { from: a.sessionId, to: b.sessionId });
  assert.throws(() => fm.link(f.id, { from: a.sessionId, to: b.sessionId }), /already exists/);
  await fm.dispatch(f.id, { member: a.sessionId, task: 't' });
  bus.emit(TYPES.AGENT_FINISHED, { sessionId: a.sessionId, final: 'sub', isChild: true });
  await wait();
  assert.equal(started.length, 1, 'a child (subagent) finishing does not trigger links');
  fm.removeMember(f.id, b.sessionId);
  assert.equal(fm.status().fleets[0].links.length, 0);
});

test('state persists; runs active at shutdown come back idle', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-')), 'fleets.json');
  const bus = new EventBus();
  const deps = { createSession: async () => ({ id: 'ses_persist1' }), start: async () => true };
  const one = new FleetManager({ bus, file }).configure(deps);
  const f = await one.create({ name: 'keep', members: [{ agent: 'build' }] });
  await one.dispatch(f.id, { task: 'work' });
  const two = new FleetManager({ bus, file });
  const s = two.status();
  assert.equal(s.fleets[0].name, 'keep');
  assert.equal(s.fleets[0].members[0].status, 'idle');
  assert.equal(s.fleets[0].members[0].lastTask, 'work');
});

test('template rendering', () => {
  assert.equal(render('{{from}}: {{result}} / {{task}} / {{nope}}', { from: 'a', result: 'r', task: 't' }), 'a: r / t / ');
  assert.match(render('', { from: 'build', result: 'done!' }), /"build" agent[\s\S]*done!/);
});
