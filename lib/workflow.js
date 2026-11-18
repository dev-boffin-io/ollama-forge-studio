'use strict';

// Dynamic workflows: capacity control (global semaphore + FIFO queue) and the task tree for recursive subagents.
//
// - At most `maxConcurrent` subagents run their model loop at the same time; the rest wait in a queue.
// - A subagent that is itself waiting for its own children gives its slot back ("waiting") and re-queues for it
//   afterwards, so parents blocked on children can never starve the children of slots (no deadlock).
// - Every subagent is a node in a tree (id = its session id) so an agent can see all of its descendants at once.

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_CONCURRENT = 20;
const MAX_FINISHED_NODES = 500;           // finished nodes kept for the task tree; oldest are pruned

const intOr = (v, d) => (Number.isInteger(v) && v >= 1 ? v : d);

class WorkflowManager {
  constructor() {
    this.maxDepth = DEFAULT_MAX_DEPTH;
    this.maxConcurrent = DEFAULT_MAX_CONCURRENT;
    this.reset();
  }

  reset() {
    this.active = 0;
    this.nodes = new Map();               // id -> node
    this.queue = [];                      // waiters: { node, resolve, reject, onAbort, signal }
  }

  /** Apply limits from config.workflow ({ maxDepth, maxConcurrent }); invalid values fall back to the defaults. */
  configure(config) {
    const w = (config && config.workflow) || {};
    this.maxDepth = intOr(w.maxDepth, DEFAULT_MAX_DEPTH);
    this.maxConcurrent = intOr(w.maxConcurrent, DEFAULT_MAX_CONCURRENT);
    this._drain();                        // a raised limit may free queued agents right away
    return this;
  }

  depthError(depth) {
    return depth > this.maxDepth ? `Error: Maximum recursion depth (${this.maxDepth}) reached.` : null;
  }

  /** Message for the model when its subagent has to wait for a slot. */
  queuedMessage() {
    return { status: 'queued', message: `Subagent is in queue. Current active agents: ${this.active}. It will start when a slot becomes available.` };
  }

  /** Add (or reset, when a subagent session is resumed) a node in the task tree. */
  register({ id, parentId = null, agent = '', description = '', depth = 1 }) {
    const prev = this.nodes.get(id);
    if (prev && prev.holds) this._releaseSlot(prev);
    const node = { id, parentId, agent, description, depth, status: 'queued', holds: false, pending: 0, startedAt: null, endedAt: null };
    this.nodes.set(id, node);
    return node;
  }

  get(id) { return this.nodes.get(id) || null; }
  isFull() { return this.active >= this.maxConcurrent; }

  /** Wait for a free slot. Resolves when the node may run. Rejects (and leaves the queue) if `signal` aborts. */
  acquire(id, { signal, front = false } = {}) {
    const node = this._need(id);
    if (signal && signal.aborted) return Promise.reject(new Error('aborted'));
    if (this.active < this.maxConcurrent && !this.queue.length) { this._grant(node); return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const w = { node, resolve, reject, signal, onAbort: null };
      if (signal) {
        w.onAbort = () => { this.queue = this.queue.filter((x) => x !== w); node.status = 'failed'; reject(new Error('aborted')); };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      if (front) this.queue.unshift(w); else this.queue.push(w);
      node.status = node.startedAt ? 'waiting' : 'queued';
    });
  }

  /** The node is about to wait for its own children: hand the slot back (counted, parallel children are fine). */
  suspend(id) {
    const node = this.nodes.get(id);
    if (!node) return;                    // the root agent holds no slot
    node.pending++;
    if (node.pending === 1 && node.holds) { this._releaseSlot(node); node.status = 'waiting'; }
  }

  /** Children are done: take a slot again (resumed work goes ahead of not-yet-started agents). */
  async resume(id, { signal } = {}) {
    const node = this.nodes.get(id);
    if (!node) return;
    node.pending = Math.max(0, node.pending - 1);
    if (node.pending === 0 && !node.holds && node.status !== 'completed' && node.status !== 'failed') {
      await this.acquire(id, { signal, front: true });
    }
  }

  /** Subagent finished: free its slot (starting the next queued one) and record the outcome. */
  finish(id, status = 'completed') {
    const node = this.nodes.get(id);
    if (!node) return;
    if (node.holds) this._releaseSlot(node);
    this.queue = this.queue.filter((w) => w.node !== node);
    node.status = status === 'failed' ? 'failed' : 'completed';
    node.endedAt = Date.now();
    this._prune();
  }

  /** Nested status of every descendant of `sessionId`. */
  tree(sessionId) {
    const kids = (pid) => [...this.nodes.values()].filter((n) => n.parentId === pid)
      .map((n) => ({ task_id: n.id, agent: n.agent, description: n.description, status: n.status, depth: n.depth, children: kids(n.id) }));
    return kids(sessionId);
  }

  counts() {
    const c = { queued: 0, running: 0, waiting: 0, completed: 0, failed: 0 };
    for (const n of this.nodes.values()) c[n.status] = (c[n.status] || 0) + 1;
    return { ...c, active: this.active, limit: this.maxConcurrent, maxDepth: this.maxDepth };
  }

  /* ---- internals ---- */
  _need(id) { const n = this.nodes.get(id); if (!n) throw new Error(`unknown workflow node ${id}`); return n; }

  _grant(node) {
    this.active++;
    node.holds = true;
    node.status = 'running';
    if (!node.startedAt) node.startedAt = Date.now();
  }

  _releaseSlot(node) {
    node.holds = false;
    this.active = Math.max(0, this.active - 1);
    this._drain();
  }

  _drain() {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const w = this.queue.shift();
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
      this._grant(w.node);
      w.resolve();
    }
  }

  _prune() {
    const done = [...this.nodes.values()].filter((n) => n.status === 'completed' || n.status === 'failed');
    for (const n of done.slice(0, Math.max(0, done.length - MAX_FINISHED_NODES))) this.nodes.delete(n.id);
  }
}

module.exports = { WorkflowManager, workflow: new WorkflowManager(), DEFAULT_MAX_DEPTH, DEFAULT_MAX_CONCURRENT };
