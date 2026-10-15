'use strict';

const DEFAULT_TIMEOUT = 600000;

function normalizeEndpoint(endpoint) {
  const value = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!value) throw new Error('endpoint is required');
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('endpoint must be an http(s) URL');
  }
  return value;
}

const authHeaders = (apiKey) => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});

async function listModels(endpoint, timeoutMs = 30000, apiKey = '') {
  const base = normalizeEndpoint(endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/tags`, { headers: authHeaders(apiKey), signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${base}/api/tags`);
    const data = await res.json();
    return (data.models || []).map((m) => ({
      name: m.name || m.model,
      family: m.details && m.details.family,
      parameter_size: m.details && m.details.parameter_size,
      capabilities: m.capabilities || [],
    }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Merge a streamed tool_call delta into an accumulator array.
 * Ollama may stream arguments as a plain object (once) or as a JSON string in fragments.
 */
function mergeToolCall(acc, delta, fallbackIndex) {
  const index = typeof delta.index === 'number' ? delta.index : fallbackIndex;
  let slot = acc.find((c) => c.index === index);
  if (!slot) {
    slot = { index, id: undefined, type: 'function', function: { name: '', arguments: {} } };
    acc.push(slot);
  }
  if (delta.id) slot.id = delta.id;
  if (delta.type) slot.type = delta.type;
  const fn = delta.function || {};
  if (fn.name) slot.function.name = fn.name;
  if (fn.arguments != null) {
    if (typeof fn.arguments === 'string') {
      slot._argString = (slot._argString || '') + fn.arguments;
    } else if (typeof fn.arguments === 'object') {
      slot.function.arguments = { ...slot.function.arguments, ...fn.arguments };
    }
  }
  return slot;
}

function finalizeToolCalls(acc) {
  return acc
    .sort((a, b) => a.index - b.index)
    .map((slot, i) => {
      let args = slot.function.arguments;
      if (slot._argString) {
        try {
          args = JSON.parse(slot._argString);
        } catch {
          args = { _raw: slot._argString };
        }
      }
      return {
        id: slot.id || `call_${i}`,
        type: 'function',
        function: { name: slot.function.name, arguments: args || {} },
      };
    })
    .filter((c) => c.function.name);
}

/**
 * Stream a chat completion from Ollama.
 * Returns { content, thinking, toolCalls, done, metrics }.
 * Calls onDelta({type:'content'|'thinking', text}) for live output.
 */
async function chatStream({ endpoint, apiKey, model, messages, tools, options, onDelta, signal, timeoutMs }) {
  const base = normalizeEndpoint(endpoint);
  if (!model) throw new Error('model is required');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const body = { model, messages, stream: true };
  if (tools && tools.length) body.tools = tools;
  if (options) body.options = options;

  try {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} from Ollama chat: ${text.slice(0, 500)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let thinking = '';
    const toolAcc = [];
    let toolIndex = 0;
    let metrics = null;

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let json;
      try {
        json = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (json.error) throw new Error(json.error);
      const msg = json.message || {};
      if (msg.thinking) {
        thinking += msg.thinking;
        if (onDelta) onDelta({ type: 'thinking', text: msg.thinking });
      }
      if (msg.content) {
        content += msg.content;
        if (onDelta) onDelta({ type: 'content', text: msg.content });
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const slot = mergeToolCall(toolAcc, tc, toolIndex);
          if (tc.index == null) toolIndex = Math.max(toolIndex, slot.index + 1);
        }
      }
      if (json.done) {
        metrics = {
          total_duration: json.total_duration,
          eval_duration: json.eval_duration,
          eval_count: json.eval_count,
          prompt_eval_count: json.prompt_eval_count,
          done_reason: json.done_reason,
        };
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer.trim()) handleLine(buffer);

    return { content, thinking, toolCalls: finalizeToolCalls(toolAcc), metrics };
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { authHeaders, normalizeEndpoint, listModels, chatStream };
