'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { getWorkDir, studioDir, VIRTUAL_PREFIX } = require('./config');
const log = require('./log');

const IGNORED = new Set(['node_modules', '.git', '.studio', '.DS_Store', '__pycache__']);
const MAX_READ_BYTES = 10 * 1024 * 1024;

/** Resolve a relative path and guarantee it stays inside the working directory (symlink-safe). */
function safeResolve(relative) {
  let base = getWorkDir();
  let rel = String(relative == null ? '' : relative).replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.isAbsolute(rel)) {
    // models often paste absolute paths: accept them when they point inside the project (still confined below)
    const root = getWorkDir();
    const norm = path.resolve(rel);
    if (norm === root || norm.startsWith(root + path.sep)) rel = path.relative(root, norm).split(path.sep).join('/');
    else throw new Error(`absolute path is outside the working directory (${root}); use a path relative to it`);
  }
  // ".studio/..." is a virtual alias for this project's data folder in the user's home (~/.studio/<project>/...),
  // so the agent can still reach uploads, saved tool output and plans without them living in the project.
  if (rel === VIRTUAL_PREFIX || rel.startsWith(VIRTUAL_PREFIX + '/')) {
    base = studioDir();
    fs.mkdirSync(base, { recursive: true });
    base = fs.realpathSync(base);
    rel = rel.slice(VIRTUAL_PREFIX.length).replace(/^\//, '');
  }
  const resolved = path.resolve(base, rel);
  const within = (p) => p === base || p.startsWith(base + path.sep);
  if (!within(resolved)) throw new Error('path escapes the working directory');
  // Resolve symlinks of the nearest existing ancestor to stop symlink escapes.
  let probe = resolved;
  while (!fs.existsSync(probe) && probe !== base) probe = path.dirname(probe);
  if (!within(fs.realpathSync(probe))) throw new Error('path escapes the working directory (symlink)');
  return resolved;
}

/* ---------- directory walking (bounded, cached, never blocks the UI on a huge folder) ---------- */

// Never worth listing/searching: dependency and cache folders (can hold 100k+ files).
const SKIP_DIRS = new Set([...IGNORED, '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.cache', '.next', '.nuxt', '.gradle', '.parcel-cache', 'site-packages', '.pnpm-store', '.npm', '.yarn', 'bower_components', '.terraform']);
const WALK_LIMIT_MS = 6000;
const WALK_TTL_MS = 8000;
const DIR_ENTRY_CAP = 1500;     // entries shown per directory in the UI tree

/** One directory level for the (lazy) UI tree: dirs first, ignored folders hidden, capped. No per-file stat. */
async function listDir(rel = '') {
  const full = safeResolve(rel);
  let entries;
  try { entries = await fsp.readdir(full, { withFileTypes: true }); } catch (e) {
    if (e.code === 'ENOTDIR') throw new Error('not a directory');
    throw e;
  }
  const out = [];
  for (const e of entries) {
    if (IGNORED.has(e.name)) continue;
    const isDir = e.isDirectory() || (e.isSymbolicLink() && (() => { try { return fs.statSync(path.join(full, e.name)).isDirectory(); } catch { return false; } })());
    if (!isDir && !e.isFile() && !e.isSymbolicLink()) continue;
    out.push({ name: e.name, path: rel ? `${rel.replace(/\/+$/, '')}/${e.name}` : e.name, type: isDir ? 'dir' : 'file', heavy: isDir && SKIP_DIRS.has(e.name) });
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  const total = out.length;
  return { path: rel, entries: out.slice(0, DIR_ENTRY_CAP), total, truncated: Math.max(0, total - DIR_ENTRY_CAP) };
}

let walkCache = { dir: null, at: 0, result: null, pending: null };
const invalidateWalk = () => { walkCache = { dir: null, at: 0, result: null, pending: null }; };

/** Breadth-first walk. Returns { files: [...], dirs: [...], truncated, reason }. Stops at `limit` entries or after `budgetMs`. */
async function walk({ limit = 100000, budgetMs = WALK_LIMIT_MS } = {}) {
  const base = getWorkDir();
  const now = Date.now();
  if (walkCache.dir === base && now - walkCache.at < WALK_TTL_MS && walkCache.result && walkCache.result.limit >= limit) return walkCache.result;
  if (walkCache.dir === base && walkCache.pending) return walkCache.pending;      // share one walk between concurrent callers
  const job = (async () => {
    const files = [];
    const dirs = [];
    const started = Date.now();
    let truncated = false;
    let reason = '';
    const queue = [''];
    for (let qi = 0; qi < queue.length; qi++) {
      if (files.length + dirs.length >= limit) { truncated = true; reason = `more than ${limit} entries`; break; }
      if (Date.now() - started > budgetMs) { truncated = true; reason = `scan stopped after ${Math.round(budgetMs / 1000)}s (very large directory)`; break; }
      const rel = queue[qi];
      let entries;
      try { entries = await fsp.readdir(rel ? path.join(base, rel) : base, { withFileTypes: true }); } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'EACCES' && e.code !== 'EPERM' && e.code !== 'ENOTDIR') log.debug('workspace', `cannot read ${rel || '.'}`, e);
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue;
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { dirs.push(child); queue.push(child); } else if (e.isFile()) files.push(child);
      }
    }
    const result = { files, dirs, truncated, reason, limit };
    walkCache = { dir: base, at: Date.now(), result, pending: null };
    return result;
  })();
  walkCache.dir = base; walkCache.pending = job;
  try { return await job; } finally { if (walkCache.pending === job) walkCache.pending = null; }
}

/** Nested tree (kept for API compatibility / tests): bounded by depth and the walk limits. */
async function buildTree(dir, relPath = '', depth = 0) {
  if (depth > 8) return [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { log.debug('workspace', `tree: cannot read ${relPath || '.'}`, e); return []; }
  const nodes = [];
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) nodes.push({ name: entry.name, path: childRel, type: 'dir', children: await buildTree(path.join(dir, entry.name), childRel, depth + 1) });
    else if (entry.isFile()) nodes.push({ name: entry.name, path: childRel, type: 'file' });
  }
  nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return nodes;
}

const listTree = () => buildTree(getWorkDir(), '');

/** Flat list of file paths (dirs get trailing "/"), capped. */
async function listFlat(limit = 100000) {
  const r = await walk({ limit });
  const out = [...r.dirs.map((d) => d + '/'), ...r.files].sort();
  return out.slice(0, limit);
}

async function readFile(relPath) {
  const full = safeResolve(relPath);
  const stat = await fsp.stat(full);
  if (!stat.isFile()) throw new Error('not a file');
  if (stat.size > MAX_READ_BYTES) throw new Error(`file too large to read (${stat.size} bytes)`);
  return fsp.readFile(full, 'utf8');
}

async function moveFile(from, to, overwrite = false) {
  const src = safeResolve(from);
  const dst = safeResolve(to);
  if (src === dst) return { path: to, moved: false };
  let dstStat;
  try { dstStat = await fsp.stat(dst); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (dstStat) {
    if (!overwrite) throw new Error('destination already exists (use overwrite: true)');
    try { await fsp.unlink(dst); } catch (e) { if (e.code && e.code !== 'ENOENT') throw e; }
  }
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  try {
    await fsp.rename(src, dst);
  } catch (e) {
    if (e.code === 'EXDEV') {
      const data = await fsp.readFile(src);
      await fsp.writeFile(dst, data);
      await fsp.rm(src, { recursive: true, force: true });
    } else {
      throw e;
    }
  }
  invalidateWalk();
  return { path: to, from: from };
}

async function writeFile(relPath, content) {
  const full = safeResolve(relPath);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content == null ? '' : String(content), 'utf8');
  invalidateWalk();
  return { path: relPath, bytes: Buffer.byteLength(String(content ?? '')) };
}

async function deleteFile(relPath) {
  if (!String(relPath || '').replace(/[\\/.]/g, '')) throw new Error('refusing to delete the working directory');
  await fsp.rm(safeResolve(relPath), { recursive: true, force: true });
  invalidateWalk();
  return { path: relPath };
}

/* ---------- glob / grep ---------- */

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) re += '\\{';
      else { re += '(?:' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = end; }
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|tar|7z|rar|exe|dll|so|dylib|bin|wasm|mp[34]|mov|avi|mkv|woff2?|ttf|otf|class|jar|pyc|pyd|o|a|lib|iso|dmg|sqlite|db)$/i;

async function files() {
  return (await listFlat(200000)).filter((p) => !p.endsWith('/'));
}

const GLOB_CAP = 5000;
const GREP_MATCH_CAP = 1000;
const GREP_BUDGET_MS = 20000;

async function glob(pattern) {
  const hasSlash = pattern.includes('/');
  const re = globToRegex(hasSlash ? pattern : '**/' + pattern);
  const all = (await files()).filter((p) => re.test(p));
  if (all.length <= GLOB_CAP) return { matches: all, truncated: false };
  return { matches: all.slice(0, GLOB_CAP), truncated: true, reason: `glob results limited to ${GLOB_CAP} matches; narrow the pattern or path` };
}

async function grep(pattern, include) {
  let re;
  try { re = new RegExp(pattern); } catch (e) { throw new Error('invalid regex: ' + e.message); }
  const incRe = include ? globToRegex(include.includes('/') ? include : '**/' + include) : null;
  const candidates = (await files()).filter((rel) => !BINARY_EXT.test(rel) && (!incRe || incRe.test(rel)));
  const started = Date.now();
  const perFile = new Array(candidates.length);
  let next = 0;
  let found = 0;
  let stopped = '';
  let reason = '';
  // a few files in parallel: much faster on big trees than one-by-one, and the event loop stays responsive
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= candidates.length || found >= GREP_MATCH_CAP) { if (found >= GREP_MATCH_CAP && !stopped) { stopped = `… match limit reached (${GREP_MATCH_CAP})`; reason = `grep stopped at ${GREP_MATCH_CAP} matches; narrow the pattern or include glob`; } return; }
      if (Date.now() - started > GREP_BUDGET_MS) { stopped = `… search stopped after ${GREP_BUDGET_MS / 1000}s`; reason = 'search stopped after time budget — narrow it with "include" or a more specific path'; return; }
      const rel = candidates[i];
      try {
        const full = safeResolve(rel);
        const st = await fsp.stat(full);
        if (st.size > MAX_READ_BYTES) continue;
        const text = await fsp.readFile(full, 'utf8');
        if (text.includes('\u0000')) continue;
        const hits = [];
        const lines = text.split('\n');
        for (let n = 0; n < lines.length && hits.length < GREP_MATCH_CAP; n++) if (re.test(lines[n])) hits.push(`${rel}:${n + 1}: ${lines[n].slice(0, 500)}`);
        if (hits.length) { perFile[i] = hits; found += hits.length; }
      } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'EACCES') log.debug('workspace', `grep: cannot read ${rel}`, e); }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  const matches = [];
  for (const hits of perFile) if (hits) for (const h of hits) { if (matches.length < GREP_MATCH_CAP) matches.push(h); }
  if (stopped) matches.push(stopped);
  return { matches, truncated: !!stopped, reason: reason || stopped.replace(/^…\s+/, '') };
}

module.exports = { safeResolve, listDir, walk, invalidateWalk, listTree, listFlat, readFile, writeFile, deleteFile, moveFile, glob, grep, IGNORED, SKIP_DIRS };
