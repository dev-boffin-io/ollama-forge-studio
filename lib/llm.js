'use strict';

// Provider layer. Model reference = "<providerId>/<model>" or a bare model name on the default provider.
// Providers (config.providers): { id: { type: "ollama" | "openai", endpoint, apiKey?, apiKeyEnv?, headers?, contextWindow? } }

const ollama = require('./ollama');
const openai = require('./openai');
const anthropic = require('./anthropic');

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

async function listModels(provider) {
  if (provider.type === 'anthropic') return anthropic.listModels(provider);
  if (provider.type === 'openai') return openai.listModels(provider);
  return ollama.listModels(provider.endpoint, 30000, provider.apiKey);
}

/** All models of all providers; unreachable providers are reported, not thrown. */
async function listAll(config) {
  const out = [];
  await Promise.all(Object.values(providersOf(config)).map(async (p) => {
    try {
      for (const m of await listModels(p)) out.push({ ...m, provider: p.id, ref: `${p.id}/${m.name}`, providerType: p.type });
    } catch (err) { out.push({ provider: p.id, error: String(err.message || err), providerType: p.type }); }
  }));
  return out;
}

const ctxCache = new Map();

/** Effective context window: explicit config.numCtx > provider setting > detected from Ollama > default. */
async function contextWindow(config, provider, model) {
  if (Number(config.numCtx) > 0) return Number(config.numCtx);
  const maxAuto = Number(config.autoCtxMax) || 131072;
  if (provider.contextWindow) return Number(provider.contextWindow);
  if (provider.type === 'anthropic') return 200000;
  if (provider.type === 'openai') return /generativelanguage\.googleapis/.test(provider.endpoint || '') ? 1000000 : 128000;
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
    } catch { /* unreachable or old server */ }
    ctxCache.set(key, detected);
  }
  const d = ctxCache.get(key);
  return d ? Math.min(d, maxAuto) : 32768;
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
    } catch { return false; }          // unreachable: don't cache, try again next time
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

module.exports = { DEFAULT_ID, providersOf, resolve, chatStream, listModels, listAll, contextWindow, supportsVision, maskConfig };
