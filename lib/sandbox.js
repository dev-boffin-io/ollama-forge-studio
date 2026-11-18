'use strict';

// Docker sandbox for agent shell commands. Disabled by default. When enabled, every bash/background command (and
// optionally the user terminal) runs inside a fresh container with the project mounted at /workspace.
//
//   "sandbox": {
//     "enabled": true,
//     "image": "node:20-bookworm",
//     "network": "none",
//     "memory": "1g",
//     "cpus": "1",
//     "mount": "rw",
//     "env": { "CI": "1" }
//   }
//
// The container is removed on exit (--rm). If sandbox is enabled but Docker/the daemon is unavailable, commands fail
// closed instead of silently running on the host. Use "network": "bridge" when the agent must install packages.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { getWorkDir, studioDir } = require('./config');

const DEFAULTS = {
  enabled: false,
  image: 'node:20-bookworm',
  network: 'none',
  memory: '1g',
  cpus: '1',
  pidsLimit: 512,
  mount: 'rw',
  mountStudio: true,
  env: {},
  user: '',
  init: true,
  noNewPrivileges: true,
  readOnlyRootfs: false,
  extraArgs: [],
  docker: 'docker',
};

let cache = { key: '', at: 0, ok: false, error: '' };

function settings(config) {
  const raw = config && config.sandbox;
  if (raw === true) return { ...DEFAULTS, enabled: true };
  if (raw === false || raw == null) return { ...DEFAULTS, enabled: false };
  if (typeof raw !== 'object') return { ...DEFAULTS, enabled: false };
  return { ...DEFAULTS, ...raw, env: { ...DEFAULTS.env, ...(raw.env || {}) } };
}

function enabled(config) { return settings(config).enabled === true; }

function check(config, opts = {}) {
  const s = settings(config);
  if (!s.enabled) return { ok: false, error: 'sandbox is disabled' };
  const docker = String(s.docker || 'docker');
  const key = docker + '\n' + (process.env.PATH || '');
  const now = Date.now();
  if (!opts.refresh && cache.key === key && now - cache.at < 10000) return { ok: cache.ok, error: cache.error };
  try {
    execFileSync(docker, ['version', '--format', '{{.Server.Version}}'], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    cache = { key, at: now, ok: true, error: '' };
    return { ok: true, error: '' };
  } catch (e) {
    const detail = String((e.stderr && e.stderr.toString()) || e.message || e).trim().slice(-800);
    cache = { key, at: now, ok: false, error: detail || 'docker is not available' };
    return { ok: false, error: cache.error };
  }
}

function status(config) {
  const s = settings(config);
  if (!s.enabled) return { enabled: false, available: false, image: s.image, network: s.network, error: '' };
  const c = check(config);
  return { enabled: true, available: c.ok, image: s.image, network: s.network, error: c.error };
}

function containerName(workDir) {
  const base = path.basename(workDir).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').slice(0, 32) || 'project';
  const rand = crypto.randomBytes(4).toString('hex');
  return `ofs-${base}-${Date.now().toString(36)}-${rand}`.slice(0, 63);
}

/**
 * Build the docker command without touching the daemon. Useful for tests and diagnostics.
 * Returns null when sandboxing is disabled.
 */
function commandSpec(command, config, opts = {}) {
  const s = settings(config);
  if (!s.enabled) return null;
  const work = opts.workDir || getWorkDir();
  const studio = opts.studioDir || studioDir();
  const container = opts.container || containerName(work);
  const image = String(opts.image || s.image || DEFAULTS.image);
  const args = ['run', '--rm', '-i', '--name', container];
  args.push('--network', String(s.network || 'none'));
  args.push('--memory', String(s.memory || DEFAULTS.memory));
  args.push('--cpus', String(s.cpus || DEFAULTS.cpus));
  if (Number(s.pidsLimit) > 0) args.push('--pids-limit', String(s.pidsLimit));
  if (s.init !== false) args.push('--init');
  if (s.noNewPrivileges !== false) args.push('--security-opt', 'no-new-privileges');
  if (s.readOnlyRootfs) args.push('--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m');
  const mountMode = s.mount === 'ro' ? 'ro' : 'rw';
  args.push('-v', `${work}:/workspace:${mountMode}`);
  if (s.mountStudio !== false && path.resolve(studio) !== path.resolve(work)) {
    try { fs.mkdirSync(studio, { recursive: true }); } catch { /* read-only home */ }
    args.push('-v', `${studio}:/workspace/.studio:rw`);
  }
  args.push('-w', '/workspace');
  const env = {
    HOME: '/workspace',
    TMPDIR: '/tmp',
    OLLAMA_STUDIO_SANDBOX: '1',
    ...(s.env && typeof s.env === 'object' ? s.env : {}),
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || v === null || v === false) continue;
    args.push('-e', `${k}=${String(v)}`);
  }
  if (s.user) args.push('--user', String(s.user));
  for (const extra of Array.isArray(s.extraArgs) ? s.extraArgs : []) args.push(String(extra));
  args.push(image, 'sh', '-lc', String(command));
  return { cmd: String(s.docker || 'docker'), args, cwd: work, container, image };
}

/** Build a spec and verify the daemon first. Throws (fail closed) when sandboxing is enabled but unavailable. */
function spawnSpec(command, config, opts = {}) {
  if (!enabled(config)) return null;
  const c = check(config);
  if (!c.ok) throw new Error(`sandbox is enabled but Docker is unavailable: ${c.error}`);
  return commandSpec(command, config, opts);
}

function cleanup(container, config) {
  if (!container) return;
  const s = settings(config);
  try {
    const child = spawn(String(s.docker || 'docker'), ['rm', '-f', container], { stdio: 'ignore', detached: true });
    child.on('error', () => { /* container may already be gone */ });
    child.unref();
  } catch { /* ignore cleanup errors */ }
}

function reset() { cache = { key: '', at: 0, ok: false, error: '' }; }

module.exports = {
  DEFAULTS, settings, enabled, check, status,
  commandSpec, spawnSpec, cleanup, reset,
};
