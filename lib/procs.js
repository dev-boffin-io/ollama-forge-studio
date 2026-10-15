'use strict';

// Process management for the bash tool:
//  - foreground commands: stdin closed, killed as a whole PROCESS GROUP on timeout/abort (so servers started by the
//    command die with it and the run can never hang on an inherited pipe);
//  - background commands (servers, watchers): tracked, output buffered, listable and killable (tool + UI).

const { spawn, execFile } = require('node:child_process');
const { getWorkDir } = require('./config');

const win = process.platform === 'win32';
const procs = new Map();
let seq = 0;

function killTree(child) {
  try {
    if (win) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
}

function spawnShell(command) {
  return win
    ? spawn('cmd.exe', ['/c', command], { cwd: getWorkDir(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('bash', ['-c', command], { cwd: getWorkDir(), env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function runForeground(command, timeoutMs, signal) {
  return new Promise((resolve) => {
    const child = spawnShell(command);
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
      ...(timedOut ? { hint: 'Command timed out and was killed. For servers, watchers or anything long-running, call bash again with background=true.' } : {}),
    }), 150));
  });
}

async function startBackground(command) {
  for (const [id, p] of procs) if (p.exited !== null && Date.now() - p.endedAt > 600000) procs.delete(id);
  if ([...procs.values()].filter((p) => p.exited === null).length >= 20) throw new Error('too many background processes (max 20); kill some first');
  const child = spawnShell(command);
  const rec = { id: 'proc_' + (++seq), pid: child.pid, command, startedAt: Date.now(), output: '', exited: null, endedAt: 0, child };
  const add = (d) => { rec.output = (rec.output + d.toString()).slice(-200000); };
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  child.on('error', (e) => { rec.output += 'spawn error: ' + e.message; rec.exited = -1; rec.endedAt = Date.now(); });
  child.on('exit', (code) => { rec.exited = code == null ? -1 : code; rec.endedAt = Date.now(); });
  procs.set(rec.id, rec);
  await new Promise((r) => { const t = setTimeout(r, 2500); child.on('exit', () => { clearTimeout(t); setTimeout(r, 100); }); });
  return view(rec, 3000);
}

const view = (p, tail = 0) => ({
  id: p.id, pid: p.pid, command: p.command, running: p.exited === null, exit_code: p.exited, started_at: p.startedAt,
  ...(tail ? { output: p.output.slice(-tail) } : {}),
});

const list = () => [...procs.values()].map((p) => view(p));

function output(id, tail = 4000) {
  const p = procs.get(id);
  if (!p) throw new Error(`no such process: ${id}`);
  return view(p, tail);
}

function kill(id) {
  const p = procs.get(id);
  if (!p) throw new Error(`no such process: ${id}`);
  if (p.exited === null) killTree(p.child);
  return { id, killed: true };
}

function killAll() { for (const p of procs.values()) if (p.exited === null) killTree(p.child); procs.clear(); }
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { killAll(); process.exit(0); });

module.exports = { runForeground, startBackground, list, output, kill, killAll };
