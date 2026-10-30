'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const tools = require('../lib/tools');

function cleanUp() {
  const wd = '/home/boffin/Desktop/ollama-forge-studio';
  if (fs.existsSync(path.join(wd, 'subdir'))) { fs.rmSync(path.join(wd, 'subdir'), { recursive: true, force: true }); }
  if (fs.existsSync(path.join(wd, 'a.txt'))) { fs.unlinkSync(path.join(wd, 'a.txt')); }
  if (fs.existsSync(path.join(wd, 'b.txt'))) { fs.unlinkSync(path.join(wd, 'b.txt')); }
  if (fs.existsSync(path.join(wd, 'c.txt'))) { fs.unlinkSync(path.join(wd, 'c.txt')); }
}

function makeCtx(root, cfg) {
  return { agent: { name: 'build' }, config: cfg.loadConfig(), session: { id: 's', messages: [{ role: 'user', content: 'x', turn: 1 }], journal: [], turn: 1 }, root: { journal: [], turn: 1 }, inherited: [], emit: () => {}, askPermission: async () => 'once', askUser: async () => '' };
}

test('smoke move_file: rename with parent mkdir', async () => {
  cleanUp();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-mv-'));
  const prev = process.env.OLLAMA_STUDIO_HOME;
  process.env.OLLAMA_STUDIO_HOME = tmp;
  const cfg = require('../lib/config');
  cfg._cache = null;
  try {
    const wd = cfg.getWorkDir();
    fs.writeFileSync(path.join(wd, 'a.txt'), 'hi');
    const ctx = makeCtx({}, cfg);
    await tools.executeTool('move_file', { from: 'a.txt', to: 'subdir/b.txt' }, ctx);
    assert.equal(fs.existsSync(path.join(wd, 'a.txt')), false);
    assert.equal(fs.readFileSync(path.join(wd, 'subdir/b.txt'), 'utf8'), 'hi');
  } finally {
    process.env.OLLAMA_STUDIO_HOME = prev;
    cfg._cache = null;
    cleanUp();
  }
});

test('smoke move_file: overwrite guard then overwrite ok', async () => {
  cleanUp();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-mv2-'));
  const prev = process.env.OLLAMA_STUDIO_HOME;
  process.env.OLLAMA_STUDIO_HOME = tmp;
  const cfg = require('../lib/config');
  cfg._cache = null;
  try {
    const wd = cfg.getWorkDir();
    fs.writeFileSync(path.join(wd, 'a.txt'), 'hi');
    fs.writeFileSync(path.join(wd, 'b.txt'), 'x');
    const ctx = makeCtx({}, cfg);
    await assert.rejects(() => tools.executeTool('move_file', { from: 'a.txt', to: 'b.txt' }, ctx));
    await tools.executeTool('move_file', { from: 'a.txt', to: 'b.txt', overwrite: true }, ctx);
    assert.equal(fs.readFileSync(path.join(wd, 'b.txt'), 'utf8'), 'hi');
  } finally {
    process.env.OLLAMA_STUDIO_HOME = prev;
    cfg._cache = null;
    cleanUp();
  }
});

test('smoke move_file: refuses traversal', async () => {
  cleanUp();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-mv3-'));
  const prev = process.env.OLLAMA_STUDIO_HOME;
  process.env.OLLAMA_STUDIO_HOME = tmp;
  const cfg = require('../lib/config');
  cfg._cache = null;
  try {
    const wd = cfg.getWorkDir();
    fs.writeFileSync(path.join(wd, 'd.txt'), 'v');
    const ctx = makeCtx({}, cfg);
    await assert.rejects(() => tools.executeTool('move_file', { from: 'd.txt', to: '../outside.txt' }, ctx));
  } finally {
    process.env.OLLAMA_STUDIO_HOME = prev;
    cfg._cache = null;
    cleanUp();
  }
});

test('smoke multi_edit: all-or-nothing execution', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-me-'));
  const prev = process.env.OLLAMA_STUDIO_HOME;
  process.env.OLLAMA_STUDIO_HOME = tmp;
  const cfg = require('../lib/config');
  cfg._cache = null;
  try {
    const wd = cfg.getWorkDir();
    const p = path.join(wd, 'e.txt');
    fs.writeFileSync(p, 'hello world\nfoo bar\n');
    const ctx = makeCtx({}, cfg);
    const r = await tools.executeTool('multi_edit', { path: 'e.txt', edits: [{ old_string: 'hello', new_string: 'hi' }, { old_string: 'foo', new_string: 'baz' }] }, ctx);
    assert.ok(r.ok);
    assert.equal(fs.readFileSync(p, 'utf8'), 'hi world\nbaz bar\n');
  } finally {
    process.env.OLLAMA_STUDIO_HOME = prev;
    cfg._cache = null;
  }
});

test('smoke multi_edit: fail mid-sequence leaves file unchanged', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-me2-'));
  const prev = process.env.OLLAMA_STUDIO_HOME;
  process.env.OLLAMA_STUDIO_HOME = tmp;
  const cfg = require('../lib/config');
  cfg._cache = null;
  try {
    const wd = cfg.getWorkDir();
    const p = path.join(wd, 'f.txt');
    const orig = 'a\nb\nc\n';
    fs.writeFileSync(p, orig);
    const ctx = makeCtx({}, cfg);
    await assert.rejects(() => tools.executeTool('multi_edit', { path: 'f.txt', edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'ZZZ', new_string: 'Z' }] }, ctx), /edit 1|not found|fuzzy/i);
    assert.equal(fs.readFileSync(p, 'utf8'), orig);
  } finally {
    process.env.OLLAMA_STUDIO_HOME = prev;
    cfg._cache = null;
  }
});

test('smoke json_edit: nested get/set/delete', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofs-je-'));
  const prev = process.env.OLLAMA_STUDIO_HOME;
  process.env.OLLAMA_STUDIO_HOME = tmp;
  const cfg = require('../lib/config');
  cfg._cache = null;
  try {
    const wd = cfg.getWorkDir();
    const p = path.join(wd, 'g.json');
    fs.writeFileSync(p, '{\n  "providers": [\n    {\n      "name": "ollama"\n    }\n  ],\n  "mcp": {\n    "github": {\n      "command": "npx"\n    }\n  }\n}\n');
    const ctx = makeCtx({}, cfg);
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
  } finally {
    process.env.OLLAMA_STUDIO_HOME = prev;
    cfg._cache = null;
  }
});
