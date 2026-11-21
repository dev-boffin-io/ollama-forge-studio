'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const web = require('../lib/web');

test('isPrivateIp: v4 ranges, v6, IPv4-mapped IPv6', () => {
  const priv = ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '[::1]', '::ffff:a9fe:a9fe'];
  for (const ip of priv) assert.equal(web.isPrivateIp(ip), true, ip);
  const pub = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '100.63.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'];
  for (const ip of pub) assert.equal(web.isPrivateIp(ip), false, ip);
});

test('isPrivateHost: names and literals (decimal / hex / octal IPv4 are normalised by URL)', () => {
  for (const u of ['http://localhost:3000/', 'http://foo.localhost/', 'http://printer.local/', 'http://db.internal/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://169.254.169.254/latest/meta-data', 'http://10.1.2.3/', 'http://192.168.1.1/'])
    assert.equal(web.isPrivateHost(u), true, u);
  for (const u of ['https://example.com/', 'http://8.8.8.8/', 'https://localhost.example.com/', 'not a url']) assert.equal(web.isPrivateHost(u), false, u);
});

const realFetch = global.fetch;
const redirect = (to) => new Response(null, { status: 302, headers: { location: to } });
const ok = (body = 'hello', type = 'text/plain') => new Response(body, { status: 200, headers: { 'content-type': type } });

test('a public URL that redirects to a private address is blocked', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  global.fetch = async (u) => (String(u).includes('start.invalid') ? redirect('http://169.254.169.254/latest/meta-data/') : ok());
  await assert.rejects(web.webfetch({ url: 'http://start.invalid/' }), /private\/internal/);
  global.fetch = async (u) => (String(u).includes('start.invalid') ? redirect('http://localhost:8080/admin') : ok());
  await assert.rejects(web.webfetch({ url: 'http://start.invalid/' }), /private\/internal/);
  global.fetch = async (u) => (String(u).includes('start.invalid') ? redirect('file:///etc/passwd') : ok());
  await assert.rejects(web.webfetch({ url: 'http://start.invalid/' }), /non-http/);
});

test('public redirects are followed (relative too), loops are capped', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  global.fetch = async (u) => { const s = String(u); return s.endsWith('/a') ? redirect('/b') : s.endsWith('/b') ? ok('final') : ok('x'); };
  const r = await web.webfetch({ url: 'http://one.invalid/a' });
  assert.equal(r.content, 'final');
  assert.equal(r.url, 'http://one.invalid/b');
  global.fetch = async () => redirect('/again');
  await assert.rejects(web.webfetch({ url: 'http://loop.invalid/' }), /too many redirects/);
});

test('an address the user already approved as private may redirect inside the private network', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  global.fetch = async (u) => (String(u).endsWith('/start') ? redirect('http://127.0.0.1:9/next') : ok('inside'));
  const r = await web.webfetch({ url: 'http://127.0.0.1:9/start' });
  assert.equal(r.content, 'inside');
});

test('literal private IP without prior approval path (allowPrivate=false) still reaches fetch only via the permission-gated caller', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  global.fetch = async () => ok('ok');
  assert.equal((await web.webfetch({ url: 'http://10.0.0.5/x' })).content, 'ok');   // gating happens in tools.js (webfetch_private -> ask)
});
