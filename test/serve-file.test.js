'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { serveFile, parseRange, etagOf, dispositionOf, isBuildPath, downloadBlockedReason } = require('../lib/serve-file');

test('parseRange: open end, closed, suffix, clamped, invalid, ignored', () => {
  assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange('bytes=-30', 100), { start: 70, end: 99 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), 'invalid');
  assert.equal(parseRange('bytes=50-10', 100), 'invalid');
  assert.equal(parseRange('bytes=-0', 100), 'invalid');
  assert.equal(parseRange('bytes=0-1,5-9', 100), null);   // multi-range: ignored, whole file is sent
  assert.equal(parseRange('items=0-1', 100), null);
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange('bytes=0-', 0), null);          // empty file
});

test('dispositionOf survives non-ASCII names and quotes', () => {
  const d = dispositionOf('ফাইল "x".apk');
  assert.ok(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''/.test(d), d);
  assert.ok(!d.split(';')[1].includes('"x"'));
  assert.ok(d.includes(encodeURIComponent('ফাইল')));
});

test('build-output guard: only while a process runs, and for freshly written files', () => {
  assert.ok(isBuildPath('app/build/outputs/apk/debug/x.apk'));
  assert.ok(isBuildPath('build'));
  assert.ok(isBuildPath('dist/app.js'));
  assert.ok(!isBuildPath('src/main/Builder.kt'));
  assert.ok(!isBuildPath('rebuild/notes.txt'));
  const old = { isDirectory: () => false, mtimeMs: Date.now() - 60000 };
  const fresh = { isDirectory: () => false, mtimeMs: Date.now() - 500 };
  assert.equal(downloadBlockedReason('app/build/x.apk', old, false), null);        // nothing running: fine
  assert.match(downloadBlockedReason('app/build/x.apk', old, true), /still running/);
  assert.equal(downloadBlockedReason('src/a.kt', old, true), null);                // a dev server must not block source downloads
  assert.match(downloadBlockedReason('src/a.kt', fresh, false), /modified a moment ago/);
});

function withServer(file, fn) {
  const srv = http.createServer((req, res) => {
    const st = fs.statSync(file);
    serveFile(req, res, file, st, { filename: path.basename(file) });
  });
  return new Promise((resolve, reject) => srv.listen(0, '127.0.0.1', async () => {
    try { resolve(await fn(`http://127.0.0.1:${srv.address().port}/`)); } catch (e) { reject(e); } finally { srv.close(); }
  }));
}

test('serveFile: Content-Length, Accept-Ranges, 206 resume, 416, If-Range, HEAD', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-'));
  const file = path.join(dir, 'big.apk');
  const data = Buffer.alloc(300000);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  fs.writeFileSync(file, data);
  const etag = etagOf(fs.statSync(file));

  await withServer(file, async (url) => {
    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-length'), String(data.length));   // the browser can show the total size
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('etag'), etag);
    assert.ok(Buffer.from(await full.arrayBuffer()).equals(data));

    // "resume": the browser asks for the rest after having 100000 bytes
    const rest = await fetch(url, { headers: { Range: 'bytes=100000-', 'If-Range': etag } });
    assert.equal(rest.status, 206);
    assert.equal(rest.headers.get('content-range'), `bytes 100000-${data.length - 1}/${data.length}`);
    assert.equal(rest.headers.get('content-length'), String(data.length - 100000));
    assert.ok(Buffer.from(await rest.arrayBuffer()).equals(data.subarray(100000)));

    const mid = await fetch(url, { headers: { Range: 'bytes=10-19' } });
    assert.equal(mid.status, 206);
    assert.ok(Buffer.from(await mid.arrayBuffer()).equals(data.subarray(10, 20)));

    const suffix = await fetch(url, { headers: { Range: 'bytes=-5' } });
    assert.ok(Buffer.from(await suffix.arrayBuffer()).equals(data.subarray(data.length - 5)));

    // the file changed since the partial download started: If-Range mismatch -> the WHOLE new file, never glued bytes
    const changed = await fetch(url, { headers: { Range: 'bytes=100000-', 'If-Range': '"stale"' } });
    assert.equal(changed.status, 200);
    assert.equal(changed.headers.get('content-length'), String(data.length));
    await changed.arrayBuffer();

    const bad = await fetch(url, { headers: { Range: `bytes=${data.length + 10}-` } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get('content-range'), `bytes */${data.length}`);

    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(data.length));
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('serveFile: empty file and non-ASCII file name do not throw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-'));
  const file = path.join(dir, 'খালি.txt');
  fs.writeFileSync(file, '');
  await withServer(file, async (url) => {
    const r = await fetch(url);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length'), '0');
    assert.ok(r.headers.get('content-disposition').includes("filename*=UTF-8''"));
    await r.arrayBuffer();
  });
  fs.rmSync(dir, { recursive: true, force: true });
});
