'use strict';

const log = require('./log');

// OpenAI-compatible chat client (OpenAI, OpenRouter, Groq, LM Studio, llama.cpp server, vLLM, Together ...).
// Messages are stored in Ollama style internally; they are converted here.

const { fetchOk } = require('./errors');

const DEFAULT_TIMEOUT = 600000;

const base = (endpoint) => String(endpoint || '').trim().replace(/\/+$/, '');

function headers(provider) {
  const h = { 'Content-Type': 'application/json', ...(provider.headers || {}) };
  if (provider.apiKey) h.Authorization = `Bearer ${provider.apiKey}`;
  return h;
}

function toWire(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      return {
        role: 'assistant', content: m.content || null,
        tool_calls: m.tool_calls.map((c, i) => ({
          id: c.id || `call_${i}`, type: 'function',
          function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments || {}) },
        })),
      };
    }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content ?? '') };
    if (m.role === 'user' && m.images && m.images.length) {
      const mime = (b) => (b.startsWith('iVBOR') ? 'image/png' : b.startsWith('/9j/') ? 'image/jpeg' : b.startsWith('R0lGOD') ? 'image/gif' : b.startsWith('UklGR') ? 'image/webp' : 'image/png');
      return { role: 'user', content: [{ type: 'text', text: m.content ?? '' }, ...m.images.map((b) => ({ type: 'image_url', image_url: { url: `data:${mime(b)};base64,${b}` } }))] };
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

async function listModels(provider, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchOk(`${base(provider.endpoint)}/models`, { headers: headers(provider), signal: controller.signal }, { source: `${provider.id || 'provider'} models`, where: base(provider.endpoint) });
    const data = await res.json();
    return (data.data || data.models || []).map((m) => ({ name: String(m.id || m.name).replace(/^models\//, ''), capabilities: [] }));
  } finally { clearTimeout(timer); }
}

async function chatStream({ provider, model, messages, tools, options, onDelta, signal, timeoutMs }) {
  if (!model) throw new Error('model is required');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT);
  const onAbort = () => controller.abort();
  if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }

  const body = { model, messages: toWire(messages), stream: true, stream_options: { include_usage: true } };
  if (tools && tools.length) body.tools = tools;
  if (options) {
    const official = /api\.openai\.com/.test(provider.endpoint || '');
    const reasoning = official && /^(o\d|gpt-5)/i.test(model);      // these reject custom temperature / max_tokens
    if (options.temperature != null && !reasoning) body.temperature = options.temperature;
    if (options.num_predict) body[official ? 'max_completion_tokens' : 'max_tokens'] = options.num_predict;
  }

  try {
    const res = await fetchOk(`${base(provider.endpoint)}/chat/completions`, { method: 'POST', headers: headers(provider), body: JSON.stringify(body), signal: controller.signal }, { source: `${provider.id || 'provider'} chat`, where: base(provider.endpoint) });
    if (!res.body) throw new Error('the server sent an empty response');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let thinking = '';
    const calls = [];
    let metrics = null;
    let finish = null;

    const handle = (payload) => {
      if (payload === '[DONE]') return;
      let j;
      try { j = JSON.parse(payload); } catch (e) { log.debug('openai', 'skipping a non-JSON stream line', e); return; }
      if (j.error) throw new Error(typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error));
      if (j.usage) metrics = { prompt_eval_count: j.usage.prompt_tokens, eval_count: j.usage.completion_tokens, done_reason: finish };
      const choice = (j.choices || [])[0];
      if (!choice) return;
      const d = choice.delta || {};
      if (choice.finish_reason) finish = choice.finish_reason;
      const think = d.reasoning_content || d.reasoning;
      if (think) { thinking += think; if (onDelta) onDelta({ type: 'thinking', text: think }); }
      if (d.content) { content += d.content; if (onDelta) onDelta({ type: 'content', text: d.content }); }
      for (const tc of d.tool_calls || []) {
        const i = typeof tc.index === 'number' ? tc.index : calls.length;
        const slot = calls[i] || (calls[i] = { id: undefined, name: '', args: '' });
        if (tc.id) slot.id = tc.id;
        if (tc.function && tc.function.name) slot.name += tc.function.name;
        if (tc.function && tc.function.arguments) slot.args += tc.function.arguments;
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) handle(line.slice(5).trim());
      }
    }
    if (buffer.trim().startsWith('data:')) handle(buffer.trim().slice(5).trim());

    const toolCalls = calls.filter(Boolean).filter((c) => c.name).map((c, i) => {
      let args = {};
      try { args = c.args ? JSON.parse(c.args) : {}; } catch (e) { log.warn('openai', `the model sent malformed arguments for tool "${c.name}"`, e); args = { _raw: c.args }; }
      return { id: c.id || `call_${i}`, type: 'function', function: { name: c.name, arguments: args } };
    });
    return { content, thinking, toolCalls, metrics };
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { chatStream, listModels };
