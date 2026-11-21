'use strict';

// Environment handed to commands the agent runs (bash tool, background processes, terminal).
// Secrets in the studio's own environment (API keys, tokens, cloud credentials) are NOT passed on, so a model that is
// tricked into running `env` or `curl -d "$(env)" …` cannot leak them.
//
//   config.bashEnv = { inherit: true }            → pass everything (old behaviour)
//   config.bashEnv = { allow: ["GITHUB_TOKEN"] }  → pass these names even though they look secret
//   config.bashEnv = { deny: ["FOO_*"] }          → additionally drop these (glob with *)

const SECRET_NAME = /(^|_)(API_?KEY|APIKEY|SECRET|SECRET_?KEY|ACCESS_?KEY|TOKEN|PASSWORD|PASSWD|PASSPHRASE|PRIVATE_?KEY|CREDENTIALS?|SESSION_?TOKEN|AUTH_?TOKEN|COOKIE)($|_)/i;
const ALWAYS_DROP = /^(OLLAMA_STUDIO_TOKEN)$/;   // the studio's own access token must never reach child processes

const globToRe = (g) => new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');

function childEnv(config = {}, base = process.env) {
  const opts = (config && config.bashEnv) || {};
  if (opts.inherit === true) return { ...base };
  const allow = new Set((opts.allow || []).map((s) => String(s).toUpperCase()));
  const deny = (opts.deny || []).map(globToRe);
  // variables named by providers (apiKeyEnv) are secrets by definition
  const named = new Set();
  const provs = (config && config.providers) || {};
  for (const p of Object.values(provs)) if (p && p.apiKeyEnv) named.add(String(p.apiKeyEnv).toUpperCase());
  if (config && config.apiKeyEnv) named.add(String(config.apiKeyEnv).toUpperCase());

  const out = {};
  for (const [k, v] of Object.entries(base)) {
    const up = k.toUpperCase();
    if (ALWAYS_DROP.test(up)) continue;
    if (!allow.has(up) && (SECRET_NAME.test(k) || named.has(up))) continue;
    if (deny.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  return out;
}

module.exports = { childEnv, SECRET_NAME };
