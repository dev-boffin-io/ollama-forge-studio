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

const REPLACERS = [simple, lineTrimmed, blockAnchor, whitespaceNormalized, indentationFlexible, trimmedBoundary, lineNumberStripped];

function disproportionate(search, old) {
  const oldLines = old.split('\n').length;
  const sLines = search.split('\n').length;
  if (sLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
  if (oldLines === 1) return false;
  return search.trim().length > Math.max(old.trim().length + 500, old.trim().length * 4);
}

/** Returns { content, matched } or throws a model-friendly error. */
function replace(content, oldString, newString, replaceAll = false) {
  if (oldString === newString) throw new Error('No changes to apply: old_string and new_string are identical.');
  if (oldString === '') throw new Error('old_string cannot be empty. Provide the exact text to replace, or use write_file for a full overwrite.');
  let notFound = true;
  for (const replacer of REPLACERS) {
    for (const search of replacer(content, oldString)) {
      const idx = content.indexOf(search);
      if (idx === -1) continue;
      notFound = false;
      if (disproportionate(search, oldString)) {
        throw new Error('Refusing replacement: the matched span is much larger than old_string. Re-read the file and give the full exact old_string.');
      }
      if (replaceAll) return { content: content.split(search).join(newString), matched: search };
      if (idx !== content.lastIndexOf(search)) continue; // ambiguous for this matcher; try a stricter-context one
      return { content: content.slice(0, idx) + newString + content.slice(idx + search.length), matched: search };
    }
  }
  if (notFound) throw new Error('Could not find old_string in the file. It must match exactly, including whitespace and indentation. Use read_file to see the current content.');
  throw new Error('Found multiple matches for old_string. Include more surrounding lines to make it unique, or set replace_all=true.');
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

module.exports = { replace, miniDiff };
