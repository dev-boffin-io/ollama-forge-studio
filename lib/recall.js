'use strict';

/**
 * "Unlimited context" without an embedding model: every message that passes through a session is also
 * written to a local SQLite FTS5 index (<dir>/.studio/recall.db, BM25 keyword ranking, Bengali-aware tokenizer).
 * Compaction/pruning may drop text from the live context, but it stays searchable here, so the agent can
 *   - call the `recall` tool to look something up, and
 *   - get the best few not-currently-visible snippets injected automatically for each new user message.
 * Needs Node >= 22.5 (built-in node:sqlite). On older Node everything here is a silent no-op.
 *
 * Optional semantic half: with `embedModel` set in the config (see lib/embed.js) every chunk is also embedded
 * in the background (table `vec`, Float32 BLOBs, cosine similarity in JS — no extension or dependency) and
 * searchHybrid()/autoHybrid() fuse the BM25 and the vector ranking with Reciprocal Rank Fusion.
 * Without an embedding model, or while the embedding server is unreachable, they return exactly the BM25 results.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { studioDir } = require('./config');
const embed = require('./embed');
const { bus, TYPES } = require('./events');

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
      CREATE TABLE IF NOT EXISTS seen(h TEXT PRIMARY KEY, sid TEXT);
      CREATE TABLE IF NOT EXISTS vec(rid INTEGER NOT NULL, model TEXT NOT NULL, sid TEXT, dim INTEGER, v BLOB, PRIMARY KEY(rid, model));
      CREATE INDEX IF NOT EXISTS vec_sid ON vec(sid);`);
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
    if (n) schedulePump();                                  // semantic index catches up in the background (no-op without embedModel)
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
  try {
    db.prepare('DELETE FROM mem WHERE sid = ?').run(id); db.prepare('DELETE FROM seen WHERE sid = ?').run(id);
    db.prepare('DELETE FROM vec WHERE sid = ?').run(id);
    vecCache = null;
  } catch (e) { log.warn('recall', `cannot forget session ${id}`, e); }
}

function tokens(query) {
  const toks = String(query).toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) || [];
  return [...new Set(toks.filter((t) => t.length >= 2 && !STOP.has(t)))].slice(0, 12);
}

/** BM25 candidates, best first: [{ rid, sid, role, ts, text }] (not de-duplicated, not truncated). */
function bm25Rows(query, { sid = null, limit = 30 } = {}) {
  const db = open();
  const toks = tokens(query);
  if (!db || !toks.length) return [];
  const match = toks.map((t) => `"${t.replace(/"/g, '')}"${t.length >= 3 ? ' *' : ''}`).join(' OR ');
  try {
    return db.prepare(`SELECT rowid AS rid, text, sid, role, ts FROM mem WHERE mem MATCH ? ${sid ? 'AND sid = ?' : ''} ORDER BY bm25(mem) LIMIT ?`)
      .all(...[match, ...(sid ? [sid] : []), limit]).map((r) => ({ ...r, rid: Number(r.rid), ts: Number(r.ts) }));
  } catch (e) { log.warn('recall', 'search failed', e); return []; }
}

/** Shared tail of every search: drop what the live context already shows, de-duplicate, cut long text, keep `limit`. */
function finish(rows, { limit, exclude, maxChars }) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (exclude && exclude.has(hash(r.sid, r.role, r.text))) continue;
    const key = r.text.slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sid: r.sid, role: r.role, ts: Number(r.ts), text: r.text.length > maxChars ? r.text.slice(0, maxChars) + '…' : r.text, ...(r.via ? { via: r.via, score: r.score } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * BM25 keyword search. `exclude` = Set of hashes (e.g. what is already visible in the live context).
 * Returns [{ sid, role, ts, text }] best first, de-duplicated.
 */
function search(query, { limit = 6, sid = null, exclude = null, maxChars = 800 } = {}) {
  return finish(bm25Rows(query, { sid, limit: limit * 5 }), { limit, exclude, maxChars });
}

/* ---------- semantic half (optional, needs config.embedModel) ---------- */

let cfgRef = null;                 // the config the embeddings are made with (set by configure())
let vecCache = null;               // { model, rids: number[], sids: string[], vecs: Float32Array[] } for the current model
let pumping = false;
let pumpTimer = null;

/** Tell the memory which config to embed with. Cheap; call it at the start of every agent run. */
function configure(config) {
  const was = cfgRef && cfgRef.embedModel;
  cfgRef = config || null;
  if (embed.enabled(cfgRef)) { if (was !== cfgRef.embedModel) embed.resetBackoff(); schedulePump(); }
}

const semanticOn = () => !!cfgRef && embed.enabled(cfgRef);

function schedulePump(ms = 80) {
  if (pumping || pumpTimer || !semanticOn() || !open()) return;
  pumpTimer = setTimeout(() => { pumpTimer = null; pump().catch((e) => log.warn('recall', 'background embedding failed', e)); }, ms);
  if (pumpTimer.unref) pumpTimer.unref();
}

function loadCache(db, model) {
  if (vecCache && vecCache.model === model) return vecCache;
  const c = { model, rids: [], sids: [], vecs: [] };
  try {
    for (const r of db.prepare('SELECT rid, sid, v FROM vec WHERE model = ?').all(model)) { c.rids.push(Number(r.rid)); c.sids.push(r.sid); c.vecs.push(embed.fromBlob(r.v)); }
  } catch (e) { log.warn('recall', 'cannot load the vector index', e); }
  vecCache = c;
  return c;
}

/**
 * Embed every chunk that has no vector yet (new ones as well as everything indexed before embeddings were switched on),
 * a few at a time, until none is left or the embedding server stops answering.
 */
async function pump() {
  if (pumping) return { done: 0 };
  const db = open();
  if (!db || !semanticOn()) return { done: 0 };
  pumping = true;
  let done = 0;
  try {
    const t = embed.target(cfgRef);
    db.prepare('DELETE FROM vec WHERE model != ?').run(t.key);          // vectors of a previous embedding model are useless now
    if (vecCache && vecCache.model !== t.key) vecCache = null;
    const pick = db.prepare('SELECT rowid AS rid, text, sid FROM mem WHERE rowid NOT IN (SELECT rid FROM vec WHERE model = ?) ORDER BY rowid DESC LIMIT 32');
    const put = db.prepare('INSERT OR REPLACE INTO vec(rid, model, sid, dim, v) VALUES (?, ?, ?, ?, ?)');
    for (;;) {
      const rows = pick.all(t.key);
      if (!rows.length) break;
      const r = await embed.embed(cfgRef, rows.map((x) => x.text));
      if (!r) break;                                                    // server unreachable / backing off: stay keyword-only, retry on the next index
      const cache = vecCache && vecCache.model === r.model ? vecCache : null;
      db.exec('BEGIN');
      try {
        rows.forEach((row, i) => {
          put.run(Number(row.rid), r.model, row.sid, r.vectors[i].length, embed.toBlob(r.vectors[i]));
          if (cache) { cache.rids.push(Number(row.rid)); cache.sids.push(row.sid); cache.vecs.push(r.vectors[i]); }
        });
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { log.debug('recall', 'rollback failed', e2); } vecCache = null; throw e; }
      done += rows.length;
    }
  } finally {
    pumping = false;
    if (done) {
      const st = stats();
      bus.emit(TYPES.MEMORY_EMBEDDED, { done, pending: st.pending });
    }
  }
  return { done };
}

/** Top vector matches for an already embedded query: [{ rid, score }] best first. */
function vectorTop(qvec, model, { sid = null, limit = 30, minSim = 0 } = {}) {
  const db = open();
  if (!db) return [];
  const c = loadCache(db, model);
  const top = [];
  for (let i = 0; i < c.vecs.length; i++) {
    if (sid && c.sids[i] !== sid) continue;
    const score = embed.dot(qvec, c.vecs[i]);
    if (score < minSim) continue;
    top.push({ rid: c.rids[i], score });
  }
  top.sort((a, b) => b.score - a.score);
  return top.slice(0, limit);
}

function rowsByRid(rids) {
  const db = open();
  if (!db || !rids.length) return new Map();
  const out = new Map();
  try {
    for (let i = 0; i < rids.length; i += 200) {
      const part = rids.slice(i, i + 200);
      for (const r of db.prepare(`SELECT rowid AS rid, text, sid, role, ts FROM mem WHERE rowid IN (${part.map(() => '?').join(',')})`).all(...part)) out.set(Number(r.rid), { ...r, rid: Number(r.rid), ts: Number(r.ts) });
    }
  } catch (e) { log.warn('recall', 'cannot read memory rows', e); }
  return out;
}

const RRF_K = 60;

/**
 * Hybrid search: BM25 + vector similarity, fused with Reciprocal Rank Fusion. Same result shape as search() plus
 * { via: 'bm25' | 'vector' | 'both', score } on every hit. Falls back to plain BM25 whenever there are no vectors.
 * `minSim` = lowest cosine similarity a vector-only hit may have (use ~0.45 for automatic injection, 0 for explicit searches).
 */
async function searchHybrid(query, { limit = 6, sid = null, exclude = null, maxChars = 800, minSim = 0, signal } = {}) {
  const lexical = bm25Rows(query, { sid, limit: limit * 5 });
  let vector = [];
  if (semanticOn() && open() && String(query).trim()) {
    const q = await embed.embed(cfgRef, [String(query).slice(0, 2000)], { signal });
    if (q) vector = vectorTop(q.vectors[0], q.model, { sid, limit: limit * 5, minSim });
  }
  if (!vector.length) return finish(lexical, { limit, exclude, maxChars });
  const fused = new Map();               // rid -> { row?, score, bm, vec }
  const bump = (rid, rank, key) => { const e = fused.get(rid) || { score: 0 }; e.score += 1 / (RRF_K + rank + 1); e[key] = true; fused.set(rid, e); };
  lexical.forEach((r, i) => { bump(r.rid, i, 'bm'); fused.get(r.rid).row = r; });
  vector.forEach((v, i) => { bump(v.rid, i, 'vec'); fused.get(v.rid).sim = v.score; });
  const missing = [...fused].filter(([, e]) => !e.row).map(([rid]) => rid);
  const fetched = rowsByRid(missing);
  const rows = [];
  for (const [rid, e] of fused) {
    const row = e.row || fetched.get(rid);
    if (row) rows.push({ ...row, via: e.bm && e.vec ? 'both' : e.vec ? 'vector' : 'bm25', score: Number((e.vec && e.sim != null ? e.sim : e.score).toFixed(4)), _rank: e.score });
  }
  rows.sort((a, b) => b._rank - a._rank);
  return finish(rows, { limit, exclude, maxChars });
}

/** Counts for the dashboard: { available, chunks, sessions, embedded, pending, semantic: { enabled, model, ... } }. */
function stats() {
  const db = open();
  const sem = embed.status(cfgRef || {});
  if (!db) return { available: false, chunks: 0, sessions: 0, embedded: 0, pending: 0, semantic: sem };
  let chunks = 0; let sessionsN = 0; let embedded = 0;
  try {
    chunks = Number(db.prepare('SELECT count(*) AS n FROM mem').get().n);
    sessionsN = Number(db.prepare('SELECT count(DISTINCT sid) AS n FROM mem').get().n);
    const t = cfgRef && embed.target(cfgRef);
    if (t) embedded = Number(db.prepare('SELECT count(*) AS n FROM vec WHERE model = ?').get(t.key).n);
  } catch (e) { log.warn('recall', 'cannot read memory statistics', e); }
  return { available: true, chunks, sessions: sessionsN, embedded, pending: sem.enabled ? Math.max(0, chunks - embedded) : 0, embedding: pumping, semantic: sem };
}

/** Newest chunks first (for browsing): [{ sid, role, ts, text }]. */
function recent({ limit = 20, sid = null, maxChars = 600 } = {}) {
  const db = open();
  if (!db) return [];
  try {
    const rows = db.prepare(`SELECT text, sid, role, ts FROM mem ${sid ? 'WHERE sid = ?' : ''} ORDER BY rowid DESC LIMIT ?`).all(...(sid ? [sid] : []), limit);
    return rows.map((r) => ({ sid: r.sid, role: r.role, ts: Number(r.ts), text: r.text.length > maxChars ? r.text.slice(0, maxChars) + '…' : r.text }));
  } catch (e) { log.warn('recall', 'cannot read recent memory', e); return []; }
}

const when = (ts) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');

function format(hits) {
  return hits.map((h, i) => `[${i + 1}] ${when(h.ts)} · ${h.role} · session ${h.sid}${h.via ? ` · ${h.via}` : ''}\n${h.text}`).join('\n\n');
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

const recalledBlock = (hits) => '<recalled-history>\nMatches from earlier work in this project (older sessions or parts of this one that no longer fit in context). ' +
  'They may be only loosely related — use them only if relevant, and call the `recall` tool for a more specific search.\n\n' + format(hits) + '\n</recalled-history>';

/** Like auto(), but semantic as well when an embedding model is configured. */
async function autoHybrid(session, userText, { limit = 3, maxChars = 700, minQueryLength = 15, minSim = 0.45, signal } = {}) {
  if (!available() || String(userText).trim().length < minQueryLength) return { hits: [], block: '' };
  const live = new Set(parts(session).map((p) => p.h));
  const hits = await searchHybrid(userText, { limit, exclude: live, maxChars, minSim, signal });
  return { hits, block: hits.length ? recalledBlock(hits) : '' };
}

module.exports = { available, indexSession, forgetSession, search, searchHybrid, auto, autoHybrid, parts, format, configure, pump, stats, recent };
