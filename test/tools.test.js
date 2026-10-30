'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const os = require("node:os");

const ctx = setup();
const tools = require('../lib/tools');
const P = require('../lib/permission');
const agents = require('../lib/agents');

const names = (defs) => defs.map((d) => d.function.name);

test('toolDefsFor: the build agent sees the core toolset', () => {
  const defs = names(tools.toolDefsFor(agents.getAgent('build'), ctx.cfg.loadConfig(), { isChild: false }));
  for (const t of ['list_files', 'glob', 'grep', 'read_file', 'write_file', 'edit_file', 'delete_file', 'bash', 'todo_write', 'task', 'webfetch', 'websearch', 'question']) {
    assert.ok(defs.includes(t), `build should see ${t}`);
  }
});

test('toolDefsFor: denied tools are hidden from the model', () => {
  const custom = { name: 'locked', permission: { edit: 'deny', bash: 'deny', webfetch: 'deny', websearch: 'deny' } };
  const defs = names(tools.toolDefsFor(custom, ctx.cfg.loadConfig(), { isChild: false }));
  for (const t of ['write_file', 'edit_file', 'delete_file', 'bash', 'webfetch', 'websearch']) {
    assert.ok(!defs.includes(t), `locked should not see ${t}`);
  }
  assert.ok(defs.includes('read_file'));
});

test('toolDefsFor: subagents lose primary-only / self-delegation tools', () => {
  const defs = names(tools.toolDefsFor(agents.getAgent('explore'), ctx.cfg.loadConfig(), { isChild: true }));
  assert.ok(!defs.includes('question'));
  assert.ok(!defs.includes('task'));
  assert.ok(!defs.includes('plan_exit'));
  assert.ok(!defs.includes('write_file'));  // explore denies edits
  assert.ok(defs.includes('read_file'));
});

test('plan_exit is only offered to the plan agent', () => {
  const build = names(tools.toolDefsFor(agents.getAgent('build'), ctx.cfg.loadConfig(), { isChild: false }));
  const plan = names(tools.toolDefsFor(agents.getAgent('plan'), ctx.cfg.loadConfig(), { isChild: false }));
  assert.ok(!build.includes('plan_exit'));
  assert.ok(plan.includes('plan_exit'));
});

test('plan agent permissions: read-only except the plans folder', () => {
  const plan = agents.getAgent('plan');
  const into = (permission, pattern, config = ctx.cfg.loadConfig()) =>
    P.decide(permission, pattern, { agent: plan, config, session: { grants: {} }, inherited: [] });

  assert.equal(into('edit', 'src/index.js'), 'deny');
  assert.equal(into('edit', '.studio/plans/design.md'), 'allow');
  assert.equal(into('bash', 'ls -la'), 'allow');
  assert.equal(into('bash', 'git status'), 'allow');
  assert.equal(into('bash', 'rm -rf build'), 'deny');
  assert.equal(into('bash', 'npm install'), 'deny');
  assert.equal(into('task', 'general'), 'deny');
});

test('every tool definition is well-formed', () => {
  for (const [name, d] of Object.entries(tools.TOOLS)) {
    assert.equal(d.type, 'function');
    assert.equal(d.function.name, name);
    assert.equal(d.function.parameters.type, 'object');
    assert.ok(typeof d.function.description === 'string' && d.function.description.length > 0);
    for (const req of d.function.parameters.required || []) {
      assert.ok(d.function.parameters.properties[req], `${name}: required "${req}" missing from properties`);
    }
  }
});

test('move_file: rename/move with journal and overwrite guard', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const journal = require('../lib/journal');
  const tools = require('../lib/tools');
  const cfg = ctx.cfg;
  const wd = cfg.getWorkDir();
  fs.writeFileSync(path.join(wd, 'a.txt'), 'hello');
  const session = { id: 's1', messages: [{ role: 'user', content: 'x', turn: 1 }], journal: [], turn: 1 };
  const root = session;
  await tools.executeTool('move_file', { from: 'a.txt', to: 'sub/b.txt' }, { agent: { name: 'build' }, config: cfg.loadConfig(), session, root, inherited: [], emit: () => {}, askPermission: async () => 'once', askUser: async () => '' });
  assert.equal(fs.existsSync(path.join(wd, 'a.txt')), false);
  assert.equal(fs.readFileSync(path.join(wd, 'sub/b.txt'), 'utf8'), 'hello');
  fs.writeFileSync(path.join(wd, 'sub/c.txt'), 'x');
  await assert.rejects(() => tools.executeTool('move_file', { from: 'sub/b.txt', to: 'sub/c.txt' }, { agent: { name: 'build' }, config: cfg.loadConfig(), session: { id: 's2', messages: [], journal: [], turn: 0 }, root: { journal: [], turn: 0 }, inherited: [], emit: () => {}, askPermission: async () => 'once', askUser: async () => '' }), /overwrite/);
});

test('read_file paths array and one failure does not hide others', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tools = require('../lib/tools');
  const cfg = ctx.cfg;
  const wd = cfg.getWorkDir();
  fs.writeFileSync(path.join(wd, 'x.txt'), 'hi');
  const res = await tools.executeTool('read_file', { paths: ['x.txt', 'missing.txt'] }, { agent: { name: 'build' }, config: cfg.loadConfig(), session: { id: 's1', messages: [], journal: [], turn: 0 }, root: { journal: [], turn: 0 }, inherited: [], emit: () => {}, askPermission: async () => 'once', askUser: async () => '' });
  assert.ok(Array.isArray(res.files));
  assert.equal(res.files[0].path, 'x.txt');
  assert.ok(res.files[1].error);
});

test('multi_edit all-or-nothing and journaled', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tools = require('../lib/tools');
  const cfg = ctx.cfg;
  const wd = cfg.getWorkDir();
  fs.writeFileSync(path.join(wd, 'm.txt'), 'a\nb\nc\n');
  const session = { id: 's1', messages: [{ role: 'user', content: 'x', turn: 1 }], journal: [], turn: 1 };
  await tools.executeTool('multi_edit', { path: 'm.txt', edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'c', new_string: 'C' }] }, { agent: { name: 'build' }, config: cfg.loadConfig(), session, root: session, inherited: [], emit: () => {}, askPermission: async () => 'once', askUser: async () => '' });
  assert.equal(fs.readFileSync(path.join(wd, 'm.txt'), 'utf8'), 'A\nb\nC\n');
  const journal = require('../lib/journal');
  const r = await journal.undo(session);
  assert.equal(fs.readFileSync(path.join(wd, 'm.txt'), 'utf8'), 'a\nb\nc\n');
  await journal.redo(session);
  assert.equal(fs.readFileSync(path.join(wd, 'm.txt'), 'utf8'), 'A\nb\nC\n');
});

test('multi_edit fails mid-sequence and file unchanged', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tools = require('../lib/tools');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-m2-' + Date.now()));
  const prev = process.env.OLLAMA_STUDIO_HOME;
  process.env.OLLAMA_STUDIO_HOME = tmp;
  const cfg = require('../lib/config');
  cfg._cache = null;
  try {
    const wd = cfg.getWorkDir();
    fs.writeFileSync(path.join(wd, 'm2.txt'), 'x\ny\n');
    await assert.rejects(() => tools.executeTool('multi_edit', { path: 'm2.txt', edits: [{ old_string: 'x', new_string: 'X' }, { old_string: 'MISSING', new_string: 'z' }] }, { agent: { name: 'build' }, config: cfg.loadConfig(), session: { id: 's1', messages: [], journal: [], turn: 0 }, root: { journal: [], turn: 0 }, inherited: [], emit: () => {}, askPermission: async () => 'once', askUser: async () => '' }), /multi_edit failed/);
    assert.equal(fs.readFileSync(path.join(wd, 'm2.txt'), 'utf8'), 'x\ny\n');
  } finally {
    process.env.OLLAMA_STUDIO_HOME = prev;
    cfg._cache = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('edit_file dry_run does not change file and reports match', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tools = require('../lib/tools');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-d-' + Date.now()));
  const prev = process.env.OLLAMA_STUDIO_HOME;
  process.env.OLLAMA_STUDIO_HOME = tmp;
  const cfg = require('../lib/config');
  cfg._cache = null;
  try {
    const wd = cfg.getWorkDir();
    fs.writeFileSync(path.join(wd, 'd.txt'), 'hello world\n');
    const res = await tools.executeTool('edit_file', { path: 'd.txt', old_string: 'world', new_string: 'there', dry_run: true }, { agent: { name: 'build' }, config: cfg.loadConfig(), session: { id: 's1', messages: [], journal: [], turn: 0 }, root: { journal: [], turn: 0 }, inherited: [], emit: () => {}, askPermission: async () => 'once', askUser: async () => '' });
    assert.equal(res.dry_run, true);
    assert.equal(fs.readFileSync(path.join(wd, 'd.txt'), 'utf8'), 'hello world\n');
  } finally {
    process.env.OLLAMA_STUDIO_HOME = prev;
    cfg._cache = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('json_edit get/set/delete with indentation and arrays', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const tools = require('../lib/tools');
  const cfg = ctx.cfg;
  const wd = cfg.getWorkDir();
  fs.writeFileSync(path.join(wd, 'c.json'), '{\n  "a": 1,\n  "arr": [0]\n}\n');
  const g = await tools.executeTool('json_edit', { path: 'c.json', op: 'get', key: 'a' }, { agent: { name: 'build' }, config: cfg.loadConfig(), session: { id: 's1', messages: [], journal: [], turn: 0 }, root: { journal: [], turn: 0 }, inherited: [], emit: () => {}, askPermission: async () => 'once', askUser: async () => '' });
  assert.equal(g.value, 1);
  await tools.executeTool('json_edit', { path: 'c.json', op: 'set', key: 'providers.0.apiKeyEnv', value: '"X"' }, { agent: { name: 'build' }, config: cfg.loadConfig(), session: { id: 's1', messages: [], journal: [], turn: 1 }, root: { journal: [], turn: 1 }, inherited: [], emit: () => {}, askPermission: async () => 'once', askUser: async () => '' });
  const j = JSON.parse(fs.readFileSync(path.join(wd, 'c.json'), 'utf8'));
  assert.equal(j.providers[0].apiKeyEnv, 'X');
  await tools.executeTool('json_edit', { path: 'c.json', op: 'delete', key: 'arr' }, { agent: { name: 'build' }, config: cfg.loadConfig(), session: { id: 's1', messages: [], journal: [], turn: 1 }, root: { journal: [], turn: 1 }, inherited: [], emit: () => {}, askPermission: async () => 'once', askUser: async () => '' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(wd, 'c.json'), 'utf8')).arr, undefined);
  await assert.rejects(() => tools.executeTool('json_edit', { path: 'c.json', op: 'get', key: 'missing' }, { agent: { name: 'build' }, config: cfg.loadConfig(), session: { id: 's1', messages: [], journal: [], turn: 0 }, root: { journal: [], turn: 0 }, inherited: [], emit: () => {}, askPermission: async () => 'once', askUser: async () => '' }), /does not exist/);
});

