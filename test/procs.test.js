'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setup } = require('./helpers');

setup();
const procs = require('../lib/procs');

const nextExit = (id) => new Promise((resolve) => {
  const on = (info) => { if (info.id === id) { procs.events.off('exit', on); resolve(info); } };
  procs.events.on('exit', on);
});

test('background process: exit event carries session, exit code, output tail and log file', async () => {
  const r = await procs.startBackground("sleep 3; echo 'line one'; echo 'line two'; exit 3", { sessionId: 'ses_test' });
  assert.equal(r.running, true);
  assert.equal(r.session_id, 'ses_test');
  const info = await nextExit(r.id);
  assert.equal(info.sessionId, 'ses_test');
  assert.equal(info.exitCode, 3);
  assert.equal(info.killed, false);
  assert.match(info.tail, /line one\nline two$/);
  assert.ok(info.durationMs >= 2500);
  assert.ok(fs.existsSync(info.logFile));
  const log = fs.readFileSync(info.logFile, 'utf8');
  assert.match(log, /line two/);
  assert.match(log, /\[exit 3\]/);
  assert.equal(procs.isSeen(r.id), false);          // nobody told the model yet -> the studio will wake it
});

test('a process that already ended inside the tool call counts as reported (no wake-up)', async () => {
  const r = await procs.startBackground('echo quick', { sessionId: 'ses_test' });
  assert.equal(r.running, false);
  assert.equal(procs.isSeen(r.id), true);
});

test('reading the final state through the process tool marks it as seen', async () => {
  const r = await procs.startBackground('sleep 3', { sessionId: 'ses_test' });
  const done = nextExit(r.id);
  await done;
  assert.equal(procs.isSeen(r.id), false);
  assert.equal(procs.list().find((p) => p.id === r.id).running, false);
  assert.equal(procs.isSeen(r.id), false);          // the UI's list() must NOT count as "the model saw it"
  procs.output(r.id);
  assert.equal(procs.isSeen(r.id), true);
});

test('kill() marks the process as killed (so it never wakes the agent) and the event says so', async () => {
  const r = await procs.startBackground('sleep 30', { sessionId: 'ses_test' });
  const done = nextExit(r.id);
  procs.kill(r.id);
  const info = await done;
  assert.equal(info.killed, true);
  assert.equal(procs.list().find((p) => p.id === r.id).killed, true);
});

test('progress is parsed from Gradle / percent / [n/m] output without any model', async () => {
  const r = await procs.startBackground("echo '> Task :app:compileDebugKotlin'; echo 'downloading 45% done'; sleep 3", { sessionId: 'ses_p' });
  await new Promise((res) => setTimeout(res, 300));
  let p = procs.list().find((x) => x.id === r.id);
  assert.equal(p.progress.task, ':app:compileDebugKotlin');
  assert.equal(p.progress.percent, 45);
  assert.equal(p.last_line, 'downloading 45% done');
  procs.kill(r.id);
  const r2 = await procs.startBackground("echo '[3/12] CC foo.o'; sleep 3", { sessionId: 'ses_p' });
  await new Promise((res) => setTimeout(res, 300));
  p = procs.list().find((x) => x.id === r2.id);
  assert.equal(p.progress.percent, 25);
  procs.kill(r2.id);
});

test('carriage-return progress bars and ANSI colours are handled', async () => {
  const r = await procs.startBackground("printf '\\033[32m> Task :x\\033[0m\\n10%%\\r50%%\\r75%%\\n'; sleep 3", { sessionId: 'ses_p' });
  await new Promise((res) => setTimeout(res, 300));
  const p = procs.list().find((x) => x.id === r.id);
  assert.equal(p.progress.task, ':x');
  assert.equal(p.progress.percent, 75);
  procs.kill(r.id);
});

/* ---------- interactive stdin (bash interactive=true + process action=input) ---------- */

test('interactive background process: input reaches stdin and the new output comes back', async () => {
  const r = await procs.startBackground('read -r who; echo "hello $who"; read -r again; echo "second $again"', { sessionId: 'ses_in', interactive: true });
  assert.equal(r.running, true);
  assert.equal(r.stdin_open, true);
  const a = await procs.sendInput(r.id, 'world');
  assert.match(a.new_output, /hello world/);
  const done = nextExit(r.id);
  const b = await procs.sendInput(r.id, 'again');
  assert.match(b.new_output, /second again/);
  await done;
});

test('sendInput: close_stdin sends EOF (cat finishes), newline=false sends raw text', async () => {
  const r = await procs.startBackground('cat', { sessionId: 'ses_in', interactive: true });
  const done = nextExit(r.id);
  const out = await procs.sendInput(r.id, 'abc', { newline: false, closeStdin: true });
  const info = await done;
  assert.equal(info.exitCode, 0);
  assert.match(out.new_output + info.tail, /abc/);
});

test('sendInput refuses processes without open stdin, finished ones and oversized input', async () => {
  const plain = await procs.startBackground('sleep 3', { sessionId: 'ses_in' });
  assert.equal(plain.stdin_open, undefined);
  await assert.rejects(() => procs.sendInput(plain.id, 'x'), /no open stdin/);
  procs.kill(plain.id);

  const quick = await procs.startBackground('echo done', { sessionId: 'ses_in', interactive: true });
  await new Promise((r) => setTimeout(r, 400));
  await assert.rejects(() => procs.sendInput(quick.id, 'x'), /already exited/);

  const live = await procs.startBackground('cat', { sessionId: 'ses_in', interactive: true });
  await assert.rejects(() => procs.sendInput(live.id, 'x'.repeat(10001)), /too long/);
  procs.kill(live.id);
  await assert.rejects(() => procs.sendInput('proc_nope', 'x'), /no such process/);
});

test('process tool: action=input goes through the bash permission rules', async () => {
  const tools = require('../lib/tools');
  const agents = require('../lib/agents');
  const config = require('../lib/config').loadConfig();
  const mk = (agentName, reply) => ({ agent: agents.getAgent(agentName), config, session: { id: 'ses_perm', messages: [], journal: [], turn: 1 }, root: { id: 'ses_perm' }, inherited: [], emit: () => {}, askPermission: async () => reply });
  const r = await procs.startBackground('read -r x; echo "got $x"', { sessionId: 'ses_perm', interactive: true });

  // explore may not run bash, so it may not type into a process either
  await assert.rejects(() => tools.executeTool('process', { action: 'input', id: r.id, text: 'nope' }, mk('explore', 'once')), /not allowed/);
  // a rejected prompt sends nothing
  await assert.rejects(() => tools.executeTool('process', { action: 'input', id: r.id, text: 'nope' }, { ...mk('build', 'reject'), agent: { name: 'asky', permission: { bash: { '*': 'ask' } } } }), /rejected/);
  // approved: delivered
  const ok = await tools.executeTool('process', { action: 'input', id: r.id, text: 'yes' }, mk('build', 'once'));
  assert.match(ok.new_output, /got yes/);
});

test('bash tool schema documents interactive, process tool documents input', () => {
  const { TOOLS } = require('../lib/tools');
  assert.ok(TOOLS.bash.function.parameters.properties.interactive);
  assert.ok(TOOLS.process.function.parameters.properties.action.enum.includes('input'));
});
