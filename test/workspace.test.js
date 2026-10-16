'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');

const ctx = setup();
const ws = require('../lib/workspace');
const cfg = ctx.cfg;

test('safeResolve: keeps relative paths inside the working directory', () => {
  const p = ws.safeResolve('src/deep/../app.js');
  assert.equal(p, path.join(cfg.getWorkDir(), 'src/app.js'));
  assert.equal(ws.safeResolve('./README.md'), path.join(cfg.getWorkDir(), 'README.md'));
});

test('safeResolve: rejects traversal and absolute paths outside the project', () => {
  assert.throws(() => ws.safeResolve('../outside.txt'), /escapes the working directory/);
  assert.throws(() => ws.safeResolve('a/../../outside.txt'), /escapes the working directory/);
  assert.throws(() => ws.safeResolve('/etc/passwd'), /outside the working directory/);
});

test('safeResolve: absolute paths inside the project are accepted', () => {
  const inside = path.join(cfg.getWorkDir(), 'notes', 'a.txt');
  assert.equal(ws.safeResolve(inside), inside);
});

test('safeResolve: .studio/... maps to the studio data dir, not the project', () => {
  const p = ws.safeResolve('.studio/uploads/x.png');
  assert.ok(p.startsWith(fs.realpathSync(ctx.studioDir)), `${p} should live under ${ctx.studioDir}`);
  assert.ok(p.endsWith(path.join('uploads', 'x.png')));
});

test('safeResolve: symlink escapes are blocked', () => {
  const outside = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
  fs.symlinkSync(outside, path.join(cfg.getWorkDir(), 'link'));
  assert.throws(() => ws.safeResolve('link/secret.txt'), /symlink/);
  assert.throws(() => ws.safeResolve('link'), /symlink/);
  fs.rmSync(outside, { recursive: true, force: true });
});

test('write/read/delete round-trip', async () => {
  await ws.writeFile('nested/deep/a.txt', 'hello');
  assert.equal(await ws.readFile('nested/deep/a.txt'), 'hello');
  await assert.rejects(() => ws.readFile('nested'), /not a file/);
  await ws.deleteFile('nested/deep/a.txt');
  await assert.rejects(() => ws.readFile('nested/deep/a.txt'), /ENOENT/);
  await assert.rejects(() => ws.deleteFile('.'), /refusing to delete/);
  await assert.rejects(() => ws.deleteFile('..'), /refusing to delete/);
});

test('tree and flat list skip ignored folders', async () => {
  fs.mkdirSync(path.join(ctx.dir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'node_modules', 'pkg', 'index.js'), 'x');
  fs.mkdirSync(path.join(ctx.dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, '.git', 'config'), 'x');
  fs.mkdirSync(path.join(ctx.dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'src', 'a.js'), 'console.log(1)\n');
  fs.writeFileSync(path.join(ctx.dir, 'src', 'b.ts'), 'export {}\n');
  fs.writeFileSync(path.join(ctx.dir, 'README.md'), '# hi\n');

  const flat = await ws.listFlat();
  assert.ok(flat.includes('src/'));
  assert.ok(flat.includes('src/a.js'));
  assert.ok(flat.includes('README.md'));
  assert.ok(!flat.some((p) => p.includes('node_modules') || p.includes('.git')));

  const tree = await ws.listTree();
  const src = tree.find((n) => n.name === 'src');
  assert.equal(src.type, 'dir');
  assert.ok(src.children.some((c) => c.name === 'a.js'));
  // dirs sort before files at each level
  assert.equal(tree[0].type, 'dir');
});

test('glob: ** semantics, path-anchored patterns, braces', async () => {
  fs.mkdirSync(path.join(ctx.dir, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'src', 'deep', 'c.js'), 'x');
  assert.deepEqual(await ws.glob('*.md'), ['README.md']);
  assert.deepEqual((await ws.glob('*.js')).sort(), ['src/a.js', 'src/deep/c.js']);
  assert.deepEqual(await ws.glob('src/*.js'), ['src/a.js']);
  assert.deepEqual((await ws.glob('src/**/*.{js,ts}')).sort(), ['src/a.js', 'src/b.ts', 'src/deep/c.js']);
});

test('grep: path:line: text matches, include filter, invalid regex', async () => {
  const hits = await ws.grep('console\\.log', '*.js');
  assert.equal(hits.length, 1);
  assert.match(hits[0], /^src\/a\.js:1: console\.log/);
  assert.deepEqual(await ws.grep('console\\.log', '*.ts'), []);
  await assert.rejects(() => ws.grep('([', null), /invalid regex/);

  // binary files are skipped
  fs.writeFileSync(path.join(ctx.dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]));
  const all = await ws.grep('\\x00|\\u0000', null).catch(() => []);
  assert.ok(!all.some((h) => h.startsWith('bin.dat')));
});
