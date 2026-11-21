'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const skills = require('../lib/skills');
const web = require('../lib/web');

const realFetch = global.fetch;
const md = (body, type = 'text/markdown') => new Response(body, { status: 200, headers: { 'content-type': type } });
const SKILL = '---\nname: remote-lint\ndescription: Lint things\n---\nRun the linter first.\n';

test('isRemoteRef: only http(s) URLs count as remote', () => {
  assert.equal(skills.isRemoteRef('https://example.com/SKILL.md'), true);
  assert.equal(skills.isRemoteRef('  http://example.com/x.md '), true);
  assert.equal(skills.isRemoteRef('commit-style'), false);
  assert.equal(skills.isRemoteRef('file:///etc/passwd'), false);
  assert.equal(skills.isRemoteRef(''), false);
});

test('loadRemote: parses a fetched SKILL.md and marks it untrusted', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  global.fetch = async () => md(SKILL);
  const text = await skills.loadRemote('https://raw.githubusercontent.com/remote-lint/SKILL.md', {});
  assert.ok(text.includes('<skill_content name="remote-lint" source="remote"'));
  assert.ok(text.includes('untrusted'));
  assert.ok(text.includes('Run the linter first.'));
  assert.ok(!text.includes('Base directory'));
});

test('loadRemote: rejects a private/internal URL unless allowPrivate is set', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  let called = false;
  global.fetch = async () => { called = true; return md(SKILL); };
  await assert.rejects(skills.loadRemote('http://169.254.169.254/latest/meta-data/SKILL.md', {}), /private|internal|blocked/i);
  assert.equal(called, false, 'no request must be made to a private address');
});

test('loadRemote: allowPrivate config lets a user-approved private skill load', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  global.fetch = async () => md(SKILL);
  const text = await skills.loadRemote('http://localhost:8080/SKILL.md', { webfetch: { allowPrivate: true } });
  assert.ok(text.includes('remote-lint'));
});

test('loadRemote: a skill without a name is rejected', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  global.fetch = async () => md('---\ndescription: no name\n---\nbody\n');
  await assert.rejects(skills.loadRemote('https://raw.githubusercontent.com/x/SKILL.md', {}), /no "name"/);
});

test('loadRemote: a GitHub repository URL discovers a SKILL.md', async (t) => {
  const realWebfetch = web.webfetch;
  t.after(() => { web.webfetch = realWebfetch; });
  const calls = [];
  web.webfetch = async ({ url }) => {
    calls.push(url);
    if (url.includes('api.github.com')) {
      return { content: JSON.stringify({ sha: 'abc123', tree: [
        { type: 'blob', path: 'README.md' },
        { type: 'blob', path: 'skills/pdf/SKILL.md' },
        { type: 'blob', path: 'skills/pdf/reference.md' },
        { type: 'blob', path: 'skills/other/SKILL.md' },
      ] }) };
    }
    if (url.includes('/skills/pdf/SKILL.md')) return { content: '---\nname: pdf\ndescription: PDF tools\n---\nUse PDF tools.\n', url };
    return { content: '---\nname: other\ndescription: Other tools\n---\nNo.\n', url };
  };
  const text = await skills.loadRemote('https://github.com/acme/skill-pack', {}, { skill: 'pdf' });
  assert.ok(text.includes('<skill_content name="pdf" source="remote"'));
  assert.ok(text.includes('Use PDF tools.'));
  assert.ok(calls[0].startsWith('https://api.github.com/repos/acme/skill-pack/git/trees/HEAD'));
  assert.ok(calls.some((u) => u.includes('/abc123/skills/pdf/SKILL.md')));
});

test('loadRemote: repo Markdown without frontmatter gets a derived name', async (t) => {
  const realWebfetch = web.webfetch;
  t.after(() => { web.webfetch = realWebfetch; });
  web.webfetch = async ({ url }) => {
    if (url.includes('api.github.com')) {
      return { content: JSON.stringify({ sha: 'def456', tree: [
        { type: 'blob', path: 'README.md' },
        { type: 'blob', path: 'AGENTS.md' },
        { type: 'blob', path: 'tests/fixtures/SKILL.md' },
      ] }) };
    }
    return { content: '# Agent skills\nUse these instructions.\n', url };
  };
  const text = await skills.loadRemote('https://github.com/agentskills/agentskills', {});
  assert.ok(text.includes('<skill_content name="agents" source="remote"'));
  assert.ok(text.includes('Use these instructions.'));
});

test('resolveRemoteRef: direct GitHub blob URLs stay raw', async () => {
  const target = await skills.resolveRemoteRef('https://github.com/o/r/blob/main/docs/SKILL.md', {});
  assert.equal(target, 'https://raw.githubusercontent.com/o/r/main/docs/SKILL.md');
});

test('loadAny: local names still use the local loader (no network)', async () => {
  let called = false;
  const realF = global.fetch;
  global.fetch = async () => { called = true; return md(SKILL); };
  try {
    await assert.rejects(skills.loadAny('definitely-not-a-skill', {}), /not found/);
    assert.equal(called, false);
  } finally { global.fetch = realF; }
});
