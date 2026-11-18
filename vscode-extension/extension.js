'use strict';

// VS Code integration for Ollama Forge Studio. No build step and no dependencies: the extension talks to the studio's
// existing REST + SSE API, opens a chat webview beside the editor, and can start the server itself if it is not running.

const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { StudioClient } = require('./protocol');

let contextRef;
let panel = null;
let client = null;
let baseUrl = '';
let currentSession = null;
let abort = null;
let serverProc = null;
let serverOutput = '';
let starting = null;

function settings() { return vscode.workspace.getConfiguration('ollamaStudio'); }
function configuredUrl() { return String(settings().get('serverUrl') || 'http://127.0.0.1:4310').replace(/\/+$/, ''); }
function sessionKey() { return 'ollamaStudio.sessionId'; }

function persistSession(id) {
  currentSession = id || null;
  try { contextRef.globalState.update(sessionKey(), currentSession); } catch { /* older VS Code */ }
}

function restoreSession() {
  if (currentSession) return currentSession;
  try { currentSession = contextRef.globalState.get(sessionKey()) || null; } catch { currentSession = null; }
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
  const [state, models, config] = await Promise.all([
    client.get('/api/state'),
    client.get('/api/models').catch(() => ({ models: [] })),
    client.get('/api/config').catch(() => ({})),
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
  };
}

async function pushState() {
  if (!panel) return;
  try {
    const state = await getState();
    panel.webview.postMessage({ type: 'state', state });
    if (state.sessionId) await pushHistory(state.sessionId);
  } catch (e) {
    panel.webview.postMessage({ type: 'error', message: String(e && e.message ? e.message : e) });
  }
}

async function pushHistory(sessionId) {
  if (!panel) return;
  try {
    const s = await client.get('/api/sessions/' + encodeURIComponent(sessionId));
    const messages = [];
    for (const m of [...(s.history || []), ...(s.messages || [])]) {
      if (m.summary) continue;
      if (m.role === 'user' && typeof m.content === 'string') messages.push({ role: 'user', text: m.display || m.content });
      else if (m.role === 'assistant' && typeof m.content === 'string') messages.push({ role: 'assistant', text: m.content, thinking: m.thinking || '', tools: [] });
    }
    panel.webview.postMessage({ type: 'history', messages });
  } catch (e) {
    persistSession(null);
    panel.webview.postMessage({ type: 'reset' });
  }
}

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
  header select { max-width: 170px; }
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
  <select id="agent" title="Agent"></select>
  <select id="model" title="Model"></select>
  <button id="new" title="New chat">New</button>
  <button id="stop" title="Stop" disabled>Stop</button>
  <button id="settings" title="Settings">Settings</button>
  <span id="status"></span>
</header>
<main id="messages"></main>
<div class="hint">Enter to send · Shift+Enter for a new line · use the editor command “Send selection to Ollama Studio” to add code.</div>
<footer>
  <textarea id="text" placeholder="Ask Ollama Studio…"></textarea>
  <button id="send" class="primary">Send</button>
</footer>
<script>
const vscode = acquireVsCodeApi();
const state = { agents: [], models: [], messages: [], sessionId: null, busy: false, pendingPermission: null, pendingQuestion: null, status: '', workDir: '', plugins: null, sandbox: null };
const els = {
  messages: document.getElementById('messages'),
  agent: document.getElementById('agent'),
  model: document.getElementById('model'),
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
function renderSelect(select, items, value, labeler) {
  const current = value || select.value;
  select.textContent = '';
  for (const item of items) {
    const name = typeof item === 'string' ? item : item.name;
    if (!name) continue;
    const o = document.createElement('option');
    o.value = name;
    o.textContent = labeler ? labeler(item) : name;
    select.appendChild(o);
  }
  if (current) select.value = current;
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
  els.send.disabled = state.busy;
  els.stop.disabled = !state.busy;
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
  if (ev.type === 'start') { state.sessionId = ev.sessionId; state.status = 'running'; render(); return; }
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
  post({ type: 'send', text: text, agent: els.agent.value, model: els.model.value });
}
els.send.onclick = send;
els.text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
els.stop.onclick = () => post({ type: 'stop' });
els.new.onclick = () => { state.busy = false; state.pendingPermission = null; state.pendingQuestion = null; state.messages = []; state.sessionId = null; state.status = ''; render(); post({ type: 'new' }); };
els.settings.onclick = () => post({ type: 'settings' });
window.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'state') {
    const s = msg.state || {};
    state.agents = s.agents || [];
    state.models = s.models || [];
    state.workDir = s.workDir || '';
    state.plugins = s.plugins || null;
    state.sandbox = s.sandbox || null;
    if (s.sessionId) state.sessionId = s.sessionId;
    if (!state.sessionId) state.messages = [];
    render();
    return;
  }
  if (msg.type === 'history') { state.messages = msg.messages || []; render(); return; }
  if (msg.type === 'reset') { state.messages = []; state.sessionId = null; render(); return; }
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

function createPanel() {
  panel = vscode.window.createWebviewPanel('ollamaStudio.chat', 'Ollama Studio', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.webview.html = getHtml();
  panel.webview.onDidReceiveMessage(onMessage, null, contextRef.subscriptions);
  panel.onDidDispose(() => {
    if (abort) { try { abort.abort(); } catch { /* gone */ } abort = null; }
    panel = null;
  }, null, contextRef.subscriptions);
  pushState();
}

async function openChat() {
  if (!panel) createPanel();
  panel.reveal(vscode.ViewColumn.Beside, true);
  if (panel) pushState();
}

async function runChat({ text, agent, model }) {
  const message = String(text || '').trim();
  if (!message || !panel) return;
  try {
    await ensureServer();
    if (!currentSession) {
      const created = await client.post('/api/sessions', { agent: agent || undefined, model: model || undefined });
      persistSession(created.id);
      panel.webview.postMessage({ type: 'state', state: await getState() });
    }
    abort = new AbortController();
    const ac = abort;
    panel.webview.postMessage({ type: 'busy', busy: true });
    await client.stream('/api/chat', {
      sessionId: currentSession,
      text: message,
      agent: agent || undefined,
      model: model || undefined,
    }, {
      signal: ac.signal,
      onEvent: (ev) => {
        if (ev && ev.type === 'start' && ev.sessionId) persistSession(ev.sessionId);
        if (panel) panel.webview.postMessage({ type: 'event', event: ev });
      },
    });
  } catch (e) {
    if (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || '')))) {
      if (panel) panel.webview.postMessage({ type: 'event', event: { type: 'aborted' } });
    } else if (panel) {
      panel.webview.postMessage({ type: 'error', message: String(e && e.message ? e.message : e) });
    }
  } finally {
    abort = null;
    if (panel) panel.webview.postMessage({ type: 'busy', busy: false });
  }
}

async function onMessage(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'ready') { if (panel) pushState(); return; }
  if (msg.type === 'send') { await runChat(msg); return; }
  if (msg.type === 'stop') { if (abort) abort.abort(); return; }
  if (msg.type === 'new') {
    if (abort) abort.abort();
    persistSession(null);
    if (panel) panel.webview.postMessage({ type: 'reset' });
    return;
  }
  if (msg.type === 'permission') {
    try { await ensureServer(); await client.post('/api/permission', { id: msg.id, reply: msg.reply }); } catch (e) { if (panel) panel.webview.postMessage({ type: 'error', message: e.message }); }
    return;
  }
  if (msg.type === 'answer') {
    try { await ensureServer(); await client.post('/api/answer', { id: msg.id, answer: msg.answer }); } catch (e) { if (panel) panel.webview.postMessage({ type: 'error', message: e.message }); }
    return;
  }
  if (msg.type === 'settings') { await vscode.commands.executeCommand('workbench.action.openSettings', 'ollamaStudio'); return; }
}

function activate(context) {
  contextRef = context;
  restoreSession();
  context.subscriptions.push(vscode.commands.registerCommand('ollamaStudio.openChat', () => openChat()));
  context.subscriptions.push(vscode.commands.registerCommand('ollamaStudio.sendSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showInformationMessage('Open a file first.'); return; }
    const sel = editor.selection;
    const text = sel.isEmpty ? editor.document.lineAt(sel.active.line).text : editor.document.getText(sel);
    if (!text.trim()) { vscode.window.showInformationMessage('Nothing selected.'); return; }
    await openChat();
    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    const block = 'From `' + rel + '`:\n```' + editor.document.languageId + '\n' + text + '\n```';
    if (panel) panel.webview.postMessage({ type: 'insert', text: block });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('ollamaStudio.startServer', async () => {
    try { const url = await ensureServer(); vscode.window.showInformationMessage('Ollama Studio is running at ' + url); }
    catch (e) { vscode.window.showErrorMessage(String(e && e.message ? e.message : e)); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('ollamaStudio.stopServer', () => {
    if (serverProc) { try { serverProc.kill(); } catch { /* gone */ } serverProc = null; client = null; vscode.window.showInformationMessage('Stopped the studio server started by this extension.'); }
    else vscode.window.showInformationMessage('No server started by this extension is running.');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('ollamaStudio.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', 'ollamaStudio')));
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('ollamaStudio.chat', {
    async deserializeWebviewPanel(saved) {
      panel = saved;
      panel.webview.html = getHtml();
      panel.webview.onDidReceiveMessage(onMessage, null, context.subscriptions);
      panel.onDidDispose(() => { panel = null; }, null, context.subscriptions);
      pushState();
    },
  }));
}

function deactivate() {
  if (abort) { try { abort.abort(); } catch { /* gone */ } abort = null; }
  if (serverProc) { try { serverProc.kill(); } catch { /* gone */ } serverProc = null; }
}

module.exports = { activate, deactivate };
