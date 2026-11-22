'use strict';

// http_request: a small API client for the agent (REST / JSON), shipped as a bundled plugin.
//
// Why a tool and not `curl` in bash: curl commands are only remembered one by one in the permission engine, the model has to
// parse raw output itself, and secrets would have to be pasted into the command line (and therefore into the conversation).
// This tool returns a compact result (status, key headers, truncated / filtered body) and can inject secrets from the
// environment by name without the model ever seeing them.
//
// IMPORTANT: it runs inside the studio process, NOT in the Docker sandbox (`sandbox.enabled` does not apply to it).
//
// Safety:
//   * http/https only, redirects are NOT followed (the Location header is returned), body capped, timeout capped.
//   * hosts that resolve to loopback / private / link-local addresses need an explicit OK (config allowPrivate or an ask).
//   * optional allowlist of public hosts (config.http.allowHosts).
//   * secrets: header values may contain {{env:NAME}}; only variables listed in config.http.allowEnv are substituted.
//
// Config (config.json):  "http": { "allowHosts": ["api.example.com", "*.github.com"], "allowPrivate": ["localhost:3000"],
//                                  "allowEnv": ["GITHUB_TOKEN"], "maxBytes": 20000 }
// Permissions: plugin tools ask by default. Relax with  "permission": { "plugin": { "http_request": "allow" } }  if you trust the model.

const dns = require('node:dns').promises;
const net = require('node:net');

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const KEEP_HEADERS = ['content-type', 'content-length', 'location', 'retry-after', 'www-authenticate', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'etag'];

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
}

function hostMatches(host, list) {
  return (list || []).some((p) => {
    const pat = String(p).toLowerCase();
    if (pat.startsWith('*.')) return host === pat.slice(2) || host.endsWith(pat.slice(1));
    return host === pat;
  });
}

function getPath(value, pathStr) {
  const parts = String(pathStr).replace(/\[(\d+|\*)\]/g, '.$1').split('.').filter(Boolean);
  let cur = [value];
  for (const part of parts) {
    const next = [];
    for (const c of cur) {
      if (part === '*') { if (Array.isArray(c)) next.push(...c); } else if (c != null && typeof c === 'object' && part in c) next.push(c[part]);
    }
    cur = next;
  }
  return parts.includes('*') ? cur : cur[0];
}

function injectEnv(value, allowEnv) {
  return String(value).replace(/\{\{env:([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, name) => {
    if (!allowEnv.includes(name)) throw new Error(`environment variable ${name} is not listed in config.http.allowEnv`);
    const v = process.env[name];
    if (v == null) throw new Error(`environment variable ${name} is not set`);
    return v;
  });
}

module.exports = {
  name: 'http',
  version: '1.0.0',
  description: 'Optional HTTP/JSON API client tool (http_request).',
  setup(api) {
    const cfg = (api.config && api.config.http) || {};
    const allowHosts = Array.isArray(cfg.allowHosts) ? cfg.allowHosts : [];
    const allowPrivate = Array.isArray(cfg.allowPrivate) ? cfg.allowPrivate : [];
    const allowEnv = Array.isArray(cfg.allowEnv) ? cfg.allowEnv : [];
    const hardMax = Math.min(200000, Number(cfg.maxBytes) || 20000);

    api.registerTool({
      name: 'request',
      description: 'Send an HTTP request and get a compact result: status, key headers and the body (truncated; JSON can be filtered with `pick`). '
        + 'Use it to call a local dev server or a REST API instead of curl. Redirects are not followed (the Location header is returned). '
        + 'Header values may contain {{env:NAME}} to use a secret from the environment without seeing it. Runs outside the sandbox.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: METHODS, description: 'HTTP method (default GET).' },
          url: { type: 'string', description: 'Full http(s) URL, including the query string.' },
          headers: { type: 'object', description: 'Request headers, e.g. {"Authorization": "Bearer {{env:API_TOKEN}}"}.' },
          json: { description: 'JSON body (any JSON value). Sets Content-Type: application/json unless you set one.' },
          body: { type: 'string', description: 'Raw text body (use instead of json).' },
          pick: { type: 'array', items: { type: 'string' }, description: 'For JSON responses: only return these paths, e.g. ["data.items[*].id", "meta.total"].' },
          timeout_seconds: { type: 'number', description: 'Default 20, max 120.' },
          max_bytes: { type: 'number', description: `Body bytes to return (default 8000, max ${hardMax}).` },
        },
        required: ['url'],
      },
      handler: async (args, ctx = {}) => {
        let url;
        try { url = new URL(String(args.url || '')); } catch { throw new Error('url is not a valid absolute URL'); }
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('only http and https URLs are supported');
        if (url.username || url.password) throw new Error('credentials inside the URL are not allowed; use headers with {{env:NAME}}');
        const method = String(args.method || 'GET').toUpperCase();
        if (!METHODS.includes(method)) throw new Error(`method must be one of ${METHODS.join(', ')}`);

        const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        const hostPort = url.port ? `${host}:${url.port}` : host;
        if (allowHosts.length && !hostMatches(host, allowHosts) && !hostMatches(hostPort, allowPrivate)) {
          throw new Error(`host ${host} is not in config.http.allowHosts`);
        }

        // resolve first: a public-looking name may point at a private address
        let addrs;
        try { addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }); } catch (e) { throw new Error(`cannot resolve ${host}: ${e.code || e.message}`); }
        if (addrs.some((a) => isPrivateIp(a.address)) && !hostMatches(hostPort, allowPrivate) && !hostMatches(host, allowPrivate)) {
          const reply = typeof ctx.askPermission === 'function'
            ? await ctx.askPermission({ tool: 'http_request', category: 'webfetch_private', summary: `${method} ${url.origin} (a local / private network address)` })
            : 'reject';
          if (reply !== 'once' && reply !== 'always') throw new Error(`requests to private network addresses (${host}) need approval; add "${hostPort}" to config.http.allowPrivate to allow them`);
        }

        const headers = {};
        for (const [k, v] of Object.entries(args.headers && typeof args.headers === 'object' ? args.headers : {})) headers[k] = injectEnv(v, allowEnv);
        let body;
        if (args.json !== undefined && method !== 'GET' && method !== 'HEAD') {
          body = JSON.stringify(args.json);
          if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
        } else if (typeof args.body === 'string' && method !== 'GET' && method !== 'HEAD') body = args.body;
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) headers['User-Agent'] = 'ollama-forge-studio/http-request';
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept')) headers.Accept = 'application/json, text/plain;q=0.9, */*;q=0.5';

        const ac = new AbortController();
        const secs = Math.min(120, Math.max(1, Number(args.timeout_seconds) || 20));
        const timer = setTimeout(() => ac.abort(), secs * 1000);
        const onAbort = () => ac.abort();
        if (ctx.signal) { if (ctx.signal.aborted) ac.abort(); else ctx.signal.addEventListener('abort', onAbort, { once: true }); }
        const t0 = Date.now();
        try {
          const res = await fetch(url, { method, headers, body, redirect: 'manual', signal: ac.signal });
          const limit = Math.min(hardMax, Math.max(200, Number(args.max_bytes) || 8000));
          const buf = Buffer.from(await res.arrayBuffer());
          const text = buf.toString('utf8');
          const out = { status: res.status, status_text: res.statusText, ms: Date.now() - t0, headers: {} };
          for (const h of KEEP_HEADERS) { const v = res.headers.get(h); if (v) out.headers[h] = v; }
          const ctype = String(res.headers.get('content-type') || '');
          let parsed;
          if (/json/i.test(ctype) || /^\s*[[{]/.test(text.slice(0, 20))) { try { parsed = JSON.parse(text); } catch { parsed = undefined; } }
          if (parsed !== undefined && Array.isArray(args.pick) && args.pick.length) {
            const picked = {};
            for (const p of args.pick) picked[p] = getPath(parsed, p);
            out.json = picked;
          } else if (parsed !== undefined) {
            const pretty = JSON.stringify(parsed, null, 2);
            out.body = pretty.slice(0, limit);
            if (pretty.length > limit) out.truncated = `${pretty.length - limit} more characters; use "pick" to select fields`;
          } else {
            out.body = text.slice(0, limit);
            if (text.length > limit) out.truncated = `${text.length - limit} more characters`;
          }
          if (res.status >= 300 && res.status < 400) out.note = 'Redirect not followed; call again with the Location URL if you want it.';
          return { output: JSON.stringify(out, null, 2) };
        } catch (e) {
          if (ac.signal.aborted) throw new Error(ctx.signal && ctx.signal.aborted ? 'aborted' : `request timed out after ${secs}s`);
          throw new Error(`request failed: ${e.cause && e.cause.code ? e.cause.code : e.message}`);
        } finally {
          clearTimeout(timer);
          if (ctx.signal) ctx.signal.removeEventListener('abort', onAbort);
        }
      },
    });
  },
};

module.exports.__test = { isPrivateIp, hostMatches, getPath, injectEnv };
