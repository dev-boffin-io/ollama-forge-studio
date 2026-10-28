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
