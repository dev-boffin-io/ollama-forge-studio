'use strict';
// End-to-end: boot the real server against a fake Ollama and drive a two-agent fleet through the HTTP API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setup } = require('./helpers');

const ctx = setup();
const ROOT = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeOllama() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url === '/api/tags') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ models: [{ name: 'fake' }] })); }
        if (req.url === '/api/show') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ model_info: { 'x.context_length': 32768 } })); }
        if (req.url === '/api/chat') {
          const msgs = JSON.parse(body).messages;
          const last = msgs[msgs.length - 1];
          const text = `ans: ${String(last.content).replace(/\s+/g, ' ').slice(0, 120)}`;
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          return res.end(JSON.stringify({ message: { role: 'assistant', content: text }, done: true, eval_count: 5, prompt_eval_count: 10 }) + '\n');
        }
        res.writeHead(404); res.end();
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', '0', '--dir', ctx.dir], { env: { ...process.env, OLLAMA_STUDIO_HOME: ctx.home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('server did not start:\n' + out)); }, 20000);
    const onData = (d) => { out += d; const m = out.match(/url: http:\/\/[^:]+:(\d+)/); if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); } };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early (${code}):\n${out}`)); });
  });
}

test('fleet: dispatch, automatic handoff A -> B, live events and memory search', async (t) => {
  const ollama = await fakeOllama();
  t.after(() => { ollama.closeAllConnections(); ollama.close(); });
  fs.writeFileSync(path.join(ctx.home, 'config.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${ollama.address().port}`, model: 'fake', snapshots: false, wakeOnProcessExit: false }));
  const { child, port } = await startServer();
  t.after(() => child.kill('SIGKILL'));
  const base = `http://127.0.0.1:${port}`;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
  const status = async () => (await (await fetch(base + '/api/fleet/status')).json());

  assert.deepEqual((await status()).fleets, []);
  const created = await post('/api/fleet/create', { name: 'crew', members: [{ agent: 'build', title: 'builder' }, { agent: 'plan', title: 'planner' }] });
  assert.equal(created.status, 200);
  const [a, b] = created.json.fleet.members;
  const fleetId = created.json.fleet.id;
  assert.equal((await post('/api/fleet/create', { members: [{ agent: 'general' }] })).status, 400, 'a subagent cannot be a fleet member');

  assert.equal((await post('/api/fleet/link', { fleetId, from: a.sessionId, to: b.sessionId, template: 'Plan from: {{result}}' })).status, 200);
  assert.equal((await post('/api/fleet/link', { fleetId, from: a.sessionId, to: a.sessionId })).status, 400);

  const d = await post('/api/fleet/dispatch', { fleetId, member: a.sessionId, task: 'build the login page' });
  assert.equal(d.status, 200);
  assert.equal(d.json.results[0].status, 'started');

  let st;
  for (let i = 0; i < 100; i++) {
    st = (await status()).fleets[0];
    if (st.members.every((m) => m.status === 'done')) break;
    await wait(150);
  }
  assert.ok(st.members.every((m) => m.status === 'done'), 'both agents finished: ' + JSON.stringify(st.members.map((m) => m.status)));
  assert.match(st.members[0].lastResult, /ans: build the login page/);
  assert.match(st.members[1].lastTask, /^Plan from: ans: build the login page/, 'B received A\'s report through the link');
  assert.equal(st.members[1].messageCount >= 2, true);

  // the bus replay stream carries the lifecycle
  const ctl = new AbortController();
  const sse = await fetch(base + '/api/events?since=0', { signal: ctl.signal });
  const reader = sse.body.getReader();
  let seen = '';
  for (let i = 0; i < 20 && !/agent_finished_task/.test(seen); i++) { const { value } = await reader.read(); seen += Buffer.from(value).toString(); }
  ctl.abort();
  assert.match(seen, /agent_started/);
  assert.match(seen, /agent_finished_task/);
  assert.match(seen, /fleet_updated/);

  // memory: status, search, context explorer
  const mem = await (await fetch(base + '/api/memory/status')).json();
  if (mem.available) {
    assert.ok(mem.chunks >= 2);
    const found = await (await fetch(base + '/api/memory/search?q=' + encodeURIComponent('login page'))).json();
    assert.ok(found.hits.length >= 1);
    const sctx = await (await fetch(base + '/api/memory/context?session=' + a.sessionId)).json();
    assert.equal(sctx.session.id, a.sessionId);
    assert.ok(sctx.session.ctx > 0);
  }

  assert.equal((await post('/api/fleet/remove', { fleetId })).status, 200);
  assert.deepEqual((await status()).fleets, []);
});
