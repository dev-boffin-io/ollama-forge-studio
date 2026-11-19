'use strict';

// Process management for the bash tool:
//  - foreground commands: stdin closed, killed as a whole PROCESS GROUP on timeout/abort (so servers started by the
//    command die with it and the run can never hang on an inherited pipe);
//  - background commands (servers, watchers): tracked, output buffered, listable and killable (tool + UI).

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const { getWorkDir, studioDir } = require('./config');
const sandbox = require('./sandbox');
const log = require('./log');

const win = process.platform === 'win32';
const procs = new Map();
let seq = 0;

// Emits 'exit' ({ id, sessionId, command, exitCode, killed, durationMs, tail, logFile }) when a background process ends.
// The studio listens to it to tell the UI and to wake the agent (lib/wake.js) — no polling by the model.
const events = new EventEmitter();
events.setMaxListeners(50);

const MAX_LOG_BYTES = 30 * 1024 * 1024;     // per process log file
const LOG_KEEP_MS = 7 * 24 * 3600 * 1000;    // old logs are removed on the next start

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function killTree(child) {
  if (child && child.__ofsContainer) sandbox.cleanup(child.__ofsContainer, child.__ofsSandboxConfig);
  try {
    if (win) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

// `interactive`: keep stdin open as a pipe so the `process` tool can send input later (prompts, REPLs, scaffolders).
// Default stays 'ignore' (EOF immediately) so ordinary commands never block waiting for input. The Docker sandbox already runs `-i`.
function spawnShell(command, config, { interactive = false } = {}) {
  const stdin = interactive ? 'pipe' : 'ignore';
  const spec = sandbox.spawnSpec(command, config);
  if (spec) {
    const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: process.env, detached: !win, stdio: [stdin, 'pipe', 'pipe'] });
    child.__ofsContainer = spec.container;
    child.__ofsSandboxConfig = config;
    return child;
  }
  return win
    ? spawn('cmd.exe', ['/c', command], { cwd: getWorkDir(), env: process.env, stdio: [stdin, 'pipe', 'pipe'] })
    : spawn('bash', ['-c', command], { cwd: getWorkDir(), env: process.env, detached: true, stdio: [stdin, 'pipe', 'pipe'] });
}

function runForeground(command, timeoutMs, signal, config) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnShell(command, config); } catch (e) {
      return resolve({ output: 'sandbox error: ' + (e && e.message ? e.message : e), exit_code: -1 });
    }
    let out = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const add = (d) => { if (out.length < 4000000) out += d.toString(); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (child && child.__ofsContainer) sandbox.cleanup(child.__ofsContainer, child.__ofsSandboxConfig);
      resolve({ output: out, ...extra });
    };
    const kill = () => { killTree(child); setTimeout(() => finish({ exit_code: null }), 1000); };
    const onAbort = () => { aborted = true; kill(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    child.on('error', (e) => finish({ exit_code: -1, output: 'spawn error: ' + e.message }));
    // 'exit' (not 'close'): a daemon holding our pipes open must not block the tool
    child.on('exit', (code) => setTimeout(() => finish({
      exit_code: code, timed_out: timedOut || undefined, aborted: aborted || undefined,
      ...(timedOut ? { hint: 'Command timed out and was killed. For servers, watchers, builds or anything long-running, call bash again with background=true, tell the user, and end your turn: the studio notifies you when it finishes.' } : {}),
    }), 150));
  });
}

/** Best-effort progress from build output: Gradle "> Task :app:x", "45%", ninja/make "[12/345]". No model involved. */
function trackProgress(rec, chunk) {
  const text = (rec.carry + chunk).replace(ANSI, '');
  const lines = text.split(/[\r\n]+/);
  rec.carry = lines.pop().slice(-500);       // an unfinished last line waits for the next chunk
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    rec.lastLine = line.slice(0, 300);
    const task = /^>\s*Task\s+(\S+)/.exec(line);
    if (task) { rec.progress.task = task[1]; rec.progress.tasks = (rec.progress.tasks || 0) + 1; }
    const pct = [...line.matchAll(/(?:^|[^\d.])(\d{1,3})%/g)].pop();
    if (pct && Number(pct[1]) <= 100) rec.progress.percent = Number(pct[1]);
    const step = /\[(\d+)\/(\d+)\]/.exec(line);
    if (step && Number(step[2]) > 0) rec.progress.percent = Math.min(100, Math.round((Number(step[1]) / Number(step[2])) * 100));
  }
}

function openLog(rec) {
  try {
    const dir = path.join(studioDir(), 'jobs');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {   // housekeeping: drop logs older than a week
      try { const fp = path.join(dir, f); if (Date.now() - fs.statSync(fp).mtimeMs > LOG_KEEP_MS) fs.unlinkSync(fp); } catch { /* ignore */ }
    }
    rec.logFile = path.join(dir, `${rec.id}-${rec.startedAt}.log`);
    rec.logStream = fs.createWriteStream(rec.logFile, { flags: 'a' });
    rec.logStream.on('error', (e) => { log.debug('procs', 'job log write failed', e); rec.logStream = null; });
    rec.logStream.write(`$ ${rec.command}\n`);
  } catch (e) { log.debug('procs', 'could not create the job log', e); rec.logStream = null; }
}

/** Mark a background process finished exactly once and tell everyone who cares. */
function finishBackground(rec, code, spawnError) {
  if (rec.finished) return;
  rec.finished = true;
  rec.exited = code == null ? -1 : code;
  rec.endedAt = Date.now();
  if (spawnError) rec.output += 'spawn error: ' + spawnError.message;
  if (rec.logStream) { try { rec.logStream.end(`\n[exit ${rec.exited}]\n`); } catch { /* ignore */ } rec.logStream = null; }
  if (rec.container) sandbox.cleanup(rec.container, rec.sandboxConfig);
  // small delay: the last chunk of output may still be in the pipe when 'exit' fires
  setTimeout(() => {
    if (rec.carry) trackProgress(rec, '\n');
    const tail = rec.output.replace(ANSI, '').split(/\r?\n/).filter((l) => l.trim()).slice(-40).join('\n').slice(-3500);
    try {
      events.emit('exit', {
        id: rec.id, sessionId: rec.sessionId, command: rec.command, exitCode: rec.exited, killed: rec.killed,
        startedAt: rec.startedAt, endedAt: rec.endedAt, durationMs: rec.endedAt - rec.startedAt, tail, logFile: rec.logFile || null,
      });
    } catch (e) { log.warn('procs', 'a listener of the process-exit event failed', e); }
  }, 250);
}

async function startBackground(command, { sessionId = null, config = null, interactive = false } = {}) {
  for (const [id, p] of procs) if (p.exited !== null && Date.now() - p.endedAt > 600000) procs.delete(id);
  if ([...procs.values()].filter((p) => p.exited === null).length >= 20) throw new Error('too many background processes (max 20); kill some first');
  const child = spawnShell(command, config, { interactive });
  if (interactive && child.stdin) child.stdin.on('error', () => { /* process ended or closed its stdin */ });
  const rec = {
    id: 'proc_' + (++seq), pid: child.pid, command, sessionId, startedAt: Date.now(), output: '', exited: null, endedAt: 0, child,
    container: child.__ofsContainer || null, sandboxConfig: config,
    interactive: !!interactive, carry: '', lastLine: '', progress: {}, killed: false, seen: false, finished: false, logFile: null, logStream: null,
  };
  openLog(rec);
  let logged = 0;
  const add = (d) => {
    const str = d.toString();
    rec.output = (rec.output + str).slice(-200000);
    trackProgress(rec, str);
    if (rec.logStream && logged < MAX_LOG_BYTES) { logged += d.length; rec.logStream.write(d); if (logged >= MAX_LOG_BYTES) rec.logStream.write('\n[log truncated: size limit]\n'); }
  };
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  child.on('error', (e) => finishBackground(rec, -1, e));
  child.on('exit', (code) => finishBackground(rec, code));
  procs.set(rec.id, rec);
  await new Promise((r) => { const t = setTimeout(r, 2500); child.on('exit', () => { clearTimeout(t); setTimeout(r, 100); }); });
  if (rec.exited !== null) rec.seen = true;    // it already ended inside this very tool call: the model gets the result right here, no wake-up needed
  return view(rec, 3000);
}

const view = (p, tail = 0) => ({
  id: p.id, pid: p.pid, command: p.command, running: p.exited === null, exit_code: p.exited, started_at: p.startedAt,
  session_id: p.sessionId || null, killed: !!p.killed,
  ...(p.interactive ? { stdin_open: p.exited === null && !!(p.child.stdin && !p.child.stdin.destroyed && p.child.stdin.writable) } : {}),
  elapsed_ms: (p.exited === null ? Date.now() : p.endedAt) - p.startedAt,
  progress: p.progress && Object.keys(p.progress).length ? { task: p.progress.task, percent: p.progress.percent } : null,
  last_line: p.lastLine || '',
  ...(p.logFile ? { log_file: p.logFile } : {}),
  ...(tail ? { output: p.output.slice(-tail) } : {}),
});

/** `forModel`: the list goes to the agent, so finished processes count as "reported" (no wake-up for them). */
const list = ({ forModel = false } = {}) => [...procs.values()].map((p) => { if (forModel && p.exited !== null) p.seen = true; return view(p); });

function output(id, tail = 4000) {
  const p = procs.get(id);
  if (!p) throw new Error(`no such process: ${id}`);
  if (p.exited !== null) p.seen = true;       // the agent has now read the final result itself
  return view(p, tail);
}

function kill(id) {
  const p = procs.get(id);
  if (!p) throw new Error(`no such process: ${id}`);
  if (p.exited === null) { p.killed = true; killTree(p.child); }
  return { id, killed: true };
}

const MAX_INPUT = 10000;

/**
 * Write to the stdin of a background process started with `interactive: true`, wait briefly for it to react and
 * return the newest output. `newline` (default true) appends "\n" (pressing Enter); `closeStdin` sends EOF afterwards.
 */
async function sendInput(id, text, { newline = true, closeStdin = false, waitMs = 1200 } = {}) {
  const p = procs.get(id);
  if (!p) throw new Error(`no such process: ${id}`);
  if (p.exited !== null) throw new Error(`${id} has already exited (exit code ${p.exited})`);
  if (!p.interactive || !p.child.stdin || p.child.stdin.destroyed || !p.child.stdin.writable) {
    throw new Error(`${id} has no open stdin: start it with bash background=true AND interactive=true`);
  }
  const data = String(text == null ? '' : text);
  if (data.length > MAX_INPUT) throw new Error(`input too long (max ${MAX_INPUT} characters)`);
  const before = p.output.length;
  const stdin = p.child.stdin;
  await new Promise((resolve, reject) => {
    const payload = data + (newline && data !== '' ? '\n' : '');
    const done = (e) => (e ? reject(e) : resolve());
    if (payload === '') return done();
    stdin.write(payload, done);
  });
  if (closeStdin) { try { stdin.end(); } catch { /* already closed */ } }
  // wait until the process has been quiet for a moment (or exits), at most waitMs
  await new Promise((resolve) => {
    let last = p.output.length;
    let quiet = 0;
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (p.exited !== null || Date.now() - t0 >= waitMs) { clearInterval(iv); return resolve(); }
      if (p.output.length === last) { quiet += 100; if (quiet >= 400 && p.output.length > before) { clearInterval(iv); resolve(); } } else { last = p.output.length; quiet = 0; }
    }, 100);
  });
  const fresh = p.output.slice(before);
  if (p.exited !== null) p.seen = true;
  return { ...view(p), new_output: fresh.replace(ANSI, '').slice(-3500) };
}

const isSeen = (id) => { const p = procs.get(id); return !!(p && p.seen); };

/** True while this session has a background job running, or one that ended recently and was not read by the model
 *  yet (the studio will wake the agent for it, so the agent must not be nudged to continue by itself). */
function hasPending(sessionId, withinMs = 30000) {
  if (!sessionId) return false;
  const now = Date.now();
  return [...procs.values()].some((p) => p.sessionId === sessionId && (p.exited === null || (!p.seen && now - p.endedAt <= withinMs)));
}

function killAll() { for (const p of procs.values()) if (p.exited === null) { p.killed = true; killTree(p.child); } procs.clear(); }
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { killAll(); process.exit(0); });

module.exports = { runForeground, startBackground, sendInput, list, output, kill, killAll, isSeen, hasPending, events };
