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
  $('sWake').value = String(c.wakeOnProcessExit !== false);
  $('sNetcheck').checked = c.netcheck !== false;
  $('sRemoteSkills').checked = !c.remoteSkills || c.remoteSkills.enabled !== false;
  $('sSkillsRemotesPath').value = (c.skills && c.skills.remotesPath) || '';
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
    $('sWake').value = String(def.wakeOnProcessExit !== false);
    $('sNetcheck').checked = def.netcheck !== false;
    $('sRemoteSkills').checked = !def.remoteSkills || def.remoteSkills.enabled !== false;
    $('sSkillsRemotesPath').value = (def.skills && def.skills.remotesPath) || '';
    const patch = {
      wakeOnProcessExit: def.wakeOnProcessExit,
      netcheck: def.netcheck,
      remoteSkills: def.remoteSkills,
      skills: def.skills,
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
    wakeOnProcessExit: $('sWake').value === 'true',
    netcheck: $('sNetcheck').checked,
    remoteSkills: { ...((state.config && state.config.remoteSkills) || {}), enabled: $('sRemoteSkills').checked },
    skills: { ...((state.config && state.config.skills) || {}), remotesPath: $('sSkillsRemotesPath').value.trim() },
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

/** Auto mode: show which agent is working right now inside the "auto" option ("auto · build"); null resets the label. */
function setAutoActive(name) {
  const o = [...$('agent').options].find((x) => x.value === 'auto');
  if (o) o.textContent = name && name !== 'auto' ? `auto · ${name}` : 'auto';
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
  state.jobs = [];
  renderJobBar();
  applyComposerLock();
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
  setAutoActive(s.agent === 'auto' ? s.autoAgent : null);
  if (s.model) { const opt = [...$('model').options].find((o) => o.value === s.model); if (opt) $('model').value = s.model; }
  renderSession(s);
  pollJobs();
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
    if (m.notice) { addMessage('note', userText(m)).className = 'note'; return; }
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
  // an empty list, or one where everything is done, is not worth a panel
  if (!todos.length || todos.every((t) => t.status === 'completed')) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = '<button type="button" class="todos-close" title="Hide task list" aria-label="Hide task list">✕</button>' + todos.map((t) => {
    const mark = t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▶' : '☐';
    return `<div class="${t.status}">${mark} ${escapeHtml(t.content)}</div>`;
  }).join('');
  el.querySelector('.todos-close').onclick = () => { el.hidden = true; el.innerHTML = ''; };
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
        if (BUILD_PATH.test(node.path)) dl.dataset.build = '1';
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
        if (BUILD_PATH.test(node.path)) dl.dataset.build = '1';
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
