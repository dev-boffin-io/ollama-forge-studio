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

test('websearch ddg parser deduplicates by url', () => {
  const html = `
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fa">A</a>
    <a class="result__snippet">snip a</a>
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fa">A2</a>
    <a class="result__snippet">snip a2</a>
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fb">B</a>
    <a class="result__snippet">snip b</a>
  `;
  const items = web.websearch._parseHtml(html, 10);
  assert.equal(items.length, 2);
  assert.equal(items[0].url, 'https://example.com/a');
  assert.equal(items[1].url, 'https://example.com/b');
});

test('websearch cache ttl and dedup across variants', async () => {
  const web2 = require('../lib/web');
  web2.websearch._cache.clear();
  const orig = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response('<a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fx">X</a><a class="result__snippet">s</a>', { status: 200 });
  };
  try {
    const r1 = await web2.websearch('hello world test', {}, 5);
    const r2 = await web2.websearch('hello world test', {}, 5);
    assert.ok(calls <= 2);
    assert.ok(r1.includes('example.com/x'));
    assert.ok(r2.includes('example.com/x'));
  } finally {
    global.fetch = orig;
  }
});

test('websearch throws clear error if ddg returns unparseable html', async () => {
  const web2 = require('../lib/web');
  web2.websearch._cache.clear();
  const orig = global.fetch;
  global.fetch = async () => new Response('<html>blocked</html>', { status: 200 });
  try {
    await assert.rejects(() => web2.websearch('blocked', {}, 5), /no parseable results|DuckDuckGo/);
  } finally {
    global.fetch = orig;
  }
});
