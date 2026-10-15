'use strict';

/**
 * Chat attachments of ANY type.
 *
 * Files are uploaded to ~/.studio/<project>/uploads/ (so the agent can also open them with its tools), then at send time each file is
 * turned into something the chosen model can use, with graceful fallbacks when the model can't read that kind of file:
 *
 *   image     vision-capable model → sent as an image
 *             else config.visionModel → that model describes it, the text is passed on
 *             else `tesseract` on PATH → OCR text
 *             else → size/dimensions + file path only (and a note)
 *   text/code → inlined (capped; the rest stays readable through the file path)
 *   PDF       → `pdftotext` if installed, else a built-in best-effort extractor
 *   docx/xlsx/pptx/odt/ods/odp → text pulled out of the zip's XML (built in)
 *   zip       → listing of the archive
 *   audio/video/other binary → metadata + path (nothing the model could read), with a hint
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const cfg = require('./config');
const llm = require('./llm');

const uploadsDir = () => path.join(cfg.studioDir(), 'uploads');
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const relPath = (id) => path.join('.studio', 'uploads', id).split(path.sep).join('/');

/* ---------- storing ---------- */

const safeName = (name) => String(name || 'file').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 80) || 'file';   // stored id is ASCII; the original name is kept as metadata

/** Stream an upload to disk; returns its metadata. `limitBytes` aborts oversized uploads. */
async function store(req, name, limitBytes) {
  await fsp.mkdir(uploadsDir(), { recursive: true });
  const id = crypto.randomBytes(4).toString('hex') + '-' + safeName(name);
  const file = path.join(uploadsDir(), id);
  let size = 0;
  const out = fs.createWriteStream(file);
  try {
    await new Promise((resolve, reject) => {
      req.on('data', (c) => {
        size += c.length;
        if (size > limitBytes) { reject(new Error(`file is larger than the ${Math.round(limitBytes / 1048576)} MB upload limit`)); req.destroy(); return; }
        if (!out.write(c)) { req.pause(); out.once('drain', () => req.resume()); }
      });
      req.on('end', resolve);
      req.on('error', reject);
      out.on('error', reject);
    });
    await new Promise((r) => out.end(r));
  } catch (e) { out.destroy(); await fsp.rm(file, { force: true }); throw e; }
  return { id, name: String(name || id), size, path: relPath(id) };
}

const fileOf = (id) => {
  if (!ID_RE.test(String(id))) throw new Error('invalid attachment id');
  return path.join(uploadsDir(), id);
};

/* ---------- classification ---------- */

const TEXT_EXT = new Set(('txt md markdown rst log csv tsv json jsonl ndjson xml html htm css scss less js mjs cjs jsx ts tsx py rb go rs java kt kts c h cc cpp hpp cs php swift m sh bash zsh fish ps1 bat cmd ' +
  'sql yml yaml toml ini cfg conf env properties gradle lock tex bib srt vtt diff patch dockerfile makefile mk cmake vue svelte astro lua pl r jl dart ex exs erl hs clj scala tf hcl proto graphql gql ipynb svg').split(' '));
const IMG_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', avif: 'image/avif' };
const OFFICE_EXT = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus', 'amr']);
const VIDEO_EXT = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', '3gp']);
const NATIVE_IMG = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const extOf = (name) => (String(name).match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase();

function looksLikeText(buf) {
  if (!buf.length) return true;
  const sample = buf.subarray(0, 8192);
  if (sample.includes(0)) return false;
  const s = sample.toString('utf8');
  const bad = (s.match(/\uFFFD/g) || []).length;
  return bad / Math.max(1, s.length) < 0.02;
}

function classify(name, head) {
  const ext = extOf(name);
  if (IMG_EXT[ext]) return { kind: 'image', mime: IMG_EXT[ext] };
  if (ext === 'pdf') return { kind: 'pdf', mime: 'application/pdf' };
  if (OFFICE_EXT.has(ext)) return { kind: 'office', mime: 'application/vnd.' + ext };
  if (['zip', 'jar', 'apk', 'epub'].includes(ext)) return { kind: 'zip', mime: 'application/zip' };
  if (AUDIO_EXT.has(ext)) return { kind: 'audio', mime: 'audio/' + ext };
  if (VIDEO_EXT.has(ext)) return { kind: 'video', mime: 'video/' + ext };
  if (TEXT_EXT.has(ext) || /^(readme|license|makefile|dockerfile|gemfile|procfile)$/i.test(name)) return { kind: 'text', mime: 'text/plain' };
  if (head && head.subarray(0, 4).toString('latin1') === '%PDF') return { kind: 'pdf', mime: 'application/pdf' };
  if (head && looksLikeText(head)) return { kind: 'text', mime: 'text/plain' };
  return { kind: 'binary', mime: 'application/octet-stream' };
}

/* ---------- ZIP reader (docx/xlsx/pptx/odt…), no dependencies ---------- */

function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    out.push({ name: buf.toString('utf8', p + 46, p + 46 + nlen), method, csize, usize, off });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

function zipRead(buf, e) {
  const nlen = buf.readUInt16LE(e.off + 26);
  const elen = buf.readUInt16LE(e.off + 28);
  const data = buf.subarray(e.off + 30 + nlen + elen, e.off + 30 + nlen + elen + e.csize);
  return e.method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: 1024 * 1024 * 1024 });
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const stripTags = (s) => unxml(s.replace(/<[^>]+>/g, ''));

function officeText(buf, ext) {
  const entries = zipEntries(buf);
  const get = (n) => { const e = entries.find((x) => x.name === n); return e ? zipRead(buf, e).toString('utf8') : ''; };
  if (ext === 'docx') {
    return stripTags(get('word/document.xml').replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n')).replace(/\n{3,}/g, '\n\n').trim();
  }
  if (ext === 'pptx') {
    const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).sort((a, b) => parseInt(a.name.match(/\d+/)[0], 10) - parseInt(b.name.match(/\d+/)[0], 10));
    return slides.map((e, i) => `--- slide ${i + 1} ---\n` + stripTags(zipRead(buf, e).toString('utf8').replace(/<\/a:p>/g, '\n'))).join('\n\n').trim();
  }
  if (ext === 'xlsx') {
    const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => stripTags(m[1]));
    const names = [...get('xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => unxml(m[1]));
    const sheets = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).sort((a, b) => parseInt(a.name.match(/\d+/)[0], 10) - parseInt(b.name.match(/\d+/)[0], 10));
    return sheets.map((e, i) => {
      const rows = [...zipRead(buf, e).toString('utf8').matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
        [...r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
          const v = (c[2] || '').match(/<v>([\s\S]*?)<\/v>/);
          const t = (c[2] || '').match(/<t[^>]*>([\s\S]*?)<\/t>/);
          if (/t="s"/.test(c[1]) && v) return shared[+v[1]] || '';
          return v ? unxml(v[1]) : t ? unxml(t[1]) : '';
        }).join('\t'));
      return `--- sheet: ${names[i] || i + 1} ---\n` + rows.join('\n');
    }).join('\n\n').trim();
  }
  // OpenDocument
  return stripTags(get('content.xml').replace(/<\/text:p>|<\/text:h>|<\/table:table-row>/g, '\n').replace(/<\/table:table-cell>/g, '\t')).replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------- PDF: pdftotext if present, else a best-effort extractor ---------- */

function pdfText(file, buf) {
  try {
    const r = spawnSync('pdftotext', ['-layout', '-q', file, '-'], { encoding: 'utf8', timeout: 180000, maxBuffer: 300 * 1024 * 1024 });
    if (r.status === 0 && r.stdout && r.stdout.trim().length > 20) return { text: r.stdout.trim(), how: 'pdftotext' };
  } catch { /* not installed */ }
  const parts = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const latin = buf.toString('latin1');
  let m;
  while ((m = re.exec(latin))) {
    let data = Buffer.from(m[1], 'latin1');
    try { data = zlib.inflateSync(data, { maxOutputLength: 300 * 1024 * 1024 }); } catch { /* maybe not compressed */ }
    const s = data.toString('latin1');
    if (!/\bBT\b/.test(s)) continue;
    for (const t of s.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) {
      const src = t[1] !== undefined ? [...t[1].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map((x) => x[1]).join('') : t[2];
      parts.push(src.replace(/\\([nrtbf()\\])/g, (x, c) => ({ n: '\n', r: '', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' }[c])).replace(/\\(\d{1,3})/g, (x, o) => String.fromCharCode(parseInt(o, 8))));
    }
    parts.push('\n');
  }
  const text = parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: /[\p{L}\p{N}]{3}/u.test(text) ? text : '', how: 'built-in extractor' };
}

/* ---------- images ---------- */

function imageSize(buf) {
  try {
    if (buf.subarray(1, 4).toString() === 'PNG') return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    if (buf.subarray(0, 3).toString() === 'GIF') return [buf.readUInt16LE(6), buf.readUInt16LE(8)];
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let p = 2;
      while (p < buf.length) {
        if (buf[p] !== 0xff) { p++; continue; }
        const mk = buf[p + 1];
        if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return [buf.readUInt16BE(p + 7), buf.readUInt16BE(p + 5)];
        p += 2 + buf.readUInt16BE(p + 2);
      }
    }
    if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP' && buf.subarray(12, 16).toString() === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  } catch { /* ignore */ }
  return null;
}

function ocr(file) {
  try {
    const have = spawnSync('tesseract', ['--list-langs'], { encoding: 'utf8', timeout: 10000 });
    if (have.status !== 0) return '';
    const langs = ['eng', 'ben'].filter((l) => have.stdout.split(/\s+/).includes(l));
    const r = spawnSync('tesseract', [file, 'stdout', ...(langs.length ? ['-l', langs.join('+')] : [])], { encoding: 'utf8', timeout: 180000, maxBuffer: 50 * 1024 * 1024 });
    return r.status === 0 ? r.stdout.trim() : '';
  } catch { return ''; }
}

async function describeWithVisionModel(config, ref, buf, signal) {
  const { provider, model } = llm.resolve(config, ref);
  const res = await llm.chatStream({
    provider, model, signal, timeoutMs: config.requestTimeoutMs,
    options: { temperature: 0.1, num_predict: 700 },
    messages: [{ role: 'user', content: 'Describe this image in detail for someone who cannot see it. Transcribe any visible text exactly (keep its language). Mention charts, tables, code or UI elements precisely.', images: [buf.toString('base64')] }],
  });
  return res.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

/** base64 images for the most recent user messages that carry natively-visible images (re-read from disk each request). */
async function nativeImages(messages, max = 4) {
  const out = new Map();
  let left = max;
  for (let i = messages.length - 1; i >= 0 && left > 0; i--) {
    const m = messages[i];
    if (m.role !== 'user' || !m.attachments) continue;
    const imgs = [];
    for (const a of m.attachments) {
      if (a.mode !== 'image' || left <= 0) continue;
      try { imgs.push((await fsp.readFile(fileOf(a.id))).toString('base64')); left--; } catch { /* file removed */ }
    }
    if (imgs.length) out.set(i, imgs);
  }
  return out;
}

/* ---------- main entry ---------- */

const human = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
const esc = (s) => String(s).replace(/"/g, '&quot;');

/**
 * Build the text blocks for a user message from uploaded files.
 * Returns { blocks, attachments } — `attachments` is the metadata stored on the message (and shown in the UI).
 */
async function prepare({ items, config, model, signal, emit = () => {} }) {
  const { provider, model: modelName } = llm.resolve(config, model);
  let sees = null;                                    // does the chosen model accept images? (lazy)
  const canSee = async () => { if (sees === null) sees = await llm.supportsVision(config, provider, modelName); return sees; };
  const ctxChars = Math.floor((await llm.contextWindow(config, provider, modelName)) * 3.5);
  let budget = Number(config.attachInlineChars) || Math.min(2000000, Math.floor(ctxChars * 0.5));   // total inline text for this message
  const blocks = [];
  const attachments = [];

  for (const it of items) {
    const file = fileOf(it.id);
    const st = await fsp.stat(file);
    const name = String(it.name || it.id);
    const head = Buffer.alloc(Math.min(st.size, 16384));
    const fh = await fsp.open(file, 'r');
    try { await fh.read(head, 0, head.length, 0); } finally { await fh.close(); }
    const { kind, mime } = classify(name, head);
    const meta = { id: it.id, name, mime, size: st.size, kind, mode: 'path', path: relPath(it.id), note: '' };
    const tag = (attrs, body) => `<attachment name="${esc(name)}" type="${mime}" size="${human(st.size)}" path="${meta.path}" fullpath="${esc(file)}"${attrs}>\n${body}\n</attachment>`;
    const inline = (text, attrs, how) => {
      const take = Math.max(2000, Math.min(text.length, Math.floor(budget / Math.max(1, items.length))));
      const cut = text.length > take;
      budget = Math.max(0, budget - Math.min(text.length, take));
      meta.mode = how;
      if (cut) meta.note = `first ${take.toLocaleString()} of ${text.length.toLocaleString()} characters were included`;
      blocks.push(tag(attrs, text.slice(0, take) + (cut ? `\n[… truncated: ${(text.length - take).toLocaleString()} more characters. Read the rest from the file at ${meta.path} with read_file or shell tools]` : '')));
    };

    try {
      if (kind === 'image') {
        const buf = await fsp.readFile(file);
        const dims = imageSize(buf);
        const info = `${dims ? dims.join('×') + ' px, ' : ''}${human(st.size)}`;
        if (NATIVE_IMG.has(mime) && await canSee()) {
          meta.mode = 'image';
          blocks.push(tag(' mode="image"', `[image ${info} — provided to you as an image in this message]`));
        } else {
          let done = false;
          if (config.visionModel && NATIVE_IMG.has(mime)) {
            emit({ type: 'info', text: `🖼 ${name}: your model can't see images — asking ${config.visionModel} to describe it…` });
            try {
              const d = await describeWithVisionModel(config, config.visionModel, buf, signal);
              if (d) { meta.mode = 'described'; meta.note = `described by ${config.visionModel}`; blocks.push(tag(' mode="described"', `[You cannot view images. Description produced by a vision model (${config.visionModel}):]\n${d}`)); done = true; }
            } catch (e) { meta.note = `vision model failed: ${e.message}`; }
          }
          if (!done) {
            emit({ type: 'info', text: `🖼 ${name}: trying OCR…` });
            const t = ocr(file);
            if (t) { meta.mode = 'ocr'; meta.note = 'text read with OCR (the model cannot see images)'; blocks.push(tag(' mode="ocr"', `[You cannot view images. Text recognised in the image by OCR:]\n${t.slice(0, 200000)}`)); done = true; }
          }
          if (!done) {
            meta.mode = 'path'; meta.note = (meta.note ? meta.note + '; ' : '') + "model can't view images — only the file path was passed";
            blocks.push(tag(' mode="path"', `[Image ${info}. You cannot view images; no vision model is configured ("visionModel" in config.json) and OCR found no text (or tesseract is not installed), so its content is unknown. Tell the user this if they ask about the picture's content.]`));
          }
        }
      } else if (kind === 'text') {
        const text = (await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '');
        inline(text, '', 'text');
      } else if (kind === 'pdf') {
        const { text, how } = pdfText(file, await fsp.readFile(file));
        if (text) { meta.note = `text extracted with ${how}`; inline(text, ' mode="extracted"', 'extracted'); }
        else { meta.note = 'no extractable text (scanned PDF?) — only the file path was passed'; blocks.push(tag(' mode="path"', '[PDF without a text layer (probably scanned). Its content could not be read. If `pdftoppm`/`tesseract` exist, you can OCR it with shell tools.]')); }
      } else if (kind === 'office') {
        const text = officeText(await fsp.readFile(file), extOf(name));
        if (text) { meta.note = 'text extracted from the document'; inline(text, ' mode="extracted"', 'extracted'); }
        else blocks.push(tag(' mode="path"', '[Document contains no extractable text.]'));
      } else if (kind === 'zip') {
        const list = zipEntries(await fsp.readFile(file)).slice(0, 5000).map((e) => `${e.name}  (${human(e.usize)})`).join('\n');
        meta.mode = 'listing'; meta.note = 'archive contents listed';
        blocks.push(tag(' mode="listing"', `[Archive — first entries:]\n${list}\n[Extract it with shell tools (unzip) if you need the files.]`));
      } else {
        meta.mode = 'path'; meta.note = `${kind} files can't be read by the model — only the file path was passed`;
        blocks.push(tag(' mode="path"', `[${kind === 'audio' ? 'Audio' : kind === 'video' ? 'Video' : 'Binary'} file (${human(st.size)}). The model cannot read its content directly. Use shell tools on the fullpath if available (e.g. ffmpeg, whisper, strings), otherwise tell the user it cannot be read.]`));
      }
    } catch (e) {
      meta.mode = 'path'; meta.note = `could not read: ${e.message}`;
      blocks.push(tag(' mode="path"', `[Could not process this file: ${e.message}]`));
    }
    attachments.push(meta);
  }
  return { blocks: blocks.join('\n\n'), attachments };
}

module.exports = { uploadsDir, store, fileOf, classify, prepare, nativeImages, ID_RE, extOf };
