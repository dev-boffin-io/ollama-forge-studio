/* Providers, tools, attachments, message menu and slash commands. Loaded after app-chat.js. */
'use strict';

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

function openSkills() {
  const dlg = $('skillsDlg');
  const msg = $('skillMsg');
  msg.className = 'hint-line';
  msg.textContent = '';
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  $('skillUrl').focus();
}

async function loadSkillUrl() {
  const msg = $('skillMsg');
  const btn = $('skillLoad');
  const url = $('skillUrl').value.trim();
  msg.className = 'hint-line';
  msg.textContent = '';
  if (!/^https?:\/\//i.test(url)) {
    msg.className = 'hint-line err';
    msg.textContent = 'Enter a URL that starts with http:// or https://';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const r = await api('/api/skills/load', { method: 'POST', body: JSON.stringify({ url, skill: $('skillName').value.trim(), sessionId: state.sessionId, model: $('model').value, agent: $('agent').value }) });
    $('skillsDlg').close();
    $('skillUrl').value = '';
    $('skillName').value = '';
    await openSession(r.sessionId);
    setStatus(`skill loaded: ${r.name}`, 'ok');
  } catch (err) {
    msg.className = 'hint-line err';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load';
  }
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
      if (!res.ok) throw new Error(res.status === 403 ? (data.error || 'forbidden') + ' — reload the page (Ctrl+F5) and try again' : (data.error || `HTTP ${res.status}`));
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

/** Lets the user select words/sentences inside one message (touch devices). */
function selectMessageText(el) {
  document.querySelectorAll('.msg.selectable').forEach(n => n.classList.remove('selectable'));
  el.classList.add('selectable');
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
  flash('select the text you need, then copy');
}

// Drop the "selectable" mode once the selection is gone or the user taps elsewhere.
document.addEventListener('selectionchange', () => {
  const s = window.getSelection();
  if (!s || s.toString().trim()) return;
  document.querySelectorAll('.msg.selectable').forEach(n => n.classList.remove('selectable'));
});
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.msg.selectable, #ctxMenu')) return;
  document.querySelectorAll('.msg.selectable').forEach(n => n.classList.remove('selectable'));
}, true);

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
    { label: 'Select text', run: () => selectMessageText(el) },
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
      const s = window.getSelection && window.getSelection();
      if (s && s.toString().trim()) { clear(); return; }      // user is selecting text natively: no menu
      press.fired = true; el.classList.remove('pressing');
      if (navigator.vibrate) navigator.vibrate(12);
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
    if (sel || el.classList.contains('selectable')) return;      // text selected: keep the browser's own Copy menu
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
