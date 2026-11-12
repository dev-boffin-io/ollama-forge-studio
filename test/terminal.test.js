'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setup } = require('./helpers');

const ctx = setup();
const terminal = require('../lib/terminal');
const ROOT = path.join(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDone(id, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const t = terminal.get(id);
    if (t && !t.running) return t;
    await sleep(25);
  }
  throw new Error('terminal did not finish in time');
}

test('runs a command in the working directory and keeps stdout/stderr for replay', async () => {
  const t = terminal.start('pwd; echo out; echo err >&2');
  assert.match(t.id, /^term_\d+$/);
  assert.equal(t.running, true);
  assert.equal(t.command, 'pwd; echo out; echo err >&2');
  const done = await waitDone(t.id);
  assert.equal(done.exit_code, 0);
  assert.equal(done.killed, false);
  const text = done.chunks.map((c) => c.text).join('');
  assert.match(text, new RegExp(ctx.cfg.getWorkDir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(text, /out/);
  assert.match(text, /err/);
  assert.ok(done.chunks.some((c) => c.stream === 'stderr' && /err/.test(c.text)));
  assert.ok(done.chunks.every((c, i) => c.seq === i + 1));
});

test('live subscribers receive ordered output and a final exit event', async () => {
  const t = terminal.start('echo one; sleep 0.15; echo two');
  const events = [];
  const unsub = terminal.subscribe(t.id, (ev) => events.push(ev));
  const done = await waitDone(t.id);
  unsub();
  const text = events.filter((e) => e.type === 'output').map((e) => e.text).join('');
  assert.match(text, /one[\s\S]*two/);
  const exit = events.find((e) => e.type === 'exit');
  assert.ok(exit);
  assert.equal(exit.code, 0);
  assert.equal(exit.killed, false);
  assert.equal(done.running, false);
});

test('stop() kills a long-running command and marks it as killed', async () => {
  const t = terminal.start('sleep 30');
  await sleep(80);
  terminal.stop(t.id);
  const done = await waitDone(t.id);
  assert.equal(done.running, false);
  assert.equal(done.killed, true);
});

test('rejects an empty command', () => {
  assert.throws(() => terminal.start('   '), /command is required/);
});

test('HTTP API: start, stream SSE, list and stop', async (t) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', '0', '--dir', ctx.dir], {
    env: { ...process.env, OLLAMA_STUDIO_HOME: ctx.home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('server did not start:\n' + out)), 20000);
    const onData = (d) => {
      out += d.toString();
      const m = out.match(/url: http:\/\/[^:]+:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited (${code}):\n${out}`)); });
  });
  const base = `http://127.0.0.1:${port}`;

  const started = await (await fetch(base + '/api/terminal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'echo hello; echo bad >&2' }),
  })).json();
  assert.match(started.id, /^term_/);

  const stream = await fetch(base + `/api/terminal/${started.id}/stream`);
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const body = await stream.text();
  const events = body.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  assert.equal(events[0].type, 'start');
  assert.match(events.filter((e) => e.type === 'output').map((e) => e.text).join(''), /hello/);
  assert.ok(events.some((e) => e.type === 'output' && e.stream === 'stderr' && /bad/.test(e.text)));
  assert.ok(events.some((e) => e.type === 'exit' && e.code === 0));

  const list = await (await fetch(base + '/api/terminal')).json();
  assert.ok(list.terminals.some((x) => x.id === started.id && !x.running));

  const long = await (await fetch(base + '/api/terminal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'sleep 30' }),
  })).json();
  const stopped = await (await fetch(base + `/api/terminal/${long.id}`, { method: 'DELETE' })).json();
  assert.equal(stopped.id, long.id);
  for (let i = 0; i < 100; i++) {
    const now = (await (await fetch(base + '/api/terminal')).json()).terminals.find((x) => x.id === long.id);
    if (now && !now.running) { assert.equal(now.killed, true); break; }
    await sleep(50);
    if (i === 99) assert.fail('stopped terminal never reported a final state');
  }
});
