'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { setup } = require('./helpers');

const ctx = setup();
const ROOT = path.resolve(__dirname, '..');
const EXTRAS = path.join(ROOT, 'extras');
const agents = require('../lib/agents');
const commands = require('../lib/commands');
const skills = require('../lib/skills');
const plugins = require('../lib/plugins');
const hooks = require('../lib/hooks');
const tools = require('../lib/tools');
const P = require('../lib/permission');

const withBundled = (fn) => {
  const prev = process.env.OLLAMA_STUDIO_NO_BUNDLED;
  delete process.env.OLLAMA_STUDIO_NO_BUNDLED;
  try { return fn(); } finally { if (prev === undefined) delete process.env.OLLAMA_STUDIO_NO_BUNDLED; else process.env.OLLAMA_STUDIO_NO_BUNDLED = prev; }
};
const decide = (agent, permission, pattern) => P.decide(permission, pattern, { agent, config: ctx.cfg.loadConfig(), session: { grants: [] }, inherited: [] });

/* ---------- bundled agents ---------- */

const NEW_AGENTS = ['architect', 'test-engineer', 'doc-writer', 'performance-optimizer'];

test('new bundled agents load, are selectable, but stay out of the auto rotation', () => {
  withBundled(() => {
    const all = agents.loadAgents();
    for (const n of NEW_AGENTS) {
      assert.ok(all[n], `${n} missing`);
      assert.equal(all[n].source, 'bundled');
      assert.equal(all[n].mode, 'all');
      assert.ok(all[n].description.length > 20, `${n} needs a description`);
      assert.ok(all[n].prompt && all[n].prompt.includes('## Rules'), `${n} needs rules`);
      assert.ok(agents.primaryAgents().some((a) => a.name === n), `${n} should be in the dropdown`);
      assert.ok(!agents.autoCandidates().some((a) => a.name === n), `${n} must not clutter auto mode`);
    }
  });
});

test('architect: may only write design documents, bash is read-only', () => {
  withBundled(() => {
    const a = agents.getAgent('architect');
    assert.equal(decide(a, 'edit', 'src/app.js'), 'deny');
    assert.equal(decide(a, 'edit', 'package.json'), 'deny');
    assert.equal(decide(a, 'edit', '.studio/plans/new-auth.md'), 'allow');
    assert.equal(decide(a, 'edit', 'docs/architecture/overview.md'), 'allow');
    assert.equal(decide(a, 'bash', 'git log --oneline'), 'allow');
    assert.equal(decide(a, 'bash', 'npm install left-pad'), 'deny');
    assert.equal(decide(a, 'bash', 'cat a > b'), 'deny');
  });
});

test('test-engineer: edits test files only and may run the usual test runners', () => {
  withBundled(() => {
    const a = agents.getAgent('test-engineer');
    for (const f of ['src/app.js', 'lib/latest.js', 'README.md', 'package.json']) assert.equal(decide(a, 'edit', f), 'deny', f);
    for (const f of ['src/app.test.js', 'src/app.spec.ts', 'pkg/user_test.go', 'tests/test_user.py', 'test/unit/a.js', 'src/__tests__/a.js', 'conftest.py', 'api/tests/conftest.py']) assert.equal(decide(a, 'edit', f), 'allow', f);
    assert.equal(decide(a, 'bash', 'npm test'), 'allow');
    assert.equal(decide(a, 'bash', 'pytest -q tests/'), 'allow');
    assert.equal(decide(a, 'bash', 'go test ./...'), 'allow');
    assert.equal(decide(a, 'bash', 'rm -rf node_modules'), 'ask');
  });
});

test('doc-writer: markdown and docs/ freely, source files only after asking, no bash writes', () => {
  withBundled(() => {
    const a = agents.getAgent('doc-writer');
    assert.equal(decide(a, 'edit', 'README.md'), 'allow');
    assert.equal(decide(a, 'edit', 'docs/api/users.md'), 'allow');
    assert.equal(decide(a, 'edit', 'src/index.ts'), 'ask');
    assert.equal(decide(a, 'bash', 'git diff HEAD~1'), 'allow');
    assert.equal(decide(a, 'bash', 'npm publish'), 'deny');
  });
});

test('performance-optimizer: changes and commands ask first, reading is free', () => {
  withBundled(() => {
    const a = agents.getAgent('performance-optimizer');
    assert.equal(decide(a, 'edit', 'src/a.js'), 'ask');
    assert.equal(decide(a, 'bash', 'node bench.js'), 'ask');
    assert.equal(decide(a, 'bash', 'git status'), 'allow');
    assert.equal(decide(a, 'read', 'src/a.js'), 'allow');
  });
});

test('hidden edit tools: architect keeps edit tools (path rules), a deny-all agent would not', () => {
  withBundled(() => {
    const names = (agent) => tools.toolDefsFor(agent, ctx.cfg.loadConfig(), { isChild: false }).map((d) => d.function.name);
    assert.ok(names(agents.getAgent('architect')).includes('write_file'), 'path-scoped edit rules must keep write_file visible');
  });
});

/* ---------- bundled skills ---------- */

test('new bundled skills load with a real base directory and appear in the prompt', () => {
  withBundled(() => {
    const cfg = ctx.cfg.loadConfig();
    const all = skills.loadSkills(cfg);
    for (const n of ['project-onboarding', 'dependency-upgrade', 'release-notes', 'bug-triage', 'i18n-l10n']) {
      assert.ok(all[n], `${n} missing`);
      assert.equal(all[n].base, path.join(ROOT, 'examples', 'skills', n));
      assert.ok(skills.promptSection(cfg).includes(`- ${n}:`));
    }
  });
});

/* ---------- extras are opt-in ---------- */

const extraSkillNames = () => fs.readdirSync(path.join(EXTRAS, 'skills'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

test('extras/skills: valid frontmatter, name = folder, each ends with a verification-style rule block', () => {
  const names = extraSkillNames();
  assert.deepEqual(names.sort(), ['api-designer', 'database-migration', 'docker-expert']);
  for (const n of names) {
    const text = fs.readFileSync(path.join(EXTRAS, 'skills', n, 'SKILL.md'), 'utf8');
    const { meta, body } = agents.parseFrontmatter ? agents.parseFrontmatter(text) : { meta: {}, body: text };
    if (agents.parseFrontmatter) {
      assert.equal(meta.name, n);
      assert.ok(String(meta.description).length > 30, `${n}: description`);
    }
    assert.match(body, /\nRules: /, `${n}: needs a Rules line`);
  }
});

test('extras are NOT loaded by default, only when config.skills.paths points at them', () => {
  const base = ctx.cfg.loadConfig();
  for (const n of extraSkillNames()) assert.equal(skills.loadSkills(base)[n], undefined, `${n} must be opt-in`);
  const on = skills.loadSkills({ ...base, skills: { paths: [path.join(EXTRAS, 'skills')] } });
  for (const n of extraSkillNames()) assert.ok(on[n], `${n} should load when enabled`);
});

test('the bundled examples/ folder contains none of the extras', () => {
  for (const n of extraSkillNames()) assert.ok(!fs.existsSync(path.join(ROOT, 'examples', 'skills', n)), `${n} must live in extras only`);
  for (const n of ['release-manager', 'support-triage']) assert.ok(!fs.existsSync(path.join(ROOT, 'examples', 'agents', `${n}.md`)), `${n} must live in extras only`);
  for (const n of ['review', 'verify']) assert.ok(!fs.existsSync(path.join(ROOT, 'examples', 'commands', `${n}.md`)), `${n} must live in extras only`);
});

/* ---------- http_request plugin ---------- */

let server; let port;
test('http_request: set up a local test server', async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url === '/redirect') { res.writeHead(302, { Location: '/json' }); return res.end(); }
      if (req.url === '/text') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('x'.repeat(5000)); }
      if (req.url === '/slow') return setTimeout(() => res.end('late'), 3000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization || null, ctype: req.headers['content-type'] || null, got: body ? JSON.parse(body) : null, data: { items: [{ id: 1, n: 'a' }, { id: 2, n: 'b' }], total: 2 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

async function loadHttp(extraCfg = {}) {
  plugins.reset(); hooks.reset();
  const dir = path.join(ctx.studioDir, 'plugins');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'http-request'), { recursive: true });
  fs.copyFileSync(path.join(EXTRAS, 'plugins', 'http-request', 'plugin.js'), path.join(dir, 'http-request', 'plugin.js'));
  const status = await plugins.load({ ...ctx.cfg.loadConfig(), http: { allowPrivate: [`127.0.0.1:${port}`], ...extraCfg } });
  assert.equal(status.errors.length, 0, JSON.stringify(status.errors));
  assert.ok(plugins.isTool('http_request'));
}
const call = (args, askPermission = async () => 'reject') => plugins.callTool('http_request', args, { askPermission, signal: undefined });
const parse = (r) => JSON.parse(r.output);

test('http_request: GET returns compact JSON, pick filters it, headers are reduced', async () => {
  await loadHttp();
  const r = parse(await call({ url: `http://127.0.0.1:${port}/json` }));
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(JSON.parse(r.body).data.total, 2);
  const p = parse(await call({ url: `http://127.0.0.1:${port}/json`, pick: ['data.items[*].id', 'data.total', 'nothing.here'] }));
  assert.deepEqual(p.json['data.items[*].id'], [1, 2]);
  assert.equal(p.json['data.total'], 2);
  assert.equal(p.json['nothing.here'], undefined);
});

test('http_request: POST json sets the content type; redirects are not followed; big bodies are truncated', async () => {
  await loadHttp();
  const r = parse(await call({ method: 'POST', url: `http://127.0.0.1:${port}/x`, json: { a: 1 } }));
  const body = JSON.parse(r.body);
  assert.equal(body.method, 'POST');
  assert.equal(body.ctype, 'application/json');
  assert.deepEqual(body.got, { a: 1 });
  const red = parse(await call({ url: `http://127.0.0.1:${port}/redirect` }));
  assert.equal(red.status, 302);
  assert.equal(red.headers.location, '/json');
  assert.match(red.note, /not followed/);
  const big = parse(await call({ url: `http://127.0.0.1:${port}/text`, max_bytes: 1000 }));
  assert.equal(big.body.length, 1000);
  assert.match(big.truncated, /4000 more/);
});

test('http_request: secrets come from allowEnv only and never from the model', async () => {
  await loadHttp({ allowEnv: ['STUDIO_TEST_TOKEN'] });
  process.env.STUDIO_TEST_TOKEN = 's3cret';
  const ok = parse(await call({ url: `http://127.0.0.1:${port}/json`, headers: { Authorization: 'Bearer {{env:STUDIO_TEST_TOKEN}}' } }));
  assert.equal(JSON.parse(ok.body).auth, 'Bearer s3cret');
  assert.ok(!ok.output && !JSON.stringify(ok).includes('{{env'), 'placeholders are replaced before sending');
  process.env.STUDIO_TEST_OTHER = 'nope';
  await assert.rejects(() => call({ url: `http://127.0.0.1:${port}/json`, headers: { X: '{{env:STUDIO_TEST_OTHER}}' } }), /not listed in config\.http\.allowEnv/);
  await assert.rejects(() => call({ url: `http://u:p@127.0.0.1:${port}/json` }), /credentials inside the URL/);
});

test('http_request: private addresses need approval unless allowlisted; allowHosts restricts public hosts; bad input is refused', async () => {
  await loadHttp({ allowPrivate: [] });                           // nothing allowlisted
  await assert.rejects(() => call({ url: `http://127.0.0.1:${port}/json` }), /need approval/);
  const asked = [];
  const r = parse(await call({ url: `http://127.0.0.1:${port}/json` }, async (q) => { asked.push(q); return 'once'; }));
  assert.equal(r.status, 200);
  assert.equal(asked[0].category, 'webfetch_private');
  await assert.rejects(() => call({ url: 'http://169.254.169.254/latest/meta-data' }), /need approval/);   // cloud metadata address

  await loadHttp({ allowHosts: ['api.example.com', '*.github.com'] });
  await assert.rejects(() => call({ url: 'https://evil.example.org/x' }), /not in config\.http\.allowHosts/);
  await assert.rejects(() => call({ url: 'file:///etc/passwd' }), /only http and https/);
  await assert.rejects(() => call({ url: 'not a url' }), /not a valid absolute URL/);
  await assert.rejects(() => call({ url: `http://127.0.0.1:${port}/x`, method: 'TRACE' }), /method must be/);
});

test('http_request: timeout is reported clearly', async () => {
  await loadHttp();
  await assert.rejects(() => call({ url: `http://127.0.0.1:${port}/slow`, timeout_seconds: 1 }), /timed out after 1s/);
});

test('http_request: helper functions (private IP detection, host patterns, JSON paths)', () => {
  const { isPrivateIp, hostMatches, getPath } = require('../extras/plugins/http-request/plugin.js').__test;
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateIp(ip), false, ip);
  assert.equal(hostMatches('api.github.com', ['*.github.com']), true);
  assert.equal(hostMatches('github.com', ['*.github.com']), true);
  assert.equal(hostMatches('evilgithub.com', ['*.github.com']), false);
  assert.deepEqual(getPath({ a: [{ b: 1 }, { b: 2 }] }, 'a[*].b'), [1, 2]);
  assert.equal(getPath({ a: [{ b: 1 }, { b: 2 }] }, 'a[1].b'), 2);
});

test('http_request: server shut down', async () => { await new Promise((r) => server.close(r)); plugins.reset(); });

/* ---------- text_search plugin ---------- */

test('text_search: pure Node.js regex/string file search works without external binaries', async () => {
  plugins.reset(); hooks.reset();
  const dir = path.join(ctx.studioDir, 'plugins');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'text-search'), { recursive: true });
  fs.copyFileSync(path.join(EXTRAS, 'plugins', 'text-search', 'plugin.js'), path.join(dir, 'text-search', 'plugin.js'));

  const status = await plugins.load(ctx.cfg.loadConfig());
  assert.equal(status.errors.length, 0, JSON.stringify(status.errors));
  assert.equal(plugins.isTool('text_search'), true);

  fs.writeFileSync(path.join(ctx.dir, 'a.ts'), 'function fetchUser(id: number) { return id; }\nconst x = fetchUser(1);\nconst y = fetchUser(2);\n');
  const r = await plugins.callTool('text_search', { query: 'fetchUser' }, {});
  assert.match(r.output, /a\.ts:1:/);
  assert.match(r.output, /a\.ts:2:/);
  assert.equal(r.matches, 3);

  const reg = await plugins.callTool('text_search', { query: 'fetchUser\\(\\d+\\)', regex: true }, {});
  assert.equal(reg.matches, 2);

  await assert.rejects(() => plugins.callTool('text_search', { query: 'x', path: '../outside' }, {}), /inside the working directory/);
});

test('text_search: config controls ignored folders and the file size cap', async () => {
  plugins.reset(); hooks.reset();
  const dir = path.join(ctx.studioDir, 'plugins');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'text-search'), { recursive: true });
  fs.copyFileSync(path.join(EXTRAS, 'plugins', 'text-search', 'plugin.js'), path.join(dir, 'text-search', 'plugin.js'));

  const status = await plugins.load({ ...ctx.cfg.loadConfig(), textSearch: { maxBytes: 10, ignoreFolders: ['skipme'] } });
  assert.equal(status.errors.length, 0, JSON.stringify(status.errors));
  assert.equal(plugins.isTool('text_search'), true);

  fs.mkdirSync(path.join(ctx.dir, 'skipme'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, 'skipme', 'needle.txt'), 'needle');
  fs.writeFileSync(path.join(ctx.dir, 'small.txt'), 'needle');
  fs.writeFileSync(path.join(ctx.dir, 'big.txt'), 'needle'.repeat(10));

  const r = await plugins.callTool('text_search', { query: 'needle' }, {});
  assert.match(r.output, /small\.txt:1:/);
  assert.doesNotMatch(r.output, /skipme|big\.txt/);
});

/* ---------- opt-in extras agents and commands ---------- */

const extraAgentNames = () => fs.readdirSync(path.join(EXTRAS, 'agents')).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3));

test('extras/agents: valid frontmatter and opt-in loading through agents.paths', () => {
  const names = extraAgentNames();
  assert.deepEqual(names.sort(), ['release-manager', 'support-triage']);
  for (const n of names) {
    const text = fs.readFileSync(path.join(EXTRAS, 'agents', `${n}.md`), 'utf8');
    const { meta, body } = agents.parseFrontmatter(text);
    assert.ok(String(meta.description).length > 30, `${n}: description`);
    assert.equal(meta.mode, 'all');
    assert.equal(meta.auto, false);
    assert.match(body, /\n## Rules/);
  }

  const base = ctx.cfg.loadConfig();
  for (const n of names) assert.equal(agents.loadAgents(base)[n], undefined, `${n} must be opt-in`);
  const on = agents.loadAgents({ ...base, agents: { paths: [path.join(EXTRAS, 'agents')] } });
  for (const n of names) {
    assert.ok(on[n], `${n} should load when enabled`);
    assert.equal(on[n].source, 'config');
  }
});

test('release-manager writes release docs but asks before version or git mutations; support-triage is read-only', () => {
  const base = ctx.cfg.loadConfig();
  const cfg = { ...base, agents: { paths: [path.join(EXTRAS, 'agents')] } };
  const release = agents.getAgent('release-manager', cfg);
  assert.equal(decide(release, 'edit', 'CHANGELOG.md'), 'allow');
  assert.equal(decide(release, 'edit', 'docs/releases/v1.md'), 'allow');
  assert.equal(decide(release, 'edit', 'package.json'), 'ask');
  assert.equal(decide(release, 'bash', 'git tag --list'), 'allow');
  assert.equal(decide(release, 'bash', 'git tag v1.2.3'), 'ask');

  const triage = agents.getAgent('support-triage', cfg);
  assert.equal(decide(triage, 'edit', 'src/app.js'), 'deny');
  assert.equal(decide(triage, 'bash', 'git diff'), 'allow');
  assert.equal(decide(triage, 'bash', 'npm install left-pad'), 'deny');
});

test('extras/commands: /verify and the /review override are opt-in through commands.paths', async () => {
  const base = ctx.cfg.loadConfig();
  assert.equal(commands.loadCommands(base).verify, undefined, '/verify must be opt-in');
  assert.equal(commands.loadCommands(base).review.builtin, true, 'the built-in /review stays by default');

  const cfg = { ...base, commands: { paths: [path.join(EXTRAS, 'commands')] } };
  const all = commands.loadCommands(cfg);
  assert.ok(all.verify);
  assert.equal(all.review.builtin, false);
  assert.match(all.review.description, /Deep opt-in review/);

  const r = await commands.expand('/verify focus on tests', cfg);
  assert.equal(r.command.name, 'verify');
  assert.match(r.text, /focus on tests/);
  assert.ok(!r.text.includes('$ARGUMENTS'));
});
