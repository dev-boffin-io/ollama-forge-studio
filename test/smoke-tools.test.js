'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const tools = require('../lib/tools');
const cfg = require('../lib/config');

function withTempDir(testFn) {
  return test(testFn.name, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-tmp-' + Date.now()));
    let prevWorkDir;
    try {
      prevWorkDir = cfg.getWorkDir();
      cfg.setWorkDir(tmp);
      await testFn.call(this, { tmp, cfg, getWorkDir: () => cfg.getWorkDir() });
    } finally {
      cfg.setWorkDir(prevWorkDir);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

test('smoke move_file: rename with parent mkdir', withTempDir(async (context) => {
  const wd = context.getWorkDir();
  fs.writeFileSync(path.join(wd, 'a.txt'), 'hi');
  const ctx = { agent: { name: 'build' }, config: context.cfg.loadConfig(), session: { id: 's', messages: [{ role: 'user', content: 'x', turn: 1 }], journal: [], turn: 1 }, root: { journal: [], turn: 1 }, inherited: [], emit: () => {}, askPermission: async () => 'once', askUser: async () => '' };
  await tools.executeTool('move_file', { from: 'a.txt', to: 'subdir/b.txt' }, ctx);
  assert.equal(fs.existsSync(path.join(wd, 'a.txt')), false);
  assert.equal(fs.readFileSync(path.join(wd, 'subdir/b.txt'), 'utf8'), 'hi');
}));

test('smoke move_file: overwrite guard then overwrite ok', withTempDir(async (context) => {
  const wd = context.getWorkDir();
  fs.writeFileSync(path.join(wd, 'a.txt'), 'hi');
  fs.writeFileSync(path.join(wd, 'b.txt'), 'x');
  const ctx = { agent: { name: 'build' }, config: context.cfg.loadConfig(), session: { id: 's', messages: [{ role: 'user', content: 'x', turn: 1 }], journal: [], turn: 1 }, root: { journal: [], turn: 1 }, inherited: [], emit: () => {}, askPermission: async () => 'once', askUser: async () => '' };
  await assert.rejects(() => tools.executeTool('move_file', { from: 'a.txt', to: 'b.txt' }, ctx));
  await tools.executeTool('move_file', { from: 'a.txt', to: 'b.txt', overwrite: true }, ctx);
  assert.equal(fs.readFileSync(path.join(wd, 'b.txt'), 'utf8'), 'hi');
}));

test('smoke move_file: refuses traversal', withTempDir(async (context) => {
  const wd = context.getWorkDir();
  fs.writeFileSync(path.join(wd, 'd.txt'), 'v');
  const ctx = { agent: { name: 'build' }, config: context.cfg.loadConfig(), session: { id: 's', messages: [{ role: 'user', content: 'x', turn: 1 }], journal: [], turn: 1 }, root: { journal: [], turn: 1 }, inherited: [], emit: () => {}, askPermission: async () => 'once', askUser: async () => '' };
  await assert.rejects(() => tools.executeTool('move_file', { from: 'd.txt', to: '../outside.txt' }, ctx));
}));

test('smoke multi_edit: all-or-nothing execution', withTempDir(async (context) => {
  const wd = context.getWorkDir();
  const p = path.join(wd, 'e.txt');
  fs.writeFileSync(p, 'hello world\nfoo bar\n');
  const ctx = { agent: { name: 'build' }, config: context.cfg.loadConfig(), session: { id: 's', messages: [{ role: 'user', content: 'x', turn: 1 }], journal: [], turn: 1 }, root: { journal: [], turn: 1 }, inherited: [], emit: () => {}, askPermission: async () => 'once', askUser: async () => '' };
  const r = await tools.executeTool('multi_edit', { path: 'e.txt', edits: [{ old_string: 'hello', new_string: 'hi' }, { old_string: 'foo', new_string: 'baz' }] }, ctx);
  assert.ok(r.ok);
  assert.equal(fs.readFileSync(p, 'utf8'), 'hi world\nbaz bar\n');
}));

test('smoke multi_edit: fail mid-sequence leaves file unchanged', withTempDir(async (context) => {
  const wd = context.getWorkDir();
  const p = path.join(wd, 'f.txt');
  const orig = 'a\nb\nc\n';
  fs.writeFileSync(p, orig);
  const ctx = { agent: { name: 'build' }, config: context.cfg.loadConfig(), session: { id: 's', messages: [{ role: 'user', content: 'x', turn: 1 }], journal: [], turn: 1 }, root: { journal: [], turn: 1 }, inherited: [], emit: () => {}, askPermission: async () => 'once', askUser: async () => '' };
  await assert.rejects(() => tools.executeTool('multi_edit', { path: 'f.txt', edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'ZZZ', new_string: 'Z' }] }, ctx), /edit 1|not found|fuzzy/i);
  assert.equal(fs.readFileSync(p, 'utf8'), orig);
}));

test('smoke json_edit: nested get/set/delete', withTempDir(async (context) => {
  const wd = context.getWorkDir();
  const p = path.join(wd, 'g.json');
  fs.writeFileSync(p, '{\n  "providers": [\n    {\n      "name": "ollama"\n    }\n  ],\n  "mcp": {\n    "github": {\n      "command": "npx"\n    }\n  }\n}\n');
  const ctx = { agent: { name: 'build' }, config: context.cfg.loadConfig(), session: { id: 's', messages: [{ role: 'user', content: 'x', turn: 1 }], journal: [], turn: 1 }, root: { journal: [], turn: 1 }, inherited: [], emit: () => {}, askPermission: async () => 'once', askUser: async () => '' };
  const r1 = await tools.executeTool('json_edit', { path: 'g.json', op: 'get', key: 'providers.0.name' }, ctx);
  assert.equal(r1.value, 'ollama');
  await tools.executeTool('json_edit', { path: 'g.json', op: 'set', key: 'providers.0.apiKeyEnv', value: '"KEY"' }, ctx);
  await tools.executeTool('json_edit', { path: 'g.json', op: 'set', key: 'mcp["github"].command', value: '"uvx"' }, ctx);
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(j.providers[0].apiKeyEnv, 'KEY');
  assert.equal(j.mcp.github.command, 'uvx');
  await tools.executeTool('json_edit', { path: 'g.json', op: 'delete', key: 'providers' }, ctx);
  const j2 = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(j2.providers, undefined);
  await assert.rejects(() => tools.executeTool('json_edit', { path: 'g.json', op: 'get', key: 'missing.deep' }, ctx));
  const before = fs.readFileSync(p, 'utf8');
  await assert.rejects(() => tools.executeTool('json_edit', { path: 'g.json', op: 'set', key: 'x.y.z', value: '{bad' }, ctx));
  assert.equal(fs.readFileSync(p, 'utf8'), before);
}));
