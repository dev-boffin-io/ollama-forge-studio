'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  replace, miniDiff, unifiedDiff,
  fuzzyLineMatch, rankMatches, indentationFlexible, whitespaceNormalized,
} = require('../lib/edit-match');

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

test('fuzzyLineMatch finds near-identical lines using Levenshtein similarity', () => {
  const content = 'const value = compute(1);\nconst other = 2;\n';
  const find = 'const value = comput(1);';
  assert.deepEqual([...fuzzyLineMatch(content, find)], ['const value = compute(1);']);
  const r = replace(content, find, 'const value = compute(2);');
  assert.equal(r.via, 'fuzzyLineMatch');
  assert.equal(r.content, 'const value = compute(2);\nconst other = 2;\n');
});

test('refuses a block match whose middle line drifted too far', () => {
  const content = 'function f() {\n  const x = 1;\n  return ok();\n}\n';
  const find = 'function f() {\n  const completelyDifferent = 12345;\n  return ok();\n}';
  assert.throws(() => replace(content, find, 'replacement'), /only approximately matches the file/);
});

test('indentation detection checks style and width per line', () => {
  const find = '    return result;';
  assert.deepEqual([...indentationFlexible('function f(){\n\treturn result;\n}', find)], ['\treturn result;']);
  assert.deepEqual([...indentationFlexible('function f(){\n  \treturn result;\n}', find)], []);
  assert.deepEqual([...indentationFlexible('function f(){\n        return result;\n}', find)], []);
});

test('rankMatches picks the highest-scoring candidate, not the first one', () => {
  const content = [
    'const alpha = zzz();', 'const beta = two();', '',
    'const alpha = oen();', 'const beta = two();', '',
  ].join('\n');
  const find = 'const alpha = one();\nconst beta = two();';
  const ranked = rankMatches(content, find);
  assert.equal(ranked[0].via, 'fuzzyLineMatch');
  assert.ok(ranked[0].idx > 20, 'the better second block ranks above the earlier weaker one');
  assert.ok(ranked[0].score > ranked[1].score);
  const r = replace(content, find, 'const alpha = fixed();\nconst beta = two();');
  assert.ok(r.content.includes('const alpha = zzz();'));
  assert.ok(r.content.includes('const alpha = fixed();'));
});

test('whitespaceNormalized handles tabs and repeated spaces inside a line', () => {
  assert.deepEqual([...whitespaceNormalized('let\ta\t=\t1;\nlet b = 2;', 'let a = 1;')], ['let\ta\t=\t1;']);
  const r = replace('const\tx\t=\tcompute(1);', 'const x = compute(1);', 'const x = compute(2);');
  assert.equal(r.via, 'whitespaceNormalized');
  assert.equal(r.content, 'const x = compute(2);');
});

test('miniDiff reports the changed region (git-style hunk)', () => {
  const d = miniDiff('a\nb\nc', 'a\nB\nc');
  assert.equal(d.additions, 1);
  assert.equal(d.deletions, 1);
  assert.equal(d.diff, '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c');
  const same = miniDiff('a\nb', 'a\nb');
  assert.equal(same.additions + same.deletions, 0);
  assert.equal(same.diff, '');
});

test('unifiedDiff: separate hunks, exact line numbers, insert/delete/new file', () => {
  const lines = Array.from({ length: 30 }, (_, i) => 'l' + (i + 1));
  const after = lines.slice();
  after[1] = 'L2';            // line 2 changed
  after.splice(24, 1);        // line 25 deleted
  after.splice(10, 0, 'new'); // inserted after l10
  const d = unifiedDiff(lines.join('\n') + '\n', after.join('\n') + '\n');
  assert.equal(d.additions, 2);
  assert.equal(d.deletions, 2);
  const heads = d.diff.split('\n').filter((l) => l.startsWith('@@'));
  assert.ok(heads.length >= 2, 'far-apart changes make separate hunks');
  assert.ok(d.diff.includes('-l2\n+L2'));
  assert.ok(d.diff.includes('-l25'));
  assert.ok(d.diff.includes('+new'));
  // applying the hunks back must reproduce the new text: every +/ctx line is in `after`, every -/ctx line in `lines`
  for (const l of d.diff.split('\n')) {
    if (l.startsWith('+')) assert.ok(after.includes(l.slice(1)));
    if (l.startsWith('-')) assert.ok(lines.includes(l.slice(1)));
  }
  const n = unifiedDiff('', 'x\ny\n');
  assert.equal(n.diff, '@@ -0,0 +1,2 @@\n+x\n+y');
  assert.deepEqual([n.additions, n.deletions], [2, 0]);
  const g = unifiedDiff('a\nb\n', '');
  assert.equal(g.diff, '@@ -1,2 +0,0 @@\n-a\n-b');
});

test('unifiedDiff: CRLF vs LF only is not a change, long diffs are cut with exact counts', () => {
  assert.equal(unifiedDiff('a\r\nb\r\n', 'a\nb\n').diff, '');
  const big = unifiedDiff('', Array.from({ length: 500 }, (_, i) => 'r' + i).join('\n'), { maxLines: 50 });
  assert.equal(big.additions, 500);
  assert.equal(big.diff.split('\n').length, 51);
  assert.match(big.diff, /… \d+ more diff lines/);
});

test('not-found error shows the closest ACTUAL region so the model can copy it', () => {
  const f = 'function a(){\n  const x = 1;\n  return x;\n}\nfunction b(){\n  const y = 2;\n  return y+1;\n}\n';
  assert.throws(() => replace(f, 'const yy = 2;\n  return computeSomething(y);', 'x'), (e) => /Closest match is at lines 5-8/.test(e.message) && /6:   const y = 2;/.test(e.message));
});

test('double-escaped old_string/new_string (literal backslash-n) still match', () => {
  const f = 'if (a) {\n  run();\n}\n';
  const r = replace(f, 'if (a) {\\n  run();\\n}', 'if (b) {\\n  go();\\n}');
  assert.equal(r.content, 'if (b) {\n  go();\n}\n');
});

test('CRLF files: edits match and line endings are preserved', () => {
  const r = replace('a\r\nb\r\nc\r\n', 'b\nc', 'B\nC');
  assert.equal(r.content, 'a\r\nB\r\nC\r\n');
});

test('replaceLines: range edit, expect guard, bounds', () => {
  const { replaceLines } = require('../lib/edit-match');
  const f = 'one\ntwo\nthree\n';
  assert.equal(replaceLines(f, 2, 2, 'TWO', 'two').content, 'one\nTWO\nthree\n');
  assert.equal(replaceLines(f, 2, 3, '', null).content, 'one\n');
  assert.throws(() => replaceLines(f, 2, 2, 'x', 'nope'), /does not match expect_first_line/);
  assert.throws(() => replaceLines(f, 9, 9, 'x'), /Invalid line range/);
});
