'use strict';

// Turns the many ways a request can fail (raw gateway HTML pages, DNS errors, resets, timeouts, JSON error bodies)
// into short, readable messages with a hint — and decides which failures are worth retrying.

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    Object.assign(this, extra);
  }
}

const decode = (s) => String(s).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** An HTML/JSON/plain error body -> one short line. */
function cleanBody(body, max = 240) {
  let t = String(body == null ? '' : body).trim();
  if (!t) return '';
  if (/^\s*(<!doctype|<html|<\?xml)/i.test(t) || /<\/?(html|head|body|title|div)\b/i.test(t)) {
    const title = (t.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    const h1 = (t.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
    const stripped = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ');
    t = [title, h1].filter(Boolean).map((x) => x.replace(/<[^>]+>/g, ' ')).join(' — ') || stripped;
  } else if (t[0] === '{' || t[0] === '[') {
    try {
      const j = JSON.parse(t);
      const e = j.error != null ? j.error : j.message != null ? j.message : j.detail != null ? j.detail : null;
      if (e != null) t = typeof e === 'string' ? e : e.message || JSON.stringify(e);
    } catch { /* keep raw text */ }
  }
  t = decode(t).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

const HINTS = {
  400: 'the server rejected the request (bad model name or parameters?)',
  401: 'the API key is missing or wrong (Providers → API key)',
  403: 'access denied — check the API key / permissions',
  404: 'not found — check the endpoint URL and the model name',
  408: 'the request timed out on the server side',
  413: 'the request is too large for the server — compact the conversation or use a smaller context',
  429: 'rate limit / quota reached — wait a bit or use another model/key',
  500: 'the model server had an internal error',
  502: 'bad gateway — the model server behind the proxy/tunnel is down or restarting',
  503: 'the model server is overloaded or loading the model',
  504: 'gateway timeout — the model took too long to answer (the prompt may be too big for the server)',
  520: 'Cloudflare got an invalid/empty answer from your server',
  521: 'Cloudflare: your server is offline (is Ollama and the tunnel running?)',
  522: 'Cloudflare: connection to your server timed out',
  523: 'Cloudflare: your server is unreachable',
  524: 'Cloudflare gave up waiting (100 s without any answer) — the prompt is probably too big for your GPU to process in time; compact the session or lower numCtx / autoCtxMax',
  525: 'Cloudflare: TLS handshake with your server failed',
  526: 'Cloudflare: invalid TLS certificate on your server',
  530: 'Cloudflare: the tunnel is not connected (restart cloudflared, the URL may have changed)',
  1033: 'Cloudflare tunnel error — the quick-tunnel URL is not active any more',
};

/**
 * Build an HttpError from a failed fetch response.
 * @param source e.g. "Ollama chat", "models list"
 */
function fromResponse(status, body, source) {
  const detail = cleanBody(body);
  // Cloudflare error pages mention "Error code 524" etc.
  const cf = /error code (\d{3,4})/i.exec(String(body || ''));
  const code = cf ? Number(cf[1]) : status;
  const hint = HINTS[code] || HINTS[status] || '';
  const msg = `HTTP ${status} from ${source}${detail ? `: ${detail}` : ''}${hint && !(detail && detail.includes(hint)) ? ` — ${hint}` : ''}`;
  return new HttpError(status, msg, { hint, detail, cfCode: cf ? code : undefined, source });
}

const NET_CODES = {
  ENOTFOUND: 'DNS lookup failed (wrong URL, or a new tunnel URL that is not ready yet)',
  EAI_AGAIN: 'DNS lookup failed temporarily (network or DNS problem)',
  ECONNREFUSED: 'connection refused (is the server running on that address/port?)',
  ECONNRESET: 'connection was reset by the server or proxy',
  EPIPE: 'connection closed while sending',
  ETIMEDOUT: 'connection timed out',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable (no internet?)',
  UND_ERR_CONNECT_TIMEOUT: 'could not connect in time',
  UND_ERR_HEADERS_TIMEOUT: 'the server did not start answering in time (the prompt may be too big)',
  UND_ERR_BODY_TIMEOUT: 'the server stopped sending data',
  UND_ERR_SOCKET: 'the connection was closed unexpectedly',
  CERT_HAS_EXPIRED: 'TLS certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed TLS certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate could not be verified',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match the host name',
};

/** The root error code of a failed fetch (undici hides it in err.cause). */
function netCode(err) {
  for (let e = err, i = 0; e && i < 4; e = e.cause, i++) {
    if (e.code && typeof e.code === 'string') return e.code;
    if (Array.isArray(e.errors)) for (const x of e.errors) if (x && typeof x.code === 'string') return x.code;     // AggregateError (IPv4+IPv6 attempts)
  }
  return '';
}

/** Readable explanation for any error; `where` = "http://host" or a provider name. */
function explain(err, where = '') {
  if (!err) return 'unknown error';
  if (err instanceof HttpError) return err.message;
  const raw = String(err.message || err);
  const code = netCode(err);
  if (err.name === 'AbortError' || err.name === 'TimeoutError' || /operation was aborted|aborted due to timeout/i.test(raw)) {
    return `request timed out${where ? ` (${where})` : ''}`;
  }
  if (NET_CODES[code]) return `cannot reach ${where || 'the server'}: ${NET_CODES[code]}`;
  if (/fetch failed|terminated|other side closed|socket hang up/i.test(raw)) return `cannot reach ${where || 'the server'}: connection failed${code ? ` (${code})` : ''}`;
  return raw;
}

/** Should the agent/loader try again? Client errors (4xx except 408/429) never. */
function isRetryable(err) {
  if (!err) return false;
  const status = Number(err.status) || 0;
  if (status) return status === 408 || status === 429 || status === 425 || status >= 500 && ![501, 505, 511].includes(status);
  const code = netCode(err);
  if (code) return /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_)/.test(code);
  const raw = String(err.message || err);
  return /\b(429|500|502|503|504|52\d|530)\b|rate.?limit|too many requests|overloaded|unavailable|terminated|fetch failed|network|socket hang up|other side closed|timed? ?out|timeout|operation was aborted/i.test(raw);
}

/** Gateway/timeouts where re-sending the same huge prompt will probably fail again. */
const isTimeoutPressure = (err) => !!err && (err.status === 524 || err.status === 504 || err.status === 522 || err.status === 408 || netCode(err) === 'UND_ERR_HEADERS_TIMEOUT');

/** HTTP status to answer a client with for an error thrown inside an API handler. */
function statusFor(err) {
  if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) return err.status;
  const code = err && err.code;
  if (code === 'ENOENT') return 404;
  if (code === 'EACCES' || code === 'EPERM') return 403;
  if (code === 'ENOSPC' || code === 'EMFILE' || code === 'ENFILE' || code === 'EIO') return 500;
  if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError || err instanceof SyntaxError && !/JSON/i.test(String(err.message))) return 500;
  return 400;       // plain `throw new Error(...)` in handlers means "bad request"
}

/** Wrap a failed fetch() (DNS/refused/reset/timeout…) in an Error with a readable message; the original stays in `.cause`. */
function wrapNetwork(err, where) {
  if (err instanceof HttpError) return err;
  const e = new Error(explain(err, where), { cause: err });
  e.code = netCode(err) || err.code;
  e.name = err && err.name === 'AbortError' ? 'AbortError' : 'NetworkError';
  return e;
}

/** fetch() that throws readable errors: network failures and non-2xx answers (gateway HTML pages are boiled down to one line). */
async function fetchOk(url, opts, { source, where } = {}) {
  let res;
  try { res = await fetch(url, opts); } catch (err) { throw wrapNetwork(err, where || (() => { try { return new URL(url).origin; } catch { return ''; } })()); }
  if (!res.ok) throw fromResponse(res.status, await res.text().catch(() => ''), source || (() => { try { return new URL(url).host; } catch { return 'server'; } })());
  return res;
}

module.exports = { wrapNetwork, fetchOk, HttpError, cleanBody, fromResponse, explain, isRetryable, isTimeoutPressure, statusFor, netCode, HINTS };
