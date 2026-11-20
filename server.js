#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { spawn } = require('node:child_process');

const cfg = require('./lib/config');
const llm = require('./lib/llm');
const mcp = require('./lib/mcp');
const lsp = require('./lib/lsp');
const snapshot = require('./lib/snapshot');
const skills = require('./lib/skills');
const procs = require('./lib/procs');
const terminal = require('./lib/terminal');
const ws = require('./lib/workspace');
const sessions = require('./lib/sessions');
const agents = require('./lib/agents');
const autoMode = require('./lib/auto');
const plugins = require('./lib/plugins');
const sandbox = require('./lib/sandbox');
const { runAgent, compactSession, generateTitle, resolveConfig, contextSize } = require('./lib/agent');
const journal = require('./lib/journal');
const commands = require('./lib/commands');
const attach = require('./lib/attach');
const runtime = require('./lib/runtime');
const log = require('./lib/log');
const { statusFor, explain } = require('./lib/errors');
const { serveFile, downloadBlockedReason } = require('./lib/serve-file');
const { createWaker } = require('./lib/wake');
const recall = require('./lib/recall');
const { bus, TYPES } = require('./lib/events');
const { FleetManager } = require('./lib/agents');

// A bug in one request/tool must never take the whole studio (and a running agent) down: log it and keep serving.
let crashCount = 0;
process.on('uncaughtException', (err) => { crashCount++; log.error('process', 'uncaught exception', err); if (crashCount > 50) process.exit(1); });
process.on('unhandledRejection', (err) => { log.error('process', 'unhandled promise rejection', err instanceof Error ? err : new Error(String(err))); });
process.on('exit', () => { try { plugins.unload(); } catch { /* shutting down */ } });

/* ---------- CLI:  ollama-forge-studio [dir] [--port N] [--host H] [-c | --continue] [-s ID] [--agent NAME] ---------- */

function parseArgs(argv) {
  const o = { dir: null, port: Number(process.env.PORT || 4310), host: process.env.HOST || '127.0.0.1', cont: false, session: null, agent: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') o.port = Number(argv[++i]);
    else if (a === '--host') o.host = argv[++i];
    else if (a === '--dir' || a === '-d') o.dir = argv[++i];
    else if (a === '--continue' || a === '-c') o.cont = true;
    else if (a === '--session' || a === '-s') o.session = argv[++i];
    else if (a === '--agent') o.agent = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.log('usage: ollama-forge-studio [dir] [--port N] [--host H] [-c|--continue] [-s <session-id>] [--agent <name>]');
      process.exit(0);
    } else if (!a.startsWith('-') && !o.dir) o.dir = a;
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
const PUBLIC_DIR = cfg.APP_ROOT ? path.join(cfg.APP_ROOT, 'public') : null; // null in the single-executable build (assets are embedded)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
};

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(data);
}

function readBody(req, limit = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('request body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const send = (ext, data) => { res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' }); res.end(data); };
  const notFound = () => { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); };

  if (runtime.isSea()) {                       // single executable: files are embedded in the binary
    const key = path.posix.normalize(rel).replace(/^\/+/, '');
    if (key.startsWith('..')) { res.writeHead(403); return res.end('Forbidden'); }
    const data = runtime.getAsset(key);
    return data ? send(path.extname(key), data) : notFound();
  }

  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => (err ? notFound() : send(path.extname(filePath), data)));
}

/* ---------- run/permission bookkeeping ---------- */

const running = new Map();            // sessionId -> run { ac, events, subs, base }
const pendingPermissions = new Map(); // permissionId -> { resolve, reject, sessionId }
const pendingQuestions = new Map();   // questionId -> { resolve, sessionId }

/** Drop saved tool output older than 7 days. */
function pruneToolOutput() {
  const dir = path.join(cfg.studioDir(), 'tool-output');
  try {
    for (const n of fs.readdirSync(dir)) {
      const f = path.join(dir, n);
      if (Date.now() - fs.statSync(f).mtimeMs > 7 * 86400000) fs.rmSync(f, { force: true });
    }
  } catch (e) { if (e.code !== 'ENOENT') log.debug('server', 'tool-output cleanup failed', e); }
}

/** { ctx, used, tps } for a session (or a blank one when `session` is null) on `modelRef` (falls back to the configured model). */
async function contextInfo(modelRef, session) {
  const c = cfg.loadConfig();
  const ref = modelRef || (session && session.model) || c.model;
  let ctx = 0;
  try { ctx = (await resolveConfig(c, ref)).numCtx || 0; } catch (e) { log.debug('server', 'context window unknown (provider unreachable?)', e); }
  return { ctx, used: session ? contextSize(session) : 0, tps: (session && session.lastTps) || 0 };
}

const isTitled = () => false;
const agentInfo = (a) => ({ name: a.name, description: a.description || '', mode: a.mode, builtin: !!a.builtin, source: a.source || 'builtin' });

/* ---------- API ---------- */

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]

  if (pathname === '/api/state' && method === 'GET') {
    return sendJson(res, 200, {
      workDir: cfg.getWorkDir(),
      startup: startup,
      agents: agents.primaryAgents(cfg.loadConfig()).map(agentInfo),
      subagents: agents.subagents(cfg.loadConfig()).map(agentInfo),
      commands: Object.values(commands.loadCommands(cfg.loadConfig())).map((c) => ({ name: c.name, description: c.description })),
      skills: Object.values(skills.loadSkills(cfg.loadConfig())).map((x) => ({ name: x.name, description: x.description })),
      lsp: lsp.available(cfg.loadConfig()),
      terminal: cfg.loadConfig().terminal !== false,
      plugins: plugins.status(),
      sandbox: sandbox.status(cfg.loadConfig()),
    });
  }

  if (pathname === '/api/workdir' && method === 'POST') {
    if (running.size) throw new Error('stop running agents before changing directory');
    const body = await readBody(req);
    const dir = cfg.setWorkDir(body.dir);
    fleet.reset();
    mcp.stop(); lsp.stop(); procs.killAll();
    await plugins.reload(cfg.loadConfig());
    pruneToolOutput();
    if (cfg.loadConfig().snapshots !== false) snapshot.warmUp().catch(log.swallow('snapshot', 'warm-up failed'));
    return sendJson(res, 200, { workDir: dir, latest: await sessions.latest() });
  }

  if (pathname === '/api/config' && method === 'GET') return sendJson(res, 200, llm.maskConfig(cfg.loadConfig()));
  if (pathname === '/api/config' && (method === 'PUT' || method === 'POST')) {
    const patch = await readBody(req);
    const saved = cfg.saveConfig(patch);
    if (patch && (patch.plugins !== undefined || patch.hooks !== undefined || patch.sandbox !== undefined)) {
      await plugins.reload(saved);
      sandbox.reset();
    }
    recall.configure(saved);
    fleet.configure({ maxParallel: (saved.fleet || {}).maxParallel, maxChain: (saved.fleet || {}).maxChain });
    return sendJson(res, 200, llm.maskConfig(saved));
  }
  // context usage badge: window of the model + tokens used by the session (0 for a new session)
  if (pathname === '/api/context' && method === 'GET') {
    const sid = url.searchParams.get('session');
    return sendJson(res, 200, await contextInfo(url.searchParams.get('model'), sid ? await sessions.get(sid).catch(() => null) : null));
  }

  if (pathname === '/api/defaults' && method === 'GET') return sendJson(res, 200, cfg.DEFAULT_CONFIG);

  if (pathname === '/api/models' && method === 'GET') {
    const models = await llm.listAll(cfg.loadConfig());
    return sendJson(res, 200, { models, providers: Object.values(llm.providersOf(cfg.loadConfig())).map((p) => ({ id: p.id, type: p.type, endpoint: p.endpoint })) });
  }

  if (pathname === '/api/providers/test' && method === 'POST') {
    const b = await readBody(req);
    const saved = llm.providersOf(cfg.loadConfig())[b.id] || {};
    const key = typeof b.apiKey === 'string' && !b.apiKey.startsWith('••••') ? b.apiKey : saved.apiKey;
    const type = ['openai', 'anthropic'].includes(b.type) ? b.type : 'ollama';
    const models = await llm.listModels({ type, endpoint: b.endpoint, apiKey: key, headers: b.headers });
    return sendJson(res, 200, { ok: true, count: models.length, models: models.slice(0, 50).map((m) => m.name) });
  }

  if (pathname === '/api/processes' && method === 'GET') {
    const sid = url.searchParams.get('sessionId');
    return sendJson(res, 200, { processes: procs.list(), ...(sid ? { sessionRunning: running.has(sid) } : {}) });
  }
  if (seg[1] === 'processes' && seg.length === 3 && method === 'DELETE') return sendJson(res, 200, procs.kill(seg[2]));

  if (pathname === '/api/terminal' && method === 'GET') return sendJson(res, 200, { terminals: terminal.list() });
  if (pathname === '/api/terminal' && method === 'POST') {
    if (cfg.loadConfig().terminal === false) return sendJson(res, 403, { error: 'the terminal is disabled in the config' });
    const b = await readBody(req);
    return sendJson(res, 200, terminal.start(b.command, { config: cfg.loadConfig() }));
  }
  if (seg[1] === 'terminal' && seg.length === 3 && method === 'DELETE') return sendJson(res, 200, terminal.stop(seg[2]));
  if (seg[1] === 'terminal' && seg.length === 4 && seg[3] === 'stream' && method === 'GET') {
    const t = terminal.get(seg[2]);
    if (!t) return sendJson(res, 404, { error: 'no such terminal' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    sse(res, { type: 'start', id: t.id, command: t.command, cwd: t.cwd, pid: t.pid, running: t.running });
    for (const c of t.chunks) sse(res, { type: 'output', stream: c.stream, text: c.text, seq: c.seq });
    if (!t.running) {
      sse(res, { type: 'exit', code: t.exit_code, durationMs: t.elapsed_ms, killed: t.killed });
      return res.end();
    }
    const unsub = terminal.subscribe(t.id, (ev) => {
      sse(res, ev);
      if (ev.type === 'exit') { unsub(); try { res.end(); } catch { /* closed */ } }
    }) || (() => {});
    // the process may have exited between the snapshot above and subscribe(): close the race
    const now = terminal.get(t.id);
    if (now && !now.running) {
      sse(res, { type: 'exit', code: now.exit_code, durationMs: now.elapsed_ms, killed: now.killed });
      unsub();
      return res.end();
    }
    res.on('close', () => { if (unsub) unsub(); });
    return;
  }

  if (pathname === '/api/mcp' && method === 'GET') {
    await mcp.ensureStarted(cfg.loadConfig());
    return sendJson(res, 200, { servers: mcp.status() });
  }
  if (pathname === '/api/mcp/reload' && method === 'POST') return sendJson(res, 200, { servers: await mcp.reload(cfg.loadConfig()) });

  if (pathname === '/api/plugins' && method === 'GET') return sendJson(res, 200, plugins.status());
  if (pathname === '/api/plugins/reload' && method === 'POST') return sendJson(res, 200, await plugins.reload(cfg.loadConfig()));
  if (pathname === '/api/sandbox' && method === 'GET') return sendJson(res, 200, sandbox.status(cfg.loadConfig()));

  if (pathname === '/api/agents' && method === 'GET') {
    return sendJson(res, 200, { agents: Object.values(agents.loadAgents(cfg.loadConfig())).map(agentInfo) });
  }

  /* --- files in the working directory --- */
  // one directory level at a time (the UI expands folders lazily, so a huge folder never freezes anything)
  if (pathname === '/api/tree' && method === 'GET') {
    const dir = ws.safeResolve(url.searchParams.get('path') || '') && (url.searchParams.get('path') || '');
    const level = await ws.listDir(dir);
    return sendJson(res, 200, { workDir: cfg.getWorkDir(), ...level, tree: level.entries });
  }
  if (pathname === '/api/download' && (method === 'GET' || method === 'HEAD')) {
    const rel = url.searchParams.get('path') || '';
    const full = ws.safeResolve(rel);
    const st = await fsp.stat(full).catch(() => null);
    if (!st) throw new Error('not found');
    // never hand out a build output that a running process is still writing (partial / corrupt file)
    const blocked = downloadBlockedReason(rel, st, procs.list().some((p) => p.running));
    if (blocked) return sendJson(res, 409, { error: blocked, busy: true });
    if (st.isDirectory()) {
      const base = path.basename(full) || 'folder';
      const safeName = base.replace(/[^\w.-]+/g, '_') || 'folder';
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${safeName}.zip"` });
      if (method === 'HEAD') return res.end();
      const args = ['-r', '-q', '-', '.'];
      const proc = spawn('zip', args, { cwd: full, stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stdout.pipe(res);
      proc.stderr.on('data', () => {});
      proc.on('error', (e) => { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }); if (!res.writableEnded) res.end('zip failed: ' + e.message); });
      proc.on('close', (code) => { if (!res.writableEnded) { if (code !== 0 && !res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('zip failed'); } else if (res.writableEnded) {} else res.end(); } });
      res.on('close', () => { try { proc.kill('SIGKILL'); } catch { /* already finished */ } });   // client left: stop zipping
      return;
    }
    // regular file: Content-Length + Range (Pause/Resume), streamed from disk
    return serveFile(req, res, full, st, { filename: path.basename(full) });
  }
  if (pathname === '/api/logs' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(log.tail(Number(url.searchParams.get('lines')) || 200) + '\n');
  }
  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, node: process.version, workDir: cfg.getWorkDir(), studioDir: cfg.studioDir(), running: running.size, snapshots: snapshot.status() || 'on', uptime: Math.round(process.uptime()) });
  }
  if (pathname === '/api/file') {
    const rel = url.searchParams.get('path') || '';
    if (method === 'GET') return sendJson(res, 200, { path: rel, content: await ws.readFile(rel) });
    if (method === 'PUT') { const b = await readBody(req); return sendJson(res, 200, await ws.writeFile(b.path || rel, b.content)); }
    if (method === 'DELETE') return sendJson(res, 200, await ws.deleteFile(rel));
  }

  /* --- sessions --- */
  if (seg[1] === 'sessions') {
    if (seg.length === 2) {
      if (method === 'GET') return sendJson(res, 200, { sessions: (await sessions.list()).map((r) => ({ ...r, running: running.has(r.id) })) });
      if (method === 'POST') {
        const b = await readBody(req);
        const c = cfg.loadConfig();
        return sendJson(res, 201, await sessions.create({ agent: b.agent || c.agent || 'build', model: b.model || c.model, title: b.title || '' }));
      }
    }
    const id = seg[2];
    if (seg.length === 3) {
      if (method === 'GET') {
        const s = await sessions.get(id);
        // `history` = messages that were summarised out of the model's context: the chat still shows them unchanged (huge tool output is clipped for transport)
        const history = (await sessions.archiveRead(id, s.archived || 0)).map((m) => (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 20000 ? { ...m, content: m.content.slice(0, 20000) + '\n… (clipped in the chat view; /export has everything)' } : m));
        return sendJson(res, 200, { ...s, history, running: running.has(id), context: await contextInfo(s.model, s) });
      }
      if (method === 'DELETE') { running.get(id)?.ac.abort(); return sendJson(res, 200, await sessions.remove(id)); }
      if (method === 'PUT' || method === 'PATCH') {
        const b = await readBody(req);
        const s = await sessions.get(id);
        if (typeof b.title === 'string') s.title = b.title.slice(0, 120);
        if (typeof b.agent === 'string' && agents.getAgent(b.agent, cfg.loadConfig())) s.agent = b.agent;
        if (typeof b.model === 'string') s.model = b.model;
        await sessions.save(s);
        return sendJson(res, 200, sessions.summary(s));
      }
    }
    if (seg.length === 4 && seg[3] === 'fork' && method === 'POST') {
      const b = await readBody(req);
      return sendJson(res, 201, await sessions.fork(id, b.upTo));
    }
    if (seg.length === 4 && seg[3] === 'rewind' && method === 'POST') {          // drop a user message and everything after it (Edit / Resend)
      if (running.has(id)) throw new Error('session is running; stop it first');
      const b = await readBody(req);
      const s = await sessions.get(id);
      const i = Number(b.index);
      if (!Number.isInteger(i) || i < 0 || i >= s.messages.length || s.messages[i].role !== 'user' || s.messages[i].summary) throw new Error('can only rewind to one of your own messages');
      s.messages = s.messages.slice(0, i);
      s.lastPrompt = 0; s.lastCount = 0; s.revert = null; s.interrupted = false;
      await sessions.save(s);
      return sendJson(res, 200, { ok: true, messages: i });
    }
    if (seg.length === 5 && seg[3] === 'messages' && (method === 'PATCH' || method === 'PUT')) {   // edit an assistant reply in place
      if (running.has(id)) throw new Error('session is running; stop it first');
      const b = await readBody(req);
      const s = await sessions.get(id);
      const m = s.messages[parseInt(seg[4], 10)];
      if (!m || m.summary || m.role !== 'assistant' || typeof b.content !== 'string') throw new Error('only assistant replies can be edited in place');
      m.content = b.content;
      await sessions.save(s);
      return sendJson(res, 200, { ok: true });
    }
    if (seg.length === 4 && seg[3] === 'compact' && method === 'POST') {
      const c = cfg.loadConfig();
      const s = await sessions.get(id);
      const r = await compactSession({ session: s, model: s.model || c.model, config: c });
      return sendJson(res, 200, r);
    }
    if (seg.length === 4 && (seg[3] === 'undo' || seg[3] === 'redo') && method === 'POST') {
      if (running.has(id)) throw new Error('session is running; stop it first');
      const s = await sessions.get(id);
      const r = seg[3] === 'undo' ? await journal.undo(s) : await journal.redo(s);
      await sessions.save(s);
      return sendJson(res, 200, r);
    }
    if (seg.length === 4 && seg[3] === 'export' && method === 'GET') {
      const format = url.searchParams.get('format') === 'json' ? 'json' : 'md';
      if (format === 'json') return sendJson(res, 200, await sessions.exportTree(id), { 'Content-Disposition': `attachment; filename="${id}.json"` });
      const s = await sessions.get(id);
      const md = require('./lib/export').toMarkdown(s, await sessions.transcript(s));
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${id}.md"` });
      return res.end(md);
    }
    if (seg.length === 4 && seg[3] === 'summaries' && method === 'GET') {
      const s = await sessions.get(id);
      let list = s.summaries || [];
      if (!list.length) {   // sessions summarised before summaries were recorded: show the live one
        const live = s.messages.find((x) => x.summary && x.role === 'user');
        if (live) list = [{ n: 1, ts: s.updatedAt, text: live.content.replace(/^Summary of the earlier conversation:\n/, ''), covered: null, legacy: true }];
      }
      return sendJson(res, 200, { summaries: list, archived: s.archived || 0, compactions: s.compactions || 0 });
    }
  }

  if (pathname === '/api/upload' && method === 'POST') {
    const limit = (Number(cfg.loadConfig().maxUploadMB) || 500) * 1048576;
    return sendJson(res, 200, await attach.store(req, url.searchParams.get('name') || 'file', limit));
  }
  const up = pathname.match(/^\/api\/uploads\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
  if (up && method === 'GET') {
    const file = attach.fileOf(up[1]);
    const st = await fs.promises.stat(file).catch(() => null);
    if (!st) return sendJson(res, 404, { error: 'no such attachment' });
    const ext = attach.extOf(up[1]);
    const inlineImg = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext];
    res.writeHead(200, {
      'Content-Type': inlineImg || 'application/octet-stream', 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
      ...(inlineImg ? {} : { 'Content-Disposition': `attachment; filename="${up[1].slice(9)}"` }),   // never render uploaded html/svg from our origin
    });
    return fs.createReadStream(file).pipe(res);
  }

  if (pathname === '/api/permission' && method === 'POST') {
    const b = await readBody(req);
    const p = pendingPermissions.get(b.id);
    if (!p) throw new Error('no such pending permission');
    pendingPermissions.delete(b.id);
    p.resolve(['once', 'always'].includes(b.reply) ? b.reply : 'reject');
    if (running.get(p.sessionId)) publish(running.get(p.sessionId), { type: 'permission_resolved', id: b.id, reply: b.reply });
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/answer' && method === 'POST') {
    const b = await readBody(req);
    const q = pendingQuestions.get(b.id);
    if (!q) throw new Error('no such pending question');
    pendingQuestions.delete(b.id);
    q.resolve(String(b.answer ?? ''));
    if (running.get(q.sessionId)) publish(running.get(q.sessionId), { type: 'question_resolved', id: b.id, answer: String(b.answer ?? '') });
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/shutdown' && method === 'POST') {
    // refuse cross-site requests so a random web page can't stop the studio
    const origin = req.headers.origin;
    if (origin) { try { if (new URL(origin).host !== req.headers.host) return sendJson(res, 403, { error: 'forbidden' }); } catch { return sendJson(res, 403, { error: 'forbidden' }); } }
    sendJson(res, 200, { ok: true });
    console.log('shutdown requested from the UI');
    setTimeout(() => process.exit(0), 150);   // 'exit' hooks stop background processes, MCP and LSP children
    return;
  }

  if (pathname === '/api/abort' && method === 'POST') {
    const b = await readBody(req);
    running.get(b.sessionId)?.ac.abort();
    return sendJson(res, 200, { ok: true });
  }

  if (pathname.startsWith('/api/fleet/') || pathname.startsWith('/api/memory/') || pathname === '/api/events') { if (await handleDashboardApi(req, res, url)) return; }

  if (await plugins.handleRoute(req, res, url, { sendJson, readBody, config: cfg.loadConfig() })) return;

  return sendJson(res, 404, { error: 'not found' });
}

/* ---------- chat runs (SSE) ----------
   A run lives on the server, independent of the browser connection: if the tab is closed or the phone suspends the
   browser, the agent keeps working. Clients (re)attach with GET /api/sessions/:id/attach and get the whole run replayed. */

const sse = (res, ev) => {
  try { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch (e) { log.debug('server', 'client stream write failed', e); }
};

function publish(run, ev) {
  const last = run.events[run.events.length - 1];
  if (last && (ev.type === 'token' || ev.type === 'thinking') && last.type === ev.type) last.text += ev.text; // coalesce for replay
  else run.events.push({ ...ev });
  if (run.events.length > 30000) run.events.splice(0, 5000);
  for (const r of run.subs) sse(r, ev);
}

function subscribe(run, res, { attach }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  if (attach) {
    sse(res, { type: 'attach', sessionId: run.id, messages: run.base || [] });
    for (const ev of run.events) sse(res, ev);
  }
  run.subs.add(res);
  res.on('close', () => run.subs.delete(res));
}

async function handleAttach(res, id) {
  const run = running.get(id);
  if (!run) return sendJson(res, 404, { error: 'not running' });
  subscribe(run, res, { attach: true });
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const config = cfg.loadConfig();
  const text = String(body.text || '').trim();
  const att = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 12).map((a) => ({ id: String(a.id || ''), name: String(a.name || a.id || '') }));
  for (const a of att) { try { if (!fs.existsSync(attach.fileOf(a.id))) throw new Error('missing'); } catch { return sendJson(res, 400, { error: `attachment not found: ${a.name || a.id}` }); } }
  if (!text && !att.length) return sendJson(res, 400, { error: 'empty message' });

  if (body.sessionId && running.has(body.sessionId)) {
    if (!body.interrupt) return sendJson(res, 409, { error: 'this session is still running — press Stop first (or it will be attached automatically)', running: true });
    running.get(body.sessionId).ac.abort();
    for (let i = 0; i < 60 && running.has(body.sessionId); i++) await new Promise((r) => setTimeout(r, 100));
    if (running.has(body.sessionId)) return sendJson(res, 409, { error: 'could not stop the running session', running: true });
  }

  const session = body.sessionId ? await sessions.get(body.sessionId) : await sessions.create({ agent: body.agent || config.agent, model: body.model || config.model });
  if (body.agent && agents.getAgent(body.agent, config)) session.agent = body.agent;
  if (body.model) session.model = body.model;
  const model = session.model || config.model;
  if (!model) return sendJson(res, 400, { error: 'no model selected' });
  let agent = agents.resolve(session, config) || agents.getAgent('build', config);     // "auto" runs as the agent it picked last (re-picked below)
  if (agent.mode === 'subagent') return sendJson(res, 400, { error: `"${agent.name}" is a subagent; pick a primary agent` });

  waker.onUserMessage(session.id);
  launchRun({ session, config, agent, model, text, att, res });
}

/**
 * Start an agent run on a session. `res` = the SSE response of the browser that sent the message (null for a
 * wake-up turn started by the studio itself: the browser then attaches via /api/sessions/:id/attach).
 */
function launchRun({ session, config, agent, model, text, att, res, wake = false, wakeDisplay }) {
  const run = { id: session.id, ac: new AbortController(), events: [], subs: new Set(), base: null };
  running.set(session.id, run);
  if (res) subscribe(run, res, { attach: false });
  const emit = (ev) => publish(run, ev);
  const myPermissions = new Set();
  const myQuestions = new Set();
  const askPermission = ({ tool, category, summary }) => new Promise((resolve, reject) => {
    const id = 'perm_' + crypto.randomBytes(4).toString('hex');
    myPermissions.add(id);
    pendingPermissions.set(id, { resolve, reject, sessionId: session.id });
    run.ac.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    emit({ type: 'permission_request', id, tool, category, summary });
  });
  const askUser = ({ question, options }) => new Promise((resolve, reject) => {
    const id = 'q_' + crypto.randomBytes(4).toString('hex');
    myQuestions.add(id);
    pendingQuestions.set(id, { resolve, sessionId: session.id });
    run.ac.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    emit({ type: 'question', id, question, options });
  });
  const heartbeat = setInterval(() => { for (const r of run.subs) { try { if (!r.writableEnded) r.write(': keepalive\n\n'); } catch (e) { log.debug('server', 'keepalive failed', e); } } }, 15000);

  // How this run ended — announced on the event bus once the run is fully over (see `finally`), so listeners (fleets) can start the next one.
  const lifecycle = { outcome: 'done', agent: agent.name, final: '', iterations: 0, truncated: false, error: '' };

  // The run continues even if every client disconnects.
  (async () => {
    try {
      if (!session.title) { session.title = (text || (att[0] && att[0].name) || 'attachment').replace(/\s+/g, ' ').slice(0, 60); session.autoTitle = !!text; }
      let content = text;
      let commandPickedAgent = false;
      let display = wake ? wakeDisplay : undefined;
      let attachments;
      const exp = text && !wake ? await commands.expand(text, config) : null;
      if (exp) {
        content = exp.text; display = text;
        if (exp.command.agent) {
          const ag = agents.getAgent(exp.command.agent, config);
          if (ag && ag.mode !== 'subagent' && !ag.virtual) {
            if (agents.isAuto(session.agent)) session.autoAgent = ag.name;   // stay in auto mode; the command just picks this turn's agent
            else session.agent = ag.name;
            agent = ag; commandPickedAgent = true;
          }
        }
      }
      if (att.length) {
        emit({ type: 'info', text: `📎 reading ${att.length} attachment${att.length > 1 ? 's' : ''}…` });
        const prep = await attach.prepare({ items: att, config, model, signal: run.ac.signal, emit });
        content = (content ? content + '\n\n' : '') + prep.blocks;
        attachments = prep.attachments;
        if (display === undefined) display = text;     // the chat shows what was typed + chips, not the extracted file text
      }
      session.turn = (session.turn || 0) + 1;
      session.revert = null; // a new message discards any pending redo
      session.messages.push({ role: 'user', content, turn: session.turn, ...(wake ? { notice: true } : {}), ...(display !== undefined ? { display } : {}), ...(attachments ? { attachments } : {}) });
      await sessions.save(session);
      run.base = session.messages.slice();     // shallow copy is enough (and instant): messages are replaced, not mutated, for the replay
      // auto mode: choose the agent for this message (a wake-up turn or a command with its own agent keeps the current one)
      const auto = agents.isAuto(session.agent);
      const before = agent.name;
      if (auto && !wake && !commandPickedAgent) agent = await autoMode.route({ session, text: content, config, model, signal: run.ac.signal });
      emit({ type: 'start', sessionId: session.id, title: session.title, agent: agent.name, auto, model, workDir: cfg.getWorkDir() });
      lifecycle.agent = agent.name;
      bus.emit(TYPES.AGENT_STARTED, { sessionId: session.id, agent: agent.name, model, isChild: false });
      if (auto && agent.name !== before) emit({ type: 'agent', name: agent.name, auto: true, from: before, reason: '' });
      session.snaps = session.snaps || {};
      const snapOn = config.snapshots !== false;
      const snapOpts = { timeoutSec: Number(config.snapshotTimeoutSec) || 25 };
      const startSnap = snapOn ? await snapshot.track(snapOpts) : null;
      if (startSnap) session.snaps[session.turn] = startSnap;
      else if (snapOn && snapshot.status() && !session.snapNoteShown) { session.snapNoteShown = true; emit({ type: 'info', text: `ℹ ${snapshot.status()}` }); }
      const result = await runAgent({ session, root: session, agent, model, config, emit, signal: run.ac.signal, askPermission, askUser, canPrompt: () => run.subs.size > 0 });
      if (startSnap) {
        const files = await snapshot.diff(startSnap, await snapshot.track(snapOpts));
        if (files.length) emit({ type: 'changes', files });
      }
      if (session.autoTitle) {
        const t = await generateTitle({ session, model, config, signal: run.ac.signal });
        if (t) { session.title = t; emit({ type: 'title', title: t }); }
        session.autoTitle = false;
      }
      lifecycle.final = result.final ? String(result.final) : ''; lifecycle.iterations = result.iterations; lifecycle.truncated = !!result.truncated;
      emit({ type: 'done', iterations: result.iterations, truncated: !!result.truncated, usage: session.usage || null });
    } catch (err) {
      if (run.ac.signal.aborted) { lifecycle.outcome = 'aborted'; session.interrupted = true; emit({ type: 'aborted' }); }
      else { lifecycle.outcome = 'failed'; lifecycle.error = String(err && err.message ? err.message : err); emit({ type: 'error', message: lifecycle.error }); }
    } finally {
      clearInterval(heartbeat);
      for (const id of myPermissions) pendingPermissions.delete(id);
      for (const id of myQuestions) pendingQuestions.delete(id);
      try { await sessions.save(session); } catch (e) { log.error('server', `could not save session ${session.id} at the end of the run`, e); emit({ type: 'warning', message: `Could not save the session: ${e.message}` }); }
      running.delete(session.id);
      for (const r of run.subs) if (!r.writableEnded) r.end();
      waker.onRunEnd(session.id);   // a background process may have finished while this run was busy
      const base = { sessionId: session.id, agent: lifecycle.agent, isChild: false };
      if (lifecycle.outcome === 'done') bus.emit(TYPES.AGENT_FINISHED, { ...base, ok: true, final: lifecycle.final.slice(0, 4000), iterations: lifecycle.iterations, truncated: lifecycle.truncated });
      else if (lifecycle.outcome === 'aborted') bus.emit(TYPES.AGENT_ABORTED, base);
      else bus.emit(TYPES.AGENT_FAILED, { ...base, error: lifecycle.error.slice(0, 300) });
    }
  })();
  return run;
}

/* ---------- wake-up when a background process finishes ---------- */

/** Start a turn on `sessionId` whose first message is the studio's notification (see lib/wake.js). false = busy, try later. */
async function startWakeRun(sessionId, notice) {
  if (running.has(sessionId)) return false;
  const config = cfg.loadConfig();
  const session = await sessions.get(sessionId);
  if (running.has(sessionId)) return false;           // a user message won the race while the session was loading
  const model = session.model || config.model;
  if (!model) throw new Error('no model selected');
  const agent = agents.resolve(session, config) || agents.getAgent('build', config);
  if (!agent || agent.mode === 'subagent') throw new Error('no primary agent for this session');
  launchRun({ session, config, agent, model, text: notice.text, att: [], res: null, wake: true, wakeDisplay: notice.display });
  return true;
}

const waker = createWaker({
  events: procs.events,
  isRunning: (id) => running.has(id),
  isSeen: (id) => procs.isSeen(id),
  enabled: () => cfg.loadConfig().wakeOnProcessExit !== false,
  start: startWakeRun,
});

/* ---------- fleets (groups of agents) + dashboard API: lib/fleet.js, lib/events.js, lib/recall.js ---------- */

const fleet = new FleetManager({ file: () => path.join(cfg.studioDir(), 'fleets.json') }).attach();

const isWaiting = (sid) => { for (const p of pendingPermissions.values()) if (p.sessionId === sid) return true; for (const q of pendingQuestions.values()) if (q.sessionId === sid) return true; return false; };

/** Start one fleet task as a normal run on the member's session (no browser attached; the Fleet tab or /attach can watch it). */
async function startFleetRun(sessionId, text) {
  if (running.has(sessionId)) return false;
  const config = cfg.loadConfig();
  const session = await sessions.get(sessionId);
  if (running.has(sessionId)) return false;
  const model = session.model || config.model;
  if (!model) throw new Error('no model selected — pick a model in the top bar first');
  const agent = agents.resolve(session, config) || agents.getAgent('build', config);
  if (!agent || agent.mode === 'subagent') throw new Error('no primary agent for this session');
  waker.onUserMessage(session.id);
  launchRun({ session, config, agent, model, text, att: [], res: null, wake: false });
  return true;
}

async function createFleetSession({ agent, model, title }) {
  const config = cfg.loadConfig();
  const a = agents.getAgent(agent || config.agent, config);
  if (!a || a.mode === 'subagent') { const e = new Error(`"${agent}" is not a primary agent`); e.status = 400; throw e; }
  return sessions.create({ agent: a.name, model: model || config.model, title: title || `${a.name} (fleet)` });
}

{
  const c0 = cfg.loadConfig().fleet || {};
  fleet.configure({ start: startFleetRun, createSession: createFleetSession, isRunning: (id) => running.has(id), isWaiting, maxParallel: c0.maxParallel, maxChain: c0.maxChain });
}

/** Fleet status joined with live session data (title, message count, running flag). */
async function fleetStatus() {
  const st = fleet.status();
  const rows = new Map((await sessions.list({ includeChildren: true })).map((r) => [r.id, r]));
  for (const f of st.fleets) for (const m of f.members) {
    const r = rows.get(m.sessionId);
    m.title = (r && r.title) || m.title; m.messageCount = r ? r.messageCount : 0; m.live = running.has(m.sessionId); m.missing = !r;
    if (r && r.model) m.model = r.model;
  }
  return st;
}

/** Give every idle member of the fleet the model the user picked (handoff targets included, so A -> B never runs on an old model). */
async function applyFleetModel(fleetId, model) {
  const f = fleet.status().fleets.find((x) => x.id === fleetId);
  if (!f) return;
  for (const m of f.members) {
    if (running.has(m.sessionId)) continue;
    try { const s = await sessions.get(m.sessionId); if (s.model !== model) { s.model = model; await sessions.save(s); } }
    catch (e) { log.debug('server', `could not set the model of fleet member ${m.sessionId}`, e); }
  }
}

const wantFleet = (b) => { if (!b.fleetId) { const e = new Error('fleetId is required'); e.status = 400; throw e; } return b.fleetId; };

/** /api/events (live SSE), /api/fleet/*, /api/memory/*. Returns true when the request was handled. */
async function handleDashboardApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/events' && method === 'GET') {
    const types = (url.searchParams.get('types') || '').split(',').filter(Boolean);
    const last = Number(req.headers['last-event-id'] || url.searchParams.get('since') || 0) || 0;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (ev) => { try { if (!res.writableEnded && !res.destroyed) res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`); } catch (e) { log.debug('server', 'event stream write failed', e); } };
    res.write(': connected\n\n');
    for (const ev of bus.since(last, types.length ? types : null)) send(ev);
    const off = bus.on('*', (ev) => { if (!types.length || types.includes(ev.type)) send(ev); });
    const beat = setInterval(() => { try { if (!res.writableEnded) res.write(': keepalive\n\n'); } catch (e) { log.debug('server', 'event keepalive failed', e); } }, 15000);
    res.on('close', () => { off(); clearInterval(beat); });
    return true;
  }

  if (pathname === '/api/fleet/status' && method === 'GET') { sendJson(res, 200, await fleetStatus()); return true; }

  if (pathname === '/api/fleet/create' && method === 'POST') {
    const b = await readBody(req);
    const f = await fleet.create({ name: b.name, members: (Array.isArray(b.members) ? b.members : []).slice(0, 20) });
    sendJson(res, 200, { fleet: f });
    return true;
  }
  if (pathname === '/api/fleet/member' && method === 'POST') {
    const b = await readBody(req);
    sendJson(res, 200, { member: await fleet.addMember(wantFleet(b), { agent: b.agent || undefined, model: b.model || '', title: b.title || '', sessionId: b.sessionId || '' }) });
    return true;
  }
  if (pathname === '/api/fleet/remove' && method === 'POST') {
    const b = await readBody(req);
    if (b.sessionId) { running.get(b.sessionId)?.ac.abort(); fleet.removeMember(wantFleet(b), b.sessionId); }
    else { for (const id of fleet.removeFleet(wantFleet(b))) running.get(id)?.ac.abort(); }
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (pathname === '/api/fleet/dispatch' && method === 'POST') {
    const b = await readBody(req);
    if (!cfg.loadConfig().model && !b.model) { const e = new Error('no model selected — pick a model in the top bar first'); e.status = 400; throw e; }
    const fid = wantFleet(b);
    if (b.model) await applyFleetModel(fid, String(b.model));   // like /api/chat: the model picked in the top bar wins over a stale saved one
    sendJson(res, 200, { results: await fleet.dispatch(fid, { member: b.member || 'all', task: b.task }) });
    return true;
  }
  if (pathname === '/api/fleet/link' && method === 'POST') {
    const b = await readBody(req);
    sendJson(res, 200, { link: fleet.link(wantFleet(b), { from: b.from, to: b.to, on: b.on, template: b.template }) });
    return true;
  }
  if (pathname === '/api/fleet/unlink' && method === 'POST') {
    const b = await readBody(req);
    fleet.unlink(wantFleet(b), b.linkId);
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (pathname === '/api/fleet/stop' && method === 'POST') {
    const b = await readBody(req);
    const queued = fleet.cancelQueued(b.sessionId);
    const live = running.get(b.sessionId);
    if (live) live.ac.abort();
    sendJson(res, 200, { ok: true, stopped: queued || !!live });
    return true;
  }

  if (pathname === '/api/memory/status' && method === 'GET') {
    recall.configure(cfg.loadConfig());
    sendJson(res, 200, recall.stats());
    return true;
  }
  if (pathname === '/api/memory/search' && method === 'GET') {
    const q = String(url.searchParams.get('q') || '').trim();
    if (!q) { sendJson(res, 200, { hits: [] }); return true; }
    recall.configure(cfg.loadConfig());
    const sid = url.searchParams.get('scope') === 'session' ? url.searchParams.get('session') : null;
    const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit')) || 10));
    sendJson(res, 200, { hits: await recall.searchHybrid(q, { limit, sid, maxChars: 700 }), semantic: recall.stats().semantic.enabled });
    return true;
  }
  if (pathname === '/api/memory/recent' && method === 'GET') {
    const sid = url.searchParams.get('scope') === 'session' ? url.searchParams.get('session') : null;
    sendJson(res, 200, { hits: recall.recent({ limit: Math.min(50, Number(url.searchParams.get('limit')) || 15), sid }) });
    return true;
  }
  if (pathname === '/api/memory/context' && method === 'GET') {
    const id = url.searchParams.get('session');
    if (!id) { sendJson(res, 200, { session: null }); return true; }
    const s = await sessions.get(id);
    const info = await contextInfo(s.model, s);
    sendJson(res, 200, {
      session: {
        id: s.id, title: s.title || '(untitled)', agent: s.agent, model: s.model, ...info, pct: info.ctx ? Math.min(999, Math.round((info.used / info.ctx) * 100)) : 0,
        messages: s.messages.length, archived: s.archived || 0, compactions: s.compactions || 0, todos: (s.todos || []).length,
        summaries: (s.summaries || []).map((x) => ({ n: x.n, ts: x.ts, covered: x.covered, preview: String(x.text || '').slice(0, 400) })),
        lastRecall: s.lastRecall || null,
      },
    });
    return true;
  }
  if (pathname === '/api/memory/reindex' && method === 'POST') {
    const config = cfg.loadConfig();
    recall.configure(config);
    require('./lib/embed').resetBackoff();
    for (const s of await sessions.all()) recall.indexSession(s);
    recall.pump().catch(log.swallow('recall', 'embedding backfill failed'));
    sendJson(res, 200, recall.stats());
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
    const att = url.pathname.match(/^\/api\/sessions\/(ses_[a-z0-9]+)\/attach$/);
    if (att && req.method === 'GET') return await handleAttach(res, att[1]);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = statusFor(err);
    if (status >= 500) log.error('http', `${req.method} ${url.pathname} failed`, err); else log.debug('http', `${req.method} ${url.pathname} -> ${status}`, err);
    try {
      if (!res.headersSent) sendJson(res, status, { error: explain(err) });
      else if (!res.writableEnded) res.end();
    } catch (e) { log.debug('http', 'could not send the error response', e); }
  }
});
server.on('clientError', (err, socket) => { try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); else socket.destroy(); } catch { /* socket already gone */ } });

/* ---------- boot: pick directory, resolve session to resume, listen (auto-bump port) ---------- */

const startup = { sessionId: null, agent: args.agent || null };

(async () => {
  let workDir;
  try { workDir = cfg.setWorkDir(args.dir || process.cwd()); } catch (e) { console.error(`cannot open the directory: ${e.message}`); log.error('boot', 'setWorkDir failed', e); process.exit(1); }
  pruneToolOutput();
  recall.configure(cfg.loadConfig());
  await plugins.load(cfg.loadConfig());
  if (args.session) startup.sessionId = args.session;
  else if (args.cont) { try { startup.sessionId = (await sessions.latest())?.id || null; } catch (e) { log.warn('boot', 'could not find the latest session to continue', e); } }

  let port = args.port;
  const tryListen = (attempt) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && attempt < 20) { port++; tryListen(attempt + 1); }
      else { console.error(`cannot start the server on ${args.host}:${port}: ${e.code === 'EADDRINUSE' ? 'no free port found' : e.message}`); log.error('server', 'listen failed', e); process.exit(1); }
    });
    server.listen(port, args.host, () => {
      if (cfg.loadConfig().snapshots !== false) snapshot.warmUp().catch(log.swallow('boot', 'snapshot warm-up failed'));   // background: never delays a message
      console.log(`ollama-forge-studio  dir: ${workDir}`);
      console.log(`               url: http://${args.host}:${server.address().port}${startup.sessionId ? `   (resuming ${startup.sessionId})` : ''}`);
    });
  };
  tryListen(0);
})();
