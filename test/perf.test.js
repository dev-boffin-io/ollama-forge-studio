'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ctx = require('./helpers').setup();
const ws = require('../lib/workspace');
const sessions = require('../lib/sessions');
const recall = require('../lib/recall');
const { capForUi, chatWithRetry } = require('../lib/agent');
const llm = require('../lib/llm');

test('listDir: one level, dirs first, heavy folders flagged, capped', async () => {
  fs.mkdirSync(path.join(ctx.dir, 'src'));
  fs.mkdirSync(path.join(ctx.dir, '.venv'));
  fs.mkdirSync(path.join(ctx.dir, 'node_modules'));
  fs.writeFileSync(path.join(ctx.dir, 'a.txt'), 'x');
  fs.writeFileSync(path.join(ctx.dir, 'src', 'deep.js'), 'x');
  const root = await ws.listDir('');
  const names = root.entries.map((e) => e.name);
  assert.ok(names.includes('src') && names.includes('a.txt') && names.includes('.venv'));
  assert.ok(!names.includes('node_modules'));
  assert.equal(root.entries[0].type, 'dir');
  assert.ok(root.entries.find((e) => e.name === '.venv').heavy);
  assert.ok(!names.includes('deep.js'));                       // not recursive
  const sub = await ws.listDir('src');
  assert.deepEqual(sub.entries.map((e) => e.path), ['src/deep.js']);
  await assert.rejects(ws.listDir('../etc'), /escapes/);
});

test('walk: skips dependency folders, is cached and invalidated by writes', async () => {
  fs.mkdirSync(path.join(ctx.dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'node_modules', 'x', 'big.js'), 'x');
  fs.mkdirSync(path.join(ctx.dir, '.venv', 'lib', 'site-packages'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, '.venv', 'lib', 'site-packages', 'p.py'), 'x');
  ws.invalidateWalk();
  const r1 = await ws.walk();
  assert.ok(!r1.files.some((f) => f.includes('node_modules') || f.includes('.venv')));
  fs.writeFileSync(path.join(ctx.dir, 'late.txt'), 'x');      // not via ws.writeFile: cache still serves the old list
  assert.ok(!(await ws.walk()).files.includes('late.txt'));
  await ws.writeFile('another.txt', 'y');                       // ws.writeFile invalidates
  assert.ok((await ws.walk()).files.includes('late.txt'));
});

test('walk: honours the entry limit and says it was cut', async () => {
  fs.mkdirSync(path.join(ctx.dir, 'many'));
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(ctx.dir, 'many', `f${i}.txt`), 'x');
  ws.invalidateWalk();
  const r = await ws.walk({ limit: 20 });
  assert.equal(r.truncated, true);
  assert.match(r.reason, /more than 20/);
  ws.invalidateWalk();
});

test('grep: finds matches across files (parallel) with stable ordering', async () => {
  ws.invalidateWalk();
  fs.writeFileSync(path.join(ctx.dir, 'g1.js'), 'const needle = 1;\n');
  fs.writeFileSync(path.join(ctx.dir, 'g2.js'), 'nothing\nneedle again\n');
  const r = await ws.grep('needle', '*.js');
  const m = (r.matches || r);
  assert.deepEqual(m.filter((x) => x.startsWith('g')).map((x) => x.split(':').slice(0, 2).join(':')), ['g1.js:1', 'g2.js:2']);
});

test('sessions.save: concurrent saves never race and the last state wins', async () => {
  const s = await sessions.create({ title: 'race' });
  const writes = [];
  for (let i = 0; i < 25; i++) { s.messages.push({ role: 'user', content: 'm' + i }); writes.push(sessions.save(s)); }
  await Promise.all(writes);
  const back = await sessions.get(s.id);
  assert.equal(back.messages.length, 25);
  assert.ok(!fs.readdirSync(path.join(ctx.studioDir, 'sessions')).some((n) => n.endsWith('.tmp')));
});

test('sessions.list: cached summaries follow saves, deletes and corrupt files do not break it', async () => {
  const a = await sessions.create({ title: 'A' });
  const b = await sessions.create({ title: 'B' });
  a.title = 'A2'; await sessions.save(a);
  fs.writeFileSync(path.join(ctx.studioDir, 'sessions', 'ses_broken1.json'), '{not json');
  const rows = await sessions.list();
  assert.ok(rows.some((r) => r.id === a.id && r.title === 'A2'));
  assert.ok(rows.some((r) => r.id === b.id));
  await sessions.remove(b.id);
  assert.ok(!(await sessions.list()).some((r) => r.id === b.id));
  await assert.rejects(sessions.get('ses_doesnotexist1'), (e) => e.status === 404);
});

test('recall.indexSession: second call on an unchanged session does no work', { skip: !recall.available() }, () => {
  const s = { id: 'ses_recalltest1', messages: [{ role: 'user', content: 'the quick brown fox jumps over the lazy dog' }, { role: 'assistant', content: 'a reply that is long enough to be indexed' }] };
  assert.ok(recall.indexSession(s) > 0);
  assert.equal(recall.indexSession(s), 0);
  s.messages.push({ role: 'user', content: 'a brand new message about elephants and giraffes' });
  assert.ok(recall.indexSession(s) > 0);
});

test('capForUi: shortens huge strings/arrays for the browser only', () => {
  const big = { content: 'x'.repeat(50000), files: Array.from({ length: 1000 }, (_, i) => 'f' + i), small: 'ok', n: 3 };
  const c = capForUi(big);
  assert.ok(c.content.length < 13000 && /more characters/.test(c.content));
  assert.equal(c.files.length, 301);
  assert.equal(c.small, 'ok');
  assert.equal(big.content.length, 50000);                      // original untouched
});

test('chatWithRetry: retries a 524, shortens the prompt once, then succeeds; never retries a 401', async () => {
  const { fromResponse } = require('../lib/errors');
  const orig = llm.chatStream;
  const events = [];
  let calls = 0;
  let shrinkCalls = 0;
  llm.chatStream = async (args) => { calls++; if (calls < 3) throw fromResponse(524, '<html><title>524</title></html>', 'Ollama chat'); return { content: 'ok:' + args.messages.length, toolCalls: [] }; };
  try {
    const r = await chatWithRetry({ provider: { endpoint: 'http://x' }, messages: [1, 2, 3], shrink: async () => { shrinkCalls++; return [1]; } }, (e) => events.push(e), null);
    assert.equal(r.content, 'ok:1');                           // the retry used the shortened messages
    assert.equal(shrinkCalls, 1);
    assert.ok(events.some((e) => e.type === 'retry' && /524/.test(e.message) && !/<html/.test(e.message)));
    calls = 0;
    llm.chatStream = async () => { calls++; throw fromResponse(401, '', 'x'); };
    await assert.rejects(chatWithRetry({ provider: {}, messages: [] }, () => {}, null), /401/);
    assert.equal(calls, 1);
  } finally { llm.chatStream = orig; }
});
