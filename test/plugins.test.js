'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');

const ctx = setup();
const plugins = require('../lib/plugins');
const hooks = require('../lib/hooks');

function pluginDir() {
  const dir = path.join(ctx.studioDir, 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('JS plugin registers namespaced tools, hooks and routes; unload removes them', async () => {
  plugins.reset();
  hooks.reset();
  const file = path.join(pluginDir(), 'hello.js');
  fs.writeFileSync(file, `
    module.exports = {
      name: 'hello',
      setup(api) {
        api.registerTool({
          name: 'greet',
          description: 'Greet someone',
          parameters: { type: 'object', properties: { who: { type: 'string' } } },
          handler: async ({ who }) => ({ output: 'hi ' + (who || 'world') }),
        });
        api.registerHook('on_tool_call', (event) => ({ allow: event.tool !== 'forbidden', message: 'blocked by plugin' }));
        api.registerRoute({ method: 'GET', path: '/api/plugins/hello', handler: () => ({ ok: true, plugin: 'hello' }) });
      },
    };
  `, 'utf8');

  const status = await plugins.load(ctx.cfg.loadConfig());
  assert.equal(status.enabled, true);
  assert.equal(status.errors.length, 0);
  const loaded = status.plugins.find((p) => p.name === 'hello');
  assert.ok(loaded, 'hello plugin should load');
  assert.deepEqual(loaded.tools, ['hello_greet']);
  assert.equal(plugins.isTool('hello_greet'), true);
  assert.equal(plugins.toolDefs()[0].function.name, 'hello_greet');
  assert.deepEqual(await plugins.callTool('hello_greet', { who: 'Ada' }), { output: 'hi Ada' });

  await assert.rejects(() => hooks.run('on_tool_call', { tool: 'forbidden' }, { config: ctx.cfg.loadConfig(), blocking: true }), /blocked by plugin/);

  let sent = null;
  const res = { writableEnded: false, writeHead() {}, end() { this.writableEnded = true; } };
  const handled = await plugins.handleRoute({ method: 'GET' }, res, new URL('http://x/api/plugins/hello'), {
    sendJson: (r, s, b) => { sent = { status: s, body: b }; r.writableEnded = true; },
  });
  assert.equal(handled, true);
  assert.deepEqual(sent, { status: 200, body: { ok: true, plugin: 'hello' } });

  plugins.reset();
  assert.equal(plugins.isTool('hello_greet'), false);
  await hooks.run('on_tool_call', { tool: 'forbidden' }, { config: ctx.cfg.loadConfig(), blocking: true });
  hooks.reset();
});

test('JSON plugin command tools receive arguments as JSON on stdin', async () => {
  plugins.reset();
  const dir = path.join(pluginDir(), 'jsonplug');
  fs.mkdirSync(dir, { recursive: true });
  const script = 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write(JSON.stringify({output:"hello "+p.args.who}));});';
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    name: 'jsonplug',
    tools: { greet: { description: 'JSON greeting', command: [process.execPath, '-e', script] } },
  }, null, 2), 'utf8');
  const status = await plugins.load(ctx.cfg.loadConfig());
  assert.equal(status.errors.length, 0);
  assert.ok(status.plugins.some((p) => p.name === 'jsonplug'));
  assert.deepEqual(await plugins.callTool('jsonplug_greet', { who: 'Grace' }), { output: 'hello Grace' });
  plugins.reset();
});

test('a single-file plugin without a name uses its filename', async () => {
  plugins.reset();
  const extra = fs.mkdtempSync(path.join(ctx.dir, 'nameless-plugins-'));
  fs.writeFileSync(path.join(extra, 'nameless.js'), "module.exports = { tools: { ping: { description: 'p', handler: () => ({ pong: true }) } } };\n", 'utf8');
  const status = await plugins.load({ ...ctx.cfg.loadConfig(), plugins: { enabled: true, paths: [extra] } });
  assert.ok(status.plugins.some((p) => p.name === 'nameless'));
  assert.equal(plugins.isTool('nameless_ping'), true);
  assert.deepEqual(await plugins.callTool('nameless_ping', {}), { pong: true });
  plugins.reset();
});

test('a plugin that fails during setup leaves no tools, hooks or routes behind', async () => {
  plugins.reset();
  hooks.reset();
  const extra = fs.mkdtempSync(path.join(ctx.dir, 'broken-plugins-'));
  const file = path.join(extra, 'broken.js');
  fs.writeFileSync(file, `
    module.exports = {
      name: 'broken',
      setup(api) {
        api.registerTool({ name: 'ping', description: 'p', handler: () => ({ pong: true }) });
        api.registerHook('on_tool_call', () => ({ allow: false, message: 'partial hook' }));
        api.registerRoute({ method: 'GET', path: '/api/plugins/broken', handler: () => ({ ok: true }) });
        throw new Error('setup failed');
      },
    };
  `, 'utf8');
  const status = await plugins.load({ ...ctx.cfg.loadConfig(), plugins: { enabled: true, paths: [extra] } });
  assert.equal(status.errors.length, 1);
  assert.match(status.errors[0].error, /setup failed/);
  assert.equal(plugins.isTool('broken_ping'), false);
  assert.equal(plugins.status().routes.some((r) => r.path === '/api/plugins/broken'), false);
  await hooks.run('on_tool_call', { tool: 'anything' }, { config: ctx.cfg.loadConfig(), blocking: true });
  plugins.reset();
  hooks.reset();
});

test('plugin paths from config are loaded and duplicate names are skipped', async () => {
  plugins.reset();
  const extra = fs.mkdtempSync(path.join(ctx.dir, 'extra-plugins-'));
  fs.writeFileSync(path.join(extra, 'one.js'), "module.exports = { name: 'extra', tools: { ping: { description: 'p', handler: () => ({ pong: true }) } } };\n", 'utf8');
  const config = { ...ctx.cfg.loadConfig(), plugins: { enabled: true, paths: [extra] } };
  const status = await plugins.load(config);
  assert.equal(status.errors.length, 0);
  assert.ok(status.plugins.some((p) => p.name === 'extra'));
  assert.deepEqual(await plugins.callTool('extra_ping', {}), { pong: true });
  plugins.reset();
});
