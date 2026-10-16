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

test('promptSection: lists available skills, empty when there are none', () => {
  const withSkills = skills.promptSection(ctx.cfg.loadConfig());
  assert.ok(withSkills.includes('- commit-style: Write good commit messages'));
  assert.ok(withSkills.includes('- deploy: Ship it'));

  const config = { ...ctx.cfg.loadConfig(), skills: { paths: [] } };
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
