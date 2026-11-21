'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { childEnv } = require('../lib/env');

const base = {
  PATH: '/usr/bin', HOME: '/home/u', LANG: 'C', SSH_AUTH_SOCK: '/tmp/agent', GIT_ASKPASS: 'x',
  OPENAI_API_KEY: 'sk-1', ANTHROPIC_API_KEY: 'sk-2', GITHUB_TOKEN: 'ghp', AWS_SECRET_ACCESS_KEY: 'aws', AWS_ACCESS_KEY_ID: 'AKIA',
  DB_PASSWORD: 'pw', MY_SERVICE_CREDENTIALS: 'c', OLLAMA_STUDIO_TOKEN: 'studio', CUSTOM_VAR: 'v', MYKEYBOARD: 'ok', TOKENIZERS_PARALLELISM: 'false',
};

test('secrets are removed, ordinary variables kept', () => {
  const e = childEnv({}, base);
  for (const k of ['PATH', 'HOME', 'LANG', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'CUSTOM_VAR', 'MYKEYBOARD', 'TOKENIZERS_PARALLELISM']) assert.ok(k in e, k + ' should stay');
  for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'DB_PASSWORD', 'MY_SERVICE_CREDENTIALS', 'OLLAMA_STUDIO_TOKEN']) assert.ok(!(k in e), k + ' should be dropped');
});

test('bashEnv.allow re-adds a name, deny drops globs, inherit keeps everything', () => {
  assert.equal(childEnv({ bashEnv: { allow: ['github_token'] } }, base).GITHUB_TOKEN, 'ghp');
  assert.ok(!('CUSTOM_VAR' in childEnv({ bashEnv: { deny: ['CUSTOM_*'] } }, base)));
  const all = childEnv({ bashEnv: { inherit: true } }, base);
  assert.equal(all.OPENAI_API_KEY, 'sk-1');
});

test('variables named by providers (apiKeyEnv) are dropped even if the name looks harmless', () => {
  const e = childEnv({ providers: { x: { apiKeyEnv: 'MYLLM' } } }, { ...base, MYLLM: 'secret' });
  assert.ok(!('MYLLM' in e));
});

test('a real child process does not see the secrets', async () => {
  const { execFileSync } = require('node:child_process');
  process.env.TEST_LEAK_API_KEY = 'leak-me';
  const out = execFileSync(process.execPath, ['-e', 'console.log(process.env.TEST_LEAK_API_KEY || "none")'], { env: childEnv({}) }).toString().trim();
  delete process.env.TEST_LEAK_API_KEY;
  assert.equal(out, 'none');
});
