'use strict';
// The agent must not stop mid-plan: a turn that ends with open todos (or announces "করছি/I will")
// gets a nudge and continues. A finished checklist is cleared when the turn ends.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setup } = require('./helpers');

const ctx = setup();
const ROOT = path.join(__dirname, '..');

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
      const reply = json.tools && json.tools.length ? script(json, requests.length) : { content: 'Title' };
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

async function chat(base, text) {
  const res = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model: 'fake', agent: 'build' }) });
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

test('a turn that stops with open todos is nudged and continued; a finished list is cleared', async (t) => {
  const todos = (status) => ({ tool_calls: [{ function: { name: 'todo_write', arguments: { todos: [{ content: 'Install deps', status }, { content: 'Write tests', status: 'pending' }] } } }] });
  const fake = await fakeOllama((req, n) => {
    const nudged = req.messages.some((m) => m.role === 'user' && /not finished/.test(m.content || ''));
    if (n === 1) return todos('in_progress');                              // plan
    if (!nudged) return { content: 'ঠিক আছে, এখন Install deps করছি।' };    // stops mid-way: should be nudged
    if (req.messages.filter((m) => m.role === 'tool').length < 2) return { tool_calls: [{ function: { name: 'todo_write', arguments: { todos: [{ content: 'Install deps', status: 'completed' }, { content: 'Write tests', status: 'completed' }] } } }] };
    return { content: 'সব কাজ শেষ।' };
  });
  const { child, port } = await startServer();
  t.after(() => { child.kill('SIGKILL'); fake.srv.close(); });
  const base = `http://127.0.0.1:${port}`;
  await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: `http://127.0.0.1:${fake.port}`, model: 'fake', snapshots: false, recallAuto: false, permission: { edit: 'allow', bash: { '*': 'allow' } } }) });

  const ev = await chat(base, 'build the thing');
  assert.ok(ev.some((e) => e.type === 'info' && /এগিয়ে/.test(e.text)), 'the unfinished turn should be nudged');
  assert.ok(fake.requests.some((r) => r.messages.some((m) => /not finished/.test(m.content || ''))), 'the nudge is sent to the model');
  assert.ok(ev.some((e) => e.type === 'todos' && e.todos.length === 0), 'a finished checklist is cleared at the end of the turn');
  assert.ok(ev.some((e) => e.type === 'done'));
});
