'use strict';

// Minimal MCP (Model Context Protocol) client, zero dependencies.
// Transports: local (stdio, newline-delimited JSON-RPC) and remote (Streamable HTTP, JSON or SSE replies).
// Config (config.mcp):
//   "github": { "type": "local",  "command": ["npx","-y","@modelcontextprotocol/server-github"], "environment": {"GITHUB_TOKEN":"..."} }
//   "docs":   { "type": "remote", "url": "https://example.com/mcp", "headers": {"Authorization":"Bearer ..."} }
// Common options: "enabled": false, "timeout": 30000.  (OAuth-protected remote servers are not supported.)

const { spawn } = require('node:child_process');
const { getWorkDir } = require('./config');

const PROTOCOL = '2025-03-26';
const DEFAULT_TIMEOUT = 30000;

const withTimeout = (p, ms, label) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

class StdioTransport {
  constructor(cfg) {
    this.cfg = cfg;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
  }

  start() {
    const [cmd, ...args] = this.cfg.command;
    this.child = spawn(cmd, args, { cwd: getWorkDir(), env: { ...process.env, ...(this.cfg.environment || {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (d) => this.onData(d));
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-2000); });
    const fail = (err) => { for (const p of this.pending.values()) p.reject(err); this.pending.clear(); this.closed = true; };
    this.child.on('error', (e) => fail(new Error('spawn failed: ' + e.message)));
    this.child.on('close', (code) => fail(new Error(`server exited (${code}) ${this.stderr.trim().slice(-300)}`)));
  }

  onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && (msg.result !== undefined || msg.error) && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message || JSON.stringify(msg.error))) : p.resolve(msg.result);
      } else if (msg.id != null && msg.method) {
        // server -> client request: answer politely
        const reply = msg.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'not supported' } };
        this.write({ jsonrpc: '2.0', id: msg.id, ...reply });
      }
    }
  }

  write(obj) { if (this.child && !this.closed) this.child.stdin.write(JSON.stringify(obj) + '\n'); }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error('server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.write({ jsonrpc: '2.0', id, method, params }); });
  }

  notify(method, params) { this.write({ jsonrpc: '2.0', method, params }); }
  close() { try { this.closed = true; this.child && this.child.kill(); } catch { /* ignore */ } }
}

class HttpTransport {
  constructor(cfg) { this.cfg = cfg; this.nextId = 1; this.sessionId = null; }
  start() {}

  async post(body, expectId) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(this.cfg.headers || {}) };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const res = await fetch(this.cfg.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.cfg.timeout || 120000) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (res.status === 401) throw new Error('401 unauthorized (OAuth is not supported; use a "headers" token)');
    if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    if (expectId == null) return undefined;
    const text = await res.text();
    const candidates = [];
    const t = text.trim();
    if (t.startsWith('{') || t.startsWith('[')) { try { const j = JSON.parse(t); candidates.push(...(Array.isArray(j) ? j : [j])); } catch { /* fall through */ } }
    if (!candidates.length) {
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try { candidates.push(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ }
      }
    }
    const msg = candidates.find((m) => m.id === expectId);
    if (!msg) throw new Error('no response from server');
    if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
    return msg.result;
  }

  request(method, params) { const id = this.nextId++; return this.post({ jsonrpc: '2.0', id, method, params }, id); }
  async notify(method, params) { try { await this.post({ jsonrpc: '2.0', method, params }, null); } catch { /* ignore */ } }
  close() { if (this.sessionId) fetch(this.cfg.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': this.sessionId, ...(this.cfg.headers || {}) } }).catch(() => {}); }
}

const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');

/* ---------- manager ---------- */

let servers = new Map(); // name -> { cfg, transport, status, error, tools[] }
let startedFor = null;

async function connect(name, cfg) {
  const entry = { name, cfg, type: cfg.type, status: 'connecting', error: '', tools: [] };
  servers.set(name, entry);
  if (cfg.enabled === false) { entry.status = 'disabled'; return; }
  const timeout = cfg.timeout || DEFAULT_TIMEOUT;
  try {
    const transport = cfg.type === 'remote' ? new HttpTransport(cfg) : new StdioTransport(cfg);
    if (cfg.type !== 'remote' && !(Array.isArray(cfg.command) && cfg.command.length)) throw new Error('"command" must be a non-empty array');
    if (cfg.type === 'remote' && !cfg.url) throw new Error('"url" is required');
    transport.start();
    entry.transport = transport;
    const init = await withTimeout(transport.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'ollama-forge-studio', version: '2.0.0' } }), timeout, 'initialize');
    await transport.notify('notifications/initialized');
    entry.instructions = init && init.instructions;
    let cursor;
    do {
      const r = await withTimeout(transport.request('tools/list', cursor ? { cursor } : {}), timeout, 'tools/list');
      for (const t of r.tools || []) entry.tools.push(t);
      cursor = r.nextCursor;
    } while (cursor);
    entry.status = 'connected';
  } catch (err) {
    entry.status = 'failed';
    entry.error = String(err.message || err).slice(0, 400);
    if (entry.transport) entry.transport.close();
  }
}

/** Start (once per working directory) all configured servers, in parallel. */
async function ensureStarted(config) {
  const key = getWorkDir();
  if (startedFor === key) return;
  stop();
  startedFor = key;
  await Promise.all(Object.entries(config.mcp || {}).map(([name, cfg]) => connect(sanitize(name), cfg || {})));
}

function stop() {
  for (const s of servers.values()) if (s.transport) s.transport.close();
  servers = new Map();
  startedFor = null;
}

async function reload(config) { stop(); await ensureStarted(config); return status(); }

const status = () => [...servers.values()].map((s) => ({ name: s.name, type: s.type, status: s.status, tools: s.tools.length, error: s.error || undefined }));

/** [{ name, server, tool, description, parameters }] for all connected servers. */
function tools() {
  const out = [];
  for (const s of servers.values()) {
    if (s.status !== 'connected') continue;
    for (const t of s.tools) {
      const schema = { ...(t.inputSchema || { type: 'object', properties: {} }) };
      delete schema.$schema;
      if (!schema.type) schema.type = 'object';
      out.push({ name: `${s.name}_${sanitize(t.name)}`, server: s.name, tool: t.name, description: t.description || t.name, parameters: schema });
    }
  }
  return out;
}

async function call(fullName, args, timeoutMs) {
  const def = tools().find((t) => t.name === fullName);
  if (!def) throw new Error(`unknown MCP tool ${fullName}`);
  const s = servers.get(def.server);
  const result = await withTimeout(s.transport.request('tools/call', { name: def.tool, arguments: args || {} }), timeoutMs || s.cfg.callTimeout || 120000, `MCP ${fullName}`);
  const text = (result.content || []).map((c) => (c.type === 'text' ? c.text : c.type === 'resource' && c.resource && c.resource.text ? c.resource.text : `[${c.type} content omitted]`)).join('\n');
  if (result.isError) throw new Error(text || 'MCP tool returned an error');
  return text || JSON.stringify(result.structuredContent || {});
}

const isMcpTool = (name) => tools().some((t) => t.name === name);
process.on('exit', stop);

module.exports = { ensureStarted, reload, stop, status, tools, call, isMcpTool };
