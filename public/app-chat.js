/* Chat rendering and streaming. Loaded after app.js; shares its globals. */
'use strict';

/* ---------- chat rendering ---------- */

/** git-style diff: "@@ -a,b +c,d @@" hunks with " " / "-" / "+" lines -> coloured rows with old/new line-number gutters. */
function diffHtml(diff, result) {
  const rows = [];
  let o = 0;
  let n = 0;
  for (const raw of escapeHtml(truncate(diff, 60000)).split('\n').slice(0, 900)) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) { o = +h[1]; n = +h[2]; rows.push(`<div class="dl hunk"><span class="ln"></span><span class="ln"></span><span class="sg"></span><span class="tx">${raw}</span></div>`); continue; }
    const c = raw[0];
    const body = raw.slice(1);
    if (c === '+') rows.push(`<div class="dl add"><span class="ln"></span><span class="ln">${n++}</span><span class="sg">+</span><span class="tx">${body}</span></div>`);
    else if (c === '-') rows.push(`<div class="dl del"><span class="ln">${o++}</span><span class="ln"></span><span class="sg">-</span><span class="tx">${body}</span></div>`);
    else if (c === ' ') rows.push(`<div class="dl ctx"><span class="ln">${o++}</span><span class="ln">${n++}</span><span class="sg"></span><span class="tx">${body}</span></div>`);
    else rows.push(`<div class="dl hunk"><span class="ln"></span><span class="ln"></span><span class="sg"></span><span class="tx">${raw}</span></div>`);   // "… N more diff lines"
  }
  const add = Number(result.additions) || 0;
  const del = Number(result.deletions) || 0;
  const tag = result.created ? '<span class="dtag new">new file</span>' : result.deleted ? '<span class="dtag gone">deleted</span>' : '';
  const stat = `<span class="stat"><span class="a">+${add}</span> <span class="d">\u2212${del}</span></span>`;
  return `<div class="diff"><div class="diff-head">${tag}<span class="dpath">${escapeHtml(result.path || '')}</span>${stat}</div>${rows.join('')}</div>`;
}

function resultHtml(result, ok) {
  const color = ok ? 'var(--green)' : 'var(--red)';
  let html = '';
  if (result && typeof result === 'object') {
    const text = typeof result.ui_diff === 'string' ? result.ui_diff : result.diff;
    if (typeof text === 'string' && text) html += diffHtml(text, result);
    else if (result.unchanged) html += `<div class="diff"><div class="diff-head"><span class="dpath">${escapeHtml(result.path || '')}</span><span class="stat">no changes</span></div></div>`;
    if (html) { const { diff, ui_diff, ...rest } = result; result = rest; }
  }
  return html + `<pre style="margin-top:6px;color:${color}">\u2192 ${escapeHtml(truncate(JSON.stringify(result), 1200))}</pre>`;
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
        if (event.auto) setAutoActive(event.agent);
        setStatus(`${event.auto ? 'auto → ' : ''}${event.agent} · generating…`, 'busy');
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
          c.card.classList.toggle('open', !event.ok || !!(event.result && (event.result.ui_diff || event.result.diff)));   // failed calls and file changes open by default
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
        else if (event.phase === 'queued') addMessage('note', `◇ subagent "${event.agent}" queued (${event.message})`).className = 'note';
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
        div.innerHTML = `${Number(event.files.length)} file(s) changed <b>+${Number(add)}</b> <i>−${Number(del)}</i> — ` + event.files.slice(0, 8).map((f) => escapeHtml(f.path)).join(', ') + (event.files.length > 8 ? ' …' : '') + ' · Undo reverts all of it';
        $('messages').appendChild(div);
        touchedFiles = true;
        scrollChat();
        break;
      }
      case 'title': loadSessions(); break;
      case 'agent':
        if (event.auto) {                      // auto mode: the dropdown stays on "auto", only its label follows the active agent
          setAutoActive(event.name);
          addMessage('note', `◇ auto: ${event.from ? `"${event.from}" → ` : ''}"${event.name}"${event.reason ? ` — ${event.reason}` : ''}`).className = 'note';
          setStatus(`auto → ${event.name} · generating…`, 'busy');
        } else { $('agent').value = event.name; addMessage('note', `◇ switched to the "${event.name}" agent`).className = 'note'; }
        break;
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
  state.jobStatus = false;
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
    applyComposerLock();                       // 'Send', or 'Stop' while a background process is still running
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
