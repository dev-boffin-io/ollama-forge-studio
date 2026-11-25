'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const LG = require('../lib/loopguard');

const tool = (name, payload, id) => ({ role: 'tool', tool_name: name, tool_call_id: id || name, content: JSON.stringify(payload) });
const call = (id, name, args) => [id, { id, function: { name, arguments: args } }];

test('thinking watchdog: trips on length and on repetition, not on normal reasoning', () => {
  const w = LG.createThinkWatch({ maxChars: 500 });
  assert.equal(w.feed('Let me check the status first. '), null);
  assert.equal(w.feed('x'.repeat(600)), 'too-long');
  const r = LG.createThinkWatch({ maxChars: 100000 });
  let hit = null;
  for (let i = 0; i < 20 && !hit; i++) hit = r.feed('I should list the files, then read the README, then check again. ');
  assert.equal(hit, 'repeating');
  const ok = LG.createThinkWatch({ maxChars: 100000 });
  let any = null;
  for (let i = 0; i < 40; i++) any = any || ok.feed(`step ${i}: a different thought about file number ${i * 7919} and its purpose. `);
  assert.equal(any, null);
});

test('denial tracker: blocks only the denied kind of call, not the whole tool; stops after 6 in a row; success resets', () => {
  const t = LG.createDenialTracker();
  const denied = { error: 'bash: "rm -rf x" is not allowed for the "plan" agent (permission rule).' };
  assert.equal(t.note('bash', denied, { command: 'rm -rf a' }).newlyBlocked, false);
  const r = t.note('bash', denied, { command: 'rm -rf b' });
  assert.equal(r.newlyBlocked, true);
  assert.match(r.message, /Other uses of "bash" still work/);
  assert.equal(t.isBlocked('bash', { command: 'rm -rf anything' }), true);
  assert.equal(t.isBlocked('bash', { command: 'ls -la' }), false, 'ls is not affected by a denied rm');
  assert.equal(t.isBlocked('bash', { command: 'git status' }), false);
  t.note('read_file', { content: 'ok' }, { path: 'a' });
  assert.equal(t.streak, 0);
  let stop = false;
  for (let i = 0; i < 6; i++) stop = t.note('tool' + i, { error: 'permission rejected by the user.' }, {}).stop;
  assert.equal(stop, true);
  assert.match(t.summary(), /bash:rm/);
  assert.equal(LG.isDenial({ error: 'File not found: a.md' }), false);
  assert.equal(LG.denialKey('bash', { command: 'FOO=1 npm test' }), 'bash:npm');
});

test('denial tracker: a new permission grant lifts all blocks and restarts the count', () => {
  const t = LG.createDenialTracker({ version: 'v1' });
  const denied = { error: 'permission rejected by the user. Do NOT retry this command.' };
  t.note('bash', denied, { command: 'npm test' });
  t.note('bash', denied, { command: 'npm run x' });
  assert.equal(t.isBlocked('bash', { command: 'npm i' }), true);
  assert.equal(t.sync('v1'), false, 'same grants: nothing changes');
  assert.equal(t.isBlocked('bash', { command: 'npm i' }), true);
  assert.equal(t.sync('v2'), true, 'user granted something');
  assert.equal(t.isBlocked('bash', { command: 'npm i' }), false);
  assert.equal(t.streak, 0);
  assert.equal(t.note('bash', denied, { command: 'npm test' }).newlyBlocked, false, 'counting starts from zero');
});

test('grounding: the screenshot case - commit question, git_status + scoped list + 1 read, failed README read -> no nag', () => {
  const calls = new Map([call('1', 'git_status', {}), call('2', 'list_files', { path: 'examples/plugins/git/' }), call('3', 'read_file', { path: 'examples/plugins/git/plugin.js' }), call('4', 'read_file', { path: 'examples/plugins/git/README.md' })]);
  const toolMsgs = [tool('git_status', { output: '?? examples/plugins/git/' }, '1'), tool('list_files', { files: ['examples/plugins/git/plugin.js'] }, '2'), tool('read_file', { path: 'x', content: '1: a' }, '3'), tool('read_file', { error: 'File not found' }, '4')];
  const plan = LG.groundingPlan({ prompt: 'কি কমিট করব?', toolMsgs, calls, looksLikeQuestion: false });
  assert.equal(plan.kind, '');
});

test('grounding: a code question with a bare listing still needs reads, and failed paths are named', () => {
  const calls = new Map([call('1', 'list_files', {}), call('2', 'read_file', { path: 'README.md' })]);
  const toolMsgs = [tool('list_files', { files: ['a.js', 'b.js', 'c.js'] }, '1'), tool('read_file', { error: 'File not found: README.md' }, '2')];
  const plan = LG.groundingPlan({ prompt: 'explain the architecture of this project', toolMsgs, calls, looksLikeQuestion: true, minReads: 2 });
  assert.equal(plan.kind, 'read');
  assert.equal(plan.reads, 0);
  assert.match(plan.content, /README\.md/);
});

test('grounding: a 1-file folder needs just 1 read; satisfied once read', () => {
  const calls = new Map([call('1', 'list_files', { path: 'examples/plugins/git' }), call('2', 'read_file', { path: 'examples/plugins/git/plugin.js' })]);
  const toolMsgs = [tool('list_files', { files: ['examples/plugins/git/plugin.js'] }, '1'), tool('read_file', { path: 'examples/plugins/git/plugin.js', content: '1: x' }, '2')];
  const plan = LG.groundingPlan({ prompt: 'what does this plugin do and why', toolMsgs, calls, looksLikeQuestion: true, cited: ['examples/plugins/git/plugin.js'], readPaths: new Set(['examples/plugins/git/plugin.js']) });
  assert.equal(plan.kind, '');
});
