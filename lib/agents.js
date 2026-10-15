'use strict';

// Agents: built-in (build / plan / general / explore + hidden helpers) + custom markdown agents:
//   ~/.config/ollama-studio/agents/*.md   (global)
//   <workdir>/.studio/agents/*.md         (per project, wins over global)
// Frontmatter: description, mode (primary|subagent|all), model, temperature, maxIterations, hidden,
//   permission: (edit / bash / read / task / doom_loop ... each "allow|ask|deny" or a pattern map)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GLOBAL_DIR, studioDir, getWorkDir } = require('./config');
const P = require('./permission');

const READONLY_BASH = {
  '*': 'deny',
  'ls *': 'allow', 'pwd': 'allow', 'cat *': 'allow', 'head *': 'allow', 'tail *': 'allow', 'wc *': 'allow',
  'grep *': 'allow', 'rg *': 'allow', 'tree *': 'allow', 'file *': 'allow', 'stat *': 'allow',
  'git status*': 'allow', 'git diff*': 'allow', 'git log*': 'allow', 'git show*': 'allow', 'git branch': 'allow',
  '*>*': 'deny', '*<(*': 'deny',
};

const PLAN_REMINDER = `PLAN MODE is ACTIVE: you are in a READ-ONLY phase. You must NOT edit, create or delete project files, and must NOT run any command that changes the system (no sed -i, tee, redirects, installs, commits). This overrides every other instruction, including direct requests to edit.
Your job: read, search and (if available) delegate to the "explore" subagent to build a well-researched plan. Ask the user clarifying questions with the "question" tool when a decision is genuinely theirs. You MAY write your plan to a markdown file under .studio/plans/ (the only place you can write).
The plan must be concise but executable: recommended approach only, the paths of critical files to change, and a short verification section (how to test it). When the plan is final, call "plan_exit" so the user can approve switching to the build agent. Do not ask "is this plan ok?" in plain text; plan_exit does that.`;

const BUILD_SWITCH = 'Your operational mode has changed from plan to build. You are no longer read-only: you may edit files and run commands. Implement the agreed plan now.';

const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

const SUMMARY_UPDATE = `The <prior-summary> summarizes everything before the <conversation>. Construct a new summary combining both. The <prior-summary> is discarded afterwards: anything you do not carry over is lost.
- Carry forward objectives, constraints, user directives and decisions from the <prior-summary> even if the <conversation> does not mention them. Drop only what is finished and no longer needed.
- The <conversation> is more recent: where they conflict, the conversation wins.
- Move completed work from "Active" to "Completed"; update "Objective" and "Next Move".`;

const COMPACTION_SYSTEM = 'You are a context summarization agent. You are given a conversation between a user and a coding agent. Produce a structured summary in exactly the requested format so another agent can continue the work. Do not continue the conversation and do not answer questions in it. Respond in the same language as the conversation.';

const TITLE_SYSTEM = `You are a title generator. You output ONLY a thread title. Nothing else.
Rules: single line, at most 50 characters, no explanations, no quotes. Use the same language as the user message. Keep technical terms, numbers and filenames exact. Never include tool names. Focus on what the user wants to do. If the message is just a greeting, make a title that reflects that tone.
Examples: "debug 500 errors in production" -> Debugging production 500 errors | "refactor user service" -> Refactoring user service | "why is app.js failing" -> app.js failure investigation`;

const BUILTIN = {
  build: { name: 'build', mode: 'primary', builtin: true, description: 'Default full-access agent for development work (permissions apply).' },
  plan: {
    name: 'plan', mode: 'primary', builtin: true,
    description: 'Read-only planning agent. Can only write plan files under .studio/plans/.',
    permission: { edit: { '*': 'deny', '.studio/plans/*.md': 'allow' }, bash: READONLY_BASH, task: { general: 'deny' } },
    append: PLAN_REMINDER,
  },
  general: {
    name: 'general', mode: 'subagent', builtin: true,
    description: 'General-purpose subagent for researching complex questions and executing multi-step tasks. Use it to run independent units of work.',
    append: 'You are a subagent working on one delegated task. Do exactly what was asked, then finish with ONE concise final report (what you found/changed, with file paths).',
  },
  explore: {
    name: 'explore', mode: 'subagent', builtin: true,
    description: 'Fast read-only subagent for exploring the codebase: find files by pattern, search code by keyword, answer questions about it. State the desired thoroughness: quick, medium, or very thorough.',
    permission: { edit: 'deny', bash: READONLY_BASH },
    append: 'You are a file search specialist. Use glob for broad file matching, grep for content search, read_file for specific files. Return file paths (and line numbers) in your final answer. Do not create or modify anything.',
  },
};

/* ---------- frontmatter ---------- */

function parseScalar(v) {
  v = v.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v.replace(/^["']|["']$/g, '');
}

/** Frontmatter parser: scalars + arbitrarily nested maps by indentation; quoted keys allowed. */
function parseFrontmatter(text) {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (const raw of m[1].split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const kv = raw.trim().match(/^("[^"]*"|'[^']*'|[^:]+?):(?:\s+(.*))?$/);
    if (!kv) continue;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const key = kv[1].replace(/^["']|["']$/g, '');
    const value = (kv[2] || '').replace(/\s+#.*$/, '').trim();
    const parent = stack[stack.length - 1].obj;
    if (value === '') { parent[key] = {}; stack.push({ indent, obj: parent[key] }); } else parent[key] = parseScalar(value);
  }
  return { meta: root, body: m[2].trim() };
}

function loadDir(dir, source) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    const name = n.slice(0, -3);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) continue;
    try {
      const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, n), 'utf8'));
      out[name] = {
        name, source, builtin: false,
        mode: ['primary', 'subagent', 'all'].includes(meta.mode) ? meta.mode : 'all',
        description: typeof meta.description === 'string' ? meta.description : '',
        model: typeof meta.model === 'string' ? meta.model : undefined,
        temperature: typeof meta.temperature === 'number' ? meta.temperature : undefined,
        maxIterations: typeof (meta.maxIterations ?? meta.steps) === 'number' ? (meta.maxIterations ?? meta.steps) : undefined,
        permission: meta.permission && typeof meta.permission === 'object' ? meta.permission : undefined,
        hidden: meta.hidden === true,
        prompt: body || undefined,
      };
    } catch { /* ignore broken agent file */ }
  }
  return out;
}

function loadAgents() {
  const merged = { ...BUILTIN };
  for (const layer of [loadDir(path.join(GLOBAL_DIR, 'agents'), 'global'), loadDir(path.join(studioDir(), 'agents'), 'project')]) {
    for (const [name, a] of Object.entries(layer)) merged[name] = { ...(merged[name] || {}), ...a };
  }
  return merged;
}

const getAgent = (name) => loadAgents()[name] || null;
const primaryAgents = () => Object.values(loadAgents()).filter((a) => a.mode !== 'subagent' && !a.hidden);
const subagents = () => Object.values(loadAgents()).filter((a) => a.mode !== 'primary' && !a.hidden);

/* ---------- instructions: AGENTS.md (global + nearest project) + config.instructions ---------- */

function readCapped(file, max = 50000) {
  try { return fs.readFileSync(file, 'utf8').slice(0, max); } catch { return null; }
}

/** Walk up from the working dir to the git root (or stay in the dir); first AGENTS.md/CLAUDE.md wins. */
function findProjectInstruction(dir) {
  let root = null;
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) { root = d; break; }
    if (path.dirname(d) === d) break;
  }
  const limit = root || dir;
  for (let d = dir; ; d = path.dirname(d)) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const f = path.join(d, name);
      if (fs.existsSync(f)) return f;
    }
    if (d === limit || path.dirname(d) === d) return null;
  }
}

function loadInstructions(config) {
  const dir = getWorkDir();
  const files = [path.join(GLOBAL_DIR, 'AGENTS.md')];
  const proj = findProjectInstruction(dir);
  if (proj) files.push(proj);
  for (const extra of Array.isArray(config.instructions) ? config.instructions : []) {
    files.push(extra.startsWith('~/') ? path.join(os.homedir(), extra.slice(2)) : path.resolve(dir, extra));
  }
  const parts = [];
  for (const f of files) {
    const text = readCapped(f);
    if (text) parts.push(`Instructions from ${f}:\n${text}`);
  }
  return parts.join('\n\n').slice(0, 150000);
}

/* ---------- system prompt ---------- */

function composeSystem({ agent, config, canDelegate, rules, session }) {
  const dir = getWorkDir();
  const parts = [agent.prompt || config.systemPrompt];
  if (agent.append) parts.push(agent.append);
  parts.push(
    `Working directory: ${dir}\nGit repository: ${fs.existsSync(path.join(dir, '.git')) ? 'yes' : 'no'}\n` +
    `Platform: ${process.platform}\nToday: ${new Date().toDateString()}`
  );
  if (session && Array.isArray(session.todos) && session.todos.length) {
    const mark = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };
    parts.push('Current task list (keep it updated with todo_write):\n' + session.todos.map((t) => `${mark[t.status] || '[ ]'} ${t.content}`).join('\n'));
  }
  if (session && session.interrupted) {
    parts.push('NOTE: the previous turn was interrupted by the user (a tool call or your reply was cut off). If the user says continue/resume, pick up the unfinished work exactly where it stopped: check the task list and the latest tool results, re-run anything marked interrupted, and do not start over.');
  }
  const instr = loadInstructions(config);
  if (instr) parts.push('Follow these project instructions:\n' + instr);
  const skillsText = require('./skills').promptSection(config);
  if (skillsText) parts.push(skillsText);
  if (canDelegate) {
    const subs = subagents().filter((a) => !(rules && P.evaluate('task', a.name, rules).action === 'deny'));
    if (subs.length) {
      parts.push('You can delegate self-contained work with the "task" tool (the subagent does not see this conversation, so give it full context and say whether it should only research or also write code). Subagents:\n' +
        subs.map((a) => `- ${a.name}: ${a.description || '(no description)'}`).join('\n'));
    }
  }
  return parts.join('\n\n');
}

module.exports = {
  loadAgents, getAgent, primaryAgents, subagents, composeSystem, parseFrontmatter, loadInstructions,
  BUILD_SWITCH, SUMMARY_TEMPLATE, SUMMARY_UPDATE, COMPACTION_SYSTEM, TITLE_SYSTEM,
};
