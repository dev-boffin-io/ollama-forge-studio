'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { getWorkDir, studioDir, VIRTUAL_PREFIX } = require('./config');

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

async function buildTree(dir, relPath = '', depth = 0) {
  if (depth > 40) return [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const nodes = [];
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: childRel, type: 'dir', children: await buildTree(full, childRel, depth + 1) });
    } else if (entry.isFile()) {
      const stat = await fsp.stat(full);
      nodes.push({ name: entry.name, path: childRel, type: 'file', size: stat.size });
    }
  }
  nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return nodes;
}

const listTree = () => buildTree(getWorkDir(), '');

/** Flat list of file paths (dirs get trailing "/"), capped. */
async function listFlat(limit = 100000) {
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes) {
      if (out.length >= limit) return;
      if (n.type === 'dir') { out.push(n.path + '/'); walk(n.children); } else out.push(n.path);
    }
  };
  walk(await listTree());
  return out;
}

async function readFile(relPath) {
  const full = safeResolve(relPath);
  const stat = await fsp.stat(full);
  if (!stat.isFile()) throw new Error('not a file');
  if (stat.size > MAX_READ_BYTES) throw new Error(`file too large to read (${stat.size} bytes)`);
  return fsp.readFile(full, 'utf8');
}

async function writeFile(relPath, content) {
  const full = safeResolve(relPath);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content == null ? '' : String(content), 'utf8');
  return { path: relPath, bytes: Buffer.byteLength(String(content ?? '')) };
}

async function deleteFile(relPath) {
  if (!String(relPath || '').replace(/[\\/.]/g, '')) throw new Error('refusing to delete the working directory');
  await fsp.rm(safeResolve(relPath), { recursive: true, force: true });
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

async function files() {
  return (await listFlat(200000)).filter((p) => !p.endsWith('/'));
}

async function glob(pattern) {
  const hasSlash = pattern.includes('/');
  const re = globToRegex(hasSlash ? pattern : '**/' + pattern);
  return (await files()).filter((p) => re.test(p)).slice(0, 5000);
}

async function grep(pattern, include) {
  let re;
  try { re = new RegExp(pattern); } catch (e) { throw new Error('invalid regex: ' + e.message); }
  const incRe = include ? globToRegex(include.includes('/') ? include : '**/' + include) : null;
  const matches = [];
  for (const rel of await files()) {
    if (matches.length >= 1000) break;
    if (incRe && !incRe.test(rel)) continue;
    let text;
    try {
      const full = safeResolve(rel);
      const st = await fsp.stat(full);
      if (st.size > MAX_READ_BYTES) continue;
      text = await fsp.readFile(full, 'utf8');
    } catch { continue; }
    if (text.includes('\u0000')) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length && matches.length < 1000; i++) {
      if (re.test(lines[i])) matches.push(`${rel}:${i + 1}: ${lines[i].slice(0, 500)}`);
    }
  }
  return matches;
}

module.exports = { safeResolve, listTree, listFlat, readFile, writeFile, deleteFile, glob, grep, IGNORED };
