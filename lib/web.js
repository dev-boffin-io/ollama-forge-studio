'use strict';

const { fromResponse, wrapNetwork } = require('./errors');

// webfetch (URL -> markdown/text/html) and websearch.

const MAX_BYTES = 50 * 1024 * 1024;
const UA = 'Mozilla/5.0 (compatible; ollama-forge-studio/2.0)';
const CACHE_TTL_MS = 10 * 60 * 1000;
const searchCache = new Map(); // key -> { at, data }

function cacheKey(q, opts) {
  return JSON.stringify({ q: String(q || ''), ...opts });
}

function getCache(k) {
  const v = searchCache.get(k);
  if (!v) return null;
  if (Date.now() - v.at > CACHE_TTL_MS) { searchCache.delete(k); return null; }
  return v.data;
}

function setCache(k, data) {
  searchCache.set(k, { at: Date.now(), data });
}

const decodeEntities = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));

function htmlToText(html) {
  return decodeEntities(html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

/** Small HTML -> Markdown converter (headings, links, lists, code, emphasis). */
function htmlToMarkdown(html) {
  let h = html.replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  h = h.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => '\n```\n' + decodeEntities(c.replace(/<[^>]+>/g, '')) + '\n```\n');
  h = h.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => '`' + c.replace(/<[^>]+>/g, '') + '`');
  for (let i = 1; i <= 6; i++) h = h.replace(new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi'), (_, c) => `\n\n${'#'.repeat(i)} ${c.replace(/<[^>]+>/g, '').trim()}\n\n`);
  h = h.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => { const text = t.replace(/<[^>]+>/g, '').trim(); return text ? `[${text}](${href})` : ''; });
  h = h.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**').replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  h = h.replace(/<li[^>]*>/gi, '\n- ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|ul|ol|table|section|article)>/gi, '\n\n').replace(/<\/t[dh]>/gi, ' | ');
  return decodeEntities(h.replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function get(url, opts) {
  try { return await fetch(url, opts); } catch (e) { throw wrapNetwork(e, (() => { try { return new URL(url).origin; } catch { return ''; } })()); }
}

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;
const isPrivateHost = (url) => { try { return PRIVATE_HOST.test(new URL(url).hostname); } catch { return false; } };

async function webfetch({ url, format = 'markdown', timeout }) {
  let u;
  try { u = new URL(url); } catch { throw new Error('invalid URL (must be fully formed, e.g. https://example.com/page)'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) URLs are supported');
  const ms = Math.min(120, Math.max(1, Number(timeout) || 30)) * 1000;
  const accept = format === 'html' ? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' : 'text/markdown,text/plain;q=0.9,text/html;q=0.8,*/*;q=0.1';
  const res = await get(u, { headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw fromResponse(res.status, await res.text().catch(() => ''), url);
  const type = res.headers.get('content-type') || '';
  if (/^(image|audio|video)\//.test(type) || /application\/(pdf|zip|octet-stream)/.test(type)) throw new Error(`Unsupported content type: ${type}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error('response too large (limit 50MB)');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('response too large (limit 50MB)');
  const body = buf.toString('utf8');
  const isHtml = /text\/html|application\/xhtml/.test(type) || /^\s*<(!doctype|html)/i.test(body);
  const content = format === 'html' ? body : isHtml ? (format === 'text' ? htmlToText(body) : htmlToMarkdown(body)) : body;
  return { url: res.url || url, content_type: type, content };
}

/* ---------- search ---------- */

async function exa(query, n) {
  const key = process.env.EXA_API_KEY;
  const url = key ? `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(key)}` : 'https://mcp.exa.ai/mcp';
  const res = await get(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search_exa', arguments: { query, type: 'auto', numResults: n, livecrawl: 'fallback' } } }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw fromResponse(res.status, await res.text().catch(() => ''), 'Exa search');
  const text = await res.text();
  const pick = (payload) => { try { const j = JSON.parse(payload); const t = (j.result && j.result.content || []).find((c) => c.text); return t && t.text; } catch { return null; } };
  const direct = text.trim().startsWith('{') ? pick(text.trim()) : null;
  if (direct) return direct;
  for (const line of text.split('\n')) if (line.startsWith('data: ')) { const r = pick(line.slice(6)); if (r) return r; }
  throw new Error('Exa returned no results');
}

const SITE_HINTS = { docs: 'documentation', news: 'news' };

function applyRecencySite(q, recency, siteType) {
  let query = String(q || '');
  if (siteType && SITE_HINTS[siteType] && siteType !== 'any') query += ` (${SITE_HINTS[siteType]})`;
  return query;
}

function buildDdgUrl(query, recency) {
  const u = new URL('https://html.duckduckgo.com/html/');
  u.searchParams.set('q', query);
  const r = String(recency || '').toLowerCase();
  if (r === 'day' || r === 'd') u.searchParams.set('df', 'd');
  else if (r === 'week' || r === 'w') u.searchParams.set('df', 'w');
  else if (r === 'month' || r === 'm') u.searchParams.set('df', 'm');
  else if (r === 'year' || r === 'y') u.searchParams.set('df', 'y');
  return u.toString();
}

function normalizeUrl(href) {
  if (!href) return '';
  let h = decodeEntities(href);
  const u = h.match(/uddg=([^&]+)/);
  if (u) h = decodeURIComponent(u[1]);
  try { return new URL(h).href; } catch { return h; }
}

async function ddg(query, n, opts = {}) {
  const q = applyRecencySite(query, opts.recency, opts.site_type);
  const url = buildDdgUrl(q, opts.recency);
  let res;
  try {
    res = await get(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw e;
  }
  if (!res.ok) throw fromResponse(res.status, '', 'DuckDuckGo search');
  const html = await res.text();
  const items = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/g;
  let m;
  while ((m = re.exec(html)) && items.length < n) {
    const href = normalizeUrl(m[1]);
    if (!href) continue;
    items.push({ title: htmlToText(m[2]), url: href, snippet: m[3] ? htmlToText(m[3]) : '', published_at: null });
  }
  const seen = new Set();
  const unique = items.filter((it) => { if (seen.has(it.url)) return false; seen.add(it.url); return true; });
  if (!unique.length) throw new Error('DuckDuckGo returned no parseable results (layout changed or blocked)');
  return unique;
}

function rewriteQueryVariants(query) {
  const q = String(query || '').trim();
  const variants = [q, q.replace(/\s+/g, ' ')];
  if (q.length > 20) variants.push(q.split(/\s+/).slice(0, 6).join(' '));
  return Array.from(new Set(variants)).filter(Boolean);
}

async function fetchAutoExtract(urls, limit, maxBytes = 80000) {
  const out = [];
  for (const u of urls.slice(0, limit)) {
    try {
      const r = await webfetch({ url: u, format: 'text', timeout: 15 });
      const text = String(r.content || '').slice(0, maxBytes);
      out.push({ url: u, excerpt: text });
    } catch {
      out.push({ url: u, excerpt: '' });
    }
  }
  return out;
}

async function websearch(query, config, numResults = 8, opts = {}) {
  const recency = opts.recency || opts.timeRange || opts.freshness;
  const site_type = opts.site_type || opts.siteType;
  const autoFetch = opts.autoFetch || opts.autofetch;
  const autoFetchLimit = Math.min(10, Math.max(0, Number(opts.autoFetchLimit || opts.fetch || 0)));
  const key = cacheKey(query, { numResults, recency, site_type, autoFetch, autoFetchLimit });
  const cached = getCache(key);
  if (cached) return cached;

  let lastErr;
  const variants = rewriteQueryVariants(query);
  const batches = [];
  for (let i = 0; i < variants.length; i++) {
    try {
      const items = await ddg(variants[i], numResults, { recency, site_type });
      batches.push(items);
    } catch (e) { lastErr = e; }
  }
  if (!batches.length) throw new Error('web search failed: ' + (lastErr && lastErr.message));

  const seen = new Set();
  let merged = [];
  for (const batch of batches) {
    for (const it of batch) {
      if (seen.has(it.url)) continue;
      seen.add(it.url);
      merged.push(it);
    }
  }
  merged = merged.slice(0, numResults);

  let results = merged.map((it) => `${it.url}\n${it.title}\n${it.snippet}${it.published_at ? '\n' + it.published_at : ''}`);
  if (autoFetchLimit > 0) {
    const extras = await fetchAutoExtract(merged.map((m) => m.url), autoFetchLimit);
    const map = new Map(extras.map((e) => [e.url, e.excerpt]));
    results = merged.slice(0, autoFetchLimit).map((it, idx) => {
      const ex = map.get(it.url);
      const base = `${it.url}\n${it.title}\n${it.snippet}${it.published_at ? '\n' + it.published_at : ''}`;
      return ex ? base + '\n\nExcerpt:\n' + ex.slice(0, 6000) : base;
    }).concat(merged.slice(autoFetchLimit).map((it) => `${it.url}\n${it.title}\n${it.snippet}${it.published_at ? '\n' + it.published_at : ''}`));
  }

  const out = results.join('\n\n---\n\n');
  setCache(key, out);
  return out;
}

websearch._ddg = ddg;
websearch._parseHtml = (html, n) => {
  const items = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/g;
  let m;
  while ((m = re.exec(html)) && items.length < n) {
    const href = normalizeUrl(m[1]);
    if (!href) continue;
    items.push({ title: htmlToText(m[2]), url: href, snippet: m[3] ? htmlToText(m[3]) : '' });
  }
  const seen = new Set();
  return items.filter((it) => { if (seen.has(it.url)) return false; seen.add(it.url); return true; });
};
websearch._cache = searchCache;

module.exports = { webfetch, websearch, isPrivateHost, htmlToMarkdown };
