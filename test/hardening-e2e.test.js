'use strict';
// Boots the real server.js and attacks it the way a malicious web page / another machine would.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setup } = require('./helpers');

const ctx = setup();
const ROOT = path.join(__dirname, '..');

function start(extraArgs = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', '0', '--dir', ctx.dir, ...extraArgs], {
      env: { ...process.env, OLLAMA_STUDIO_HOME: ctx.home, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('server did not start:\n' + out)); }, 20000);
    const onData = (d) => {
      out += d.toString();
      const m = out.match(/url: http:\/\/[^:]+:(\d+)(\/\?token=([\w-]+))?/);
      if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]), token: m[3] || null, out: () => out }); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early (${code}):\n${out}`)); });
  });
}

// node's fetch forbids setting Host/Origin freely in some versions, so use http.request for the hostile cases
const raw = (port, { method = 'GET', path: p = '/', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
    let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
  });
  r.on('error', reject);
  if (body !== undefined) r.write(body);
  r.end();
});

test('loopback server: legit UI calls work, hostile cross-site calls are refused and change nothing', async (t) => {
  const { child, port } = await start();
  t.after(() => child.kill('SIGKILL'));
  const base = `http://127.0.0.1:${port}`;
  const before = await (await fetch(base + '/api/config')).json();

  // legit
  assert.equal((await fetch(base + '/api/state')).status, 200);
  const put = await fetch(base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ temperature: 0.3 }) });
  assert.equal(put.status, 200);

  // CSRF: evil page, text/plain "simple" request
  const csrf = await raw(port, { method: 'POST', path: '/api/config', headers: { host: `127.0.0.1:${port}`, origin: 'http://evil.example', 'content-type': 'text/plain', 'content-length': '42' }, body: '{"permission":{"bash":{"*":"allow"}}}     ' });
  assert.equal(csrf.status, 403);
  // same-origin looking but not JSON
  const plain = await raw(port, { method: 'POST', path: '/api/config', headers: { host: `127.0.0.1:${port}`, 'content-type': 'text/plain', 'content-length': '37' }, body: '{"permission":{"bash":{"*":"allow"}}}' });
  assert.equal(plain.status, 415);
  // DNS rebinding
  const rebind = await raw(port, { path: '/api/config', headers: { host: `evil.example:${port}` } });
  assert.equal(rebind.status, 403);
  const rebindChat = await raw(port, { method: 'POST', path: '/api/chat', headers: { host: `evil.example:${port}`, origin: `http://evil.example:${port}`, 'content-type': 'application/json', 'content-length': '2' }, body: '{}' });
  assert.equal(rebindChat.status, 403);

  const after = await (await fetch(base + '/api/config')).json();
  assert.deepEqual(after.permission, before.permission, 'permissions untouched by the attacks');

  // hardening headers on every response
  const idx = await fetch(base + '/');
  assert.equal(idx.headers.get('x-frame-options'), 'DENY');
  assert.match(idx.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(idx.headers.get('x-content-type-options'), 'nosniff');
});

test('oversized JSON bodies are rejected with 413', async (t) => {
  const { child, port } = await start();
  t.after(() => child.kill('SIGKILL'));
  const big = Buffer.alloc(9 * 1024 * 1024, 'a');
  const r = await raw(port, { method: 'POST', path: '/api/abort', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': String(big.length) }, body: big }).catch((e) => ({ status: e.code === 'ECONNRESET' || e.code === 'EPIPE' ? 413 : 0 }));
  assert.equal(r.status, 413);
});

test('network-facing server (--host 0.0.0.0) requires the token', async (t) => {
  const { child, port, token } = await start(['--host', '0.0.0.0']);
  t.after(() => child.kill('SIGKILL'));
  assert.ok(token && token.length >= 24, 'startup prints a URL that contains the token');
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + '/')).status, 401);
  assert.equal((await fetch(base + '/api/state', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(base + '/api/state', { headers: { Authorization: 'Bearer ' + token } })).status, 200);
  const first = await fetch(base + '/?token=' + token, { redirect: 'manual' });
  assert.equal(first.status, 200);
  const cookie = first.headers.get('set-cookie');
  assert.match(cookie, /studio_token=/);
  assert.equal((await fetch(base + '/api/state', { headers: { Cookie: cookie.split(';')[0] } })).status, 200);
});

test('OLLAMA_STUDIO_ALLOWED_HOSTS lets a named host through on loopback', async (t) => {
  const { child, port } = await start([], { OLLAMA_STUDIO_ALLOWED_HOSTS: 'studio.test' });
  t.after(() => child.kill('SIGKILL'));
  assert.equal((await raw(port, { path: '/api/state', headers: { host: `studio.test:${port}` } })).status, 200);
});

test('project trust API: untrusted -> trust -> plugins load', async (t) => {
  const dir = path.join(ctx.dir, '.claude', 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'p1.js'), `module.exports = { name: 'p1', setup() {} };`);
  const { child, port } = await start([], { OLLAMA_STUDIO_TRUST_PROJECT: '' });
  t.after(() => child.kill('SIGKILL'));
  const base = `http://127.0.0.1:${port}`;
  const j = { 'Content-Type': 'application/json' };
  let s = await (await fetch(base + '/api/trust')).json();
  assert.equal(s.trusted, false);
  assert.equal((await (await fetch(base + '/api/plugins')).json()).plugins.some((p) => p.name === 'p1'), false);
  s = await (await fetch(base + '/api/trust', { method: 'POST', headers: j, body: JSON.stringify({ trust: true, remember: false }) })).json();
  assert.equal(s.trusted, true);
  assert.equal((await (await fetch(base + '/api/plugins')).json()).plugins.some((p) => p.name === 'p1'), true);
});
