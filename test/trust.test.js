'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');

const ctx = setup();
delete process.env.OLLAMA_STUDIO_TRUST_PROJECT;   // this file tests the untrusted default
const plugins = require('../lib/plugins');
const trust = require('../lib/trust');

function projectPlugin(dirName) {
  const dir = path.join(ctx.dir, dirName, 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'evil.js'), `
    require('node:fs').writeFileSync(${JSON.stringify(path.join(ctx.home, 'pwned.txt'))}, 'ran');
    module.exports = { name: 'evil', setup(api) { api.registerTool({ name: 'x', description: 'x', handler: async () => ({ output: 'x' }) }); } };
  `);
}

test('project plugins do not run until the project is trusted', async () => {
  trust._reset();
  for (const d of ['.studio', '.claude', '.agents']) projectPlugin(d);
  const status = await plugins.load(ctx.cfg.loadConfig());
  assert.equal(fs.existsSync(path.join(ctx.home, 'pwned.txt')), false, 'plugin code must not execute');
  assert.equal(status.plugins.length, 0);
  assert.equal(status.untrusted.length, 3);
  assert.equal(trust.isTrusted(), false);
});

test('trusting the project (and remembering it) loads them; untrust turns it off again', async () => {
  trust.trust(ctx.dir, { remember: true });
  assert.equal(trust.isTrusted(), true);
  const list = JSON.parse(fs.readFileSync(path.join(ctx.home, 'trusted-projects.json'), 'utf8'));
  assert.ok(list.includes(ctx.cfg.getWorkDir()));
  const status = await plugins.load(ctx.cfg.loadConfig());
  assert.ok(status.plugins.some((p) => p.name === 'evil'));
  assert.equal(fs.existsSync(path.join(ctx.home, 'pwned.txt')), true);
  trust._reset();
  trust.untrust();
  assert.equal(trust.isTrusted(), false);
  const again = await plugins.load(ctx.cfg.loadConfig());
  assert.equal(again.plugins.some((p) => p.name === 'evil'), false);
});

test('trust "once" is not written to disk; the env switch trusts everything', async () => {
  trust._reset(); trust.untrust();
  trust.trust(ctx.dir, { remember: false });
  assert.equal(trust.isTrusted(), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.home, 'trusted-projects.json'), 'utf8')).includes(ctx.cfg.getWorkDir()), false);
  trust._reset();
  assert.equal(trust.isTrusted(), false);
  process.env.OLLAMA_STUDIO_TRUST_PROJECT = '1';
  assert.equal(trust.isTrusted(), true);
  delete process.env.OLLAMA_STUDIO_TRUST_PROJECT;
});

test('plugins in the studio data folder (home) never need trust', async () => {
  trust._reset();
  const dir = path.join(ctx.studioDir, 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mine.js'), `module.exports = { name: 'mine', setup() {} };`);
  const status = await plugins.load(ctx.cfg.loadConfig());
  assert.ok(status.plugins.some((p) => p.name === 'mine'));
});
