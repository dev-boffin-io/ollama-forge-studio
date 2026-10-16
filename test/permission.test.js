'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/permission');

test('wildcard: *, ? and literal escaping', () => {
  assert.equal(P.wildcard('anything', '*'), true);
  assert.equal(P.wildcard('ls', 'ls *'), true);          // "ls *" also matches bare "ls"
  assert.equal(P.wildcard('ls -la /tmp', 'ls *'), true);
  assert.equal(P.wildcard('lsfoo', 'ls *'), false);
  assert.equal(P.wildcard('git status', 'git status*'), true);
  assert.equal(P.wildcard('git status --short', 'git status*'), true);
  assert.equal(P.wildcard('git stash', 'git status*'), false);
  assert.equal(P.wildcard('abc', 'a?c'), true);
  assert.equal(P.wildcard('aXc', 'a?c'), true);
  assert.equal(P.wildcard('ac', 'a?c'), false);
  assert.equal(P.wildcard('rm (x)', 'rm (x)'), true);    // regex metacharacters are literal
  assert.equal(P.wildcard('rm ax', 'rm (x)'), false);
});

test('fromConfig: string and pattern-map forms, invalid actions dropped', () => {
  assert.deepEqual(P.fromConfig({ edit: 'deny', bash: { '*': 'ask', 'ls *': 'allow', 'rm *': 'nope' } }), [
    { permission: 'edit', pattern: '*', action: 'deny' },
    { permission: 'bash', pattern: '*', action: 'ask' },
    { permission: 'bash', pattern: 'ls *', action: 'allow' },
  ]);
  assert.deepEqual(P.fromConfig(null), []);
  assert.deepEqual(P.fromConfig({ read: 'wrong' }), []);
});

test('evaluate: last matching rule wins, default is ask', () => {
  const rules = [
    { permission: '*', pattern: '*', action: 'allow' },
    { permission: 'bash', pattern: '*', action: 'ask' },
    { permission: 'bash', pattern: 'ls *', action: 'allow' },
  ];
  assert.equal(P.evaluate('bash', 'ls -la', rules).action, 'allow');
  assert.equal(P.evaluate('bash', 'rm -rf x', rules).action, 'ask');
  assert.equal(P.evaluate('edit', 'x.js', rules).action, 'allow');
  assert.equal(P.evaluate('bash', 'rm x', []).action, 'ask');
});

test('decide: defaults < config < agent layering', () => {
  const base = { session: { grants: {} }, inherited: [] };
  assert.equal(P.decide('edit', 'a.js', { ...base, agent: {}, config: {} }), 'allow'); // BASE_RULES
  const config = { permission: { bash: { '*': 'ask', 'ls *': 'allow' } } };
  assert.equal(P.decide('bash', 'ls -la', { ...base, agent: {}, config }), 'allow');
  assert.equal(P.decide('bash', 'rm -rf x', { ...base, agent: {}, config }), 'ask');
  // agent layer wins over config
  const agent = { permission: { bash: 'deny' } };
  assert.equal(P.decide('bash', 'ls -la', { ...base, agent, config }), 'deny');
  // config layer wins over defaults
  assert.equal(P.decide('edit', 'a.js', { ...base, agent: {}, config: { permission: { edit: 'ask' } } }), 'ask');
});

test('decide: session grants can allow an "ask" but never override a deny', () => {
  const askCtx = {
    agent: {}, config: { permission: { bash: { '*': 'ask' } } },
    session: { grants: [{ permission: 'bash', pattern: 'git status *', action: 'allow' }] }, inherited: [],
  };
  assert.equal(P.decide('bash', 'git status --short', askCtx), 'allow');
  assert.equal(P.decide('bash', 'rm -rf x', askCtx), 'ask');
  const denyCtx = { ...askCtx, config: { permission: { bash: { '*': 'deny' } } } };
  assert.equal(P.decide('bash', 'git status --short', denyCtx), 'deny');
});

test('normalizeGrants: legacy object form becomes an allow list', () => {
  const session = { grants: { bash: true, edit: false } };
  assert.deepEqual(P.normalizeGrants(session), [{ permission: 'bash', pattern: '*', action: 'allow' }]);
  const arr = [{ permission: 'read', pattern: '*', action: 'allow' }];
  assert.equal(P.normalizeGrants({ grants: arr }), arr);
});

test('disabled: only a final "*"-deny hides a permission category', () => {
  assert.equal(P.disabled('edit', { permission: { edit: 'deny' } }, {}), true);
  assert.equal(P.disabled('edit', {}, {}), false);
  // plan-style: deny * but allow .studio/plans/*.md -> the last rule is not a blanket deny
  assert.equal(P.disabled('edit', { permission: { edit: { '*': 'deny', '.studio/plans/*.md': 'allow' } } }, {}), false);
  assert.equal(P.disabled('bash', { permission: { bash: 'deny' } }, {}), true);
  assert.equal(P.disabled('webfetch', {}, { permission: { webfetch: 'deny' } }), true);
});

test('decideBash: every segment must pass; deny anywhere wins', () => {
  // (segment splitting: &&, ||, ;, | and newlines all split)
  const ctx = { agent: {}, config: { permission: { bash: { '*': 'ask', 'ls *': 'allow', 'pwd': 'allow' } } }, session: { grants: {} }, inherited: [] };
  assert.equal(P.decideBash('ls -la', ctx), 'allow');
  assert.equal(P.decideBash('ls && pwd', ctx), 'allow');
  assert.equal(P.decideBash('ls && rm -rf /tmp/x', ctx), 'ask');       // rm falls back to '*': ask
  assert.equal(P.decideBash('', ctx), 'deny');
  const deny = { ...ctx, config: { permission: { bash: { '*': 'allow', 'rm *': 'deny' } } } };
  assert.equal(P.decideBash('ls && rm -rf /tmp/x', deny), 'deny');
});

test('decideBash: redirects and substitutions are never auto-allowed', () => {
  const ctx = { agent: {}, config: { permission: { bash: { '*': 'allow' } } }, session: { grants: {} }, inherited: [] };
  assert.equal(P.decideBash('echo hi > out.txt', ctx), 'ask');
  assert.equal(P.decideBash('cat $(ls)', ctx), 'ask');
  assert.equal(P.decideBash('echo `date`', ctx), 'ask');
  // an exact grant of the complex command promotes it back to allow
  ctx.session.grants = [{ permission: 'bash', pattern: 'echo hi > out.txt', action: 'allow', exact: 'echo hi > out.txt' }];
  assert.equal(P.decideBash('echo hi > out.txt', ctx), 'allow');
});

test('grant: remembers the shape of a command, dangerous tools stay exact', () => {
  const s = { grants: {} };
  P.grant(s, 'bash', 'git status --short');
  P.grant(s, 'bash', 'rm -rf node_modules');
  P.grant(s, 'bash', 'cat a.txt && ls');
  P.grant(s, 'edit', '*');
  P.grant(s, 'webfetch', 'https://example.com/docs/page');
  const g = s.grants;
  assert.ok(g.some((x) => x.permission === 'bash' && x.pattern === 'git status *'));
  assert.ok(g.some((x) => x.permission === 'bash' && x.pattern === 'rm -rf node_modules')); // exact only
  assert.ok(g.some((x) => x.permission === 'bash' && x.pattern === 'cat *'));
  assert.ok(g.some((x) => x.permission === 'bash' && x.pattern === 'ls *'));
  assert.ok(g.some((x) => x.permission === 'edit' && x.pattern === '*'));
  assert.ok(g.some((x) => x.permission === 'webfetch' && x.pattern === 'https://example.com/*'));

  // a remembered shape actually allows later runs
  const ctx = { agent: {}, config: { permission: { bash: { '*': 'ask' } } }, session: s, inherited: [] };
  assert.equal(P.decideBash('git status --short', ctx), 'allow');
  assert.equal(P.decideBash('git push', ctx), 'ask');
});

test('rulesFor: BASE_RULES come first so config/agent rules override them', () => {
  const rules = P.rulesFor({}, { permission: { edit: 'deny' } }, []);
  assert.equal(rules[0], P.BASE_RULES[0]);
  assert.equal(P.evaluate('edit', 'x.js', rules).action, 'deny');
  // .env reads ask by default (SSRF-ish guard in BASE_RULES)
  assert.equal(P.evaluate('read', '.env', P.rulesFor({}, {}, [])).action, 'ask');
  assert.equal(P.evaluate('read', '.env.example', P.rulesFor({}, {}, [])).action, 'allow');
  assert.equal(P.evaluate('read', 'src/a.js', P.rulesFor({}, {}, [])).action, 'allow');
});
