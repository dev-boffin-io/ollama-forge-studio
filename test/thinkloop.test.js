'use strict';
// A model that thinks forever is interrupted and told to act; a tool that is permission-denied over and over is closed.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setup } = require('./helpers');

const ctx = setup();
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** script(req, n) -> { content?, tool_calls?, thinkingChunks? } ; thinkingChunks are streamed slowly so the stream can be cut. */
function fakeOllama(script) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const json = body ? JSON.parse(body) : {};
      if (req.url === '/api/tags') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ models: [{ name: 'fake' }] })); }
      if (req.url === '/api/show') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ model_info: { 'llama.context_length': 16384 }, capabilities: [] })); }
      if (req.url !== '/api/chat') { res.writeHead(404); return res.end(); }
      requests.push(json);
      const reply = json.tools && json.tools.length ? script(json, requests.length) : { content: 'Title' };
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      try {
        for (const c of reply.thinkingChunks || []) { res.write(JSON.stringify({ message: { role: 'assistant', content: '', thinking: c }, done: false }) + '\n'); await sleep(15); }
        res.write(JSON.stringify({ message: { role: 'assistant', content: reply.content || '', ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {}) }, done: false }) + '\n');
        res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, eval_count: 5, prompt_eval_count: 50, eval_duration: 1e9 }) + '\n');
      } catch { /* client cut the stream */ }
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, requests, port: srv.address().port })));
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', '0', '--dir', ctx.dir], { env: { ...process.env, OLLAMA_STUDIO_HOME: ctx.home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('server did not start:\n' + out)); }, 20000);
    const onData = (d) => { out += d.toString(); const m = out.match(/url: http:\/\/[^:]+:(\d+)/); if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); } };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early (${code}):\n${out}`)); });
  });
}

async function chat(base, text) {
  const res = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model: 'fake', agent: 'build' }) });
  assert.equal(res.status, 200);
  const events = [];
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
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

const configure = (base, fake, extra = {}) => fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: `http://127.0.0.1:${fake.port}`, model: 'fake', snapshots: false, recallAuto: false, nudgePrompt: false, maxThinkChars: 1500, ...extra }) });

test('runaway thinking is cut off, the model is told to act, and the turn then completes', async (t) => {
  const fake = await fakeOllama((req, n) => (n === 1 ? { thinkingChunks: Array.from({ length: 40 }, () => 'hmm, let me think about this once more. '.repeat(5)) } : { content: 'done' }));
  const { child, port } = await startServer();
  t.after(() => { child.kill('SIGKILL'); fake.srv.close(); });
  const base = `http://127.0.0.1:${port}`;
  await configure(base, fake);
  const ev = await chat(base, 'hello there');
  assert.ok(ev.some((e) => e.type === 'info' && /interrupted \(1\/3\)/.test(e.text)), 'the interruption is reported');
  assert.ok(fake.requests.some((r) => r.messages.some((m) => m.role === 'user' && /Do NOT think this through again/.test(String(m.content || '')))), 'the model gets the act-now nudge');
  assert.ok(ev.some((e) => e.type === 'done'));
});

test('three runaway thoughts in a row end the turn with a warning instead of looping forever', async (t) => {
  const fake = await fakeOllama(() => ({ thinkingChunks: Array.from({ length: 40 }, () => 'still thinking about it, again and again. '.repeat(5)) }));
  const { child, port } = await startServer();
  t.after(() => { child.kill('SIGKILL'); fake.srv.close(); });
  const base = `http://127.0.0.1:${port}`;
  await configure(base, fake);
  const ev = await chat(base, 'hello there');
  assert.ok(ev.some((e) => e.type === 'warning' && /stuck while thinking/.test(e.message)));
  assert.equal(fake.requests.filter((r) => r.tools && r.tools.length).length, 3);
  assert.equal(fake.requests[2].think, false, 'the third attempt switches reasoning off');
});

test('a kind of call denied twice is not retried, and the tool itself stays available', async (t) => {
  const fake = await fakeOllama((req, n) => (n <= 4 ? { tool_calls: [{ function: { name: 'bash', arguments: { command: `rm -rf x${n}` } } }] } : { content: 'ok, I will not do that' }));
  const { child, port } = await startServer();
  t.after(() => { child.kill('SIGKILL'); fake.srv.close(); });
  const base = `http://127.0.0.1:${port}`;
  await configure(base, fake, { permission: { bash: { '*': 'allow', 'rm *': 'deny' } } });
  const ev = await chat(base, 'delete things');
  assert.ok(ev.some((e) => e.type === 'info' && /not permitted/.test(e.text)), 'the second refusal is reported');
  assert.ok(fake.requests.filter((r) => r.tools && r.tools.length).every((r) => r.tools.some((x) => x.function.name === 'bash')), 'bash is never removed from the tool list');
  const results = fake.requests.flatMap((r) => r.messages.filter((m) => m.role === 'tool').map((m) => m.content)).join('\n');
  assert.match(results, /already refused twice/, 'the 3rd rm is refused without running');
});
