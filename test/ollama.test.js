'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ollama = require('../lib/ollama');

test('normalizeEndpoint: trims, strips trailing slashes, requires http(s)', () => {
  assert.equal(ollama.normalizeEndpoint('  http://localhost:11434/  '), 'http://localhost:11434');
  assert.equal(ollama.normalizeEndpoint('https://host:8443///'), 'https://host:8443');
  assert.throws(() => ollama.normalizeEndpoint(''), /required/);
  assert.throws(() => ollama.normalizeEndpoint(undefined), /required/);
  assert.throws(() => ollama.normalizeEndpoint('ftp://host'), /http\(s\)/);
  assert.throws(() => ollama.normalizeEndpoint('not a url'), /Invalid URL/);
});

test('authHeaders: bearer token only when a key exists', () => {
  assert.deepEqual(ollama.authHeaders('abc'), { Authorization: 'Bearer abc' });
  assert.deepEqual(ollama.authHeaders(''), {});
  assert.deepEqual(ollama.authHeaders(undefined), {});
});
