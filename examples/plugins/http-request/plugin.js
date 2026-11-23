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
//   * http/https only, redirects are NOT followed by default (the Location header is returned), bodies are capped.
//   * hosts that resolve to loopback / private / link-local addresses need an explicit OK (config allowPrivate or an ask).
//   * optional allowlist of public hosts (config.http.allowHosts).
//   * secrets: header values may contain {{env:NAME}}; only variables listed in config.http.allowEnv are substituted.
//
// Config (config.json):  "http": { "allowHosts": ["api.example.com", "*.github.com"], "allowPrivate": ["localhost:3000"],
//                                  "allowEnv": ["GITHUB_TOKEN"], "maxBytes": 2000000,
//                                  "followRedirects": false, "maxRedirects": 5 }
// Permissions: plugin tools ask by default. Relax with  "permission": { "plugin": { "http_request": "allow" } }  if you trust the model.

const dns = require('node:dns').promises;
const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const KEEP_HEADERS = ['content-type', 'content-length', 'location', 'retry-after', 'www-authenticate', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'etag'];
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

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

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers && typeof headers === 'object' ? headers : {})) {
    out[k] = String(v).replace(/\{\{env:([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, name) => `[redacted:${name}]`);
  }
  return out;
}

function parseUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch { throw new Error('url is not a valid absolute URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('only http and https URLs are supported');
  if (url.username || url.password) throw new Error('credentials inside the URL are not allowed; use headers with {{env:NAME}}');
  return url;
}

async function assertUrlAllowed(url, allowHosts, allowPrivate, ctx) {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const hostPort = url.port ? `${host}:${url.port}` : host;
  if (allowHosts.length && !hostMatches(host, allowHosts) && !hostMatches(hostPort, allowPrivate)) {
    throw new Error(`host ${host} is not in config.http.allowHosts`);
  }
  let addrs;
  try { addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }); } catch (e) { throw new Error(`cannot resolve ${host}: ${e.code || e.message}`); }
  if (addrs.some((a) => isPrivateIp(a.address)) && !hostMatches(hostPort, allowPrivate) && !hostMatches(host, allowPrivate)) {
    const reply = typeof ctx.askPermission === 'function'
      ? await ctx.askPermission({ tool: 'http_request', category: 'webfetch_private', summary: `${url.protocol}//${hostPort} (a local / private network address)` })
      : 'reject';
    if (reply !== 'once' && reply !== 'always') throw new Error(`requests to private network addresses (${host}) need approval; add "${hostPort}" to config.http.allowPrivate to allow them`);
  }
}

async function resolveInside(base, relative) {
  const root = path.resolve(base);
  const rel = String(relative || '').replace(/\\/g, '/');
  if (!rel.trim()) throw new Error('save_to needs a non-empty path');
  if (path.isAbsolute(rel)) {
    const abs = path.resolve(rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`save_to absolute path is outside the working directory (${root})`);
  }
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('save_to path escapes the working directory');
  let probe = full;
  while (true) {
    try {
      const real = await fs.realpath(probe);
      if (real !== root && !real.startsWith(root + path.sep)) throw new Error('save_to path is a symlink that points outside the working directory');
      return full;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const parent = path.dirname(probe);
      if (parent === probe) throw new Error('save_to path escapes the working directory');
      probe = parent;
    }
  }
}

function requestBody(args, method) {
  if (method === 'GET' || method === 'HEAD') return { body: undefined, shown: undefined };
  if (args.json !== undefined) {
    const body = JSON.stringify(args.json);
    return { body, shown: body, contentType: 'application/json' };
  }
  if (typeof args.body_base64 === 'string') return { body: Buffer.from(args.body_base64, 'base64'), shown: undefined, shownBase64: args.body_base64, contentType: 'application/octet-stream' };
  if (typeof args.body === 'string') return { body: args.body, shown: args.body };
  return { body: undefined, shown: undefined };
}

function numberIn(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

module.exports = {
  name: 'http',
  version: '1.1.0',
  description: 'Full HTTP/JSON API client tool (http_request).',
  setup(api) {
    const cfg = (api.config && api.config.http) || {};
    const allowHosts = Array.isArray(cfg.allowHosts) ? cfg.allowHosts : [];
    const allowPrivate = Array.isArray(cfg.allowPrivate) ? cfg.allowPrivate : [];
    const allowEnv = Array.isArray(cfg.allowEnv) ? cfg.allowEnv : [];
    const hardMax = numberIn(cfg.maxBytes, 2 * 1024 * 1024, 1, 50 * 1024 * 1024);
    const defaultFollowRedirects = cfg.followRedirects === true;
    const defaultMaxRedirects = numberIn(cfg.maxRedirects, 5, 0, 20);

    api.registerTool({
      name: 'request',
      description: 'Send an HTTP request and get status, headers and body. Compact by default; opt into full text, binary, '
        + 'request details, redirects or saving the response to the workspace. Use it for REST APIs and local dev servers '
        + 'instead of curl. Header values may contain {{env:NAME}} to use a secret without seeing it. Runs outside the sandbox.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: METHODS, description: 'HTTP method (default GET).' },
          url: { type: 'string', description: 'Full http(s) URL, including the query string.' },
          headers: { type: 'object', description: 'Request headers, e.g. {"Authorization": "Bearer {{env:API_TOKEN}}"}.' },
          json: { description: 'JSON body (any JSON value). Sets Content-Type: application/json unless you set one.' },
          body: { type: 'string', description: 'Raw text body (use instead of json).' },
          body_base64: { type: 'string', description: 'Base64 request body for binary uploads (use instead of json/body).' },
          pick: { type: 'array', items: { type: 'string' }, description: 'For JSON responses: only return these paths, e.g. ["data.items[*].id", "meta.total"].' },
          timeout_seconds: { type: 'number', description: 'Default 20, max 300.' },
          max_bytes: { type: 'number', description: `Body bytes/chars to return in compact mode (default 8000, max ${hardMax}).` },
          include_request: { type: 'boolean', description: 'Include method, URL, headers (env values redacted) and the request body in the result.' },
          include_headers: { type: 'boolean', description: 'Return every response header instead of only the key ones.' },
          full_body: { type: 'boolean', description: `Return the whole response body up to config.http.maxBytes (${hardMax}), ignoring max_bytes.` },
          as_base64: { type: 'boolean', description: 'Return raw response bytes as body_base64 instead of decoded text.' },
          save_to: { type: 'string', description: 'Save the complete raw response to this workspace-relative path.' },
          follow_redirects: { type: 'boolean', description: 'Follow redirects, rechecking host/private-address rules on every hop (default from config.http.followRedirects).' },
          max_redirects: { type: 'number', description: 'Maximum redirects to follow (default from config.http.maxRedirects, max 20).' },
        },
        required: ['url'],
      },
      handler: async (args, ctx = {}) => {
        const method = String(args.method || 'GET').toUpperCase();
        if (!METHODS.includes(method)) throw new Error(`method must be one of ${METHODS.join(', ')}`);
        const original = parseUrl(args.url);
        const followRedirects = args.follow_redirects === undefined ? defaultFollowRedirects : args.follow_redirects === true;
        const maxRedirects = numberIn(args.max_redirects, defaultMaxRedirects, 0, 20);

        const headers = {};
        for (const [k, v] of Object.entries(args.headers && typeof args.headers === 'object' ? args.headers : {})) headers[k] = injectEnv(v, allowEnv);
        const shownHeaders = redactHeaders(args.headers);
        const req = requestBody(args, method);
        let body = req.body;
        if (req.contentType && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = req.contentType;
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) headers['User-Agent'] = 'ollama-forge-studio/http-request';
        if (!Object.keys(headers).some((k) => k.toLowerCase() === 'accept')) headers.Accept = 'application/json, text/plain;q=0.9, */*;q=0.5';

        const secs = numberIn(args.timeout_seconds, 20, 1, 300);
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), secs * 1000);
        const onAbort = () => ac.abort();
        if (ctx.signal) { if (ctx.signal.aborted) ac.abort(); else ctx.signal.addEventListener('abort', onAbort, { once: true }); }
        const t0 = Date.now();
        try {
          let current = original;
          let hopMethod = method;
          let hopBody = body;
          const redirects = [];
          let res;
          let buf;
          while (true) {
            await assertUrlAllowed(current, allowHosts, allowPrivate, ctx);
            res = await fetch(current, { method: hopMethod, headers, body: hopBody, redirect: 'manual', signal: ac.signal });
            const location = res.headers.get('location');
            if (res.status >= 300 && res.status < 400 && location && followRedirects && redirects.length < maxRedirects) {
              const target = new URL(location, current);
              if (target.origin !== current.origin) {
                for (const k of Object.keys(headers)) if (SENSITIVE_HEADERS.has(k.toLowerCase())) delete headers[k];
              }
              redirects.push({ status: res.status, from: current.toString(), to: target.toString() });
              current = target;
              if ([301, 302, 303].includes(res.status) && hopMethod !== 'GET' && hopMethod !== 'HEAD') {
                hopMethod = 'GET';
                hopBody = undefined;
                for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type') delete headers[k];
              }
              continue;
            }
            buf = Buffer.from(await res.arrayBuffer());
            break;
          }

          const out = { status: res.status, status_text: res.statusText, ms: Date.now() - t0, bytes: buf.length, headers: {} };
          if (args.include_headers === true) out.headers = Object.fromEntries(res.headers.entries());
          else for (const h of KEEP_HEADERS) { const v = res.headers.get(h); if (v) out.headers[h] = v; }
          if (args.include_request === true) {
            out.request = { method, url: original.toString(), headers: shownHeaders };
            if (req.shown !== undefined) out.request.body = req.shown;
            if (req.shownBase64 !== undefined) out.request.body_base64 = req.shownBase64;
          }
          if (redirects.length) out.redirects = redirects;
          if (res.status >= 300 && res.status < 400 && res.headers.get('location') && !redirects.length) out.note = 'Redirect not followed; call again with follow_redirects: true or use the Location URL.';
          if (followRedirects && redirects.length >= maxRedirects && res.status >= 300 && res.status < 400 && res.headers.get('location')) out.note = `Stopped after ${maxRedirects} redirects; increase max_redirects if needed.`;

          if (args.save_to !== undefined) {
            const file = await resolveInside(api.workDir, args.save_to);
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, buf);
            out.saved = { path: args.save_to, bytes: buf.length };
          }

          if (args.as_base64 === true) {
            const limit = args.full_body === true ? hardMax : numberIn(args.max_bytes, 8000, 1, hardMax);
            out.body_base64 = buf.subarray(0, limit).toString('base64');
            out.encoding = 'base64';
            if (buf.length > limit) out.truncated = `${buf.length - limit} more bytes; use full_body: true or raise config.http.maxBytes`;
          } else {
            const limit = args.full_body === true ? hardMax : numberIn(args.max_bytes, 8000, 1, hardMax);
            const text = buf.toString('utf8');
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
              if (pretty.length > limit) out.truncated = `${pretty.length - limit} more characters; use "pick" or "full_body: true"`;
            } else {
              out.body = text.slice(0, limit);
              if (text.length > limit) out.truncated = `${text.length - limit} more characters; use "full_body: true"`;
            }
          }
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
