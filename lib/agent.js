'use strict';

const log = require('./log');
const { explain, isRetryable: isRetryableError, isTimeoutPressure } = require('./errors');

const llm = require('./llm');
const mcp = require('./mcp');
const hooks = require('./hooks');
const verify = require('./verify');
const { toolDefsFor, executeTool } = require('./tools');
const A = require('./agents');
const P = require('./permission');
const sessions = require('./sessions');
const recall = require('./recall');
const { bus, TYPES } = require('./events');
const { workflow: wf } = require('./workflow');
const skills = require('./skills');
const attach = require('./attach');

const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED
The maximum number of steps allowed for this task has been reached. Tools are disabled until the next user message. Respond with text only.
1. Do NOT make any tool calls.
2. You MUST reply with a text summary: state that the step limit was reached, what has been accomplished, what remains, and what should be done next.`;

// The model sometimes announces a step (\"করছি\", \"করব\", \"I will ...\") or stops with unfinished todos
// and makes no tool call. Nudge it to continue, a few times per turn at most.
const UNFINISHED_NUDGE = 'Your task is not finished. Continue working now: make the next tool call. Do not describe what you are about to do. When the work is complete, mark every todo item completed with todo_write and then give a short final summary.';
const INTENT_RE = /(করতে\s*চলেছি|করতেছি|করছি|করব|দেখব|দেখছি|খুঁজছি|চেক\s*করছি|শুরু\s*করছি|\b(?:i\s*will|i'?ll|i\s*am\s*going\s*to|i'?m\s*going\s*to|let\s*me|now\s*i'?ll)\b)/i;
const MAX_NUDGES_PER_TURN = 3;
const GROUNDING_NUDGE = 'READ THE CODE FIRST. A file list is not evidence and general knowledge is not allowed. Call read_file / grep / lsp on the files that matter (at least two real reads this turn), then answer only from what those tools returned.';
const CITATION_NUDGE = 'Your answer needs file:line citations for every project claim, and the cited files must be ones you actually read in this turn (for example lib/agent.js:475). If you cannot cite them, call read_file/grep/lsp again instead of answering from memory.';
const UNVERIFIED_CITATION_NUDGE = 'Your answer contains citations to files not read in this turn. Read those files with read_file/grep/lsp now, or remove the unsupported citations, then answer only from code you read.';
const MIN_READS = 2;
const MAX_GROUNDING_NUDGES = 4;
const READ_TOOLS = new Set(['read_file', 'grep', 'lsp']);
const LISTING_TOOLS = new Set(['list_files', 'glob']);
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'json_edit', 'move_file', 'delete_file', 'bash']);
const ANALYSIS_RE = /(প্রজেক্ট|কোড|ইস্যু|সমস্যা|উন্নতি|বাগ|রিভিউ|বিশ্লেষণ|আর্কিটেকচার|কিভাবে|কীভাবে|\b(project|codebase|code|issues?|bugs?|review|improv\w*|analy[sz]e|architecture|explain|how does|why)\b)/i;
const CITATION_RE = /(?:^|[\s(`])([\w./@-]+\.[A-Za-z0-9]+):(\d+)/g;
const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
const FILE_LEDGER_MAX_OPS = 60;
const FILE_LEDGER_DETAIL_CHARS = 240;
const BASH_WRITE_RE = /(?:^|[;&|]\s*)(?:rm|mv|cp|mkdir|touch|tee|sed\s+-i|perl\s+-pi|chmod|git\s+(?:checkout|reset|apply|am|rebase|merge|stash|clean)|npm\s+(?:i|install|uninstall|ci|run|test)|yarn|pnpm|make|gradle)\b|>\s*[^&]|[|]\s*tee\b/i;

function citedPaths(text) {
  const out = [];
  const re = new RegExp(CITATION_RE.source, 'g');
  let m;
  while ((m = re.exec(String(text || '')))) out.push(normPath(m[1]));
  return out;
}

function readPathsThisTurn(messages) {
  const out = new Set();
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    let payload = null;
    try { payload = JSON.parse(String(m.content || '')); } catch {}
    if (payload && typeof payload === 'object') {
      if (typeof payload.path === 'string' && payload.content !== undefined) out.add(normPath(payload.path));
      if (Array.isArray(payload.files)) for (const f of payload.files) if (f && typeof f.path === 'string') out.add(normPath(f.path));
      const matches = typeof payload.matches === 'string' ? payload.matches : Array.isArray(payload.matches) ? payload.matches.join('\n') : '';
      for (const line of String(matches).split('\n')) {
        const mm = line.match(/^([^\s:]+):\d+:/);
        if (mm) out.add(normPath(mm[1]));
      }
    }
    if (m.tool_name === 'task') for (const p of citedPaths(m.content)) out.add(p);
  }
  return out;
}

const toolArgs = (v) => {
  if (v && typeof v === 'object') return v;
  try { return typeof v === 'string' ? JSON.parse(v) : {}; } catch { return {}; }
};

const clip = (v, n = FILE_LEDGER_DETAIL_CHARS) => String(v == null ? '' : v).replace(/\s+/g, ' ').slice(0, n);

function opPaths(name, a) {
  if (name === 'read_file') return (Array.isArray(a.paths) && a.paths.length ? a.paths : [a.path]).filter(Boolean).map(normPath);
  if (name === 'grep') return [a.include].filter(Boolean).map(normPath);
  if (name === 'lsp') return [a.path, a.file].filter(Boolean).map(normPath);
  if (name === 'write_file' || name === 'edit_file' || name === 'multi_edit' || name === 'json_edit' || name === 'delete_file') return [a.path].filter(Boolean).map(normPath);
  if (name === 'move_file') return [a.from, a.to].filter(Boolean).map(normPath);
  return [];
}

function opDetail(name, a, payload, paths) {
  if (name === 'read_file') {
    const offset = Number(a.offset) || 1;
    const limit = Number(a.limit) || 5000;
    return `read ${paths.join(', ') || '(unknown)'} lines ${offset}-${offset + limit - 1}`;
  }
  if (name === 'grep') return `grep ${clip(a.pattern, 80)} ${paths.length ? 'in ' + paths.join(', ') : ''}`.trim();
  if (name === 'glob') return `glob ${clip(a.pattern, 120)}`;
  if (name === 'write_file') return `write ${paths.join(', ')} +${payload.additions || 0}/-${payload.deletions || 0} ${clip(payload.diff)}`.trim();
  if (name === 'edit_file' || name === 'multi_edit' || name === 'json_edit') return `${name} ${paths.join(', ')} +${payload.additions || 0}/-${payload.deletions || 0} ${clip(payload.diff)}`.trim();
  if (name === 'move_file') return `move ${clip(a.from)} -> ${clip(a.to)}`;
  if (name === 'delete_file') return `delete ${paths.join(', ')}`;
  if (name === 'bash') return `bash ${clip(a.command, 160)}`;
  if (name === 'task') return `delegate ${clip(a.description || a.agent || '', 120)}`;
  return `${name} ${clip(a.path || a.pattern || a.command || '', 120)}`.trim();
}

function noteFileOp(session, name, rawArgs, payload, turn, iteration) {
  const currentTurn = turn || 0;
  if (session.fileLedgerTurn !== currentTurn || !Array.isArray(session.fileLedger)) {
    session.fileLedgerTurn = currentTurn;
    session.fileLedger = [];
  }
  const a = toolArgs(rawArgs);
  const paths = opPaths(name, a);
  const kind = READ_TOOLS.has(name) ? 'read' : MUTATING_TOOLS.has(name) ? 'change' : 'other';
  if (kind === 'other' && name !== 'task' && name !== 'glob') return;
  const detail = opDetail(name, a, payload || {}, paths);
  if (!detail.trim()) return;
  session.fileLedger.push({ turn: currentTurn, i: iteration + 1, kind, name, detail });
  if (session.fileLedger.length > FILE_LEDGER_MAX_OPS) session.fileLedger.splice(0, session.fileLedger.length - FILE_LEDGER_MAX_OPS);
}

function fileLedgerBlock(session) {
  const turn = session.turn || 0;
  const ops = (session.fileLedger || []).filter((e) => e && e.turn === turn).slice(-FILE_LEDGER_MAX_OPS);
  if (!ops.length) return '';
  return '<current-turn file ledger (compact; the full tool output is in the messages above)>\n' +
    ops.map((e) => `${e.i}. ${e.name}: ${e.detail}`).join('\n') +
    '\n</current-turn file ledger>';
}

const NUDGE_CONTINUE = 'Yes, continue';
const NUDGE_STOP = 'No, stop';

/* ---------- retry with backoff for flaky tunnels / overloaded servers ---------- */

const RETRY_MAX = 5;
const retryDelay = (attempt) => Math.min(30000, Math.ceil(2000 * 2 ** (attempt - 1) * (1 + 0.25 * Math.random())));
const isRetryable = (err) => isRetryableError(err);

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) return reject(new Error('aborted'));
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
});

/**
 * One model call with retries. Transient failures (tunnel hiccups, 5xx, rate limits) are retried with backoff.
 * When the server times out on a big prompt (Cloudflare 524 / 504), re-sending the identical prompt just times out again,
 * so before the 2nd retry `args.shrink()` (prune + summarise) is asked to make it smaller.
 */
async function chatWithRetry(args, emit, signal) {
  let shrunk = false;
  for (let attempt = 1; ; attempt++) {
    try {
      if (args.onAttempt) args.onAttempt();
      return await llm.chatStream(args);
    } catch (err) {
      if ((signal && signal.aborted) || attempt > RETRY_MAX || !isRetryable(err)) throw err;
      const delay = retryDelay(attempt);
      const where = args.provider && args.provider.endpoint;
      let message = explain(err, where).slice(0, 300);
      if (isTimeoutPressure(err) && !shrunk && attempt >= 2 && args.shrink) {
        shrunk = true;
        try {
          emit({ type: 'compacting' });
          const smaller = await args.shrink();
          if (smaller) { args = { ...args, messages: smaller }; message += ' — shortening the prompt before retrying'; }
        } catch (e) { log.warn('agent', 'could not shorten the prompt after a gateway timeout', e); }
      }
      log.info('agent', `model call failed (attempt ${attempt}/${RETRY_MAX}), retrying in ${delay}ms`, err);
      emit({ type: 'retry', attempt, max: RETRY_MAX, delayMs: delay, message });
      await sleep(delay, signal);
    }
  }
}

/** Big tool results are sent to the model in full, but the browser only needs a preview (huge DOM nodes freeze phones). */
function capForUi(value, max = 12000) {
  try {
    if (typeof value === 'string') return value.length > max ? value.slice(0, max) + `\n… (${(value.length - max).toLocaleString()} more characters not shown here)` : value;
    if (Array.isArray(value)) return value.length > 300 ? [...value.slice(0, 300).map((v) => capForUi(v, max)), `… ${value.length - 300} more items`] : value.map((v) => capForUi(v, max));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = capForUi(v, max);
      return out;
    }
  } catch (e) { log.debug('agent', 'capForUi failed', e); }
  return value;
}

/* ---------- context management ---------- */

const estimateTokens = (messages) =>
  Math.ceil(messages.reduce((n, m) => n + String(m.content || '').length + JSON.stringify(m.tool_calls || '').length, 0) / 3.5);

/** Real prompt size from the last model call + an estimate for what was appended since. */
function contextSize(session) {
  const est = estimateTokens(session.messages);
  if (!session.lastPrompt || session.lastCount > session.messages.length) return est;
  return Math.max(est, session.lastPrompt + estimateTokens(session.messages.slice(session.lastCount)));
}

/**
 * Stub out OLD big tool outputs only; the most recent `protectTokens` of context are never touched.
 * Exception: the latest read_file output of each file stays (up to KEEP_READ_* limits) as long as that file was not changed afterwards —
 * otherwise the model forgets the real text and edits from memory.
 */
const KEEP_READ_CHARS = 12000;        // per read_file message
const KEEP_READ_TOTAL = 36000;        // across all kept reads
const MUTATING_CALLS = new Set(['write_file', 'edit_file', 'multi_edit', 'json_edit', 'move_file', 'delete_file']);

function keepableReads(messages) {
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const calls = new Map();
  const lastRead = new Map();     // path -> index of latest read_file result message
  const lastChange = new Map();   // path -> index of latest mutating call result
  let invalidAll = false;
  messages.forEach((m, i) => { for (const c of m.tool_calls || []) calls.set(c.id, c); });
  messages.forEach((m, i) => {
    if (m.role !== 'tool' || !calls.has(m.tool_call_id)) return;
    const c = calls.get(m.tool_call_id);
    const a = toolArgs(c.function.arguments);
    const name = c.function.name;
    if (name === 'read_file') for (const p of (Array.isArray(a.paths) && a.paths.length ? a.paths : [a.path]).filter(Boolean)) lastRead.set(norm(p), i);
    else if (MUTATING_CALLS.has(name)) for (const p of [a.path, a.from, a.to].filter(Boolean)) lastChange.set(norm(p), i);
    else if (name === 'bash' && BASH_WRITE_RE.test(String(a.command || ''))) invalidAll = true;
  });
  const keep = new Set();
  if (invalidAll) return keep;
  const byIdx = [...lastRead.entries()].filter(([p, i]) => !(lastChange.has(p) && lastChange.get(p) > i)).sort((x, y) => y[1] - x[1]);
  let total = 0;
  for (const [, i] of byIdx) {
    const len = String(messages[i].content).length;
    if (len > KEEP_READ_CHARS || total + len > KEEP_READ_TOTAL) continue;
    total += len;
    keep.add(i);
  }
  return keep;
}

function pruneToolOutputs(messages, protectTokens = 2000) {
  let acc = 0;
  let boundary = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens([messages[i]]);
    if (acc >= protectTokens) { boundary = i; break; }
  }
  const keep = keepableReads(messages);
  let pruned = 0;
  for (let i = 0; i < boundary; i++) {
    const m = messages[i];
    if (m.role === 'tool' && !m.pruned && String(m.content).length > 600 && !keep.has(i)) {
      m.full = m.content;   // keep the original for export; it is never sent to the model
      m.content = JSON.stringify({ note: 'old tool output pruned to save context; re-run the tool (e.g. read_file) before relying on or editing that content' });
      m.pruned = true;
      pruned++;
    }
  }
  return pruned;
}

function serialize(m) {
  if (m.role === 'tool') return `[tool ${m.tool_name || ''} result]\n${String(m.content).slice(0, 20000)}`;
  const calls = (m.tool_calls || []).map((c) => `[calls ${c.function.name} ${JSON.stringify(c.function.arguments).slice(0, 4000)}]`).join('\n');
  return `[${m.role}]\n${String(m.content || '').slice(0, 40000)}${calls ? '\n' + calls : ''}`;
}

/** Keep the most recent turns that fit a token budget; never split a tool call from its results. */
function chooseTailStart(messages, budget) {
  const userIdx = messages.map((m, i) => (m.role === 'user' && !m.summary && !m.notice ? i : -1)).filter((i) => i > 0);
  let start = -1;
  for (let k = userIdx.length - 1; k >= 0; k--) {
    if (estimateTokens(messages.slice(userIdx[k])) <= budget) start = userIdx[k]; else break;
  }
  if (start > 0) return start;
  // single huge turn: cut inside it at an assistant message
  const asst = messages.map((m, i) => (m.role === 'assistant' && !m.summary ? i : -1)).filter((i) => i > 0);
  for (let k = asst.length - 1; k >= 0; k--) {
    if (estimateTokens(messages.slice(asst[k])) <= budget) start = asst[k]; else break;
  }
  return start > 0 ? start : -1;
}

/** UI event: the newest summary, so the chat can fold it into a "Compaction" line where the older messages ended. */
const compactedEvent = (session) => {
  const last = (session.summaries || [])[(session.summaries || []).length - 1];
  return { type: 'compacted', n: last ? last.n : session.compactions, covered: last ? last.covered : null, text: last ? last.text : '' };
};

async function summarize({ session, model, config, signal }) {
  const m = session.messages;
  const usable = (config.numCtx || 8192) * 0.75;
  const budget = Math.min(60000, Math.max(2000, Math.floor(usable * 0.25)));
  const cut = chooseTailStart(m, budget);
  if (cut <= 0) return false;
  const hasPrior = m[0] && m[0].summary && m[0].role === 'user';
  const prior = hasPrior ? m[0].content.replace(/^Summary of the earlier conversation:\n/, '') : '';
  const head = m.slice(hasPrior ? 2 : 0, cut);
  if (!head.length) return false;
  const maxChars = Math.floor((config.numCtx || 8192) * 3 * 0.55);
  let conversation = head.map(serialize).join('\n\n');
  if (conversation.length > maxChars) conversation = '[...older part omitted...]\n' + conversation.slice(-maxChars);
  const prompt = [
    A.SUMMARY_TEMPLATE,
    prior ? `${A.SUMMARY_UPDATE}\n\n<prior-summary>\n${prior}\n</prior-summary>` : '',
    `<conversation>\n${conversation}\n</conversation>`,
  ].filter(Boolean).join('\n\n');
  const small = llm.resolve(config, config.smallModel || model);
  const res = await llm.chatStream({
    provider: small.provider, model: small.model, signal, timeoutMs: config.requestTimeoutMs,
    options: { temperature: 0.1, num_ctx: config.numCtx, num_predict: Math.min(8192, Math.floor((config.numCtx || 8192) / 4)) },
    messages: [{ role: 'system', content: A.COMPACTION_SYSTEM }, { role: 'user', content: prompt }],
  });
  const text = res.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) return false;
  // keep everything that is about to leave the live context (verbatim) so /export still has the whole session
  const dropped = m.slice(0, cut);
  await sessions.archiveAppend(session.id, dropped, session.archived || 0);
  session.archived = (session.archived || 0) + dropped.length;
  session.summaries = [...(session.summaries || []), { n: (session.compactions || 0) + 1, ts: Date.now(), text, covered: head.length, archived: session.archived }];
  session.messages = [
    { role: 'user', summary: true, content: 'Summary of the earlier conversation:\n' + text },
    { role: 'assistant', summary: true, content: 'Understood. I will continue from this summary.' },
    ...m.slice(cut),
  ];
  session.compactions = (session.compactions || 0) + 1;
  session.lastPrompt = 0;
  return true;
}

/** Config with numCtx resolved for the model that will actually run (auto-detect). */
async function resolveConfig(config, ref) {
  const { provider, model } = llm.resolve(config, ref);
  return { ...config, numCtx: await llm.contextWindow(config, provider, model) };
}

async function compactSession(args) {
  args = { ...args, config: await resolveConfig(args.config, args.model) };
  const { session } = args;
  const pruned = pruneToolOutputs(session.messages, Math.floor(args.config.numCtx * 0.15));
  const summarized = await summarize(args);
  await sessions.save(session);
  return { pruned, summarized, messages: session.messages.length };
}

/** Short thread title from the first user message (best effort). */
async function generateTitle({ session, model, config, signal }) {
  const first = session.messages.find((x) => x.role === 'user' && !x.summary);
  if (!first) return null;
  try {
    const small = llm.resolve(config, config.smallModel || model);
    const res = await llm.chatStream({
      provider: small.provider, model: small.model, signal, timeoutMs: 30000,
      options: { temperature: 0.5, num_ctx: Math.min(config.numCtx || 4096, 4096), num_predict: 40 },
      messages: [{ role: 'system', content: A.TITLE_SYSTEM }, { role: 'user', content: String(first.content).slice(0, 800) }],
    });
    const t = res.content.replace(/<think>[\s\S]*?<\/think>/g, '').split('\n').map((x) => x.trim()).find(Boolean) || '';
    const clean = t.replace(/^["'`#*\s]+|["'`*\s]+$/g, '').slice(0, 50);
    return clean || null;
  } catch (e) { log.debug('agent', 'title generation failed', e); return null; }
}

/** After abort/crash an assistant tool call may lack a result; stub it so the history stays valid. */
function repairSession(session) {
  const answered = new Set(session.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  const out = [];
  for (const m of session.messages) {
    out.push(m);
    for (const c of m.tool_calls || []) {
      if (!answered.has(c.id)) out.push({ role: 'tool', tool_name: c.function.name, tool_call_id: c.id, content: JSON.stringify({ error: 'interrupted by the user before this tool finished; re-run it if it is still needed' }) });
    }
  }
  session.messages = out;
}

/* ---------- the agent loop ---------- */

/**
 * One agent run on a persisted session. Saved after every step so abort/crash never loses work.
 * `root` is the top-level session (owns the undo journal); subagents get their own child session.
 */
/* Runs one subagent task (new or resumed). `env` carries the parent's live state; see runSubagent in runAgentCore. */
async function runSubagentTask(env, { agent: subName, description, prompt, taskId }) {
  const { session, root, agent, useModel, config, signal, askPermission, askUser, inherited, isChild, depth, emit } = env;
  wf.configure(config);
  const childDepth = depth + 1;
  const depthErr = wf.depthError(childDepth);
  if (depthErr) return { error: depthErr };               // no session is created; the model just gets the error
  let child;
  let sub;
  if (taskId) {
    child = await sessions.get(taskId);
    if (child.parentId !== session.id) throw new Error('task_id does not belong to this session');
    sub = A.getAgent(child.agent);
  } else {
    sub = A.getAgent(subName);
    if (!sub || sub.mode === 'primary') throw new Error(`unknown subagent "${subName}"`);
    child = await sessions.create({ agent: sub.name, model: useModel, title: description || 'subtask', parentId: session.id });
  }
  child.grants = session.grants; // approvals carry into the subagent
  child.messages.push({ role: 'user', content: String(prompt || '') });
  const mySlot = isChild ? session.id : null;             // a subagent waiting for its children gives its slot back
  wf.register({ id: child.id, parentId: session.id, agent: sub.name, description, depth: childDepth });
  emit({ type: 'subagent', phase: 'start', sessionId: child.id, agent: sub.name, description, resumed: !!taskId, depth: childDepth });
  if (mySlot) wf.suspend(mySlot);
  let status = 'completed';
  try {
    if (wf.isFull()) emit({ type: 'subagent', phase: 'queued', sessionId: child.id, agent: sub.name, description, ...wf.queuedMessage() });
    await wf.acquire(child.id, { signal });
    const childInherited = [
      ...P.rulesFor(agent, config, inherited),
    ].filter((r) => r.action === 'deny' && (r.permission === 'edit' || r.pattern !== '*'));
    const out = await runAgent({
      session: child, root, agent: sub, model: useModel, config, signal, askPermission, askUser,
      inherited: childInherited, isChild: true, depth: childDepth,
      emit: (ev) => { if (ev.type === 'tool_call' || ev.type === 'tool_result') emit({ type: 'sub_event', sessionId: child.id, event: ev }); else if (ev.type === 'subagent') emit(ev); },
    });
    emit({ type: 'subagent', phase: 'done', sessionId: child.id });
    return { report: out.final || '(subagent produced no final message)', task_id: child.id };
  } catch (e) {
    status = 'failed';
    throw e;
  } finally {
    wf.finish(child.id, status);                          // frees the slot -> the next queued subagent starts
    if (mySlot) await wf.resume(mySlot, { signal }).catch(() => {});
  }
}

async function runAgentCore({ session, root, agent, model, config, emit, signal, askPermission, askUser, canPrompt, inherited = [], isChild = false, depth = 0 }) {
  root = root || session;
  repairSession(session);
  if (session.fileLedgerTurn !== (session.turn || 0)) {
    session.fileLedgerTurn = session.turn || 0;
    session.fileLedger = [];
  }
  let useModel = agent.model || model;                   // model ref ("provider/model" or bare name)
  let { provider, model: modelName } = llm.resolve(config, useModel);
  if (!isChild) await mcp.ensureStarted(config);
  const baseConfig = config;                              // before the context window is filled in (needed again if the model changes)
  config = { ...config, numCtx: await llm.contextWindow(config, provider, modelName) };
  const maxIterations = agent.maxIterations || config.maxIterations || 200;
  let options = { temperature: agent.temperature ?? config.temperature ?? 0.2, num_ctx: config.numCtx };
  P.normalizeGrants(session);
  const auto = !isChild && A.isAuto(session.agent);       // auto mode: agents hand over to each other (switch_agent tool)
  let tools = toolDefsFor(agent, config, { isChild, inherited, auto });
  const canSwitch = () => tools.some((t) => t.function.name === 'switch_agent');

  /** Continue the running loop as another primary agent: its model/temperature, tools and (next iteration) system prompt. */
  const adopt = async (next) => {
    agent = next;
    if ((next.model || model) !== useModel) {
      useModel = next.model || model;
      ({ provider, model: modelName } = llm.resolve(baseConfig, useModel));
      config = { ...baseConfig, numCtx: await llm.contextWindow(baseConfig, provider, modelName) };
    }
    options = { temperature: next.temperature ?? config.temperature ?? 0.2, num_ctx: config.numCtx };
    tools = toolDefsFor(agent, config, { isChild, inherited, auto });
  };

  // Reads the parent's current values at each call (useModel can change when the agent switches).
  const runSubagent = (args) => runSubagentTask({ session, root, agent, useModel, config, signal, askPermission, askUser, inherited, isChild, depth, emit }, args);

  const lastUser = [...session.messages].reverse().find((m) => m.role === 'user' && !m.summary);
  const lastUserQuery = lastUser ? String(lastUser.content || '') : '';
  const autoSkillsBlock = skills.autoContext(lastUserQuery, config);

  // Zero-model long-term memory: keyword-retrieve older context that no longer fits (see lib/recall.js)
  let recalledBlock = '';
  if (!isChild) recall.configure(config);                // semantic index (config.embedModel) follows the current config
  if (!isChild && config.recallAuto !== false && recall.available()) {
    try {
      recall.indexSession(session);
      const query = lastUserQuery;
      const r = lastUser ? await recall.autoHybrid(session, query, { signal }) : { hits: [], block: '' };
      if (r.hits.length) {
        recalledBlock = r.block;
        // what the memory put into this turn's context — shown by the dashboard's Memory/Context explorer
        session.lastRecall = { ts: Date.now(), query: query.slice(0, 200), hits: r.hits.map((h) => ({ sid: h.sid, role: h.role, ts: h.ts, via: h.via || 'bm25', text: h.text.slice(0, 300) })) };
        emit({ type: 'recall', count: r.hits.length });
        bus.emit(TYPES.MEMORY_RECALLED, { sessionId: session.id, count: r.hits.length, query: query.slice(0, 80), via: [...new Set(r.hits.map((h) => h.via || 'bm25'))].join('+') });
      } else if (session.lastRecall) session.lastRecall = null;
    } catch (e) { if (signal && signal.aborted) throw e; log.debug('agent', 'automatic recall failed', e); }
  }

  let nudges = 0;
  let nudgeAsked = false;
  let groundingNudges = 0;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal && signal.aborted) throw new Error('aborted');
    try { recall.indexSession(session); } catch (e) { log.debug('agent', 'recall indexing failed', e); }   // index everything BEFORE it can be pruned/summarised
    emit({ type: 'iteration', iteration: iteration + 1, max: maxIterations });

    const budget = (config.numCtx || 8192) * 0.75;
    if (config.autoCompact !== false && contextSize(session) > budget) {
      pruneToolOutputs(session.messages, Math.floor(config.numCtx * 0.35));
      if (contextSize(session) > budget) {
        emit({ type: 'compacting' });
        try { if (await summarize({ session, model: useModel, config, signal })) emit(compactedEvent(session)); } catch (e) {
          if (signal && signal.aborted) throw e;
          log.warn('agent', 'summarising the conversation failed; continuing without it', e);
          emit({ type: 'info', text: `⚠ could not summarise the older messages (${explain(e)}) — continuing with the full history` });
        }
      }
    }

    const lastStep = iteration === maxIterations - 1;
    const rules = P.rulesFor(agent, config, inherited);
    let system = A.composeSystem({ agent, config, canDelegate: !isChild || depth < wf.configure(config).maxDepth, rules, session, depth, maxDepth: wf.maxDepth, auto: canSwitch() });
    if (autoSkillsBlock) system += '\n\n' + autoSkillsBlock;
    if (recalledBlock) system += '\n\n' + recalledBlock;
    const ledgerBlock = fileLedgerBlock(session);
    if (ledgerBlock) system += '\n\n' + ledgerBlock;
    if (lastStep) system += '\n\n' + MAX_STEPS_PROMPT;
    // images attached to recent user messages go to the model only if it can actually see them
    let imgs = new Map();
    if (!isChild && session.messages.some((x) => x.attachments)) {
      try { if (await llm.supportsVision(config, provider, modelName)) imgs = await attach.nativeImages(session.messages); } catch (e) { log.debug('agent', 'image check failed; sending text only', e); }
    }
    const buildConvo = () => [{ role: 'system', content: system }, ...session.messages.map(({ pruned, summary, turn, display, thinking, full, attachments, notice, nudgeKind, ...m }, i) => (imgs.has(i) ? { ...m, images: imgs.get(i) } : m))];
    const convo = buildConvo();
    // after a gateway timeout: shrink the history (prune old tool output, then summarise) and rebuild the request
    const shrink = async () => {
      imgs = new Map();                                    // indexes shift after compaction; drop images for the retry
      pruneToolOutputs(session.messages, Math.floor(config.numCtx * 0.15));
      try { if (await summarize({ session, model: useModel, config, signal })) emit(compactedEvent(session)); } catch (e) { log.debug('agent', 'summary for shrink failed', e); }
      await sessions.save(session);
      return buildConvo();
    };

    let partial = '';
    let result;
    const t0 = Date.now();
    try {
      result = await chatWithRetry({
        provider, model: modelName, messages: convo, tools: lastStep ? [] : tools, options, signal, shrink,
        timeoutMs: config.requestTimeoutMs || 600000,
        onAttempt: () => { partial = ''; },
        onDelta: (d) => {
          if (d.type === 'content') { partial += d.text; emit({ type: 'token', text: d.text }); }
          else if (d.type === 'thinking') emit({ type: 'thinking', text: d.text });
        },
      }, emit, signal);
    } catch (err) {
      // keep what the model had already written so "continue" can pick up from it
      if (signal && signal.aborted && partial.trim()) {
        session.messages.push({ role: 'assistant', content: partial + '\n\n[response interrupted by the user]' });
        await sessions.save(session);
      }
      throw err;
    }
    session.interrupted = false;

    if (result.metrics) {
      const m = result.metrics;
      // generation speed: Ollama's own eval_duration when present, else wall-clock for the request
      const genSec = m.eval_duration ? m.eval_duration / 1e9 : (Date.now() - t0) / 1000;
      const tps = m.eval_count && genSec > 0 ? m.eval_count / genSec : 0;
      const used = (m.prompt_eval_count || 0) + (m.eval_count || 0);
      // the server accepted more tokens than the window we assumed: the real window is bigger — remember it (stops needless compaction)
      if (m.prompt_eval_count > (config.numCtx || 0) * 1.05) { llm.learnContextWindow(provider, modelName, m.prompt_eval_count); config = { ...config, numCtx: Math.max(config.numCtx || 0, m.prompt_eval_count) }; }
      if (!isChild) { session.lastCtx = config.numCtx || 0; session.lastUsed = used; session.lastTps = tps; }
      emit({ type: 'metrics', metrics: m, ctx: config.numCtx || 0, used, tps, child: isChild });
      session.lastPrompt = result.metrics.prompt_eval_count || 0;
      session.lastCount = session.messages.length;
      session.usage = {
        prompt: (session.usage?.prompt || 0) + (result.metrics.prompt_eval_count || 0),
        completion: (session.usage?.completion || 0) + (result.metrics.eval_count || 0),
      };
    }

    const assistantMsg = { role: 'assistant', content: result.content || '' };
    if (result.thinking && result.thinking.trim()) assistantMsg.thinking = result.thinking;   // shown in the UI, not re-sent
    if (result.toolCalls.length) assistantMsg.tool_calls = result.toolCalls;
    session.messages.push(assistantMsg);
    await sessions.save(session);

    if (!result.toolCalls.length) {
      const todos = session.todos || [];
      const turn = session.turn || 0;
      const openTodos = !isChild && todos.some((t) => t.status !== 'completed');
      const openThisTurn = !isChild && todos.some((t) => t.status !== 'completed' && t.turn === turn);
      const announcesWork = !isChild && INTENT_RE.test((result.content || '').slice(-240));
      let waitingOnJob = false;
      try { const rootId = session.parentId || session.id; waitingOnJob = require('./procs').hasPending(rootId); } catch {}
      let continuation = null;
      let userStopped = false;

      if (!isChild && !lastStep && !waitingOnJob && groundingNudges < MAX_GROUNDING_NUDGES) {
        let start = -1;
        for (let i = session.messages.length - 1; i >= 0; i--) { const m = session.messages[i]; if (m.role === 'user' && !m.notice && !m.summary) { start = i; break; } }
        const prompt = start >= 0 ? String(session.messages[start].content || '') : '';
        const toolMsgs = session.messages.slice(start + 1).filter((m) => m.role === 'tool');
        const names = toolMsgs.map((m) => m.tool_name);
        const reads = names.filter((n) => READ_TOOLS.has(n)).length + names.filter((n) => n === 'task').length * 2;
        const listed = names.some((n) => LISTING_TOOLS.has(n));
        const mutated = names.some((n) => MUTATING_TOOLS.has(n));
        const looksLikeQuestion = prompt.trim().length >= 12 && ANALYSIS_RE.test(prompt);
        const needsGrounding = listed || looksLikeQuestion;
        const answer = String(result.content || '');
        const cited = citedPaths(answer);
        const readPaths = readPathsThisTurn(toolMsgs);
        const unverified = cited.filter((p) => !readPaths.has(p));
        let notice = '';
        if (needsGrounding && reads < MIN_READS) notice = `read the code first — only ${reads} file read(s) so far`;
        else if (needsGrounding && !cited.length) notice = 'answer needs file:line citations from code read in this turn';
        else if (needsGrounding && unverified.length) notice = `citations to files not read this turn (${unverified.slice(0, 3).join(', ')})`;
        if (!mutated && notice) {
          continuation = {
            kind: 'grounding',
            info: `⟳ ${notice}`,
            content: notice.startsWith('read the code first') ? GROUNDING_NUDGE : notice.startsWith('citations to files') ? UNVERIFIED_CITATION_NUDGE : CITATION_NUDGE,
          };
        }
      }

      if (!continuation && !isChild && !lastStep && !waitingOnJob && nudges < MAX_NUDGES_PER_TURN && (openThisTurn || announcesWork)) {
        let answer = null;
        if (!nudgeAsked && config.nudgePrompt !== false && typeof askUser === 'function' && (!canPrompt || canPrompt())) {
          nudgeAsked = true;
          const openCount = todos.filter((t) => t.status !== 'completed' && t.turn === turn).length;
          const why = openThisTurn
            ? `${openCount} task${openCount === 1 ? '' : 's'} in the list ${openCount === 1 ? 'is' : 'are'} still open.`
            : 'The agent said it would continue but made no tool call.';
          try {
            answer = await askUser({ question: `The agent stopped before finishing. ${why} Continue?`, options: [NUDGE_CONTINUE, NUDGE_STOP] });
          } catch (e) {
            if (signal && signal.aborted) throw e;
            log.debug('agent', 'nudge prompt failed; continuing automatically', e);
          }
        }
        const reply = answer == null ? '' : String(answer).trim();
        const choice = reply.toLowerCase();
        if (choice === NUDGE_STOP.toLowerCase()) {
          emit({ type: 'info', text: '■ stopped at your request' });
          userStopped = true;
        } else {
          continuation = reply && choice !== NUDGE_CONTINUE.toLowerCase()
            ? { kind: 'instruction', info: '⟳ continuing with your instruction', content: reply, notice: false }
            : { kind: 'unfinished', info: '⟳ work is not finished yet — continuing', content: UNFINISHED_NUDGE };
        }
      }

      if (!continuation && !isChild && !lastStep && !waitingOnJob && !userStopped) {
        const v = await verify.finalCheck({ session, root, config, signal, emit });
        if (v && v.retry) continuation = { kind: 'verify', info: '⟳ verification failed — fixing', content: v.message };
      }

      if (continuation) {
        emit({ type: 'info', text: continuation.info });
        if (continuation.kind === 'grounding') groundingNudges++;
        else if (continuation.kind === 'unfinished' || continuation.kind === 'instruction') nudges++;
        session.messages.push({ role: 'user', summary: false, notice: continuation.notice !== false, nudgeKind: continuation.kind, turn, content: continuation.content });
        await sessions.save(session);
        continue;
      }

      // every item done: clear the checklist so it does not linger after the turn
      if (!isChild && todos.length && !openTodos) {
        session.todos = [];
        emit({ type: 'todos', todos: [] });
      }
      try { recall.indexSession(session); } catch (e) { log.debug('agent', 'final recall indexing failed', e); }
      if (lastStep) emit({ type: 'warning', message: `Reached the step limit (${maxIterations}). Send another message to continue.` });
      return { final: result.content, iterations: iteration + 1, truncated: lastStep };
    }

    // Run tool calls in order, but several `task` (subagent) calls in one message run in parallel.
    const exec = async (call) => {
      const { name, arguments: args } = call.function;
      try {
        return { ok: true, payload: await executeTool(name, args, { agent, config, session, root, inherited, emit, signal, askPermission, askUser, runSubagent }) };
      } catch (err) {
        return { ok: false, payload: { error: String(err && err.message ? err.message : err) } };
      }
    };
    for (const call of result.toolCalls) emit({ type: 'tool_call', id: call.id, name: call.function.name, args: call.function.arguments });
    const taskCalls = result.toolCalls.filter((c) => c.function.name === 'task');
    const started = new Map();
    if (taskCalls.length > 1) for (const c of taskCalls) started.set(c.id, exec(c));
    for (const call of result.toolCalls) {
      const { ok, payload } = await (started.get(call.id) || exec(call));
      if (!ok && signal && signal.aborted) throw new Error('aborted');
      emit({ type: 'tool_result', id: call.id, name: call.function.name, ok, result: capForUi(payload) });
      noteFileOp(session, call.function.name, call.function.arguments, payload, session.turn || 0, iteration);
      session.messages.push({ role: 'tool', tool_name: call.function.name, tool_call_id: call.id, content: JSON.stringify(payload, (k, v) => (k === 'ui_diff' ? undefined : v)) });   // ui_diff is for the UI only
    }

    // plan_exit approved / switch_agent (auto mode) -> continue as the other agent
    // (the session says who: session.agent, or session.autoAgent while session.agent is "auto")
    const wanted = A.resolve(session);
    if (wanted && wanted.name !== agent.name) {
      const from = agent.name;
      await adopt(wanted);
      const handover = auto ? session.autoSwitch : null;
      session.autoSwitch = null;
      if (session.switchedFromPlan) session.messages.push({ role: 'user', summary: false, content: A.BUILD_SWITCH });
      else if (auto) {
        const why = handover && handover.reason ? ` Reason: ${handover.reason}` : '';
        session.messages.push({ role: 'user', summary: false, notice: true, content: `[Studio · auto mode] The work was handed over from the "${from}" agent to the "${agent.name}" agent.${why} You are now the "${agent.name}" agent${agent.description ? ` (${agent.description})` : ''}. Your tools and permissions follow that role. Continue the task from where it stands.` });
      }
      session.switchedFromPlan = false;
      emit({ type: 'agent', name: agent.name, ...(auto ? { auto: true, from, reason: handover && handover.reason || '' } : {}) });
    }
    await sessions.save(session);
  }
  return { final: null, iterations: maxIterations, truncated: true };
}

/** Public entry point: wraps the loop with lifecycle hooks (start/end/error). */
async function runAgent(opts) {
  const { session, agent, config, emit, signal, isChild = false } = opts;
  const hookCtx = { config, session, agent, emit, signal };
  const base = { sessionId: session && session.id, agent: agent && agent.name, isChild: !!isChild };
  const child = isChild ? { isChild: true, parentId: session.parentId || null } : null;   // top-level runs are announced by the server once they are fully finished
  try {
    await hooks.run('on_agent_start', base, { ...hookCtx, blocking: false });
    if (child) bus.emit(TYPES.AGENT_STARTED, { sessionId: session.id, agent: agent.name, ...child });
    const result = await runAgentCore(opts);
    if (child) bus.emit(TYPES.AGENT_FINISHED, { sessionId: session.id, agent: agent.name, ok: true, final: result && result.final ? String(result.final).slice(0, 4000) : '', iterations: result && result.iterations, truncated: !!(result && result.truncated), ...child });
    await hooks.run('on_agent_end', {
      ...base,
      final: result && result.final ? String(result.final).slice(0, 200000) : '',
      iterations: result && result.iterations,
      truncated: !!(result && result.truncated),
    }, { ...hookCtx, blocking: false });
    return result;
  } catch (e) {
    if (child) bus.emit(signal && signal.aborted ? TYPES.AGENT_ABORTED : TYPES.AGENT_FAILED, { sessionId: session.id, agent: agent.name, error: String(e && e.message ? e.message : e).slice(0, 300), ...child });
    await hooks.run('on_error', {
      ...base,
      error: String(e && e.message ? e.message : e),
      aborted: !!(signal && signal.aborted),
    }, { ...hookCtx, blocking: false });
    throw e;
  }
}

module.exports = { runAgent, compactSession, generateTitle, resolveConfig, contextSize, capForUi, chatWithRetry, pruneToolOutputs };
