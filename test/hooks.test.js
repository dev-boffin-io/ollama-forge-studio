'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');

const ctx = setup();
const hooks = require('../lib/hooks');
const tools = require('../lib/tools');

const ctxFor = (config = {}, session = { id: 'ses_hooks' }) => ({
  config, session, agent: { name: 'build' }, root: session, inherited: [], emit: () => {},
  askPermission: async () => 'once', askUser: async () => '',
});

const jsonHook = (source) => [process.execPath, '-e', source];

test('pre_edit command hook can block and returns parsed JSON', async () => {
  hooks.reset();
  const command = jsonHook('let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write(JSON.stringify({allow:p.path!=="blocked.txt",message:"blocked by test"}));});');
  const c = ctxFor({ hooks: { pre_edit: [{ command }] } });
  const ok = await hooks.preEdit(c, { path: 'ok.txt' });
  assert.equal(ok[0].allow, true);
  await assert.rejects(() => hooks.preEdit(c, { path: 'blocked.txt' }), /blocked by test/);
  hooks.reset();
});

test('pre_edit backup hook copies the old file into the studio data dir', async () => {
  hooks.reset();
  const wd = ctx.cfg.getWorkDir();
  fs.writeFileSync(path.join(wd, 'backup-me.txt'), 'old content\n');
  const c = ctxFor({ hooks: { pre_edit: [{ backup: true }] } });
  const res = await hooks.preEdit(c, { path: 'backup-me.txt', absolutePath: path.join(wd, 'backup-me.txt') });
  assert.equal(res[0].backedUp, true);
  assert.equal(fs.readFileSync(res[0].path, 'utf8'), 'old content\n');
  hooks.reset();
});

test('JS hooks can observe and block events', async () => {
  hooks.reset();
  const seen = [];
  const off = hooks.on('on_file_change', (payload) => { seen.push(payload.path); });
  await hooks.run('on_file_change', { path: 'seen.txt' }, ctxFor({}));
  assert.deepEqual(seen, ['seen.txt']);
  off();

  hooks.on('on_tool_call', () => ({ allow: false, message: 'no tools today' }), { source: 'test' });
  await assert.rejects(() => hooks.run('on_tool_call', { tool: 'bash' }, { ...ctxFor({}), blocking: true }), /no tools today/);
  hooks.reset();
});

test('an explicitly observe-only hook is not forced to block', async () => {
  hooks.reset();
  hooks.on('on_tool_call', () => ({ allow: false, message: 'observe only' }), { source: 'test', blocking: false });
  const res = await hooks.run('on_tool_call', { tool: 'bash' }, { ...ctxFor({}), blocking: true });
  assert.equal(res[0].allow, false);
  hooks.reset();
});

test('executeTool runs on_tool_call before the tool and on_file_change after a write', async () => {
  hooks.reset();
  const seen = [];
  hooks.on('on_tool_call', (payload) => { seen.push('call:' + payload.tool); });
  hooks.on('on_file_change', (payload) => { seen.push('change:' + payload.path); });
  const session = { id: 'ses_hooks_tool', messages: [], journal: [], turn: 1, grants: {} };
  await tools.executeTool('write_file', { path: 'hooked.txt', content: 'hello' }, ctxFor(ctx.cfg.loadConfig(), session));
  assert.deepEqual(seen, ['call:write_file', 'change:hooked.txt']);
  assert.equal(fs.readFileSync(path.join(ctx.cfg.getWorkDir(), 'hooked.txt'), 'utf8'), 'hello');
  hooks.reset();
});

test('a blocking on_tool_call hook prevents the tool from running', async () => {
  hooks.reset();
  hooks.on('on_tool_call', (payload) => ({ allow: payload.tool !== 'write_file', message: 'blocked write' }), { source: 'test' });
  const session = { id: 'ses_hooks_block', messages: [], journal: [], turn: 1, grants: {} };
  await assert.rejects(() => tools.executeTool('write_file', { path: 'never.txt', content: 'x' }, ctxFor(ctx.cfg.loadConfig(), session)), /blocked write/);
  assert.equal(fs.existsSync(path.join(ctx.cfg.getWorkDir(), 'never.txt')), false);
  hooks.reset();
});

test('a hook command that exits without reading stdin does not crash the studio', async () => {
  hooks.reset();
  const c = ctxFor({ hooks: { pre_edit: [{ command: [process.execPath, '-e', 'process.exit(0)'] }] } });
  await hooks.preEdit(c, { path: 'ignored.txt' });
  hooks.reset();
});
