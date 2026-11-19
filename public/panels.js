'use strict';
/* Chat / Fleet / Memory tabs. Loaded after app.js (uses its $, api, escapeHtml, ago, state, openSession). */

(() => {
  const POST = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}), retry: false });
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
  const timeOf = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const ui = {
    tab: 'chat', fleets: null, fleetId: null, events: [], lastSeq: 0, agents: null,
    mem: null, memHits: null, memQuery: '', memScope: 'project', memCtx: null, memRecent: [],
    timers: {}, es: null, adding: false,
  };

  /* ---------- tabs ---------- */

  function setTab(name) {
    ui.tab = name;
    const chat = document.querySelector('section.chat');
    if (name === 'chat') delete chat.dataset.tab; else chat.dataset.tab = name;
    document.querySelectorAll('.tabs .tab').forEach((b) => { const on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
    $('fleetView').hidden = name !== 'fleet';
    $('memoryView').hidden = name !== 'memory';
    if (name === 'fleet') refreshFleet(); else if (name === 'memory') refreshMemory();
  }
  window.studioTabs = { show: setTab };
  document.querySelectorAll('.tabs .tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  const debounce = (key, fn, ms) => { clearTimeout(ui.timers[key]); ui.timers[key] = setTimeout(fn, ms); };

  async function openChat(id) {
    try { await openSession(id); } catch (e) { console.warn('could not open the session', e); }
    setTab('chat');
  }

  /* ---------- live event stream ---------- */

  function connectEvents() {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/events' + (ui.lastSeq ? '?since=' + ui.lastSeq : ''));
    ui.es = es;
    es.onopen = () => $('liveDot').classList.add('on');
    es.onerror = () => $('liveDot').classList.remove('on');           // EventSource reconnects by itself and resumes from Last-Event-ID
    es.onmessage = (m) => {
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      ui.lastSeq = Math.max(ui.lastSeq, ev.seq || 0);
      ui.events.push(ev);
      if (ui.events.length > 60) ui.events.splice(0, ui.events.length - 60);
      if (/^agent_|^fleet_/.test(ev.type)) debounce('fleet', () => (ui.tab === 'fleet' ? refreshFleet() : refreshBadge()), 250);
      if (ui.tab === 'fleet') paintTimeline();
      if (ev.type === 'memory_embedded' || ev.type === 'memory_recalled') debounce('mem', () => { if (ui.tab === 'memory') refreshMemory(true); }, 400);
      if (ev.type === 'agent_finished_task' || ev.type === 'agent_started') debounce('memctx', () => { if (ui.tab === 'memory') refreshMemory(true); }, 600);
    };
  }

  /* ---------- fleet ---------- */

  async function primaryAgents() {
    if (!ui.agents) { try { ui.agents = (await api('/api/state')).agents || []; } catch { ui.agents = [{ name: 'build' }, { name: 'plan' }]; } }
    return ui.agents;
  }

  async function refreshBadge() {
    try {
      const st = await api('/api/fleet/status');
      ui.fleets = st;
      const n = st.counts.running + st.counts.queued;
      const b = $('fleetBadge');
      b.hidden = !n && !st.counts.waiting;
      b.textContent = st.counts.waiting ? '!' : String(n);
      b.title = st.counts.waiting ? 'an agent is waiting for your answer' : `${st.counts.running} running, ${st.counts.queued} queued`;
    } catch (e) { console.debug('fleet badge', e); }
  }

  async function refreshFleet() {
    try { ui.fleets = await api('/api/fleet/status'); paintFleet(); refreshBadge(); } catch (e) { $('fleetView').innerHTML = `<div class="err">⚠ ${escapeHtml(e.message)}</div>`; }
    clearTimeout(ui.timers.tick);
    ui.timers.tick = setTimeout(() => { if (ui.tab === 'fleet') refreshFleet(); }, 5000);   // elapsed times + safety net if an event was missed
  }

  const statusOf = (m) => (m.waiting ? 'waiting' : m.status);
  const label = { idle: 'idle', queued: 'queued', running: 'running', waiting: 'needs input', done: 'done', failed: 'failed', aborted: 'stopped' };

  function currentFleet() {
    const list = (ui.fleets && ui.fleets.fleets) || [];
    return list.find((f) => f.id === ui.fleetId) || list[0] || null;
  }

  function memberName(f, id) { const m = f.members.find((x) => x.sessionId === id); return m ? `${m.agent}${m.title ? ' · ' + clip(m.title, 24) : ''}` : id; }

  function paintFleet() {
    const root = $('fleetView');
    if (document.activeElement && root.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) { paintTimeline(); return; }   // never steal focus/typing
    const st = ui.fleets;
    const f = currentFleet();
    if (f) ui.fleetId = f.id;
    let html = '<div class="row"><select id="flSelect" aria-label="Fleet">' +
      ((st && st.fleets) || []).map((x) => `<option value="${escapeHtml(x.id)}" ${f && x.id === f.id ? 'selected' : ''}>${escapeHtml(x.name)} (${x.members.length})</option>`).join('') +
      '</select><button class="btn small" data-act="newFleet">+ Fleet</button>' +
      (f ? '<button class="btn small" data-act="addAgent">+ Agent</button><button class="btn small ghost danger" data-act="delFleet">Delete fleet</button>' : '') +
      `<span class="spacer"></span><span class="hint-line">${st ? `slots ${st.active}/${st.maxParallel} · queued ${st.queued}` : ''}</span></div>`;
    html += '<form id="flAdd" class="fl-dispatch" hidden><div class="row"><select name="agent"></select><input type="text" name="title" placeholder="name / role (optional)" /><button class="btn small primary" type="submit">Add agent</button><button class="btn small ghost" type="button" data-act="cancelAdd">Cancel</button></div></form>';
    if (!f) {
      html += '<div class="empty" style="margin-top:12px">No fleet yet. A fleet is a group of agents you steer together: dispatch one task to all of them, run them in parallel, and chain them (<i>when A finishes, start B with A\'s report</i>).<br><br>Press <b>+ Fleet</b> to create one.</div>';
      root.innerHTML = html; return wire();
    }
    const c = { running: 0, queued: 0, waiting: 0, done: 0, failed: 0 };
    f.members.forEach((m) => { if (m.waiting) c.waiting++; else if (c[m.status] != null) c[m.status]++; });
    html += `<div class="fl-chips"><span class="chip run"><b>${c.running}</b> running</span><span class="chip"><b>${c.queued}</b> queued</span><span class="chip ${c.waiting ? 'bad' : ''}"><b>${c.waiting}</b> need input</span><span class="chip ok"><b>${c.done}</b> done</span><span class="chip ${c.failed ? 'bad' : ''}"><b>${c.failed}</b> failed</span></div>`;
    html += '<form id="flDispatch" class="fl-dispatch"><div class="row"><select name="member"><option value="all">All idle agents</option>' +
      f.members.map((m) => `<option value="${escapeHtml(m.sessionId)}">${escapeHtml(memberName(f, m.sessionId))}</option>`).join('') +
      '</select><span class="hint-line">task to dispatch (Ctrl+Enter)</span></div><textarea name="task" rows="3" placeholder="e.g. Implement the login endpoint and write tests"></textarea><div class="row"><button class="btn primary small" type="submit" ' + (f.members.length ? '' : 'disabled') + '>Dispatch</button><span id="flErr" class="err"></span></div></form>';
    html += '<div class="fl-grid">' + f.members.map((m) => cardHtml(m)).join('') + '</div>';
    if (!f.members.length) html += '<div class="empty">Add agents with <b>+ Agent</b>.</div>';
    html += '<h4>Handoffs</h4>' + (f.links.length ? f.links.map((l) => `<div class="fl-link"><b>${escapeHtml(memberName(f, l.from))}</b> → <b>${escapeHtml(memberName(f, l.to))}</b><span class="pill">on ${escapeHtml(l.on)}</span><span class="hint-line" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.template ? escapeHtml(clip(l.template, 70)) : 'default handoff message'}</span><button class="btn small ghost" data-act="unlink" data-id="${escapeHtml(l.id)}" title="Remove handoff">✕</button></div>`).join('') : '<div class="hint-line">none — when an agent finishes, nothing starts automatically.</div>');
    if (f.members.length > 1) {
      const opts = f.members.map((m) => `<option value="${escapeHtml(m.sessionId)}">${escapeHtml(memberName(f, m.sessionId))}</option>`).join('');
      html += `<form id="flLink" class="row" style="margin-top:6px"><select name="from">${opts}</select><span>→</span><select name="to">${opts}</select><select name="on"><option value="done">when done</option><option value="failed">when failed</option><option value="any">always</option></select><input type="text" name="template" placeholder="message template (optional): use {{result}} {{task}} {{from}}" style="flex:1 1 220px" /><button class="btn small" type="submit">+ Link</button><span id="flLinkErr" class="err"></span></form>`;
    }
    html += '<h4>Live events</h4><div id="flTimeline" class="fl-timeline"></div>';
    root.innerHTML = html;
    paintTimeline();
    wire();
  }

  function cardHtml(m) {
    const s = statusOf(m);
    const busy = m.status === 'running' || m.status === 'queued';
    const elapsed = m.status === 'running' && m.startedAt ? ` · ${ago(m.startedAt)}` : m.endedAt && m.startedAt ? ` · took ${Math.max(1, Math.round((m.endedAt - m.startedAt) / 1000))}s` : '';
    return `<div class="fl-card ${s}" data-sid="${escapeHtml(m.sessionId)}">` +
      `<div class="fl-head"><span class="fl-title" title="${escapeHtml(m.title || '')}"><span class="agent-badge ${escapeHtml(m.agent)}">${escapeHtml(m.agent)}</span> ${escapeHtml(clip(m.title || '(new)', 28))}</span><span class="pill ${s}">${label[s] || s}</span></div>` +
      `<div class="fl-meta">${escapeHtml(m.model || 'default model')} · ${m.messageCount || 0} msgs · ${m.runs || 0} runs${elapsed}</div>` +
      (m.lastTask ? `<div class="fl-task"><b>Task:</b> ${escapeHtml(clip(m.lastTask, 180))}</div>` : '') +
      (m.lastError ? `<div class="err">${escapeHtml(m.lastError)}</div>` : '') +
      (m.lastResult ? `<details><summary class="hint-line">Last report</summary><pre>${escapeHtml(clip(m.lastResult, 3000))}</pre></details>` : '') +
      `<div class="row"><button class="btn small ${m.waiting ? 'primary' : ''}" data-act="open">${m.waiting ? 'Answer…' : 'Open'}</button>` +
      (busy ? '<button class="btn small ghost" data-act="stop">Stop</button>' : '<button class="btn small ghost" data-act="runOne">Task…</button>') +
      '<span class="spacer"></span><button class="btn small ghost danger" data-act="remove" title="Remove from fleet (stops it, keeps the session)">✕</button></div></div>';
  }

  function paintTimeline() {
    const box = $('flTimeline');
    if (!box) return;
    const f = currentFleet();
    const names = new Map(); (ui.fleets ? ui.fleets.fleets : []).forEach((x) => x.members.forEach((m) => names.set(m.sessionId, m.agent)));
    const rows = ui.events.filter((e) => /^agent_|^memory_recalled/.test(e.type) && !e.isChild).slice(-40).reverse();
    box.innerHTML = rows.map((e) => {
      const who = escapeHtml(names.get(e.sessionId) || e.agent || (e.sessionId || '').slice(0, 12));
      const cls = e.type === 'agent_failed' ? 't-fail' : e.type === 'agent_finished_task' ? 't-ok' : '';
      const extra = e.type === 'agent_failed' ? ' — ' + escapeHtml(clip(e.error, 100)) : e.type === 'memory_recalled' ? ` — ${e.count} snippet(s) (${escapeHtml(e.via || '')})` : '';
      return `<div class="${cls}">${timeOf(e.ts)} · ${escapeHtml(e.type)} · ${who}${extra}</div>`;
    }).join('') || '<div>waiting for activity…</div>';
    void f;
  }

  function showErr(id, e) { const x = $(id); if (x) x.textContent = e && e.message ? e.message : String(e || ''); }

  function wire() {
    const root = $('fleetView');
    const sel = $('flSelect');
    if (sel) sel.onchange = () => { ui.fleetId = sel.value; paintFleet(); };
    const add = $('flAdd');
    if (add) {
      primaryAgents().then((list) => { add.elements.agent.innerHTML = list.map((a) => `<option value="${escapeHtml(a.name)}" title="${escapeHtml(a.description || '')}">${escapeHtml(a.name)}</option>`).join(''); });
      add.hidden = !ui.adding;
      add.onsubmit = async (e) => {
        e.preventDefault();
        try { await POST('/api/fleet/member', { fleetId: ui.fleetId, agent: add.elements.agent.value, title: add.elements.title.value.trim() }); ui.adding = false; refreshFleet(); } catch (err) { alert(err.message); }
      };
    }
    const disp = $('flDispatch');
    if (disp) {
      const go = async () => {
        showErr('flErr', '');
        const task = disp.elements.task.value.trim();
        if (!task) return showErr('flErr', 'write a task first');
        try {
          const r = await POST('/api/fleet/dispatch', { fleetId: ui.fleetId, member: disp.elements.member.value, task });
          const skipped = r.results.filter((x) => x.status === 'busy').length;
          disp.elements.task.value = '';
          if (skipped) showErr('flErr', `${skipped} agent(s) were busy and skipped`);
          refreshFleet();
        } catch (err) { showErr('flErr', err.message); }
      };
      disp.onsubmit = (e) => { e.preventDefault(); go(); };
      disp.elements.task.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } };
    }
    const link = $('flLink');
    if (link) {
      if (link.elements.to.options.length > 1) link.elements.to.selectedIndex = 1;
      link.onsubmit = async (e) => {
        e.preventDefault();
        try { await POST('/api/fleet/link', { fleetId: ui.fleetId, from: link.elements.from.value, to: link.elements.to.value, on: link.elements.on.value, template: link.elements.template.value.trim() }); refreshFleet(); } catch (err) { showErr('flLinkErr', err.message); }
      };
    }
    root.onclick = async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      const sid = b.closest('.fl-card') ? b.closest('.fl-card').dataset.sid : null;
      try {
        if (act === 'newFleet') { const name = prompt('Fleet name?', `Fleet ${((ui.fleets && ui.fleets.fleets.length) || 0) + 1}`); if (name === null) return; const r = await POST('/api/fleet/create', { name }); ui.fleetId = r.fleet.id; ui.adding = true; refreshFleet(); }
        else if (act === 'addAgent') { ui.adding = true; $('flAdd').hidden = false; }
        else if (act === 'cancelAdd') { ui.adding = false; $('flAdd').hidden = true; }
        else if (act === 'delFleet') { if (confirm('Delete this fleet? Its agents are stopped; their sessions stay in the Sessions list.')) { await POST('/api/fleet/remove', { fleetId: ui.fleetId }); ui.fleetId = null; refreshFleet(); } }
        else if (act === 'open') openChat(sid);
        else if (act === 'stop') { await POST('/api/fleet/stop', { sessionId: sid }); refreshFleet(); }
        else if (act === 'remove') { await POST('/api/fleet/remove', { fleetId: ui.fleetId, sessionId: sid }); refreshFleet(); }
        else if (act === 'runOne') { const f = $('flDispatch'); f.elements.member.value = sid; f.elements.task.focus(); f.scrollIntoView({ block: 'center' }); }
        else if (act === 'unlink') { await POST('/api/fleet/unlink', { fleetId: ui.fleetId, linkId: b.dataset.id }); refreshFleet(); }
      } catch (err) { alert(err.message); }
    };
  }

  /* ---------- memory / context explorer ---------- */

  async function refreshMemory(quiet = false) {
    try {
      const sid = state.sessionId;
      const [mem, ctx, recent] = await Promise.all([
        api('/api/memory/status'),
        sid ? api('/api/memory/context?session=' + encodeURIComponent(sid)).catch(() => ({ session: null })) : Promise.resolve({ session: null }),
        api('/api/memory/recent?limit=12' + (ui.memScope === 'session' && sid ? '&scope=session&session=' + sid : '')).catch(() => ({ hits: [] })),
      ]);
      ui.mem = mem; ui.memCtx = ctx.session; ui.memRecent = recent.hits || [];
      paintMemory(quiet);
    } catch (e) { $('memoryView').innerHTML = `<div class="err">⚠ ${escapeHtml(e.message)}</div>`; }
  }

  const hitHtml = (h) => `<div class="mm-hit"><div class="mm-meta">${h.via ? `<span class="via via-${escapeHtml(h.via)}">${escapeHtml(h.via)}</span>` : ''}<span>${escapeHtml(h.role)}</span><span>${new Date(h.ts).toLocaleString()}</span><a data-open="${escapeHtml(h.sid)}">${escapeHtml(h.sid)}</a>${h.score != null ? `<span>score ${h.score}</span>` : ''}</div><pre>${escapeHtml(h.text)}</pre></div>`;

  function paintMemory(quiet) {
    const root = $('memoryView');
    if (quiet && document.activeElement && root.contains(document.activeElement) && /^(INPUT|SELECT)$/.test(document.activeElement.tagName)) return;
    const m = ui.mem;
    const c = ui.memCtx;
    let html = '<div class="mm-grid">';
    // engine card
    html += '<div class="mm-card"><h3>Project memory</h3>';
    if (!m || !m.available) html += '<div class="mm-line">⚠ unavailable — needs Node ≥ 22.5 with built-in SQLite.</div>';
    else {
      const sem = m.semantic || {};
      html += `<div class="mm-line"><b>${m.chunks.toLocaleString()}</b> snippets from <b>${m.sessions}</b> session(s) · keyword search (BM25) <b>on</b></div>`;
      if (sem.enabled) {
        const pct = m.chunks ? Math.round((m.embedded / m.chunks) * 100) : 100;
        html += `<div class="mm-line">Semantic search: <b>${escapeHtml(sem.model)}</b> — ${m.embedded.toLocaleString()} / ${m.chunks.toLocaleString()} embedded (${pct}%)${m.embedding ? ' · working…' : ''}</div><div class="bar"><i style="width:${pct}%"></i></div>`;
        if (sem.backingOff || sem.lastError) html += `<div class="err">Embedding server problem: ${escapeHtml(sem.lastError || 'retrying soon')} — falling back to keyword search.</div>`;
      } else html += '<div class="mm-line">Semantic search: <b>off</b>. Set <code>"embedModel": "nomic-embed-text"</code> (any Ollama/OpenAI embedding model) in the config to add meaning-based recall in any language.</div>';
      html += '<div class="row" style="margin-top:8px"><button class="btn small" data-mact="reindex">Index all sessions' + (sem.enabled ? ' &amp; embed' : '') + '</button></div>';
    }
    html += '</div>';
    // context card
    html += '<div class="mm-card"><h3>Context of the open session</h3>';
    if (!c) html += '<div class="mm-line">No session open yet — start a chat and its context shows up here.</div>';
    else {
      const cls = c.pct >= 90 ? 'crit' : c.pct >= 70 ? 'warn' : '';
      html += `<div class="mm-line"><b>${escapeHtml(c.title)}</b> · ${escapeHtml(c.agent)} · ${escapeHtml(c.model || 'default model')}</div>`;
      html += `<div class="bar ${cls}"><i style="width:${Math.min(100, c.pct)}%"></i></div><div class="mm-line">${c.used.toLocaleString()} / ${c.ctx ? c.ctx.toLocaleString() : '?'} tokens (${c.pct}%)</div>`;
      html += `<div class="mm-line"><b>${c.messages}</b> live messages · <b>${c.archived}</b> archived (summarised away, still searchable) · <b>${c.compactions}</b> compaction(s)</div>`;
      if (c.summaries.length) html += c.summaries.slice(-3).reverse().map((x) => `<details><summary class="hint-line">Summary #${x.n} · ${new Date(x.ts).toLocaleString()}${x.covered ? ` · ${x.covered} msgs` : ''}</summary><pre style="white-space:pre-wrap;font-size:12px">${escapeHtml(x.preview)}</pre></details>`).join('');
      html += '<h4 style="margin:10px 0 4px">Recalled into the last turn</h4>';
      html += c.lastRecall && c.lastRecall.hits.length
        ? c.lastRecall.hits.map((h) => hitHtml({ ...h })).join('')
        : '<div class="mm-line">nothing was injected (no relevant older snippet).</div>';
    }
    html += '</div></div>';
    // search
    html += `<form id="mmSearch" class="mm-search"><input type="search" name="q" placeholder="Search everything the agents ever saw in this project…" value="${escapeHtml(ui.memQuery)}" /><select name="scope"><option value="project" ${ui.memScope === 'project' ? 'selected' : ''}>whole project</option><option value="session" ${ui.memScope === 'session' ? 'selected' : ''}>this session</option></select><button class="btn small primary" type="submit">Search</button></form><div id="mmErr" class="err"></div>`;
    html += '<div id="mmResults">' + (ui.memHits ? (ui.memHits.length ? ui.memHits.map(hitHtml).join('') : '<div class="empty">No matches.</div>') : '') + '</div>';
    if (!ui.memHits) html += '<h4>Recent memory</h4>' + (ui.memRecent.length ? ui.memRecent.map(hitHtml).join('') : '<div class="empty">Nothing indexed yet.</div>');
    root.innerHTML = html;
    const form = $('mmSearch');
    form.onsubmit = async (e) => {
      e.preventDefault();
      ui.memQuery = form.elements.q.value.trim(); ui.memScope = form.elements.scope.value;
      if (!ui.memQuery) { ui.memHits = null; return paintMemory(); }
      try {
        const r = await api('/api/memory/search?limit=12&q=' + encodeURIComponent(ui.memQuery) + (ui.memScope === 'session' && state.sessionId ? '&scope=session&session=' + state.sessionId : ''));
        ui.memHits = r.hits; paintMemory();
      } catch (err) { showErr('mmErr', err); }
    };
    root.onclick = async (e) => {
      const open = e.target.closest('[data-open]');
      if (open) return openChat(open.dataset.open);
      const act = e.target.closest('[data-mact]');
      if (act && act.dataset.mact === 'reindex') { act.disabled = true; act.textContent = 'Indexing…'; try { await POST('/api/memory/reindex', {}); } catch (err) { showErr('mmErr', err); } refreshMemory(); }
    };
  }

  /* ---------- go ---------- */

  connectEvents();
  refreshBadge();
  setInterval(() => { if (ui.tab === 'memory') refreshMemory(true); }, 8000);
  // the open session changed (user picked another one in the list): keep the Memory tab in step
  let lastSid = null;
  setInterval(() => { if (state.sessionId !== lastSid) { lastSid = state.sessionId; if (ui.tab === 'memory') refreshMemory(true); } }, 1000);
})();
