'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StudioClient, SseParser, parseSseText } = require('../vscode-extension/protocol');

test('SSE parser handles split chunks, comments and multiple data lines', () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push('data: {"type":"token","text":"he'), []);
  assert.deepEqual(parser.push('llo"}\n\n: keepalive\n\ndata: {"type":"done"}\n\n'), [
    { type: 'token', text: 'hello' },
    { type: 'done' },
  ]);
  assert.deepEqual(parser.push('data: {"type":"raw"'), []);
  assert.deepEqual(parser.end(), [{ type: 'raw', data: '{"type":"raw"' }]);
});

test('parseSseText returns parsed events and leaves a partial block in rest', () => {
  const r = parseSseText('data: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: {"type":"c"');
  assert.deepEqual(r.events, [{ type: 'a' }, { type: 'b' }]);
  assert.equal(r.rest, 'data: {"type":"c"');
});

test('StudioClient request joins URLs and surfaces HTTP errors', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/fail')) return { ok: false, status: 403, text: async () => JSON.stringify({ error: 'nope' }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
  const c = new StudioClient('http://127.0.0.1:4310/', fetch);
  assert.deepEqual(await c.get('api/health'), { ok: true });
  assert.equal(calls[0].url, 'http://127.0.0.1:4310/api/health');
  await assert.rejects(() => c.get('/api/fail'), /nope/);
});

test('StudioClient stream parses SSE from a web ReadableStream', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"token","text":"hi"}\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'));
      controller.close();
    },
  });
  const fetch = async () => ({ ok: true, status: 200, body });
  const c = new StudioClient('http://127.0.0.1:4310', fetch);
  const events = [];
  await c.stream('/api/chat', { text: 'x' }, { onEvent: (e) => events.push(e) });
  assert.deepEqual(events, [{ type: 'token', text: 'hi' }, { type: 'done' }]);
});
