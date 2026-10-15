'use strict';

// Shadow-git snapshots: a private git repo in ~/.studio/<project>/snapshot.git whose work-tree is the
// project directory. It never touches the project's own .git. We snapshot the whole tree (tracked + untracked,
// honouring .gitignore) at the start of every user turn, so undo/redo also covers changes made via `bash`.
// Requires `git` on PATH; if it is missing everything silently falls back to the per-file journal.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { getWorkDir, studioDir } = require('./config');
const ws = require('./workspace');

let state = { dir: null, ok: false };
const gitDir = () => path.join(studioDir(), 'snapshot.git');

function git(args, { buffer = false, input } = {}) {
  const base = ['--git-dir', gitDir(), '--work-tree', getWorkDir(), '-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', '-c', 'core.quotepath=false', '-c', 'gc.auto=0'];
  return new Promise((resolve) => {
    const child = execFile('git', [...base, ...args], { cwd: getWorkDir(), maxBuffer: 256 * 1024 * 1024, encoding: buffer ? 'buffer' : 'utf8', timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: stdout }));
    if (input != null) child.stdin.end(input);
  });
}

async function init() {
  const dir = getWorkDir();
  if (state.dir === dir) return state.ok;
  state = { dir, ok: false };
  try {
    if (!fs.existsSync(path.join(gitDir(), 'HEAD'))) {
      await fsp.mkdir(gitDir(), { recursive: true });
      const r = await git(['init', '--quiet']);
      if (r.code !== 0) return false;
      await fsp.mkdir(path.join(gitDir(), 'info'), { recursive: true });
      await fsp.writeFile(path.join(gitDir(), 'info', 'exclude'), '.studio/\nnode_modules/\n.git/\n', 'utf8');
    }
    state.ok = true;
    git(['gc', '--prune=7.days', '--quiet']); // background housekeeping
  } catch { state.ok = false; }
  return state.ok;
}

/** Snapshot the whole tree; returns a tree hash, or null when snapshots are unavailable. */
async function track() {
  if (!(await init())) return null;
  const add = await git(['add', '-A', '--ignore-errors', '--', '.']);
  if (add.code !== 0 && add.code !== 1) return null;
  const tree = await git(['write-tree']);
  return tree.code === 0 ? String(tree.out).trim() : null;
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

module.exports = { track, diff, restore };
