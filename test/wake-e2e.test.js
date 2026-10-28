'use strict';
// End to end: real server.js + a fake Ollama.
//  1. the model starts `sleep ...; echo MARK` with background=true and ends its turn (no polling)
//  2. the process finishes -> the STUDIO starts a new turn by itself with a notification (no user message)
//  3. a process the user stopped never wakes the agent
//  4. downloads: Content-Length + Range through the real HTTP API, build output blocked while a process runs
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

/** Fake Ollama: scripted by what the last message looks like. Records every chat request. */
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
      const reply = json.tools && json.tools.length ? script(json) : { content: 'Title' };   // no tools = title/summary request
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

/** POST /api/chat and read the SSE stream until the run ends. */
async function chat(base, text, sessionId) {
  const res = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, sessionId, model: 'fake', agent: 'build' }) });
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

const lastUser = (req) => [...req.messages].reverse().find((m) => m.role === 'user');
const bgCall = (command) => ({ tool_calls: [{ function: { name: 'bash', arguments: { command, background: true } } }] });

test('background job -> turn ends -> studio wakes the agent when it finishes; stopped jobs do not; downloads resume', async (t) => {
  const fake = await fakeOllama((req) => {
    const last = req.messages[req.messages.length - 1];
    const u = lastUser(req);
    if (u && /Studio notification/.test(u.content)) return { content: /BUILD-OK/.test(u.content) ? 'Build finished OK, APK is ready.' : 'noted' };
    if (last.role === 'tool') return { content: 'Started it in the background; I will report when it is done.' };
    if (/first/.test(u.content)) return bgCall('sleep 3; echo BUILD-OK-MARK');
    if (/second/.test(u.content)) return bgCall('sleep 60; echo SHOULD-NEVER-REPORT');
    return { content: 'ok' };
  });
  const { child, port } = await startServer();
  t.after(() => { child.kill('SIGKILL'); fake.srv.close(); });
  const base = `http://127.0.0.1:${port}`;
  await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: `http://127.0.0.1:${fake.port}`, model: 'fake', snapshots: false, recallAuto: false, permission: { edit: 'allow', bash: { '*': 'allow' } } }) });

  // ---- 1. the model starts the build and ends its turn ----
  const ev1 = await chat(base, 'first: build it', undefined);
  const sessionId = ev1.find((e) => e.type === 'start').sessionId;
  assert.ok(ev1.some((e) => e.type === 'tool_call' && e.name === 'bash'));
  assert.ok(ev1.some((e) => e.type === 'done'));
  const before = fake.requests.length;

  const jobs = await (await fetch(`${base}/api/processes?sessionId=${sessionId}`)).json();
  assert.equal(jobs.processes.length, 1);
  assert.equal(jobs.processes[0].running, true);
  assert.equal(jobs.processes[0].session_id, sessionId);          // the UI locks the composer for exactly this session
  assert.equal(jobs.sessionRunning, false);

  // ---- 2. nobody writes anything: the studio wakes the agent itself once the process ends ----
  let woke = null;
  for (let i = 0; i < 100 && !woke; i++) { await wait(250); woke = fake.requests.slice(before).find((r) => lastUser(r) && /Studio notification/.test(lastUser(r).content)); }
  assert.ok(woke, 'the agent was not woken up when the background process finished');
  assert.match(lastUser(woke).content, /finished successfully \(exit code 0\)/);
  assert.match(lastUser(woke).content, /BUILD-OK-MARK/);
  assert.ok(woke.messages.every((m) => !('notice' in m) && !('display' in m)), 'UI-only fields must never be sent to the model');

  // the wake-up turn is saved in the session: a short note for the UI + the model's report
  let session;
  for (let i = 0; i < 40; i++) {
    session = await (await fetch(`${base}/api/sessions/${sessionId}`)).json();
    if (!session.running && session.messages.some((m) => m.role === 'assistant' && /APK is ready/.test(m.content))) break;
    await wait(250);
  }
  const notice = session.messages.find((m) => m.notice);
  assert.ok(notice, 'the notification message is stored with notice:true');
  assert.match(notice.display, /^🔔 proc_\d+ finished · exit 0/);
  assert.ok(session.messages.some((m) => m.role === 'assistant' && /APK is ready/.test(m.content)));
  // no polling by the model: exactly one `bash` call, no `process` calls anywhere in the session
  const names = session.messages.flatMap((m) => (m.tool_calls || []).map((c) => c.function.name));
  assert.deepEqual(names, ['bash']);

  // ---- 3. a job the user stopped never wakes the agent ----
  const ev2 = await chat(base, 'second: another build', sessionId);
  assert.ok(ev2.some((e) => e.type === 'done'));
  const jobs2 = (await (await fetch(`${base}/api/processes?sessionId=${sessionId}`)).json()).processes.filter((p) => p.running);
  assert.equal(jobs2.length, 1);
  const n2 = fake.requests.length;
  const del = await fetch(`${base}/api/processes/${jobs2[0].id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  await wait(2500);
  assert.equal(fake.requests.length, n2, 'a process stopped by the user must not wake the agent');
  const after = (await (await fetch(`${base}/api/processes?sessionId=${sessionId}`)).json()).processes.find((p) => p.id === jobs2[0].id);
  assert.equal(after.running, false);
  assert.equal(after.killed, true);

  // ---- 4. downloads through the real API ----
  const out = path.join(ctx.dir, 'app', 'build', 'outputs');
  fs.mkdirSync(out, { recursive: true });
  const data = Buffer.alloc(200000, 7);
  fs.writeFileSync(path.join(out, 'x-debug.apk'), data);
  fs.writeFileSync(path.join(ctx.dir, 'notes.txt'), 'hello');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(out, 'x-debug.apk'), old, old);
  fs.utimesSync(path.join(ctx.dir, 'notes.txt'), old, old);
  const rel = encodeURIComponent('app/build/outputs/x-debug.apk');
  const full = await fetch(`${base}/api/download?path=${rel}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-length'), String(data.length));
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  await full.arrayBuffer();
  const part = await fetch(`${base}/api/download?path=${rel}`, { headers: { Range: 'bytes=150000-' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 50000);

  // a build is running again -> its output folder is closed for downloads (partial file), source files are not
  const ev3 = await chat(base, 'first: build again', sessionId);
  assert.ok(ev3.some((e) => e.type === 'done'));
  const blocked = await fetch(`${base}/api/download?path=${rel}`);
  assert.equal(blocked.status, 409);
  assert.match((await blocked.json()).error, /still running/);
  const src = await fetch(`${base}/api/download?path=notes.txt`);
  assert.equal(src.status, 200);
  assert.equal(await src.text(), 'hello');
});
