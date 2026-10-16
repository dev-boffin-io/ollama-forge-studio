'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

const ctx = setup();
const sessions = require('../lib/sessions');

test('create / get / list / latest', async () => {
  const s = await sessions.create({ agent: 'build', model: 'llama3', title: 'First' });
  assert.match(s.id, /^ses_[a-z0-9]{6,}$/);
  assert.deepEqual(s.messages, []);
  assert.equal(s.parentId, null);

  const got = await sessions.get(s.id);
  assert.equal(got.title, 'First');

  const rows = await sessions.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, s.id);
  assert.equal(rows[0].messageCount, 0);
  assert.equal((await sessions.latest()).id, s.id);

  await assert.rejects(() => sessions.get('ses_doesnotexist000'), /session not found/);
  await assert.rejects(() => sessions.get('../../evil'), /invalid session id/);
  await assert.rejects(() => sessions.get('nope'), /invalid session id/);
});

test('save: persists messages and bumps updatedAt', async () => {
  const s = await sessions.create({ title: 'Chat' });
  const before = s.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  s.messages.push({ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' });
  await sessions.save(s);
  const got = await sessions.get(s.id);
  assert.equal(got.messages.length, 2);
  assert.ok(got.updatedAt > before);
});

test('subagent children are hidden from list but reachable via children()', async () => {
  const parent = await sessions.create({ title: 'parent' });
  const child = await sessions.create({ title: 'child', parentId: parent.id });
  const rows = await sessions.list();
  assert.ok(!rows.some((r) => r.id === child.id));
  assert.ok((await sessions.list({ includeChildren: true })).some((r) => r.id === child.id));
  const kids = await sessions.children(parent.id);
  assert.equal(kids.length, 1);
  assert.equal(kids[0].id, child.id);
});

test('fork: copies messages (optionally sliced) and marks the source', async () => {
  const s = await sessions.create({ title: 'src', model: 'm', agent: 'build' });
  s.messages.push({ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }, { role: 'user', content: 'three' });
  await sessions.save(s);

  const f = await sessions.fork(s.id);
  assert.equal(f.title, 'src (fork)');
  assert.equal(f.forkOf, s.id);
  assert.equal(f.model, 'm');
  assert.equal(f.messages.length, 3);
  assert.notEqual(f.id, s.id);

  const partial = await sessions.fork(s.id, 2);
  assert.equal(partial.messages.length, 2);
  assert.equal(partial.messages[1].content, 'two');
});

test('archive: summarised-away messages stay in the transcript', async () => {
  const s = await sessions.create({ title: 'arch' });
  s.messages.push({ role: 'user', content: 'live message' });
  await sessions.save(s);
  await sessions.archiveAppend(s.id, [{ role: 'user', content: 'old one', summary: true }, { role: 'assistant', content: 'old two' }], 0);
  s.archived = 2;
  await sessions.save(s);

  const rows = await sessions.archiveRead(s.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].content, 'old one');
  assert.equal((await sessions.archiveRead(s.id, 1)).length, 1);

  const t = await sessions.transcript(s);
  assert.equal(t.length, 3);
  assert.equal(t[0].content, 'old one');
  assert.equal(t[2].content, 'live message');
});

test('exportTree: session plus children recursively', async () => {
  const p = await sessions.create({ title: 'root' });
  const c1 = await sessions.create({ title: 'c1', parentId: p.id });
  await sessions.create({ title: 'c2', parentId: c1.id });
  const tree = await sessions.exportTree(p.id);
  assert.equal(tree.title, 'root');
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].title, 'c1');
  assert.equal(tree.children[0].children.length, 1);
});

test('remove: deletes a session and its children', async () => {
  const p = await sessions.create({ title: 'gone' });
  const c = await sessions.create({ title: 'child', parentId: p.id });
  await sessions.remove(p.id);
  await assert.rejects(() => sessions.get(p.id), /session not found/);
  await assert.rejects(() => sessions.get(c.id), /session not found/);
});
