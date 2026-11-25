'use strict';

// git plugin: four read-only git tools exposed to the model as git_status, git_diff, git_log and git_show.
//
// Why tools and not `bash git ...`: each call is a fixed, validated argv (no shell, no injection), output is capped and
// compact, and the permission engine can allow these four without opening up commit / push / reset.
//
// Safety:
//   * no shell: execFile('git', argv) only. Refs and paths that start with "-" are rejected, paths go after "--".
//   * paths must stay inside the working directory (no absolute paths, no "..").
//   * refuses to run when the repo's own git config looks dangerous (same gitsafe check the bash permission path uses).
//   * diff / show use --no-ext-diff --no-textconv, so no external program from the repo config is started.
//
// Permissions: plugin tools ask by default. To allow these read-only tools without a prompt add to config.json:
//   "permission": { "plugin": { "git_status": "allow", "git_diff": "allow", "git_log": "allow", "git_show": "allow" } }

const path = require('node:path');
const { execFile } = require('node:child_process');

const MAX_OUTPUT = 40000;     // characters returned to the model
const TIMEOUT_MS = 30000;
const REF_RE = /^[A-Za-z0-9._\/~^@{}-]{1,200}$/;

// The project folder the studio is working on. The host passes it to setup(api) as api.workDir, and the UI calls
// plugins.reload() whenever the project changes, so setup runs again and this value stays current.
// (The launch folder, process.cwd(), is NOT the project when the studio is started from another directory.)
let projectDir = null;

function workDirOf(ctx) {
  return projectDir || (ctx && ctx.workDir) || process.cwd();
}

// Same repo-config check the bash permission path uses (lib/gitsafe.js). Bundled plugins only; otherwise skipped.
function isRisky(dir) {
  try { return require(require('node:path').resolve(__dirname, '../../../lib/gitsafe')).risky(dir); } catch { return false; }
}

function checkPath(p) {
  if (p === undefined || p === null || p === '') return null;
  const s = String(p).trim();
  if (s.startsWith('-')) throw new Error('path must not start with "-"');
  if (path.isAbsolute(s) || s.split(/[\\/]/).includes('..')) throw new Error('path must be relative to the working directory and must not contain ".."');
  return s;
}

function checkRef(r) {
  const s = String(r || '').trim();
  if (!s) return null;
  if (s.startsWith('-') || !REF_RE.test(s)) throw new Error(`invalid ref: ${s}`);
  if (s.includes(':')) throw new Error('ref must not contain ":" (use git_show with a plain ref)');
  return s;
}

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function runGit(argv, workDir, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', argv, {
      cwd: workDir,
      maxBuffer: 8 * 1024 * 1024,
      timeout: TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(new Error('git is not installed or not on PATH'));
      let out = String(stdout || '');
      const errText = String(stderr || '').trim();
      if (err && !out && errText) return reject(new Error(`${errText.split('\n').slice(0, 5).join('\n')}\n(working directory: ${workDir})`));
      let truncated = false;
      if (out.length > MAX_OUTPUT) { out = out.slice(0, MAX_OUTPUT); truncated = true; }
      const body = out.trimEnd() || (errText ? errText : '(no output)');
      resolve({ output: truncated ? `${body}\n… output truncated at ${MAX_OUTPUT} characters; narrow the path or the range` : body, exit_code: err ? (err.code || 1) : 0 });
    });
    if (signal) {
      if (signal.aborted) child.kill();
      else signal.addEventListener('abort', () => child.kill(), { once: true });
    }
  });
}

function guard(ctx) {
  const dir = workDirOf(ctx);
  if (isRisky(dir)) throw new Error('refused: this repository\'s git config runs external programs (core.fsmonitor, diff.external, textconv, filters ...). Review .git/config first.');
  return dir;
}

module.exports = {
  name: 'git',
  version: '1.0.0',
  description: 'Read-only git tools: status, diff, log and show. No commit, push, reset or checkout.',
  setup(api) {
    projectDir = (api && typeof api.workDir === 'string' && api.workDir) || null;
    api.registerTool({
      name: 'status',
      description: 'Show the working-tree status (git status). Use it first to see which files changed, were staged, or are untracked.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional path (file or folder) relative to the working directory.' },
          short: { type: 'boolean', description: 'Compact one-line-per-file output (default true).' },
        },
        additionalProperties: false,
      },
      handler: async (args = {}, ctx = {}) => {
        const dir = guard(ctx);
        const p = checkPath(args.path);
        const argv = ['status', '--branch'];
        if (args.short !== false) argv.push('--short');
        if (p) argv.push('--', p);
        return runGit(argv, dir, ctx.signal);
      },
    });

    api.registerTool({
      name: 'diff',
      description: 'Show changes (git diff). Default: unstaged changes. Use staged=true for the index, or base=<ref> to compare against a commit/branch (e.g. base "main").',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional path relative to the working directory.' },
          staged: { type: 'boolean', description: 'Show staged changes (git diff --cached).' },
          base: { type: 'string', description: 'Compare the working tree with this ref, e.g. "HEAD~1", "main", or a commit hash.' },
          stat: { type: 'boolean', description: 'Only the per-file summary (--stat), useful for large diffs.' },
          context: { type: 'number', description: 'Lines of context around each change (0-10, default 3).' },
        },
        additionalProperties: false,
      },
      handler: async (args = {}, ctx = {}) => {
        const dir = guard(ctx);
        const p = checkPath(args.path);
        const base = checkRef(args.base);
        const argv = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', `-U${clampInt(args.context, 3, 0, 10)}`];
        if (args.staged === true) argv.push('--cached');
        if (args.stat === true) argv.push('--stat');
        if (base) argv.push(base);
        if (p) argv.push('--', p);
        return runGit(argv, dir, ctx.signal);
      },
    });

    api.registerTool({
      name: 'log',
      description: 'Show recent commits (git log). Compact one-line form by default.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of commits, 1-50 (default 10).' },
          path: { type: 'string', description: 'Only commits that touched this path.' },
          ref: { type: 'string', description: 'Branch, tag or commit to start from (default HEAD).' },
          oneline: { type: 'boolean', description: 'One line per commit (default true).' },
        },
        additionalProperties: false,
      },
      handler: async (args = {}, ctx = {}) => {
        const dir = guard(ctx);
        const p = checkPath(args.path);
        const ref = checkRef(args.ref);
        const argv = ['log', `-n${clampInt(args.limit, 10, 1, 50)}`, '--no-color'];
        argv.push(args.oneline === false ? '--format=medium' : '--oneline', '--decorate');
        if (ref) argv.push(ref);
        if (p) argv.push('--', p);
        return runGit(argv, dir, ctx.signal);
      },
    });

    api.registerTool({
      name: 'show',
      description: 'Show one commit: message and diff (git show). Use stat=true for only the file summary. For a single file at a revision, pass path.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Commit, branch or tag (default HEAD).' },
          stat: { type: 'boolean', description: 'Only the file summary (--stat).' },
          path: { type: 'string', description: 'Only the changes to this path.' },
        },
        additionalProperties: false,
      },
      handler: async (args = {}, ctx = {}) => {
        const dir = guard(ctx);
        const ref = checkRef(args.ref) || 'HEAD';
        if (ref.includes('..')) throw new Error('git_show takes a single ref, not a range');
        const p = checkPath(args.path);
        const argv = ['show', '--no-ext-diff', '--no-textconv', '--no-color', '--format=medium', ref];
        if (args.stat === true) argv.push('--stat');
        if (p) argv.push('--', p);
        return runGit(argv, dir, ctx.signal);
      },
    });
  },
};
