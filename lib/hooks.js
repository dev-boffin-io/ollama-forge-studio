'use strict';

// Lifecycle hooks. Hooks can be configured in config.json or registered by plugins.
//
//   "hooks": {
//     "pre_edit":       [{ "backup": true }],
//     "on_tool_call":   [{ "command": ["node", "hooks/audit.js"], "timeout": 10000 }],
//     "on_file_change": [{ "command": "echo changed >> .studio/hook.log" }]
//   }
//
// Command hooks get the event payload as JSON on stdin and in OLLAMA_STUDIO_HOOK_PAYLOAD. They may print a JSON
// object; { "allow": false, "message": "..." } blocks a blocking event. pre_edit and on_tool_call are blocking by
// default; the other events are observe-only. { "backup": true } is a built-in pre_edit hook that copies the old file
// (or folder) into <studio data dir>/backups/<timestamp>/ before the agent changes it.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const log = require('./log');
const { getWorkDir, studioDir } = require('./config');

const win = process.platform === 'win32';
const MAX_OUTPUT = 256 * 1024;

const EVENTS = [
  'on_agent_start', 'on_agent_end',
  'on_tool_call', 'on_tool_result',
  'pre_edit', 'on_file_change',
  'on_error',
];

const BLOCKING = new Set(['pre_edit', 'on_tool_call']);
const defaultBlocking = (event) => BLOCKING.has(event);

const handlers = new Map();   // event -> [{ id, fn, source, blocking }]
let seq = 0;

class HookBlocked extends Error {
  constructor(message) {
    super(message);
    this.name = 'HookBlocked';
    this.status = 403;
  }
}

/** Register a JS hook. Returns an unsubscribe function. */
function on(event, fn, opts = {}) {
  if (typeof fn !== 'function') throw new Error('hook handler must be a function');
  const list = handlers.get(event) || [];
  const entry = { id: ++seq, fn, source: opts.source || 'plugin', blocking: opts.blocking };
  list.push(entry);
  handlers.set(event, list);
  return () => off(event, entry.id);
}

function off(event, id) {
  const list = handlers.get(event);
  if (!list) return;
  const next = list.filter((h) => h.id !== id);
  if (next.length) handlers.set(event, next); else handlers.delete(event);
}

/** Remove every JS hook registered by a plugin (called when plugins reload). */
function clear(source) {
  for (const [event, list] of handlers) {
    const next = list.filter((h) => h.source !== source);
    if (next.length) handlers.set(event, next); else handlers.delete(event);
  }
}

function list() {
  const out = [];
  for (const [event, entries] of handlers) {
    for (const h of entries) out.push({ event, source: h.source, blocking: h.blocking });
  }
  return out;
}

function normalizeSpec(spec, event) {
  if (typeof spec === 'function') return { fn: spec, source: 'config', blocking: defaultBlocking(event) };
  if (typeof spec === 'string') return { command: spec, source: 'config', blocking: defaultBlocking(event) };
  if (!spec || typeof spec !== 'object') return null;
  return {
    ...spec,
    command: spec.command || spec.cmd || spec.run,
    source: spec.source || 'config',
    blocking: spec.blocking === undefined ? defaultBlocking(event) : spec.blocking === true,
  };
}

function configSpecs(config, event) {
  const all = config && config.hooks;
  if (!all || typeof all !== 'object') return [];
  const specs = [];
  for (const key of [event, '*']) {
    const value = all[key];
    if (!value) continue;
    const list = Array.isArray(value) ? value : [value];
    for (const spec of list) {
      const normalized = normalizeSpec(spec, event);
      if (normalized) specs.push(normalized);
    }
  }
  return specs;
}

function safeRelative(rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter((p) => p && p !== '.' && p !== '..').join('/');
}

function backupPath(payload, spec) {
  const rel = safeRelative(payload.path || payload.from);
  if (!rel) return null;
  const root = spec.backupDir ? path.resolve(getWorkDir(), spec.backupDir) : path.join(studioDir(), 'backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(root, stamp, rel);
}

function backup(payload, spec) {
  const rel = payload.path || payload.from;
  if (!rel) return { backedUp: false, reason: 'no path in the hook payload' };
  const src = payload.absolutePath || path.resolve(getWorkDir(), rel);
  const dest = backupPath(payload, spec);
  if (!dest) return { backedUp: false, reason: 'unsafe path' };
  try {
    if (!fs.existsSync(src)) return { backedUp: false, reason: 'source does not exist' };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true, force: true });
    return { backedUp: true, path: dest };
  } catch (e) {
    return { backedUp: false, error: String(e.message || e) };
  }
}

/** Run one command/function hook spec. Exported for JSON plugins that contribute command hooks. */
async function runSpec(spec, payload, ctx = {}) {
  if (!spec) return null;
  if (spec.backup === true) return backup(payload, spec);
  if (typeof spec.fn === 'function') return spec.fn(payload, ctx);
  if (typeof spec === 'function') return spec(payload, ctx);
  const command = spec.command || spec.cmd || spec.run;
  if (!command) throw new Error('hook has no command, backup or function');
  const result = await runCommand(command, spec, payload, ctx);
  if (ctx.blocking && result.code !== 0) {
    throw new HookBlocked(`${payload.event || 'hook'} command exited ${result.code}: ${result.stderr.trim().slice(-500) || 'no error output'}`);
  }
  if (ctx.blocking && result.json && result.json.allow === false) {
    throw new HookBlocked(result.json.message || `${payload.event || 'hook'} was blocked by a hook`);
  }
  return result.json || result;
}

function runCommand(command, spec, payload, ctx) {
  return new Promise((resolve, reject) => {
    const cwd = spec.cwd ? path.resolve(getWorkDir(), spec.cwd) : getWorkDir();
    const timeout = Math.min(60000, Math.max(100, Number(spec.timeout) || 10000));
    const input = JSON.stringify(payload);
    const env = {
      ...process.env,
      ...(spec.env && typeof spec.env === 'object' ? spec.env : {}),
      OLLAMA_STUDIO_HOOK: String(payload.event || ''),
      OLLAMA_STUDIO_HOOK_PAYLOAD: input,
      OLLAMA_STUDIO_WORKDIR: getWorkDir(),
      OLLAMA_STUDIO_SESSION: String(payload.sessionId || ''),
    };
    let child;
    try {
      if (Array.isArray(command)) {
        if (!command.length) throw new Error('empty command array');
        child = spawn(String(command[0]), command.slice(1).map(String), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      } else {
        child = win
          ? spawn('cmd.exe', ['/c', String(command)], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
          : spawn('sh', ['-c', String(command)], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      }
    } catch (e) { return reject(e); }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ code: -1, stdout, stderr: stderr + '\naborted', json: null, aborted: true }); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish({ code: -1, stdout, stderr: stderr + `\nhook timed out after ${timeout}ms`, json: null, timedOut: true }); }, timeout);
    if (ctx.signal) { if (ctx.signal.aborted) return onAbort(); ctx.signal.addEventListener('abort', onAbort, { once: true }); }
    child.on('error', (e) => finish({ code: -1, stdout, stderr: stderr + '\n' + e.message, json: null, error: String(e.message || e) }));
    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });
    child.on('close', (code) => {
      let json = null;
      const text = stdout.trim();
      if (text.startsWith('{') || text.startsWith('[')) { try { json = JSON.parse(text); } catch { /* plain text output */ } }
      finish({ code: code == null ? -1 : code, stdout, stderr, json });
    });
    child.stdin.on('error', () => { /* hook may not read stdin */ });
    try { child.stdin.end(input); } catch { /* hook may not read stdin */ }
  });
}

/**
 * Fire an event. `ctx` may contain config, session, agent, emit, signal and an explicit `blocking` override.
 * Blocking hooks throw HookBlocked; observe-only hook failures are logged and never break the agent.
 */
async function run(event, payload = {}, ctx = {}) {
  const config = ctx.config || {};
  const registered = (handlers.get(event) || []).map((h) => ({
    fn: h.fn, source: h.source, blocking: h.blocking === undefined ? defaultBlocking(event) : h.blocking,
  }));
  const specs = [...registered, ...configSpecs(config, event)];
  if (!specs.length) return [];
  const full = {
    event,
    workDir: getWorkDir(),
    studioDir: studioDir(),
    sessionId: payload.sessionId || (ctx.session && ctx.session.id) || null,
    agent: payload.agent || (ctx.agent && ctx.agent.name) || null,
    ...payload,
  };
  const results = [];
  for (const spec of specs) {
    const blocking = spec.blocking === false ? false : (ctx.blocking === undefined ? spec.blocking === true : ctx.blocking === true);
    try {
      const result = await runSpec(spec, full, { ...ctx, blocking });
      if (blocking && result && result.allow === false) {
        throw new HookBlocked(result.message || `${event} was blocked by a hook`);
      }
      results.push(result);
    } catch (e) {
      if (e instanceof HookBlocked) throw e;
      if (blocking) throw new HookBlocked(`${event} hook failed: ${e.message || e}`);
      log.warn('hooks', `${event} hook failed (ignored)`, e);
      try { if (ctx.emit) ctx.emit({ type: 'hook_error', event, message: String(e.message || e) }); } catch { /* stream closed */ }
    }
  }
  return results;
}

/** Built-in helper used by the file tools: pre_edit hooks, including optional backups. */
async function preEdit(ctx, payload) {
  return run('pre_edit', payload, { ...ctx, blocking: true });
}

/** Observe-only notification after a file/folder was changed. */
async function fileChange(ctx, payload) {
  return run('on_file_change', payload, { ...ctx, blocking: false });
}

/** Test helper: drop every registered JS hook. */
function reset() { handlers.clear(); }

module.exports = {
  EVENTS, HookBlocked, on, off, clear, list, reset,
  run, runSpec, preEdit, fileChange, backup,
};
