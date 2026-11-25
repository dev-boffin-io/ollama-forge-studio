'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

const ctx = setup();
const sandbox = require('../lib/sandbox');
const procs = require('../lib/procs');

const enabled = {
  sandbox: {
    enabled: true,
    image: 'node:20-bookworm',
    network: 'bridge',
    memory: '256m',
    cpus: '0.5',
    env: { FOO: 'bar' },
  },
};

test('sandbox is disabled by default and commandSpec returns null', () => {
  assert.equal(sandbox.enabled({}), false);
  assert.equal(sandbox.commandSpec('echo hi', {}), null);
  assert.deepEqual(sandbox.status({}), { enabled: false, available: false, image: 'node:20-bookworm', network: 'none', error: '' });
});

test('commandSpec builds a hardened docker run command (project mount; studio folder only on request, read-only)', () => {
  const spec = sandbox.commandSpec('echo hi', enabled, { workDir: ctx.dir, studioDir: ctx.studioDir, container: 'ofs-test' });
  assert.equal(spec.cmd, 'docker');
  assert.equal(spec.container, 'ofs-test');
  assert.equal(spec.cwd, ctx.dir);
  for (const part of ['run', '--rm', '-i', '--name', 'ofs-test', '--network', 'bridge', '--memory', '256m', '--cpus', '0.5', '--init', '--security-opt', 'no-new-privileges']) {
    assert.ok(spec.args.includes(part), `expected ${part} in ${spec.args.join(' ')}`);
  }
  assert.ok(spec.args.includes(`${ctx.dir}:/workspace:rw`));
  assert.ok(!spec.args.some((a) => a.includes('/workspace/.studio')), 'the studio data folder (config.json = hooks/MCP/permissions) is NOT mounted by default');
  assert.ok(spec.args.includes('--cap-drop') && spec.args.includes('ALL'), 'all capabilities are dropped by default');
  const opt = sandbox.commandSpec('echo hi', { sandbox: { ...enabled.sandbox, mountStudio: true } }, { workDir: ctx.dir, studioDir: ctx.studioDir, container: 'ofs-test' });
  assert.ok(opt.args.includes(`${ctx.studioDir}:/workspace/.studio:ro`), 'opt-in studio mount is read-only');
  assert.ok(spec.args.includes('-w'));
  assert.ok(spec.args.includes('/workspace'));
  assert.ok(spec.args.includes('FOO=bar'));
  assert.ok(spec.args.includes('HOME=/workspace'));
  assert.equal(spec.args[spec.args.length - 4], 'node:20-bookworm');
  assert.deepEqual(spec.args.slice(-3), ['sh', '-lc', 'echo hi']);
});

test('read-only mounts and extra args are supported', () => {
  const spec = sandbox.commandSpec('ls', { sandbox: { enabled: true, mount: 'ro', extraArgs: ['--cap-drop', 'ALL'], pidsLimit: 0 } }, { workDir: ctx.dir, studioDir: ctx.studioDir, container: 'ofs-ro' });
  assert.ok(spec.args.includes(`${ctx.dir}:/workspace:ro`));
  assert.ok(spec.args.includes('--cap-drop'));
  assert.ok(spec.args.includes('ALL'));
  assert.ok(!spec.args.includes('--pids-limit'));
});

test('spawnSpec fails closed when the docker binary or daemon is unavailable', () => {
  sandbox.reset();
  assert.throws(
    () => sandbox.spawnSpec('echo hi', { sandbox: { enabled: true, docker: 'ofs-no-such-docker-binary' } }),
    /Docker is unavailable/,
  );
  const status = sandbox.status({ sandbox: { enabled: true, docker: 'ofs-no-such-docker-binary' } });
  assert.equal(status.enabled, true);
  assert.equal(status.available, false);
  assert.ok(status.error);
  sandbox.reset();
});

test('a foreground command never falls back to the host when sandboxing is broken', async () => {
  sandbox.reset();
  const r = await procs.runForeground('echo host-leak', 1000, null, { sandbox: { enabled: true, docker: 'ofs-no-such-docker-binary' } });
  assert.equal(r.exit_code, -1);
  assert.match(r.output, /sandbox error/);
  assert.doesNotMatch(r.output, /host-leak/);
  sandbox.reset();
});
