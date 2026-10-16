'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { replace, miniDiff } = require('../lib/edit-match');

test('exact match replaces the region', () => {
  const r = replace('const a = 1;\nconst b = 2;\n', 'const a = 1;', 'const a = 99;');
  assert.equal(r.content, 'const a = 99;\nconst b = 2;\n');
  assert.equal(r.matched, 'const a = 1;');
});

test('errors: identical, empty, not found, ambiguous', () => {
  assert.throws(() => replace('abc', 'abc', 'abc'), /No changes/);
  assert.throws(() => replace('abc', '', 'x'), /cannot be empty/);
  assert.throws(() => replace('abc', 'zzz', 'x'), /Could not find/);
  assert.throws(() => replace('foo bar foo', 'foo', 'x'), /multiple matches/);
});

test('replace_all replaces every occurrence', () => {
  const r = replace('foo bar foo', 'foo', 'baz', true);
  assert.equal(r.content, 'baz bar baz');
});

test('tolerates wrong indentation (line-trimmed matcher)', () => {
  const content = 'function f() {\n  if (x) {\n    return 1;\n  }\n}\n';
  const badIndent = 'if (x) {\nreturn 1;\n}';
  const r = replace(content, badIndent, 'if (x) {\n  return 2;\n}');
  assert.ok(r.content.includes('return 2;'));
  assert.ok(!r.content.includes('return 1;'));
});

test('tolerates whitespace drift inside a line', () => {
  const r = replace('const x   =   compute(1);  ', 'const x = compute(1);', 'const x = compute(2);');
  assert.equal(r.content, 'const x = compute(2);');   // the whole drifted line is the match
});

test('strips "12: " line-number prefixes copied from read_file', () => {
  const content = 'line one\nline two\nline three\n';
  const withNumbers = '1: line one\n2: line two';
  const r = replace(content, withNumbers, 'LINE ONE\nLINE TWO');
  assert.equal(r.content, 'LINE ONE\nLINE TWO\nline three\n');
});

test('picks the best block match when the middle drifted slightly', () => {
  const content = [
    'def add(a, b):', '    # add two numbers', '    result = a + b', '    return result', '',
    'def other():', '    return 0',
  ].join('\n');
  const find = 'def add(a, b):\n    # add two numbers\n    result = a + b\n    return result';
  const r = replace(content, find, 'def add(a, b):\n    return a + b');
  assert.ok(r.content.startsWith('def add(a, b):\n    return a + b'));
  assert.ok(!r.content.includes('result = a + b'));
});

test('trimmed boundary: leading/trailing whitespace in old_string is fine', () => {
  const r = replace('say hello now', '  hello  ', 'HI');
  assert.equal(r.content, 'say HI now');
});

test('miniDiff reports the changed region', () => {
  const d = miniDiff('a\nb\nc', 'a\nB\nc');
  assert.equal(d.additions, 1);
  assert.equal(d.deletions, 1);
  assert.ok(d.diff.includes('- b'));
  assert.ok(d.diff.includes('+ B'));
  assert.ok(d.diff.startsWith('@@ line 2 @@'));
  const same = miniDiff('a\nb', 'a\nb');
  assert.equal(same.additions + same.deletions, 0);
});
