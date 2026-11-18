'use strict';
// Dynamic workflows: recursion depth limit, capacity queue, recovery, task tree.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup } = require('./helpers');

const ctx = setup();
const { WorkflowManager } = require('../lib/workflow');
const sessions = require('../lib/sessions');
const { runAgent } = require('../lib/agent');
const agents = require('../lib/agents');

const tick = () => new Promise((r) => setImmediate(r));
const node = (wf, id, extra = {}) => wf.register({ id, parentId: 'root', agent: 'general', description: id, depth: 1, ...extra });

/* ---------- unit: depth ---------- */

test('depthError: allowed up to maxDepth, the next level is refused with the documented message', () => {
  const wf = new WorkflowManager();
  assert.equal(wf.depthError(3), null);
  assert.equal(wf.depthError(4), 'Error: Maximum recursion depth (3) reached.');
  wf.configure({ workflow: { maxDepth: 1 } });
  assert.equal(wf.depthError(2), 'Error: Maximum recursion depth (1) reached.');
  wf.configure({ workflow: { maxDepth: 'x', maxConcurrent: 0 } });
  assert.equal(wf.maxDepth, 3, 'invalid config falls back to the default');
  assert.equal(wf.maxConcurrent, 20);
});

/* ---------- unit: capacity ---------- */

test('25 subagents at once: 20 run, 5 are queued; slots go to the queue in order as agents finish', async () => {
  const wf = new WorkflowManager();
  const ids = Array.from({ length: 25 }, (_, i) => `n${i}`);
  const started = [];
  for (const id of ids) { node(wf, id); wf.acquire(id).then(() => started.push(id)); }
  await tick();
  assert.equal(started.length, 20);
  assert.equal(wf.counts().running, 20);
  assert.equal(wf.counts().queued, 5);
  assert.equal(wf.isFull(), true);
  assert.deepEqual(wf.queuedMessage(), { status: 'queued', message: 'Subagent is in queue. Current active agents: 20. It will start when a slot becomes available.' });

  wf.finish('n0', 'completed');
  await tick();
  assert.equal(started.length, 21);
  assert.equal(started[20], 'n20', 'FIFO');
  assert.equal(wf.active, 20);
});

test('recovery: a failed subagent frees its slot and the next queued one starts', async () => {
  const wf = new WorkflowManager().configure({ workflow: { maxConcurrent: 1 } });
  node(wf, 'a'); node(wf, 'b');
  await wf.acquire('a');
  let bStarted = false;
  wf.acquire('b').then(() => { bStarted = true; });
  await tick();
  assert.equal(bStarted, false);
  wf.finish('a', 'failed');
  await tick();
  assert.equal(bStarted, true);
  assert.equal(wf.get('a').status, 'failed');
  assert.equal(wf.get('b').status, 'running');
});

test('abort while queued: leaves the queue without taking a slot', async () => {
  const wf = new WorkflowManager().configure({ workflow: { maxConcurrent: 1 } });
  node(wf, 'a'); node(wf, 'b');
  await wf.acquire('a');
  const ac = new AbortController();
  const p = wf.acquire('b', { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, /aborted/);
  wf.finish('a');
  assert.equal(wf.active, 0);
  assert.equal(wf.queue.length, 0);
});

test('a parent waiting for its children gives its slot back (no deadlock at full capacity)', async () => {
  const wf = new WorkflowManager().configure({ workflow: { maxConcurrent: 1 } });
  node(wf, 'parent');
  await wf.acquire('parent');
  wf.suspend('parent');                       // parent starts waiting for its child
  assert.equal(wf.active, 0);
  assert.equal(wf.get('parent').status, 'waiting');
  wf.register({ id: 'child', parentId: 'parent', agent: 'general', description: 'c', depth: 2 });
  await wf.acquire('child');                  // would hang forever if the parent kept the only slot
  wf.finish('child');
  await wf.resume('parent');
  assert.equal(wf.get('parent').status, 'running');
  assert.equal(wf.active, 1);
});

test('task tree: nested status of all descendants', async () => {
  const wf = new WorkflowManager();
  node(wf, 'a'); wf.register({ id: 'a1', parentId: 'a', agent: 'general', description: 'x', depth: 2 });
  node(wf, 'b');
  await wf.acquire('a'); await wf.acquire('a1');
  wf.finish('a1'); wf.finish('b', 'failed');
  const t = wf.tree('root');
  assert.deepEqual(t.map((n) => [n.task_id, n.status]), [['a', 'running'], ['b', 'failed']]);
  assert.deepEqual(t[0].children.map((n) => [n.task_id, n.status, n.depth]), [['a1', 'completed', 2]]);
});

/* ---------- integration: real agent loop against a fake Ollama ---------- */

function fakeOllama(script) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      if (req.url === '/api/tags') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ models: [{ name: 'fake' }] })); }
      if (req.url === '/api/show') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ model_info: { 'llama.context_length': 16384 }, capabilities: [] })); }
      if (req.url !== '/api/chat') { res.writeHead(404); return res.end(); }
      requests.push(json);
      const reply = json.tools && json.tools.length ? script(json) : { content: 'Title' };
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: reply.content || '', ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {}) }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, eval_count: 5, prompt_eval_count: 50, eval_duration: 1e9 }) + '\n');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, requests })));
}

const sysOf = (req) => String((req.messages[0] || {}).content || '');
const taskCall = (n) => ({ tool_calls: [{ function: { name: 'task', arguments: { description: `level ${n}`, prompt: `go deeper (${n})`, agent: 'general' } } }] });
const lastTool = (req) => [...req.messages].reverse().find((m) => m.role === 'tool');

async function runRoot(prompt, config) {
  const root = await sessions.create({ agent: 'build', model: 'fake', title: 't' });
  root.messages.push({ role: 'user', content: prompt });
  const events = [];
  const out = await runAgent({ session: root, agent: agents.getAgent('build'), model: 'fake', config, emit: (e) => events.push(e), askPermission: async () => 'once', askUser: async () => '', canPrompt: false });
  return { root, out, events };
}

test('depth test: an agent that keeps delegating is stopped at level 4 and the model gets the error', async (t) => {
  // every agent (root and subagents) tries to delegate one level deeper until it sees a tool result
  const fake = await fakeOllama((req) => {
    const last = lastTool(req);
    if (last) return { content: 'done: ' + last.content.slice(0, 120) };
    return taskCall(1);
  });
  t.after(() => fake.srv.close());
  ctx.cfg.saveConfig({ endpoint: `http://127.0.0.1:${fake.port}`, model: 'fake', snapshots: false, recallAuto: false, nudgePrompt: false });
  const { out, events } = await runRoot('delegate deeply', ctx.cfg.loadConfig());
  assert.ok(out.final);
  const starts = events.filter((e) => e.type === 'subagent' && e.phase === 'start');
  assert.deepEqual(starts.map((e) => e.depth), [1, 2, 3], 'levels 1-3 were created, level 4 was refused');
  assert.ok(fake.requests.some((r) => lastTool(r) && /Maximum recursion depth \(3\) reached/.test(lastTool(r).content)), 'the deepest agent was told why');
});

test('subagents see task + task_tree and their delegation depth', async (t) => {
  const fake = await fakeOllama((req) => (lastTool(req) ? { content: 'ok' } : taskCall(1)));
  t.after(() => fake.srv.close());
  ctx.cfg.saveConfig({ endpoint: `http://127.0.0.1:${fake.port}`, model: 'fake', snapshots: false, recallAuto: false, nudgePrompt: false });
  await runRoot('go', ctx.cfg.loadConfig());
  const asChild = fake.requests.find((r) => r.tools && /level 1 of 3/.test(sysOf(r)));
  assert.ok(asChild, 'level 1 subagent knows its depth');
  const names = asChild.tools.map((x) => x.function.name);
  assert.ok(names.includes('task') && names.includes('task_tree'));
  const subReqs = fake.requests.filter((r) => r.tools && /subagent working on one delegated task/.test(sysOf(r)));
  const levels = new Set(subReqs.map((r) => (/level (\d) of 3/.exec(sysOf(r)) || [])[1]));
  assert.deepEqual([...levels].sort(), ['1', '2', undefined].sort(), 'the level-3 subagent gets no delegation advice');
});

test('concurrency: parallel task calls beyond maxConcurrent queue and still all finish', async (t) => {
  let running = 0; let peak = 0;
  const fake = await fakeOllama((req) => {
    const sys = sysOf(req);
    if (/subagent working on one delegated task/.test(sys)) { running++; peak = Math.max(peak, running); setTimeout(() => { running--; }, 0); return { content: 'child done' }; }
    if (lastTool(req)) return { content: 'all done' };
    return { tool_calls: Array.from({ length: 5 }, (_, i) => ({ function: { name: 'task', arguments: { description: `job ${i}`, prompt: 'work', agent: 'general' } } })) };
  });
  t.after(() => fake.srv.close());
  ctx.cfg.saveConfig({ endpoint: `http://127.0.0.1:${fake.port}`, model: 'fake', snapshots: false, recallAuto: false, nudgePrompt: false, workflow: { maxDepth: 3, maxConcurrent: 2 } });
  const { out, events } = await runRoot('fan out', ctx.cfg.loadConfig());
  assert.equal(out.final, 'all done');
  assert.equal(events.filter((e) => e.type === 'subagent' && e.phase === 'done').length, 5);
  const queued = events.filter((e) => e.type === 'subagent' && e.phase === 'queued');
  assert.ok(queued.length >= 1 && queued.every((e) => e.status === 'queued'), 'the UI/model is told about queued subagents');
  const { workflow } = require('../lib/workflow');
  assert.equal(workflow.active, 0, 'every slot was released');
});
