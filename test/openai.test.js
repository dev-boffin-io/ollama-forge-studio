'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const openai = require('../lib/openai');

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai';
const VERTEX = 'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/endpoints/openapi';

function sse(events) {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  });
}

function mockFetch(t, reply) {
  const orig = global.fetch;
  t.after(() => { global.fetch = orig; });
  let sent;
  global.fetch = async (url, opts) => { sent = JSON.parse(opts.body); return reply(); };
  return () => sent;
}

const history = [{
  role: 'assistant', content: '',
  tool_calls: [{
    id: 'call_old', type: 'function',
    function: { name: 'read_file', arguments: { path: 'old.txt' } },
    extra_content: { google: { thought_signature: 'SIG-OLD' } },
  }],
}, { role: 'tool', tool_call_id: 'call_old', content: '{}' }, { role: 'user', content: 'continue' }];

test('Gemini: captures a streamed thought signature and replays it verbatim', async (t) => {
  const sent = mockFetch(t, () => sse([
    { choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_new', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' }, extra_content: { google: { thought_signature: 'SIG-NEW' } } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]));

  const out = await openai.chatStream({ provider: { id: 'gemini', type: 'openai', endpoint: GEMINI }, model: 'gemini-3.8-flash', messages: history, tools: [] });

  assert.deepEqual(out.toolCalls, [{
    id: 'call_new', type: 'function',
    function: { name: 'read_file', arguments: { path: 'a.txt' } },
    extra_content: { google: { thought_signature: 'SIG-NEW' } },
  }]);
  assert.deepEqual(sent().messages[0].tool_calls[0].extra_content, { google: { thought_signature: 'SIG-OLD' } });
});

test('Gemini: a signature chunk without index/id attaches to the last call; Vertex is recognised', async (t) => {
  const sent = mockFetch(t, () => sse([
    { choices: [{ delta: { tool_calls: [{ id: 'call_1', function: { name: 'ls', arguments: '{}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ extra_content: { google: { thought_signature: 'SIG-V' } } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]));

  const out = await openai.chatStream({ provider: { id: 'vertex', type: 'openai', endpoint: VERTEX }, model: 'gemini-3.8-flash', messages: history, tools: [] });

  assert.equal(out.toolCalls[0].extra_content.google.thought_signature, 'SIG-V');
  assert.equal(sent().messages[0].tool_calls[0].extra_content.google.thought_signature, 'SIG-OLD');
});

test('non-Gemini providers: extra_content is never sent on the wire', async (t) => {
  const sent = mockFetch(t, () => sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));

  const out = await openai.chatStream({ provider: { id: 'openai', type: 'openai', endpoint: 'https://api.openai.com/v1' }, model: 'gpt-4o', messages: history, tools: [] });

  assert.equal(out.content, 'ok');
  assert.equal(sent().messages[0].tool_calls[0].extra_content, undefined);
});
