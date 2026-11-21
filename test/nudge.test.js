'use strict';
// The agent must not stop mid-plan: a turn that ends with open todos (or announces "করছি/I will")
// gets a nudge and continues. A finished checklist is cleared when the turn ends.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
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

async function chat(base, text, sessionId, onEvent) {
  const res = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model: 'fake', agent: 'build', ...(sessionId ? { sessionId } : {}) }) });
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
      if (line) {
        const ev = JSON.parse(line.slice(6));
        events.push(ev);
        if (onEvent) await onEvent(ev);
      }
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
  await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: `http://127.0.0.1:${fake.port}`, model: 'fake', snapshots: false, recallAuto: false, nudgePrompt: false, permission: { edit: 'allow', bash: { '*': 'allow' } } }) });

  const ev = await chat(base, 'build the thing');
  assert.ok(ev.some((e) => e.type === 'info' && /work is not finished/.test(e.text)), 'the unfinished turn should be nudged');
  assert.ok(fake.requests.some((r) => r.messages.some((m) => /not finished/.test(m.content || ''))), 'the nudge is sent to the model');
  assert.ok(ev.some((e) => e.type === 'todos' && e.todos.length === 0), 'a finished checklist is cleared at the end of the turn');
  assert.ok(ev.some((e) => e.type === 'done'));
});

test('todos left open in an earlier turn do not nudge a later turn', async (t) => {
  const pending = { tool_calls: [{ function: { name: 'todo_write', arguments: { todos: [{ content: 'Old task', status: 'pending' }] } } }] };
  let laterCalls = 0;
  const fake = await fakeOllama((req) => {
    const users = req.messages.filter((m) => m.role === 'user').map((m) => String(m.content || '').trim());
    if (users.includes('hello')) { laterCalls++; return { content: 'hi there' }; }
    if (!req.messages.some((m) => m.role === 'tool')) return pending;      // first turn leaves a todo open
    return { content: 'still working' };
  });
  const { child, port } = await startServer();
  t.after(() => { child.kill('SIGKILL'); fake.srv.close(); });
  const base = `http://127.0.0.1:${port}`;
  await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: `http://127.0.0.1:${fake.port}`, model: 'fake', snapshots: false, recallAuto: false, nudgePrompt: false, permission: { edit: 'allow', bash: { '*': 'allow' } } }) });

  const first = await chat(base, 'plan it');
  const sid = first.find((e) => e.type === 'start').sessionId;
  assert.ok(sid, 'the first turn returns its session id');
  assert.ok(first.some((e) => e.type === 'info' && /work is not finished/.test(e.text)), 'the first turn is nudged while its own todo is open');

  laterCalls = 0;
  const second = await chat(base, 'hello', sid);
  assert.equal(laterCalls, 1, 'a stale todo must not make the model run again');
  assert.ok(!second.some((e) => e.type === 'info' && /work is not finished/.test(e.text)), 'the later turn is not nudged');
});

test('the nudge asks the user before continuing; approving sends the nudge', async (t) => {
  const todos = (status) => ({ tool_calls: [{ function: { name: 'todo_write', arguments: { todos: [{ content: 'Install deps', status }] } } }] });
  const fake = await fakeOllama((req) => {
    const nudged = req.messages.some((m) => m.role === 'user' && /not finished/.test(m.content || ''));
    if (!req.messages.some((m) => m.role === 'tool')) return todos('in_progress');
    if (!nudged) return { content: 'still working' };
    if (req.messages.filter((m) => m.role === 'tool').length < 2) return todos('completed');
    return { content: 'done' };
  });
  const { child, port } = await startServer();
  t.after(() => { child.kill('SIGKILL'); fake.srv.close(); });
  const base = `http://127.0.0.1:${port}`;
  await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: `http://127.0.0.1:${fake.port}`, model: 'fake', snapshots: false, recallAuto: false, nudgePrompt: true, permission: { edit: 'allow', bash: { '*': 'allow' } } }) });

  let asked = null;
  const ev = await chat(base, 'build the thing', undefined, async (e) => {
    if (e.type !== 'question') return;
    asked = e;
    await fetch(base + '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: e.id, answer: 'Yes, continue' }) });
  });
  assert.ok(asked, 'the user is asked before the agent is nudged');
  assert.deepEqual(asked.options, ['Yes, continue', 'No, stop']);
  assert.match(asked.question, /Continue\?/);
  assert.ok(fake.requests.some((r) => r.messages.some((m) => /not finished/.test(m.content || ''))), 'approving sends the nudge');
  assert.ok(ev.some((e) => e.type === 'done'));
});

test('the user can decline the nudge', async (t) => {
  const pending = { tool_calls: [{ function: { name: 'todo_write', arguments: { todos: [{ content: 'Old task', status: 'in_progress' }] } } }] };
  const fake = await fakeOllama((req) => {
    if (!req.messages.some((m) => m.role === 'tool')) return pending;
    return { content: 'still working' };
  });
  const { child, port } = await startServer();
  t.after(() => { child.kill('SIGKILL'); fake.srv.close(); });
  const base = `http://127.0.0.1:${port}`;
  await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: `http://127.0.0.1:${fake.port}`, model: 'fake', snapshots: false, recallAuto: false, nudgePrompt: true, permission: { edit: 'allow', bash: { '*': 'allow' } } }) });

  let asked = null;
  const ev = await chat(base, 'build the thing', undefined, async (e) => {
    if (e.type !== 'question') return;
    asked = e;
    await fetch(base + '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: e.id, answer: 'No, stop' }) });
  });
  assert.ok(asked, 'the user is asked');
  assert.ok(!fake.requests.some((r) => r.messages.some((m) => /not finished/.test(m.content || ''))), 'declining does not send the nudge');
  assert.ok(ev.some((e) => e.type === 'done'));
});

test('a custom answer is sent to the model as a user message', async (t) => {
  const pending = { tool_calls: [{ function: { name: 'todo_write', arguments: { todos: [{ content: 'Old task', status: 'in_progress' }] } } }] };
  const fake = await fakeOllama((req) => {
    if (req.messages.some((m) => m.role === 'user' && String(m.content || '').includes('also update the docs'))) return { content: 'ok' };
    if (!req.messages.some((m) => m.role === 'tool')) return pending;
    return { content: 'still working' };
  });
  const { child, port } = await startServer();
  t.after(() => { child.kill('SIGKILL'); fake.srv.close(); });
  const base = `http://127.0.0.1:${port}`;
  await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: `http://127.0.0.1:${fake.port}`, model: 'fake', snapshots: false, recallAuto: false, nudgePrompt: true, permission: { edit: 'allow', bash: { '*': 'allow' } } }) });

  let asked = null;
  await chat(base, 'build the thing', undefined, async (e) => {
    if (e.type !== 'question') return;
    asked = e;
    await fetch(base + '/api/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: e.id, answer: 'also update the docs' }) });
  });
  assert.ok(asked, 'the user is asked');
  assert.ok(fake.requests.some((r) => r.messages.some((m) => m.role === 'user' && String(m.content || '').includes('also update the docs'))), 'the custom answer reaches the model');
});

test('project questions are grounded in real reads before answering', async (t) => {
  const fake = await fakeOllama((req) => {
    const grounded = req.messages.some((m) => m.role === 'user' && /read the code first/i.test(String(m.content || '')));
    const cited = req.messages.some((m) => m.role === 'user' && /file:line citations/i.test(String(m.content || '')));
    const unverified = req.messages.some((m) => m.role === 'user' && /citations to files not read this turn/i.test(String(m.content || '')));
    const reads = req.messages.filter((m) => m.role === 'tool' && ['read_file', 'grep', 'lsp'].includes(m.tool_name)).length;
    if (!grounded) return { content: 'I can tell from the file names.' };
    if (reads < 2) return { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'sample.js' } } }] };
    if (!cited) return { content: 'Reviewed with evidence.' };
    if (!unverified) return { content: 'README.md:1 says so.' };
    return { content: 'Reviewed sample.js:1.' };
  });
  const { child, port } = await startServer();
  t.after(() => { child.kill('SIGKILL'); fake.srv.close(); });
  const base = `http://127.0.0.1:${port}`;
  await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: `http://127.0.0.1:${fake.port}`, model: 'fake', snapshots: false, recallAuto: false, nudgePrompt: false, permission: { edit: 'allow', bash: { '*': 'allow' } } }) });
  fs.writeFileSync(path.join(ctx.dir, 'sample.js'), 'module.exports = 1;\n');

  const ev = await chat(base, 'review the codebase and report issues');
  assert.ok(ev.some((e) => e.type === 'info' && /read the code first/.test(e.text)));
  assert.ok(ev.some((e) => e.type === 'info' && /file:line citations/.test(e.text)));
  assert.ok(ev.some((e) => e.type === 'info' && /citations to files not read this turn/.test(e.text)));
  assert.ok(fake.requests.some((r) => r.messages.some((m) => m.role === 'user' && /read the code first/i.test(String(m.content || '')))));
  assert.ok(fake.requests.some((r) => r.messages.some((m) => m.role === 'user' && /file:line citations/i.test(String(m.content || '')))));
  assert.ok(fake.requests.some((r) => r.messages.filter((m) => m.role === 'tool' && m.tool_name === 'read_file').length >= 2));
});

test('listing-only answers are forced to read the code first', async (t) => {
  const fake = await fakeOllama((req) => {
    const toolMsgs = req.messages.filter((m) => m.role === 'tool');
    const grounded = req.messages.some((m) => m.role === 'user' && /read the code first/i.test(String(m.content || '')));
    const cited = req.messages.some((m) => m.role === 'user' && /file:line citations/i.test(String(m.content || '')));
    const reads = req.messages.filter((m) => m.role === 'tool' && ['read_file', 'grep', 'lsp'].includes(m.tool_name)).length;
    if (!toolMsgs.length) return { tool_calls: [{ function: { name: 'list_files', arguments: {} } }] };
    if (!grounded) return { content: 'I can answer from the file list.' };
    if (reads < 2) return { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'sample.js' } } }] };
    if (!cited) return { content: 'I read the code.' };
    return { content: 'Evidence is in sample.js:1.' };
  });
  const { child, port } = await startServer();
  t.after(() => { child.kill('SIGKILL'); fake.srv.close(); });
  const base = `http://127.0.0.1:${port}`;
  await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: `http://127.0.0.1:${fake.port}`, model: 'fake', snapshots: false, recallAuto: false, nudgePrompt: false, permission: { edit: 'allow', bash: { '*': 'allow' } } }) });
  fs.writeFileSync(path.join(ctx.dir, 'sample.js'), 'module.exports = 1;\n');

  const ev = await chat(base, 'tell me what is here');
  assert.ok(ev.some((e) => e.type === 'info' && /read the code first/.test(e.text)));
  assert.ok(fake.requests.some((r) => r.messages.some((m) => m.role === 'user' && /read the code first/i.test(String(m.content || '')))));
  assert.ok(fake.requests.some((r) => r.messages.filter((m) => m.role === 'tool' && m.tool_name === 'read_file').length >= 2));
});

test('only one continuation notice is issued when grounding and unfinished triggers overlap', async (t) => {
  const todoCall = (status) => ({ tool_calls: [{ function: { name: 'todo_write', arguments: { todos: [{ content: 'Review code', status }] } } }] });
  const fake = await fakeOllama((req) => {
    const grounded = req.messages.some((m) => m.role === 'user' && /read the code first/i.test(String(m.content || '')));
    const reads = req.messages.filter((m) => m.role === 'tool' && m.tool_name === 'read_file' && !m.content.includes('"error"')).length;
    const completed = req.messages.some((m) => (m.tool_calls || []).some((c) => c.function.name === 'todo_write' && /completed/.test(JSON.stringify(c.function.arguments))));
    if (!req.messages.some((m) => m.role === 'tool')) return todoCall('in_progress');
    if (!grounded) return { content: 'I will review the codebase and report issues.' };
    if (reads < 2) return { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'sample.js' } } }] };
    if (!completed) return todoCall('completed');
    return { content: 'Reviewed sample.js:1.' };
  });
  const { child, port } = await startServer();
  t.after(() => { child.kill('SIGKILL'); fake.srv.close(); });
  const base = `http://127.0.0.1:${port}`;
  await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: `http://127.0.0.1:${fake.port}`, model: 'fake', snapshots: false, recallAuto: false, nudgePrompt: false, permission: { edit: 'allow', bash: { '*': 'allow' } } }) });
  fs.writeFileSync(path.join(ctx.dir, 'sample.js'), 'module.exports = 1;\n');

  const ev = await chat(base, 'review the codebase and report issues');
  const nudges = ev.filter((e) => e.type === 'info' && /^⟳ /.test(String(e.text || '')));
  assert.equal(nudges.length, 1, 'only one continuation notice should be emitted for the same assistant reply');
  assert.match(nudges[0].text, /read the code first/);
  assert.ok(!ev.some((e) => e.type === 'info' && /work is not finished/.test(String(e.text || ''))), 'the unfinished nudge must not fire again after grounding won');
  assert.ok(ev.some((e) => e.type === 'done'));
});

test('the model receives a compact ledger of current-turn read and write operations', async (t) => {
  const fake = await fakeOllama((req) => {
    const tools = req.messages.filter((m) => m.role === 'tool');
    if (!tools.length) return { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'sample.js' } } }] };
    if (tools.length === 1) return { tool_calls: [{ function: { name: 'write_file', arguments: { path: 'ledger-note.txt', content: 'hello\n' } } }] };
    return { content: 'Wrote ledger-note.txt based on sample.js:1.' };
  });
  const { child, port } = await startServer();
  t.after(() => { child.kill('SIGKILL'); fake.srv.close(); });
  const base = `http://127.0.0.1:${port}`;
  await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: `http://127.0.0.1:${fake.port}`, model: 'fake', snapshots: false, recallAuto: false, nudgePrompt: false, permission: { edit: 'allow', bash: { '*': 'allow' } } }) });
  fs.writeFileSync(path.join(ctx.dir, 'sample.js'), 'module.exports = 1;\n');

  const ev = await chat(base, 'record a note from the project');
  assert.ok(ev.some((e) => e.type === 'done'));
  const chatReq = [...fake.requests].reverse().find((r) => r.messages.some((m) => m.role === 'system' && /autonomous software engineer/.test(String(m.content || ''))));
  const system = String((chatReq.messages.find((m) => m.role === 'system') || {}).content || '');
  assert.match(system, /<current-turn file ledger/);
  assert.match(system, /read sample\.js lines 1-5000/);
  assert.match(system, /write ledger-note\.txt/);
  assert.ok(system.length < 20000, 'the ledger must stay compact');
  assert.ok(chatReq.messages.some((m) => m.role === 'tool' && m.tool_name === 'read_file' && /module\.exports/.test(String(m.content || ''))), 'the full read output stays in the conversation');
});
