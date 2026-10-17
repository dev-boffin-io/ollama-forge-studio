'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers').setup();
const E = require('../lib/errors');

test('cleanBody: gateway HTML pages become one readable line', () => {
  const html = '<!DOCTYPE html><!--[if lt IE 7]> <html class="no-js ie6 oldie"> <![endif]--><html><head><title>x.trycloudflare.com | 524: A timeout occurred</title></head><body><h1>Error code 524</h1><p>lots of markup</p></body></html>';
  const t = E.cleanBody(html);
  assert.ok(t.includes('524: A timeout occurred'));
  assert.ok(!t.includes('<'));
  assert.ok(t.length < 300);
});

test('cleanBody: JSON error bodies and long text', () => {
  assert.equal(E.cleanBody('{"error":{"message":"model not found"}}'), 'model not found');
  assert.equal(E.cleanBody('{"error":"bad key"}'), 'bad key');
  assert.ok(E.cleanBody('x'.repeat(1000)).length <= 241);
  assert.equal(E.cleanBody(''), '');
});

test('fromResponse: status, hint, Cloudflare code', () => {
  const e = E.fromResponse(524, '<html><title>524: A timeout occurred</title><body>Error code 524</body></html>', 'Ollama chat');
  assert.equal(e.status, 524);
  assert.match(e.message, /HTTP 524 from Ollama chat/);
  assert.match(e.message, /too big|compact/i);
  assert.ok(!e.message.includes('<html'));
  assert.match(E.fromResponse(401, '', 'x').message, /API key/);
});

test('isRetryable: transient yes, client errors no', () => {
  assert.equal(E.isRetryable(E.fromResponse(524, '', 'x')), true);
  assert.equal(E.isRetryable(E.fromResponse(503, '', 'x')), true);
  assert.equal(E.isRetryable(E.fromResponse(429, '', 'x')), true);
  assert.equal(E.isRetryable(E.fromResponse(401, '', 'x')), false);
  assert.equal(E.isRetryable(E.fromResponse(404, '', 'x')), false);
  assert.equal(E.isRetryable(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), true);
  assert.equal(E.isRetryable(new Error('Unexpected token in my code')), false);
  assert.equal(E.isRetryable(new Error('terminated')), true);
});

test('explain: DNS / refused / timeout get plain-language messages', () => {
  const dns = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  assert.match(E.explain(dns, 'https://a.trycloudflare.com'), /cannot reach https:\/\/a\.trycloudflare\.com.*DNS/);
  const agg = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { errors: [{ code: 'ECONNREFUSED' }] }) });
  assert.match(E.explain(agg, 'http://127.0.0.1:1'), /refused/);
  const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  assert.match(E.explain(abort, 'x'), /timed out/);
});

test('statusFor: maps errors to HTTP statuses', () => {
  assert.equal(E.statusFor(new Error('bad input')), 400);
  assert.equal(E.statusFor(Object.assign(new Error('x'), { code: 'ENOENT' })), 404);
  assert.equal(E.statusFor(Object.assign(new Error('x'), { code: 'EACCES' })), 403);
  assert.equal(E.statusFor(Object.assign(new Error('x'), { status: 413 })), 413);
  assert.equal(E.statusFor(new TypeError('x is not a function')), 500);
});

test('fetchOk: network failure and HTTP error become readable errors', async () => {
  await assert.rejects(E.fetchOk('http://127.0.0.1:9/x', {}, { source: 'test', where: 'http://127.0.0.1:9' }), /cannot reach http:\/\/127\.0\.0\.1:9/);
  const http = require('node:http');
  const srv = http.createServer((req, res) => { res.statusCode = 502; res.end('<html><title>502 Bad Gateway</title></html>'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(E.fetchOk(`http://127.0.0.1:${srv.address().port}/`, {}, { source: 'gw' }), (e) => e.status === 502 && /502 Bad Gateway/.test(e.message) && !/<html/.test(e.message));
  } finally { srv.close(); }
});
