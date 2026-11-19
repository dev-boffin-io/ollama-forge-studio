'use strict';

/**
 * Optional embedding client for the vector half of the project memory (lib/recall.js).
 *
 * Off by default: set `embedModel` in the config to a model ref ("nomic-embed-text", "ollama2/bge-m3",
 * "openai/text-embedding-3-small" ...). Without it the memory is keyword-only (BM25) exactly as before.
 *
 *   ollama  -> POST <endpoint>/api/embed        { model, input: [..] }  -> { embeddings: [[..]] }
 *   openai  -> POST <endpoint>/embeddings       { model, input: [..] }  -> { data: [{ embedding }] }   (any OpenAI-compatible API)
 *   anthropic has no embeddings API -> memory stays keyword-only for that provider.
 *
 * Vectors come back L2-normalised as Float32Array, so cosine similarity is a plain dot product.
 * After a failure the client backs off for a minute instead of hammering a missing model or a sleeping server.
 */

const log = require('./log');
const llm = require('./llm');
const { fetchOk, explain } = require('./errors');

const BATCH = 16;
const MAX_CHARS = 2000;
const BACKOFF_MS = 60000;
const TIMEOUT_MS = 60000;

const state = { failedUntil: 0, lastError: '', lastOkAt: 0 };

const base = (e) => String(e || '').trim().replace(/\/+$/, '');

/** The configured embedding model as { provider, model, key }, or null when embeddings are off / unsupported. */
function target(config) {
  const ref = String((config && config.embedModel) || '').trim();
  if (!ref) return null;
  const { provider, model } = llm.resolve(config, ref);
  if (!provider || provider.type === 'anthropic' || !model) return null;
  return { provider, model, key: `${provider.id}|${provider.endpoint}|${model}` };
}

const enabled = (config) => !!target(config);

function normalize(arr) {
  const v = Float32Array.from(arr);
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

async function request(t, inputs, signal) {
  const { provider, model } = t;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const onAbort = () => ac.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (provider.type === 'openai') {
      const headers = { 'Content-Type': 'application/json', ...(provider.headers || {}) };
      if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
      const res = await fetchOk(`${base(provider.endpoint)}/embeddings`, { method: 'POST', headers, body: JSON.stringify({ model, input: inputs }), signal: ac.signal }, { source: `${provider.id} embeddings`, where: base(provider.endpoint) });
      const j = await res.json();
      const rows = (j.data || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0)).map((d) => d.embedding);
      return rows;
    }
    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    const res = await fetchOk(`${base(provider.endpoint)}/api/embed`, { method: 'POST', headers, body: JSON.stringify({ model, input: inputs }), signal: ac.signal }, { source: 'Ollama embed', where: base(provider.endpoint) });
    const j = await res.json();
    return j.embeddings || [];
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Embed many texts. Returns { model, vectors: Float32Array[] } (same order), or null when embeddings are off,
 * backing off, or the call failed (the caller then simply stays keyword-only).
 */
async function embed(config, texts, { signal } = {}) {
  const t = target(config);
  if (!t || !texts.length) return null;
  if (Date.now() < state.failedUntil) return null;
  const vectors = [];
  try {
    for (let i = 0; i < texts.length; i += BATCH) {
      const slice = texts.slice(i, i + BATCH).map((x) => String(x).slice(0, MAX_CHARS));
      const rows = await request(t, slice, signal);
      if (rows.length !== slice.length) throw new Error(`the embedding server returned ${rows.length} vectors for ${slice.length} texts`);
      for (const r of rows) {
        if (!Array.isArray(r) || !r.length) throw new Error('the embedding server returned an empty vector');
        vectors.push(normalize(r));
      }
    }
  } catch (e) {
    if (signal && signal.aborted) return null;
    state.failedUntil = Date.now() + BACKOFF_MS;
    state.lastError = explain(e, t.provider.endpoint).slice(0, 300);
    log.warn('embed', `embeddings unavailable for ${BACKOFF_MS / 1000}s — memory stays keyword-only meanwhile`, e);
    return null;
  }
  state.lastOkAt = Date.now();
  state.lastError = '';
  state.failedUntil = 0;
  return { model: t.key, vectors };
}

const dot = (a, b) => { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; };

/** Float32Array <-> Buffer for the SQLite BLOB column. */
const toBlob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b) => { const out = new Float32Array(Math.floor(b.byteLength / 4)); new Uint8Array(out.buffer).set(new Uint8Array(b.buffer, b.byteOffset, out.length * 4)); return out; };   // copy: a pooled Buffer is not 4-byte aligned

function status(config) {
  const t = target(config);
  return {
    enabled: !!t, model: t ? `${t.provider.id}/${t.model}` : '',
    backingOff: Date.now() < state.failedUntil, lastError: state.lastError, lastOkAt: state.lastOkAt,
  };
}

const resetBackoff = () => { state.failedUntil = 0; state.lastError = ''; };

module.exports = { target, enabled, embed, dot, toBlob, fromBlob, status, resetBackoff, normalize };
