'use strict';
// End-to-end smoke test: actually boot server.js and talk to its HTTP API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setup } = require('./helpers');

const ctx = setup();
const ROOT = path.join(__dirname, '..');

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', '0', '--dir', ctx.dir], {
      env: { ...process.env, OLLAMA_STUDIO_HOME: ctx.home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('server did not start in time:\n' + out)); }, 20000);
    const onData = (d) => {
      out += d.toString();
      const m = out.match(/url: http:\/\/[^:]+:(\d+)/);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early (${code}):\n${out}`)); });
  });
}

test('server boots, serves the UI and answers the HTTP API', async (t) => {
  const { child, port } = await startServer();
  t.after(() => child.kill('SIGKILL'));
  const base = `http://127.0.0.1:${port}`;

  const state = await (await fetch(base + '/api/state')).json();
  assert.equal(state.workDir, fs.realpathSync(ctx.dir));
  assert.ok(Array.isArray(state.agents));
  assert.ok(state.agents.some((a) => a.name === 'build'));
  assert.ok(state.subagents.some((a) => a.name === 'general'));

  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('<html'));

  const config = await (await fetch(base + '/api/config')).json();
  assert.ok(config.endpoint);

  const sessionsRes = await fetch(base + '/api/sessions');
  assert.equal(sessionsRes.status, 200);
  const list = await sessionsRes.json();
  assert.ok(Array.isArray(list.sessions));

  const missing = await fetch(base + '/api/nope');
  assert.ok([400, 404].includes(missing.status), `unexpected status ${missing.status}`);
});
