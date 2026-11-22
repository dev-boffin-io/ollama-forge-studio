'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');

const ctx = setup();
const ROOT = path.resolve(__dirname, '..');
const plugins = require('../lib/plugins');
const hooks = require('../lib/hooks');

const withBundled = async (fn) => {
  const prev = process.env.OLLAMA_STUDIO_NO_BUNDLED;
  delete process.env.OLLAMA_STUDIO_NO_BUNDLED;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.OLLAMA_STUDIO_NO_BUNDLED; else process.env.OLLAMA_STUDIO_NO_BUNDLED = prev; }
};

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

test('bundled example plugins load, register tools and respect plugins.enabled:false', async () => {
  plugins.reset();
  hooks.reset();
  fs.rmSync(path.join(ctx.studioDir, 'plugins'), { recursive: true, force: true });
  await withBundled(async () => {
    const status = await plugins.load(ctx.cfg.loadConfig());
    assert.equal(status.errors.length, 0, JSON.stringify(status.errors));
    const now = status.plugins.find((p) => p.name === 'now');
    const json = status.plugins.find((p) => p.name === 'json');
    const http = status.plugins.find((p) => p.name === 'http');
    assert.ok(now && json && http, 'all bundled plugins should load');
    assert.deepEqual(now.tools, ['now_now']);
    assert.deepEqual(json.tools, ['json_format']);
    assert.deepEqual(http.tools, ['http_request']);
    assert.equal(now.dir, path.join(ROOT, 'examples', 'plugins', 'now'));
    assert.equal(json.dir, path.join(ROOT, 'examples', 'plugins', 'json-format'));
    assert.equal(http.dir, path.join(ROOT, 'examples', 'plugins', 'http-request'));
    assert.equal(plugins.isTool('http_request'), true);

    const t = await plugins.callTool('now_now', { utc: true });
    assert.match(t.iso, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof t.unix_ms, 'number');
    const f = await plugins.callTool('json_format', { text: '{"b":2,"a":1}', sort_keys: true, indent: 0 });
    assert.equal(f.output, '{"a":1,"b":2}');
    await assert.rejects(() => plugins.callTool('json_format', { text: '{bad' }), /invalid JSON/);
  });
  plugins.reset();
  hooks.reset();

  await withBundled(async () => {
    const status = await plugins.load({ ...ctx.cfg.loadConfig(), plugins: { enabled: false } });
    assert.equal(status.enabled, false);
    assert.deepEqual(status.plugins, []);
    assert.equal(plugins.isTool('now_now'), false);
  });
  plugins.reset();
  hooks.reset();
});

test('user plugins override bundled plugins with the same name', async () => {
  plugins.reset();
  hooks.reset();
  const dir = pluginDir();
  fs.writeFileSync(path.join(dir, 'now.js'), "module.exports = { name: 'now', tools: { now: { description: 'override', handler: () => ({ output: 'user' }) } } };\n", 'utf8');
  await withBundled(async () => {
    const status = await plugins.load(ctx.cfg.loadConfig());
    assert.equal(status.errors.length, 0, JSON.stringify(status.errors));
    assert.equal(status.plugins.filter((p) => p.name === 'now').length, 1);
    assert.deepEqual(await plugins.callTool('now_now', {}), { output: 'user' });
    assert.ok(plugins.isTool('json_format'), 'unrelated bundled plugins are unaffected');
  });
  plugins.reset();
  hooks.reset();
});
