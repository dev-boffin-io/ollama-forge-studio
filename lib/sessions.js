'use strict';

// Sessions are saved per working directory in <dir>/.studio/sessions/<id>.json
// so reopening the studio in the same folder lets you resume where you left off.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { studioDir } = require('./config');

const ID_RE = /^ses_[a-z0-9]{6,40}$/;
const sessionsDir = () => path.join(studioDir(), 'sessions');

function checkId(id) {
  if (!ID_RE.test(String(id))) throw new Error('invalid session id');
  return id;
}
const fileOf = (id) => path.join(sessionsDir(), checkId(id) + '.json');
const archiveOf = (id) => path.join(sessionsDir(), checkId(id) + '.archive.jsonl');
const newId = () => 'ses_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

async function save(session) {
  session.updatedAt = Date.now();
  await fsp.mkdir(sessionsDir(), { recursive: true });
  const file = fileOf(session.id);
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(session, null, 1), 'utf8');
  await fsp.rename(tmp, file); // atomic: a crash never leaves a half-written session
  return session;
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
    if (e.code === 'ENOENT') throw new Error('session not found');
    throw e;
  }
}

async function all() {
  let names = [];
  try { names = await fsp.readdir(sessionsDir()); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try { out.push(JSON.parse(await fsp.readFile(path.join(sessionsDir(), n), 'utf8'))); } catch { /* skip corrupt */ }
  }
  return out;
}

const summary = (s) => ({
  id: s.id, title: s.title || '(untitled)', agent: s.agent, model: s.model, parentId: s.parentId || null,
  createdAt: s.createdAt, updatedAt: s.updatedAt, messageCount: s.messages.length,
});

/** Top-level sessions (child/subagent sessions are hidden), newest first. */
async function list({ includeChildren = false } = {}) {
  const rows = (await all()).filter((s) => includeChildren || !s.parentId).map(summary);
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
  try { raw = await fsp.readFile(archiveOf(id), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim() || out.length >= limit) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a damaged line */ }
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
  try { require('./recall').forgetSession(id); } catch { /* ignore */ }
  return { id };
}

/** Copy a session (optionally only the first `upTo` messages) to branch off a different approach. */
async function fork(id, upTo) {
  const src = await get(id);
  let messages = src.messages;
  if (Number.isInteger(upTo) && upTo >= 0) messages = messages.slice(0, upTo);
  const copy = await create({ agent: src.agent, model: src.model, title: (src.title || 'session') + ' (fork)' });
  copy.messages = JSON.parse(JSON.stringify(messages));
  copy.todos = JSON.parse(JSON.stringify(src.todos || []));
  copy.forkOf = src.id;
  const archived = await archiveRead(src.id, src.archived || 0);   // a fork keeps the summarised-away history too
  if (archived.length) { await archiveAppend(copy.id, archived, 0); copy.archived = archived.length; }
  copy.summaries = JSON.parse(JSON.stringify(src.summaries || []));
  return save(copy);
}

/** Session + all child (subagent) sessions, recursively — for export/backup. */
async function exportTree(id) {
  const s = await get(id);
  return { ...s, archive: await archiveRead(id, s.archived || 0), children: await Promise.all((await children(id)).map((c) => exportTree(c.id))) };
}

module.exports = { create, get, save, list, latest, remove, fork, exportTree, children, summary, archiveAppend, archiveRead, transcript };
