'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const llm = require('../lib/llm');

test('providersOf: default provider from endpoint, extra providers normalised', () => {
  process.env.TEST_LLM_KEY = 'sekret';
  const all = llm.providersOf({
    endpoint: 'http://localhost:11434', apiKeyEnv: 'TEST_LLM_KEY',
    providers: {
      oa: { type: 'openai', endpoint: 'https://api.openai.com/v1', apiKey: 'k1' },
      bad: { type: 'weird', endpoint: 'https://x.example' },
      noEndpoint: { type: 'openai' },
      envKey: { type: 'anthropic', endpoint: 'https://api.anthropic.com', apiKeyEnv: 'TEST_LLM_KEY' },
    },
  });
  assert.equal(all.default.type, 'ollama');
  assert.equal(all.default.endpoint, 'http://localhost:11434');
  assert.equal(all.default.apiKey, 'sekret');          // apiKeyEnv resolves at call time
  assert.equal(all.oa.type, 'openai');
  assert.equal(all.bad.type, 'ollama');               // unknown type falls back to ollama
  assert.equal(all.noEndpoint, undefined);            // skipped: no endpoint
  assert.equal(all.envKey.apiKey, 'sekret');
  delete process.env.TEST_LLM_KEY;
});

test('resolve: provider/model refs and bare names', () => {
  const config = {
    endpoint: 'http://localhost:11434',
    providers: { openrouter: { type: 'openai', endpoint: 'https://openrouter.ai/api/v1' } },
  };
  const a = llm.resolve(config, 'openrouter/meta/llama-3-8b');
  assert.equal(a.provider.id, 'openrouter');
  assert.equal(a.model, 'meta/llama-3-8b');

  const b = llm.resolve(config, 'llama3:8b');
  assert.equal(b.provider.id, 'default');
  assert.equal(b.model, 'llama3:8b');

  const c = llm.resolve({ ...config, defaultProvider: 'missing' }, 'llama3:8b');
  assert.equal(c.provider.id, 'default');
});

test('maskConfig: api keys are masked, never removed from the copy structure', () => {
  const masked = llm.maskConfig({
    apiKey: 'sk-supersecret1234',
    providers: { oa: { type: 'openai', endpoint: 'x', apiKey: 'abcd1234efgh' }, plain: { type: 'ollama', endpoint: 'y' } },
  });
  assert.equal(masked.apiKey, '••••1234');
  assert.equal(masked.providers.oa.apiKey, '••••efgh');
  assert.equal(masked.providers.plain.apiKey, undefined);
  assert.equal(masked.providers.oa.type, 'openai');
});

test('contextWindow: explicit numCtx wins, provider/type defaults, unreachable Ollama', async () => {
  assert.equal(await llm.contextWindow({ numCtx: 4096 }, { type: 'ollama', endpoint: 'http://127.0.0.1:1' }, 'm'), 4096);
  assert.equal(await llm.contextWindow({ numCtx: 0 }, { type: 'ollama', endpoint: 'http://127.0.0.1:1', contextWindow: 8192 }, 'm'), 8192);
  assert.equal(await llm.contextWindow({ numCtx: 0 }, { type: 'anthropic', endpoint: 'https://api.anthropic.com' }, 'claude'), 200000);
  assert.equal(await llm.contextWindow({ numCtx: 0 }, { type: 'openai', endpoint: 'https://api.openai.com/v1' }, 'gpt-4o'), 128000);
  assert.equal(await llm.contextWindow({ numCtx: 0 }, { type: 'openai', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai' }, 'gemini'), 1000000);
  // unreachable local endpoint falls back to the default window
  assert.equal(await llm.contextWindow({ numCtx: 0, autoCtxMax: 131072 }, { type: 'ollama', endpoint: 'http://127.0.0.1:1' }, 'missing-model'), 32768);
  // autoCtxMax caps a detected window
  assert.equal(await llm.contextWindow({ numCtx: 0, autoCtxMax: 1000 }, { type: 'ollama', endpoint: 'http://127.0.0.1:1' }, 'missing-model-2'), 32768);
});

test('supportsVision: config override and provider heuristics (no network)', async () => {
  assert.equal(await llm.supportsVision({ vision: false }, { type: 'anthropic' }, 'claude'), false);
  assert.equal(await llm.supportsVision({ vision: true }, { type: 'ollama', endpoint: 'http://127.0.0.1:1' }, 'llama3'), true);
  assert.equal(await llm.supportsVision({}, { type: 'anthropic', endpoint: 'https://api.anthropic.com' }, 'claude'), true);
  assert.equal(await llm.supportsVision({}, { type: 'openai', endpoint: 'https://api.openai.com/v1' }, 'gpt-4o'), true);
  assert.equal(await llm.supportsVision({}, { type: 'openai', endpoint: 'https://api.openai.com/v1' }, 'gpt-3.5-turbo'), false);
  assert.equal(await llm.supportsVision({}, { type: 'openai', endpoint: 'https://openrouter.ai/api/v1' }, 'google/gemini-2.0-flash'), true);
});
