/* Event wiring, background jobs and terminal. Loaded last. */
'use strict';

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
$('skillsBtn').addEventListener('click', openSkills);
$('skillCancel').addEventListener('click', () => $('skillsDlg').close());
$('skillLoad').addEventListener('click', () => loadSkillUrl());
$('skillUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadSkillUrl(); } });
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
  if (myJobs().length) { stopJobs(); return; }       // a background process is running: the only action is Stop
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


/* ---------- background jobs (builds, installs, servers) ----------
   The agent starts a long process and ends its turn; the studio (not the model) tracks it. While one runs for the
   current session the composer is locked to "Stop", a live card shows time / progress / last output line, and when it
   ends the studio wakes the agent (server side) — here we only re-attach to that run or leave a short note. */

const BUILD_PATH = /(^|[\\/])(build|dist|out|target|outputs|\.gradle|\.next)([\\/]|$)/i;
const DEFAULT_PLACEHOLDER = $('prompt').placeholder;
state.jobs = [];
state.jobStatus = false;
const jobsSeen = new Map();       // id -> was running at the previous poll

const myJobs = () => state.jobs.filter((p) => p.running && state.sessionId && p.session_id === state.sessionId);
const jobElapsed = (p) => (p.elapsed_ms || 0) + (Date.now() - (p._at || Date.now()));
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** Send button = Send / Stop; textarea locked while a background process runs (only Stop is possible). */
function applyComposerLock() {
  const locked = !state.streaming && myJobs().length > 0;
  $('prompt').disabled = locked;
  $('attachBtn').disabled = locked;
  $('prompt').placeholder = locked ? 'A background process is running — press Stop to cancel it. The agent reports when it finishes.' : DEFAULT_PLACEHOLDER;
  $('send').textContent = state.streaming || locked ? 'Stop' : 'Send';
  document.body.classList.toggle('jobs-running', state.jobs.some((p) => p.running));
}

function renderJobBar() {
  const bar = $('jobBar');
  const jobs = myJobs();
  if (!jobs.length) { bar.hidden = true; bar.replaceChildren(); return; }
  bar.hidden = false;
  bar.replaceChildren(...jobs.map((p) => {
    const pct = p.progress && p.progress.percent != null ? p.progress.percent : null;
    const el = document.createElement('div');
    el.className = 'job';
    el.innerHTML =
      `<div class="job-head"><span class="job-dot"></span><b>Running</b><span class="job-time">${fmtElapsed(jobElapsed(p))}</span>` +
      (pct != null ? `<span class="job-pct">${pct}%</span>` : '') +
      (p.progress && p.progress.task ? `<span class="job-task">${escapeHtml(p.progress.task)}</span>` : '') +
      `<button class="btn small ghost" type="button" data-jobkill="${escapeHtml(p.id)}">Stop</button></div>` +
      `<code class="job-cmd">${escapeHtml(p.command)}</code>` +
      (pct != null ? `<div class="job-bar"><i style="width:${pct}%"></i></div>` : '') +
      (p.last_line ? `<div class="job-last">${escapeHtml(p.last_line)}</div>` : '');
    return el;
  }));
}

async function killJob(id) {
  try { await api(`/api/processes/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch (e) { setStatus(e.message, 'err'); }
  setStatus('stopping background process…', 'busy');
  state.jobStatus = false;
  setTimeout(pollJobs, 600);
}
const stopJobs = () => Promise.all(myJobs().map((p) => killJob(p.id)));
$('jobBar').addEventListener('click', (e) => { const b = e.target.closest('[data-jobkill]'); if (b) killJob(b.dataset.jobkill); });

async function onJobFinished(p) {
  loadTree().catch(() => {});                       // new build outputs
  await new Promise((r) => setTimeout(r, 1600));    // give the server a moment to start the agent's wake-up turn
  if (state.streaming || p.session_id !== state.sessionId) return;
  let agentRunning = false;
  try { agentRunning = !!(await (await fetch(`/api/processes?sessionId=${encodeURIComponent(state.sessionId)}`)).json()).sessionRunning; } catch { /* offline: just show the note */ }
  if (agentRunning) { resumeIfRunning(); return; }
  const what = p.killed ? '■ stopped' : p.exit_code === 0 ? '✔ finished' : `✖ failed (exit ${p.exit_code})`;
  addMessage('note', `${what} · ${p.id} · ${fmtElapsed(p.elapsed_ms)}`).className = 'note';
}

let jobsPolling = false;
async function pollJobs() {
  if (jobsPolling || document.hidden) return;
  jobsPolling = true;
  try {
    const url = '/api/processes' + (state.sessionId ? `?sessionId=${encodeURIComponent(state.sessionId)}` : '');
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return;
    const r = await res.json();
    const now = Date.now();
    state.jobs = (r.processes || []).map((p) => ({ ...p, _at: now }));
    for (const p of state.jobs) {
      if (jobsSeen.get(p.id) === true && !p.running) onJobFinished(p);
      jobsSeen.set(p.id, p.running);
    }
    renderJobBar();
    applyComposerLock();
    if (!state.streaming) {
      if (myJobs().length) { if (!state.jobStatus) { state.jobStatus = true; setStatus('background process running…', 'busy'); } }
      else if (state.jobStatus) { state.jobStatus = false; setStatus('ready', 'ok'); }
      if (r.sessionRunning) resumeIfRunning();      // the studio started a wake-up turn while this page was idle
    }
  } catch { /* the server is busy or unreachable: try again on the next tick */ }
  finally { jobsPolling = false; }
}
setInterval(pollJobs, 3000);
setInterval(() => { if (myJobs().length) renderJobBar(); }, 1000);     // the clock on the card
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollJobs(); });

/* ---------- terminal (user-run shell commands) ----------
   A direct command runner for the human: each Run starts a fresh shell in the working directory and streams
   stdout/stderr live over SSE. The server owns the process, so output keeps coming (and survives a reload). */

const TERM_MAX_CHARS = 300000;
const TERM_HISTORY_KEY = 'studio.term.history';
const TERM_OPEN_KEY = 'studio.term.open';
state.terminal = { id: null, running: false, es: null, lastSeq: 0 };

const termOut = $('terminalOut');
const termInput = $('terminalCmd');
let termOutChars = 0;

function termAppend(text, cls) {
  if (!text) return;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  termOut.appendChild(span);
  termOutChars += text.length;
  while (termOutChars > TERM_MAX_CHARS && termOut.firstChild) {
    termOutChars -= termOut.firstChild.textContent.length;
    termOut.removeChild(termOut.firstChild);
  }
  termOut.scrollTop = termOut.scrollHeight;
}
function termClear() { termOut.replaceChildren(); termOutChars = 0; }

function termOpen(focus = true) {
  $('terminalPanel').hidden = false;
  try { localStorage.setItem(TERM_OPEN_KEY, '1'); } catch { /* storage blocked */ }
  if (focus) termInput.focus();
}
function termClose() {
  $('terminalPanel').hidden = true;
  try { localStorage.setItem(TERM_OPEN_KEY, '0'); } catch { /* storage blocked */ }
}

function termSetRunning(running) {
  state.terminal.running = running;
  $('terminalStop').disabled = !running;
  $('terminalRun').disabled = running;
  termInput.disabled = running;
  $('terminalStatus').textContent = running ? 'running' : 'idle';
  $('terminalStatus').className = 'status' + (running ? ' busy' : '');
}

function termDisconnect() {
  if (state.terminal.es) { state.terminal.es.close(); state.terminal.es = null; }
}

function termAttach(id) {
  termDisconnect();
  state.terminal.id = id;
  state.terminal.lastSeq = 0;
  const es = new EventSource(`/api/terminal/${encodeURIComponent(id)}/stream`);
  state.terminal.es = es;
  es.onmessage = (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type === 'output') {
      if (ev.seq != null && ev.seq <= state.terminal.lastSeq) return;   // EventSource reconnect: skip the replayed chunks
      if (ev.seq != null) state.terminal.lastSeq = ev.seq;
      termAppend(ev.text, ev.stream === 'stderr' ? 'err' : '');
    } else if (ev.type === 'exit') {
      termAppend(`\n[exit ${ev.code == null ? 'signal' : ev.code}${ev.killed ? ', stopped' : ''} · ${fmtElapsed(ev.durationMs || 0)}]\n`, 'meta');
      termDisconnect();
      termSetRunning(false);
    }
  };
  es.onerror = () => {
    // a network drop reconnects automatically (the replay is de-duplicated by seq); a 404 after a server restart
    // closes the stream for good, so let the input become usable again.
    if (es.readyState === EventSource.CLOSED) {
      termAppend('\n[terminal stream closed]\n', 'meta');
      state.terminal.es = null;
      termSetRunning(false);
    }
  };
  termSetRunning(true);
}

async function termRun(command) {
  termAppend(`$ ${command}\n`, 'cmd');
  const r = await api('/api/terminal', { method: 'POST', body: JSON.stringify({ command }) });
  termAttach(r.id);
}

async function termStop() {
  if (!state.terminal.id) return;
  $('terminalStatus').textContent = 'stopping…';
  $('terminalStatus').className = 'status busy';
  try { await api(`/api/terminal/${encodeURIComponent(state.terminal.id)}`, { method: 'DELETE' }); } catch (e) { termAppend('✖ ' + e.message + '\n', 'err'); }
}

function termHistory() { try { return JSON.parse(localStorage.getItem(TERM_HISTORY_KEY) || '[]'); } catch { return []; } }
let termHistIdx = -1;
function termRemember(command) {
  const h = termHistory().filter((x) => x !== command);
  h.unshift(command);
  try { localStorage.setItem(TERM_HISTORY_KEY, JSON.stringify(h.slice(0, 50))); } catch { /* storage blocked */ }
  termHistIdx = -1;
}

$('terminalBtn').addEventListener('click', () => { if (state.terminal.enabled === false) return; if ($('terminalPanel').hidden) termOpen(); else termClose(); });
$('terminalClose').addEventListener('click', termClose);
$('terminalClear').addEventListener('click', termClear);
$('terminalStop').addEventListener('click', termStop);
$('terminalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const command = termInput.value.trim();
  if (!command || state.terminal.running) return;
  termInput.value = '';
  termRemember(command);
  try { await termRun(command); } catch (err) { termAppend('✖ ' + err.message + '\n', 'err'); termSetRunning(false); }
});
termInput.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const h = termHistory();
  if (!h.length) return;
  e.preventDefault();
  if (e.key === 'ArrowUp') termHistIdx = Math.min(termHistIdx + 1, h.length - 1);
  else termHistIdx = Math.max(termHistIdx - 1, -1);
  termInput.value = termHistIdx === -1 ? '' : h[termHistIdx];
});

/** After a reload, re-attach to a terminal that is still running (the server keeps the process alive). */
async function termRestore() {
  let open = false;
  try { open = localStorage.getItem(TERM_OPEN_KEY) === '1'; } catch { /* storage blocked */ }
  try {
    const r = await api('/api/terminal');
    const all = r.terminals || [];
    const running = all.filter((t) => t.running);
    if (running.length) { termOpen(false); termAttach(running[running.length - 1].id); return; }
    if (open) { termOpen(false); if (all.length) termAttach(all[all.length - 1].id); return; }
  } catch { /* offline: the button still works once the server is back */ }
  if (open) termOpen(false);
}
termRestore();

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
    state.terminal.enabled = st.terminal !== false;
    $('terminalBtn').hidden = !state.terminal.enabled;
    if (!state.terminal.enabled) { termClose(); termDisconnect(); }
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
