'use strict';

const llm = require('./llm');
const mcp = require('./mcp');
const { toolDefsFor, executeTool } = require('./tools');
const A = require('./agents');
const P = require('./permission');
const sessions = require('./sessions');
const recall = require('./recall');
const attach = require('./attach');

const MAX_STEPS_PROMPT = `CRITICAL - MAXIMUM STEPS REACHED
The maximum number of steps allowed for this task has been reached. Tools are disabled until the next user message. Respond with text only.
1. Do NOT make any tool calls.
2. You MUST reply with a text summary: state that the step limit was reached, what has been accomplished, what remains, and what should be done next.`;

/* ---------- retry with backoff for flaky tunnels / overloaded servers ---------- */

const RETRYABLE = [
  /\b(429|500|502|503|504|524)\b/,
  /rate.?limit|too many requests|overloaded|service unavailable|internal (server )?error|server error/i,
  /terminated|fetch failed|network|socket hang up|econn|etimedout|enotfound|eai_again|getaddrinfo|connection (error|refused|lost|reset)|other side closed|upstream connect/i,
  /operation was aborted|timed? ?out|timeout/i, // our own per-request timeout (user aborts are checked separately)
];
const RETRY_MAX = 5;
const retryDelay = (attempt) => Math.min(30000, Math.ceil(2000 * 2 ** (attempt - 1) * (1 + 0.25 * Math.random())));
const isRetryable = (err) => RETRYABLE.some((re) => re.test(String(err && err.message ? err.message : err)));

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
});

async function chatWithRetry(args, emit, signal) {
  for (let attempt = 1; ; attempt++) {
    try {
      if (args.onAttempt) args.onAttempt();
      return await llm.chatStream(args);
    } catch (err) {
      if ((signal && signal.aborted) || attempt > RETRY_MAX || !isRetryable(err)) throw err;
      const delay = retryDelay(attempt);
      emit({ type: 'retry', attempt, max: RETRY_MAX, delayMs: delay, message: String(err.message || err).slice(0, 200) });
      await sleep(delay, signal);
    }
  }
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

/** Stub out OLD big tool outputs only; the most recent `protectTokens` of context are never touched. */
function pruneToolOutputs(messages, protectTokens = 2000) {
  let acc = 0;
  let boundary = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens([messages[i]]);
    if (acc >= protectTokens) { boundary = i; break; }
  }
  let pruned = 0;
  for (let i = 0; i < boundary; i++) {
    const m = messages[i];
    if (m.role === 'tool' && !m.pruned && String(m.content).length > 600) {
      m.full = m.content;   // keep the original for export; it is never sent to the model
      m.content = JSON.stringify({ note: 'old tool output pruned to save context; re-run the tool if you need it again' });
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
  const userIdx = messages.map((m, i) => (m.role === 'user' && !m.summary ? i : -1)).filter((i) => i > 0);
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
  } catch { return null; }
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
async function runAgent({ session, root, agent, model, config, emit, signal, askPermission, askUser, inherited = [], isChild = false }) {
  root = root || session;
  repairSession(session);
  const useModel = agent.model || model;                 // model ref ("provider/model" or bare name)
  const { provider, model: modelName } = llm.resolve(config, useModel);
  if (!isChild) await mcp.ensureStarted(config);
  config = { ...config, numCtx: await llm.contextWindow(config, provider, modelName) };
  const maxIterations = agent.maxIterations || config.maxIterations || 200;
  const options = { temperature: agent.temperature ?? config.temperature ?? 0.2, num_ctx: config.numCtx };
  P.normalizeGrants(session);
  let tools = toolDefsFor(agent, config, { isChild, inherited });

  const runSubagent = async ({ agent: subName, description, prompt, taskId }) => {
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
    emit({ type: 'subagent', phase: 'start', sessionId: child.id, agent: sub.name, description, resumed: !!taskId });
    const childInherited = [
      ...P.rulesFor(agent, config, inherited),
    ].filter((r) => r.action === 'deny' && (r.permission === 'edit' || r.pattern !== '*'));
    const out = await runAgent({
      session: child, root, agent: sub, model: useModel, config, signal, askPermission, askUser,
      inherited: childInherited, isChild: true,
      emit: (ev) => { if (ev.type === 'tool_call' || ev.type === 'tool_result') emit({ type: 'sub_event', sessionId: child.id, event: ev }); },
    });
    emit({ type: 'subagent', phase: 'done', sessionId: child.id });
    return { report: out.final || '(subagent produced no final message)', task_id: child.id };
  };

  // Zero-model long-term memory: keyword-retrieve older context that no longer fits (see lib/recall.js)
  let recalledBlock = '';
  if (!isChild && config.recallAuto !== false && recall.available()) {
    try {
      recall.indexSession(session);
      const lastUser = [...session.messages].reverse().find((m) => m.role === 'user' && !m.summary);
      const r = lastUser ? recall.auto(session, String(lastUser.content || '')) : { hits: [], block: '' };
      if (r.hits.length) { recalledBlock = r.block; emit({ type: 'recall', count: r.hits.length }); }
    } catch { /* recall is best-effort */ }
  }

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal && signal.aborted) throw new Error('aborted');
    try { recall.indexSession(session); } catch { /* index everything BEFORE it can be pruned/summarised */ }
    emit({ type: 'iteration', iteration: iteration + 1, max: maxIterations });

    const budget = (config.numCtx || 8192) * 0.75;
    if (config.autoCompact !== false && contextSize(session) > budget) {
      pruneToolOutputs(session.messages, Math.floor(config.numCtx * 0.35));
      if (contextSize(session) > budget) {
        emit({ type: 'compacting' });
        try { await summarize({ session, model: useModel, config, signal }); } catch { /* continue uncompacted */ }
      }
    }

    const lastStep = iteration === maxIterations - 1;
    const rules = P.rulesFor(agent, config, inherited);
    let system = A.composeSystem({ agent, config, canDelegate: !isChild, rules, session });
    if (recalledBlock) system += '\n\n' + recalledBlock;
    if (lastStep) system += '\n\n' + MAX_STEPS_PROMPT;
    // images attached to recent user messages go to the model only if it can actually see them
    let imgs = new Map();
    if (!isChild && session.messages.some((x) => x.attachments)) {
      try { if (await llm.supportsVision(config, provider, modelName)) imgs = await attach.nativeImages(session.messages); } catch { /* text-only */ }
    }
    const convo = [{ role: 'system', content: system }, ...session.messages.map(({ pruned, summary, turn, display, thinking, full, attachments, ...m }, i) => (imgs.has(i) ? { ...m, images: imgs.get(i) } : m))];

    let partial = '';
    let result;
    const t0 = Date.now();
    try {
      result = await chatWithRetry({
        provider, model: modelName, messages: convo, tools: lastStep ? [] : tools, options, signal,
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
      try { recall.indexSession(session); } catch { /* ignore */ }
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
      emit({ type: 'tool_result', id: call.id, name: call.function.name, ok, result: payload });
      session.messages.push({ role: 'tool', tool_name: call.function.name, tool_call_id: call.id, content: JSON.stringify(payload) });
    }

    // plan_exit approved -> continue as the build agent (with a mode-switch reminder)
    if (session.agent !== agent.name) {
      const next = A.getAgent(session.agent);
      if (next) {
        agent = next;
        tools = toolDefsFor(agent, config, { isChild, inherited });
        if (session.switchedFromPlan) session.messages.push({ role: 'user', summary: false, content: A.BUILD_SWITCH });
        session.switchedFromPlan = false;
        emit({ type: 'agent', name: agent.name });
      }
    }
    await sessions.save(session);
  }
  return { final: null, iterations: maxIterations, truncated: true };
}

module.exports = { runAgent, compactSession, generateTitle, resolveConfig, contextSize };
