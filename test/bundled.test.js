'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup } = require('./helpers');

const ctx = setup();
const ROOT = path.resolve(__dirname, '..');
const EXAMPLES = path.join(ROOT, 'examples');
const bundled = require('../lib/bundled');
const agents = require('../lib/agents');
const skills = require('../lib/skills');

// helpers.setup() switches the layer off for every other suite; these tests turn it on explicitly.
const withBundled = (fn) => {
  const prev = process.env.OLLAMA_STUDIO_NO_BUNDLED;
  delete process.env.OLLAMA_STUDIO_NO_BUNDLED;
  try { return fn(); } finally { if (prev === undefined) delete process.env.OLLAMA_STUDIO_NO_BUNDLED; else process.env.OLLAMA_STUDIO_NO_BUNDLED = prev; }
};
const names = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3));

test('bundled: every examples/agents/*.md is a default agent, tagged source "bundled"', () => {
  withBundled(() => {
    const all = agents.loadAgents();
    const expected = names(path.join(EXAMPLES, 'agents'));
    assert.ok(expected.length >= 3, 'examples/agents should ship the reviewer, debug-agent and security-agent');
    for (const n of expected) {
      assert.ok(all[n], `agent ${n} missing`);
      assert.equal(all[n].source, 'bundled');
      assert.equal(all[n].builtin, false);
    }
    assert.ok(all.build && all.build.builtin, 'built-in agents are untouched');
    assert.ok(agents.primaryAgents().some((a) => a.name === 'debug-agent'), 'mode: all agents show up in the dropdown');
  });
});

test('bundled: every examples/skills/<name>/SKILL.md is a default skill with a real base directory', () => {
  withBundled(() => {
    const all = skills.loadSkills(ctx.cfg.loadConfig());
    const expected = fs.readdirSync(path.join(EXAMPLES, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    assert.ok(expected.length >= 5);
    for (const n of expected) {
      assert.ok(all[n], `skill ${n} missing`);
      assert.equal(all[n].base, path.join(EXAMPLES, 'skills', n));
    }
    assert.ok(skills.promptSection(ctx.cfg.loadConfig()).includes('- commit-style:'));
  });
});

test('bundled: the user\'s own agents and skills override the bundled ones of the same name', () => {
  withBundled(() => {
    const dir = path.join(ctx.studioDir, 'agents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'reviewer.md'), '---\ndescription: my own reviewer\nmode: primary\n---\nMine.\n', 'utf8');
    const a = agents.loadAgents().reviewer;
    assert.equal(a.source, 'project');
    assert.equal(a.description, 'my own reviewer');
    assert.equal(a.prompt, 'Mine.');
    assert.equal(a.mode, 'primary');
    assert.ok(agents.loadAgents()['security-agent'], 'other bundled agents are unaffected');

    const sdir = path.join(ctx.studioDir, 'skills', 'commit-style');
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, 'SKILL.md'), '---\nname: commit-style\ndescription: my own style\n---\nMine.\n', 'utf8');
    const s = skills.loadSkills(ctx.cfg.loadConfig())['commit-style'];
    assert.equal(s.description, 'my own style');
    assert.equal(s.base, sdir);
    assert.ok(skills.loadSkills(ctx.cfg.loadConfig())['test-and-verify'], 'other bundled skills are unaffected');
  });
});

test('bundled: OLLAMA_STUDIO_NO_BUNDLED switches the layer off', () => {
  assert.equal(bundled.bundledRoot(), null);                  // setup() set it
  assert.ok(!agents.loadAgents()['security-agent']);
  assert.ok(!skills.loadSkills(ctx.cfg.loadConfig())['doc-generator']);
  withBundled(() => assert.equal(bundled.bundledRoot(), EXAMPLES));
});

test('unpack: writes the embedded files once, keeps modes, skips unsafe paths, prunes older builds', () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-unpack-'));
  try {
    const files = { 'agents/a.md': 'agent a', 'skills/s/SKILL.md': 'skill s', 'skills/s/scripts/run.sh': '#!/bin/sh\necho hi\n' };
    const reads = [];
    const read = (key) => { reads.push(key); const k = key.replace(/^examples\//, ''); return k in files ? Buffer.from(files[k]) : null; };
    const manifest = {
      hash: 'a'.repeat(64),
      files: [
        { path: 'agents/a.md' }, { path: 'skills/s/SKILL.md' }, { path: 'skills/s/scripts/run.sh', exec: true },
        { path: '../evil.txt' }, { path: '/abs.txt' },       // must be ignored, never written
      ],
    };
    const old = path.join(dest, 'b'.repeat(12));              // an unpacked older build
    fs.mkdirSync(old);
    fs.mkdirSync(path.join(dest, 'unrelated'));                // not ours: must survive pruning

    const out = bundled.unpack(manifest, read, dest);
    assert.equal(out, path.join(dest, 'a'.repeat(12)));
    assert.equal(fs.readFileSync(path.join(out, 'agents', 'a.md'), 'utf8'), 'agent a');
    assert.equal(fs.readFileSync(path.join(out, 'skills', 's', 'SKILL.md'), 'utf8'), 'skill s');
    assert.ok(fs.existsSync(path.join(out, '.complete')));
    if (process.platform !== 'win32') {
      assert.ok(fs.statSync(path.join(out, 'skills', 's', 'scripts', 'run.sh')).mode & 0o100, 'executable bit is kept');
      assert.ok(!(fs.statSync(path.join(out, 'agents', 'a.md')).mode & 0o111));
    }
    assert.ok(!fs.existsSync(path.join(dest, 'evil.txt')) && !fs.existsSync(path.join(out, '..', 'evil.txt')));
    assert.ok(!reads.some((k) => k.includes('evil') || k.includes('abs')));
    assert.ok(!fs.existsSync(old), 'older build directory is pruned');
    assert.ok(fs.existsSync(path.join(dest, 'unrelated')));
    assert.deepEqual(fs.readdirSync(dest).sort(), ['a'.repeat(12), 'unrelated']);   // no leftover .tmp dir

    // second start: already complete → nothing is read again
    reads.length = 0;
    assert.equal(bundled.unpack(manifest, read, dest), out);
    assert.equal(reads.length, 0);

    // a missing embedded file aborts cleanly and leaves no half-written directory behind
    const bad = bundled.unpack.bind(null, { hash: 'c'.repeat(64), files: [{ path: 'agents/missing.md' }] }, () => null, dest);
    assert.throws(bad, /missing/);
    assert.ok(!fs.readdirSync(dest).some((n) => n.startsWith('c'.repeat(12))));
  } finally { fs.rmSync(dest, { recursive: true, force: true }); }
});

test('unpacked layout is scannable by the normal agent and skill loaders', () => {
  // What a single executable ends up with: the same agents/ + skills/ tree, scanned like any other root.
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-scan-'));
  try {
    const all = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else all.push(path.relative(EXAMPLES, f).split(path.sep).join('/')); } })(path.join(EXAMPLES, 'agents'));
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else all.push(path.relative(EXAMPLES, f).split(path.sep).join('/')); } })(path.join(EXAMPLES, 'skills'));
    const out = bundled.unpack({ hash: 'd'.repeat(64), files: all.map((p) => ({ path: p })) }, (k) => fs.readFileSync(path.join(ROOT, k)), dest);
    assert.ok(fs.existsSync(path.join(out, 'agents', 'reviewer.md')));
    assert.ok(fs.existsSync(path.join(out, 'skills', 'commit-style', 'SKILL.md')));
    const { meta } = agents.parseFrontmatter(fs.readFileSync(path.join(out, 'agents', 'security-agent.md'), 'utf8'));
    assert.equal(typeof meta.description, 'string');
  } finally { fs.rmSync(dest, { recursive: true, force: true }); }
});
