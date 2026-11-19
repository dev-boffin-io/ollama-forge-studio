'use strict';

/**
 * Studio event bus — one in-process place where the parts of the studio announce what just happened, so other parts
 * (the fleet manager, the dashboard's live stream, plugins) can react without being wired to each other.
 *
 * Event types used by the studio:
 *   agent_started        { sessionId, agent, model, parentId?, isChild }
 *   agent_finished_task  { sessionId, agent, ok:true, final, iterations, truncated, parentId?, isChild }
 *   agent_failed         { sessionId, agent, error, parentId?, isChild }
 *   agent_aborted        { sessionId, agent, parentId?, isChild }
 *   memory_recalled      { sessionId, count, query, via }
 *   memory_embedded      { done, pending }
 *   fleet_updated        { fleetId }
 *
 * Every event gets a growing `seq` and a timestamp. The last HISTORY events are kept so a dashboard that (re)connects
 * can catch up (`since(seq)`), which also backs the Last-Event-ID replay of GET /api/events.
 * A throwing (or rejecting) listener never breaks the emitter or the other listeners.
 */

const { EventEmitter } = require('node:events');
const log = require('./log');

const HISTORY = 500;

const TYPES = Object.freeze({
  AGENT_STARTED: 'agent_started',
  AGENT_FINISHED: 'agent_finished_task',
  AGENT_FAILED: 'agent_failed',
  AGENT_ABORTED: 'agent_aborted',
  MEMORY_RECALLED: 'memory_recalled',
  MEMORY_EMBEDDED: 'memory_embedded',
  FLEET_UPDATED: 'fleet_updated',
});

class EventBus {
  constructor(history = HISTORY) {
    this.em = new EventEmitter();
    this.em.setMaxListeners(0);
    this.limit = history;
    this.reset();
  }

  reset() {
    this.seq = 0;
    this.history = [];
    this.em.removeAllListeners();
  }

  /** Publish an event. Returns the stored event ({ seq, ts, type, ...data }). */
  emit(type, data = {}) {
    const ev = { seq: ++this.seq, ts: Date.now(), type, ...data };
    this.history.push(ev);
    if (this.history.length > this.limit) this.history.splice(0, this.history.length - this.limit);
    this.em.emit(type, ev);
    this.em.emit('*', ev);
    return ev;
  }

  _safe(fn, type) {
    return (ev) => {
      try {
        const r = fn(ev);
        if (r && typeof r.catch === 'function') r.catch((e) => log.warn('events', `async listener for "${type}" failed`, e));
      } catch (e) { log.warn('events', `listener for "${type}" failed`, e); }
    };
  }

  /** Listen to one type ('*' = everything). Returns an unsubscribe function. */
  on(type, fn) {
    const wrapped = this._safe(fn, type);
    this.em.on(type, wrapped);
    return () => this.em.off(type, wrapped);
  }

  /** Like on(), but only the first matching event (optionally filtered by `where(ev)`). */
  once(type, fn, where = null) {
    const off = this.on(type, (ev) => {
      if (where && !where(ev)) return;
      off();
      return fn(ev);
    });
    return off;
  }

  /** Events newer than `seq` (optionally only some types), oldest first. */
  since(seq = 0, types = null) {
    const want = types ? new Set(types) : null;
    return this.history.filter((e) => e.seq > seq && (!want || want.has(e.type)));
  }
}

module.exports = { EventBus, bus: new EventBus(), TYPES };
