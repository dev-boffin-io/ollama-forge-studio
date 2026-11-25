'use strict';

// Request guard for the local HTTP server.
//
// Threats handled here:
//   * DNS rebinding      - a web page re-points its own hostname at 127.0.0.1 and talks to the API as "same origin".
//                          Fixed by only accepting known Host names while bound to loopback.
//   * CSRF               - any site you visit can POST text/plain to http://127.0.0.1:<port>/api/... without a CORS
//                          preflight. Fixed by checking Origin / Sec-Fetch-Site on every request that is not a plain
//                          static read, and by requiring application/json (or the upload stream type) on writes.
//   * Same-origin proof  - the UI adds `X-Studio-Client: web` to every request it makes. A custom header forces a CORS preflight
//                          for any other site, and the studio never answers preflights, so only the studio's own page can send
//                          it. That is a browser-enforced CSRF proof which, unlike the Origin string, survives phone/LAN
//                          browsers, reverse proxies and port forwards (Host rewritten, Sec-Fetch-* headers missing or
//                          'same-site', Origin not matching the Host the server sees).
//   * LAN / tunnel use   - when the server listens on a non-loopback address a random access token is required
//                          (Authorization: Bearer, `studio_token` cookie, or ?token= on the first visit, which sets the cookie).
//
// All decisions are made in `check(req, url)`, which is pure (no I/O) so it is unit-tested directly.

const crypto = require('node:crypto');

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const COOKIE = 'studio_token';
const CLIENT_HEADER = 'x-studio-client';   // sent by public/net.js on every request of the bundled UI
const CLIENT_VALUE = 'web';

/** "http://Host:4310/", "host:4310", "HOST" → "host:4310" / "host" (lower-case, scheme and path dropped). */
const hostKey = (v) => {
  const raw = String(v || '').trim().toLowerCase();
  if (!raw) return '';
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : 'http://' + raw).host; } catch { return ''; }
};

const isLoopbackBind = (host) => {
  const h = String(host || '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(h);
};

const hostOnly = (hostHeader) => {
  const h = String(hostHeader || '').toLowerCase();
  if (h.startsWith('[')) { const end = h.indexOf(']'); return end > 0 ? h.slice(0, end + 1) : h; }
  return h.replace(/:\d+$/, '');
};

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    let value = raw;
    try { value = decodeURIComponent(raw); } catch { /* malformed %-escape from a client: keep the raw text, never throw */ }
    out[part.slice(0, i).trim()] = value;
  }
  return out;
}

/**
 * @param {{bindHost:string, token?:string, extraHosts?:string[]}} opts
 *   token: forced token (env OLLAMA_STUDIO_TOKEN); otherwise one is generated when the bind address is not loopback.
 *   extraHosts: additional Host names accepted in loopback mode (env OLLAMA_STUDIO_ALLOWED_HOSTS, comma separated).
 *   extraOrigins: additional browser origins ("http://192.168.1.20:8080" or just "192.168.1.20:8080") treated as same-origin, for
 *     setups where a proxy / tunnel presents the studio under another address (env OLLAMA_STUDIO_ALLOWED_ORIGINS, --allow-origin).
 */
function createGuard({ bindHost, token, extraHosts = [], extraOrigins = [] } = {}) {
  const loopback = isLoopbackBind(bindHost);
  const secret = token || (loopback ? '' : crypto.randomBytes(24).toString('base64url'));
  const allowedHosts = new Set([...LOOPBACK_NAMES, ...extraHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean)]);

  const trustedOrigins = new Set(extraOrigins.map(hostKey).filter(Boolean));

  const deny = (status, error) => ({ ok: false, status, error });

  /** The page's own script made this request (custom header: cross-site pages cannot send it without a preflight we never grant). */
  const fromStudioUi = (headers) => String(headers[CLIENT_HEADER] || '').trim().toLowerCase() === CLIENT_VALUE;

  /** Does this Origin header name this very server? Accepts the Host the server saw, the Host a proxy forwarded, or a listed origin. */
  function originIsOurs(origin, headers) {
    let o = '';
    try { o = new URL(origin).host.toLowerCase(); } catch { return false; }
    if (o === String(headers.host || '').toLowerCase()) return true;
    const fwd = String(headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase();   // browsers cannot set this cross-site without a preflight
    if (fwd && o === fwd) return true;
    return trustedOrigins.has(o);
  }

  /** Same-origin verdict for code outside check() (e.g. /api/shutdown). No Origin header = not a browser cross-site request. */
  function isSameOrigin(req) {
    const headers = (req && req.headers) || {};
    if (fromStudioUi(headers) || !headers.origin) return true;
    return originIsOurs(headers.origin, headers);
  }

  /** Returns { ok:true, setCookie? } or { ok:false, status, error }. */
  function check(req, url) {
    const method = String(req.method || 'GET').toUpperCase();
    const headers = req.headers || {};

    // 1. Host header: only in loopback mode (with a token, any Host is fine because rebinding cannot know the token).
    if (!secret && !allowedHosts.has(hostOnly(headers.host))) return deny(403, 'forbidden: unexpected Host header (set OLLAMA_STUDIO_ALLOWED_HOSTS to allow it)');

    // 2. Token (non-loopback or forced).
    let setCookie = null;
    if (secret) {
      const bearer = /^Bearer\s+(.+)$/i.exec(String(headers.authorization || ''));
      const fromCookie = parseCookies(headers.cookie)[COOKIE];
      const fromQuery = url && url.searchParams ? url.searchParams.get('token') : null;
      const supplied = (bearer && bearer[1]) || fromCookie || fromQuery;
      if (!supplied || !safeEqual(supplied, secret)) return deny(401, 'unauthorized: open the URL printed at startup (it contains ?token=…)');
      if (!fromCookie && fromQuery) setCookie = `${COOKIE}=${encodeURIComponent(secret)}; Path=/; HttpOnly; SameSite=Strict`;
    }

    // 3. Cross-site protection (always on). A request that carries the UI's custom header can only have been sent by the studio's own
    //    page (anything else would first need a successful CORS preflight), so the string comparisons below are skipped for it.
    const origin = headers.origin;
    const fetchSite = headers['sec-fetch-site'];
    const isRead = method === 'GET' || method === 'HEAD';
    const proven = fromStudioUi(headers);
    if (origin && !proven && !originIsOurs(origin, headers)) {
      return deny(403, `forbidden: cross-origin request (Origin ${String(origin).slice(0, 100)} is not Host ${String(headers.host || '?').slice(0, 100)}; behind a proxy or tunnel? list its address in OLLAMA_STUDIO_ALLOWED_ORIGINS)`);
    }
    const isApi = Boolean(url && url.pathname.startsWith('/api/'));
    if (!proven && fetchSite && (isApi || !isRead) && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      // 'cross-site' and 'same-site' (another port on localhost is same-site!) are refused for the API; plain page loads
      // and link clicks to the UI are still fine (static files carry no secrets, the browser's CORS rules stop cross-origin reads).
      return deny(403, 'forbidden: cross-site request');
    }

    // 4. Writes must be JSON (or a raw upload) so a plain HTML form / text/plain fetch cannot reach the API without a preflight.
    if (!isRead && method !== 'OPTIONS' && url && url.pathname.startsWith('/api/')) {
      const type = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const hasBody = headers['content-length'] !== '0' && (headers['content-length'] !== undefined || headers['transfer-encoding'] !== undefined);
      const isUpload = url.pathname === '/api/upload';
      if (hasBody && !isUpload && type !== 'application/json') return deny(415, 'unsupported media type: send application/json');
    }

    return { ok: true, setCookie };
  }

  return { check, isSameOrigin, loopback, token: secret, tokenRequired: Boolean(secret) };
}

module.exports = { createGuard, isLoopbackBind, hostOnly, parseCookies, CLIENT_HEADER, CLIENT_VALUE };
