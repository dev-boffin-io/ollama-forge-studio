'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { setup } = require('./helpers');

const ctx = setup();

// public/markdown.js is a browser script; run it with minimal DOM stubs.
const source = fs.readFileSync(path.join(ctx.cfg.APP_ROOT, 'public', 'markdown.js'), 'utf8');
const sandbox = { window: {}, document: { addEventListener() {} }, navigator: {}, setTimeout, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const { renderMarkdown, markdownToText } = sandbox.window;

test('renderMarkdown: XSS is escaped, only generated tags reach the output', () => {
  const html = renderMarkdown('Hello <script>alert(1)</script> <img src=x onerror=alert(2)>');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('src=x>'));   // stays escaped text, never becomes a tag
});

test('renderMarkdown: headings, emphasis, lists and links', () => {
  const html = renderMarkdown('# Title\n\nSome **bold** and *italic* text.\n\n- one\n- two\n\n[docs](https://example.com)');
  assert.ok(/<h2[^>]*>Title<\/h2>/.test(html), html);   // "# " renders as h2
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<em>italic</em>'));
  assert.ok(html.includes('<li>one</li>'));
  assert.ok(html.includes('<a href="https://example.com"'));
});

test('renderMarkdown: dangerous link schemes are not linked', () => {
  const html = renderMarkdown('[click](javascript:alert(1))');
  assert.ok(!html.includes('href="javascript'));
  const mail = renderMarkdown('[mail](mailto:a@b.c)');
  assert.ok(mail.includes('href="mailto:a@b.c"'));
});

test('renderMarkdown: fenced code gets a block with a copy button', () => {
  const html = renderMarkdown('```js\nconst x = 1;\n```');
  const text = html.replace(/<[^>]+>/g, '');
  assert.ok(html.includes('<code'));
  assert.ok(html.includes('copy-btn'));
  assert.ok(text.includes('const x = 1;'));
});

test('markdownToText: strips formatting for the clipboard', () => {
  const text = markdownToText('# Title\n\nSome **bold** and `code` text.\n\n- item\n[docs](https://example.com)');
  assert.ok(text.includes('Title'));
  assert.ok(text.includes('bold'));
  assert.ok(text.includes('code'));
  assert.ok(!text.includes('**'));
  assert.ok(!text.includes('# '));
  assert.ok(text.includes('• item'));
  assert.ok(text.includes('docs (https://example.com)'));
});
