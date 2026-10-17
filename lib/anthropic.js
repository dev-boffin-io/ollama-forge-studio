'use strict';

// Anthropic Messages API client (Claude). Messages are stored in Ollama/OpenAI style internally and converted here.
// Auth: x-api-key header. Endpoint: https://api.anthropic.com (a trailing /v1 is accepted too).

const { fetchOk, fromResponse, wrapNetwork } = require('./errors');

const DEFAULT_TIMEOUT = 600000;
const VERSION = '2023-06-01';

const base = (endpoint) => String(endpoint || 'https://api.anthropic.com').trim().replace(/\/+$/, '').replace(/\/v1$/, '');

function headers(provider) {
  const h = { 'Content-Type': 'application/json', 'anthropic-version': VERSION, ...(provider.headers || {}) };
  if (provider.apiKey) h['x-api-key'] = provider.apiKey;
  return h;
}

const mime = (b) => (b.startsWith('iVBOR') ? 'image/png' : b.startsWith('/9j/') ? 'image/jpeg' : b.startsWith('R0lGOD') ? 'image/gif' : b.startsWith('UklGR') ? 'image/webp' : 'image/png');

/** -> { system, messages } in Anthropic shape (alternating roles, tool results grouped into one user turn). */
function toWire(messages) {
  const system = [];
  const out = [];
  const push = (role, blocks) => {
    blocks = blocks.filter((b) => !(b.type === 'text' && !b.text));
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks); else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') { if (m.content) system.push(String(m.content)); continue; }
    if (m.role === 'tool') { push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id || 'call_0', content: String(m.content ?? '') || '(empty)' }]); continue; }
    if (m.role === 'assistant') {
      const blocks = [{ type: 'text', text: m.content || '' }];
      (m.tool_calls || []).forEach((c, i) => {
        let input = c.function.arguments;
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
        blocks.push({ type: 'tool_use', id: c.id || `call_${i}`, name: c.function.name, input: input || {} });
      });
      push('assistant', blocks);
      continue;
    }
    const blocks = [];
    for (const b of m.images || []) blocks.push({ type: 'image', source: { type: 'base64', media_type: mime(b), data: b } });
    blocks.push({ type: 'text', text: m.content ?? '' });
    push('user', blocks);
  }
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(start)' }] });
  return { system: system.join('\n\n'), messages: out };
}

async function listModels(provider, timeoutMs = 30000) {
  const out = [];
  let after = '';
  for (let page = 0; page < 10; page++) {
    const res = await fetchOk(`${base(provider.endpoint)}/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`, { headers: headers(provider), signal: AbortSignal.timeout(timeoutMs) }, { source: 'Anthropic models', where: base(provider.endpoint) });
    const j = await res.json();
    for (const m of j.data || []) out.push({ name: m.id, capabilities: ['vision', 'tools'] });
    if (!j.has_more || !j.last_id) break;
    after = j.last_id;
  }
  return out;
}

async function chatStream({ provider, model, messages, tools, options, onDelta, signal, timeoutMs }) {
  if (!model) throw new Error('model is required');
  if (!provider.apiKey) throw new Error('Anthropic provider needs an API key (Providers → API key)');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT);
  const onAbort = () => controller.abort();
  if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }

  const wire = toWire(messages);
  const buildBody = (maxTokens) => {
    const b = { model, max_tokens: maxTokens, messages: wire.messages, stream: true };
    if (wire.system) b.system = wire.system;
    if (tools && tools.length) b.tools = tools.map((t) => ({ name: t.function.name, description: t.function.description || '', input_schema: t.function.parameters || { type: 'object', properties: {} } }));
    if (options && options.temperature != null && provider.sendTemperature !== false) b.temperature = Math.min(1, options.temperature);
    return b;
  };

  try {
    let maxTokens = Number(provider.maxTokens) || (options && options.num_predict) || 32000;
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { res = await fetch(`${base(provider.endpoint)}/v1/messages`, { method: 'POST', headers: headers(provider), body: JSON.stringify(buildBody(maxTokens)), signal: controller.signal }); } catch (err) { throw wrapNetwork(err, base(provider.endpoint)); }
      if (res.ok && res.body) break;
      const text = await res.text().catch(() => '');
      // older models allow fewer output tokens: step down and retry
      if (res.status === 400 && /max_tokens/i.test(text) && maxTokens > 4096 && attempt < 2) { maxTokens = maxTokens > 8192 ? 8192 : 4096; continue; }
      throw fromResponse(res.status, text, `${provider.id || 'Anthropic'} chat`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let thinking = '';
    const blocks = {};            // index -> { id, name, args }
    let inTok = 0; let outTok = 0; let stop = null;

    const handle = (payload) => {
      let j;
      try { j = JSON.parse(payload); } catch { return; }
      switch (j.type) {
        case 'message_start': { const u = (j.message && j.message.usage) || {}; inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); outTok = u.output_tokens || 0; break; }
        case 'content_block_start': { const cb = j.content_block || {}; if (cb.type === 'tool_use') blocks[j.index] = { id: cb.id, name: cb.name, args: '' }; break; }
        case 'content_block_delta': {
          const d = j.delta || {};
          if (d.type === 'text_delta' && d.text) { content += d.text; if (onDelta) onDelta({ type: 'content', text: d.text }); }
          else if (d.type === 'thinking_delta' && d.thinking) { thinking += d.thinking; if (onDelta) onDelta({ type: 'thinking', text: d.thinking }); }
          else if (d.type === 'input_json_delta' && blocks[j.index]) blocks[j.index].args += d.partial_json || '';
          break;
        }
        case 'message_delta': { if (j.delta && j.delta.stop_reason) stop = j.delta.stop_reason; if (j.usage && j.usage.output_tokens != null) outTok = j.usage.output_tokens; break; }
        case 'error': throw new Error((j.error && j.error.message) || 'Anthropic stream error');
        default: break;
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

    const toolCalls = Object.keys(blocks).map(Number).sort((a, b) => a - b).map((k, i) => {
      const c = blocks[k];
      let args = {};
      try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = { _raw: c.args }; }
      return { id: c.id || `call_${i}`, type: 'function', function: { name: c.name, arguments: args } };
    });
    return { content, thinking, toolCalls, metrics: { prompt_eval_count: inTok, eval_count: outTok, done_reason: stop } };
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { chatStream, listModels, toWire };
