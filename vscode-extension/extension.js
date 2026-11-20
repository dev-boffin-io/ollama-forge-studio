'use strict';

const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { StudioClient } = require('./protocol');

let contextRef;
let panel = null;
let chatView = null;
let sessionsView = null;
let client = null;
let baseUrl = '';
let currentSession = null;
let abort = null;
let serverProc = null;
let serverOutput = '';
let starting = null;
let statusBarItem = null;
let lastTextEditor = null;
let activeFile = null;
let activeFileAttached = true;
const chatWebviews = new Set();
const ACTIVE_FILE_SNIPPET_LIMIT = 8000;

function settings() { return vscode.workspace.getConfiguration('ollamaStudio'); }
function configuredUrl() { return String(settings().get('serverUrl') || 'http://127.0.0.1:4310').replace(/\/+$/, ''); }
function sessionKey() { return 'ollamaStudio.sessionId'; }
function activeFileKey() { return 'ollamaStudio.attachActiveFile'; }

function captureActiveFile(editor) {
  const target = editor || lastTextEditor || vscode.window.activeTextEditor;
  if (!target || !target.document) return null;
  const doc = target.document;
  if (doc.uri.scheme !== 'file') return null;
  const sel = target.selection;
  const startLine = Math.min(sel.start.line, sel.end.line) + 1;
  const endLine = Math.max(sel.start.line, sel.end.line) + 1;
  let selected = '';
  try { selected = sel.isEmpty ? doc.lineAt(sel.active.line).text : doc.getText(sel); } catch {}
  return {
    path: doc.uri.fsPath,
    rel: vscode.workspace.asRelativePath(doc.uri, false) || doc.fileName,
    languageId: doc.languageId,
    line: sel.active.line + 1,
    startLine,
    endLine,
    hasSelection: !sel.isEmpty,
    text: selected.slice(0, ACTIVE_FILE_SNIPPET_LIMIT),
    truncated: selected.length > ACTIVE_FILE_SNIPPET_LIMIT,
  };
}

function activeFileContext(file) {
  if (!file) return '';
  const where = file.hasSelection ? `lines ${file.startLine}-${file.endLine}` : `line ${file.line}`;
  const snippet = file.text ? `\n${file.text}` : '';
  const truncated = file.truncated ? '\n[snippet truncated]' : '';
  return `[Active file: ${file.rel} (${file.languageId}), ${where}]\n${snippet}${truncated}\n[/Active file]`;
}

function broadcastActiveFile() {
  postChat({ type: 'active_file', activeFile, attached: activeFileAttached });
}

function updateActiveFile(editor) {
  if (editor) lastTextEditor = editor;
  activeFile = captureActiveFile(lastTextEditor || editor);
  broadcastActiveFile();
}

function persistSession(id) {
  currentSession = id || null;
  try { contextRef.workspaceState.update(sessionKey(), currentSession); } catch { currentSession = id || null; }
}

function restoreSession() {
  if (currentSession) return currentSession;
  try { currentSession = contextRef.workspaceState.get(sessionKey()) || null; } catch { currentSession = null; }
  return currentSession;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label || 'operation'} timed out after ${ms}ms`)), ms); }),
  ]);
}

async function healthy(url, timeoutMs = 1500) {
  try {
    const c = new StudioClient(url);
    await withTimeout(c.get('/api/health'), timeoutMs, 'health check');
    return true;
  } catch { return false; }
}

async function ensureServer() {
  if (client && baseUrl && await healthy(baseUrl)) return baseUrl;
  const wanted = configuredUrl();
  if (await healthy(wanted)) {
    baseUrl = wanted;
    client = new StudioClient(baseUrl);
    return baseUrl;
  }
  if (settings().get('autoStart') === false) throw new Error(`Ollama Studio is not running at ${wanted}. Start it or enable ollamaStudio.autoStart.`);
  if (starting) return starting;
  starting = (async () => {
    const serverPath = String(settings().get('serverPath') || path.resolve(contextRef.extensionPath, '..', 'server.js'));
    if (!fs.existsSync(serverPath)) throw new Error(`server not found: ${serverPath} (set ollamaStudio.serverPath)`);
    const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    const dir = folder ? folder.uri.fsPath : process.cwd();
    const isJs = /\.(?:c?js)$/i.test(serverPath);
    const nodePath = String(settings().get('nodePath') || 'node');
    const args = isJs
      ? [serverPath, '--port', '0', '--host', '127.0.0.1', '--dir', dir]
      : ['--port', '0', '--host', '127.0.0.1', '--dir', dir];
    const cmd = isJs ? nodePath : serverPath;
    serverOutput = '';
    const child = spawn(cmd, args, { cwd: dir, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    serverProc = child;
    let url = '';
    const found = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the studio did not start within 20s.\n${serverOutput.slice(-2000)}`)), 20000);
      const onData = (d) => {
        const text = d.toString();
        serverOutput = (serverOutput + text).slice(-8000);
        const m = /url:\s+(http:\/\/\S+)/.exec(text);
        if (m) { url = m[1].replace(/\/+$/, ''); clearTimeout(timer); resolve(url); }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('exit', (code) => { if (!url) { clearTimeout(timer); reject(new Error(`the studio exited (${code}).\n${serverOutput.slice(-2000)}`)); } });
    });
    baseUrl = await found;
    client = new StudioClient(baseUrl);
    child.on('exit', () => { if (serverProc === child) { serverProc = null; client = null; } });
    return baseUrl;
  })().finally(() => { starting = null; });
  return starting;
}

async function getState() {
  await ensureServer();
  const [state, models, config, sessions] = await Promise.all([
    client.get('/api/state'),
    client.get('/api/models').catch(() => ({ models: [] })),
    client.get('/api/config').catch(() => ({})),
    client.get('/api/sessions').catch(() => ({ sessions: [] })),
  ]);
  return {
    workDir: state.workDir,
    agents: state.agents || [],
    subagents: state.subagents || [],
    models: (models.models || []).map((m) => (typeof m === 'string' ? m : (m.name || m.id || ''))).filter(Boolean),
    config,
    plugins: state.plugins || null,
    sandbox: state.sandbox || null,
    sessionId: restoreSession(),
    sessions: sessions.sessions || [],
    activeFile,
    attached: activeFileAttached,
  };
}

function safeSetHtml(webview, html) {
  try { webview.html = html; return true; } catch { return false; }
}

function safePost(webview, msg, onFail) {
  const fail = () => { chatWebviews.delete(webview); if (onFail) onFail(); };
  try {
    const result = webview.postMessage(msg);
    if (result && typeof result.then === 'function') result.then(undefined, fail);
    return true;
  } catch { fail(); return false; }
}

function registerChatWebview(webview) {
  chatWebviews.add(webview);
}

function postChat(msg) {
  for (const webview of [...chatWebviews]) safePost(webview, msg);
}

async function refreshAll() {
  await pushState();
  if (sessionsView) await sessionsView.refresh();
}

async function pushState() {
  try {
    const state = await getState();
    postChat({ type: 'state', state });
    if (state.sessionId) await pushHistory(state.sessionId);
    else postChat({ type: 'history', messages: [] });
  } catch (e) {
    postChat({ type: 'error', message: String(e && e.message ? e.message : e) });
  }
}

async function pushHistory(sessionId) {
  try {
    const s = await client.get('/api/sessions/' + encodeURIComponent(sessionId));
    const messages = [];
    for (const m of [...(s.history || []), ...(s.messages || [])]) {
      if (m.summary) continue;
      if (m.role === 'user' && typeof m.content === 'string') messages.push({ role: 'user', text: m.display || m.content });
      else if (m.role === 'assistant' && typeof m.content === 'string') messages.push({ role: 'assistant', text: m.content, thinking: m.thinking || '', tools: [] });
    }
    postChat({ type: 'history', messages });
  } catch (e) {
    persistSession(null);
    postChat({ type: 'reset' });
  }
}

async function switchSession(id) {
  if (abort) { try { abort.abort(); } catch {} abort = null; }
  persistSession(id || null);
  postChat({ type: 'reset' });
  await refreshAll();
}

async function newChat() { await switchSession(null); }

function getHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ollama Studio</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: flex; flex-direction: column; font: 13px/1.45 var(--vscode-font-family, system-ui, sans-serif); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  header { display: flex; gap: 6px; align-items: center; padding: 7px 9px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
  header select { max-width: 100%; }
  .header-row { display: flex; gap: 6px; width: 100%; }
  .session-row { display: flex; gap: 6px; width: 100%; }
  .session-row select { flex: 1; min-width: 0; }
  .file-row { width: 100%; }
  #file { width: 100%; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; }
  #file.attached { border-color: var(--vscode-focusBorder); }
  .header-row select { flex: 1; min-width: 0; }
  select, button, input, textarea { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; padding: 4px 6px; }
  button { cursor: pointer; background: var(--vscode-button-secondaryBackground, var(--vscode-input-background)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:disabled { opacity: .5; cursor: default; }
  #status { margin-left: auto; opacity: .75; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 46%; }
  main { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .msg { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 8px 10px; max-width: 100%; }
  .msg.user { background: color-mix(in srgb, var(--vscode-textLink-foreground) 10%, transparent); }
  .msg.assistant { background: color-mix(in srgb, var(--vscode-editor-foreground) 4%, transparent); }
  .msg.error { border-color: var(--vscode-errorForeground); }
  .role { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; opacity: .65; margin-bottom: 4px; }
  .body, pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
  details { margin-top: 6px; }
  summary { cursor: pointer; opacity: .8; font-size: 11px; }
  .tool { margin-top: 6px; border-left: 2px solid var(--vscode-panel-border); padding-left: 7px; }
  .toolname { font-weight: 600; font-size: 11px; opacity: .85; }
  pre { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.12)); padding: 6px; border-radius: 4px; margin-top: 4px; max-height: 260px; overflow: auto; }
  .prompt { border: 1px solid var(--vscode-focusBorder); border-radius: 8px; padding: 9px; background: var(--vscode-editorWidget-background, transparent); }
  .prompt .row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 7px; }
  footer { border-top: 1px solid var(--vscode-panel-border); padding: 8px; display: flex; gap: 7px; align-items: flex-end; }
  #text { flex: 1; min-height: 52px; max-height: 220px; resize: vertical; }
  #send { min-width: 64px; }
  .hint { opacity: .6; font-size: 10px; padding: 0 10px 7px; }
</style>
</head>
<body>
<header>
  <div class="file-row"><button id="file" title="Attach or detach the active file"></button></div>
  <div class="session-row">
    <select id="session" title="Chat in this folder"></select>
    <button id="new" title="New chat">New</button>
  </div>
  <div class="header-row">
    <select id="agent" title="Agent"></select>
    <select id="model" title="Model"></select>
    <button id="stop" title="Stop" disabled>Stop</button>
    <button id="settings" title="Settings">Settings</button>
  </div>
  <span id="status"></span>
</header>
<main id="messages"></main>
<div class="hint">Enter to send · Shift+Enter for a new line · active file is attached automatically; click the file chip to detach.</div>
<footer>
  <textarea id="text" placeholder="Ask Ollama Studio…"></textarea>
  <button id="send" class="primary">Send</button>
</footer>
<script>
const vscode = acquireVsCodeApi();
const state = { agents: [], models: [], sessions: [], messages: [], sessionId: null, busy: false, pendingPermission: null, pendingQuestion: null, status: '', workDir: '', plugins: null, sandbox: null, activeFile: null, attached: true };
const els = {
  messages: document.getElementById('messages'),
  agent: document.getElementById('agent'),
  model: document.getElementById('model'),
  session: document.getElementById('session'),
  file: document.getElementById('file'),
  status: document.getElementById('status'),
  text: document.getElementById('text'),
  send: document.getElementById('send'),
  stop: document.getElementById('stop'),
  new: document.getElementById('new'),
  settings: document.getElementById('settings'),
};
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function post(msg) { vscode.postMessage(msg); }
function ensureAssistant() {
  let m = state.messages[state.messages.length - 1];
  if (!m || m.role !== 'assistant') { m = { role: 'assistant', text: '', thinking: '', tools: [] }; state.messages.push(m); }
  return m;
}
function addInfo(text, cls) { state.messages.push({ role: cls || 'info', text: String(text || ''), tools: [] }); }
function relativeTime(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - Number(ts)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function sessionLabel(s) {
  const bits = [s.agent, s.messageCount != null ? s.messageCount + ' msg' + (s.messageCount === 1 ? '' : 's') : '', relativeTime(s.updatedAt)].filter(Boolean);
  return (s.title || 'Untitled chat') + (bits.length ? ' — ' + bits.join(' · ') : '');
}
function sessionOptions() {
  const rows = (state.sessions || []).slice();
  if (state.sessionId && !rows.some((s) => s.id === state.sessionId)) rows.unshift({ id: state.sessionId, title: 'Current chat' });
  rows.unshift({ id: '', title: 'New chat' });
  return rows;
}
function renderSelect(select, items, value, labeler, valueOf) {
  const current = (value !== undefined && value !== null) ? value : select.value;
  select.textContent = '';
  for (const item of items) {
    const name = valueOf ? valueOf(item) : (typeof item === 'string' ? item : item.name);
    if (name === undefined || name === null) continue;
    const o = document.createElement('option');
    o.value = name;
    o.textContent = labeler ? labeler(item) : name;
    select.appendChild(o);
  }
  if (current !== undefined && current !== null) select.value = current;
}
function renderMessages() {
  els.messages.textContent = '';
  for (const m of state.messages) {
    const wrap = el('div', 'msg ' + (m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : m.role === 'error' ? 'error' : ''));
    wrap.appendChild(el('div', 'role', m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Studio' : m.role === 'error' ? 'Error' : 'Studio'));
    if (m.thinking) {
      const d = el('details', 'thinking');
      d.appendChild(el('summary', '', 'thinking'));
      d.appendChild(el('div', 'body', m.thinking));
      wrap.appendChild(d);
    }
    if (m.text) wrap.appendChild(el('div', 'body', m.text));
    if (m.tools && m.tools.length) {
      const d = el('details', 'tools');
      d.appendChild(el('summary', '', 'tools (' + m.tools.length + ')'));
      for (const t of m.tools) {
        const td = el('div', 'tool');
        td.appendChild(el('div', 'toolname', t.name + (t.ok === false ? ' · error' : '')));
        if (t.args) td.appendChild(el('pre', '', t.args));
        if (t.result) td.appendChild(el('pre', '', t.result));
        d.appendChild(td);
      }
      wrap.appendChild(d);
    }
    els.messages.appendChild(wrap);
  }
  if (state.pendingPermission) {
    const p = state.pendingPermission;
    const card = el('div', 'prompt');
    card.appendChild(el('div', '', 'Permission: ' + (p.summary || p.tool || 'tool call')));
    const row = el('div', 'row');
    const once = el('button', 'primary', 'Allow once');
    const always = el('button', '', 'Always');
    const reject = el('button', '', 'Reject');
    const answer = (reply) => { state.pendingPermission = null; render(); post({ type: 'permission', id: p.id, reply: reply }); };
    once.onclick = () => answer('once');
    always.onclick = () => answer('always');
    reject.onclick = () => answer('reject');
    row.appendChild(once); row.appendChild(always); row.appendChild(reject);
    card.appendChild(row);
    els.messages.appendChild(card);
  }
  if (state.pendingQuestion) {
    const q = state.pendingQuestion;
    const card = el('div', 'prompt');
    card.appendChild(el('div', '', q.question || 'The agent has a question.'));
    const row = el('div', 'row');
    for (const opt of (q.options || [])) {
      const b = el('button', '', opt);
      b.onclick = () => { const id = q.id; state.pendingQuestion = null; render(); post({ type: 'answer', id: id, answer: opt }); };
      row.appendChild(b);
    }
    const input = document.createElement('input');
    input.placeholder = 'Type an answer…';
    const submit = el('button', 'primary', 'Answer');
    submit.onclick = () => { const id = q.id; const answer = input.value; state.pendingQuestion = null; render(); post({ type: 'answer', id: id, answer: answer }); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit.click(); });
    row.appendChild(input); row.appendChild(submit);
    card.appendChild(row);
    els.messages.appendChild(card);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}
function renderActiveFile() {
  const f = state.activeFile;
  if (!f) {
    els.file.textContent = 'No active file';
    els.file.title = 'Open a file to attach it';
    els.file.className = '';
    return;
  }
  const where = f.hasSelection ? f.startLine + '-' + f.endLine : String(f.line);
  els.file.textContent = (state.attached ? 'Active file: ' : 'Detached: ') + f.rel + ':' + where;
  els.file.title = state.attached
    ? 'Click to detach ' + f.rel
    : 'Click to attach ' + f.rel;
  els.file.className = state.attached ? 'attached' : '';
}
function renderStatus() {
  const bits = [];
  if (state.workDir) bits.push(state.workDir);
  if (state.sessionId) bits.push(state.sessionId);
  if (state.sandbox && state.sandbox.enabled) bits.push('sandbox:' + (state.sandbox.available ? 'on' : 'unavailable'));
  if (state.plugins && state.plugins.plugins) bits.push('plugins:' + state.plugins.plugins.length);
  if (state.status) bits.push(state.status);
  els.status.textContent = bits.join(' · ');
}
function render() {
  renderSelect(els.agent, state.agents, els.agent.value, (a) => a.name + (a.description ? ' — ' + a.description : ''));
  renderSelect(els.model, state.models, els.model.value);
  renderSelect(els.session, sessionOptions(), state.sessionId || '', sessionLabel, (s) => s.id);
  els.send.disabled = state.busy;
  els.stop.disabled = !state.busy;
  renderActiveFile();
  renderStatus();
  renderMessages();
}
function handleEvent(ev) {
  if (!ev || !ev.type) return;
  if (ev.type === 'token') { ensureAssistant().text += ev.text || ''; render(); return; }
  if (ev.type === 'thinking') { ensureAssistant().thinking += ev.text || ''; render(); return; }
  if (ev.type === 'tool_call') {
    const a = ensureAssistant();
    a.tools = a.tools || [];
    a.tools.push({ id: ev.id, name: ev.name, args: ev.args ? JSON.stringify(ev.args, null, 2) : '' });
    render(); return;
  }
  if (ev.type === 'tool_result') {
    for (const m of state.messages) {
      const t = (m.tools || []).find((x) => x.id === ev.id);
      if (t) { t.ok = ev.ok !== false; t.result = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result, null, 2); break; }
    }
    render(); return;
  }
  if (ev.type === 'permission_request') { state.pendingPermission = ev; render(); return; }
  if (ev.type === 'permission_resolved') { if (state.pendingPermission && state.pendingPermission.id === ev.id) state.pendingPermission = null; render(); return; }
  if (ev.type === 'question') { state.pendingQuestion = ev; render(); return; }
  if (ev.type === 'question_resolved') { if (state.pendingQuestion && state.pendingQuestion.id === ev.id) state.pendingQuestion = null; render(); return; }
  if (ev.type === 'start') {
    state.sessionId = ev.sessionId;
    if (ev.sessionId && !state.sessions.some((s) => s.id === ev.sessionId)) state.sessions.unshift({ id: ev.sessionId, title: 'Current chat' });
    state.status = 'running'; render(); return;
  }
  if (ev.type === 'done') { state.busy = false; state.status = ev.truncated ? 'step limit' : 'done'; render(); return; }
  if (ev.type === 'aborted') { state.busy = false; state.status = 'stopped'; addInfo('Stopped.', 'info'); render(); return; }
  if (ev.type === 'error') { state.busy = false; state.status = 'error'; addInfo(ev.message || 'unknown error', 'error'); render(); return; }
  if (ev.type === 'info' || ev.type === 'warning') { addInfo(ev.text || ev.message || '', 'info'); render(); return; }
  if (ev.type === 'agent') { state.status = 'agent: ' + (ev.name || ''); render(); return; }
  if (ev.type === 'retry') { state.status = 'retrying (' + ev.attempt + '/' + ev.max + ')'; render(); return; }
  if (ev.type === 'compacting') { state.status = 'compacting context'; render(); return; }
  if (ev.type === 'metrics') { state.status = 'running'; render(); return; }
  if (ev.type === 'subagent') { state.status = 'subagent ' + ev.phase + ': ' + (ev.agent || ''); render(); return; }
}
function send() {
  const text = els.text.value.trim();
  if (!text || state.busy) return;
  els.text.value = '';
  state.busy = true;
  state.messages.push({ role: 'user', text: text, tools: [] });
  render();
  post({ type: 'send', text: text, agent: els.agent.value, model: els.model.value, attachFile: state.attached });
}
els.send.onclick = send;
els.text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
els.stop.onclick = () => post({ type: 'stop' });
els.new.onclick = () => { post({ type: 'new' }); };
els.settings.onclick = () => post({ type: 'settings' });
els.session.onchange = () => { const id = els.session.value; if (id !== (state.sessionId || '')) post({ type: 'switch_session', sessionId: id }); };
els.file.onclick = () => post({ type: 'toggle_active_file' });
window.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'state') {
    const s = msg.state || {};
    state.agents = s.agents || [];
    state.models = s.models || [];
    state.sessions = s.sessions || [];
    state.workDir = s.workDir || '';
    state.plugins = s.plugins || null;
    state.sandbox = s.sandbox || null;
    state.activeFile = s.activeFile || null;
    state.attached = s.attached !== false;
    state.sessionId = s.sessionId || null;
    if (!state.sessionId) state.messages = [];
    render();
    return;
  }
  if (msg.type === 'active_file') { state.activeFile = msg.activeFile || null; state.attached = !!msg.attached; render(); return; }
  if (msg.type === 'history') { state.messages = msg.messages || []; render(); return; }
  if (msg.type === 'reset') { state.messages = []; state.sessionId = null; state.status = ''; state.busy = false; render(); return; }
  if (msg.type === 'event') { handleEvent(msg.event); return; }
  if (msg.type === 'user') { state.messages.push({ role: 'user', text: msg.text, tools: [] }); render(); return; }
  if (msg.type === 'busy') { state.busy = !!msg.busy; render(); return; }
  if (msg.type === 'error') { state.busy = false; addInfo(msg.message || 'error', 'error'); render(); return; }
  if (msg.type === 'insert') { els.text.value = (els.text.value ? els.text.value + '\\n\\n' : '') + msg.text; els.text.focus(); return; }
});
render();
post({ type: 'ready' });
</script>
</body>
</html>`;
}

function getSessionsHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chats</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 12px/1.4 var(--vscode-font-family, system-ui, sans-serif); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
  header { display: flex; gap: 5px; padding: 7px; border-bottom: 1px solid var(--vscode-panel-border); }
  button { font: inherit; cursor: pointer; color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, var(--vscode-input-background)); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 3px 7px; }
  #folder { padding: 6px 8px; opacity: .65; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #list { display: flex; flex-direction: column; gap: 4px; padding: 4px 6px 10px; }
  .chat { text-align: left; width: 100%; border-color: transparent; background: transparent; padding: 6px 7px; display: flex; flex-direction: column; gap: 2px; }
  .chat:hover { background: var(--vscode-list-hoverBackground); }
  .chat.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .chat .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chat .meta { font-size: 10px; opacity: .7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #empty { padding: 10px 8px; opacity: .7; }
  #error { padding: 6px 8px; color: var(--vscode-errorForeground); font-size: 11px; }
</style>
</head>
<body>
<header><button id="new" title="New chat">+ New</button><button id="refresh" title="Refresh chats">↻</button></header>
<div id="folder"></div>
<div id="error"></div>
<div id="list"></div>
<div id="empty" hidden>No chats in this folder yet.</div>
<script>
const vscode = acquireVsCodeApi();
const state = { sessions: [], sessionId: null, workDir: '' };
const list = document.getElementById('list');
const empty = document.getElementById('empty');
const folder = document.getElementById('folder');
const error = document.getElementById('error');
function post(msg) { vscode.postMessage(msg); }
function relativeTime(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - Number(ts)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function render() {
  folder.textContent = state.workDir || '';
  error.textContent = '';
  list.textContent = '';
  const rows = state.sessions || [];
  empty.hidden = rows.length > 0;
  for (const s of rows) {
    const b = document.createElement('button');
    b.className = 'chat' + (s.id === state.sessionId ? ' active' : '');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = s.title || 'Untitled chat';
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = [s.agent, s.messageCount != null ? s.messageCount + ' msg' + (s.messageCount === 1 ? '' : 's') : '', relativeTime(s.updatedAt), s.running ? 'running' : ''].filter(Boolean).join(' · ');
    b.appendChild(title); b.appendChild(meta);
    b.onclick = () => post({ type: 'open', id: s.id });
    list.appendChild(b);
  }
}
document.getElementById('new').onclick = () => post({ type: 'new' });
document.getElementById('refresh').onclick = () => post({ type: 'refresh' });
window.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'sessions') {
    state.sessions = msg.sessions || [];
    state.sessionId = msg.sessionId || null;
    state.workDir = msg.workDir || '';
    render(); return;
  }
  if (msg.type === 'error') { error.textContent = msg.message || 'error'; return; }
});
render();
post({ type: 'ready' });
</script>
</body>
</html>`;
}

class ChatViewProvider {
  resolveWebviewView(view) {
    view.webview.options = { enableScripts: true };
    if (!safeSetHtml(view.webview, getHtml())) return;
    registerChatWebview(view.webview);
    if (typeof view.onDidDispose === 'function') {
      view.onDidDispose(() => chatWebviews.delete(view.webview), null, contextRef.subscriptions);
    }
    view.webview.onDidReceiveMessage(onMessage, null, contextRef.subscriptions);
    pushState();
  }
}

class SessionsViewProvider {
  constructor() { this._view = null; }

  resolveWebviewView(view) {
    view.webview.options = { enableScripts: true };
    if (!safeSetHtml(view.webview, getSessionsHtml())) return;
    this._view = view;
    if (typeof view.onDidDispose === 'function') {
      view.onDidDispose(() => { if (this._view === view) this._view = null; }, null, contextRef.subscriptions);
    }
    view.webview.onDidReceiveMessage((msg) => this._onMessage(msg), null, contextRef.subscriptions);
    this.refresh();
  }

  async refresh() {
    const view = this._view;
    if (!view) return;
    const cleared = () => { if (this._view === view) this._view = null; };
    try {
      const state = await getState();
      if (this._view !== view) return;
      if (!safePost(view.webview, { type: 'sessions', sessions: state.sessions, sessionId: state.sessionId, workDir: state.workDir }, cleared)) cleared();
    } catch (e) {
      if (this._view === view && !safePost(view.webview, { type: 'error', message: String(e && e.message ? e.message : e) }, cleared)) cleared();
    }
  }

  async _onMessage(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'ready' || msg.type === 'refresh') { await this.refresh(); return; }
    if (msg.type === 'new') { await newChat(); await openChat(); return; }
    if (msg.type === 'open') { await switchSession(msg.id); await openChat(); }
  }
}

function createPanel() {
  const created = vscode.window.createWebviewPanel('ollamaStudio.chat', 'Ollama Studio', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  if (!safeSetHtml(created.webview, getHtml())) { try { created.dispose(); } catch {} return; }
  panel = created;
  registerChatWebview(created.webview);
  created.webview.onDidReceiveMessage(onMessage, null, contextRef.subscriptions);
  created.onDidDispose(() => {
    chatWebviews.delete(created.webview);
    if (panel === created) panel = null;
  }, null, contextRef.subscriptions);
  pushState();
}

async function openChat() {
  if (!panel) createPanel();
  if (!panel) return;
  try { panel.reveal(vscode.ViewColumn.Beside, true); }
  catch { panel = null; createPanel(); if (!panel) return; }
  await pushState();
}

async function runChat({ text, agent, model, attachFile }) {
  const message = String(text || '').trim();
  if (!message) return;
  const file = attachFile === false ? null : (captureActiveFile() || activeFile);
  const context = activeFileContext(file);
  const prompt = context ? `${context}\n\n${message}` : message;
  try {
    await ensureServer();
    if (!currentSession) {
      const created = await client.post('/api/sessions', { agent: agent || undefined, model: model || undefined });
      persistSession(created.id);
      await refreshAll();
    }
    abort = new AbortController();
    const ac = abort;
    postChat({ type: 'busy', busy: true });
    await client.stream('/api/chat', {
      sessionId: currentSession,
      text: prompt,
      agent: agent || undefined,
      model: model || undefined,
    }, {
      signal: ac.signal,
      onEvent: (ev) => {
        if (ev && ev.type === 'start' && ev.sessionId) {
          persistSession(ev.sessionId);
          if (sessionsView) sessionsView.refresh();
        }
        postChat({ type: 'event', event: ev });
      },
    });
  } catch (e) {
    if (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || '')))) {
      postChat({ type: 'event', event: { type: 'aborted' } });
    } else {
      postChat({ type: 'error', message: String(e && e.message ? e.message : e) });
    }
  } finally {
    abort = null;
    postChat({ type: 'busy', busy: false });
    await refreshAll();
  }
}

async function onMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'ready') { await pushState(); return; }
  if (msg.type === 'send') { await runChat(msg); return; }
  if (msg.type === 'stop') { if (abort) abort.abort(); return; }
  if (msg.type === 'new') { await newChat(); return; }
  if (msg.type === 'switch_session') { await switchSession(msg.sessionId); return; }
  if (msg.type === 'toggle_active_file') { await vscode.commands.executeCommand('ollamaStudio.toggleActiveFile'); return; }
  if (msg.type === 'permission') {
    try { await ensureServer(); await client.post('/api/permission', { id: msg.id, reply: msg.reply }); }
    catch (e) { postChat({ type: 'error', message: String(e && e.message ? e.message : e) }); }
    return;
  }
  if (msg.type === 'answer') {
    try { await ensureServer(); await client.post('/api/answer', { id: msg.id, answer: msg.answer }); }
    catch (e) { postChat({ type: 'error', message: String(e && e.message ? e.message : e) }); }
    return;
  }
  if (msg.type === 'settings') { await vscode.commands.executeCommand('workbench.action.openSettings', 'ollamaStudio'); }
}

function activate(context) {
  contextRef = context;
  restoreSession();
  try { activeFileAttached = context.workspaceState.get(activeFileKey()) !== false; } catch { activeFileAttached = true; }
  lastTextEditor = vscode.window.activeTextEditor || null;
  activeFile = captureActiveFile(lastTextEditor);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.name = 'Ollama Studio';
  statusBarItem.text = '$(robot) Ollama Studio';
  statusBarItem.tooltip = 'Open Ollama Studio chat';
  statusBarItem.command = 'ollamaStudio.openChat';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  chatView = new ChatViewProvider();
  sessionsView = new SessionsViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ollamaStudio.chatView', chatView),
    vscode.window.registerWebviewViewProvider('ollamaStudio.sessionsView', sessionsView)
  );

  context.subscriptions.push(vscode.commands.registerCommand('ollamaStudio.openChat', () => openChat()));
  context.subscriptions.push(vscode.commands.registerCommand('ollamaStudio.newChat', async () => { await newChat(); await openChat(); }));
  context.subscriptions.push(vscode.commands.registerCommand('ollamaStudio.refreshSessions', () => sessionsView && sessionsView.refresh()));
  context.subscriptions.push(vscode.commands.registerCommand('ollamaStudio.toggleActiveFile', async () => {
    activeFileAttached = !activeFileAttached;
    try { await context.workspaceState.update(activeFileKey(), activeFileAttached); } catch {}
    broadcastActiveFile();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('ollamaStudio.sendSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showInformationMessage('Open a file first.'); return; }
    const sel = editor.selection;
    const text = sel.isEmpty ? editor.document.lineAt(sel.active.line).text : editor.document.getText(sel);
    if (!text.trim()) { vscode.window.showInformationMessage('Nothing selected.'); return; }
    await openChat();
    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    const block = 'From `' + rel + '`:\n```' + editor.document.languageId + '\n' + text + '\n```';
    postChat({ type: 'insert', text: block });
  }));

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => updateActiveFile(editor)));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection((e) => {
    if (e.textEditor === lastTextEditor || e.textEditor === vscode.window.activeTextEditor) updateActiveFile(e.textEditor);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    if (lastTextEditor && e.document === lastTextEditor.document) updateActiveFile(lastTextEditor);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('ollamaStudio.startServer', async () => {
    try { const url = await ensureServer(); vscode.window.showInformationMessage('Ollama Studio is running at ' + url); }
    catch (e) { vscode.window.showErrorMessage(String(e && e.message ? e.message : e)); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('ollamaStudio.stopServer', () => {
    if (serverProc) { try { serverProc.kill(); } catch {} serverProc = null; client = null; vscode.window.showInformationMessage('Stopped the studio server started by this extension.'); }
    else vscode.window.showInformationMessage('No server started by this extension is running.');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('ollamaStudio.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'ollamaStudio')));

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async () => {
    if (serverProc) { try { serverProc.kill(); } catch {} serverProc = null; }
    client = null;
    baseUrl = '';
    persistSession(null);
    postChat({ type: 'reset' });
    await refreshAll();
  }));

  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('ollamaStudio.chat', {
    async deserializeWebviewPanel(saved) {
      if (!safeSetHtml(saved.webview, getHtml())) return;
      panel = saved;
      registerChatWebview(saved.webview);
      saved.webview.onDidReceiveMessage(onMessage, null, context.subscriptions);
      saved.onDidDispose(() => {
        chatWebviews.delete(saved.webview);
        if (panel === saved) panel = null;
      }, null, context.subscriptions);
      pushState();
    },
  }));
}

function deactivate() {
  if (abort) { try { abort.abort(); } catch {} abort = null; }
  if (serverProc) { try { serverProc.kill(); } catch {} serverProc = null; }
}

module.exports = { activate, deactivate };
