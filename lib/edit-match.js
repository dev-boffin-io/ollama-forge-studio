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

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const contentLines = (t) => String(t ?? '').split('\n');
const splitLines = (t) => {
  const s = String(t ?? '');
  if (s === '') return [];
  const a = s.split(/\r?\n/);
  if (a[a.length - 1] === '') a.pop();
  return a;
};
const normWs = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();
const lineOffsets = (lines) => {
  const out = [0];
  for (const l of lines) out.push(out[out.length - 1] + l.length + 1);
  return out;
};
const spanAt = (content, lines, offsets, start, n) => content.substring(offsets[start], offsets[start + n] - 1);

function indentOf(line) {
  const raw = /^[\t ]*/.exec(String(line ?? ''))[0];
  const tabs = (raw.match(/\t/g) || []).length;
  const spaces = raw.length - tabs;
  const style = tabs && spaces ? 'mixed' : tabs ? 'tab' : spaces ? 'space' : 'none';
  return { raw, tabs, spaces, width: tabs * 4 + spaces, style };
}

function commonIndentUnit(lines) {
  const non = lines.filter((l) => l.trim());
  if (!non.length) return '';
  const indents = non.map((l) => /^[\t ]*/.exec(l)[0]);
  if (indents.every((s) => s.includes('\t'))) return '\t';
  if (indents.every((s) => /^ +$/.test(s))) {
    const min = Math.min(...indents.map((s) => s.length));
    if (min >= 4 && min % 4 === 0) return '    ';
    if (min >= 2 && min % 2 === 0) return '  ';
    return ' '.repeat(min);
  }
  return indents.reduce((a, b) => (b.length < a.length ? b : a), indents[0]);
}

function stripIndentUnit(lines, unit) {
  if (!unit) return lines.slice();
  return lines.map((l) => (l.trim() && l.startsWith(unit) ? l.slice(unit.length) : l));
}

function lineIndentQuality(expected, actual) {
  const e = indentOf(expected);
  const a = indentOf(actual);
  if (e.raw === a.raw) return 1;
  if (e.style === 'none' || a.style === 'none') return 0;
  if (e.style === a.style) {
    const d = Math.abs(e.width - a.width);
    if (d === 0) return 0.9;
    if (d <= 1) return 0.7;
    if (d <= 4) return 0.4;
    return 0;
  }
  if (e.width === a.width) return 0.65;
  if (Math.abs(e.width - a.width) <= 1) return 0.45;
  return 0;
}

function indentQuality(expected, actual) {
  const e = Array.isArray(expected) ? expected : splitLines(expected);
  const a = Array.isArray(actual) ? actual : splitLines(actual);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < e.length; i++) {
    if (!e[i].trim()) continue;
    sum += lineIndentQuality(e[i], a[i] ?? '');
    n++;
  }
  return n ? sum / n : 1;
}

function indentPatternsCompatible(expected, actual) {
  for (let i = 0; i < expected.length; i++) {
    if (!expected[i].trim()) continue;
    const e = indentOf(expected[i]);
    const a = indentOf(actual[i] ?? '');
    if (e.style === 'none') continue;
    if (a.style === 'none') return false;
    if (e.style !== a.style) {
      if (e.width !== a.width) return false;
    } else if (e.raw !== a.raw && Math.abs(e.width - a.width) > 1) return false;
  }
  return true;
}

function lineSimilarity(a, b) {
  const x = normWs(a);
  const y = normWs(b);
  if (x === y) return 1;
  if (!x || !y) return 0;
  if (Math.max(x.length, y.length) > 2000) return dice(x, y);
  const lev = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  return Math.max(lev, dice(x, y));
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

function whitespaceRegex(text) {
  const tokens = normWs(text).split(' ').filter(Boolean).map(escapeRegExp);
  return tokens.length ? new RegExp(tokens.join('[\\t ]+')) : null;
}

const whitespaceNormalized = function* (content, find) {
  const target = normWs(find);
  const lines = contentLines(content);
  const want = splitLines(find);
  if (want.length <= 1) {
    const re = whitespaceRegex(find);
    for (const line of lines) {
      if (normWs(line) === target) yield line;
      else if (re) {
        const m = re.exec(line);
        if (m) yield m[0];
      }
    }
    return;
  }
  const regexes = want.map(whitespaceRegex);
  if (regexes.some((r) => !r)) return;
  for (let i = 0; i <= lines.length - want.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (!regexes[j].test(lines[i + j])) { ok = false; break; }
    }
    if (ok) yield lines.slice(i, i + want.length).join('\n');
  }
};

const indentationFlexible = function* (content, find) {
  const lines = contentLines(content);
  const want = splitLines(find);
  const target = stripIndentUnit(want, commonIndentUnit(want)).join('\n');
  for (let i = 0; i <= lines.length - want.length; i++) {
    const block = lines.slice(i, i + want.length);
    if (!indentPatternsCompatible(want, block)) continue;
    if (stripIndentUnit(block, commonIndentUnit(block)).join('\n') === target) yield block.join('\n');
  }
};

const fuzzyLineMatch = function* (content, find, { threshold = 0.78, maxStarts = 20000 } = {}) {
  const lines = contentLines(content);
  const want = splitLines(find);
  if (!want.length || !lines.length) return;
  const offsets = lineOffsets(lines);
  const starts = Math.min(lines.length - want.length + 1, maxStarts);
  for (let i = 0; i < starts; i++) {
    let sum = 0;
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      const sim = lineSimilarity(want[j], lines[i + j] ?? '');
      if (sim < threshold) { ok = false; break; }
      sum += sim;
    }
    if (!ok) continue;
    const indent = indentQuality(want, lines.slice(i, i + want.length));
    if (indent < 0.45) continue;
    const score = 0.8 * (sum / want.length) + 0.2 * indent;
    if (score >= threshold) yield spanAt(content, lines, offsets, i, want.length);
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
  ['escapeNormalized', escapeNormalized], ['fuzzyLineMatch', fuzzyLineMatch],
];

const MATCH_WEIGHTS = {
  simple: 1000,
  lineTrimmed: 930,
  blockAnchor: 900,
  whitespaceNormalized: 870,
  indentationFlexible: 850,
  trimmedBoundary: 820,
  lineNumberStripped: 800,
  escapeNormalized: 780,
  fuzzyLineMatch: 620,
};

function scoreMatch(find, search) {
  if (search === find) return 1;
  const want = splitLines(find);
  const got = splitLines(search);
  const whole = lineSimilarity(find, search);
  let perLine = whole;
  if (want.length === got.length && want.length) {
    perLine = want.reduce((n, l, i) => n + lineSimilarity(l, got[i]), 0) / want.length;
  }
  const similarity = Math.max(whole, perLine);
  const indent = indentQuality(want, got);
  const whitespace = normWs(find) === normWs(search) ? 1 : similarity;
  return 0.6 * similarity + 0.25 * indent + 0.15 * whitespace;
}

function rankMatches(content, find, { maxPerMatcher = 300 } = {}) {
  const out = [];
  const seen = new Set();
  for (const [via, replacer] of REPLACERS) {
    let count = 0;
    for (const search of replacer(content, find)) {
      if (++count > maxPerMatcher) break;
      let from = 0;
      let idx;
      while ((idx = content.indexOf(search, from)) !== -1) {
        from = idx + 1;
        const key = `${idx}\u0000${search}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const quality = scoreMatch(find, search);
        out.push({ via, search, idx, quality, score: (MATCH_WEIGHTS[via] ?? 500) + quality * 100 });
      }
    }
  }
  out.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return out;
}

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
  const ranked = rankMatches(src, oldS);
  if (!ranked.length) {
    const near = closestRegion(src, oldS);
    const hint = near
      ? ` Closest match is at lines ${near.start}-${near.end}; the ACTUAL text there is:\n${near.text}\nCopy old_string from this text exactly (without the "N: " prefixes), or call edit_file with start_line/end_line to replace that range instead.`
      : ' Use read_file to see the current content, or call edit_file with start_line/end_line.';
    throw new Error('Could not find old_string in the file. It must match exactly, including whitespace and indentation.' + hint);
  }
  const best = ranked[0];
  if (disproportionate(best.search, oldS)) {
    throw new Error('Refusing replacement: the matched span is much larger than old_string. Re-read the file and give the full exact old_string.');
  }
  // the model double-escaped old_string (single line full of "\n") -> it almost certainly did the same to new_string
  if (best.via === 'escapeNormalized' && !oldS.includes('\n') && !newS.includes('\n')) newS = unescapeLiteral(newS);
  if (replaceAll) return { content: restoreEol(src.split(best.search).join(newS), crlf), matched: best.search, via: best.via };
  const tied = ranked.filter((m) => Math.abs(m.score - best.score) < 0.5 && (m.idx !== best.idx || m.search !== best.search));
  if (tied.length) throw new Error('Found multiple matches for old_string. Include more surrounding lines to make it unique, or set replace_all=true.');
  return { content: restoreEol(src.slice(0, best.idx) + newS + src.slice(best.idx + best.search.length), crlf), matched: best.search, via: best.via };
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

/** Edit script between two line arrays: [{ t: ' ' | '-' | '+', text }]. Prefix/suffix trimmed, LCS on the middle (block replace if huge). */
function diffOps(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const ops = [];
  for (let i = 0; i < s; i++) ops.push({ t: ' ', text: a[i] });
  const m = ea - s;
  const n = eb - s;
  if (m * n <= 4e6) {
    const w = n + 1;
    const dp = new Uint32Array((m + 1) * w);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i * w + j] = a[s + i] === b[s + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (a[s + i] === b[s + j]) { ops.push({ t: ' ', text: a[s + i] }); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push({ t: '-', text: a[s + i] }); i++; }
      else { ops.push({ t: '+', text: b[s + j] }); j++; }
    }
    while (i < m) ops.push({ t: '-', text: a[s + i++] });
    while (j < n) ops.push({ t: '+', text: b[s + j++] });
  } else {
    for (let i = 0; i < m; i++) ops.push({ t: '-', text: a[s + i] });
    for (let j = 0; j < n; j++) ops.push({ t: '+', text: b[s + j] });
  }
  for (let i = ea; i < a.length; i++) ops.push({ t: ' ', text: a[i] });
  return ops;
}

/**
 * git-style unified diff: "@@ -a,b +c,d @@" hunks, " " context / "-" removed / "+" added lines, `context` lines around each change.
 * Returns { diff, additions, deletions } (counts are exact even when the text is cut at `maxLines`). diff is '' when nothing changed.
 */
function unifiedDiff(before, after, { context = 3, maxLines = 120 } = {}) {
  const ops = diffOps(splitLines(before), splitLines(after));
  let additions = 0;
  let deletions = 0;
  let ln = 1;                                   // running old / new line numbers
  let rn = 1;
  for (const o of ops) {
    o.a = ln; o.b = rn;
    if (o.t === '+') { additions++; rn++; } else if (o.t === '-') { deletions++; ln++; } else { ln++; rn++; }
  }
  if (!additions && !deletions) return { diff: '', additions: 0, deletions: 0 };
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => { if (o.t !== ' ') for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true; });
  const out = [];
  for (let i = 0; i < ops.length;) {
    if (!keep[i]) { i++; continue; }
    let j = i;
    while (j < ops.length && keep[j]) j++;
    const hunk = ops.slice(i, j);
    const oldN = hunk.filter((o) => o.t !== '+').length;
    const newN = hunk.filter((o) => o.t !== '-').length;
    const oldStart = oldN ? hunk.find((o) => o.t !== '+').a : hunk[0].a - 1;
    const newStart = newN ? hunk.find((o) => o.t !== '-').b : hunk[0].b - 1;
    out.push(`@@ -${oldStart},${oldN} +${newStart},${newN} @@`);
    for (const o of hunk) out.push(o.t + o.text);
    i = j;
  }
  if (out.length > maxLines) {
    const cut = out.length - maxLines;
    out.length = maxLines;
    out.push(`… ${cut} more diff lines (+${additions} −${deletions} in total)`);
  }
  return { diff: out.join('\n'), additions, deletions };
}

/** Compact diff for the model's context (same format, fewer lines). */
function miniDiff(before, after, max = 40) {
  return unifiedDiff(before, after, { context: 2, maxLines: max });
}

module.exports = {
  replace, replaceLines, closestRegion, miniDiff, unifiedDiff,
  fuzzyLineMatch, rankMatches, scoreMatch,
  whitespaceNormalized, indentationFlexible,
};
