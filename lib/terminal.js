'use strict';

// Direct terminal for the user (not the agent): run a shell command in the working directory and
// stream stdout/stderr live over SSE. Each command is a fresh shell process; stdin is closed.
// This is deliberately separate from lib/procs.js, which tracks the agent's background jobs.

const { spawn, execFile } = require('node:child_process');
const { getWorkDir } = require('./config');
const log = require('./log');

const win = process.platform === 'win32';
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const terminals = new Map();
let seq = 0;
const MAX_RUNNING = 10;
const MAX_BUFFER = 500 * 1024;          // characters kept for reattach / replay
const KEEP_FINISHED_MS = 10 * 60 * 1000;

function spawnShell(command) {
  return win
    ? spawn('cmd.exe', ['/c', command], { cwd: getWorkDir(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('bash', ['-c', command], { cwd: getWorkDir(), env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function killTree(child) {
  try {
    if (win) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

function view(t, withChunks = false) {
  return {
    id: t.id, command: t.command, cwd: t.cwd, pid: t.pid,
    running: !t.done, exit_code: t.exited, killed: t.killed,
    started_at: t.startedAt, elapsed_ms: (t.done ? t.endedAt : Date.now()) - t.startedAt,
    ...(withChunks ? { chunks: t.chunks.slice() } : {}),
  };
}

function emit(t, ev) {
  for (const fn of t.listeners) { try { fn(ev); } catch (e) { log.debug('terminal', 'listener failed', e); } }
}

function start(command) {
  for (const [id, t] of terminals) if (t.done && Date.now() - t.endedAt > KEEP_FINISHED_MS) terminals.delete(id);
  if ([...terminals.values()].filter((t) => !t.done).length >= MAX_RUNNING) throw new Error(`too many running terminals (max ${MAX_RUNNING}); stop one first`);
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('command is required');
  if (cmd.length > 10000) throw new Error('command is too long');

  const child = spawnShell(cmd);
  const t = {
    id: 'term_' + (++seq), command: cmd, cwd: getWorkDir(), pid: child.pid,
    startedAt: Date.now(), endedAt: 0, done: false, exited: null, killed: false,
    chunks: [], size: 0, chunkSeq: 0, listeners: new Set(), child,
  };

  const push = (stream, d) => {
    const text = d.toString().replace(ANSI, '');
    if (!text) return;
    t.chunks.push({ stream, text, seq: ++t.chunkSeq });
    t.size += text.length;
    while (t.size > MAX_BUFFER && t.chunks.length) {
      const c = t.chunks[0];
      const over = t.size - MAX_BUFFER;
      if (c.text.length <= over) { t.chunks.shift(); t.size -= c.text.length; }
      else { c.text = c.text.slice(over); t.size -= over; }
    }
    emit(t, { type: 'output', stream, text, seq: t.chunkSeq });
  };
  const finish = (code) => {
    if (t.done) return;
    t.done = true;
    t.exited = code;
    t.endedAt = Date.now();
    emit(t, { type: 'exit', code, durationMs: t.endedAt - t.startedAt, killed: t.killed });
    t.listeners.clear();
  };

  child.stdout.on('data', (d) => push('stdout', d));
  child.stderr.on('data', (d) => push('stderr', d));
  child.on('error', (e) => {
    const text = 'spawn error: ' + e.message + '\n';
    t.chunks.push({ stream: 'stderr', text, seq: ++t.chunkSeq });
    t.size += text.length;
    emit(t, { type: 'output', stream: 'stderr', text, seq: t.chunkSeq });
    finish(-1);
  });
  child.on('exit', (code) => finish(code));
  terminals.set(t.id, t);
  return view(t);
}

function get(id) {
  const t = terminals.get(id);
  return t ? view(t, true) : null;
}

function subscribe(id, fn) {
  const t = terminals.get(id);
  if (!t) return null;
  t.listeners.add(fn);
  return () => t.listeners.delete(fn);
}

function stop(id) {
  const t = terminals.get(id);
  if (!t) throw new Error(`no such terminal: ${id}`);
  if (!t.done) { t.killed = true; killTree(t.child); }
  return view(t);
}

function list() { return [...terminals.values()].map((t) => view(t)); }

function killAll() { for (const t of terminals.values()) if (!t.done) { t.killed = true; killTree(t.child); } terminals.clear(); }
process.on('exit', killAll);

// drop the buffers of finished terminals even if no new command is started
const cleanup = setInterval(() => {
  for (const [id, t] of terminals) if (t.done && Date.now() - t.endedAt > KEEP_FINISHED_MS) terminals.delete(id);
}, 60 * 1000);
cleanup.unref();

module.exports = { start, get, list, subscribe, stop, killAll };
