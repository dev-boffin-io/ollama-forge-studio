'use strict';

// Sessions are saved per project in ~/.studio/<project>/sessions/<id>.json
// so reopening the studio in the same folder lets you resume where you left off.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { studioDir } = require('./config');
const log = require('./log');

const ID_RE = /^ses_[a-z0-9]{6,40}$/;
const sessionsDir = () => path.join(studioDir(), 'sessions');

function checkId(id) {
  if (!ID_RE.test(String(id))) { const e = new Error('invalid session id'); e.status = 400; throw e; }
  return id;
}
const fileOf = (id) => path.join(sessionsDir(), checkId(id) + '.json');
const archiveOf = (id) => path.join(sessionsDir(), checkId(id) + '.archive.jsonl');
const newId = () => 'ses_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

const summaryCache = new Map();   // dir|id -> summary row (so listing never re-parses big session files)
const cacheKey = (id) => sessionsDir() + '|' + id;

// Saves of one session are serialised (two writers sharing one .tmp file used to race) and coalesced: while a write is
// in flight, further save() calls just mark the session dirty and a single follow-up write persists the latest state.
const writers = new Map();       // file -> { running: Promise, dirty: session|null }

async function writeNow(session) {
  const file = fileOf(session.id);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fsp.mkdir(sessionsDir(), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(session), 'utf8');      // compact: big sessions are several times smaller and faster than indent=1
    await fsp.rename(tmp, file);                                    // atomic: a crash never leaves a half-written session
  } catch (e) {
    fsp.rm(tmp, { force: true }).catch(() => {});
    if (e.code === 'ENOSPC') throw new Error('cannot save the session: the disk is full');
    if (e.code === 'EACCES' || e.code === 'EPERM') throw new Error(`cannot save the session: no permission to write ${sessionsDir()}`);
    throw e;
  }
}

async function save(session) {
  session.updatedAt = Date.now();
  summaryCache.set(cacheKey(session.id), summary(session));
  const file = fileOf(session.id);
  const w = writers.get(file);
  if (w) { w.dirty = session; return w.running; }          // joins the pending follow-up write
  const entry = { dirty: null, running: null };
  entry.running = (async () => {
    try {
      let current = session;
      while (current) {
        entry.dirty = null;
        await writeNow(current);
        current = entry.dirty;                            // saved again meanwhile? write the newest state once more
      }
    } finally { writers.delete(file); }
    return session;
  })();
  writers.set(file, entry);
  return entry.running.then(() => session);
}

async function create({ agent = 'build', model = '', title = '', parentId = null } = {}) {
  const now = Date.now();
  return save({
    id: newId(), title, agent, model, parentId,
    createdAt: now, updatedAt: now,
    messages: [], todos: [], grants: {}, compactions: 0,
  });
}

async function get(id) {
  try {
    return JSON.parse(await fsp.readFile(fileOf(id), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') { const err = new Error('session not found'); err.status = 404; throw err; }
    if (e instanceof SyntaxError) throw new Error(`session file is damaged (${id}) — it cannot be opened`);
    throw e;
  }
}

async function sessionFiles() {
  try { return (await fsp.readdir(sessionsDir())).filter((n) => /^ses_[a-z0-9]+\.json$/.test(n)); } catch (e) {
    if (e.code !== 'ENOENT') log.warn('sessions', 'cannot list sessions folder', e);
    return [];
  }
}

async function readSessionFile(n) {
  try { return JSON.parse(await fsp.readFile(path.join(sessionsDir(), n), 'utf8')); } catch (e) {
    log.warn('sessions', `skipping unreadable session file ${n}`, e);     // corrupt/half-copied file: keep going with the others
    return null;
  }
}

async function all() {
  const out = [];
  for (const n of await sessionFiles()) { const s = await readSessionFile(n); if (s) out.push(s); }
  return out;
}

const summary = (s) => ({
  id: s.id, title: s.title || '(untitled)', agent: s.agent, model: s.model, parentId: s.parentId || null,
  createdAt: s.createdAt, updatedAt: s.updatedAt, messageCount: s.messages.length,
});

/** Top-level sessions (child/subagent sessions are hidden), newest first. */
async function list({ includeChildren = false } = {}) {
  const rows = [];
  for (const n of await sessionFiles()) {
    const id = n.slice(0, -5);
    let row = summaryCache.get(cacheKey(id));
    if (!row) {                                           // first time we see this file: parse it once, then it is cached
      const s = await readSessionFile(n);
      if (!s || !Array.isArray(s.messages)) continue;
      row = summary(s);
      summaryCache.set(cacheKey(id), row);
    }
    if (includeChildren || !row.parentId) rows.push(row);
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows;
}

async function latest() { return (await list())[0] || null; }

async function children(id) { return (await all()).filter((s) => s.parentId === id); }

/**
 * Messages that are summarised away leave the live context (session.messages) but are kept verbatim here,
 * one JSON object per line, so the whole conversation can always be exported.
 * `expected` = how many lines the saved session believes are in the file (drops leftovers of a crashed append).
 */
async function archiveRead(id, limit = Infinity) {
  let raw = '';
  try { raw = await fsp.readFile(archiveOf(id), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') log.warn('sessions', `cannot read archive of ${id}`, e); return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim() || out.length >= limit) continue;
    try { out.push(JSON.parse(line)); } catch (e) { log.debug('sessions', `damaged archive line in ${id}`, e); }
  }
  return out;
}

async function archiveAppend(id, messages, expected = 0) {
  if (!messages.length) return;
  await fsp.mkdir(sessionsDir(), { recursive: true });
  const keep = await archiveRead(id, expected);
  const body = [...keep, ...messages].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const tmp = archiveOf(id) + '.tmp';
  await fsp.writeFile(tmp, body, 'utf8');
  await fsp.rename(tmp, archiveOf(id));
}

/** Every message of the session in order: archived (summarised-away) first, then the live ones. */
async function transcript(session) {
  return [...(await archiveRead(session.id, session.archived || 0)), ...session.messages];
}

async function remove(id) {
  for (const c of await children(id)) await remove(c.id);
  await fsp.rm(fileOf(id), { force: true });
  await fsp.rm(archiveOf(id), { force: true });
  summaryCache.delete(cacheKey(id));
  try { require('./recall').forgetSession(id); } catch (e) { log.warn('sessions', `recall cleanup failed for ${id}`, e); }
  return { id };
}

/** Copy a session (optionally only the first `upTo` messages) to branch off a different approach. */
async function fork(id, upTo) {
  const src = await get(id);
  let messages = src.messages;
  if (Number.isInteger(upTo) && upTo >= 0) messages = messages.slice(0, upTo);
  const copy = await create({ agent: src.agent, model: src.model, title: (src.title || 'session') + ' (fork)' });
  copy.messages = structuredClone(messages);
  copy.todos = structuredClone(src.todos || []);
  copy.forkOf = src.id;
  const archived = await archiveRead(src.id, src.archived || 0);   // a fork keeps the summarised-away history too
  if (archived.length) { await archiveAppend(copy.id, archived, 0); copy.archived = archived.length; }
  copy.summaries = structuredClone(src.summaries || []);
  return save(copy);
}

/** Session + all child (subagent) sessions, recursively — for export/backup. */
async function exportTree(id) {
  const s = await get(id);
  return { ...s, archive: await archiveRead(id, s.archived || 0), children: await Promise.all((await children(id)).map((c) => exportTree(c.id))) };
}

module.exports = { create, get, save, list, latest, remove, fork, exportTree, children, summary, archiveAppend, archiveRead, transcript };
