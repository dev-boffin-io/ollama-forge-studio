'use strict';

// Request guard for the local HTTP server.
//
// Threats handled here:
//   * DNS rebinding      - a web page re-points its own hostname at 127.0.0.1 and talks to the API as "same origin".
//                          Fixed by only accepting known Host names while bound to loopback.
//   * CSRF               - any site you visit can POST text/plain to http://127.0.0.1:<port>/api/... without a CORS
//                          preflight. Fixed by checking Origin / Sec-Fetch-Site on every request that is not a plain
//                          static read, and by requiring application/json (or the upload stream type) on writes.
//   * LAN / tunnel use   - when the server listens on a non-loopback address a random access token is required
//                          (Authorization: Bearer, `studio_token` cookie, or ?token= on the first visit, which sets the cookie).
//
// All decisions are made in `check(req, url)`, which is pure (no I/O) so it is unit-tested directly.

const crypto = require('node:crypto');

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const COOKIE = 'studio_token';

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
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * @param {{bindHost:string, token?:string, extraHosts?:string[]}} opts
 *   token: forced token (env OLLAMA_STUDIO_TOKEN); otherwise one is generated when the bind address is not loopback.
 *   extraHosts: additional Host names accepted in loopback mode (env OLLAMA_STUDIO_ALLOWED_HOSTS, comma separated).
 */
function createGuard({ bindHost, token, extraHosts = [] } = {}) {
  const loopback = isLoopbackBind(bindHost);
  const secret = token || (loopback ? '' : crypto.randomBytes(24).toString('base64url'));
  const allowedHosts = new Set([...LOOPBACK_NAMES, ...extraHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean)]);

  const deny = (status, error) => ({ ok: false, status, error });

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

    // 3. Cross-site protection (always on).
    const origin = headers.origin;
    const fetchSite = headers['sec-fetch-site'];
    const isRead = method === 'GET' || method === 'HEAD';
    if (origin) {
      let same = false;
      try { same = new URL(origin).host.toLowerCase() === String(headers.host || '').toLowerCase(); } catch { same = false; }
      if (!same) return deny(403, 'forbidden: cross-origin request');
    }
    const isApi = Boolean(url && url.pathname.startsWith('/api/'));
    if (fetchSite && (isApi || !isRead) && fetchSite !== 'same-origin' && fetchSite !== 'none') {
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

  return { check, loopback, token: secret, tokenRequired: Boolean(secret) };
}

module.exports = { createGuard, isLoopbackBind, hostOnly, parseCookies };
