'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGuard, isLoopbackBind } = require('../lib/guard');

const req = (method, pathname, headers = {}) => ({ req: { method, headers }, url: new URL('http://localhost' + pathname) });
const run = (g, method, pathname, headers) => { const r = req(method, pathname, headers); return g.check(r.req, r.url); };
const JSON_H = { 'content-type': 'application/json', 'content-length': '2' };

test('isLoopbackBind', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.5']) assert.equal(isLoopbackBind(h), true, h);
  for (const h of ['0.0.0.0', '192.168.1.5', '::', 'example.com']) assert.equal(isLoopbackBind(h), false, h);
});

test('loopback mode: no token, normal same-origin calls pass', () => {
  const g = createGuard({ bindHost: '127.0.0.1' });
  assert.equal(g.tokenRequired, false);
  assert.equal(run(g, 'GET', '/api/state', { host: '127.0.0.1:4310' }).ok, true);
  assert.equal(run(g, 'GET', '/api/state', { host: 'localhost:4310', origin: 'http://localhost:4310', 'sec-fetch-site': 'same-origin' }).ok, true);
  assert.equal(run(g, 'POST', '/api/chat', { host: '[::1]:4310', origin: 'http://[::1]:4310', ...JSON_H }).ok, true);
  assert.equal(run(g, 'GET', '/', { host: '127.0.0.1:4310', 'sec-fetch-site': 'none' }).ok, true);   // typed into the address bar
});

test('DNS rebinding: unknown Host header is refused in loopback mode', () => {
  const g = createGuard({ bindHost: '127.0.0.1' });
  const r = run(g, 'GET', '/api/config', { host: 'evil.example:4310' });
  assert.equal(r.ok, false); assert.equal(r.status, 403);
  assert.equal(run(g, 'GET', '/api/config', { host: 'evil.example:4310', origin: 'http://evil.example:4310' }).ok, false);
});

test('allowed extra hosts are honoured', () => {
  const g = createGuard({ bindHost: '127.0.0.1', extraHosts: ['studio.local'] });
  assert.equal(run(g, 'GET', '/api/state', { host: 'studio.local:4310' }).ok, true);
});

test('CSRF: cross-origin writes are refused, even as text/plain', () => {
  const g = createGuard({ bindHost: '127.0.0.1' });
  const evil = { host: '127.0.0.1:4310', origin: 'http://evil.example' };
  assert.equal(run(g, 'POST', '/api/config', { ...evil, 'content-type': 'text/plain', 'content-length': '20' }).status, 403);
  assert.equal(run(g, 'POST', '/api/chat', { ...evil, ...JSON_H }).status, 403);
  assert.equal(run(g, 'GET', '/api/config', evil).status, 403);
  // another localhost port is "same-site" but not same-origin
  assert.equal(run(g, 'POST', '/api/chat', { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:3000', ...JSON_H }).status, 403);
  assert.equal(run(g, 'POST', '/api/chat', { host: '127.0.0.1:4310', 'sec-fetch-site': 'same-site', ...JSON_H }).status, 403);
  assert.equal(run(g, 'POST', '/api/chat', { host: '127.0.0.1:4310', 'sec-fetch-site': 'cross-site', ...JSON_H }).status, 403);
});

test('writes without a JSON content type are refused (no preflight-free requests)', () => {
  const g = createGuard({ bindHost: '127.0.0.1' });
  const h = { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310' };
  assert.equal(run(g, 'POST', '/api/config', { ...h, 'content-type': 'text/plain', 'content-length': '5' }).status, 415);
  assert.equal(run(g, 'POST', '/api/config', { ...h, 'content-type': 'application/x-www-form-urlencoded', 'content-length': '5' }).status, 415);
  assert.equal(run(g, 'POST', '/api/config', { ...h, 'content-length': '5' }).status, 415);
  assert.equal(run(g, 'POST', '/api/config', { ...h, 'content-type': 'application/json; charset=utf-8', 'content-length': '5' }).ok, true);
  assert.equal(run(g, 'POST', '/api/abort', { ...h }).ok, true, 'a body-less POST is fine');
  assert.equal(run(g, 'POST', '/api/upload', { ...h, 'content-type': 'image/png', 'content-length': '9' }).ok, true, 'uploads stream raw bytes');
});

test('token mode: required, accepted via bearer / cookie / first-visit query, constant-time compare', () => {
  const g = createGuard({ bindHost: '0.0.0.0' });
  assert.equal(g.tokenRequired, true);
  assert.ok(g.token.length >= 24);
  const host = { host: '192.168.1.20:4310' };
  assert.equal(run(g, 'GET', '/', host).status, 401);
  assert.equal(run(g, 'GET', '/api/state', { ...host, authorization: 'Bearer nope' }).status, 401);
  assert.equal(run(g, 'GET', '/api/state', { ...host, authorization: 'Bearer ' + g.token }).ok, true);
  assert.equal(run(g, 'GET', '/api/state', { ...host, cookie: 'a=b; studio_token=' + encodeURIComponent(g.token) }).ok, true);
  const first = run(g, 'GET', '/?token=' + g.token, host);
  assert.equal(first.ok, true);
  assert.match(first.setCookie, /studio_token=.*HttpOnly.*SameSite=Strict/);
  assert.equal(run(g, 'GET', '/?token=wrong', host).status, 401);
  // a valid token does not switch off the CSRF checks
  assert.equal(run(g, 'POST', '/api/chat', { ...host, authorization: 'Bearer ' + g.token, origin: 'http://evil.example', ...JSON_H }).status, 403);
});

test('forced token (OLLAMA_STUDIO_TOKEN) also works on loopback', () => {
  const g = createGuard({ bindHost: '127.0.0.1', token: 'sekret-sekret-sekret-sekret' });
  assert.equal(g.tokenRequired, true);
  assert.equal(run(g, 'GET', '/api/state', { host: 'anything.example' }).status, 401);
  assert.equal(run(g, 'GET', '/api/state', { host: 'anything.example', authorization: 'Bearer sekret-sekret-sekret-sekret' }).ok, true);
});

test('UI header: a request from the studio page passes even when Origin/Host/Sec-Fetch-Site disagree (LAN phone, proxy, tunnel)', () => {
  const g = createGuard({ bindHost: '0.0.0.0' });
  const base = { host: '127.0.0.1:4310', authorization: 'Bearer ' + g.token, 'x-studio-client': 'web' };
  // proxy rewrote Host, browser sent the public Origin
  assert.equal(run(g, 'POST', '/api/upload', { ...base, origin: 'http://192.168.1.20:8080', 'content-type': 'image/jpeg', 'content-length': '9' }).ok, true);
  // browser labelled the request same-site / cross-site
  assert.equal(run(g, 'POST', '/api/upload', { ...base, 'sec-fetch-site': 'same-site', 'content-type': 'image/jpeg', 'content-length': '9' }).ok, true);
  assert.equal(run(g, 'POST', '/api/chat', { ...base, 'sec-fetch-site': 'cross-site', ...JSON_H }).ok, true);
  // the header does not replace the token or the content-type rule
  assert.equal(run(g, 'POST', '/api/chat', { host: '127.0.0.1:4310', 'x-studio-client': 'web', ...JSON_H }).status, 401);
  assert.equal(run(g, 'POST', '/api/config', { ...base, 'content-type': 'text/plain', 'content-length': '5' }).status, 415);
});

test('without the UI header a foreign Origin is still refused (a hostile page cannot add it: custom headers need a preflight)', () => {
  const g = createGuard({ bindHost: '127.0.0.1' });
  const evil = { host: '127.0.0.1:4310', origin: 'http://evil.example' };
  assert.equal(run(g, 'POST', '/api/upload', { ...evil, 'content-type': 'image/png', 'content-length': '9' }).status, 403);
  assert.equal(run(g, 'POST', '/api/upload', { ...evil, 'x-studio-client': 'nope', 'content-type': 'image/png', 'content-length': '9' }).status, 403);
});

test('proxies: forwarded host and listed origins count as same-origin; others do not', () => {
  const g = createGuard({ bindHost: '127.0.0.1', extraHosts: ['studio.lan'], extraOrigins: ['http://192.168.1.20:8080', 'tunnel.example'] });
  const host = { host: '127.0.0.1:4310', ...JSON_H };
  assert.equal(run(g, 'POST', '/api/chat', { ...host, origin: 'http://192.168.1.20:8080' }).ok, true);
  assert.equal(run(g, 'POST', '/api/chat', { ...host, origin: 'https://tunnel.example' }).ok, true);
  assert.equal(run(g, 'POST', '/api/chat', { ...host, origin: 'http://studio.lan', 'x-forwarded-host': 'studio.lan' }).ok, true);
  assert.equal(run(g, 'POST', '/api/chat', { ...host, origin: 'http://192.168.1.21:8080' }).status, 403);
  assert.equal(run(g, 'POST', '/api/chat', { ...host, origin: 'http://evil.example', 'x-forwarded-host': 'studio.lan' }).status, 403);
});

test('isSameOrigin (used by /api/shutdown)', () => {
  const g = createGuard({ bindHost: '127.0.0.1' });
  assert.equal(g.isSameOrigin({ headers: { host: 'localhost:4310' } }), true);
  assert.equal(g.isSameOrigin({ headers: { host: 'localhost:4310', origin: 'http://localhost:4310' } }), true);
  assert.equal(g.isSameOrigin({ headers: { host: 'localhost:4310', origin: 'http://evil.example' } }), false);
  assert.equal(g.isSameOrigin({ headers: { host: 'localhost:4310', origin: 'http://evil.example', 'x-studio-client': 'web' } }), true);
});
