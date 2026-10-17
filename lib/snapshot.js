'use strict';

// Shadow-git snapshots: a private git repo in ~/.studio/<project>/snapshot.git whose work-tree is the
// project directory. It never touches the project's own .git. We snapshot the whole tree (tracked + untracked,
// honouring .gitignore) at the start of every user turn, so undo/redo also covers changes made via `bash`.
// Requires `git` on PATH; if it is missing (or the folder is still being scanned for the first time) undo falls back to the per-file journal.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { getWorkDir, studioDir } = require('./config');
const ws = require('./workspace');

const log = require('./log');

// Heavy folders that never belong in an undo snapshot (dependencies, caches, build output of other tools).
const EXCLUDE = ['.studio/', 'node_modules/', '.git/', '.venv/', 'venv/', '__pycache__/', 'site-packages/', '.cache/', '.next/', '.gradle/', '.tox/', '.mypy_cache/', '.pytest_cache/', '*.pyc', '*.pyo'];

// Per-folder state. `ready` = the shadow repo has completed its first full scan, so later snapshots are cheap
// (git only re-stats files). The first scan of a huge folder can take minutes: it runs in the BACKGROUND (warmUp) and never
// blocks a message; until it is done, undo for file tools still works through the per-file journal.
let state = { dir: null, ok: false, ready: false, warming: null, note: '', failStreak: 0 };
const gitDir = () => path.join(studioDir(), 'snapshot.git');
const disabledMarker = () => path.join(studioDir(), 'snapshot.disabled');   // written by older versions; ignored/removed now

function git(args, { buffer = false, input, timeout = 120000 } = {}) {
  const base = ['--git-dir', gitDir(), '--work-tree', getWorkDir(), '-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', '-c', 'core.quotepath=false', '-c', 'gc.auto=0'];
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile('git', [...base, ...args], { cwd: getWorkDir(), maxBuffer: 256 * 1024 * 1024, encoding: buffer ? 'buffer' : 'utf8', timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
        (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: stdout, timedOut: !!(err && err.killed), missing: !!(err && err.code === 'ENOENT') }));
    } catch (e) { log.warn('snapshot', 'cannot start git', e); resolve({ code: 1, out: '', missing: true }); return; }
    if (input != null) child.stdin.on('error', () => {}), child.stdin.end(input);
  });
}

// One git operation on the shadow repo at a time (parallel subagents / undo during a snapshot would fight over index.lock).
let chain = Promise.resolve();
const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

async function clearStaleLock() {
  try { await fsp.rm(path.join(gitDir(), 'index.lock'), { force: true }); } catch (e) { log.debug('snapshot', 'cannot remove index.lock', e); }
}

async function init() {
  const dir = getWorkDir();
  if (state.dir === dir) return state.ok;
  state = { dir, ok: false, ready: false, warming: null, note: '', failStreak: 0 };
  try {
    await fsp.rm(disabledMarker(), { force: true });
    if (!fs.existsSync(path.join(gitDir(), 'HEAD'))) {
      await fsp.mkdir(gitDir(), { recursive: true });
      const r = await git(['init', '--quiet']);
      if (r.code !== 0) { state.note = r.missing ? 'git is not installed — undo uses per-file history' : 'git init failed — undo uses per-file history'; return false; }
    }
    await fsp.mkdir(path.join(gitDir(), 'info'), { recursive: true });
    await fsp.writeFile(path.join(gitDir(), 'info', 'exclude'), EXCLUDE.join('\n') + '\n', 'utf8');   // always refreshed
    // an existing shadow repo with an index was scanned before: incremental adds are cheap right away
    state.ready = fs.existsSync(path.join(gitDir(), 'index'));
    state.ok = true;
    gcIfDue();
  } catch (e) { state.ok = false; state.note = 'snapshot setup failed — undo uses per-file history'; log.warn('snapshot', 'init failed', e); }
  return state.ok;
}

/** Housekeeping at most once a day, in the background. */
function gcIfDue() {
  const mark = path.join(gitDir(), 'studio-gc');
  try { if (Date.now() - fs.statSync(mark).mtimeMs < 86400000) return; } catch { /* never ran */ }
  try { fs.writeFileSync(mark, String(Date.now())); } catch (e) { log.debug('snapshot', 'cannot write gc marker', e); }
  git(['gc', '--prune=7.days', '--quiet'], { timeout: 600000 }).catch(log.swallow('snapshot', 'gc failed'));
}

/**
 * First full scan of the folder, in the background (no deadline: a 100k-file folder may need minutes, and nobody waits for it).
 * Safe to call repeatedly; resolves true when snapshots are ready.
 */
function warmUp() {
  return (async () => {
    if (!(await init())) return false;
    if (state.ready) return true;
    if (state.warming) return state.warming;
    const dir = state.dir;
    state.note = 'preparing undo history for this folder in the background (first run on a large folder) — undo of bash changes works once it is done';
    log.info('snapshot', `warm-up started for ${dir}`);
    const t0 = Date.now();
    state.warming = serial(async () => {
      await clearStaleLock();
      const add = await git(['add', '-A', '--ignore-errors', '--', '.'], { timeout: 30 * 60 * 1000 });
      if (state.dir !== dir) return false;                       // folder switched meanwhile
      state.warming = null;
      if (add.code !== 0 && add.code !== 1) { state.note = 'could not prepare undo history — undo uses per-file history'; log.warn('snapshot', `warm-up failed (code ${add.code}${add.timedOut ? ', timed out' : ''})`); return false; }
      state.ready = true;
      state.note = '';
      log.info('snapshot', `warm-up finished in ${Math.round((Date.now() - t0) / 1000)}s`);
      return true;
    });
    return state.warming;
  })().catch((e) => { log.warn('snapshot', 'warm-up crashed', e); return false; });
}

/** What the user should know right now ('' when everything is fine). */
const status = () => (state.ok || !state.dir ? state.note : state.note || 'snapshots unavailable');

/**
 * Snapshot the whole tree; returns a tree hash, or null when it is not available *right now*
 * (still warming up, git missing, or this incremental scan exceeded `timeoutSec`). A null never disables anything for good:
 * the next call simply tries again. Undo falls back to the per-file journal for that turn.
 */
async function track({ timeoutSec = 25 } = {}) {
  if (!(await init())) return null;
  if (!state.ready) { warmUp(); return null; }
  return serial(async () => {
    await clearStaleLock();
    const add = await git(['add', '-A', '--ignore-errors', '--', '.'], { timeout: Math.max(5, timeoutSec) * 1000 });
    if (add.timedOut) {
      state.failStreak++;
      state.note = `the undo snapshot took longer than ${timeoutSec}s this time — undo for bash changes is skipped for this message (file edits can still be undone)`;
      log.warn('snapshot', state.note);
      await clearStaleLock();
      return null;
    }
    if (add.code !== 0 && add.code !== 1) { log.warn('snapshot', `git add failed (code ${add.code})`); return null; }
    state.failStreak = 0;
    state.note = '';
    const tree = await git(['write-tree']);
    return tree.code === 0 ? String(tree.out).trim() : null;
  });
}

/**
 * Called right before a tool that can change files outside the file tools (bash): if this turn has no "before" snapshot
 * yet (e.g. warm-up finished mid-turn), take it now so the bash changes can still be undone.
 */
async function ensureBefore(session, opts) {
  try {
    if (!session || !session.turn) return;
    session.snaps = session.snaps || {};
    if (session.snaps[session.turn]) return;
    const snap = await track(opts);
    if (snap) session.snaps[session.turn] = snap;
  } catch (e) { log.debug('snapshot', 'ensureBefore failed', e); }
}

/** [{path, additions, deletions}] between two snapshots. */
async function diff(from, to) {
  if (!from || !to || from === to) return [];
  const r = await git(['diff-tree', '-r', '--numstat', '--no-renames', '-z', from, to]);
  if (r.code !== 0) return [];
  // numstat -z (non-rename): "add\tdel\tpath\0"
  return String(r.out).split('\0').filter(Boolean).map((rec) => {
    const [a, d, ...rest] = rec.split('\t');
    return { path: rest.join('\t'), additions: a === '-' ? 0 : Number(a), deletions: d === '-' ? 0 : Number(d) };
  });
}

/** Make the working tree match snapshot `target` for every file that differs from `current`. */
async function restore(target, current) {
  const files = await diff(current, target);
  for (const f of files) {
    const exists = (await git(['cat-file', '-e', `${target}:${f.path}`])).code === 0;
    const full = ws.safeResolve(f.path);
    if (exists) {
      const blob = await git(['cat-file', 'blob', `${target}:${f.path}`], { buffer: true });
      if (blob.code === 0) { await fsp.mkdir(path.dirname(full), { recursive: true }); await fsp.writeFile(full, blob.out); }
    } else await fsp.rm(full, { force: true });
  }
  return files.map((f) => f.path);
}

module.exports = { track, diff, restore, status, warmUp, ensureBefore };
