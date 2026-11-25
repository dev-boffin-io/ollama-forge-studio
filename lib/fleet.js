'use strict';

/**
 * Fleets: named groups of top-level agent sessions that the user steers together.
 *
 *  - A fleet has MEMBERS (each member is one saved session running one primary agent) and LINKS.
 *  - dispatch() sends a task to one member (or all idle members). At most `maxParallel` members run at once; the rest
 *    wait in a FIFO queue and start when a slot frees up.
 *  - A LINK  "A -> B"  is a trigger on the event bus: when A emits `agent_finished_task` (or fails, per `on`), B is
 *    dispatched automatically with A's final report filled into a template ({{result}}, {{task}}, {{from}}).
 *    Chains are capped by `maxChain` hops AND by `maxChainRuns` model runs per user task, so neither a loop A -> B -> A nor a
 *    fan-out (A -> B, A -> C, B -> C ...) can run away.
 *  - A handoff for a member that is busy is PARKED in that member's `pending` list (never dropped) and delivered, merged into one
 *    message, when its current run ends. `on: 'any'` means done or failed; a run the user aborted only triggers `on: 'aborted'` links.
 *  - Everything is announced on the bus as `fleet_updated`, which feeds the dashboard's live stream.
 *
 * The manager never starts a model run itself: the server injects configure({ start, createSession, isRunning, isWaiting }),
 * the same pattern as lib/wake.js. State (fleets, members, links, last results) is saved to <studio dir>/fleets.json;
 * runs that were active when the studio stopped come back as "idle".
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const log = require('./log');
const { bus: defaultBus, TYPES } = require('./events');

const DEFAULTS = { maxParallel: 3, maxChain: 8, maxChainRuns: 12 };
const PENDING_MAX = 20;            // parked handoffs per member
const CHAINS_KEPT = 200;
const RESULT_MAX = 4000;
const LINK_ON = ['done', 'failed', 'any', 'aborted'];
const DEFAULT_TEMPLATE = '[Fleet handoff from the "{{from}}" agent]\nThe previous agent finished its task. Its final report:\n\n{{result}}\n\nContinue with your part of the job based on that report.';

const rid = (p) => p + '_' + crypto.randomBytes(4).toString('hex');
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const render = (tpl, vars) => String(tpl || DEFAULT_TEMPLATE).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));

class FleetManager {
  /** @param {{ bus?: object, file?: string|null }} opts  file = where to persist (null = memory only) */
  constructor({ bus = defaultBus, file = null } = {}) {
    this.bus = bus;
    this.file = file;                    // path, or a function returning it (the studio dir follows the working directory)
    this.fleets = new Map();
    this.queue = [];                     // [{ fleetId, sessionId, task, hop, chain }]
    this.chains = new Map();             // chain id (one per user task) -> { runs, at }: the run budget of an automatic chain
    this.limits = { ...DEFAULTS };
    this.deps = { start: async () => false, createSession: async () => { throw bad('fleet is not wired to a server', 500); }, isRunning: () => false, isWaiting: () => false };
    this._off = [];
    this._loaded = false;
  }

  configure({ start, createSession, isRunning, isWaiting, maxParallel, maxChain, maxChainRuns } = {}) {
    if (start) this.deps.start = start;
    if (createSession) this.deps.createSession = createSession;
    if (isRunning) this.deps.isRunning = isRunning;
    if (isWaiting) this.deps.isWaiting = isWaiting;
    if (Number.isInteger(maxParallel) && maxParallel >= 1) this.limits.maxParallel = maxParallel;
    if (Number.isInteger(maxChain) && maxChain >= 1) this.limits.maxChain = maxChain;
    if (Number.isInteger(maxChainRuns) && maxChainRuns >= 1) this.limits.maxChainRuns = maxChainRuns;
    this._pump();
    return this;
  }

  /** Subscribe to the bus (idempotent). */
  attach() {
    if (this._off.length) return this;
    this._off.push(this.bus.on(TYPES.AGENT_FINISHED, (ev) => this._onEnd(ev, 'done')));
    this._off.push(this.bus.on(TYPES.AGENT_FAILED, (ev) => this._onEnd(ev, 'failed')));
    this._off.push(this.bus.on(TYPES.AGENT_ABORTED, (ev) => this._onEnd(ev, 'aborted')));
    return this;
  }

  detach() { for (const off of this._off) off(); this._off = []; }

  /* ---------- persistence ---------- */

  _file() { return typeof this.file === 'function' ? this.file() : this.file; }

  /** Forget the in-memory state (the working directory changed: the next call loads that project's fleets). */
  reset() { this.fleets.clear(); this.queue = []; this.chains.clear(); this._loaded = false; }

  _load() {
    if (this._loaded) return;
    this._loaded = true;
    const file = this._file();
    if (!file) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const f of data.fleets || []) {
        for (const m of f.members || []) {
          if (m.status === 'running' || m.status === 'queued') m.status = 'idle';   // the run did not survive the restart
          m.pending = Array.isArray(m.pending) ? m.pending : [];
        }
        this.fleets.set(f.id, { links: [], members: [], ...f });
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        log.warn('fleet', 'could not read the saved fleets (starting empty; a copy of the damaged file is kept as .broken)', e);
        try { fs.copyFileSync(file, file + '.broken'); } catch (e2) { log.debug('fleet', 'could not back up the damaged fleets file', e2); }   // the next save would otherwise overwrite it
      }
    }
  }

  _save() {
    const file = this._file();
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ fleets: [...this.fleets.values()] }), 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) { log.warn('fleet', 'could not save the fleets', e); }
  }

  _changed(fleetId) { this._save(); this.bus.emit(TYPES.FLEET_UPDATED, { fleetId }); }

  /* ---------- lookup ---------- */

  _fleet(id) { this._load(); const f = this.fleets.get(id); if (!f) throw bad('fleet not found', 404); return f; }

  _findMember(sessionId) {
    this._load();
    for (const f of this.fleets.values()) { const m = f.members.find((x) => x.sessionId === sessionId); if (m) return { fleet: f, member: m }; }
    return null;
  }

  _chain(id) {
    let c = this.chains.get(id);
    if (!c) {
      c = { runs: 0, at: Date.now() };
      this.chains.set(id, c);
      if (this.chains.size > CHAINS_KEPT) for (const k of [...this.chains.keys()].slice(0, this.chains.size - CHAINS_KEPT)) this.chains.delete(k);
    }
    return c;
  }

  /* ---------- fleets, members, links ---------- */

  async create({ name = '', members = [] } = {}) {
    this._load();
    const fleet = { id: rid('flt'), name: String(name || '').trim().slice(0, 60) || `Fleet ${this.fleets.size + 1}`, createdAt: Date.now(), members: [], links: [] };
    this.fleets.set(fleet.id, fleet);
    try { for (const m of members) await this.addMember(fleet.id, m, { silent: true }); } catch (e) { this.fleets.delete(fleet.id); throw e; }
    this._changed(fleet.id);
    return fleet;
  }

  async addMember(fleetId, { agent = 'build', model = '', title = '', sessionId = '' } = {}, { silent = false } = {}) {
    const fleet = this._fleet(fleetId);
    let id = sessionId;
    if (id) { if (this._findMember(id)) throw bad('that session already belongs to a fleet', 409); }
    else id = (await this.deps.createSession({ agent, model, title })).id;
    const member = { sessionId: id, agent, model, title: String(title || '').slice(0, 60), status: 'idle', lastTask: '', lastResult: '', lastError: '', startedAt: null, endedAt: null, runs: 0, hop: 0, chain: null, pending: [] };
    fleet.members.push(member);
    if (!silent) this._changed(fleetId);
    return member;
  }

  removeMember(fleetId, sessionId) {
    const fleet = this._fleet(fleetId);
    if (!fleet.members.some((m) => m.sessionId === sessionId)) throw bad('member not found', 404);
    fleet.members = fleet.members.filter((m) => m.sessionId !== sessionId);
    fleet.links = fleet.links.filter((l) => l.from !== sessionId && l.to !== sessionId);
    this.queue = this.queue.filter((q) => q.sessionId !== sessionId);
    this._changed(fleetId);
  }

  removeFleet(fleetId) {
    const fleet = this._fleet(fleetId);
    const ids = new Set(fleet.members.map((m) => m.sessionId));
    this.queue = this.queue.filter((q) => !ids.has(q.sessionId));
    this.fleets.delete(fleetId);
    this._changed(fleetId);
    return [...ids];
  }

  link(fleetId, { from, to, on = 'done', template = '' } = {}) {
    const fleet = this._fleet(fleetId);
    if (!from || !to) throw bad('link needs "from" and "to"');
    if (from === to) throw bad('an agent cannot trigger itself');
    if (!LINK_ON.includes(on)) throw bad(`"on" must be one of ${LINK_ON.join(', ')}`);
    for (const id of [from, to]) if (!fleet.members.some((m) => m.sessionId === id)) throw bad(`${id} is not a member of this fleet`);
    if (fleet.links.some((l) => l.from === from && l.to === to && l.on === on)) throw bad('that link already exists', 409);
    const l = { id: rid('lnk'), from, to, on, template: String(template || '').slice(0, 4000) };
    fleet.links.push(l);
    this._changed(fleetId);
    return l;
  }

  unlink(fleetId, linkId) {
    const fleet = this._fleet(fleetId);
    const before = fleet.links.length;
    fleet.links = fleet.links.filter((l) => l.id !== linkId);
    if (fleet.links.length === before) throw bad('link not found', 404);
    this._changed(fleetId);
  }

  /* ---------- dispatch ---------- */

  _active() { let n = 0; for (const f of this.fleets.values()) for (const m of f.members) if (m.status === 'running') n++; return n; }

  /**
   * Send `task` to one member (sessionId) or to every idle member ('all').
   * Returns [{ sessionId, status: 'started' | 'queued' | 'busy' }]; a busy member is skipped, never interrupted.
   * One user dispatch = one chain (shared run budget for everything it triggers automatically).
   */
  async dispatch(fleetId, { member = 'all', task = '' } = {}, { hop = 0, chain = null } = {}) {
    const fleet = this._fleet(fleetId);
    const text = String(task || '').trim();
    if (!text) throw bad('the task is empty');
    const targets = member === 'all'
      ? fleet.members.filter((m) => m.status !== 'running' && m.status !== 'queued')
      : fleet.members.filter((m) => m.sessionId === member);
    if (!targets.length) throw bad(member === 'all' ? 'no idle member to dispatch to' : 'member not found', member === 'all' ? 409 : 404);
    const chainId = chain || rid('chn');
    const out = [];
    for (const m of targets) out.push({ sessionId: m.sessionId, status: await this._send(fleet, m, text, hop, chainId) });
    return out;
  }

  _isBusy(m) { return m.status === 'running' || m.status === 'queued' || this.deps.isRunning(m.sessionId); }

  /** Handoffs that arrived while the member was busy, merged oldest first with `text` (which may be empty). */
  _mergePending(m, text, hop, chain) {
    const items = m.pending.splice(0);
    const parts = items.map((i) => i.text);
    if (text) parts.push(text);
    const body = parts.length === 1 ? parts[0] : `[${parts.length} fleet handoffs arrived while you were busy, oldest first]\n\n` + parts.map((p, i) => `--- handoff ${i + 1} ---\n${p}`).join('\n\n');
    return { text: body, hop: Math.max(hop, ...items.map((i) => i.hop || 0)), chain: text ? chain : (items[0] && items[0].chain) || chain };
  }

  /**
   * park = true (automatic handoffs): a busy target keeps the handoff in `pending` instead of losing it.
   * Returns 'started' | 'queued' | 'busy' | 'parked' | 'dropped'.
   */
  async _send(fleet, m, text, hop, chainId, { park = false } = {}) {
    if (this._isBusy(m)) {
      if (!park) return 'busy';
      if (m.pending.length >= PENDING_MAX) {
        m.lastError = `a handoff was dropped: ${PENDING_MAX} handoffs are already waiting for this agent`;
        log.warn('fleet', `${m.agent}: ${m.lastError}`);
        this._changed(fleet.id);
        return 'dropped';
      }
      m.pending.push({ text, hop, chain: chainId, at: Date.now() });
      this._changed(fleet.id);
      return 'parked';
    }
    if (m.pending.length) ({ text, hop, chain: chainId } = this._mergePending(m, text, hop, chainId));
    if (!text) return 'busy';
    if (this._active() >= this.limits.maxParallel) {
      m.status = 'queued'; m.lastTask = text; m.hop = hop;
      this.queue.push({ fleetId: fleet.id, sessionId: m.sessionId, task: text, hop, chain: chainId });
      this._changed(fleet.id);
      return 'queued';
    }
    return this._startNow(fleet, m, text, hop, chainId);
  }

  async _startNow(fleet, m, text, hop, chainId) {
    const chain = this._chain(chainId || rid('chn'));
    chain.runs += 1; chain.at = Date.now();
    m.status = 'running'; m.lastTask = text; m.lastError = ''; m.startedAt = Date.now(); m.endedAt = null; m.hop = hop; m.chain = chainId;
    this._changed(fleet.id);
    let ok = false;
    try { ok = await this.deps.start(m.sessionId, text, { fleetId: fleet.id, hop }); } catch (e) { m.lastError = String(e && e.message || e).slice(0, 300); log.warn('fleet', `could not start ${m.sessionId}`, e); }
    if (!ok) {
      chain.runs = Math.max(0, chain.runs - 1);
      m.status = m.lastError ? 'failed' : 'idle';
      m.endedAt = Date.now();
      this._changed(fleet.id);
      return 'busy';
    }
    return 'started';
  }

  _pump() {
    while (this.queue.length && this._active() < this.limits.maxParallel) {
      const q = this.queue.shift();
      const found = this._findMember(q.sessionId);
      if (!found || found.member.status !== 'queued') continue;
      this._startNow(found.fleet, found.member, q.task, q.hop, q.chain).catch((e) => log.warn('fleet', 'queued start failed', e));
    }
  }

  /** The member just finished: deliver what was parked while it was busy (one merged message), unless the chain's run budget is used up. */
  _drain(fleet, member) {
    if (!member.pending.length) return;
    const chainId = member.pending[0].chain;
    if (chainId && this._chain(chainId).runs >= this.limits.maxChainRuns) {
      member.lastError = `${member.pending.length} waiting handoff(s) discarded: automatic chain reached its limit of ${this.limits.maxChainRuns} runs (run budget)`;
      log.warn('fleet', `${member.agent}: ${member.lastError}`);
      member.pending = [];
      return;
    }
    this._send(fleet, member, '', 0, chainId).catch((e) => log.warn('fleet', 'delivering parked handoffs failed', e));
  }

  /** Stop a member: abort handled by the server (its run); a queued member just leaves the queue. */
  cancelQueued(sessionId) {
    const found = this._findMember(sessionId);
    if (!found || found.member.status !== 'queued') return false;
    this.queue = this.queue.filter((q) => q.sessionId !== sessionId);
    found.member.status = 'idle';
    this._changed(found.fleet.id);
    return true;
  }

  /* ---------- bus reactions ---------- */

  _onEnd(ev, outcome) {
    if (!ev || ev.isChild) return;                 // subagents belong to their parent's run
    const found = this._findMember(ev.sessionId);
    if (!found) return;
    const { fleet, member } = found;
    member.status = outcome;
    member.endedAt = ev.ts || Date.now();
    member.runs += 1;
    if (outcome === 'done') { member.lastResult = String(ev.final || '').slice(0, RESULT_MAX); member.lastError = ''; }
    if (outcome === 'failed') member.lastError = String(ev.error || 'failed').slice(0, 300);
    if (outcome === 'aborted' && member.pending.length) {      // the user stopped this agent: do not feed it more work behind their back
      member.lastError = `${member.pending.length} waiting handoff(s) discarded because the run was aborted`;
      member.pending = [];
    }
    // "any" = done or failed. A run the USER aborted only triggers links that say so explicitly (on: 'aborted').
    const wanted = outcome === 'done' ? ['done', 'any'] : outcome === 'failed' ? ['failed', 'any'] : ['aborted'];
    const hop = (member.hop || 0) + 1;
    const chainId = member.chain || rid('chn');
    const chain = this._chain(chainId);
    for (const l of fleet.links.filter((x) => x.from === member.sessionId && wanted.includes(x.on))) {
      const target = fleet.members.find((x) => x.sessionId === l.to);
      if (!target) continue;
      if (hop > this.limits.maxChain) {
        log.warn('fleet', `chain stopped at ${member.agent} -> ${target.agent}: more than ${this.limits.maxChain} automatic hops without the user`);
        target.lastError = `automatic chain stopped after ${this.limits.maxChain} hops (loop guard)`;
        continue;
      }
      if (chain.runs >= this.limits.maxChainRuns) {
        log.warn('fleet', `chain stopped at ${member.agent} -> ${target.agent}: ${chain.runs} runs already started by one task`);
        target.lastError = `automatic chain stopped after ${chain.runs} runs (run budget; raise fleet.maxChainRuns if this is intended)`;
        continue;
      }
      const text = render(l.template, { result: member.lastResult || (outcome === 'done' ? '(no final message)' : `(the agent ${outcome}: ${member.lastError || 'no output'})`), from: member.agent, task: member.lastTask });
      this._send(fleet, target, text, hop, chainId, { park: true }).catch((e) => log.warn('fleet', 'trigger failed', e));
    }
    this._drain(fleet, member);
    this._changed(fleet.id);
    this._pump();
  }

  /* ---------- status ---------- */

  status() {
    this._load();
    const fleets = [...this.fleets.values()].map((f) => ({
      id: f.id, name: f.name, createdAt: f.createdAt,
      links: f.links.map((l) => ({ ...l })),
      members: f.members.map((m) => ({ ...m, pending: (m.pending || []).length, waiting: m.status === 'running' && !!this.deps.isWaiting(m.sessionId) })),
    }));
    const counts = { idle: 0, queued: 0, running: 0, waiting: 0, done: 0, failed: 0, aborted: 0 };
    for (const f of fleets) for (const m of f.members) { counts[m.status] = (counts[m.status] || 0) + 1; if (m.waiting) counts.waiting++; }
    return { fleets, counts, maxParallel: this.limits.maxParallel, maxChain: this.limits.maxChain, maxChainRuns: this.limits.maxChainRuns, active: this._active(), queued: this.queue.length };
  }
}

module.exports = { FleetManager, render, DEFAULT_TEMPLATE };
