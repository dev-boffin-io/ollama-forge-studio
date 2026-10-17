'use strict';

const log = require('./log');

// Minimal LSP client (zero dependencies): diagnostics after edits + an `lsp` tool for code intelligence.
// Servers are spawned lazily per language/root from PATH (or workdir node_modules/.bin). Config (config.lsp):
//   "lsp": { "myserver": { "command": ["my-ls","--stdio"], "extensions": [".foo"] }, "typescript": { "disabled": true } }
//   "lsp": false   -> disable LSP entirely

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { getWorkDir } = require('./config');

const BUILTIN = [
  { id: 'typescript', exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'], bin: 'typescript-language-server', args: ['--stdio'], roots: ['tsconfig.json', 'jsconfig.json', 'package.json'] },
  { id: 'pyright', exts: ['.py', '.pyi'], bin: 'pyright-langserver', args: ['--stdio'], roots: ['pyproject.toml', 'pyrightconfig.json', 'setup.py', 'requirements.txt'] },
  { id: 'gopls', exts: ['.go'], bin: 'gopls', args: [], roots: ['go.work', 'go.mod'] },
  { id: 'rust-analyzer', exts: ['.rs'], bin: 'rust-analyzer', args: [], roots: ['Cargo.toml'] },
  { id: 'clangd', exts: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp'], bin: 'clangd', args: [], roots: ['compile_commands.json', 'compile_flags.txt', '.clangd'] },
  { id: 'bash', exts: ['.sh', '.bash', '.zsh'], bin: 'bash-language-server', args: ['start'], roots: [] },
  { id: 'json', exts: ['.json', '.jsonc'], bin: 'vscode-json-language-server', args: ['--stdio'], roots: [] },
  { id: 'html', exts: ['.html', '.htm'], bin: 'vscode-html-language-server', args: ['--stdio'], roots: [] },
  { id: 'css', exts: ['.css', '.scss', '.less'], bin: 'vscode-css-language-server', args: ['--stdio'], roots: [] },
  { id: 'yaml', exts: ['.yaml', '.yml'], bin: 'yaml-language-server', args: ['--stdio'], roots: [] },
  { id: 'lua', exts: ['.lua'], bin: 'lua-language-server', args: [], roots: ['.luarc.json'] },
  { id: 'zls', exts: ['.zig'], bin: 'zls', args: [], roots: ['build.zig'] },
];

const LANG = { '.ts': 'typescript', '.tsx': 'typescriptreact', '.js': 'javascript', '.jsx': 'javascriptreact', '.mjs': 'javascript', '.cjs': 'javascript', '.mts': 'typescript', '.cts': 'typescript', '.py': 'python', '.pyi': 'python', '.go': 'go', '.rs': 'rust', '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.h': 'c', '.hpp': 'cpp', '.sh': 'shellscript', '.bash': 'shellscript', '.json': 'json', '.jsonc': 'jsonc', '.html': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less', '.yaml': 'yaml', '.yml': 'yaml', '.lua': 'lua', '.zig': 'zig' };
const KINDS = { 2: 'module', 5: 'class', 6: 'method', 8: 'field', 9: 'constructor', 10: 'enum', 11: 'interface', 12: 'function', 13: 'variable', 14: 'constant', 23: 'struct' };

function which(bin) {
  const dirs = [path.join(getWorkDir(), 'node_modules', '.bin'), ...String(process.env.PATH || '').split(path.delimiter)];
  const exts = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
  for (const d of dirs) for (const e of exts) {
    const f = path.join(d, bin + e);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* not here — try the next candidate */ }
  }
  return null;
}

class Client {
  constructor(id, command, root, initOptions) {
    this.id = id; this.command = command; this.root = root; this.initOptions = initOptions;
    this.nextId = 1; this.pending = new Map(); this.buf = Buffer.alloc(0);
    this.diag = new Map(); this.waiters = []; this.versions = new Map();
  }

  async start() {
    const [cmd, ...args] = this.command;
    this.child = spawn(cmd, args, { cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (d) => this.onData(d));
    this.child.stderr.on('data', () => {});
    const dead = (e) => { this.dead = true; for (const p of this.pending.values()) p.reject(e); this.pending.clear(); };
    this.child.on('error', (e) => dead(new Error('spawn failed: ' + e.message)));
    this.child.on('close', () => dead(new Error('language server exited')));
    const rootUri = pathToFileURL(this.root).href;
    await this.request('initialize', {
      processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) }],
      initializationOptions: this.initOptions || {},
      capabilities: {
        textDocument: {
          synchronization: { didSave: true }, publishDiagnostics: {}, hover: { contentFormat: ['plaintext', 'markdown'] },
          definition: { linkSupport: true }, references: {}, implementation: { linkSupport: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
        workspace: { workspaceFolders: true, configuration: true, symbol: {} },
      },
    }, 30000);
    this.notify('initialized', {});
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const m = this.buf.subarray(0, headerEnd).toString().match(/Content-Length:\s*(\d+)/i);
      if (!m) { this.buf = this.buf.subarray(headerEnd + 4); continue; }
      const len = Number(m[1]);
      if (this.buf.length < headerEnd + 4 + len) return;
      const body = this.buf.subarray(headerEnd + 4, headerEnd + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(headerEnd + 4 + len);
      try { this.onMessage(JSON.parse(body)); } catch (e) { log.debug('lsp', 'bad message from the language server', e); }
    }
  }

  onMessage(msg) {
    if (msg.id != null && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message || 'LSP error')) : p.resolve(msg.result);
    } else if (msg.method === 'textDocument/publishDiagnostics') {
      this.diag.set(msg.params.uri, msg.params.diagnostics || []);
      for (const w of this.waiters.filter((x) => x.uri === msg.params.uri)) { clearTimeout(w.timer); w.timer = setTimeout(() => w.done(), 150); }
    } else if (msg.id != null && msg.method) {
      let result = null;
      if (msg.method === 'workspace/configuration') result = (msg.params.items || []).map(() => null);
      else if (msg.method === 'workspace/workspaceFolders') result = [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }];
      this.send({ jsonrpc: '2.0', id: msg.id, result });
    }
  }

  send(obj) {
    if (this.dead) return;
    const json = JSON.stringify(obj);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }

  request(method, params, timeout = 15000) {
    if (this.dead) return Promise.reject(new Error('language server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }

  /** Sync file content and wait (debounced) for diagnostics. */
  async touch(abs, text, waitMs) {
    const uri = pathToFileURL(abs).href;
    const first = !this.versions.has(uri);
    const version = (this.versions.get(uri) || 0) + 1;
    this.versions.set(uri, version);
    const waiter = new Promise((resolve) => {
      const w = { uri, timer: null, done: () => { clearTimeout(w.timer); this.waiters = this.waiters.filter((x) => x !== w); resolve(); } };
      w.timer = setTimeout(w.done, waitMs);
      this.waiters.push(w);
    });
    if (first) this.notify('textDocument/didOpen', { textDocument: { uri, languageId: LANG[path.extname(abs).toLowerCase()] || 'plaintext', version, text } });
    else { this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] }); this.notify('textDocument/didSave', { textDocument: { uri }, text }); }
    await waiter;
    return this.diag.get(uri) || [];
  }

  close() {
    try { this.request('shutdown', null, 1000).catch(() => {}).finally(() => { this.notify('exit', null); setTimeout(() => this.child.kill(), 300); }); } catch (e) { log.debug('lsp', 'shutdown failed', e); }
  }
}

/* ---------- manager ---------- */

let clients = new Map(); // key -> Promise<Client|null>
let broken = new Set();
let availCache = { dir: null, at: 0, value: false };

function specFor(file, config) {
  if (config.lsp === false) return null;
  const ext = path.extname(file).toLowerCase();
  const custom = config.lsp || {};
  for (const [id, c] of Object.entries(custom)) {
    if (c && !c.disabled && Array.isArray(c.command) && (c.extensions || []).includes(ext)) return { id, command: c.command, roots: c.roots || [], init: c.initialization };
  }
  for (const b of BUILTIN) {
    if ((custom[b.id] && custom[b.id].disabled) || !b.exts.includes(ext)) continue;
    const bin = which(b.bin);
    if (bin) return { id: b.id, command: [bin, ...b.args], roots: b.roots };
  }
  return null;
}

function rootFor(file, markers) {
  const base = getWorkDir();
  for (let d = path.dirname(file); d.startsWith(base); d = path.dirname(d)) {
    if (markers.some((m) => fs.existsSync(path.join(d, m)))) return d;
    if (d === base) break;
  }
  return base;
}

async function clientFor(file, config) {
  const spec = specFor(file, config);
  if (!spec) return null;
  const root = rootFor(file, spec.roots);
  const key = `${spec.id}|${root}`;
  if (broken.has(key)) return null;
  if (!clients.has(key)) {
    const c = new Client(spec.id, spec.command, root, spec.init);
    clients.set(key, c.start().then(() => c, (e) => { log.warn('lsp', `language server "${key}" failed to start; disabled for this session`, e); broken.add(key); try { c.child && c.child.kill(); } catch (e2) { log.debug('lsp', 'kill failed', e2); } return null; }));
  }
  const c = await clients.get(key);
  return c && !c.dead ? c : null;
}

/** True if at least one language server is configured or installed (cached 30s). */
function available(config) {
  if (config.lsp === false) return false;
  const now = Date.now();
  if (availCache.dir === getWorkDir() && now - availCache.at < 30000) return availCache.value;
  const custom = Object.values(config.lsp || {}).some((c) => c && Array.isArray(c.command) && !c.disabled);
  const value = custom || BUILTIN.some((b) => !(config.lsp && config.lsp[b.id] && config.lsp[b.id].disabled) && which(b.bin));
  availCache = { dir: getWorkDir(), at: now, value };
  return value;
}

const rel = (uri) => { try { return path.relative(getWorkDir(), fileURLToPath(uri)) || '.'; } catch { return uri; } };

function formatDiagnostics(diags, { onlyErrors = true, limit = 20 } = {}) {
  const sev = ['', 'ERROR', 'WARN', 'INFO', 'HINT'];
  const list = diags.filter((d) => !onlyErrors || d.severity === 1 || d.severity == null);
  const lines = list.slice(0, limit).map((d) => `${sev[d.severity || 1]} [${d.range.start.line + 1}:${d.range.start.character + 1}] ${String(d.message).split('\n')[0]}`);
  if (list.length > limit) lines.push(`... and ${list.length - limit} more`);
  return lines.join('\n');
}

/** Called after a file was written. Returns formatted errors, or '' (no server / no errors). */
async function diagnosticsAfterWrite(relPath, config) {
  try {
    const abs = path.join(getWorkDir(), relPath);
    const client = await clientFor(abs, config);
    if (!client) return '';
    const text = await fs.promises.readFile(abs, 'utf8');
    const first = !client.versions.has(pathToFileURL(abs).href);
    return formatDiagnostics(await client.touch(abs, text, first ? 6000 : 3000));
  } catch (e) { log.debug('lsp', 'diagnostics failed', e); return ''; }
}

function simplify(value) {
  if (Array.isArray(value)) return value.map(simplify);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'uri' || k === 'targetUri') out.file = rel(v);
      else if (k === 'kind' && typeof v === 'number') out.kind = KINDS[v] || v;
      else if (k === 'range' || k === 'targetRange' || k === 'selectionRange' || k === 'targetSelectionRange') {
        if (k === 'range' || k === 'targetSelectionRange') out.at = `${v.start.line + 1}:${v.start.character + 1}`;
      } else out[k] = simplify(v);
    }
    return out;
  }
  return value;
}

const OPS = ['goToDefinition', 'findReferences', 'hover', 'documentSymbol', 'workspaceSymbol', 'goToImplementation', 'diagnostics'];

async function operation(op, relPath, line, character, query, config) {
  if (!OPS.includes(op)) throw new Error(`unknown operation; use one of ${OPS.join(', ')}`);
  const abs = path.join(getWorkDir(), relPath || '');
  const client = await clientFor(abs, config);
  if (!client) throw new Error('No language server available for this file type (install one, e.g. typescript-language-server, pyright, gopls, rust-analyzer, clangd — or configure "lsp" in config.json).');
  const text = await fs.promises.readFile(abs, 'utf8');
  const uri = pathToFileURL(abs).href;
  const diags = await client.touch(abs, text, client.versions.has(uri) ? 1500 : 6000);
  if (op === 'diagnostics') return formatDiagnostics(diags, { onlyErrors: false, limit: 50 }) || 'No diagnostics.';
  const pos = { line: Math.max(0, (Number(line) || 1) - 1), character: Math.max(0, (Number(character) || 1) - 1) };
  const td = { uri };
  let result;
  switch (op) {
    case 'goToDefinition': result = await client.request('textDocument/definition', { textDocument: td, position: pos }); break;
    case 'goToImplementation': result = await client.request('textDocument/implementation', { textDocument: td, position: pos }); break;
    case 'findReferences': result = await client.request('textDocument/references', { textDocument: td, position: pos, context: { includeDeclaration: true } }); break;
    case 'hover': {
      const h = await client.request('textDocument/hover', { textDocument: td, position: pos });
      const c = h && h.contents;
      result = !c ? null : typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x.value)).join('\n') : c.value;
      break;
    }
    case 'documentSymbol': result = await client.request('textDocument/documentSymbol', { textDocument: td }); break;
    case 'workspaceSymbol': result = await client.request('workspace/symbol', { query: query || '' }); break;
  }
  if (result == null || (Array.isArray(result) && !result.length)) return `No results for ${op}.`;
  return typeof result === 'string' ? result : JSON.stringify(simplify(result), null, 1).slice(0, 60000);
}

function stop() {
  for (const p of clients.values()) p.then((c) => c && c.close()).catch(() => {});
  clients = new Map();
  broken = new Set();
  availCache = { dir: null, at: 0, value: false };
}
process.on('exit', () => { for (const p of clients.values()) p.then((c) => c && c.child && c.child.kill()).catch(() => {}); });

module.exports = { available, diagnosticsAfterWrite, operation, stop, OPS, formatDiagnostics };
