'use strict';

// Permission rules: a flat list of {permission, pattern, action}; the LAST matching rule wins.
// Config forms:  "edit": "deny"   or   "bash": { "git *": "allow", "rm *": "deny", "*": "ask" }

const BASE_RULES = [
  { permission: '*', pattern: '*', action: 'allow' },
  { permission: 'doom_loop', pattern: '*', action: 'ask' },
  { permission: 'mcp', pattern: '*', action: 'ask' },            // MCP tools run third-party code
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
  const granted = evaluate(permission, pattern, normalizeGrants(session)).action === 'allow' && normalizeGrants(session).some((g) => wildcard(permission, g.permission) && wildcard(pattern, g.pattern));
  return granted ? 'allow' : base;
}

/** True if the agent can never use this permission category (tool is hidden from the model). */
function disabled(permission, agent, config, inherited = []) {
  const rules = rulesFor(agent, config, inherited).filter((r) => wildcard(permission, r.permission));
  const last = rules[rules.length - 1];
  return !!last && last.pattern === '*' && last.action === 'deny';
}

/* ---------- bash: evaluate every segment of a compound command ---------- */

const SEGMENT_SPLIT = /&&|\|\||[;|\n]/;
const COMPLEX = /[<>`]|\$\(|\$\{|<\(/; // redirects / substitutions: never auto-allowed

function bashSegments(command) {
  return String(command).split(SEGMENT_SPLIT).map((s) => s.trim()).filter(Boolean);
}

function decideBash(command, ctx) {
  const segs = bashSegments(command);
  if (!segs.length) return 'deny';
  const complex = COMPLEX.test(command);
  let result = 'allow';
  for (const seg of [command, ...segs]) {
    const d = decide('bash', seg, ctx);
    if (d === 'deny') return 'deny';
    if (seg !== command && d === 'ask') result = 'ask';
  }
  // whole-string rule can also say ask/deny (e.g. "* | sh")
  if (decide('bash', command, ctx) === 'ask' && segs.length === 1) result = 'ask';
  if (complex && result === 'allow' && !normalizeGrants(ctx.session).some((g) => g.exact === command)) return 'ask';
  return result;
}

const TWO_TOKEN = new Set(['git', 'npm', 'pnpm', 'yarn', 'docker', 'cargo', 'go', 'pip', 'pip3', 'make', 'systemctl', 'apt', 'kubectl']);
const NEVER_BROAD = new Set(['rm', 'sudo', 'su', 'dd', 'mkfs', 'chmod', 'chown', 'kill', 'killall', 'mv', 'shutdown', 'reboot', 'curl', 'wget', 'sh', 'bash', 'eval']);

/** Remember an "always allow" for the shape of this command (not blanket bash). */
function grant(session, category, pattern) {
  const grants = normalizeGrants(session);
  const add = (p, extra = {}) => { if (!grants.some((g) => g.permission === category && g.pattern === p)) grants.push({ permission: category, pattern: p, action: 'allow', ...extra }); };
  if (category === 'webfetch') { try { return add(new URL(pattern).origin + '/*'); } catch { return add(pattern); } }
  if (category !== 'bash') return add(category === 'edit' ? '*' : pattern);
  if (COMPLEX.test(pattern)) return add(pattern, { exact: pattern });
  for (const seg of bashSegments(pattern)) {
    const toks = seg.split(/\s+/);
    if (NEVER_BROAD.has(toks[0])) add(seg);
    else add(TWO_TOKEN.has(toks[0]) && toks[1] ? `${toks[0]} ${toks[1]} *` : `${toks[0]} *`);
  }
}

module.exports = { rulesFor, fromConfig, evaluate, wildcard, decide, decideBash, disabled, grant, normalizeGrants, BASE_RULES };
