'use strict';

// webfetch (URL -> markdown/text/html) and websearch (Exa MCP, DuckDuckGo, or SearXNG).

const MAX_BYTES = 50 * 1024 * 1024;
const UA = 'Mozilla/5.0 (compatible; ollama-forge-studio/2.0)';

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

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;
const isPrivateHost = (url) => { try { return PRIVATE_HOST.test(new URL(url).hostname); } catch { return false; } };

async function webfetch({ url, format = 'markdown', timeout }) {
  let u;
  try { u = new URL(url); } catch { throw new Error('invalid URL (must be fully formed, e.g. https://example.com/page)'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) URLs are supported');
  const ms = Math.min(120, Math.max(1, Number(timeout) || 30)) * 1000;
  const accept = format === 'html' ? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' : 'text/markdown,text/plain;q=0.9,text/html;q=0.8,*/*;q=0.1';
  const res = await fetch(u, { headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
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
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search_exa', arguments: { query, type: 'auto', numResults: n, livecrawl: 'fallback' } } }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Exa HTTP ${res.status}`);
  const text = await res.text();
  const pick = (payload) => { try { const j = JSON.parse(payload); const t = (j.result && j.result.content || []).find((c) => c.text); return t && t.text; } catch { return null; } };
  const direct = text.trim().startsWith('{') ? pick(text.trim()) : null;
  if (direct) return direct;
  for (const line of text.split('\n')) if (line.startsWith('data: ')) { const r = pick(line.slice(6)); if (r) return r; }
  throw new Error('Exa returned no results');
}

async function ddg(query, n) {
  const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(html)) && out.length < n) {
    let href = decodeEntities(m[1]);
    const u = href.match(/uddg=([^&]+)/);
    if (u) href = decodeURIComponent(u[1]);
    out.push(`${out.length + 1}. ${htmlToText(m[2])}\n   ${href}\n   ${m[3] ? htmlToText(m[3]) : ''}`);
  }
  if (!out.length) throw new Error('no results parsed');
  return out.join('\n\n');
}

async function searxng(base, query, n) {
  const res = await fetch(`${String(base).replace(/\/+$/, '')}/search?format=json&q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const j = await res.json();
  return (j.results || []).slice(0, n).map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content || ''}`).join('\n\n') || 'no results';
}

async function websearch(query, config, numResults = 8) {
  const cfg = config.websearch || {};
  const order = cfg.provider === 'searxng' && cfg.url ? ['searxng'] : cfg.provider === 'ddg' ? ['ddg'] : cfg.provider === 'exa' || !cfg.provider ? ['exa', 'ddg'] : [cfg.provider, 'ddg'];
  let lastErr;
  for (const p of order) {
    try { return p === 'exa' ? await exa(query, numResults) : p === 'searxng' ? await searxng(cfg.url, query, numResults) : await ddg(query, numResults); } catch (e) { lastErr = e; }
  }
  throw new Error('web search failed: ' + (lastErr && lastErr.message));
}

module.exports = { webfetch, websearch, isPrivateHost, htmlToMarkdown };
