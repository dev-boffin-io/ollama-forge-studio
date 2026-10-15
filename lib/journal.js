'use strict';

// Undo / redo for agent file changes. Preferred: whole-tree shadow-git snapshots (snapshot.js).
// Fallback when git is missing: per-file journal. Before the first change to a file in a user turn
// we remember its previous content in the ROOT session's journal. Undo restores those files and removes the
// turn's messages; redo re-applies. Journal mode does not see changes made by `bash`; snapshot mode does.

const fsp = require('node:fs/promises');
const ws = require('./workspace');
const snapshot = require('./snapshot');

const MAX_TRACK_BYTES = 100 * 1024 * 1024;

async function readOrNull(rel) {
  try {
    const full = ws.safeResolve(rel);
    const st = await fsp.stat(full);
    if (!st.isFile() || st.size > MAX_TRACK_BYTES) return undefined; // untrackable
    return await fsp.readFile(full, 'utf8');
  } catch (e) {
    return e && e.code === 'ENOENT' ? null : undefined;
  }
}

/** Call BEFORE modifying `rel`. */
async function track(root, rel) {
  if (!root) return;
  root.journal = root.journal || [];
  const turn = root.turn || 0;
  if (root.journal.some((e) => e.turn === turn && e.path === rel)) return;
  const before = await readOrNull(rel);
  if (before === undefined) return;
  root.journal.push({ turn, path: rel, before });
}

async function restore(rel, content) {
  if (content === null) await ws.deleteFile(rel).catch(() => {});
  else await ws.writeFile(rel, content);
}

async function undo(session) {
  const idx = session.messages.map((m) => m.role === 'user' && !m.summary).lastIndexOf(true);
  if (idx < 0) throw new Error('nothing to undo');
  const turn = session.messages[idx].turn;
  const entries = (session.journal || []).filter((e) => e.turn === turn);
  const files = [];
  const start = session.snaps && session.snaps[turn];
  const now = start ? await snapshot.track() : null;
  if (start && now) {
    // whole-tree snapshot: also reverts changes made through bash
    const changed = await snapshot.restore(start, now);
    const removed = session.messages.slice(idx);
    session.messages = session.messages.slice(0, idx);
    session.journal = (session.journal || []).filter((e) => e.turn !== turn);
    session.revert = { turn, mode: 'snapshot', before: now, files: changed.map((p) => ({ path: p })), removed, journal: entries };
    return { text: removed[0].content, files: changed, removedMessages: removed.length };
  }
  for (const e of entries) {
    const after = await readOrNull(e.path);
    await restore(e.path, e.before);
    files.push({ path: e.path, before: e.before, after: after === undefined ? null : after });
  }
  const removed = session.messages.slice(idx);
  session.messages = session.messages.slice(0, idx);
  session.journal = (session.journal || []).filter((e) => e.turn !== turn);
  session.revert = { turn, files, removed, journal: entries };
  return { text: removed[0].content, files: files.map((f) => f.path), removedMessages: removed.length };
}

async function redo(session) {
  const r = session.revert;
  if (!r) throw new Error('nothing to redo');
  if (r.mode === 'snapshot') {
    const cur = await snapshot.track();
    if (!cur) throw new Error('snapshots are unavailable');
    await snapshot.restore(r.before, cur);
    session.messages.push(...r.removed);
    session.journal = [...(session.journal || []), ...r.journal];
    session.revert = null;
    return { files: r.files.map((f) => f.path) };
  }
  for (const f of r.files) await restore(f.path, f.after);
  session.messages.push(...r.removed);
  session.journal = [...(session.journal || []), ...r.journal];
  session.revert = null;
  return { files: r.files.map((f) => f.path) };
}

module.exports = { track, undo, redo };
