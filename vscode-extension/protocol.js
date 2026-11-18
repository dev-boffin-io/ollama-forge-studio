'use strict';

// Tiny dependency-free client for the Ollama Forge Studio HTTP API. It is shared by the VS Code extension and its
// tests, and intentionally uses only fetch/Web Streams so the extension has no build step and no npm dependencies.

class SseParser {
  constructor() { this.buffer = ''; }

  push(chunk) {
    this.buffer += String(chunk || '');
    const events = [];
    for (;;) {
      const m = /\r?\n\r?\n/.exec(this.buffer);
      if (!m) break;
      const block = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const ev = parseBlock(block);
      if (ev !== null) events.push(ev);
    }
    return events;
  }

  end() {
    if (!this.buffer.trim()) return [];
    const ev = parseBlock(this.buffer);
    this.buffer = '';
    return ev === null ? [] : [ev];
  }
}

function parseBlock(block) {
  const lines = String(block).split(/\r?\n/);
  const data = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    data.push(line.slice(5).replace(/^ /, ''));
  }
  if (!data.length) return null;
  const raw = data.join('\n');
  try { return JSON.parse(raw); } catch { return { type: 'raw', data: raw }; }
}

function parseSseText(text) {
  const parser = new SseParser();
  const events = parser.push(text);
  return { events, rest: parser.buffer };
}

class StudioClient {
  constructor(baseUrl, fetchImpl) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.fetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (typeof this.fetch !== 'function') throw new Error('fetch is not available in this runtime');
  }

  url(pathname) {
    const p = String(pathname || '');
    return this.baseUrl + (p.startsWith('/') ? p : '/' + p);
  }

  async request(method, pathname, body, opts = {}) {
    const headers = { accept: 'application/json', ...(opts.headers || {}) };
    const init = { method, headers };
    if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    if (opts.signal) init.signal = opts.signal;
    const res = await this.fetch(this.url(pathname), init);
    const text = await res.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }
    if (!res.ok) {
      const err = new Error(data.error || data.raw || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  get(pathname, opts) { return this.request('GET', pathname, undefined, opts); }
  post(pathname, body, opts) { return this.request('POST', pathname, body === undefined ? {} : body, opts); }
  put(pathname, body, opts) { return this.request('PUT', pathname, body === undefined ? {} : body, opts); }

  async stream(pathname, body, { onEvent, signal } = {}) {
    const res = await this.fetch(this.url(pathname), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body || {}),
      ...(signal ? { signal } : {}),
    });
    return readSse(res, onEvent);
  }

  async attach(sessionId, { onEvent, signal } = {}) {
    const res = await this.fetch(this.url(`/api/sessions/${encodeURIComponent(sessionId)}/attach`), {
      headers: { accept: 'text/event-stream' },
      ...(signal ? { signal } : {}),
    });
    return readSse(res, onEvent);
  }
}

async function readSse(res, onEvent) {
  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch { /* ignore */ }
    let data = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    const err = new Error(data.error || data.raw || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (!res.body || typeof res.body.getReader !== 'function') throw new Error('the server did not return a streaming response');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const emit = (list) => { for (const ev of list) { if (typeof onEvent === 'function') onEvent(ev); } };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    emit(parser.push(decoder.decode(value, { stream: true })));
  }
  emit(parser.push(decoder.decode()));
  emit(parser.end());
  return res;
}

module.exports = { StudioClient, SseParser, parseSseText };
