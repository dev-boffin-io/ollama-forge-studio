'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const web = require('../lib/web');
const skills = require('../lib/skills');

const realFetch = global.fetch;
const md = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/markdown' } });
const SKILL = '---\nname: gh-skill\ndescription: x\n---\nDo the thing.\n';

test('netEnabled: on by default, off only when explicitly false', () => {
  assert.equal(web.netEnabled({}), true);
  assert.equal(web.netEnabled({ netcheck: true }), true);
  assert.equal(web.netEnabled({ netcheck: false }), false);
});

test('netcheck off: remote skills are refused before any request', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  let called = false;
  global.fetch = async () => { called = true; return md(SKILL); };
  await assert.rejects(skills.loadRemote('https://github.com/a/b/blob/main/SKILL.md', { netcheck: false }), /netcheck/);
  assert.equal(called, false);
});

test('toRawUrl: GitHub and Codeberg view links become raw links', () => {
  assert.equal(skills.toRawUrl('https://github.com/o/r/blob/main/skills/x/SKILL.md'), 'https://raw.githubusercontent.com/o/r/main/skills/x/SKILL.md');
  assert.equal(skills.toRawUrl('https://codeberg.org/o/r/src/branch/main/SKILL.md'), 'https://codeberg.org/o/r/raw/branch/main/SKILL.md');
  assert.equal(skills.toRawUrl('https://example.com/SKILL.md'), 'https://example.com/SKILL.md');
});

test('allowlist: a GitHub skill loads from the raw host by default', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  let seen = '';
  global.fetch = async (u) => { seen = String(u); return md(SKILL); };
  const text = await skills.loadRemote('https://github.com/o/r/blob/main/SKILL.md', {});
  assert.ok(seen.startsWith('https://raw.githubusercontent.com/o/r/main/SKILL.md'));
  assert.ok(text.includes('gh-skill'));
});

test('allowlist: a host outside the list is refused by default, allowed when configured', async (t) => {
  t.after(() => { global.fetch = realFetch; });
  global.fetch = async () => md(SKILL);
  await assert.rejects(skills.loadRemote('https://www.reddit.com/r/x/SKILL.md', {}), /not in remoteSkills.allowHosts/);
  const text = await skills.loadRemote('https://www.reddit.com/r/x/SKILL.md', { remoteSkills: { allowHosts: ['reddit.com'] } });
  assert.ok(text.includes('gh-skill'));
});

test('remoteOn: needs netcheck on and remoteSkills.enabled not false', () => {
  assert.equal(skills.remoteOn({}), true);
  assert.equal(skills.remoteOn({ remoteSkills: { enabled: false } }), false);
  assert.equal(skills.remoteOn({ netcheck: false }), false);
  assert.equal(skills.remoteOn({ remoteSkills: { enabled: true } }), true);
});

test('pickCandidates: keeps only SKILL.md on allowed hosts, as raw URLs, deduplicated', () => {
  const items = [
    { url: 'https://github.com/o/r/blob/main/SKILL.md' },
    { url: 'https://github.com/o/r/blob/main/SKILL.md' },
    { url: 'https://codeberg.org/o/r/src/branch/main/SKILL.md' },
    { url: 'https://www.reddit.com/r/x/comments/1/SKILL.md' },
    { url: 'https://github.com/o/r' },
    { url: 'https://github.com/o/r/blob/main/README.md' },
    { url: 'not a url' },
  ];
  assert.deepEqual(skills.pickCandidates(items, {}), [
    'https://raw.githubusercontent.com/o/r/main/SKILL.md',
    'https://codeberg.org/o/r/raw/branch/main/SKILL.md',
  ]);
});

test('discover: finds and loads a skill for a topic name with no URL from the user', async (t) => {
  const realWs = web.websearch;
  const realFetch = global.fetch;
  t.after(() => { web.websearch = realWs; global.fetch = realFetch; });
  let query = '';
  web.websearch = async (q) => { query = q; return [{ url: 'https://www.reddit.com/x' }, { url: 'https://github.com/o/discover-test/blob/main/SKILL.md' }]; };
  global.fetch = async () => md(SKILL);
  const asked = [];
  const text = await skills.discover('lint review', {}, async (cat, pat) => { asked.push(cat); });
  assert.ok(query.includes('lint review'));
  assert.ok(text.includes('gh-skill'));
  assert.deepEqual(asked, ['websearch', 'webfetch']);
});

test('discover: a refused permission stops the search', async (t) => {
  const realWs = web.websearch;
  t.after(() => { web.websearch = realWs; });
  let searched = false;
  web.websearch = async () => { searched = true; return []; };
  await assert.rejects(skills.discover('x', {}, async () => { throw new Error('permission rejected by the user.'); }), /rejected/);
  assert.equal(searched, false);
});

test('discover: no matching host gives a clear error', async (t) => {
  const realWs = web.websearch;
  t.after(() => { web.websearch = realWs; });
  web.websearch = async () => [{ url: 'https://www.reddit.com/x' }];
  await assert.rejects(skills.discover('nothing', {}, async () => {}), /no remote skill found/);
});

test('promptSection: shows the URL-free remote hint when remote is on, nothing when off', () => {
  const on = skills.promptSection({ remoteSkills: { enabled: true } });
  assert.ok(on.includes('You do not need a URL'));
  assert.equal(skills.promptSection({ remoteSkills: { enabled: false } }).includes('You do not need a URL'), false);
  assert.equal(skills.promptSection({ netcheck: false }).includes('You do not need a URL'), false);
});
