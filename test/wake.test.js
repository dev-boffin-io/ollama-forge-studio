'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWaker, noticeFor, fmtDuration } = require('../lib/wake');

const info = (o = {}) => ({ id: 'proc_1', sessionId: 'ses_a', command: './gradlew assembleDebug', exitCode: 0, killed: false, durationMs: 812000, tail: 'BUILD SUCCESSFUL in 13m 32s', logFile: '/tmp/x.log', ...o });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function make(over = {}) {
  const events = new EventEmitter();
  const started = [];
  const state = { running: new Set(), seen: new Set(), enabled: true, startResult: true };
  const waker = createWaker({
    events, delayMs: 5, maxStreak: 3,
    isRunning: (id) => state.running.has(id),
    isSeen: (id) => state.seen.has(id),
    enabled: () => state.enabled,
    start: async (sid, notice) => { started.push({ sid, notice }); return state.startResult; },
    ...over,
  });
  return { events, started, state, waker };
}

test('fmtDuration', () => {
  assert.equal(fmtDuration(45000), '45s');
  assert.equal(fmtDuration(812000), '13m 32s');
  assert.equal(fmtDuration(3 * 3600000 + 5 * 60000), '3h 5m');
});

test('noticeFor tells the model what happened and not to poll; the UI label is short', () => {
  const ok = noticeFor([info()]);
  assert.match(ok.text, /^\[Studio notification/);
  assert.match(ok.text, /finished successfully \(exit code 0\) after 13m 32s/);
  assert.match(ok.text, /BUILD SUCCESSFUL/);
  assert.match(ok.text, /Do not poll/);
  assert.equal(ok.display, '🔔 proc_1 finished · exit 0 · 13m 32s');
  const bad = noticeFor([info({ exitCode: 1, tail: 'error: boom' })]);
  assert.match(bad.text, /FAILED \(exit code 1\)/);
  assert.match(bad.text, /fix it/);
});

test('an idle session is woken once when its process finishes', async () => {
  const { events, started } = make();
  events.emit('exit', info());
  await wait(40);
  assert.equal(started.length, 1);
  assert.equal(started[0].sid, 'ses_a');
  assert.match(started[0].notice.text, /proc_1/);
});

test('killed, already-seen, sessionless and disabled -> no wake-up', async () => {
  const { events, started, state } = make();
  events.emit('exit', info({ killed: true }));
  events.emit('exit', info({ id: 'proc_2', sessionId: null }));
  state.seen.add('proc_3');
  events.emit('exit', info({ id: 'proc_3' }));
  state.enabled = false;
  events.emit('exit', info({ id: 'proc_4' }));
  await wait(40);
  assert.equal(started.length, 0);
});

test('while the agent is busy the notice waits and is delivered when the run ends', async () => {
  const { events, started, state, waker } = make();
  state.running.add('ses_a');
  events.emit('exit', info());
  await wait(40);
  assert.equal(started.length, 0);
  assert.equal(waker.hasPending('ses_a'), true);
  state.running.delete('ses_a');
  waker.onRunEnd('ses_a');
  await wait(400);
  assert.equal(started.length, 1);
  assert.equal(waker.hasPending('ses_a'), false);
});

test('if the model read the result itself while busy, nothing is announced afterwards', async () => {
  const { events, started, state, waker } = make();
  state.running.add('ses_a');
  events.emit('exit', info());
  state.seen.add('proc_1');                 // the model called `process output` during its turn
  state.running.delete('ses_a');
  waker.onRunEnd('ses_a');
  await wait(400);
  assert.equal(started.length, 0);
});

test('processes that end together produce ONE wake-up turn', async () => {
  const { events, started } = make();
  events.emit('exit', info({ id: 'proc_1' }));
  events.emit('exit', info({ id: 'proc_2', exitCode: 2 }));
  await wait(40);
  assert.equal(started.length, 1);
  assert.match(started[0].notice.text, /proc_1/);
  assert.match(started[0].notice.text, /proc_2/);
});

test('loop guard: at most maxStreak automatic turns until the user writes again', async () => {
  const { events, started, waker } = make();
  for (let i = 0; i < 5; i++) { events.emit('exit', info({ id: 'p' + i })); await wait(30); }
  assert.equal(started.length, 3);
  waker.onUserMessage('ses_a');
  events.emit('exit', info({ id: 'pz' }));
  await wait(30);
  assert.equal(started.length, 4);
});

test('losing a race with a user message (start() -> false) keeps the notice for the next run end', async () => {
  const { events, started, state, waker } = make();
  state.startResult = false;
  events.emit('exit', info());
  await wait(40);
  assert.equal(started.length, 1);
  assert.equal(waker.hasPending('ses_a'), true);
  state.startResult = true;
  waker.onRunEnd('ses_a');
  await wait(400);
  assert.equal(started.length, 2);
});
