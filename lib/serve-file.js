'use strict';

// File downloads that behave like a real file server:
//  - Content-Length  -> the browser can show "142 MB of 142 MB" instead of "142 MB / ?"
//  - Accept-Ranges + 206 Partial Content -> Pause/Resume and "continue after the connection dropped" work
//  - ETag / Last-Modified + If-Range -> a resume never glues bytes of a NEW file onto an old partial download
//  - streamed from disk (never read into memory; a 150 MB APK used to be buffered whole)

const fs = require('node:fs');
const { pipeline } = require('node:stream');

/**
 * Parse a single `Range: bytes=...` header.
 * @returns {{start:number,end:number}|null|'invalid'}  null = no (usable) range -> send the whole file;
 *          'invalid' = unsatisfiable -> 416
 */
function parseRange(header, size) {
  if (!header || size <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;                       // multi-range or garbage: ignoring it is allowed (we just send everything)
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start;
  let end;
  if (a === '') {                            // suffix: the last N bytes
    const n = Number(b);
    if (!n) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) return 'invalid';
  return { start, end };
}

/** Strong validator: changes whenever the size or the modification time changes. */
const etagOf = (st) => `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;

/** Content-Disposition that survives non-ASCII file names (a raw "ফাইল.apk" in a header makes Node throw). */
function dispositionOf(name) {
  const clean = String(name || 'download').replace(/[\r\n"\\]/g, '');
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

/** If-Range: only honour the Range when the validator still matches the file on disk. */
function ifRangeOk(req, st, etag) {
  const v = req.headers['if-range'];
  if (!v) return true;
  if (v.startsWith('"') || v.startsWith('W/')) return v === etag;
  const t = Date.parse(v);
  return Number.isFinite(t) && Math.floor(st.mtimeMs / 1000) * 1000 <= t;
}

/**
 * Serve one regular file. `st` is the fs.Stats the caller already took (so the guards and the headers agree).
 * Resolves after the headers are written; the body streams on its own.
 */
function serveFile(req, res, full, st, { filename, contentType = 'application/octet-stream' } = {}) {
  const size = st.size;
  const etag = etagOf(st);
  const headers = {
    'Content-Type': contentType,
    'Content-Disposition': dispositionOf(filename),
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': new Date(st.mtimeMs).toUTCString(),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Encoding': 'identity',          // never let a proxy/middleware gzip an APK: the length would no longer match
  };

  let range = req.headers.range && ifRangeOk(req, st, etag) ? parseRange(req.headers.range, size) : null;
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
    res.end();
    return { status: 416 };
  }
  const status = range ? 206 : 200;
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  headers['Content-Length'] = length;
  res.writeHead(status, headers);

  if (req.method === 'HEAD' || length === 0) { res.end(); return { status, length }; }

  const stream = fs.createReadStream(full, { start, end });
  pipeline(stream, res, () => { /* client went away or the file changed mid-way: the connection is closed, the browser resumes */ });
  return { status, length };
}

/** Build/output folders: while a background process runs, these are (probably) still being written. */
const BUILD_PATH = /(^|[\\/])(build|dist|out|target|outputs|\.gradle|\.next)([\\/]|$)/i;
const isBuildPath = (rel) => BUILD_PATH.test(String(rel || ''));

/**
 * Should this download wait? `busy` = a background process is running.
 * @returns {string|null} the reason, or null when the download is fine
 */
function downloadBlockedReason(rel, st, busy, now = Date.now()) {
  if (busy && isBuildPath(rel)) return 'A background process (build/install) is still running, and this file is in its output folder. Wait until it finishes, otherwise the download can be incomplete or corrupt.';
  if (st && !st.isDirectory() && now - st.mtimeMs < 3000) return 'This file was modified a moment ago and may still be written. Try again in a few seconds.';
  return null;
}

module.exports = { serveFile, parseRange, etagOf, dispositionOf, isBuildPath, downloadBlockedReason };
