'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const web = require('../lib/web');

test('isPrivateHost: localhost/LAN/link-local are private, the rest are not', () => {
  for (const u of [
    'http://localhost:3000/x', 'http://LOCALHOST/', 'https://printer.local/status',
    'http://db.internal/', 'http://127.0.0.1:8080/', 'http://10.1.2.3/',
    'http://192.168.0.5/', 'http://172.16.9.9/', 'http://172.31.1.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://[::1]:8000/',
    'http://[fd00::1]/', 'http://0.0.0.0/',
  ]) assert.equal(web.isPrivateHost(u), true, u);

  for (const u of [
    'https://example.com/', 'https://8.8.8.8/', 'http://172.32.0.1/',
    'https://api.github.com/repos', 'not-a-url',
  ]) assert.equal(web.isPrivateHost(u), false, u);
});

test('htmlToMarkdown: headings, links, emphasis, lists and code', () => {
  const md = web.htmlToMarkdown(`
    <html><head><title>t</title></head><body>
    <h1>Title</h1>
    <p>Hello <strong>world</strong> and <em>friends</em>.</p>
    <ul><li>one</li><li>two</li></ul>
    <pre>const x = 1;</pre>
    <p>See <a href="https://example.com/docs">the docs</a>.</p>
    <script>alert(1)</script>
    </body></html>`);
  assert.ok(md.includes('# Title'));
  assert.ok(md.includes('**world**'));
  assert.ok(md.includes('*friends*'));
  assert.ok(md.includes('- one'));
  assert.ok(md.includes('- two'));
  assert.ok(md.includes('```'));
  assert.ok(md.includes('const x = 1;'));
  assert.ok(md.includes('[the docs](https://example.com/docs)'));
  assert.ok(!md.includes('alert(1)'));
  assert.ok(!md.includes('<script>'));
  assert.ok(!md.includes('<h1>'));
});
