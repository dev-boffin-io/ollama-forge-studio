'use strict';

// External plugins add tools, hooks and HTTP routes without touching the core.
//
// A plugin is either a single CommonJS file, a folder with plugin.json (and optionally index.js/main), or a folder
// with index.js. Plugins are loaded from <global>/plugins, the project's .studio/plugins, .claude/plugins,
// .agents/plugins, the project data dir, and config.plugins.paths. Plugin tools are always namespaced:
// a plugin called "docker" with a tool called "ps" is exposed to the model as "docker_ps".
//
// CommonJS example:
//   module.exports = {
//     name: 'hello',
//     setup(api) {
//       api.registerTool({
//         name: 'greet',
//         description: 'Greet someone',
//         parameters: { type: 'object', properties: { who: { type: 'string' } } },
//         handler: async ({ who }) => ({ output: `hello ${who || 'world'}` }),
//       });
//       api.registerHook('on_tool_call', async (event) => ({ allow: event.tool !== 'bash' }));
//       api.registerRoute({ method: 'GET', path: '/api/plugins/hello', handler: () => ({ ok: true }) });
//     },
//   };
//
// JSON example:
//   { "name": "hello", "tools": { "greet": { "description": "Greet", "command": ["node", "greet.js"] } } }

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const log = require('./log');
const hooks = require('./hooks');
const { GLOBAL_DIR, getWorkDir, studioDir } = require('./config');
const { bundledRoot } = require('./bundled');

const win = process.platform === 'win32';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOOL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_OUTPUT = 512 * 1024;

let loaded = [];
let toolMap = new Map();      // exposed name -> { plugin, spec, handler, command, def }
let routeList = [];           // { plugin, method, path, handler }
let lastStatus = { enabled: true, plugins: [], errors: [] };

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'plugin';
}

function resolvePath(p, base) {
  const raw = String(p || '');
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(base, raw);
}

function roots(config) {
  const dir = getWorkDir();
  const bundled = bundledRoot();
  const extra = (config && config.plugins && Array.isArray(config.plugins.paths)) ? config.plugins.paths : [];
  return [...new Set([
    path.join(GLOBAL_DIR, 'plugins'),
    path.join(dir, '.studio', 'plugins'),
    path.join(dir, '.claude', 'plugins'),
    path.join(dir, '.agents', 'plugins'),
    path.join(studioDir(), 'plugins'),
    ...extra.map((p) => resolvePath(p, dir)),
    ...(bundled ? [path.join(bundled, 'plugins')] : []),
  ])];
}

function candidates(root) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory() || e.isSymbolicLink()) {
      const manifest = path.join(full, 'plugin.json');
      if (fs.existsSync(manifest)) out.push({ file: manifest, dir: full, single: false });
      else {
        for (const name of ['index.js', 'plugin.js', 'index.cjs', 'plugin.cjs']) {
          const f = path.join(full, name);
          if (fs.existsSync(f)) { out.push({ file: f, dir: full, single: false }); break; }
        }
      }
    } else if (/\.(?:c?js|json)$/i.test(e.name)) {
      out.push({ file: full, dir: root, single: true });
    }
  }
  return out;
}

function makeApi(plugin, config) {
  const api = {
    name: plugin.name,
    version: plugin.version,
    dir: plugin.dir,
    config,
    workDir: getWorkDir(),
    studioDir: studioDir(),
    log: {
      debug: (...args) => log.debug('plugin:' + plugin.name, ...args),
      info: (...args) => log.info('plugin:' + plugin.name, ...args),
      warn: (...args) => log.warn('plugin:' + plugin.name, ...args),
      error: (...args) => log.error('plugin:' + plugin.name, ...args),
    },
    registerTool: (spec) => addTool(plugin, spec),
    registerHook: (event, spec) => addHook(plugin, event, spec),
    on: (event, spec) => addHook(plugin, event, spec),
    registerRoute: (spec) => addRoute(plugin, spec),
    expose: (name, value) => { plugin.exports[name] = value; },
  };
  return api;
}

function addTool(plugin, spec) {
  if (!spec || typeof spec !== 'object') throw new Error(`plugin ${plugin.name}: registerTool expects an object`);
  const local = String(spec.name || '').trim();
  if (!TOOL_RE.test(local)) throw new Error(`plugin ${plugin.name}: invalid tool name "${local}"`);
  const name = `${slug(plugin.name)}_${local}`;
  if (toolMap.has(name)) throw new Error(`plugin ${plugin.name}: duplicate tool ${name}`);
  const handler = typeof spec.handler === 'function' ? spec.handler : null;
  const command = spec.command || spec.cmd;
  if (!handler && !command) throw new Error(`plugin ${plugin.name}: tool ${local} needs a handler or command`);
  const parameters = spec.parameters && typeof spec.parameters === 'object'
    ? spec.parameters
    : { type: 'object', properties: {}, additionalProperties: false };
  const def = {
    type: 'function',
    function: {
      name,
      description: String(spec.description || `${plugin.name} plugin tool: ${local}`).slice(0, 1024),
      parameters,
    },
  };
  toolMap.set(name, { plugin, spec, handler, command, def });
  plugin.tools.push(name);
  log.debug('plugins', `registered tool ${name} from ${plugin.name}`);
}

function addHook(plugin, event, spec) {
  if (!hooks.EVENTS.includes(event)) throw new Error(`plugin ${plugin.name}: unknown hook event "${event}"`);
  if (!spec || (typeof spec !== 'function' && typeof spec !== 'object')) throw new Error(`plugin ${plugin.name}: invalid ${event} hook`);
  const normalized = typeof spec === 'function' ? { fn: spec } : spec;
  const dispose = hooks.on(event, (payload, ctx) => hooks.runSpec(normalized, payload, ctx), {
    source: plugin.name,
    blocking: normalized.blocking,
  });
  plugin.hookCleanups.push(dispose);
  plugin.hooks += 1;
}

function addRoute(plugin, spec) {
  if (!spec || typeof spec !== 'object') throw new Error(`plugin ${plugin.name}: registerRoute expects an object`);
  const method = String(spec.method || 'GET').toUpperCase();
  const routePath = String(spec.path || '');
  if (!routePath.startsWith('/api/plugins/')) throw new Error(`plugin ${plugin.name}: routes must start with /api/plugins/`);
  if (typeof spec.handler !== 'function') throw new Error(`plugin ${plugin.name}: route ${routePath} needs a handler`);
  if (routeList.some((r) => r.method === method && r.path === routePath)) {
    throw new Error(`plugin ${plugin.name}: duplicate route ${method} ${routePath}`);
  }
  routeList.push({ plugin, method, path: routePath, handler: spec.handler });
  plugin.routes.push({ method, path: routePath });
}

function applyDefinitions(plugin, defs, config) {
  if (!defs || typeof defs !== 'object') return;
  const tools = defs.tools || {};
  if (Array.isArray(tools)) {
    for (const t of tools) addTool(plugin, t);
  } else {
    for (const [name, t] of Object.entries(tools)) addTool(plugin, { name, ...(t || {}) });
  }
  const hookDefs = defs.hooks || {};
  for (const [event, list] of Object.entries(hookDefs)) {
    const entries = Array.isArray(list) ? list : [list];
    for (const h of entries) addHook(plugin, event, h);
  }
  const routes = defs.routes || [];
  for (const r of Array.isArray(routes) ? routes : Object.values(routes)) addRoute(plugin, r);
  if (typeof defs.setup === 'function') return defs.setup(makeApi(plugin, config));
  return undefined;
}

async function loadCandidate(candidate, config, seen, errors) {
  let manifest = {};
  let moduleExport = null;
  let jsFile = null;
  let dir = candidate.dir;
  if (/\.json$/i.test(candidate.file)) {
    try { manifest = JSON.parse(fs.readFileSync(candidate.file, 'utf8')); } catch (e) {
      throw new Error(`cannot read ${candidate.file}: ${e.message}`);
    }
    if (manifest.enabled === false) return null;
    if (manifest.main) jsFile = path.resolve(dir, manifest.main);
    else if (fs.existsSync(path.join(dir, 'index.js'))) jsFile = path.join(dir, 'index.js');
    else if (fs.existsSync(path.join(dir, 'index.cjs'))) jsFile = path.join(dir, 'index.cjs');
  } else {
    jsFile = candidate.file;
  }
  if (jsFile) {
    if (!fs.existsSync(jsFile)) throw new Error(`plugin entry not found: ${jsFile}`);
    const req = createRequire(jsFile);
    const resolved = req.resolve(jsFile);
    delete req.cache[resolved];
    moduleExport = req(resolved);
    if (moduleExport && moduleExport.manifest) manifest = { ...moduleExport.manifest, ...manifest };
    dir = path.dirname(jsFile);
  }
  const fallback = candidate.single ? path.basename(candidate.file, path.extname(candidate.file)) : path.basename(candidate.dir);
  const name = String(manifest.name || (moduleExport && moduleExport.name) || fallback || path.basename(candidate.file)).trim();
  if (!NAME_RE.test(name)) throw new Error(`invalid plugin name "${name}" (use letters, numbers, dot, dash, underscore)`);
  if (seen.has(name)) {
    log.warn('plugins', `skipping duplicate plugin ${name} in ${candidate.file}`);
    return null;
  }
  seen.add(name);
  const plugin = {
    name,
    version: String(manifest.version || (moduleExport && moduleExport.version) || '0.0.0'),
    description: String(manifest.description || (moduleExport && moduleExport.description) || ''),
    dir,
    file: candidate.file,
    tools: [],
    routes: [],
    hooks: 0,
    hookCleanups: [],
    exports: {},
    module: moduleExport,
    shutdown: moduleExport && (moduleExport.shutdown || moduleExport.teardown),
  };
  const api = makeApi(plugin, config);
  try {
    if (typeof moduleExport === 'function') await moduleExport(api);
    else if (moduleExport && typeof moduleExport.setup === 'function') await moduleExport.setup(api);
    await applyDefinitions(plugin, manifest, config);
    if (moduleExport && typeof moduleExport === 'object') {
      await applyDefinitions(plugin, {
        tools: moduleExport.tools,
        hooks: moduleExport.hooks,
        routes: moduleExport.routes,
      }, config);
    }
    loaded.push(plugin);
    log.info('plugins', `loaded ${name}@${plugin.version} (${plugin.tools.length} tool(s), ${plugin.hooks} hook(s), ${plugin.routes.length} route(s))`);
    return plugin;
  } catch (e) {
    for (const dispose of plugin.hookCleanups) {
      try { dispose(); } catch { /* already gone */ }
    }
    hooks.clear(name);
    for (const [key, entry] of toolMap) if (entry.plugin === plugin) toolMap.delete(key);
    routeList = routeList.filter((route) => route.plugin !== plugin);
    seen.delete(name);
    throw e;
  }
}

async function load(config = {}) {
  unload();
  const enabled = !(config.plugins && config.plugins.enabled === false);
  if (!enabled) {
    lastStatus = { enabled: false, plugins: [], errors: [] };
    log.info('plugins', 'plugins disabled in config');
    return lastStatus;
  }
  const seen = new Set();
  const errors = [];
  for (const root of roots(config)) {
    for (const candidate of candidates(root)) {
      try {
        await loadCandidate(candidate, config, seen, errors);
      } catch (e) {
        const message = String(e.message || e);
        errors.push({ file: candidate.file, error: message });
        log.error('plugins', `failed to load ${candidate.file}`, e);
      }
    }
  }
  lastStatus = {
    enabled: true,
    plugins: loaded.map((p) => ({
      name: p.name,
      version: p.version,
      description: p.description,
      dir: p.dir,
      tools: p.tools.slice(),
      hooks: p.hooks,
      routes: p.routes.slice(),
    })),
    errors,
  };
  return lastStatus;
}

function unload() {
  for (const plugin of loaded) {
    for (const dispose of plugin.hookCleanups) {
      try { dispose(); } catch { /* already gone */ }
    }
    hooks.clear(plugin.name);
    if (typeof plugin.shutdown === 'function') {
      try {
        const result = plugin.shutdown();
        if (result && typeof result.catch === 'function') result.catch((e) => log.warn('plugins', `shutdown ${plugin.name} failed`, e));
      } catch (e) { log.warn('plugins', `shutdown ${plugin.name} failed`, e); }
    }
  }
  loaded = [];
  toolMap = new Map();
  routeList = [];
}

async function reload(config = {}) { return load(config); }

function status() {
  return {
    enabled: lastStatus.enabled !== false,
    plugins: loaded.map((p) => ({
      name: p.name,
      version: p.version,
      description: p.description,
      dir: p.dir,
      tools: p.tools.slice(),
      hooks: p.hooks,
      routes: p.routes.slice(),
    })),
    tools: [...toolMap.keys()],
    routes: routeList.map((r) => ({ method: r.method, path: r.path, plugin: r.plugin.name })),
    errors: lastStatus.errors || [],
  };
}

function toolDefs() {
  return [...toolMap.values()].map((t) => t.def);
}

function isTool(name) { return toolMap.has(name); }

function runCommand(entry, args, ctx) {
  return new Promise((resolve, reject) => {
    const command = entry.command;
    const timeout = Math.min(300000, Math.max(100, Number(entry.spec.timeout) || 60000));
    const payload = JSON.stringify({ args: args || {}, workDir: getWorkDir(), studioDir: studioDir(), sessionId: (ctx && ctx.session && ctx.session.id) || null });
    const env = {
      ...process.env,
      ...(entry.spec.env && typeof entry.spec.env === 'object' ? entry.spec.env : {}),
      OLLAMA_STUDIO_PLUGIN: entry.plugin.name,
      OLLAMA_STUDIO_WORKDIR: getWorkDir(),
      OLLAMA_STUDIO_SESSION: String((ctx && ctx.session && ctx.session.id) || ''),
    };
    let child;
    try {
      if (Array.isArray(command)) {
        if (!command.length) throw new Error('empty command');
        child = spawn(String(command[0]), command.slice(1).map(String), { cwd: getWorkDir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
      } else {
        child = win
          ? spawn('cmd.exe', ['/c', String(command)], { cwd: getWorkDir(), env, stdio: ['pipe', 'pipe', 'pipe'] })
          : spawn('sh', ['-c', String(command)], { cwd: getWorkDir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
      }
    } catch (e) { return reject(e); }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ctx && ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve(value);
    };
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(new Error(`plugin tool ${entry.def.function.name} aborted`)); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(new Error(`plugin tool ${entry.def.function.name} timed out after ${timeout}ms`)); }, timeout);
    if (ctx && ctx.signal) { if (ctx.signal.aborted) return onAbort(); ctx.signal.addEventListener('abort', onAbort, { once: true }); }
    child.on('error', (e) => finish(e));
    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return finish(new Error(stderr.trim().slice(-2000) || `plugin tool exited ${code}`));
      const text = stdout.trim();
      if (text.startsWith('{') || text.startsWith('[')) {
        try { return finish(null, JSON.parse(text)); } catch { /* plain text */ }
      }
      finish(null, { output: text });
    });
    child.stdin.on('error', () => { /* plugin may ignore stdin */ });
    try { child.stdin.end(payload); } catch { /* plugin may ignore stdin */ }
  });
}

async function callTool(name, args, ctx) {
  const entry = toolMap.get(name);
  if (!entry) throw new Error(`unknown plugin tool: ${name}`);
  if (entry.handler) return entry.handler(args || {}, ctx || {});
  return runCommand(entry, args, ctx || {});
}

async function handleRoute(req, res, url, helpers = {}) {
  const method = String(req.method || 'GET').toUpperCase();
  const pathname = url.pathname;
  for (const route of routeList) {
    const match = route.path.endsWith('*') ? pathname.startsWith(route.path.slice(0, -1)) : pathname === route.path;
    if (route.method !== method || !match) continue;
    const result = await route.handler({
      req,
      res,
      url,
      ...helpers,
      config: helpers.config || {},
      workDir: getWorkDir(),
      studioDir: studioDir(),
      plugin: route.plugin.name,
      log,
    });
    if (!res.writableEnded && result !== undefined) {
      if (helpers.sendJson) helpers.sendJson(res, 200, result);
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); }
    }
    return true;
  }
  return false;
}

function reset() {
  unload();
  lastStatus = { enabled: true, plugins: [], errors: [] };
}

module.exports = {
  load, reload, unload, status, reset,
  toolDefs, isTool, callTool,
  handleRoute,
  _addTool: addTool,
  _addRoute: addRoute,
};
