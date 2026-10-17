'use strict';

/**
 * "Unlimited context" without an embedding model: every message that passes through a session is also
 * written to a local SQLite FTS5 index (<dir>/.studio/recall.db, BM25 keyword ranking, Bengali-aware tokenizer).
 * Compaction/pruning may drop text from the live context, but it stays searchable here, so the agent can
 *   - call the `recall` tool to look something up, and
 *   - get the best few not-currently-visible snippets injected automatically for each new user message.
 * Needs Node >= 22.5 (built-in node:sqlite). On older Node everything here is a silent no-op.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { studioDir } = require('./config');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* old Node (< 22.5): recall is disabled by design */ }

// Letters, digits AND combining marks (so Bengali/Hindi words aren't split at vowel signs).
const TOKENIZE = "unicode61 remove_diacritics 0 categories 'L* N* Co M*'";
const STOP = new Set(('the a an and or of to in on for with that this these those what how why when where which who you your are was were be can could ' +
  'will would should do does did is it its i me my we our they them he she not no yes as at by from but if so than then there here have has had ' +
  'আমি তুমি আপনি কি কী কে কেন কোথায় কখন এই ওই সেই এবং আর ও না হ্যাঁ করে করতে করা কর হয় হবে আছে ছিল জন্য থেকে সাথে মধ্যে একটি একটা').split(/\s+/));

const dbs = new Map(); // db file -> DatabaseSync | null

function open() {
  if (!sqlite) return null;
  const file = path.join(studioDir(), 'recall.db');
  if (dbs.has(file)) return dbs.get(file);
  let db = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new sqlite.DatabaseSync(file);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE VIRTUAL TABLE IF NOT EXISTS mem USING fts5(text, sid UNINDEXED, role UNINDEXED, ts UNINDEXED, tokenize="${TOKENIZE}");
      CREATE TABLE IF NOT EXISTS seen(h TEXT PRIMARY KEY, sid TEXT);`);
  } catch (e) { db = null; log.warn('recall', 'history search is unavailable (SQLite/FTS5 problem or read-only folder)', e); }
  dbs.set(file, db);
  return db;
}

const available = () => !!open();
const hash = (...p) => crypto.createHash('sha1').update(p.join('\u0001')).digest('hex');

/** Split long text into paragraph-aligned chunks so hits are focused. */
function chunk(text, max = 1200) {
  const out = [];
  let cur = '';
  for (const para of String(text).split(/\n{2,}/)) {
    if (cur && cur.length + para.length + 2 > max) { out.push(cur); cur = ''; }
    if (para.length > max) {
      for (let i = 0; i < para.length; i += max) out.push(para.slice(i, i + max));
    } else cur += (cur ? '\n\n' : '') + para;
  }
  if (cur) out.push(cur);
  return out.filter((t) => t.trim().length >= 8);
}

const log = require('./log');

/** Searchable pieces of ONE live message: [{ role, text, h }]. */
function messageParts(sid, m) {
  if (m.summary || m.pruned) return [];
  const out = [];
  const add = (role, text) => { for (const t of chunk(text)) out.push({ role, text: t, h: hash(sid, role, t) }); };
  if (m.role === 'user') add('user', m.content || '');
  else if (m.role === 'assistant') {
    add('assistant', m.content || '');
    const calls = (m.tool_calls || []).map((c) => `[${c.function.name} ${JSON.stringify(c.function.arguments || {}).slice(0, 300)}]`).join('\n');
    if (calls) add('assistant', calls);
  } else if (m.role === 'tool') add('tool:' + (m.tool_name || ''), String(m.content || '').slice(0, 40000));
  return out;
}

// Chunking + hashing every message on every agent step made long sessions crawl: remember the result per message object.
const partsCache = new WeakMap();       // message -> { sid, sig, parts }
const sigOf = (m) => `${m.role}|${m.pruned ? 1 : 0}|${m.summary ? 1 : 0}|${String(m.content || '').length}|${m.tool_calls ? m.tool_calls.length : 0}`;

function cachedParts(sid, m) {
  const sig = sigOf(m);
  const hit = partsCache.get(m);
  if (hit && hit.sid === sid && hit.sig === sig) return hit.parts;
  const parts = messageParts(sid, m);
  partsCache.set(m, { sid, sig, parts });
  return parts;
}

/** The searchable pieces of a session's *live* messages: [{ role, text, h }]. */
function parts(session) {
  const out = [];
  for (const m of session.messages || []) for (const p of cachedParts(session.id, m)) out.push(p);
  return out;
}

const indexedMsgs = new WeakMap();      // message -> sig that is already in the database

/** Add any not-yet-indexed messages of a session to the index. Cheap to call often: only new/changed messages are touched. */
function indexSession(session) {
  const db = open();
  if (!db || !session) return 0;
  const todo = [];
  for (const m of session.messages || []) {
    const sig = sigOf(m);
    if (indexedMsgs.get(m) === sig) continue;
    todo.push([m, sig]);
  }
  if (!todo.length) return 0;
  let n = 0;
  try {
    const ins = db.prepare('INSERT INTO mem(text, sid, role, ts) VALUES (?, ?, ?, ?)');
    const has = db.prepare('SELECT 1 FROM seen WHERE h = ?');
    const put = db.prepare('INSERT OR IGNORE INTO seen(h, sid) VALUES (?, ?)');
    db.exec('BEGIN');
    for (const [m] of todo) {
      for (const p of cachedParts(session.id, m)) {
        if (has.get(p.h)) continue;
        ins.run(p.text, session.id, p.role, Date.now());
        put.run(p.h, session.id);
        n++;
      }
    }
    db.exec('COMMIT');
    for (const [m, sig] of todo) indexedMsgs.set(m, sig);
  } catch (e) {
    log.warn('recall', 'indexing failed (history search may miss recent messages)', e);
    try { db.exec('ROLLBACK'); } catch (e2) { log.debug('recall', 'rollback failed', e2); }
    n = 0;
  }
  return n;
}

function forgetSession(id) {
  const db = open();
  if (!db) return;
  try { db.prepare('DELETE FROM mem WHERE sid = ?').run(id); db.prepare('DELETE FROM seen WHERE sid = ?').run(id); } catch (e) { log.warn('recall', `cannot forget session ${id}`, e); }
}

function tokens(query) {
  const toks = String(query).toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) || [];
  return [...new Set(toks.filter((t) => t.length >= 2 && !STOP.has(t)))].slice(0, 12);
}

/**
 * BM25 keyword search. `exclude` = Set of hashes (e.g. what is already visible in the live context).
 * Returns [{ sid, role, ts, text }] best first, de-duplicated.
 */
function search(query, { limit = 6, sid = null, exclude = null, maxChars = 800 } = {}) {
  const db = open();
  const toks = tokens(query);
  if (!db || !toks.length) return [];
  const match = toks.map((t) => `"${t.replace(/"/g, '')}"${t.length >= 3 ? ' *' : ''}`).join(' OR ');
  let rows;
  try {
    rows = db.prepare(`SELECT text, sid, role, ts FROM mem WHERE mem MATCH ? ${sid ? 'AND sid = ?' : ''} ORDER BY bm25(mem) LIMIT ?`)
      .all(...[match, ...(sid ? [sid] : []), limit * 5]);
  } catch (e) { log.warn('recall', 'search failed', e); return []; }
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (exclude && exclude.has(hash(r.sid, r.role, r.text))) continue;
    const key = r.text.slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sid: r.sid, role: r.role, ts: Number(r.ts), text: r.text.length > maxChars ? r.text.slice(0, maxChars) + '…' : r.text });
    if (out.length >= limit) break;
  }
  return out;
}

const when = (ts) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');

function format(hits) {
  return hits.map((h, i) => `[${i + 1}] ${when(h.ts)} · ${h.role} · session ${h.sid}\n${h.text}`).join('\n\n');
}

/** Automatic retrieval for a new user message: best snippets that are NOT already in the live context. */
function auto(session, userText, { limit = 3, maxChars = 700, minQueryLength = 15 } = {}) {
  if (!available() || String(userText).trim().length < minQueryLength) return { hits: [], block: '' };
  const live = new Set(parts(session).map((p) => p.h));
  const hits = search(userText, { limit, exclude: live, maxChars });
  if (!hits.length) return { hits, block: '' };
  const block = '<recalled-history>\nKeyword matches from earlier work in this project (older sessions or parts of this one that no longer fit in context). ' +
    'They may be only loosely related — use them only if relevant, and call the `recall` tool for a more specific search.\n\n' + format(hits) + '\n</recalled-history>';
  return { hits, block };
}

module.exports = { available, indexSession, forgetSession, search, auto, parts, format };
