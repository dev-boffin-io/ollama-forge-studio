'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');
const env = setup();
const snapshot = require('../lib/snapshot');

test('first track warms up in the background (null), then snapshots and restores bash-style changes', async () => {
  fs.writeFileSync(path.join(env.dir, 'a.txt'), 'one');
  assert.equal(await snapshot.track(), null);             // cold: does not block, does not disable
  assert.equal(await snapshot.warmUp(), true);
  assert.equal(snapshot.status(), '');
  const s1 = await snapshot.track();
  assert.match(String(s1), /^[0-9a-f]{40}$/);
  fs.writeFileSync(path.join(env.dir, 'a.txt'), 'two');
  fs.writeFileSync(path.join(env.dir, 'b.txt'), 'new');
  const s2 = await snapshot.track();
  assert.notEqual(s1, s2);
  const files = await snapshot.diff(s1, s2);
  assert.ok(files.length >= 2);
  await snapshot.restore(s1, s2);
  assert.equal(fs.readFileSync(path.join(env.dir, 'a.txt'), 'utf8'), 'one');
  assert.equal(fs.existsSync(path.join(env.dir, 'b.txt')), false);
});

test('ensureBefore fills a missing before-snapshot and a stale disabled marker is ignored', async () => {
  fs.writeFileSync(path.join(env.studioDir, 'snapshot.disabled'), 'old');
  const session = { turn: 3, snaps: {} };
  await snapshot.ensureBefore(session);
  assert.match(String(session.snaps[3]), /^[0-9a-f]{40}$/);
});
