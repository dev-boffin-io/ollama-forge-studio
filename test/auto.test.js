'use strict';
// Auto mode: a dropdown choice that rotates between the primary agents step by step (router per message,
// switch_agent during a turn), while the active agent keeps the normal `task` tool for subagents.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setup } = require('./helpers');

const ctx = setup();
const ROOT = path.join(__dirname, '..');

// agents of this test project (the server child process reads the same studio dir)
const agentsDir = path.join(ctx.studioDir, 'agents');
fs.mkdirSync(agentsDir, { recursive: true });
fs.writeFileSync(path.join(agentsDir, 'reviewer.md'), '---\ndescription: Reviews code for bugs\nmode: all\n---\nYou are the REVIEWER agent.\n');
fs.writeFileSync(path.join(agentsDir, 'fixer.md'), '---\ndescription: Fixes failing tests\nmode: primary\n---\nYou are the FIXER agent.\n');
fs.writeFileSync(path.join(agentsDir, 'secret.md'), '---\ndescription: Never part of the rotation\nmode: primary\nauto: false\n---\nYou are the SECRET agent.\n');
fs.writeFileSync(path.join(agentsDir, 'helper.md'), '---\ndescription: A subagent\nmode: subagent\n---\nYou are the HELPER agent.\n');
fs.writeFileSync(path.join(agentsDir, 'hidden-one.md'), '---\ndescription: hidden\nmode: primary\nhidden: true\n---\nHidden.\n');
fs.writeFileSync(path.join(agentsDir, 'auto.md'), '---\ndescription: must be ignored\nmode: primary\n---\nImpostor.\n');

const agents = require('../lib/agents');
const tools = require('../lib/tools');
const auto = require('../lib/auto');
const llm = require('../lib/llm');

const names = (list) => list.map((a) => a.name).sort();

/* ---------- registry ---------- */

test('auto is a primary dropdown choice (not a subagent); a file named auto.md cannot replace it', () => {
  assert.ok(agents.primaryAgents().some((a) => a.name === 'auto'));
  assert.ok(!agents.subagents().some((a) => a.name === 'auto'));
  const a = agents.getAgent('auto');
  assert.equal(a.virtual, true);
  assert.notEqual(a.prompt, 'Impostor.');
  assert.equal(agents.isAuto('auto'), true);
  assert.equal(agents.isAuto('build'), false);
});

test('autoCandidates: primary agents only — no auto itself, subagents, hidden or `auto: false` agents', () => {
  assert.deepEqual(names(agents.autoCandidates()), ['build', 'fixer', 'plan', 'reviewer']);
});

test('resolve: auto runs as the last picked agent (build before any pick); other sessions pass through', () => {
  assert.equal(agents.resolve({ agent: 'auto' }).name, 'build');
  assert.equal(agents.resolve({ agent: 'auto', autoAgent: 'fixer' }).name, 'fixer');
  assert.equal(agents.resolve({ agent: 'auto', autoAgent: 'secret' }).name, 'build', 'an agent outside the rotation is not accepted');
  assert.equal(agents.resolve({ agent: 'auto', autoAgent: 'gone' }).name, 'build');
  assert.equal(agents.resolve({ agent: 'plan', autoAgent: 'fixer' }).name, 'plan');
  assert.equal(agents.resolve({ agent: 'does-not-exist' }), null);
});

test('composeSystem: only auto mode lists the agents to hand over to', () => {
  const build = agents.getAgent('build');
  const on = agents.composeSystem({ agent: build, config: ctx.cfg.loadConfig(), canDelegate: true, rules: [], session: null, auto: true });
  assert.match(on, /Auto mode:/);
  assert.match(on, /- fixer: Fixes failing tests/);
  assert.ok(!/- secret:/.test(on) && !/- helper: A subagent[\s\S]*switch_agent/.test(on.split('Subagents:')[0]));
  assert.ok(!/- build:/.test(on.split('Subagents:')[0]), 'the current agent is not offered');
  const off = agents.composeSystem({ agent: build, config: ctx.cfg.loadConfig(), canDelegate: true, rules: [], session: null });
  assert.ok(!/Auto mode:/.test(off));
});

/* ---------- switch_agent tool ---------- */

const toolNames = (agent, opts) => tools.toolDefsFor(agent, ctx.cfg.loadConfig(), { isChild: false, ...opts }).map((t) => t.function.name);

test('switch_agent is offered only in auto mode, never to plan or to subagents; task stays available', () => {
  const build = agents.getAgent('build');
  assert.ok(toolNames(build, { auto: true }).includes('switch_agent'));
  assert.ok(toolNames(build, { auto: true }).includes('task'), 'the active agent can still delegate to subagents');
  assert.ok(!toolNames(build, { auto: false }).includes('switch_agent'));
  assert.ok(!toolNames(build).includes('switch_agent'));
  assert.ok(!toolNames(agents.getAgent('plan'), { auto: true }).includes('switch_agent'), 'leaving plan stays behind plan_exit');
  assert.ok(toolNames(agents.getAgent('plan'), { auto: true }).includes('plan_exit'));
  assert.ok(!toolNames(agents.getAgent('explore'), { auto: true, isChild: true }).includes('switch_agent'));
});

function toolCtx(session, agentName = 'build', askUser = async () => '') {
  return { agent: agents.getAgent(agentName), config: ctx.cfg.loadConfig(), session, root: session, inherited: [], emit: () => {}, askPermission: async () => 'once', askUser };
}

test('switch_agent: records the pick; rejects unknown, hidden, subagent and out-of-rotation targets', async () => {
  const session = { id: 's1', agent: 'auto', messages: [], journal: [], turn: 1 };
  const r = await tools.executeTool('switch_agent', { agent: 'reviewer', reason: '  code is   done ' }, toolCtx(session));
  assert.equal(r.switched, true);
  assert.equal(session.autoAgent, 'reviewer');
  assert.deepEqual(session.autoSwitch, { from: 'build', reason: 'code is done' });

  for (const bad of ['secret', 'helper', 'hidden-one', 'auto', 'nope', '']) {
    const s = { id: 's2', agent: 'auto', messages: [], journal: [], turn: 1 };
    await assert.rejects(() => tools.executeTool('switch_agent', { agent: bad }, toolCtx(s)), /unknown agent/, `"${bad}" must be refused`);
    assert.equal(s.autoAgent, undefined);
  }
  const same = { id: 's3', agent: 'auto', messages: [], journal: [], turn: 1 };
  assert.equal((await tools.executeTool('switch_agent', { agent: 'build' }, toolCtx(same))).switched, false);
  assert.equal(same.autoAgent, undefined);

  const manual = { id: 's4', agent: 'build', messages: [], journal: [], turn: 1 };
  await assert.rejects(() => tools.executeTool('switch_agent', { agent: 'reviewer' }, toolCtx(manual)), /only works in auto mode/);
});

test('plan_exit in auto mode continues as build but stays in auto mode', async () => {
  const session = { id: 's5', agent: 'auto', autoAgent: 'plan', messages: [], journal: [], turn: 1 };
  const r = await tools.executeTool('plan_exit', {}, toolCtx(session, 'plan', async () => 'Yes, build it'));
  assert.equal(r.approved, true);
  assert.equal(session.agent, 'auto');
  assert.equal(session.autoAgent, 'build');
  const manual = { id: 's6', agent: 'plan', messages: [], journal: [], turn: 1 };
  await tools.executeTool('plan_exit', {}, toolCtx(manual, 'plan', async () => 'Yes, build it'));
  assert.equal(manual.agent, 'build', 'outside auto mode nothing changed');
});

/* ---------- router ---------- */

const candidates = () => agents.autoCandidates();

test('parseChoice: whole-word match, earliest mention wins, think blocks ignored, hyphenated names intact', () => {
  const list = [{ name: 'build' }, { name: 'debug-agent' }, { name: 'debug' }, { name: 'plan' }];
  assert.equal(auto.parseChoice('plan', list).name, 'plan');
  assert.equal(auto.parseChoice('  **Debug-Agent**\n', list).name, 'debug-agent');
  assert.equal(auto.parseChoice('<think>build build build</think>plan', list).name, 'plan');
  assert.equal(auto.parseChoice('I would pick plan, not build.', list).name, 'plan');
  assert.equal(auto.parseChoice('rebuilding', list), null, 'no partial-word matches');
  assert.equal(auto.parseChoice('', list), null);
  assert.equal(auto.parseChoice('something else', list), null);
});

function withChat(fn, body) {
  const real = llm.chatStream;
  const calls = [];
  llm.chatStream = async (args) => { calls.push(args); return fn(args); };
  return Promise.resolve().then(body).then(() => calls).finally(() => { llm.chatStream = real; });
}

test('route: picks the named agent, remembers it, and sends candidates + current agent + context to the model', async () => {
  const session = { id: 'r1', agent: 'auto', messages: [{ role: 'assistant', content: 'I finished the implementation.' }] };
  const text = `${'filler '.repeat(300)}please look over what you wrote`;
  let picked;
  const calls = await withChat(() => ({ content: 'reviewer' }), async () => {
    picked = await auto.route({ session, text, config: ctx.cfg.loadConfig(), model: 'fake' });
  });
  assert.equal(picked.name, 'reviewer');
  assert.equal(session.autoAgent, 'reviewer');
  assert.equal(calls.length, 1);
  const prompt = calls[0].messages[1].content;
  for (const n of ['build', 'plan', 'reviewer', 'fixer']) assert.match(prompt, new RegExp(`- ${n}:`));
  for (const n of ['secret', 'helper', 'hidden-one', 'auto']) assert.ok(!new RegExp(`- ${n}:`).test(prompt), `${n} must not be offered`);
  assert.match(prompt, /Current agent: build/);
  assert.match(prompt, /I finished the implementation/);
  assert.match(prompt, /\[middle omitted\]/);
  assert.match(prompt, /please look over what you wrote$/m);
});

test('route: keeps the current agent when the answer is nonsense, the call fails, routing is off or there is nothing to choose', async () => {
  const mk = (autoAgent) => ({ id: 'r2', agent: 'auto', autoAgent, messages: [] });
  const cfg = ctx.cfg.loadConfig();
  let s = mk('fixer');
  await withChat(() => ({ content: 'banana' }), async () => { assert.equal((await auto.route({ session: s, text: 'hi', config: cfg, model: 'fake' })).name, 'fixer'); });
  s = mk('fixer');
  await withChat(() => { throw new Error('connection refused'); }, async () => { assert.equal((await auto.route({ session: s, text: 'hi', config: cfg, model: 'fake' })).name, 'fixer'); });
  s = mk(undefined);
  await withChat(() => { throw new Error('boom'); }, async () => { assert.equal((await auto.route({ session: s, text: 'hi', config: cfg, model: 'fake' })).name, 'build'); assert.equal(s.autoAgent, 'build'); });
  s = mk('fixer');
  const off = await withChat(() => ({ content: 'plan' }), async () => { assert.equal((await auto.route({ session: s, text: 'hi', config: { ...cfg, autoRoute: false }, model: 'fake' })).name, 'fixer'); });
  assert.equal(off.length, 0, 'autoRoute: false makes no model call');
  s = mk('fixer');
  const empty = await withChat(() => ({ content: 'plan' }), async () => { assert.equal((await auto.route({ session: s, text: '   ', config: cfg, model: 'fake' })).name, 'fixer'); });
  assert.equal(empty.length, 0);
});

test('route: an aborted request is not swallowed', async () => {
  const ac = new AbortController();
  ac.abort();
  await withChat(() => { throw new Error('aborted'); }, async () => {
    await assert.rejects(() => auto.route({ session: { id: 'r3', agent: 'auto', messages: [] }, text: 'hi', config: ctx.cfg.loadConfig(), model: 'fake', signal: ac.signal }), /aborted/);
  });
});

/* ---------- end to end: router -> hand-over -> subagent, over HTTP with a fake Ollama ---------- */

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
      const reply = script(json);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: reply.content || '', ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {}) }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, eval_count: 5, prompt_eval_count: 50, eval_duration: 1e9 }) + '\n');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, requests, port: srv.address().port })));
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', '0', '--dir', ctx.dir], {
      env: { ...process.env, OLLAMA_STUDIO_HOME: ctx.home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('server did not start:\n' + out)); }, 20000);
    const onData = (d) => { out += d.toString(); const m = out.match(/url: http:\/\/[^:]+:(\d+)/); if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early (${code}):\n${out}`)); });
  });
}

async function chat(base, body) {
  const res = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'fake', ...body }) });
  assert.equal(res.status, 200);
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
      buf = buf.slice(i + 2);
      if (line) events.push(JSON.parse(line.slice(6)));
    }
  }
  return events;
}

const sysOf = (req) => String((req.messages[0] || {}).content || '');
const toolsOf = (req) => (req.tools || []).map((t) => t.function.name);

test('auto mode end to end: routed to reviewer -> hands over to fixer -> fixer delegates to a subagent; next message stays with fixer', { timeout: 60000 }, async (t) => {
  let routerAnswer = 'reviewer';
  const fake = await fakeOllama((req) => {
    const sys = sysOf(req);
    if (!req.tools || !req.tools.length) return { content: /router of a coding studio/.test(sys) ? routerAnswer : 'Title' };
    if (/file search specialist/.test(sys)) return { content: 'found it in src/a.js' };                  // the explore subagent
    if (/REVIEWER agent/.test(sys)) return { tool_calls: [{ function: { name: 'switch_agent', arguments: { agent: 'fixer', reason: 'tests fail' } } }] };
    if (/FIXER agent/.test(sys)) {
      if (!req.messages.some((m) => m.role === 'tool' && m.tool_name === 'task')) return { tool_calls: [{ function: { name: 'task', arguments: { description: 'locate code', prompt: 'find a.js', agent: 'explore' } } }] };
      return { content: 'all fixed' };
    }
    return { content: 'unexpected agent: ' + sys.slice(0, 40) };
  });
  const { child, port } = await startServer();
  t.after(() => { child.kill('SIGKILL'); fake.srv.close(); });
  const base = `http://127.0.0.1:${port}`;
  await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: `http://127.0.0.1:${fake.port}`, model: 'fake', snapshots: false, recallAuto: false, nudgePrompt: false }) });

  // the dropdown list the UI is built from
  const state = await (await fetch(base + '/api/state')).json();
  assert.ok(state.agents.some((a) => a.name === 'auto'), 'auto is in the agent dropdown');

  const first = await chat(base, { text: 'check my work and fix what is broken', agent: 'auto' });
  const start = first.find((e) => e.type === 'start');
  assert.equal(start.agent, 'reviewer');
  assert.equal(start.auto, true);
  const sw = first.find((e) => e.type === 'agent' && e.name === 'fixer');
  assert.ok(sw, 'the hand-over is announced');
  assert.equal(sw.auto, true);
  assert.equal(sw.from, 'reviewer');
  assert.equal(sw.reason, 'tests fail');
  assert.ok(first.some((e) => e.type === 'subagent' && e.phase === 'start' && e.agent === 'explore'), 'the active agent delegated to a subagent');
  assert.ok(first.some((e) => e.type === 'done'));
  assert.ok(!first.some((e) => e.type === 'error'), JSON.stringify(first.find((e) => e.type === 'error')));

  // what the model saw
  const router = fake.requests.find((r) => !r.tools && /router of a coding studio/.test(sysOf(r)));
  assert.ok(router, 'the router was asked once per user message');
  assert.ok(!/- secret:/.test(router.messages[1].content));
  const asReviewer = fake.requests.find((r) => r.tools && /REVIEWER agent/.test(sysOf(r)));
  assert.ok(toolsOf(asReviewer).includes('switch_agent') && toolsOf(asReviewer).includes('task'));
  const asFixer = fake.requests.filter((r) => r.tools && /FIXER agent/.test(sysOf(r)));
  assert.ok(asFixer.length >= 2);
  assert.ok(toolsOf(asFixer[0]).includes('switch_agent') && toolsOf(asFixer[0]).includes('task'), 'after a hand-over the new agent can still delegate');
  assert.ok(asFixer[0].messages.some((m) => m.role === 'user' && /\[Studio · auto mode\].*"reviewer".*"fixer"/.test(m.content)), 'the new agent is told about the hand-over');
  assert.ok(!/REVIEWER agent/.test(sysOf(asFixer[0])), 'the system prompt really changed');

  // persisted: still "auto", remembers who is working
  const sid = start.sessionId;
  const saved = await (await fetch(base + '/api/sessions/' + sid)).json();
  assert.equal(saved.agent, 'auto');
  assert.equal(saved.autoAgent, 'fixer');

  // next message: the router gives no usable answer -> the agent that was working keeps going
  routerAnswer = 'no idea';
  const second = await chat(base, { text: 'thanks, one more thing', agent: 'auto', sessionId: sid });
  assert.equal(second.find((e) => e.type === 'start').agent, 'fixer');
  assert.ok(!second.some((e) => e.type === 'agent'), 'no hand-over event when nothing changed');
  const router2 = fake.requests.filter((r) => !r.tools && /router of a coding studio/.test(sysOf(r)));
  assert.match(router2[router2.length - 1].messages[1].content, /Current agent: fixer/);
});

test('picking a concrete agent in the dropdown is unaffected by auto mode (no router, no switch_agent)', { timeout: 60000 }, async (t) => {
  const fake = await fakeOllama((req) => (req.tools && req.tools.length ? { content: 'plain answer' } : { content: 'Title' }));
  const { child, port } = await startServer();
  t.after(() => { child.kill('SIGKILL'); fake.srv.close(); });
  const base = `http://127.0.0.1:${port}`;
  await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: `http://127.0.0.1:${fake.port}`, model: 'fake', snapshots: false, recallAuto: false }) });
  const ev = await chat(base, { text: 'hello', agent: 'fixer' });
  const start = ev.find((e) => e.type === 'start');
  assert.equal(start.agent, 'fixer');
  assert.ok(!start.auto);
  assert.ok(!fake.requests.some((r) => /router of a coding studio/.test(sysOf(r))));
  assert.ok(fake.requests.filter((r) => r.tools).every((r) => !toolsOf(r).includes('switch_agent')));
});
