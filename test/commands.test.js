'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');

const ctx = setup();
const commands = require('../lib/commands');

test('built-in commands are always available', () => {
  const all = commands.loadCommands();
  assert.ok(all.init && all.init.builtin);
  assert.ok(all.review && all.review.builtin);
  assert.equal(all.init.description, 'create/update AGENTS.md for this directory');
});

test('expand: /init substitutes $ARGUMENTS', async () => {
  const r = await commands.expand('/init focus on the test suite');
  assert.equal(r.command.name, 'init');
  assert.ok(r.text.includes('focus on the test suite'));
  assert.ok(!r.text.includes('$ARGUMENTS'));
  assert.ok(r.text.includes('AGENTS.md'));
});

test('expand: unknown or non-command input returns null', async () => {
  assert.equal(await commands.expand('just a message'), null);
  assert.equal(await commands.expand('/does-not-exist args'), null);
  assert.equal(await commands.expand('/'), null);
});

test('expand: custom command with $1..$9, $ARGUMENTS and quoted args', async () => {
  const dir = path.join(ctx.studioDir, 'commands');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'deploy.md'), '---\ndescription: Deploy it\nagent: build\n---\nDeploy $1 to $ARGUMENTS (again: $1)\n', 'utf8');
  const r = await commands.expand('/deploy staging cluster-wide');
  assert.equal(r.command.name, 'deploy');
  assert.equal(r.command.description, 'Deploy it');
  assert.equal(r.command.agent, 'build');
  assert.equal(r.text, 'Deploy staging to staging cluster-wide (again: staging)');

  const q = await commands.expand('/deploy "my app"');
  assert.equal(q.text, 'Deploy my app to "my app" (again: my app)');   // $ARGUMENTS keeps the raw text
});

test('expand: @path inlines a project file', async () => {
  fs.writeFileSync(path.join(ctx.dir, 'notes.txt'), 'HELLO NOTES', 'utf8');
  const dir = path.join(ctx.studioDir, 'commands');
  fs.writeFileSync(path.join(dir, 'check.md'), 'Check @notes.txt please', 'utf8');
  const r = await commands.expand('/check');
  assert.ok(r.text.startsWith('Check @notes.txt please'));
  assert.ok(r.text.includes('Contents of notes.txt:'));
  assert.ok(r.text.includes('HELLO NOTES'));
});

test('expand: invalid command file names are skipped', () => {
  const dir = path.join(ctx.studioDir, 'commands');
  fs.writeFileSync(path.join(dir, 'bad name.md'), 'nope', 'utf8');
  assert.ok(!commands.loadCommands()['bad name']);
});
