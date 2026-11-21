'use strict';
// Self-correction loop: every edit is checked at once, a failing check is handed back to the model with repair
// instructions, and a full-suite regression check runs before the turn ends (lib/verify.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setup } = require('./helpers');

// The tests below run `node --test` as the project's own test command. Inside the outer runner that child would inherit
// NODE_TEST_CONTEXT and report exit code 0 even for failing tests, so hide it from the children. It is removed in a
// `before` hook (not at load time) so the runner has already picked its reporting mode and still lists every subtest.
test.before(() => { delete process.env.NODE_TEST_CONTEXT; });

const env = setup();
const ROOT = path.join(__dirname, '..');
const tools = require('../lib/tools');
const verify = require('../lib/verify');

const write = (rel, text) => { const f = path.join(env.dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const mkCtx = (verifyCfg) => ({
  agent: { name: 'build' },
  config: { ...env.cfg.loadConfig(), ...(verifyCfg === undefined ? {} : { verify: verifyCfg }) },
  session: { id: 's' + Math.random(), messages: [{ role: 'user', content: 'x', turn: 1 }], journal: [], turn: 1 },
  root: { journal: [], turn: 1 },
  inherited: [], emit: () => {}, askPermission: async () => 'once', askUser: async () => '',
});

/* ---------- 1) immediate check after every edit ---------- */

test('a syntax error is reported right away with repair instructions; the fix turns it green', async () => {
  const ctx = mkCtx();
  const bad = await tools.executeTool('write_file', { path: 'broken.js', content: 'function (' }, ctx);
  assert.equal(bad.verify.status, 'fail');
  assert.match(bad.verify.output, /SyntaxError/);
  assert.match(bad.note, /VERIFY FAILED/);
  assert.match(bad.note, /syntax error.*logic error/s);
  const good = await tools.executeTool('write_file', { path: 'broken.js', content: 'module.exports = 1;\n' }, ctx);
  assert.equal(good.verify.status, 'pass');
  assert.ok(!good.note, 'no repair note once the check passes');
});

test('the test file that belongs to the edited file runs immediately (node:test project)', async () => {
  write('package.json', JSON.stringify({ name: 'p', scripts: { test: 'node --test "test/**/*.test.js"' } }));
  write('test/calc.test.js', "const t = require('node:test'); const a = require('node:assert/strict'); const { add } = require('../lib/calc');\nt('add', () => a.equal(add(2, 3), 5));\n");
  const ctx = mkCtx();
  const bad = await tools.executeTool('write_file', { path: 'lib/calc.js', content: 'exports.add = (a, b) => a - b;\n' }, ctx);
  assert.equal(bad.verify.status, 'fail');
  assert.ok(bad.verify.checks.some((c) => /test: node --test/.test(c)), 'the related test ran');
  assert.match(bad.verify.output, /-1|5/, 'the assertion output reaches the model');
  const fixed = await tools.executeTool('edit_file', { path: 'lib/calc.js', old_string: 'a - b', new_string: 'a + b' }, ctx);
  assert.equal(fixed.verify.status, 'pass');
  assert.equal(fixed.verify.checks.length, 2, 'syntax + test');
});

test('multi_edit and json_edit are verified too; invalid JSON is caught', async () => {
  const ctx = mkCtx();
  write('lib/m.js', 'const a = 1;\nconst b = 2;\n');
  const r = await tools.executeTool('multi_edit', { path: 'lib/m.js', edits: [{ old_string: 'const a = 1;', new_string: 'const a = (1;' }] }, ctx);
  assert.equal(r.verify.status, 'fail');
  const bad = await tools.executeTool('write_file', { path: 'data.json', content: '{ "a": 1,, }' }, ctx);
  assert.equal(bad.verify.status, 'fail');
  write('cfg.json', '{"a":1}');
  const j = await tools.executeTool('json_edit', { path: 'cfg.json', op: 'set', key: 'a', value: 2 }, ctx);
  assert.equal(j.verify.status, 'pass');
});

test('files without a reliable checker are skipped (not guessed); tsconfig-style JSON with comments is left alone', async () => {
  const ctx = mkCtx();
  assert.equal((await tools.executeTool('write_file', { path: 'notes.md', content: '# hi' }, ctx)).verify.status, 'skipped');
  assert.equal((await tools.executeTool('write_file', { path: 'tsconfig.json', content: '{ // comment\n "a": 1 }' }, ctx)).verify.status, 'skipped');
});

test('verify can be switched off completely', async () => {
  const ctx = mkCtx(false);
  const r = await tools.executeTool('write_file', { path: 'off.js', content: 'function (' }, ctx);
  assert.equal(r.verify, undefined);
  assert.equal(verify.stateOf(ctx.root).dirty, false);
});

test('after maxFixRounds failures on one file the model is told to stop guessing', async () => {
  const ctx = mkCtx({ maxFixRounds: 2 });
  const a = await tools.executeTool('write_file', { path: 'loop.js', content: 'x = (' }, ctx);
  assert.doesNotMatch(a.note, /STOP guessing/);
  const b = await tools.executeTool('write_file', { path: 'loop.js', content: 'x = ((' }, ctx);
  assert.equal(b.verify.attempt, 2);
  assert.match(b.note, /STOP guessing/);
});

test('a custom editCommand replaces the built-in checks ({file} placeholder)', async () => {
  const ctx = mkCtx({ editCommand: 'node -e "process.exit(process.argv[1].includes(\'bad\') ? 1 : 0)" {file}' });
  const bad = await tools.executeTool('write_file', { path: 'bad.txt', content: 'x' }, ctx);
  assert.equal(bad.verify.status, 'fail');
  const ok = await tools.executeTool('write_file', { path: 'fine.txt', content: 'x' }, ctx);
  assert.equal(ok.verify.status, 'pass');
});

/* ---------- command discovery ---------- */

test('detectTestCommand: real scripts only, never the npm placeholder, config wins', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'detect-'));
  const cfg = {};
  const at = (rel, text) => fs.writeFileSync(path.join(dir, rel), text);
  assert.equal(verify.detectTestCommand(cfg, dir), null);
  at('package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.equal(verify.detectTestCommand(cfg, dir), null, 'the npm init placeholder is not a test suite');
  at('package.json', JSON.stringify({ scripts: { test: 'jest' } }));
  assert.equal(verify.detectTestCommand(cfg, dir).command, 'npm test');
  at('yarn.lock', '');
  assert.equal(verify.detectTestCommand(cfg, dir).command, 'yarn test');
  assert.equal(verify.detectTestCommand({ verify: { command: 'make check' } }, dir).command, 'make check');
  fs.rmSync(path.join(dir, 'package.json'));
  at('go.mod', 'module x');
  assert.equal(verify.detectTestCommand(cfg, dir).command, 'go test ./...');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- final regression check ---------- */

const collect = () => { const events = []; return { events, emit: (e) => events.push(e) }; };
const fresh = (patch) => ({ session: { id: 'f', turn: 1, messages: [] }, config: { verify: { command: 'node -e "process.exit(0)"', ...patch } }, signal: undefined });

test('finalCheck does nothing when no file changed this turn', async () => {
  const { events, emit } = collect();
  const a = fresh();
  assert.equal(await verify.finalCheck({ ...a, emit }), null);
  assert.equal(events.length, 0, 'the suite is not run for a read-only turn');
});

test('finalCheck: green suite clears the dirty flag; red suite goes back to the model, bounded by maxFinalRounds', async () => {
  const { events, emit } = collect();
  const green = fresh();
  verify.markDirty({ config: green.config, session: green.session }, 'a.js');
  assert.equal(await verify.finalCheck({ ...green, emit }), null);
  assert.ok(events.some((e) => e.type === 'info' && /final verification passed/.test(e.text)));
  assert.equal(verify.stateOf(green.session).dirty, false);

  const red = fresh({ command: 'node -e "console.error(\'AssertionError: expected 8\'); process.exit(1)"', maxFinalRounds: 2 });
  verify.markDirty({ config: red.config, session: red.session }, 'lib/math.js');
  const r1 = await verify.finalCheck({ ...red, emit });
  assert.equal(r1.retry, true);
  assert.match(r1.message, /final verification/);
  assert.match(r1.message, /AssertionError: expected 8/);
  assert.match(r1.message, /lib\/math\.js/);
  assert.match(r1.message, /regression/i);
  assert.equal((await verify.finalCheck({ ...red, emit })).retry, true);
  const give = await verify.finalCheck({ ...red, emit });
  assert.equal(give, null, 'after the budget is used up the turn ends instead of looping forever');
  assert.ok(events.some((e) => e.type === 'warning' && /still fail/.test(e.message)));
});

test('finalCheck: a project without a test command is skipped, never guessed', async () => {
  const { events, emit } = collect();
  const a = { session: { id: 'n', turn: 1, messages: [] }, config: {}, signal: undefined };
  const empty = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'empty-'));
  const cfg = require('../lib/config');
  const prev = cfg.getWorkDir();
  cfg.setWorkDir(empty);
  try {
    verify.markDirty({ config: a.config, session: a.session }, 'x.txt');
    assert.equal(await verify.finalCheck({ ...a, emit }), null);
    assert.equal(events.length, 0);
  } finally { cfg.setWorkDir(prev); fs.rmSync(empty, { recursive: true, force: true }); }
});

/* ---------- end to end: the whole loop through the agent ---------- */

function fakeOllama(script) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      if (req.url === '/api/tags') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ models: [{ name: 'fake' }] })); }
      if (req.url === '/api/show') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ model_info: { 'llama.context_length': 16384 }, capabilities: [] })); }
      if (req.url !== '/api/chat') { res.writeHead(404); return res.end(); }
      requests.push(json);
      const reply = json.tools && json.tools.length ? script(json) : { content: 'Title' };
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { role: 'assistant', content: reply.content || '', ...(reply.tool_calls ? { tool_calls: reply.tool_calls } : {}) }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, eval_count: 5, prompt_eval_count: 50, eval_duration: 1e9 }) + '\n');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, requests, port: srv.address().port })));
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', '0', '--dir', env.dir], { env: { ...process.env, OLLAMA_STUDIO_HOME: env.home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('server did not start:\n' + out)); }, 20000);
    const onData = (d) => { out += d.toString(); const m = out.match(/url: http:\/\/[^:]+:(\d+)/); if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]) }); } };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early (${code}):\n${out}`)); });
  });
}

async function chat(base, text) {
  const res = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model: 'fake', agent: 'build' }) });
  assert.equal(res.status, 200);
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
      buf = buf.slice(i + 2);
      if (line) events.push(JSON.parse(line.slice(6)));
    }
  }
  return events;
}

test('end to end: a failing edit is repaired from the verify output, and a regression found by the final suite is repaired too', async (t) => {
  // project: lib/math.js has add + double; test/math.test.js covers add, test/double.test.js covers double (NOT the "related" test of math.js)
  write('package.json', JSON.stringify({ name: 'e2e', scripts: { test: 'node --test "test/**/*.test.js"' } }));
  write('lib/e2e-math.js', 'exports.add = (a, b) => a + b;\nexports.double = (x) => x * 2;\n');
  write('test/e2e-math.test.js', "const t = require('node:test'); const a = require('node:assert/strict'); const m = require('../lib/e2e-math');\nt('add', () => a.equal(m.add(2, 3), 5));\n");
  write('test/double.test.js', "const t = require('node:test'); const a = require('node:assert/strict'); const m = require('../lib/e2e-math');\nt('double', () => a.equal(m.double(4), 8));\n");

  const src = (add, dbl) => `exports.add = (a, b) => ${add};\nexports.double = (x) => ${dbl};\n`;
  const writeCall = (content) => ({ tool_calls: [{ function: { name: 'write_file', arguments: { path: 'lib/e2e-math.js', content } } }] });
  const fake = await fakeOllama((req) => {
    const results = req.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    const regressionNotice = req.messages.some((m) => m.role === 'user' && /final verification\]/.test(m.content || ''));
    if (results.length === 0) return { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'lib/e2e-math.js' } } }] };
    if (results.length === 1) return writeCall(src('a - b', 'x * 2'));                       // bug 1: caught at once by the related test
    if (results.length === 2) return writeCall(src('a + b', 'x * 3'));                       // fixes add, but breaks double (a regression elsewhere)
    if (!regressionNotice) return { content: 'Finished.' };                                  // claims done -> the final suite catches double
    if (results.length === 3) return writeCall(src('a + b', 'x * 2'));                       // repairs the regression
    return { content: 'Fixed and verified.' };
  });
  const { child, port } = await startServer();
  t.after(() => { child.kill('SIGKILL'); fake.srv.close(); });
  const base = `http://127.0.0.1:${port}`;
  await fetch(base + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: `http://127.0.0.1:${fake.port}`, model: 'fake', snapshots: false, recallAuto: false, nudgePrompt: false, permission: { edit: 'allow', bash: { '*': 'allow' } } }) });

  const ev = await chat(base, 'change the math module');
  const verdicts = ev.filter((e) => e.type === 'tool_result' && e.name === 'write_file').map((e) => e.result && e.result.verify && e.result.verify.status);
  assert.deepEqual(verdicts, ['fail', 'pass', 'pass'], 'edit 1 fails at once, edit 2 passes its own checks, edit 3 passes');

  const second = fake.requests.find((r) => r.messages.filter((m) => m.role === 'tool').length === 2);
  assert.match(second.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n'), /VERIFY FAILED/, 'the model sees the failure and the repair instructions in the very next request');

  assert.ok(ev.some((e) => e.type === 'info' && /final verification failed/.test(e.text)), 'the regression in double() is found by the full suite');
  assert.ok(fake.requests.some((r) => r.messages.some((m) => m.role === 'user' && /final verification\]/.test(m.content || '') && /double/.test(m.content))), 'the failing output is sent back to the model');
  assert.ok(ev.some((e) => e.type === 'info' && /final verification passed/.test(e.text)), 'the turn ends only after the suite is green');
  assert.ok(ev.some((e) => e.type === 'done'));
  assert.match(fs.readFileSync(path.join(env.dir, 'lib/e2e-math.js'), 'utf8'), /x \* 2/);
});
