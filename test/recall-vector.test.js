'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup } = require('./helpers');

setup();
const recall = require('../lib/recall');
const embed = require('../lib/embed');

// Fake Ollama /api/embed: a tiny bag-of-concepts embedding so "database" and "sql" land close together.
const CONCEPTS = [['database', 'sql', 'postgres'], ['gui', 'pyqt', 'window'], ['deploy', 'docker', 'ci']];
const vec = (t) => CONCEPTS.map((ws) => ws.reduce((n, w) => n + (String(t).toLowerCase().includes(w) ? 1 : 0), 0) + 0.01);
let calls = 0;
function fakeServer(fail = false) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        calls++;
        if (fail) { res.writeHead(500); return res.end('boom'); }
        const { input } = JSON.parse(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ embeddings: input.map(vec) }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
const session = (id, msgs) => ({ id, messages: msgs.map((c) => ({ role: 'user', content: c })) });

test('without embedModel the hybrid search is plain BM25', async () => {
  if (!recall.available()) return;
  recall.configure({ endpoint: 'http://127.0.0.1:9', embedModel: '' });
  recall.indexSession(session('ses_aaaaaa', ['we chose postgres for the storage layer of the project']));
  const hits = await recall.searchHybrid('postgres storage', {});
  assert.equal(hits.length, 1);
  assert.equal(hits[0].via, undefined);
});

test('vectors find related text with no shared keyword; fused hits are labelled', async () => {
  if (!recall.available()) return;
  const srv = await fakeServer();
  const cfg = { endpoint: `http://127.0.0.1:${srv.address().port}`, embedModel: 'fake-embed' };
  recall.configure(cfg);
  recall.indexSession(session('ses_bbbbbb', ['the sql migration for the users table is ready', 'rebuild the pyqt window layout']));
  await recall.pump();
  const st = recall.stats();
  assert.equal(st.semantic.enabled, true);
  assert.equal(st.pending, 0);
  assert.ok(st.embedded >= 2);
  const hits = await recall.searchHybrid('database', { sid: 'ses_bbbbbb', minSim: 0.5 });
  assert.ok(hits.length >= 1);
  assert.match(hits[0].text, /sql migration/);
  assert.equal(hits[0].via, 'vector');
  const both = await recall.searchHybrid('sql migration', { sid: 'ses_bbbbbb' });
  assert.equal(both[0].via, 'both');
  srv.closeAllConnections(); srv.close();
});

test('an unreachable embedding server degrades to keyword search and backs off', async () => {
  if (!recall.available()) return;
  const srv = await fakeServer(true);
  recall.configure({ endpoint: `http://127.0.0.1:${srv.address().port}`, embedModel: 'other-embed' });
  embed.resetBackoff();
  recall.indexSession(session('ses_cccccc', ['docker compose deploy notes for the staging server']));
  const hits = await recall.searchHybrid('docker deploy', { sid: 'ses_cccccc' });
  assert.equal(hits.length, 1);
  const before = calls;
  await recall.searchHybrid('docker deploy', {});
  assert.equal(calls, before, 'no new request while backing off');
  assert.equal(embed.status({ endpoint: 'x', embedModel: 'o' }).backingOff, true);
  srv.closeAllConnections(); srv.close();
});

test('forgetSession removes vectors too', async () => {
  if (!recall.available()) return;
  recall.forgetSession('ses_bbbbbb');
  const hits = await recall.searchHybrid('sql migration', { sid: 'ses_bbbbbb' });
  assert.equal(hits.length, 0);
});
