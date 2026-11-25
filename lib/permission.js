'use strict';

// Permission rules: a flat list of {permission, pattern, action}; the LAST matching rule wins.
// Config forms:  "edit": "deny"   or   "bash": { "git *": "allow", "rm *": "deny", "*": "ask" }

const BASE_RULES = [
  { permission: '*', pattern: '*', action: 'allow' },
  // Shell commands can change anything, so they ask by default. Harmless read-only commands are allowed below.
  { permission: 'bash', pattern: '*', action: 'ask' },
  { permission: 'bash', pattern: 'pwd', action: 'allow' },
  { permission: 'bash', pattern: 'ls *', action: 'allow' },
  { permission: 'bash', pattern: 'git status *', action: 'allow' },
  { permission: 'bash', pattern: 'git branch', action: 'allow' },
  { permission: 'bash', pattern: 'node --version', action: 'allow' },
  { permission: 'doom_loop', pattern: '*', action: 'ask' },
  { permission: 'mcp', pattern: '*', action: 'ask' },            // MCP tools run third-party code
  { permission: 'plugin', pattern: '*', action: 'ask' },         // plugin tools also run third-party code
  { permission: 'webfetch_private', pattern: '*', action: 'ask' }, // localhost / LAN URLs (SSRF guard)
  { permission: 'read', pattern: '*', action: 'allow' },
  { permission: 'read', pattern: '*.env', action: 'ask' },
  { permission: 'read', pattern: '*.env.*', action: 'ask' },
  { permission: 'read', pattern: '*.env.example', action: 'allow' },
];

function fromConfig(obj) {
  const rules = [];
  for (const [permission, value] of Object.entries(obj || {})) {
    if (typeof value === 'string') rules.push({ permission, pattern: '*', action: value });
    else if (value && typeof value === 'object') {
      for (const [pattern, action] of Object.entries(value)) rules.push({ permission, pattern, action });
    }
  }
  return rules.filter((r) => ['allow', 'ask', 'deny'].includes(r.action));
}

function wildcard(str, pattern) {
  if (pattern === '*') return true;
  let re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  if (re.endsWith(' .*')) re = re.slice(0, -3) + '( .*)?'; // "ls *" also matches bare "ls"
  return new RegExp('^' + re + '$', 's').test(str);
}

function evaluate(permission, pattern, ...rulesets) {
  const all = rulesets.flat();
  for (let i = all.length - 1; i >= 0; i--) {
    if (wildcard(permission, all[i].permission) && wildcard(pattern, all[i].pattern)) return all[i];
  }
  return { permission, pattern: '*', action: 'ask' };
}

const normalizeGrants = (session) => {
  if (!Array.isArray(session.grants)) {
    session.grants = Object.keys(session.grants || {}).filter((k) => session.grants[k]).map((permission) => ({ permission, pattern: '*', action: 'allow' }));
  }
  return session.grants;
};

/** defaults < config < agent. Session grants are layered on top but can never override a deny. */
function rulesFor(agent, config, inherited = []) {
  return [...BASE_RULES, ...fromConfig(config.permission), ...fromConfig(agent.permission), ...inherited];
}

function decide(permission, pattern, { agent, config, session, inherited }) {
  const rules = rulesFor(agent, config, inherited);
  const base = evaluate(permission, pattern, rules).action;
  if (base === 'deny') return 'deny';
  // grants are allow-only. A `literal` grant (dangerous or interpreter-like commands) matches that exact string only, never as a glob.
  const granted = normalizeGrants(session).some((g) => g.action === 'allow' && wildcard(permission, g.permission) && (g.literal ? g.pattern === pattern : wildcard(pattern, g.pattern)));
  return granted ? 'allow' : base;
}

/** True if the agent can never use this permission category (tool is hidden from the model). */
function disabled(permission, agent, config, inherited = []) {
  const rules = rulesFor(agent, config, inherited).filter((r) => wildcard(permission, r.permission));
  const last = rules[rules.length - 1];
  return !!last && last.pattern === '*' && last.action === 'deny';
}

/* ---------- bash: evaluate every segment of a compound command ---------- */

// Control operators that start a new command: ; | || && & (background!) and newlines. A single `&` used to be missed, so
// "ls & curl evil.sh" looked like the harmless command `ls`. The scan is quote-aware (an operator inside '…' or "…" is data).
// Anything the scan cannot judge with certainty (unterminated quote, $'…' / $"…" strings, substitutions, redirects) is never auto-allowed.
const COMPLEX = /[<>`]|\$\(|\$\{|<\(|\$['"]/;

function parseCommand(command) {
  const s = String(command);
  const segments = [];
  let cur = '';
  let quote = null;
  let esc = false;
  const push = () => { const t = cur.trim(); if (t) segments.push(t); cur = ''; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { cur += c; esc = false; continue; }
    if (c === '\\' && quote !== "'") { cur += c; esc = true; continue; }
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '\r') { push(); continue; }
    cur += c;
  }
  push();
  return { segments, unterminated: quote !== null || esc };
}

function bashSegments(command) { return parseCommand(command).segments; }

const isGit = (seg) => /^git(\s|$)/.test(seg);

function gitIsRisky(ctx) {
  try { return require('./gitsafe').risky(ctx.workDir || require('./config').getWorkDir()); } catch { return false; }
}

function decideBash(command, ctx) {
  const parsed = parseCommand(command);
  const segs = parsed.segments;
  if (!segs.length) return 'deny';
  const complex = COMPLEX.test(command) || parsed.unterminated;
  let result = 'allow';
  for (const seg of [command, ...segs]) {
    const d = decide('bash', seg, ctx);
    if (d === 'deny') return 'deny';
    if (seg !== command && d === 'ask') result = 'ask';
  }
  // whole-string rule can also say ask/deny (e.g. "* | sh")
  if (decide('bash', command, ctx) === 'ask' && segs.length === 1) result = 'ask';
  if (complex && result === 'allow' && !normalizeGrants(ctx.session).some((g) => g.exact === command)) return 'ask';
  // git runs programs named in the repository's own config (core.fsmonitor, diff.external, textconv, filters ...):
  // when that config looks dangerous no git command is auto-allowed, not even one the user granted with "always".
  if (result === 'allow' && segs.some(isGit) && gitIsRisky(ctx)) return 'ask';
  return result;
}

const TWO_TOKEN = new Set(['git', 'npm', 'pnpm', 'yarn', 'docker', 'cargo', 'go', 'pip', 'pip3', 'make', 'systemctl', 'apt', 'kubectl']);

// "Always allow" must never turn into a blanket licence to run arbitrary code. Commands in these sets are only remembered
// for the EXACT command line (literal grant), so allowing `node build.js` does not allow `node -e "..."`.
const NEVER_BROAD = new Set(['rm', 'sudo', 'su', 'doas', 'dd', 'mkfs', 'chmod', 'chown', 'kill', 'killall', 'mv', 'cp', 'ln', 'shutdown', 'reboot', 'curl', 'wget', 'sh', 'bash', 'zsh', 'dash', 'fish', 'eval',
  // interpreters and runners: they execute whatever code they are given
  'node', 'nodejs', 'deno', 'bun', 'python', 'python2', 'python3', 'py', 'ruby', 'perl', 'php', 'lua', 'tclsh', 'java', 'dotnet', 'rscript', 'osascript', 'powershell', 'pwsh', 'cmd',
  'npx', 'pnpx', 'bunx', 'uvx', 'pipx', 'busybox',
  // wrappers that run another command
  'env', 'xargs', 'find', 'awk', 'gawk', 'mawk', 'sed', 'time', 'timeout', 'nohup', 'nice', 'ionice', 'watch', 'exec', 'command', 'builtin', 'parallel', 'expect', 'script', 'strace', 'gdb', 'tee',
  'ssh', 'scp', 'rsync', 'tar', 'unzip', 'zip']);
// subcommands that run project scripts, change history/remotes or start containers: exact match only
const RISKY_SUB = {
  git: new Set(['push', 'reset', 'clean', 'rebase', 'checkout', 'restore', 'rm', 'config', 'filter-branch', 'submodule', 'am', 'apply', 'pull', 'fetch', 'clone', 'remote', 'worktree', 'update-ref', 'gc', 'prune', 'tag']),
  docker: new Set(['run', 'exec', 'rm', 'rmi', 'build', 'compose', 'cp', 'system', 'volume', 'network', 'container', 'image']),
  kubectl: new Set(['exec', 'apply', 'delete', 'run', 'cp', 'replace', 'patch', 'edit', 'create']),
  npm: new Set(['run', 'run-script', 'exec', 'x', 'start', 'test', 'publish', 'install', 'i', 'ci', 'add', 'link', 'rebuild', 'init', 'explore']),
  pnpm: new Set(['run', 'exec', 'dlx', 'start', 'test', 'publish', 'install', 'i', 'add', 'link', 'rebuild', 'create']),
  yarn: new Set(['run', 'exec', 'dlx', 'start', 'test', 'publish', 'install', 'add', 'create']),
  cargo: new Set(['run', 'install', 'publish', 'test', 'bench', 'build', 'check']),
  go: new Set(['run', 'install', 'generate', 'test', 'get']),
  pip: new Set(['install']), pip3: new Set(['install']),
  apt: new Set(['install', 'remove', 'purge', 'upgrade', 'dist-upgrade', 'autoremove']),
  systemctl: new Set(['start', 'stop', 'restart', 'enable', 'disable', 'mask', 'kill', 'edit']),
};

/** Remember an "always allow" for the shape of this command (not blanket bash). */
function grant(session, category, pattern) {
  const grants = normalizeGrants(session);
  const add = (p, extra = {}) => { if (!grants.some((g) => g.permission === category && g.pattern === p && !!g.literal === !!extra.literal)) grants.push({ permission: category, pattern: p, action: 'allow', ...extra }); };
  if (category === 'webfetch') { try { return add(new URL(pattern).origin + '/*'); } catch { return add(pattern, { literal: true }); } }
  if (category !== 'bash') return add(category === 'edit' ? '*' : pattern);
  if (COMPLEX.test(pattern) || parseCommand(pattern).unterminated) return add(pattern, { exact: pattern, literal: true });
  for (const seg of bashSegments(pattern)) {
    const toks = seg.split(/\s+/);
    const first = String(toks[0]).replace(/^.*[\\/]/, '').toLowerCase();       // /usr/bin/python3 -> python3
    const sub = String(toks[1] || '').toLowerCase();
    const risky = NEVER_BROAD.has(first) || /^[A-Za-z_]\w*=/.test(toks[0]) || /[*?]/.test(seg) || (RISKY_SUB[first] && RISKY_SUB[first].has(sub));
    if (risky) add(seg, { literal: true });
    else add(TWO_TOKEN.has(first) && toks[1] ? `${toks[0]} ${toks[1]} *` : `${toks[0]} *`);
  }
}

module.exports = { parseCommand, bashSegments, rulesFor, fromConfig, evaluate, wildcard, decide, decideBash, disabled, grant, normalizeGrants, BASE_RULES };
