'use strict';

// Path claims between agents that run at the same time (fleet members, parallel sessions).
// All agents of a studio share ONE working directory, so two of them writing the same file would silently overwrite each other.
// The first agent that changes a file claims it until its run ends; another agent that tries to change it gets a clear error
// (it can do other work, or wait and retry). A claim only blocks while its owner is really RUNNING: the server registers
// setLiveness((sessionId) => running.has(sessionId)); without that predicate nothing is ever blocked. Claims are also released
// on agent_finished_task / agent_failed / agent_aborted of the top-level session and expire after `TTL_MS` untouched, so a
// crash can never leave a file locked.
// Reads are never blocked. Shell commands (bash) are not tracked: they are covered by permission prompts and snapshots.

const path = require('node:path');
const { bus: defaultBus, TYPES } = require('./events');

const CI = process.platform === 'win32' || process.platform === 'darwin';
const TTL_MS = 15 * 60 * 1000;
const held = new Map();            // key -> { owner, tool, at }
let alive = null;                  // (ownerSessionId) => boolean, set by the server

const keyOf = (abs) => { const p = path.resolve(abs); return CI ? p.toLowerCase() : p; };

/** Claim `abs` for `owner` (the top-level session id). Returns { ok:true } or { ok:false, holder:{ owner, tool, at } }. */
function acquire(owner, abs, tool = '', now = Date.now()) {
  const k = keyOf(abs);
  const h = held.get(k);
  if (h && h.owner !== owner && now - h.at < TTL_MS && alive && alive(h.owner)) return { ok: false, holder: { ...h } };
  held.set(k, { owner, tool, at: now });
  return { ok: true };
}

function releaseAll(owner) {
  let n = 0;
  for (const [k, h] of held) if (h.owner === owner) { held.delete(k); n++; }
  return n;
}

/** fn(ownerSessionId) -> true while that session's run is active. */
function setLiveness(fn) { alive = typeof fn === 'function' ? fn : null; }

function holderOf(abs) { const h = held.get(keyOf(abs)); return h ? { ...h } : null; }
function count() { return held.size; }
function clear() { held.clear(); }

let off = [];
/** Release a session's claims when its run ends. Idempotent. */
function attach(bus = defaultBus) {
  detach();
  const end = (ev) => { if (ev && !ev.isChild && ev.sessionId) releaseAll(ev.sessionId); };
  off = [bus.on(TYPES.AGENT_FINISHED, end), bus.on(TYPES.AGENT_FAILED, end), bus.on(TYPES.AGENT_ABORTED, end)];
}
function detach() { for (const f of off) { try { f(); } catch { /* already gone */ } } off = []; }

module.exports = { acquire, releaseAll, holderOf, setLiveness, count, clear, attach, detach, TTL_MS };
