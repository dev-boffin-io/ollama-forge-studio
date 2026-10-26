'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  config: {}, model: '', workDir: '',
  sessions: [], sessionId: null, agents: [],
  activeFile: null, streaming: false, abortController: null,
  messages: [], pending: [],
};

/* ---------- helpers ---------- */

function setStatus(text, cls = '') {
  const el = $('connStatus');
  el.className = 'status' + (cls ? ' ' + cls : '');
  el.textContent = '';
  const label = document.createElement('span');
  label.className = 'status-text';
  label.textContent = text;
  el.appendChild(label);
  // a small inline wave while the agent is working (generating / retrying / connecting)
  if (cls === 'busy' && !/^ready\b/.test(text)) {
    const wave = document.createElement('span');
    wave.className = 'wave';
    wave.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i++) wave.appendChild(document.createElement('i'));
    el.appendChild(wave);
  }
}

/** Persistent "ctx 34% · 12.3 tok/s" badge (stays visible after the status text changes to "done"). */
function showMetrics({ ctx, used, tps }) {
  const el = $('metricsBadge');
  const parts = [];
  let cls = 'status metrics';
  if (ctx > 0 && used >= 0) {
    const pct = Math.min(999, Math.round((used / ctx) * 100));
    parts.push(`ctx ${pct}%`);
    if (pct >= 90) cls += ' crit'; else if (pct >= 70) cls += ' warn';
    el.title = `Context: ${used.toLocaleString()} / ${ctx.toLocaleString()} tokens` + (tps ? ` · ${tps.toFixed(1)} tok/s` : '');
  }
  if (tps > 0) parts.push(`${tps.toFixed(1)} tok/s`);
  el.hidden = !parts.length;
  el.className = cls;
  el.textContent = parts.join(' · ');
}

/**
 * fetch + JSON with a timeout, readable errors, and one automatic retry for GETs on a network hiccup
 * (first contact after the server/tunnel was idle often fails once).
 */
async function api(path, options = {}) {
  const { timeoutMs = 60000, retry = (options.method || 'GET') === 'GET', ...rest } = options;
  let lastErr;
  for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, signal: ac.signal, ...rest });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!res.ok) {
        const err = new Error(data.error || (res.status >= 502 ? `the studio server is not answering (HTTP ${res.status})` : `HTTP ${res.status}`));
        err.status = res.status;
        if (res.status < 500) throw err;                      // 4xx: retrying will not help
        lastErr = err;
      } else return data;
    } catch (err) {
      if (err.status && err.status < 500) throw err;
      lastErr = err.name === 'AbortError' ? new Error(`the server did not answer within ${Math.round(timeoutMs / 1000)}s`) : err.status ? err : new Error('cannot reach the studio server — is it still running?');
    } finally { clearTimeout(timer); }
    if (attempt === 0 && retry) await new Promise((r) => setTimeout(r, 700));
  }
  throw lastErr;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const truncate = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
let bulkRender = false;      // while a whole session is drawn, skip per-message scrolling (each scroll forces a layout)
const scrollChat = () => { if (!bulkRender) $('messages').scrollTop = $('messages').scrollHeight; };

function ago(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  return Math.round(s / 86400) + 'd';
}

/* ---------- config, models, agents ---------- */

async function loadConfig() {
  state.config = await api('/api/config');
  $('endpoint').value = state.config.endpoint || '';
  state.model = state.config.model || '';
}

function openSettings() {
  const dlg = $('settingsDlg');
  if (!dlg) return;
  const c = state.config || {};
  $('sThinking').value = String(c.thinking === true);
  $('sTemperature').value = c.temperature == null ? '' : c.temperature;
  $('sNumCtx').value = c.numCtx == null ? '' : c.numCtx;
  $('sMaxIterations').value = c.maxIterations == null ? '' : c.maxIterations;
  $('sRequestTimeoutMs').value = c.requestTimeoutMs == null ? '' : c.requestTimeoutMs;
  $('sSystemPrompt').value = c.systemPrompt || '';
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
}

async function resetSettings() {
  const dlg = $('settingsDlg');
  if (!confirm('Reset agent/runtime settings to defaults?')) return;
  try {
    const def = await api('/api/defaults');
    $('sThinking').value = String(def.thinking === true);
    $('sTemperature').value = def.temperature == null ? '' : def.temperature;
    $('sNumCtx').value = def.numCtx == null ? '' : def.numCtx;
    $('sMaxIterations').value = def.maxIterations == null ? '' : def.maxIterations;
    $('sRequestTimeoutMs').value = def.requestTimeoutMs == null ? '' : def.requestTimeoutMs;
    $('sSystemPrompt').value = def.systemPrompt || '';
    const patch = {
      thinking: def.thinking,
      temperature: def.temperature,
      numCtx: def.numCtx,
      maxIterations: def.maxIterations,
      requestTimeoutMs: def.requestTimeoutMs,
      systemPrompt: def.systemPrompt,
    };
    state.config = await api('/api/config', { method: 'PUT', body: JSON.stringify(patch) });
    state.model = state.config.model;
    if (dlg && dlg.open) dlg.close();
    setStatus('reset to defaults', 'ok');
  } catch (e) { setStatus(e.message, 'err'); }
}

async function saveSettings() {
  const patch = {
    thinking: $('sThinking').value === 'true',
    temperature: $('sTemperature').value === '' ? undefined : Number($('sTemperature').value),
    numCtx: $('sNumCtx').value === '' ? 0 : Number($('sNumCtx').value),
    maxIterations: $('sMaxIterations').value === '' ? undefined : Number($('sMaxIterations').value),
    requestTimeoutMs: $('sRequestTimeoutMs').value === '' ? undefined : Number($('sRequestTimeoutMs').value),
    systemPrompt: $('sSystemPrompt').value,
  };
  state.config = await api('/api/config', { method: 'PUT', body: JSON.stringify(patch) });
  state.model = state.config.model;
  $('settingsDlg').close();
  setStatus('saved', 'ok');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let modelRetryTimer = null;

/**
 * Fill the model list. The first contact with a fresh tunnel / sleeping server often fails once, so this tries a few times
 * (showing progress), and if nothing answers it keeps retrying quietly in the background instead of leaving the page dead.
 */
async function loadModels({ autoRetry = true } = {}) {
  clearTimeout(modelRetryTimer);
  const select = $('model');
  let models = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3 && !models; attempt++) {
    setStatus(attempt === 1 ? 'connecting…' : `connecting… (try ${attempt}/3)`, 'busy');
    try { models = (await api('/api/models', { timeoutMs: 45000, retry: false })).models || []; } catch (err) { lastErr = err; if (attempt < 3) await sleep(1200 * attempt); }
  }
  if (!models) {
    setStatus('cannot connect', 'err');
    select.innerHTML = `<option value="">⚠ ${escapeHtml(lastErr ? lastErr.message : 'no answer')} (retrying…)</option>`;
    if (autoRetry) modelRetryTimer = setTimeout(() => loadModels({ autoRetry: true }), 10000);
    return false;
  }
  select.innerHTML = '';
  const groups = new Map();
  for (const m of models) {
    if (!groups.has(m.provider)) { const g = document.createElement('optgroup'); g.label = m.provider + (m.providerType === 'openai' ? ' (OpenAI-compatible)' : m.providerType === 'anthropic' ? ' (Anthropic)' : ' (Ollama)'); groups.set(m.provider, g); }
    const o = document.createElement('option');
    if (m.error) { o.textContent = '⚠ ' + m.error.slice(0, 80); o.title = m.error; o.disabled = true; } else { o.value = m.ref; o.textContent = m.name + (m.parameter_size ? `  (${m.parameter_size})` : ''); }
    groups.get(m.provider).appendChild(o);
  }
  [...groups.values()].sort((a, b) => a.label.localeCompare(b.label)).forEach((g) => select.appendChild(g));
  const refs = models.filter((m) => m.ref).map((m) => m.ref);
  const want = refs.includes(state.model) ? state.model : refs.includes('default/' + state.model) ? 'default/' + state.model : refs[0];
  if (want) { select.value = want; state.model = want; }
  const stale = models.find((m) => m.stale);
  const failed = models.filter((m) => m.error);
  if (!refs.length) {
    setStatus('no models', 'err');
    if (autoRetry && failed.length) modelRetryTimer = setTimeout(() => loadModels({ autoRetry: true }), 10000);   // e.g. the tunnel is still starting
  } else if (stale) { setStatus('ready (cached list)', 'busy'); $('connStatus').title = 'The server did not answer; showing the last known models. ' + stale.stale; }
  else { setStatus('ready', 'ok'); $('connStatus').title = failed.length ? failed.map((f) => `${f.provider}: ${f.error}`).join('\n') : ''; }
  return true;
}

async function saveConfig() {
  const patch = { endpoint: $('endpoint').value.trim(), model: $('model').value, agent: $('agent').value };
  state.config = await api('/api/config', { method: 'PUT', body: JSON.stringify(patch) });
  state.model = state.config.model;
  setStatus('saved', 'ok');
}

function fillAgents(list, selected) {
  state.agents = list;
  const sel = $('agent');
  sel.innerHTML = '';
  for (const a of list) {
    const o = document.createElement('option');
    o.value = a.name;
    o.textContent = a.name;
    o.title = a.description;
    sel.appendChild(o);
  }
  if (selected && list.some((a) => a.name === selected)) sel.value = selected;
}

/* ---------- sessions ---------- */

async function loadSessions() {
  const { sessions } = await api('/api/sessions');
  state.sessions = sessions;
  const list = $('sessionList');
  list.innerHTML = '';
  if (!sessions.length) {
    list.innerHTML = '<li class="hint" style="cursor:default">No sessions in this directory yet.<br>Send a message to start one.</li>';
    return;
  }
  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = s.id === state.sessionId ? 'active' : '';
    li.innerHTML =
      `<div class="top"><span class="title">${escapeHtml(s.title)}</span><span class="del" title="Delete">✕</span></div>` +
      `<div class="meta"><span class="agent-badge ${escapeHtml(s.agent)}">${escapeHtml(s.agent)}</span><span>${s.running ? '<b style="color:var(--amber)">● running</b>' : ago(s.updatedAt) + ' ago'}</span><span>${s.messageCount} msgs</span></div>`;
    li.addEventListener('click', () => { closePanels(); openSession(s.id); });
    li.querySelector('.del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete session "${s.title}"?`)) return;
      await api(`/api/sessions/${s.id}`, { method: 'DELETE' });
      if (state.sessionId === s.id) newSession();
      loadSessions();
    });
    list.appendChild(li);
  }
}

/** Refresh the ctx badge from the server: this session's real usage on the selected model (0% for a new session). */
async function refreshContext(sessionId) {
  try {
    const q = new URLSearchParams({ model: $('model').value || '' });
    if (sessionId) q.set('session', sessionId);
    const c = await api('/api/context?' + q);
    if (sessionId !== state.sessionId) return;           // user switched meanwhile
    if (c.ctx > 0) showMetrics({ ctx: c.ctx, used: c.used, tps: c.tps }); else $('metricsBadge').hidden = true;
  } catch (e) { console.debug('context badge not updated', e); }
}

function newSession() {
  state.sessionId = null;
  $('metricsBadge').hidden = true;
  refreshContext(null);
  $('messages').innerHTML = '';
  renderTodos([]);
  addHint();
  loadSessions();
}

function addHint() {
  const d = document.createElement('div');
  d.className = 'hint';
  d.innerHTML = 'Working in <em>' + escapeHtml(state.workDir) + '</em><br>Ask the agent to build or change things here. ' +
    'Use <em>plan</em> for a read-only review, <em>build</em> for full access. Sessions are saved in <em>~/.studio/&lt;project&gt;/sessions/</em> and can be resumed any time.';
  $('messages').appendChild(d);
}

async function openSession(id) {
  if (state.streaming) return;
  const s = await api(`/api/sessions/${id}`);
  state.sessionId = s.id;
  if (state.agents.some((a) => a.name === s.agent)) $('agent').value = s.agent;
  if (s.model) { const opt = [...$('model').options].find((o) => o.value === s.model); if (opt) $('model').value = s.model; }
  renderSession(s);
  renderTodos(s.todos || []);
  if (s.context && s.context.ctx > 0) showMetrics(s.context);
  else if (s.lastCtx) showMetrics({ ctx: s.lastCtx, used: s.lastUsed || 0, tps: s.lastTps || 0 });
  else $('metricsBadge').hidden = true;
  try { localStorage.setItem('lastSession:' + state.workDir, s.id); } catch { /* ignore */ }
  await loadSessions();
  if (s.running && !state.streaming) startStream((signal) => fetch(`/api/sessions/${s.id}/attach`, { signal }));
}

const RENDER_WINDOW = 60;    // messages drawn at once; older ones are one click away (long sessions froze the page otherwise)

function renderSession(s, from = null) {
  const box = $('messages');
  const live = s.messages || [];
  const history = s.history || [];                    // messages summarised out of the model's context — still shown exactly as they were
  const off = history.length;
  const all = history.length ? [...history, ...live] : live;
  state.messages = live;                              // message menu (Edit / Resend) maps DOM bubbles back to these by index
  state.history = history;
  state.renderFrom = from == null ? Math.max(0, all.length - RENDER_WINDOW) : Math.max(0, from);
  const start = state.renderFrom;
  box.replaceChildren();
  const cards = new Map();
  bulkRender = true;
  try {
    if (start > 0) {
      const more = document.createElement('button');
      more.className = 'btn small ghost more-msgs';
      more.textContent = `↑ Show ${Math.min(RENDER_WINDOW, start)} earlier messages (${start} hidden)`;
      more.addEventListener('click', () => { const keep = box.scrollHeight - box.scrollTop; renderSession({ messages: live, history }, start - RENDER_WINDOW); box.scrollTop = box.scrollHeight - keep; });
      box.appendChild(more);
    }
    for (let i = start; i < all.length; i++) {
      try { renderOneMessage(all[i], i >= off ? i - off : undefined, cards); } catch (e) { console.error('could not draw message', i, e); }
    }
    if (!all.length) addHint();
  } finally { bulkRender = false; }
  scrollChat();
}

function renderOneMessage(m, i, cards) {
  if (m.role === 'user') {
    if (!m.summary) { const el = addMessage('user', userText(m)); if (i !== undefined) el.dataset.idx = i; decorateUser(el, m.attachments); }
    else addSummaryBlock(m.content.replace(/^Summary of the earlier conversation:\n/, ''));
  } else if (m.role === 'assistant') {
    if (m.thinking && !m.summary) { const t = addThinkingBlock(); t.style.display = ''; t.open = false; setThinking(t, m.thinking); }
    if (m.content && !m.summary) { const el = addMessage('assistant', m.content); if (i !== undefined) el.dataset.idx = i; }
    for (const c of m.tool_calls || []) {
      const { card, body } = addToolCard(c.function.name, c.function.arguments);
      body.innerHTML = `<pre>${escapeHtml(truncate(JSON.stringify(c.function.arguments, null, 2), 6000))}</pre>`;
      cards.set(c.id, { card, body });
    }
  } else if (m.role === 'tool') {
    const c = cards.get(m.tool_call_id);
    if (!c) return;
    const raw = String(m.content || '');
    let parsed = raw.length > 30000 ? raw.slice(0, 1200) + `… (${(raw.length - 1200).toLocaleString()} more characters)` : raw;   // huge results are not parsed/drawn in full
    let ok = true;
    if (raw.length <= 30000) {
      try { parsed = JSON.parse(raw); ok = !(parsed && parsed.error); } catch { /* plain text result */ }
    } else ok = !/^\s*\{\s*"error"/.test(raw);
    c.body.innerHTML += resultHtml(parsed, ok);
    c.card.classList.add(ok ? 'ok' : 'err');
  }
}

function renderTodos(todos) {
  const el = $('todos');
  el.hidden = !todos.length;
  el.innerHTML = todos.map((t) => {
    const mark = t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▶' : '☐';
    return `<div class="${t.status}">${mark} ${escapeHtml(t.content)}</div>`;
  }).join('');
}

async function forkSession() {
  if (!state.sessionId) return;
  const s = await api(`/api/sessions/${state.sessionId}/fork`, { method: 'POST', body: '{}' });
  await openSession(s.id);
}

async function undoRedo(kind) {
  if (!state.sessionId || state.streaming) return;
  try {
    const r = await api(`/api/sessions/${state.sessionId}/${kind}`, { method: 'POST', body: '{}' });
    await openSession(state.sessionId);
    await loadTree();
    if (kind === 'undo') {
      $('prompt').value = r.text || '';
      setStatus(r.files.length ? `undone · restored ${r.files.length} file(s)` : 'undone', 'ok');
    } else setStatus(`redone · ${r.files.length} file(s)`, 'ok');
  } catch (err) { setStatus(err.message, 'err'); }
}

async function compactSession() {
  if (!state.sessionId || state.streaming) return;
  setStatus('compacting…', 'busy');
  try {
    const r = await api(`/api/sessions/${state.sessionId}/compact`, { method: 'POST', body: '{}' });
    setStatus(r.summarized ? 'compacted' : `pruned ${r.pruned} outputs`, 'ok');
    await openSession(state.sessionId);
  } catch (err) { setStatus('compact failed', 'err'); alert(err.message); }
}

/* ---------- directory + files ---------- */

function showWorkDir() {
  $('workDir').textContent = state.workDir;
  $('filesTitle').textContent = 'Files · ' + state.workDir.split(/[\\/]/).filter(Boolean).pop();
}

async function changeDir() {
  const dir = prompt('Open directory (absolute path):', state.workDir);
  if (!dir || dir === state.workDir) return;
  try {
    const r = await api('/api/workdir', { method: 'POST', body: JSON.stringify({ dir }) });
    state.workDir = r.workDir;
    state.activeFile = null;
    treeState.expanded.clear(); treeState.cache.clear();
    $('editor').value = '';
    $('editorTitle').textContent = 'No file open';
    if ($('editorDlg').open) $('editorDlg').close();
    showWorkDir();
    await loadTree();
    if (r.latest) await openSession(r.latest.id); else newSession();
    await loadSessions();
    const st = await api('/api/state');
    state.commands = st.commands || [];
    fillAgents(st.agents, $('agent').value);
  } catch (err) { alert(err.message); }
}

/* ---------- file tree: one folder level at a time (expanding is lazy, so huge folders never freeze the page) ---------- */

const treeState = { expanded: new Set(), cache: new Map() };     // expanded folder paths; path -> { entries, truncated }

async function fetchDir(rel) {
  const d = await api('/api/tree?path=' + encodeURIComponent(rel));
  treeState.cache.set(rel, { entries: d.entries || [], truncated: d.truncated || 0 });
  return treeState.cache.get(rel);
}

/** Reload the root and every expanded folder (in parallel), then redraw. A folder that vanished is simply collapsed. */
async function loadTree() {
  const dirs = ['', ...treeState.expanded];
  await Promise.all(dirs.map((d) => fetchDir(d).catch((e) => { if (d) treeState.expanded.delete(d); else throw e; })));
  renderTree();
}

function renderTree() {
  const ul = $('tree');
  const frag = document.createDocumentFragment();
  const root = treeState.cache.get('');
  if (!root || !root.entries.length) { const li = document.createElement('li'); li.className = 'hint'; li.style.cursor = 'default'; li.textContent = 'Empty directory.'; frag.appendChild(li); }
  const walk = (rel, depth) => {
    const level = treeState.cache.get(rel);
    if (!level) return;
    for (const node of level.entries) {
      const li = document.createElement('li');
      li.style.paddingLeft = 6 + depth * 14 + 'px';
      if (node.type === 'dir') {
        const open = treeState.expanded.has(node.path);
        li.className = 'dir' + (node.heavy ? ' heavy' : '');
        li.title = node.heavy ? 'dependency/cache folder — expand only if you need it' : node.path;
        const row = document.createElement('div');
        row.className = 'tree-row';
        const label = document.createElement('span');
        label.className = 'tree-label';
        label.textContent = (open ? '▾ ' : '▸ ') + node.name;
        label.addEventListener('click', () => toggleDir(node.path));
        const dl = document.createElement('a');
        dl.className = 'tree-dl';
        dl.href = '/api/download?path=' + encodeURIComponent(node.path);
        dl.download = (node.name || 'folder') + '.zip';
        dl.title = 'Download folder as zip';
        dl.textContent = '⬇ zip';
        dl.addEventListener('click', (e) => e.stopPropagation());
        row.append(label, dl);
        li.appendChild(row);
        frag.appendChild(li);
        if (open) walk(node.path, depth + 1);
      } else {
        li.className = node.path === state.activeFile ? 'active' : '';
        li.dataset.path = node.path;
        li.title = node.path;
        const row = document.createElement('div');
        row.className = 'tree-row';
        const label = document.createElement('span');
        label.className = 'tree-label';
        label.textContent = node.name;
        label.addEventListener('click', () => openFile(node.path).catch((e) => setStatus(e.message, 'err')));
        const dl = document.createElement('a');
        dl.className = 'tree-dl';
        dl.href = '/api/download?path=' + encodeURIComponent(node.path);
        dl.download = node.name;
        dl.title = 'Download file';
        dl.textContent = '⬇';
        dl.addEventListener('click', (e) => e.stopPropagation());
        row.append(label, dl);
        li.appendChild(row);
        frag.appendChild(li);
      }
    }
    if (level.truncated) { const li = document.createElement('li'); li.className = 'hint'; li.style.cssText = `cursor:default;padding-left:${6 + depth * 14}px`; li.textContent = `… ${level.truncated} more not shown`; frag.appendChild(li); }
  };
  walk('', 0);
  ul.replaceChildren(frag);
}

async function toggleDir(rel) {
  try {
    if (treeState.expanded.has(rel)) treeState.expanded.delete(rel);
    else { treeState.expanded.add(rel); if (!treeState.cache.has(rel)) await fetchDir(rel); }
    renderTree();
  } catch (e) { treeState.expanded.delete(rel); setStatus('cannot open folder: ' + e.message, 'err'); }
}

/** Highlight the open file without rebuilding the tree. */
function markActiveFile() {
  document.querySelectorAll('#tree li').forEach((li) => { if (li.dataset.path) li.classList.toggle('active', li.dataset.path === state.activeFile); });
}

async function openFile(relPath) {
  const data = await api(`/api/file?path=${encodeURIComponent(relPath)}`);
  state.activeFile = relPath;
  $('editor').value = data.content;
  $('editorTitle').textContent = relPath;
  $('saveFile').disabled = false;
  setDirty(false);
  markActiveFile();
  closePanels();                                      // on a phone the drawer must not stay over the editor
  openEditor();
}

/** Show the editor as a modal overlay (it is no longer a cramped column). */
function openEditor() {
  const dlg = $('editorDlg');
  if (!dlg || dlg.open) return;
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
}

/** Close the editor, asking before throwing away unsaved edits. */
function closeEditor() {
  const dlg = $('editorDlg');
  if (!dlg || !dlg.open) return;
  if ($('dirtyDot').classList.contains('on') && !confirm('Discard unsaved changes?')) return;
  dlg.close();
}

/* ---------- slide-out panels (mobile) ---------- */
/* NOTE: these names must not collide with the message context-menu helpers at the bottom of this file. */

function openPanels() {
  document.body.classList.add('menu-open');
  $('menuBtn').setAttribute('aria-expanded', 'true');
}

function closePanels() {
  document.body.classList.remove('menu-open');
  $('menuBtn').setAttribute('aria-expanded', 'false');
}

const panelsOpen = () => document.body.classList.contains('menu-open');

async function saveFile() {
  if (!state.activeFile) return;
  await api('/api/file', { method: 'PUT', body: JSON.stringify({ path: state.activeFile, content: $('editor').value }) });
  setDirty(false);
  setStatus('file saved', 'ok');
}

async function createFile() {
  const p = prompt('New file path (e.g. src/index.js):');
  if (!p) return;
  await api('/api/file', { method: 'PUT', body: JSON.stringify({ path: p, content: '' }) });
  await loadTree();
  await openFile(p);
}

const setDirty = (on) => { $('dirtyDot').className = 'dirty' + (on ? ' on' : ''); };

/* ---------- chat rendering ---------- */

function resultHtml(result, ok) {
  const color = ok ? 'var(--green)' : 'var(--red)';
  let html = '';
  if (result && typeof result.diff === 'string') {
    html += '<div class="diff">' + escapeHtml(truncate(result.diff, 40000)).split('\n').slice(0, 800).map((l) =>
      `<div class="${l.startsWith('+ ') ? 'add' : l.startsWith('- ') ? 'del' : 'hunk'}">${l}</div>`).join('') + '</div>';
    const { diff, ...rest } = result;
    result = rest;
  }
  return html + `<pre style="margin-top:6px;color:${color}">→ ${escapeHtml(truncate(JSON.stringify(result), 1200))}</pre>`;
}


/** A thin "Compaction" line where older messages were folded into a summary; click it to read the summary (like a Thinking block). */
function addSummaryBlock(text, covered) {
  const el = document.createElement('details');
  el.className = 'msg compaction';
  const label = document.createElement('summary');
  label.textContent = covered ? `Compaction · ${covered} messages summarised` : 'Compaction';
  const body = document.createElement('div');
  body.className = 'md';
  body.innerHTML = window.renderMarkdown(text);
  el.append(label, body);
  $('messages').appendChild(el);
  return el;
}

/** Assistant text is rendered as markdown; everything else stays plain text. */
function setMessageText(el, text) {
  el.dataset.raw = text;
  if (el.classList.contains('assistant')) el.innerHTML = window.renderMarkdown(text); else el.textContent = text;
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  setMessageText(div, text);
  $('messages').appendChild(div);
  scrollChat();
  return div;
}

/** Collapsible "💭 Thinking" block: open while the model is thinking, folded once the answer starts. */
function addThinkingBlock() {
  const el = document.createElement('details');
  el.className = 'msg thinking';
  el.open = true;
  el.style.display = 'none';
  el.innerHTML = '<summary>💭 Thinking</summary><div class="tbody"></div>';
  $('messages').appendChild(el);
  return el;
}
const setThinking = (el, text) => { el.querySelector('.tbody').textContent = text; };

// markdown re-render is throttled to one per animation frame while tokens stream in
const pendingRender = new Map();
const lastRender = new WeakMap();
function renderSoon(el, text) {
  const had = pendingRender.has(el);
  pendingRender.set(el, text);
  if (had) return;
  // re-parsing a long answer as markdown on every frame is O(n²): slow the cadence down as the text grows
  const wait = Math.max(0, (text.length > 20000 ? 700 : text.length > 6000 ? 350 : text.length > 2000 ? 120 : 0) - (Date.now() - (lastRender.get(el) || 0)));
  const run = () => requestAnimationFrame(() => {
    const t = pendingRender.get(el);
    pendingRender.delete(el);
    lastRender.set(el, Date.now());
    try { setMessageText(el, t); } catch (e) { console.error('markdown render failed', e); el.textContent = t; }
    scrollChat();
  });
  if (wait > 0) setTimeout(run, wait); else run();
}

const pendingThink = new Map();
function thinkSoon(el, text) {
  const had = pendingThink.has(el);
  pendingThink.set(el, text);
  if (had) return;
  setTimeout(() => { const t = pendingThink.get(el); pendingThink.delete(el); setThinking(el, text.length > 30000 ? '…' + t.slice(-30000) : t); scrollChat(); }, 120);
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  return [args.path, args.command, args.pattern, args.description, args.agent].filter(Boolean).map((x) => truncate(String(x), 60)).join(' · ');
}

function addToolCard(name, args) {
  const card = document.createElement('div');
  card.className = 'tool';
  const head = document.createElement('div');
  head.className = 'tool-head';
  head.innerHTML = `<span class="badge">⚙ ${escapeHtml(name)}</span><span style="color:var(--muted)">${escapeHtml(summarizeArgs(args))}</span>`;
  const body = document.createElement('div');
  body.className = 'tool-body';
  head.addEventListener('click', () => card.classList.toggle('open'));
  card.append(head, body);
  $('messages').appendChild(card);
  scrollChat();
  return { card, body };
}

function addPermissionCard(ev) {
  const div = document.createElement('div');
  div.className = 'perm';
  div.innerHTML = `<b>Permission needed</b> — the agent wants to run <b>${escapeHtml(ev.tool)}</b>:<code>${escapeHtml(ev.summary)}</code>` +
    '<div class="row"><button class="btn small primary" data-r="once">Allow once</button>' +
    '<button class="btn small" data-r="always">Always (this session)</button>' +
    '<button class="btn small ghost" data-r="reject">Reject</button></div>';
  div.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    div.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    div.classList.add('done');
    try { await api('/api/permission', { method: 'POST', body: JSON.stringify({ id: ev.id, reply: b.dataset.r }) }); }
    catch (err) { addMessage('assistant', '✖ ' + err.message); }
  }));
  $('messages').appendChild(div);
  scrollChat();
  return div;
}

function addQuestionCard(ev) {
  const div = document.createElement('div');
  div.className = 'question';
  div.innerHTML = `<b>Question</b><div style="margin:4px 0">${escapeHtml(ev.question)}</div><div class="row"></div>`;
  const row = div.querySelector('.row');
  const send = async (answer) => {
    div.classList.add('done');
    div.querySelectorAll('button,input').forEach((x) => { x.disabled = true; });
    try { await api('/api/answer', { method: 'POST', body: JSON.stringify({ id: ev.id, answer }) }); }
    catch (err) { addMessage('assistant', '✖ ' + err.message); }
  };
  for (const o of ev.options || []) {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = o;
    b.addEventListener('click', () => send(o));
    row.appendChild(b);
  }
  const input = document.createElement('input');
  input.placeholder = 'Type your own answer…';
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value.trim()) send(input.value.trim()); });
  row.appendChild(input);
  $('messages').appendChild(div);
  scrollChat();
  return div;
}

/* ---------- chat streaming ---------- */

/** Read one run's SSE stream (live or re-attached). Returns true if the run reached a terminal event. */
async function consumeRun(res) {
  let assistantEl = null;
  let assistantText = '';
  let thinkingEl = null;
  let thinkingText = '';
  let toolCards = new Map();
  let cards = new Map(); // permission / question cards by id
  let finished = false;
  let touchedFiles = false;

  const newTurnBlock = () => { assistantEl = null; assistantText = ''; thinkingEl = null; thinkingText = ''; };

  const handleEvent = (event) => {
    switch (event.type) {
      case 'attach':
        // re-attached to a run in progress: rebuild the chat, then the replayed events follow
        renderSession({ messages: event.messages || [] });
        newTurnBlock();
        toolCards = new Map();
        cards = new Map();
        setStatus('reconnected', 'busy');
        break;
      case 'start':
        state.sessionId = event.sessionId;
        try { localStorage.setItem('lastSession:' + state.workDir, event.sessionId); } catch { /* ignore */ }
        setStatus(`${event.agent} · generating…`, 'busy');
        break;
      case 'iteration': newTurnBlock(); break;
      case 'thinking':
        thinkingText += event.text;
        if (thinkingText.trim()) {
          if (!thinkingEl) thinkingEl = addThinkingBlock();
          thinkingEl.style.display = '';
          thinkSoon(thinkingEl, thinkingText);
        }
        break;
      case 'token':
        if (!assistantEl) { assistantEl = addMessage('assistant', ''); if (thinkingEl) thinkingEl.open = false; }
        assistantText += event.text;
        renderSoon(assistantEl, assistantText);
        break;
      case 'tool_call': {
        const { card, body } = addToolCard(event.name, event.args);
        body.innerHTML = `<pre>${escapeHtml(JSON.stringify(event.args, null, 2))}</pre>`;
        toolCards.set(event.id, { card, body });
        break;
      }
      case 'tool_result': {
        const c = toolCards.get(event.id);
        if (c) {
          c.body.innerHTML += resultHtml(event.result, event.ok);
          c.card.classList.add(event.ok ? 'ok' : 'err');
          c.card.classList.toggle('open', !event.ok);
        }
        if (/write_file|edit_file|delete_file|bash/.test(event.name)) touchedFiles = true;
        break;
      }
      case 'sub_event': {
        const ev = event.event;
        const line = document.createElement('div');
        line.className = 'subline' + (ev.type === 'tool_result' && !ev.ok ? ' err' : '');
        line.textContent = ev.type === 'tool_call' ? `↳ ${ev.name} ${summarizeArgs(ev.args)}` : `  ${ev.ok ? '✓' : '✗'} ${ev.name}`;
        $('messages').appendChild(line);
        scrollChat();
        break;
      }
      case 'subagent':
        if (event.phase === 'start') addMessage('note', `◇ subagent "${event.agent}" ${event.resumed ? 'resumed' : 'started'}: ${event.description || ''}`).className = 'note';
        break;
      case 'todos': renderTodos(event.todos); break;
      case 'question': cards.set(event.id, addQuestionCard(event)); break;
      case 'permission_request': cards.set(event.id, addPermissionCard(event)); break;
      case 'permission_resolved':
      case 'question_resolved': {
        const c = cards.get(event.id);
        if (c) { c.classList.add('done'); c.querySelectorAll('button,input').forEach((x) => { x.disabled = true; }); }
        break;
      }
      case 'changes': {
        const add = event.files.reduce((n, f) => n + f.additions, 0);
        const del = event.files.reduce((n, f) => n + f.deletions, 0);
        const div = document.createElement('div');
        div.className = 'changes';
        div.innerHTML = `${event.files.length} file(s) changed <b>+${add}</b> <i>−${del}</i> — ` + event.files.slice(0, 8).map((f) => escapeHtml(f.path)).join(', ') + (event.files.length > 8 ? ' …' : '') + ' · Undo reverts all of it';
        $('messages').appendChild(div);
        touchedFiles = true;
        scrollChat();
        break;
      }
      case 'title': loadSessions(); break;
      case 'agent': $('agent').value = event.name; addMessage('note', `◇ switched to the "${event.name}" agent`).className = 'note'; break;
      case 'retry':
        if (assistantEl) { assistantEl.remove(); newTurnBlock(); }
        addMessage('note', `server error — retry ${event.attempt}/${event.max} in ${(event.delayMs / 1000).toFixed(0)}s (${event.message})`).className = 'note';
        setStatus('retrying…', 'busy');
        break;
      case 'info': addMessage('note', event.text).className = 'note'; break;
      case 'recall': addMessage('note', `🔎 recalled ${event.count} earlier snippet(s) from the project history`).className = 'note'; break;
      case 'compacting': state.compactNote = addMessage('note', 'context is full — summarising older messages…'); state.compactNote.className = 'note'; break;
      case 'compacted':
        if (state.compactNote) { state.compactNote.remove(); state.compactNote = null; }
        if (event.text) { newTurnBlock(); addSummaryBlock(event.text, event.covered); scrollChat(); }
        break;
      case 'metrics':
        if (!event.child && event.metrics && event.metrics.eval_count) {
          showMetrics(event);
          setStatus(`${event.metrics.eval_count} tok`, 'ok');
        }
        break;
      case 'warning': addMessage('assistant', '⚠ ' + event.message); break;
      case 'error': addMessage('assistant', '✖ ' + event.message); setStatus('error', 'err'); finished = true; break;
      case 'aborted': addMessage('note', '■ stopped — the work done so far is saved; say "continue" to resume.').className = 'note'; setStatus('stopped', ''); finished = true; break;
      case 'done': setStatus('done', 'ok'); finished = true; state.runDone = true; break;
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    state.lastBytes = Date.now();
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) {
          let ev = null;
          try { ev = JSON.parse(line.slice(6)); } catch (e) { console.warn('bad event from the server', e); continue; }
          try { handleEvent(ev); } catch (e) { console.error('could not show event', ev && ev.type, e); }
        }
      }
    }
  }
  if (touchedFiles) loadTree().catch((e) => console.warn('file tree refresh failed', e));
  return finished;
}

/**
 * Run an SSE request (new message or re-attach). The agent keeps running on the server even if this connection
 * drops (tab switched, phone suspended); we then re-attach automatically.
 */
async function startStream(makeFetch) {
  if (state.streaming) return;
  state.streaming = true;
  state.runDone = false;
  state.userStopped = false;
  state.lastBytes = Date.now();
  $('send').textContent = 'Stop';
  state.abortController = new AbortController();
  let finished = false;
  // phones can freeze a socket silently; the server sends a keepalive every 15s
  const watchdog = setInterval(() => {
    if (Date.now() - state.lastBytes > 45000 && state.abortController) { state.dropped = true; state.abortController.abort(); }
  }, 5000);
  try {
    const res = await makeFetch(state.abortController.signal);
    if (res.status === 409) {
      addMessage('note', 'This session is still running on the server — attached to it. Press Stop to interrupt.').className = 'note';
      state.streaming = false;
      clearInterval(watchdog);
      return startStream((signal) => fetch(`/api/sessions/${state.sessionId}/attach`, { signal }));
    }
    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* body is not JSON — keep the HTTP status text */ }
      throw new Error(msg);
    }
    finished = await consumeRun(res);
  } catch (err) {
    if (err.name === 'AbortError') { if (state.userStopped) finished = true; }
    else addMessage('note', '⚠ connection lost: ' + err.message).className = 'note';
  } finally {
    clearInterval(watchdog);
    state.streaming = false;
    state.abortController = null;
    $('send').textContent = 'Send';
    state.dropped = false;
    if (!finished) {
      setStatus('reconnecting…', 'busy');
      setTimeout(resumeIfRunning, 1500);
    } else {
      await loadSessions();
      // give the new bubbles their message index (needed by the Edit/Resend menu): re-render after a clean finish,
      // otherwise (error / stopped) keep the notes on screen and only refresh the stored messages
      try {
        if (state.runDone) await openSession(state.sessionId);
        else if (state.sessionId) state.messages = (await api(`/api/sessions/${state.sessionId}`)).messages;
      } catch (e) { console.warn('could not refresh the session after the run', e); }
    }
    state.runDone = false;
  }
}

/** If the session is (still) running on the server, re-attach; otherwise just show its final state. */
async function resumeIfRunning() {
  if (state.streaming || !state.sessionId) return;
  try {
    const s = await api(`/api/sessions/${state.sessionId}`);
    if (s.running) startStream((signal) => fetch(`/api/sessions/${state.sessionId}/attach`, { signal }));
    else { await openSession(state.sessionId); await loadTree(); setStatus('ready', 'ok'); }
  } catch { setTimeout(resumeIfRunning, 4000); }
}

function sendChat(text, opts = {}) {
  const interrupt = opts === true || !!opts.interrupt;
  const attachments = (opts.attachments || []).map((a) => ({ id: a.id, name: a.name }));
  document.querySelector('#messages .hint')?.remove();
  const el = addMessage('user', text);
  decorateUser(el, opts.attachmentMeta || attachments.map((a) => ({ ...a, mode: 'pending' })));
  return startStream((signal) => fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ model: $('model').value, agent: $('agent').value, sessionId: state.sessionId, text, attachments, interrupt }),
  }));
}

function stopRun() {
  state.userStopped = true;
  if (state.sessionId) api('/api/abort', { method: 'POST', body: JSON.stringify({ sessionId: state.sessionId }) }).catch(() => {});
  setStatus('stopping…', 'busy');
  // the server answers with an "aborted" event; if the connection is dead, give up after a moment
  setTimeout(() => { if (state.abortController) state.abortController.abort(); }, 5000);
}

/* ---------- providers dialog ---------- */

let providerDraft = {};

const PRESETS = {
  openai: { id: 'openai', type: 'openai', endpoint: 'https://api.openai.com/v1' },
  anthropic: { id: 'anthropic', type: 'anthropic', endpoint: 'https://api.anthropic.com' },
  gemini: { id: 'gemini', type: 'openai', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  groq: { id: 'groq', type: 'openai', endpoint: 'https://api.groq.com/openai/v1' },
  openrouter: { id: 'openrouter', type: 'openai', endpoint: 'https://openrouter.ai/api/v1' },
  ollama: { id: 'ollama2', type: 'ollama', endpoint: 'http://localhost:11434' },
};

function providerRowHtml(id, p, isDefault) {
  const t = p.type === 'openai' || p.type === 'anthropic' ? p.type : 'ollama';
  const opt = (v, label) => `<option value="${v}" ${t === v ? 'selected' : ''}>${label}</option>`;
  return `<div class="prow" data-id="${escapeHtml(id)}">
    ${isDefault ? '' : `<label>Preset</label><select data-f="preset"><option value="">Custom…</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic (Claude)</option><option value="gemini">Google Gemini</option><option value="groq">Groq</option><option value="openrouter">OpenRouter</option><option value="ollama">Another Ollama</option></select>`}
    <label>Name</label><input data-f="id" value="${escapeHtml(id)}" ${isDefault ? 'disabled' : ''} placeholder="e.g. openai, groq, gemini" />
    <label>Type</label><select data-f="type" ${isDefault ? 'disabled' : ''}>${opt('ollama', 'Ollama')}${opt('openai', 'OpenAI-compatible (OpenAI, Groq, Gemini…)')}${opt('anthropic', 'Anthropic (Claude)')}</select>
    <label>Endpoint</label><input data-f="endpoint" value="${escapeHtml(p.endpoint || '')}" placeholder="http://localhost:11434  |  https://api.openai.com/v1" spellcheck="false" />
    <label>API key</label><input data-f="apiKey" type="password" value="${escapeHtml(p.apiKey || '')}" placeholder="${isDefault ? '(optional — not needed for plain Ollama)' : '(optional for Ollama, required for cloud APIs)'}" autocomplete="off" />
    ${isDefault ? '' : `<label>Context window</label><input data-f="contextWindow" type="number" value="${p.contextWindow || ''}" placeholder="auto (OpenAI 128k · Claude 200k · Gemini 1M)" />`}
    <div class="full"><button class="btn small" data-act="test">Test</button>${isDefault ? '' : '<button class="btn small ghost" data-act="remove">Remove</button>'}<span class="res"></span></div>
  </div>`;
}

function openProviders() {
  const c = state.config;
  $('providerRows').innerHTML = providerRowHtml('default', { type: 'ollama', endpoint: c.endpoint, apiKey: c.apiKey }, true) +
    Object.entries(c.providers || {}).map(([id, p]) => providerRowHtml(id, p, false)).join('');
  bindProviderRows();
  $('providersDlg').showModal();
}

function readRow(row) {
  const f = (k) => row.querySelector(`[data-f="${k}"]`);
  return { id: f('id').value.trim(), type: f('type').value, endpoint: f('endpoint').value.trim(), apiKey: f('apiKey') ? f('apiKey').value : undefined, contextWindow: f('contextWindow') && f('contextWindow').value ? Number(f('contextWindow').value) : undefined };
}

function bindProviderRows() {
  $('providerRows').querySelectorAll('.prow').forEach((row) => {
    const preset = row.querySelector('[data-f="preset"]');
    if (preset) preset.addEventListener('change', () => {
      const pr = PRESETS[preset.value];
      if (!pr) return;
      const set = (k, v) => { const el = row.querySelector(`[data-f="${k}"]`); if (el) el.value = v; };
      if (!row.querySelector('[data-f="id"]').value.trim()) set('id', pr.id);
      set('type', pr.type); set('endpoint', pr.endpoint);
    });
    row.querySelector('[data-act="test"]').addEventListener('click', async () => {
      const r = readRow(row);
      const out = row.querySelector('.res');
      out.textContent = 'testing…';
      try {
        const res = await api('/api/providers/test', { method: 'POST', body: JSON.stringify({ ...r, id: row.dataset.id }) });
        out.textContent = `✓ ${res.count} model(s): ${res.models.slice(0, 4).join(', ')}${res.count > 4 ? '…' : ''}`;
      } catch (err) { out.textContent = '✗ ' + err.message; }
    });
    const rm = row.querySelector('[data-act="remove"]');
    if (rm) rm.addEventListener('click', () => row.remove());
  });
}

async function saveProviders() {
  const rows = [...$('providerRows').querySelectorAll('.prow')];
  const providers = {};
  let endpoint = state.config.endpoint;
  let defaultKey = state.config.apiKey || '';
  for (const row of rows) {
    const r = readRow(row);
    if (row.dataset.id === 'default') { endpoint = r.endpoint || endpoint; defaultKey = r.apiKey || ''; continue; }
    if (!r.id || !r.endpoint) continue;
    providers[r.id] = { type: r.type, endpoint: r.endpoint, ...(r.apiKey ? { apiKey: r.apiKey } : {}), ...(r.contextWindow ? { contextWindow: r.contextWindow } : {}) };
  }
  state.config = await api('/api/config', { method: 'PUT', body: JSON.stringify({ endpoint, apiKey: defaultKey, providers }) });
  $('endpoint').value = state.config.endpoint || '';
  $('providersDlg').close();
  await loadModels();
}

/* ---------- tools / integrations dialog ---------- */

async function openStatus() {
  $('statusBody').innerHTML = '<div class="hint-line">loading…</div>';
  if (!$('statusDlg').open) $('statusDlg').showModal();
  try {
    const [m, st, pr] = await Promise.all([api('/api/mcp'), api('/api/state'), api('/api/processes')]);
    const dot = (cls) => `<span class="dot ${cls}"></span>`;
    $('statusBody').innerHTML =
      '<h4>Background processes</h4>' + (pr.processes.length ? pr.processes.map((p) => `<div class="srow">${dot(p.running ? 'ok' : '')}<code>${escapeHtml(p.command)}</code> pid ${p.pid} · ${p.running ? 'running' : 'exited ' + p.exit_code} ${p.running ? `<button class="btn small ghost" data-kill="${escapeHtml(p.id)}">Kill</button>` : ''}</div>`).join('') : '<div class="hint-line">none (servers started by the agent with background=true show up here)</div>') +
      '<h4>MCP servers</h4>' + (m.servers.length ? m.servers.map((s) => `<div class="srow">${dot(s.status === 'connected' ? 'ok' : s.status === 'failed' ? 'bad' : '')}<b>${escapeHtml(s.name)}</b> ${escapeHtml(s.type)} · ${escapeHtml(s.status)}${s.tools ? ` · ${s.tools} tools` : ''}${s.error ? ` — <span style="color:var(--red)">${escapeHtml(s.error)}</span>` : ''}</div>`).join('') : '<div class="hint-line">none configured — add <code>"mcp"</code> to config.json</div>') +
      `<h4>Language servers (LSP)</h4><div class="srow">${dot(st.lsp ? 'ok' : '')}${st.lsp ? 'at least one language server is available (diagnostics after edits + lsp tool)' : 'none found on PATH — install e.g. typescript-language-server, pyright, gopls, or configure "lsp"'}</div>` +
      '<h4>Skills</h4>' + (st.skills.length ? st.skills.map((s) => `<div class="srow"><b>${escapeHtml(s.name)}</b> ${escapeHtml(s.description)}</div>`).join('') : '<div class="hint-line">none — add folders with SKILL.md under ~/.studio/&lt;project&gt;/skills/</div>') +
      '<h4>Commands</h4>' + st.commands.map((c) => `<div class="srow"><b>/${escapeHtml(c.name)}</b> ${escapeHtml(c.description)}</div>`).join('');
    $('statusBody').querySelectorAll('[data-kill]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/api/processes/${b.dataset.kill}`, { method: 'DELETE' }).catch((e) => alert(e.message));
      openStatus();
    }));
  } catch (err) { $('statusBody').textContent = err.message; }
}

/* ---------- attachments ---------- */

const KIND_ICON = { image: '🖼', pdf: '📄', office: '📊', text: '📃', zip: '🗜', audio: '🎵', video: '🎞', binary: '📦' };
const MODE_LABEL = { image: 'sent as image', described: 'described by a vision model', ocr: 'OCR text', text: 'included as text', extracted: 'text extracted',
  listing: 'archive listing', path: 'path only', pending: '' };
const IMG_RE = /\.(png|jpe?g|gif|webp)$/i;
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
function guessKind(name, type) {
  if (/^image\//.test(type) || /\.(png|jpe?g|gif|webp|bmp|heic|avif|tiff?)$/i.test(name)) return 'image';
  if (/pdf$/i.test(name)) return 'pdf';
  if (/\.(docx|xlsx|pptx|odt|ods|odp)$/i.test(name)) return 'office';
  if (/\.(zip|jar|apk|epub)$/i.test(name)) return 'zip';
  if (/^audio\//.test(type) || /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i.test(name)) return 'audio';
  if (/^video\//.test(type) || /\.(mp4|mkv|webm|mov|avi)$/i.test(name)) return 'video';
  return /^text\//.test(type) || /\.(txt|md|csv|json|xml|html|css|js|ts|py|java|c|cpp|go|rs|sh|sql|ya?ml|toml|log)$/i.test(name) ? 'text' : 'binary';
}

/** Attachment chips (and image thumbnails) shown under a user message. */
function decorateUser(el, atts) {
  if (!atts || !atts.length) return;
  const box = document.createElement('div');
  box.className = 'atts';
  for (const a of atts) {
    const kind = a.kind || guessKind(a.name, a.mime || '');
    const warn = a.mode === 'path' && kind !== 'binary' ? ' warn' : '';
    const chip = document.createElement('span');
    chip.className = 'chip' + warn;
    chip.title = [MODE_LABEL[a.mode], a.note].filter(Boolean).join(' — ');
    chip.textContent = `${KIND_ICON[kind] || '📎'} ${a.name}${a.size ? ' · ' + fmtSize(a.size) : ''}${MODE_LABEL[a.mode] ? ' · ' + MODE_LABEL[a.mode] : ''}`;
    if (a.id && kind === 'image' && IMG_RE.test(a.id)) {
      const link = document.createElement('a');
      link.href = `/api/uploads/${encodeURIComponent(a.id)}`; link.target = '_blank'; link.rel = 'noopener';
      const img = document.createElement('img');
      img.className = 'thumb'; img.loading = 'lazy'; img.alt = a.name; img.src = link.href;
      link.appendChild(img);
      box.appendChild(link);
    }
    box.appendChild(chip);
    if (a.note && a.mode === 'path') { const n = document.createElement('div'); n.className = 'attnote'; n.textContent = 'ⓘ ' + a.note; box.appendChild(n); }
  }
  el.appendChild(box);
}

function renderAttachBar() {
  const bar = $('attachBar');
  bar.hidden = !state.pending.length;
  bar.innerHTML = '';
  state.pending.forEach((p, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip pend' + (p.status === 'error' ? ' err' : '');
    chip.textContent = `${KIND_ICON[guessKind(p.name, p.type)] || '📎'} ${p.name} · ${fmtSize(p.size)}${p.status === 'uploading' ? ' · uploading…' : p.status === 'error' ? ' · ' + p.error : ''}`;
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'chip-x'; x.textContent = '✕'; x.title = 'Remove';
    x.addEventListener('click', () => { state.pending.splice(i, 1); renderAttachBar(); });
    chip.appendChild(x);
    bar.appendChild(chip);
  });
}

async function addFiles(fileList) {
  for (const file of [...fileList]) {
    const p = { name: file.name || 'pasted-file', size: file.size, type: file.type, status: 'uploading' };
    state.pending.push(p);
    renderAttachBar();
    try {
      const res = await fetch('/api/upload?name=' + encodeURIComponent(p.name), { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      p.id = data.id; p.status = 'ready';
    } catch (err) { p.status = 'error'; p.error = err.message; }
    renderAttachBar();
  }
  const bad = state.pending.filter((p) => p.status === 'error');
  if (bad.length) setStatus('upload failed: ' + bad[0].error, 'err');
}

/* ---------- message menu: hold / right-click a message → Copy · Copy text · Edit · Resend ---------- */

const userText = (m) => (m.attachments ? (m.display != null ? m.display : m.content) : (m.display || m.content)) || '';
let menuFor = null;

function closeMenu() { $('ctxMenu').hidden = true; menuFor = null; }

function flash(text) { setStatus(text, 'ok'); setTimeout(() => { if ($('connStatus').textContent === text) setStatus(state.streaming ? 'working…' : 'ready', state.streaming ? 'busy' : 'ok'); }, 1400); }

function openMsgMenu(el, x, y) {
  if (menuFor === el && !$('ctxMenu').hidden) return;
  const idx = el.dataset.idx === undefined ? -1 : Number(el.dataset.idx);
  const m = idx >= 0 ? state.messages[idx] : null;
  const isUser = el.classList.contains('user');
  const busy = state.streaming || !m;                  // streaming bubbles have no stored message yet
  const raw = el.dataset.raw || '';
  const items = [
    { label: 'Copy', hint: isUser ? '' : 'markdown', run: () => window.copyToClipboard(raw).then(() => flash('copied')) },
    { label: 'Copy text', hint: 'plain', run: () => window.copyToClipboard(isUser ? raw : window.markdownToText(raw)).then(() => flash('copied text')) },
    { label: 'Edit', disabled: busy, run: () => openEdit(idx, m, isUser) },
    { label: isUser ? 'Resend' : 'Regenerate', disabled: busy, run: () => resendFrom(idx, m, isUser) },
  ];
  const menu = $('ctxMenu');
  menu.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button'; b.disabled = !!it.disabled;
    b.innerHTML = `<span>${escapeHtml(it.label)}</span>${it.hint ? `<small>${escapeHtml(it.hint)}</small>` : ''}`;
    b.addEventListener('click', () => { closeMenu(); it.run(); });
    menu.appendChild(b);
  }
  menu.hidden = false;
  menuFor = el;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 6)) + 'px';
  menu.style.top = Math.max(6, Math.min(y, window.innerHeight - h - 6)) + 'px';
}

/** The user message that starts the turn a bubble belongs to. */
function turnStart(idx) {
  for (let i = idx; i >= 0; i--) if (state.messages[i].role === 'user' && !state.messages[i].summary) return i;
  return -1;
}

async function rewindAndSend(userIdx, text, attachments) {
  await api(`/api/sessions/${state.sessionId}/rewind`, { method: 'POST', body: JSON.stringify({ index: userIdx }) });
  renderSession(await api(`/api/sessions/${state.sessionId}`));
  addMessage('note', '↩ conversation rewound to this point (files the agent changed afterwards were kept — use Undo to revert those)').className = 'note';
  sendChat(text, { attachments, attachmentMeta: attachments.length ? attachments : undefined });
}

async function resendFrom(idx, m, isUser) {
  const u = isUser ? idx : turnStart(idx);
  if (u < 0) return;
  const um = state.messages[u];
  try { await rewindAndSend(u, userText(um), (um.attachments || []).map((a) => ({ ...a }))); } catch (err) { setStatus(err.message, 'err'); }
}

function openEdit(idx, m, isUser) {
  $('editTitle').textContent = isUser ? 'Edit message & resend' : 'Edit reply';
  $('editText').value = isUser ? userText(m) : m.content;
  $('editNote').textContent = isUser ? 'Saving removes this message and everything after it, then sends the edited text.' : 'Changes the stored reply (what the model sees next time).';
  $('editSave').textContent = isUser ? 'Save & resend' : 'Save';
  $('editDlg').dataset.idx = idx;
  $('editDlg').dataset.user = isUser ? '1' : '';
  $('editDlg').showModal();
  $('editText').focus();
}

async function saveEdit() {
  const idx = Number($('editDlg').dataset.idx);
  const isUser = !!$('editDlg').dataset.user;
  const text = $('editText').value;
  $('editDlg').close();
  try {
    if (isUser) {
      const atts = (state.messages[idx].attachments || []).map((a) => ({ ...a }));
      if (!text.trim() && !atts.length) return;
      await rewindAndSend(idx, text.trim(), atts);
    } else {
      await api(`/api/sessions/${state.sessionId}/messages/${idx}`, { method: 'PATCH', body: JSON.stringify({ content: text }) });
      renderSession(await api(`/api/sessions/${state.sessionId}`));
      flash('reply updated');
    }
  } catch (err) { setStatus(err.message, 'err'); }
}

(function bindMessageMenu() {
  const box = $('messages');
  let press = null;
  const clear = () => { if (press) { clearTimeout(press.timer); press.el.classList.remove('pressing'); } press = null; };
  box.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = e.target.closest('.msg.user, .msg.assistant');
    if (!el || e.target.closest('a, button, summary, textarea, input')) return;
    clear();
    const x = e.clientX, y = e.clientY;
    el.classList.add('pressing');
    press = { el, x, y, fired: false, timer: setTimeout(() => {
      press.fired = true; el.classList.remove('pressing');
      if (navigator.vibrate) navigator.vibrate(12);
      const s = window.getSelection && window.getSelection(); if (s && s.removeAllRanges) s.removeAllRanges();
      openMsgMenu(el, x, y);
    }, 480) };
  });
  box.addEventListener('pointermove', (e) => { if (press && !press.fired && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) clear(); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) box.addEventListener(ev, () => { if (press && !press.fired) clear(); });
  box.addEventListener('scroll', () => { clear(); closeMenu(); }, { passive: true });
  box.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('.msg.user, .msg.assistant');
    if (!el) return;
    const sel = window.getSelection && window.getSelection().toString();
    if (sel && e.pointerType !== 'touch') return;                // right-click on a text selection: keep the browser's own menu
    e.preventDefault();
    if (press && press.fired) return;                             // our long-press already opened it
    openMsgMenu(el, e.clientX, e.clientY);
  });
  document.addEventListener('pointerdown', (e) => { if (!$('ctxMenu').hidden && !e.target.closest('#ctxMenu')) closeMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('resize', closeMenu);
})();

/* ---------- built-in slash commands ---------- */

const BUILTINS = [
  { name: 'export', description: 'download the whole session as Markdown (add "json" for JSON) — includes everything that was summarised away' },
  { name: 'summaries', description: 'read the summaries of this session' },
  { name: 'compact', description: 'summarise older context now' },
];

function exportSession(fmt = 'md') {
  if (!state.sessionId) { addMessage('note', 'nothing to export yet — start a session first').className = 'note'; return; }
  const a = document.createElement('a');
  a.href = `/api/sessions/${state.sessionId}/export?format=${fmt === 'json' ? 'json' : 'md'}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  addMessage('note', `⬇ exporting the full session as ${fmt === 'json' ? 'JSON' : 'Markdown'}…`).className = 'note';
}

async function openSummaries() {
  if (!state.sessionId) { addMessage('note', 'no session yet').className = 'note'; return; }
  $('summariesBody').innerHTML = '<div class="hint-line">loading…</div>';
  if (!$('summariesDlg').open) $('summariesDlg').showModal();
  try {
    const r = await api(`/api/sessions/${state.sessionId}/summaries`);
    if (!r.summaries.length) {
      $('summariesBody').innerHTML = '<div class="hint-line">No summaries yet. They appear here when the context fills up (or after <b>Compact</b>).</div>';
      return;
    }
    $('summariesBody').innerHTML =
      '<div class="hint-line">Older messages are replaced by a summary in the model\'s context, but nothing is lost: <code>/export</code> gives the complete session.</div>' +
      r.summaries.map((s, i) => `<details class="sum" ${i === r.summaries.length - 1 ? 'open' : ''}><summary><b>#${s.n}</b> · ${escapeHtml(new Date(s.ts).toLocaleString())}${s.covered ? ` · covers ${s.covered} messages` : ''}${s.legacy ? ' · current' : ''}</summary><div class="md">${window.renderMarkdown(s.text)}</div></details>`).join('');
  } catch (err) { $('summariesBody').textContent = err.message; }
}

/** Returns true when the text was a built-in command (and has been handled). */
function runBuiltin(text) {
  if (!text.startsWith('/')) return false;
  const [cmd, ...rest] = text.slice(1).trim().split(/\s+/);
  if (cmd === 'export') { exportSession((rest[0] || 'md').toLowerCase() === 'json' ? 'json' : 'md'); return true; }
  if (cmd === 'summaries') { openSummaries(); return true; }
  if (cmd === 'compact') { compactSession(); return true; }
  return false;
}

/* ---------- wiring ---------- */

$('providersBtn').addEventListener('click', openProviders);
// editing the endpoint box saves it as the default provider and reloads the model list
// switching model changes the context window: update the badge for the open session
$('model').addEventListener('change', () => { if (!state.streaming) refreshContext(state.sessionId); });
$('endpoint').addEventListener('change', async () => {
  try {
    state.config = await api('/api/config', { method: 'PUT', body: JSON.stringify({ endpoint: $('endpoint').value.trim() }) });
    await loadModels();
  } catch (err) { setStatus(err.message, 'err'); }
});
$('providersCancel').addEventListener('click', () => $('providersDlg').close());
$('providersSave').addEventListener('click', () => saveProviders().catch((e) => alert(e.message)));
$('addProvider').addEventListener('click', () => {
  $('providerRows').insertAdjacentHTML('beforeend', providerRowHtml('', { type: 'openai', endpoint: '' }, false));
  bindProviderRows();
});
$('statusBtn').addEventListener('click', openStatus);
$('quitBtn').addEventListener('click', async () => {
  if (!confirm('Stop the Ollama Forge Studio server? Running work is saved; background processes will be killed.')) return;
  try { await fetch('/api/shutdown', { method: 'POST' }); } catch { /* server already gone */ }
  document.body.innerHTML = '<p style="font:16px system-ui;padding:2rem;color:#aaa">Ollama Forge Studio has stopped. You can close this tab.</p>';
});
$('statusClose').addEventListener('click', () => $('statusDlg').close());
$('mcpReload').addEventListener('click', async () => { $('statusBody').innerHTML = '<div class="hint-line">reconnecting…</div>'; await api('/api/mcp/reload', { method: 'POST', body: '{}' }); openStatus(); });


$('saveConfig').addEventListener('click', saveConfig);
$('settingsBtn').addEventListener('click', openSettings);
if ($('settingsCancel')) $('settingsCancel').addEventListener('click', () => $('settingsDlg').close());
if ($('settingsReset')) $('settingsReset').addEventListener('click', () => resetSettings().catch((e) => setStatus(e.message, 'err')));
if ($('settingsSave')) $('settingsSave').addEventListener('click', () => saveSettings().catch((e) => setStatus(e.message, 'err')));
$('refreshModels').addEventListener('click', loadModels);
$('workDir').addEventListener('click', changeDir);
$('workDir').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); changeDir(); }
});
$('newSession').addEventListener('click', () => { if (!state.streaming) newSession(); });
$('forkSession').addEventListener('click', forkSession);
$('compactSession').addEventListener('click', compactSession);
$('summariesBtn').addEventListener('click', openSummaries);
$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', () => { addFiles($('fileInput').files); $('fileInput').value = ''; });
$('editCancel').addEventListener('click', () => $('editDlg').close());
$('editSave').addEventListener('click', saveEdit);
$('prompt').addEventListener('paste', (e) => { const f = e.clipboardData && e.clipboardData.files; if (f && f.length) { e.preventDefault(); addFiles(f); } });
(function bindDrop() {
  const pane = document.querySelector('.pane.chat');
  let depth = 0;
  const has = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  pane.addEventListener('dragenter', (e) => { if (has(e)) { depth++; pane.classList.add('dropping'); } });
  pane.addEventListener('dragleave', (e) => { if (has(e) && --depth <= 0) { depth = 0; pane.classList.remove('dropping'); } });
  pane.addEventListener('dragover', (e) => { if (has(e)) e.preventDefault(); });
  pane.addEventListener('drop', (e) => { if (!has(e)) return; e.preventDefault(); depth = 0; pane.classList.remove('dropping'); addFiles(e.dataTransfer.files); });
})();
$('summariesClose').addEventListener('click', () => $('summariesDlg').close());
$('exportFromSummaries').addEventListener('click', () => exportSession('md'));
$('undoBtn').addEventListener('click', () => undoRedo('undo'));
$('redoBtn').addEventListener('click', () => undoRedo('redo'));

$('prompt').addEventListener('input', () => {
  const v = $('prompt').value;
  const hint = $('cmdHint');
  if (!v.startsWith('/') || v.includes(' ')) { hint.hidden = true; return; }
  const matches = [...BUILTINS, ...(state.commands || [])].filter((c) => ('/' + c.name).startsWith(v));
  hint.hidden = !matches.length;
  hint.innerHTML = matches.map((c) => `<div><b data-c="${escapeHtml(c.name)}">/${escapeHtml(c.name)}</b> ${escapeHtml(c.description)}</div>`).join('');
  hint.querySelectorAll('b').forEach((b) => b.addEventListener('click', () => { $('prompt').value = '/' + b.dataset.c + ' '; hint.hidden = true; $('prompt').focus(); }));
});
$('refreshTree').addEventListener('click', loadTree);
$('newFile').addEventListener('click', createFile);
$('saveFile').addEventListener('click', saveFile);
$('editor').addEventListener('input', () => setDirty(true));
$('editorClose').addEventListener('click', closeEditor);
$('editorDlg').addEventListener('cancel', (e) => {
  // Escape: keep the dialog open unless the user agrees to lose unsaved edits
  if ($('dirtyDot').classList.contains('on')) { e.preventDefault(); if (confirm('Discard unsaved changes?')) $('editorDlg').close(); }
});

// slide-out panels (only meaningful on narrow screens; harmless on desktop)
$('menuBtn').addEventListener('click', () => (panelsOpen() ? closePanels() : openPanels()));
$('menuClose').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); closePanels(); });
$('menuScrim').addEventListener('click', closePanels);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanels(); });
window.addEventListener('resize', () => { if (window.innerWidth > 900) closePanels(); });

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.streaming) { stopRun(); return; }
  const text = $('prompt').value.trim();
  const files = state.pending.filter((p) => p.status === 'ready');
  if (state.pending.some((p) => p.status === 'uploading')) { setStatus('wait — files are still uploading…', 'busy'); return; }
  if (!text && !files.length) return;
  $('prompt').value = '';
  $('cmdHint').hidden = true;
  if (!files.length && runBuiltin(text)) return;
  state.pending = [];
  renderAttachBar();
  sendChat(text, { attachments: files });
});

$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chatForm').requestSubmit(); }
});

/** Startup failures must be visible (and retryable), never a silently blank page. */
function showFatal(title, err, retry) {
  const box = $('messages');
  box.replaceChildren();
  const d = document.createElement('div');
  d.className = 'hint';
  d.innerHTML = `<b>${escapeHtml(title)}</b><br>${escapeHtml(err && err.message ? err.message : String(err))}<br><br>`;
  const b = document.createElement('button');
  b.className = 'btn small primary';
  b.textContent = 'Try again';
  b.addEventListener('click', retry);
  d.appendChild(b);
  box.appendChild(d);
  setStatus('error', 'err');
}

async function init() {
  try {
    const [, st] = await Promise.all([loadConfig(), api('/api/state')]);
    state.workDir = st.workDir;
    showWorkDir();
    state.commands = st.commands || [];
    fillAgents(st.agents, st.startup.agent || state.config.agent);
    // the slow/flaky parts run side by side: a sleeping model server must not hold up the file list or the sessions
    const results = await Promise.allSettled([loadModels(), loadTree(), loadSessions()]);
    results.forEach((r, i) => { if (r.status === 'rejected') console.warn(['models', 'files', 'sessions'][i] + ' failed to load', r.reason); });
    if (results[1].status === 'rejected') $('tree').innerHTML = `<li class="hint" style="cursor:default">⚠ ${escapeHtml(results[1].reason.message)}</li>`;
    // resume where you left off: `-c` / `-s <id>`, else the last session used in this directory, else the newest
    let last = null;
    try { last = localStorage.getItem('lastSession:' + state.workDir); } catch { /* storage blocked: skip */ }
    const pick = st.startup.sessionId || (state.sessions.find((x) => x.id === last) || state.sessions[0] || {}).id;
    if (pick) { try { await openSession(pick); return; } catch (e) { console.warn('could not reopen the last session', e); } }
    newSession();
  } catch (err) {
    console.error('startup failed', err);
    showFatal('Could not start the studio page', err, () => init());
  }
}
init();

// anything that slips through shows up in the status line (and the console) instead of failing silently
window.addEventListener('unhandledrejection', (e) => { console.error('unhandled rejection', e.reason); setStatus('error: ' + String((e.reason && e.reason.message) || e.reason).slice(0, 80), 'err'); e.preventDefault(); });
window.addEventListener('error', (e) => { console.error('page error', e.error || e.message); });

// coming back to the tab (e.g. after viewing the file server in another tab): re-attach to the running agent
document.addEventListener('visibilitychange', () => { if (!document.hidden && !state.streaming && state.sessionId) resumeIfRunning(); });
window.addEventListener('pageshow', () => { if (!state.streaming && state.sessionId) resumeIfRunning(); });
