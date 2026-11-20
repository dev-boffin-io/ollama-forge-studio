'use strict';

// Fuzzy "old_string -> new_string" matching (tolerates whitespace/indentation drift).
// Local models often get whitespace/indentation slightly wrong; instead of failing the edit,
// we try progressively looser matchers and only accept an unambiguous match.

function levenshtein(a, b) {
  if (!a || !b) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const simple = function* (_c, find) { yield find; };

const lineTrimmed = function* (content, find) {
  const orig = content.split('\n');
  const search = find.split('\n');
  if (search[search.length - 1] === '') search.pop();
  for (let i = 0; i <= orig.length - search.length; i++) {
    if (search.every((s, j) => orig[i + j].trim() === s.trim())) {
      const start = orig.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
      const len = orig.slice(i, i + search.length).reduce((n, l) => n + l.length + 1, 0) - 1;
      yield content.substring(start, start + len);
    }
  }
};

/** First+last line anchors with fuzzy middle (similarity >= 0.65). */
const blockAnchor = function* (content, find) {
  const orig = content.split('\n');
  const search = find.split('\n');
  if (search.length < 3) return;
  if (search[search.length - 1] === '') search.pop();
  const first = search[0].trim();
  const last = search[search.length - 1].trim();
  const maxDelta = Math.max(1, Math.floor(search.length * 0.25));
  const cands = [];
  for (let i = 0; i < orig.length; i++) {
    if (orig[i].trim() !== first) continue;
    for (let j = i + 2; j < orig.length; j++) {
      if (orig[j].trim() === last) {
        if (Math.abs(j - i + 1 - search.length) <= maxDelta) cands.push([i, j]);
        break;
      }
    }
  }
  if (!cands.length) return;
  const similarity = ([s, e]) => {
    const n = Math.min(search.length - 2, e - s - 1);
    if (n <= 0) return 1;
    let sum = 0;
    for (let k = 1; k <= n; k++) {
      const a = orig[s + k].trim();
      const b = search[k].trim();
      const m = Math.max(a.length, b.length);
      sum += m === 0 ? 1 : 1 - levenshtein(a, b) / m;
    }
    return sum / n;
  };
  const scored = cands.map((c) => ({ c, sim: similarity(c) }));
  const best = scored.reduce((a, b) => (b.sim > a.sim ? b : a));
  if (best.sim < 0.65) return;
  const [s, e] = best.c;
  const start = orig.slice(0, s).reduce((n, l) => n + l.length + 1, 0);
  const len = orig.slice(s, e + 1).reduce((n, l) => n + l.length + 1, 0) - 1;
  yield content.substring(start, start + len);
};

const whitespaceNormalized = function* (content, find) {
  const norm = (t) => t.replace(/\s+/g, ' ').trim();
  const target = norm(find);
  const lines = content.split('\n');
  for (const line of lines) {
    if (norm(line) === target) yield line;
    else if (norm(line).includes(target)) {
      const words = find.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const m = line.match(new RegExp(words.join('\\s+')));
      if (m) yield m[0];
    }
  }
  const n = find.split('\n').length;
  if (n > 1) {
    for (let i = 0; i <= lines.length - n; i++) {
      const block = lines.slice(i, i + n).join('\n');
      if (norm(block) === target) yield block;
    }
  }
};

const indentationFlexible = function* (content, find) {
  const strip = (text) => {
    const lines = text.split('\n');
    const non = lines.filter((l) => l.trim());
    if (!non.length) return text;
    const min = Math.min(...non.map((l) => l.match(/^\s*/)[0].length));
    return lines.map((l) => (l.trim() ? l.slice(min) : l)).join('\n');
  };
  const target = strip(find);
  const cl = content.split('\n');
  const n = find.split('\n').length;
  for (let i = 0; i <= cl.length - n; i++) {
    const block = cl.slice(i, i + n).join('\n');
    if (strip(block) === target) yield block;
  }
};

const trimmedBoundary = function* (content, find) {
  const t = find.trim();
  if (t === find) return;
  if (content.includes(t)) yield t;
};

/** Models sometimes copy the "12: " prefixes shown by read_file into old_string. */
const lineNumberStripped = function* (content, find) {
  const lines = find.split('\n');
  if (lines.length && lines.every((l) => /^\s*\d+[:|]\s?/.test(l) || l === '')) {
    yield lines.map((l) => l.replace(/^\s*\d+[:|]\s?/, '')).join('\n');
  }
};

/** Local models often double-escape: they send a literal backslash-n where a real newline belongs. */
const unescapeLiteral = (t) => t.replace(/\\(n|t|r|"|'|`|\\)/g, (_m, c) => ({ n: '\n', t: '\t', r: '\r' }[c] ?? c));

const escapeNormalized = function* (content, find) {
  if (!/\\[ntr"'`\\]/.test(find)) return;
  const un = unescapeLiteral(find);
  if (un === find) return;
  if (content.includes(un)) yield un;
  yield* lineTrimmed(content, un);
  yield* indentationFlexible(content, un);
};

const REPLACERS = [
  ['simple', simple], ['lineTrimmed', lineTrimmed], ['blockAnchor', blockAnchor],
  ['whitespaceNormalized', whitespaceNormalized], ['indentationFlexible', indentationFlexible],
  ['trimmedBoundary', trimmedBoundary], ['lineNumberStripped', lineNumberStripped],
  ['escapeNormalized', escapeNormalized],
];

/* ---------- closest-region hint (turns a blind "not found" into something the model can copy from) ---------- */

const bigrams = (t) => { const m = new Map(); for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a); const B = bigrams(b);
  let inter = 0;
  for (const [g, c] of A) inter += Math.min(c, B.get(g) || 0);
  return (2 * inter) / (a.length - 1 + b.length - 1);
}

/** Finds where old_string most likely was meant to be. Returns { start, end, text } (1-based, numbered like read_file) or null. */
function closestRegion(content, find, { pad = 1, maxLines = 40 } = {}) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const want = String(find).replace(/\r\n/g, '\n').split('\n');
  const n = Math.min(want.length, maxLines);
  const byTrim = new Map();
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t.length < 3) return;
    if (!byTrim.has(t)) byTrim.set(t, []);
    byTrim.get(t).push(i);
  });
  const votes = new Map();
  const vote = (s, w) => votes.set(s, (votes.get(s) || 0) + w);
  want.forEach((fl, k) => {
    const hits = byTrim.get(fl.trim());
    if (!hits || hits.length > 5) return;
    for (const i of hits) vote(i - k, 1);
  });
  if (!votes.size) {                       // nothing identical: fall back to per-line similarity on the first few real lines
    let tried = 0;
    for (let k = 0; k < want.length && tried < 6; k++) {
      const t = want[k].trim();
      if (t.length < 6) continue;
      tried++;
      let bestI = -1; let bestSim = 0.6;
      for (let i = 0; i < lines.length && i < 20000; i++) {
        const lt = lines[i].trim();
        if (lt.length < 3) continue;
        const sim = dice(t, lt);
        if (sim > bestSim) { bestSim = sim; bestI = i; }
      }
      if (bestI >= 0) vote(bestI - k, bestSim);
    }
  }
  if (!votes.size) return null;
  let best = null;
  for (const [s, v] of votes) if (!best || v > best.v) best = { s, v };
  const first = Math.max(0, best.s - pad);
  const last = Math.min(lines.length - 1, best.s + n - 1 + pad);
  const text = lines.slice(first, last + 1).map((l, i) => `${first + i + 1}: ${l.length > 300 ? l.slice(0, 300) + '…' : l}`).join('\n');
  return { start: first + 1, end: last + 1, text };
}

/* ---------- line endings ---------- */

const isCrlf = (t) => t.includes('\r\n') && !/(^|[^\r])\n/.test(t);
const toLf = (t) => t.replace(/\r\n/g, '\n');
const restoreEol = (t, crlf) => (crlf ? t.replace(/\n/g, '\r\n') : t);

function disproportionate(search, old) {
  const oldLines = old.split('\n').length;
  const sLines = search.split('\n').length;
  if (sLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
  if (oldLines === 1) return false;
  return search.trim().length > Math.max(old.trim().length + 500, old.trim().length * 4);
}

/** Returns { content, matched, via } or throws a model-friendly error. */
function replace(content, oldString, newString, replaceAll = false) {
  if (oldString === newString) throw new Error('No changes to apply: old_string and new_string are identical.');
  if (oldString === '') throw new Error('old_string cannot be empty. Provide the exact text to replace, or use write_file for a full overwrite.');
  const crlf = isCrlf(content);
  const src = crlf ? toLf(content) : content;
  const oldS = toLf(oldString);
  let newS = toLf(newString);
  let notFound = true;
  for (const [via, replacer] of REPLACERS) {
    for (const search of replacer(src, oldS)) {
      const idx = src.indexOf(search);
      if (idx === -1) continue;
      notFound = false;
      if (disproportionate(search, oldS)) {
        throw new Error('Refusing replacement: the matched span is much larger than old_string. Re-read the file and give the full exact old_string.');
      }
      // the model double-escaped old_string (single line full of "\n") -> it almost certainly did the same to new_string
      if (via === 'escapeNormalized' && !oldS.includes('\n') && !newS.includes('\n')) newS = unescapeLiteral(newS);
      if (replaceAll) return { content: restoreEol(src.split(search).join(newS), crlf), matched: search, via };
      if (idx !== src.lastIndexOf(search)) continue; // ambiguous for this matcher; try a stricter-context one
      return { content: restoreEol(src.slice(0, idx) + newS + src.slice(idx + search.length), crlf), matched: search, via };
    }
  }
  if (notFound) {
    const near = closestRegion(src, oldS);
    const hint = near
      ? ` Closest match is at lines ${near.start}-${near.end}; the ACTUAL text there is:\n${near.text}\nCopy old_string from this text exactly (without the "N: " prefixes), or call edit_file with start_line/end_line to replace that range instead.`
      : ' Use read_file to see the current content, or call edit_file with start_line/end_line.';
    throw new Error('Could not find old_string in the file. It must match exactly, including whitespace and indentation.' + hint);
  }
  throw new Error('Found multiple matches for old_string. Include more surrounding lines to make it unique, or set replace_all=true.');
}

/**
 * Replace a 1-based inclusive line range (no old_string needed). `expect` (optional) is the text the model believes
 * is on start_line; it guards against stale line numbers after earlier edits.
 */
function replaceLines(content, startLine, endLine, newString, expect) {
  const crlf = isCrlf(content);
  const lines = (crlf ? toLf(content) : content).split('\n');
  const s = Number(startLine);
  const e = endLine == null || endLine === '' ? s : Number(endLine);
  if (!Number.isInteger(s) || !Number.isInteger(e)) throw new Error('start_line and end_line must be integers (1-based, inclusive).');
  if (s < 1 || e < s || e > lines.length) throw new Error(`Invalid line range ${s}-${e}: the file has ${lines.length} lines. Use read_file to see the current line numbers.`);
  if (expect != null && String(expect).trim() !== '' && lines[s - 1].trim() !== String(expect).replace(/^\s*\d+[:|]\s?/, '').trim()) {
    const from = Math.max(1, s - 2); const to = Math.min(lines.length, e + 2);
    const txt = lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n');
    throw new Error(`Line ${s} does not match expect_first_line (line numbers are probably stale after an earlier edit). Actual lines ${from}-${to}:\n${txt}\nRe-check the range and retry.`);
  }
  const ins = toLf(String(newString ?? ''));
  const newLines = ins === '' ? [] : ins.replace(/\n$/, '').split('\n');
  const out = [...lines.slice(0, s - 1), ...newLines, ...lines.slice(e)];
  return { content: restoreEol(out.join('\n'), crlf), matched: lines.slice(s - 1, e).join('\n'), via: 'lines' };
}

/** Tiny readable diff of the replaced region (not a full unified diff). */
function miniDiff(before, after, max = 20) {
  const a = before.split('\n');
  const b = after.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) { ea--; eb--; }
  const rem = a.slice(s, ea + 1);
  const add = b.slice(s, eb + 1);
  const out = [`@@ line ${s + 1} @@`];
  rem.slice(0, max).forEach((l) => out.push('- ' + l));
  if (rem.length > max) out.push(`- … ${rem.length - max} more`);
  add.slice(0, max).forEach((l) => out.push('+ ' + l));
  if (add.length > max) out.push(`+ … ${add.length - max} more`);
  return { diff: out.join('\n'), additions: add.length, deletions: rem.length };
}

module.exports = { replace, replaceLines, closestRegion, miniDiff };
