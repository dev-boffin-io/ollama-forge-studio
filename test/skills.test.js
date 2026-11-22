'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');

const ctx = setup();
const skills = require('../lib/skills');

test('loadSkills: finds SKILL.md folders from project and studio dirs', () => {
  const proj = path.join(ctx.dir, '.claude', 'skills', 'commit-style');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'SKILL.md'), '---\nname: commit-style\ndescription: Write good commit messages\n---\nUse a imperative mood.\n', 'utf8');
  fs.writeFileSync(path.join(proj, 'extra.txt'), 'file sample', 'utf8');

  const studio = path.join(ctx.studioDir, 'skills', 'deploy');
  fs.mkdirSync(studio, { recursive: true });
  fs.writeFileSync(path.join(studio, 'SKILL.md'), '---\nname: deploy\ndescription: Ship it\n---\nDeploy steps.\n', 'utf8');

  const all = skills.loadSkills(ctx.cfg.loadConfig());
  assert.ok(all['commit-style']);
  assert.equal(all['commit-style'].description, 'Write good commit messages');
  assert.equal(all['commit-style'].content, 'Use a imperative mood.');
  assert.equal(all['commit-style'].base, proj);
  assert.ok(all.deploy);

  // a SKILL.md without a name is ignored
  const broken = path.join(ctx.dir, '.agents', 'skills', 'broken');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'SKILL.md'), '---\ndescription: no name\n---\nbody\n', 'utf8');
  assert.ok(!skills.loadSkills(ctx.cfg.loadConfig()).broken);
});

test('load: wraps the skill body with its base directory and file list', () => {
  const text = skills.load('commit-style', ctx.cfg.loadConfig());
  assert.ok(text.includes('<skill_content name="commit-style">'));
  assert.ok(text.includes('# Skill: commit-style'));
  assert.ok(text.includes('Use a imperative mood.'));
  assert.ok(text.includes('Base directory for this skill:'));
  assert.ok(text.includes('<file>extra.txt</file>'));
  assert.throws(() => skills.load('no-such-skill', ctx.cfg.loadConfig()), /not found.*commit-style/);
});

test('selectAutoSkills: ranks by the request and respects exclude/include/auto:false', () => {
  const dir = path.join(ctx.dir, '.agents', 'skills', 'docker-compose-review');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: docker-compose-review\ndescription: Review docker compose deployments\n---\nCheck the compose file.\n', 'utf8');
  const optOut = path.join(ctx.dir, '.agents', 'skills', 'auto-opt-out');
  fs.mkdirSync(optOut, { recursive: true });
  fs.writeFileSync(path.join(optOut, 'SKILL.md'), '---\nname: auto-opt-out\ndescription: Review docker compose deployments\nauto: false\n---\nDo not auto-select this.\n', 'utf8');

  const auto = { enabled: true, count: 2, minScore: 1, maxChars: 4000, totalChars: 12000, include: [], exclude: [], fallback: [] };
  const cfg = { ...ctx.cfg.loadConfig(), skills: { paths: [], auto }, remoteSkills: { enabled: false } };
  const query = 'please review our docker compose setup';
  const picked = skills.selectAutoSkills(query, cfg);
  assert.equal(picked[0].name, 'docker-compose-review');
  assert.ok(!picked.some((s) => s.name === 'auto-opt-out'));

  const excluded = skills.selectAutoSkills(query, { ...cfg, skills: { ...cfg.skills, auto: { ...auto, exclude: ['docker-compose-review'] } } });
  assert.ok(!excluded.some((s) => s.name === 'docker-compose-review'));

  const pinned = skills.selectAutoSkills('totally unrelated', { ...cfg, skills: { ...cfg.skills, auto: { ...auto, count: 1, include: ['docker-compose-review'] } } });
  assert.equal(pinned[0].name, 'docker-compose-review');
});

test('configured remotesPath loads an external skill library without listing it', () => {
  const remotes = path.join(ctx.dir, 'external-remotes');
  const base = path.join(remotes, 'skills', 'pack', 'disk-only-skill');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'SKILL.md'), '---\nname: disk-only-skill\ndescription: Disk only review steps\n---\nDisk body.\n', 'utf8');

  const auto = { enabled: true, count: 1, minScore: 1, maxChars: 4000, totalChars: 12000, include: [], exclude: [], fallback: [] };
  const cfg = { ...ctx.cfg.loadConfig(), skills: { paths: [], remotesPath: remotes, auto }, remoteSkills: { enabled: false } };
  const picked = skills.selectAutoSkills('disk only review', cfg);
  assert.equal(picked[0].name, 'disk-only-skill');
  assert.equal(picked[0].source, 'remotes');
  assert.match(skills.loadRemoteBundled('disk-only-skill', cfg), /source="remotes"/);
  assert.ok(!skills.promptSection(cfg).includes('- disk-only-skill:'));
});

test('autoContext: injects selected skills and caps their body length', () => {
  const dir = path.join(ctx.dir, '.agents', 'skills', 'long-auto-skill');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: long-auto-skill\ndescription: Long body\n---\n${'x'.repeat(300)}\n`, 'utf8');
  const auto = { enabled: true, count: 1, minScore: 1, maxChars: 80, totalChars: 80, include: ['long-auto-skill'], exclude: [], fallback: [] };
  const cfg = { ...ctx.cfg.loadConfig(), skills: { paths: [], auto }, remoteSkills: { enabled: false } };
  const text = skills.autoContext('anything', cfg);
  assert.match(text, /<auto_skill name="long-auto-skill" source="local">/);
  assert.match(text, /truncated/);
  assert.ok(text.includes('x'.repeat(80)));
  assert.ok(!text.includes('x'.repeat(81)));
});

test('promptSection: lists available skills, empty when there are none', () => {
  const withSkills = skills.promptSection(ctx.cfg.loadConfig());
  assert.match(withSkills, /attached automatically/);
  assert.ok(withSkills.includes('- commit-style: Write good commit messages'));
  assert.ok(withSkills.includes('- deploy: Ship it'));

  const config = { ...ctx.cfg.loadConfig(), skills: { paths: [] }, remoteSkills: { enabled: false } };
  // point at an empty set of roots by using a fresh workdir with no skill folders
  const empty = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'skills-empty-'));
  ctx.cfg.setWorkDir(empty);
  const text = skills.promptSection(config);
  const realHome = require('node:os').homedir();
  const homeHasSkills = ['.claude/skills', '.agents/skills'].some((p) => fs.existsSync(path.join(realHome, p)));
  const globalHasSkills = fs.existsSync(path.join(ctx.cfg.GLOBAL_DIR, 'skills'));
  if (!homeHasSkills && !globalHasSkills) assert.equal(text, '');
  else assert.ok(typeof text === 'string');
  fs.rmSync(empty, { recursive: true, force: true });
  ctx.cfg.setWorkDir(ctx.dir);
});
