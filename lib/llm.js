'use strict';

const log = require('./log');

// Provider layer. Model reference = "<providerId>/<model>" or a bare model name on the default provider.
// Providers (config.providers): { id: { type: "ollama" | "openai", endpoint, apiKey?, apiKeyEnv?, headers?, contextWindow? } }

const ollama = require('./ollama');
const openai = require('./openai');
const anthropic = require('./anthropic');
const { explain, isRetryable } = require('./errors');

// Provider types: "ollama" (API key optional), "openai" (OpenAI, Groq, Gemini, OpenRouter, LM Studio, vLLM ... any OpenAI-compatible API), "anthropic" (Claude).
const TYPES = ['ollama', 'openai', 'anthropic'];

const DEFAULT_ID = 'default';

function providersOf(config) {
  const out = {};
  out[DEFAULT_ID] = { type: 'ollama', endpoint: config.endpoint, apiKey: config.apiKey, apiKeyEnv: config.apiKeyEnv };
  for (const [id, p] of Object.entries(config.providers || {})) {
    if (!p || !p.endpoint) continue;
    out[id] = { ...p, type: TYPES.includes(p.type) ? p.type : 'ollama' };
  }
  for (const [id, p] of Object.entries(out)) {
    p.id = id;
    const key = p.apiKey || (p.apiKeyEnv ? process.env[p.apiKeyEnv] : '');
    p.apiKey = key || '';
  }
  return out;
}

/** "openrouter/meta/llama" -> { provider, model } ; "llama3:8b" -> default provider. */
function resolve(config, ref) {
  const all = providersOf(config);
  const text = String(ref || '');
  const slash = text.indexOf('/');
  if (slash > 0 && all[text.slice(0, slash)]) return { provider: all[text.slice(0, slash)], model: text.slice(slash + 1) };
  const def = all[config.defaultProvider] || all[DEFAULT_ID];
  return { provider: def, model: text };
}

function chatStream(args) {
  // `endpoint` may be passed as a plain URL (legacy) or a provider object
  const provider = args.provider || (typeof args.endpoint === 'object' && args.endpoint) || { type: 'ollama', endpoint: args.endpoint };
  if (provider.type === 'anthropic') return anthropic.chatStream({ ...args, provider });
  if (provider.type === 'openai') return openai.chatStream({ ...args, provider });
  return ollama.chatStream({ ...args, endpoint: provider.endpoint, apiKey: provider.apiKey });
}

async function listModels(provider, timeoutMs = 30000) {
  if (provider.type === 'anthropic') return anthropic.listModels(provider, timeoutMs);
  if (provider.type === 'openai') return openai.listModels(provider, timeoutMs);
  return ollama.listModels(provider.endpoint, timeoutMs, provider.apiKey);
}

const modelCache = new Map();      // provider key -> { at, models } — last good answer, used when a flaky tunnel does not answer
const cacheKeyOf = (p) => `${p.type}|${p.endpoint}`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Model list of ONE provider, tolerant of first-contact hiccups (a fresh tunnel URL needs a moment to resolve; a sleeping
 * server wakes up): up to 3 quick attempts, then the last good list (marked stale) if there is one.
 */
async function listWithRetry(p, { attempts = 3, timeoutMs = 12000 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const models = await listModels(p, timeoutMs);
      modelCache.set(cacheKeyOf(p), { at: Date.now(), models });
      return { models, stale: '' };
    } catch (e) {
      last = e;
      log.debug('llm', `listing models of ${p.id} failed (attempt ${i + 1}/${attempts})`, e);
      if (!isRetryable(e) || i === attempts - 1) break;
      await pause(600 * (i + 1) ** 2);          // 0.6 s, 2.4 s
    }
  }
  const cached = modelCache.get(cacheKeyOf(p));
  if (cached) return { models: cached.models, stale: explain(last, p.endpoint) };
  throw last;
}

/** All models of all providers; unreachable providers are reported, not thrown. */
async function listAll(config) {
  const out = [];
  await Promise.all(Object.values(providersOf(config)).map(async (p) => {
    try {
      const { models, stale } = await listWithRetry(p);
      for (const m of models) out.push({ ...m, provider: p.id, ref: `${p.id}/${m.name}`, providerType: p.type, ...(stale ? { stale } : {}) });
    } catch (err) { out.push({ provider: p.id, error: explain(err, p.endpoint), providerType: p.type }); }
  }));
  return out;
}

const ctxCache = new Map();
const learnedWindow = new Map();     // provider|model -> a window we have SEEN the server accept (larger than the detected/assumed one)
const windowKey = (p, m) => `${p.endpoint}|${m}`;
function learnContextWindow(provider, model, tokens) {
  const k = windowKey(provider, model);
  if (tokens > (learnedWindow.get(k) || 0)) learnedWindow.set(k, tokens);
}

/** Effective context window: explicit config.numCtx > provider setting > detected from Ollama > default. */
async function contextWindow(config, provider, model) {
  if (Number(config.numCtx) > 0) return Number(config.numCtx);
  const learned = learnedWindow.get(windowKey(provider, model)) || 0;
  const maxAuto = Number(config.autoCtxMax) || 131072;
  if (provider.contextWindow) return Number(provider.contextWindow);
  if (provider.type === 'anthropic') return Math.max(200000, learned);
  if (provider.type === 'openai') return Math.max(/generativelanguage\.googleapis/.test(provider.endpoint || '') ? 1000000 : 128000, learned);
  const key = `${provider.endpoint}|${model}`;
  if (!ctxCache.has(key)) {
    let detected = 0;
    try {
      const res = await fetch(`${String(provider.endpoint).replace(/\/+$/, '')}/api/show`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...ollama.authHeaders(provider.apiKey) }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const info = (await res.json()).model_info || {};
        const k = Object.keys(info).find((x) => x.endsWith('.context_length'));
        if (k) detected = Number(info[k]) || 0;
      }
    } catch (e) { log.debug('llm', `context length of ${model} unknown (unreachable or old server)`, e); }
    ctxCache.set(key, detected);
  }
  const d = ctxCache.get(key);
  return Math.max(d ? Math.min(d, maxAuto) : 32768, learned);
}

const visionCache = new Map();

/** Can this model take images? config.vision (true/false) overrides; Ollama is asked via /api/show; OpenAI-type is guessed from the name. */
async function supportsVision(config, provider, model) {
  if (config.vision === true) return true;
  if (config.vision === false) return false;
  if (provider.type === 'anthropic') return true;
  if (provider.type === 'openai') {
    return /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|(^|[^a-z])o[134]([^a-z]|$)|vision|llava|pixtral|gemini|claude|qwen.*vl|gemma-?3|llama-?3\.2.*(11|90)b|llama-?4|minicpm-v|internvl/i.test(model);
  }
  const key = `${provider.endpoint}|${model}`;
  const hit = visionCache.get(key);
  if (hit && Date.now() - hit.at > 300000) visionCache.delete(key);   // re-check after 5 min
  if (!visionCache.has(key)) {
    try {
      const res = await fetch(`${String(provider.endpoint).replace(/\/+$/, '')}/api/show`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...ollama.authHeaders(provider.apiKey) }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return false;
      const j = await res.json();
      const caps = Array.isArray(j.capabilities) ? j.capabilities : [];
      const info = Object.keys(j.model_info || {});
      const fam = (j.details && j.details.families) || [];
      visionCache.set(key, { at: Date.now(), ok: caps.includes('vision') || info.some((k) => /\.vision\.|\.clip\.|projector/i.test(k)) || fam.includes('clip') || !!j.projector_info });
    } catch (e) { log.debug('llm', `vision check for ${model} failed`, e); return false; }          // unreachable: don't cache, try again next time
  }
  return visionCache.get(key).ok;
}

/** Hide secrets when sending config to the browser. */
function maskConfig(config) {
  const c = JSON.parse(JSON.stringify(config));
  for (const p of Object.values(c.providers || {})) if (p.apiKey) p.apiKey = '••••' + String(p.apiKey).slice(-4);
  if (c.apiKey) c.apiKey = '••••' + String(c.apiKey).slice(-4);
  return c;
}

module.exports = { listWithRetry, learnContextWindow, DEFAULT_ID, providersOf, resolve, chatStream, listModels, listAll, contextWindow, supportsVision, maskConfig };
