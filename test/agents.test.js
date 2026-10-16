'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');

const ctx = setup();
const agents = require('../lib/agents');

test('parseFrontmatter: scalars, numbers, nested maps, comments', () => {
  const text = [
    '---',
    'description: "Reviews code"',
    'mode: all',
    'temperature: 0.1',
    'hidden: false',
    'permission:',
    '  edit: deny',
    '  bash:',
    "    '*': ask",
    '    ls *: allow',
    '# a comment line',
    '---',
    'System prompt body.',
  ].join('\n');
  const { meta, body } = agents.parseFrontmatter(text);
  assert.equal(meta.description, 'Reviews code');
  assert.equal(meta.mode, 'all');
  assert.equal(meta.temperature, 0.1);
  assert.equal(meta.hidden, false);
  assert.deepEqual(meta.permission, { edit: 'deny', bash: { '*': 'ask', 'ls *': 'allow' } });
  assert.equal(body, 'System prompt body.');
});

test('parseFrontmatter: text without frontmatter is the body', () => {
  const { meta, body } = agents.parseFrontmatter('just some text\n');
  assert.deepEqual(meta, {});
  assert.equal(body, 'just some text');
});

test('built-in agents: build / plan / general / explore', () => {
  const all = agents.loadAgents();
  for (const name of ['build', 'plan', 'general', 'explore']) assert.ok(all[name], `missing ${name}`);
  assert.equal(all.plan.mode, 'primary');
  assert.equal(all.general.mode, 'subagent');
  assert.equal(all.explore.mode, 'subagent');
  assert.equal(agents.getAgent('nope'), null);

  const primary = agents.primaryAgents().map((a) => a.name);
  assert.ok(primary.includes('build') && primary.includes('plan'));
  assert.ok(!primary.includes('explore'));

  const subs = agents.subagents().map((a) => a.name);
  assert.ok(subs.includes('general') && subs.includes('explore'));
  assert.ok(!subs.includes('build'));
});

test('plan agent is read-only except for .studio/plans/*.md', () => {
  const plan = agents.getAgent('plan');
  assert.ok(plan.permission.edit['*'] === 'deny');
  assert.ok(plan.permission.edit['.studio/plans/*.md'] === 'allow');
  assert.ok(plan.append.includes('PLAN MODE'));
});

test('custom agents load from the project agent folder', () => {
  const dir = path.join(ctx.studioDir, 'agents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'reviewer.md'), '---\ndescription: Reviews code\nmode: subagent\nmodel: llama3.1:8b\npermission:\n  edit: deny\n---\nReview things.\n', 'utf8');
  const a = agents.getAgent('reviewer');
  assert.ok(a);
  assert.equal(a.source, 'project');
  assert.equal(a.mode, 'subagent');
  assert.equal(a.model, 'llama3.1:8b');
  assert.deepEqual(a.permission, { edit: 'deny' });
  assert.equal(a.prompt, 'Review things.');
  assert.ok(agents.subagents().some((x) => x.name === 'reviewer'));
});

test('composeSystem includes working directory and agent prompt', () => {
  const build = agents.getAgent('build');
  const text = agents.composeSystem({ agent: build, config: ctx.cfg.loadConfig(), canDelegate: false, rules: [], session: null });
  assert.ok(text.includes(`Working directory: ${ctx.cfg.getWorkDir()}`));
  const plan = agents.getAgent('plan');
  const planText = agents.composeSystem({ agent: plan, config: ctx.cfg.loadConfig(), canDelegate: false, rules: [], session: null });
  assert.ok(planText.includes('PLAN MODE'));
});
