'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// public/net.js is a browser script: run it against a stub window and check which requests get the header.
function load() {
  const calls = [];
  const win = { fetch: async (input, init) => { calls.push({ input, init }); return {}; } };
  win.window = win;
  const ctx = vm.createContext({ window: win, location: { href: 'http://192.168.1.20:4310/', origin: 'http://192.168.1.20:4310' }, URL, Headers, Request: class {}, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'net.js'), 'utf8'), ctx);
  return { win, calls };
}

test('net.js adds X-Studio-Client to same-origin requests only, keeping other headers', async () => {
  const { win, calls } = load();
  await win.fetch('/api/upload?name=a.png', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: 'x' });
  await win.fetch('http://192.168.1.20:4310/api/state');
  await win.fetch('https://example.com/x', { headers: { A: 'b' } });
  assert.equal(calls[0].init.headers.get('x-studio-client'), 'web');
  assert.equal(calls[0].init.headers.get('content-type'), 'image/png');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[1].init.headers.get('x-studio-client'), 'web');
  assert.equal(calls[2].init && calls[2].init.headers && calls[2].init.headers.get && calls[2].init.headers.get('x-studio-client'), undefined);
});

test('index.html loads net.js before the app scripts', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(html.indexOf('/net.js') > -1 && html.indexOf('/net.js') < html.indexOf('/app.js'));
});
