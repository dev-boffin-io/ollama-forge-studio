'use strict';

// Auto mode ("auto" in the agent dropdown): the studio rotates between the primary agents step by step.
//   1. At the start of every user turn, route() asks the (small) model which primary agent fits the message best.
//      It prefers the agent that was working before, and falls back to it whenever the answer is unusable.
//   2. During a turn the active agent can hand over by itself with the `switch_agent` tool (lib/tools.js);
//      the loop in lib/agent.js then continues as the new agent (new prompt, tools, permissions).
// Whoever is active keeps the normal `task` tool, so it can still delegate to subagents.
// The agent that runs is always a concrete one: agents.resolve(session). `session.autoAgent` remembers the last pick.

const log = require('./log');
const A = require('./agents');
const llm = require('./llm');

const ROUTER_SYSTEM = 'You are the router of a coding studio. Choose the ONE agent that should handle the user\'s next message. ' +
  'Prefer the current agent when the message simply continues its work. Reply with ONLY the agent name, nothing else.';

const ROUTE_HEAD_CHARS = 800;
const ROUTE_TAIL_CHARS = 400;

function routeMessage(text) {
  const s = String(text ?? '');
  if (s.length <= ROUTE_HEAD_CHARS + ROUTE_TAIL_CHARS) return s;
  return `${s.slice(0, ROUTE_HEAD_CHARS)}\n… [middle omitted] …\n${s.slice(-ROUTE_TAIL_CHARS)}`;
}

/** First candidate named in the model's reply (whole-word match, earliest mention wins), or null. */
function parseChoice(reply, candidates) {
  const text = String(reply || '').replace(/<think>[\s\S]*?<\/think>/g, '').toLowerCase();
  let best = null;
  for (const a of candidates) {
    const name = a.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(^|[^a-z0-9_-])${name}($|[^a-z0-9_-])`).exec(text);
    if (m && (!best || m.index < best.index)) best = { agent: a, index: m.index };
  }
  return best ? best.agent : null;
}

/** What the agent did last: the closing text of the latest assistant message (gives the router the "step" context). */
function lastWork(session) {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content.trim().slice(-500);
  }
  return '';
}

/**
 * Pick the primary agent for the user's new message and remember it in session.autoAgent.
 * Never throws: any problem (no small model, timeout, nonsense reply) keeps the current agent.
 */
async function route({ session, text, config, model, signal }) {
  const current = A.resolve(session) || A.getAgent('build');
  const candidates = A.autoCandidates();
  let pick = current;
  if (candidates.length > 1 && config.autoRoute !== false && String(text || '').trim()) {
    try {
      const small = llm.resolve(config, config.smallModel || model);
      const prompt =
        `Agents:\n${candidates.map((a) => `- ${a.name}: ${a.description || '(no description)'}`).join('\n')}\n\n` +
        `Current agent: ${current.name}\n` +
        (lastWork(session) ? `The current agent's latest message:\n${lastWork(session)}\n\n` : '\n') +
        `User's new message:\n${routeMessage(text)}\n\nAgent name:`;
      const res = await llm.chatStream({
        provider: small.provider, model: small.model, signal, timeoutMs: 30000,
        options: { temperature: 0, num_ctx: Math.min(config.numCtx || 4096, 4096), num_predict: 256 },
        messages: [{ role: 'system', content: ROUTER_SYSTEM }, { role: 'user', content: prompt }],
      });
      pick = parseChoice(res.content, candidates) || current;
    } catch (e) {
      if (signal && signal.aborted) throw e;
      log.debug('auto', 'routing failed; keeping the current agent', e);
    }
  }
  session.autoAgent = pick.name;
  return pick;
}

module.exports = { route, parseChoice, routeMessage };
