'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');

const ctx = setup();
const cfg = ctx.cfg;
const os = require('node:os');

test('projectKey: stable, sanitised, unique per directory', () => {
  const a = cfg.projectKey('/tmp/My Project!');
  const b = cfg.projectKey('/tmp/My Project!');
  const c = cfg.projectKey('/tmp/other');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^My-Project-[0-9a-f]{8}$/);
  assert.match(cfg.projectKey('/'), /^project-[0-9a-f]{8}$/);
});

test('setWorkDir / getWorkDir: rejects non-directories, stores the realpath', () => {
  const file = path.join(ctx.dir, 'a-file.txt');
  fs.writeFileSync(file, 'x');
  assert.throws(() => cfg.setWorkDir(file), /not a directory/);
  assert.throws(() => cfg.setWorkDir(path.join(ctx.dir, 'missing')), /not a directory/);
  const before = cfg.getWorkDir();
  const back = cfg.setWorkDir(ctx.dir);
  assert.equal(back, before);
  assert.equal(cfg.getWorkDir(), fs.realpathSync(ctx.dir));
  assert.ok(fs.existsSync(path.join(ctx.studioDir, 'project.json')));
});

test('setWorkDir: launching from the app root falls back to ./workspace', () => {
  const real = cfg.setWorkDir(cfg.APP_ROOT);
  assert.equal(real, fs.realpathSync(path.join(cfg.APP_ROOT, 'workspace')));
  assert.notEqual(real, cfg.APP_ROOT);
  cfg.setWorkDir(ctx.dir); // restore for the rest of the file
});

test('loadConfig: defaults, global and local layers', () => {
  assert.equal(cfg.VIRTUAL_PREFIX, '.studio');
  const defaults = cfg.loadConfig();
  assert.equal(typeof defaults.endpoint, 'string');
  assert.ok(defaults.endpoint.length > 0);
  assert.equal(defaults.autoCtxMax, 131072);
  assert.equal(defaults.maxIterations, 200);
  assert.equal(defaults.permission.edit, 'allow');
  assert.deepEqual(defaults.providers, {});
  assert.deepEqual(defaults.mcp, {});
  assert.ok(typeof defaults.systemPrompt === 'string' && defaults.systemPrompt.length > 0);

  // per-project config wins over the global one
  const local = { model: 'local-model', temperature: 0.9, permission: { bash: { 'npm test*': 'allow' } }, providers: { lp: { type: 'openai', endpoint: 'https://lp.example/v1' } } };
  fs.writeFileSync(path.join(ctx.studioDir, 'config.json'), JSON.stringify(local), 'utf8');
  const merged = cfg.loadConfig();
  assert.equal(merged.model, 'local-model');
  assert.equal(merged.temperature, 0.9);
  assert.deepEqual(merged.permission.bash, { 'npm test*': 'allow' });
  assert.equal(merged.permission.edit, 'allow');        // untouched keys keep their defaults
  assert.ok(merged.providers.lp);

  // without a local file the global config.json applies
  fs.rmSync(path.join(ctx.studioDir, 'config.json'));
  const global = JSON.parse(fs.readFileSync(cfg.CONFIG_PATH, 'utf8'));
  const after = cfg.loadConfig();
  assert.equal(after.model, global.model !== undefined ? global.model : cfg.DEFAULT_CONFIG.model);
  assert.deepEqual(after.providers, {});
});
