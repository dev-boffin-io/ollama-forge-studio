'use strict';

// Loop guards for the agent loop. Everything here is pure (no I/O) so it is unit-tested directly (test/loopguard.test.js).
//
//   1. createThinkWatch    - stops a model that "thinks" forever or repeats itself while thinking.
//   2. createDenialTracker - stops an agent that keeps calling tools it is not allowed to use.
//   3. groundingPlan       - decides whether "read the code first" is really needed, and says exactly what is missing.

const DEFAULT_THINK_MAX_CHARS = 9000;       // ~2.5k tokens of reasoning without any answer / tool call is already too much
const REPEAT_CHUNK = 120;                   // characters compared when looking for a repeating thought
const REPEAT_LIMIT = 3;                     // the same chunk this many times = the model is going round in circles

/* ---------- 1. thinking watchdog ---------- */

/**
 * Feed every thinking delta to feed(). It returns null while all is well, or a reason string ('too-long' | 'repeating')
 * the first time the model is judged to be stuck. Call stop() (or just stop feeding) once content / a tool call starts.
 */
function createThinkWatch({ maxChars = DEFAULT_THINK_MAX_CHARS } = {}) {
  let buf = '';
  let sinceCheck = 0;
  let tripped = null;
  const norm = (s) => s.replace(/\s+/g, ' ');
  return {
    get tripped() { return tripped; },
    get length() { return buf.length; },
    feed(text) {
      if (tripped) return tripped;
      const t = String(text || '');
      buf += t;
      sinceCheck += t.length;
      if (maxChars > 0 && buf.length > maxChars) return (tripped = 'too-long');
      // cheap repetition check, once per ~REPEAT_CHUNK new characters
      if (sinceCheck >= REPEAT_CHUNK && buf.length >= REPEAT_CHUNK * REPEAT_LIMIT) {
        sinceCheck = 0;
        const tail = norm(buf.slice(-REPEAT_CHUNK * 2)).slice(-REPEAT_CHUNK).trim();
        if (tail.length >= 40) {
          const all = norm(buf);
          let n = 0;
          for (let i = all.indexOf(tail); i !== -1; i = all.indexOf(tail, i + tail.length)) n++;
          if (n >= REPEAT_LIMIT) return (tripped = 'repeating');
        }
      }
      return null;
    },
  };
}

/** What the model is told after the watchdog stopped a runaway thought. Gets harsher with every strike. */
function thinkNudge(reason, strike) {
  const why = reason === 'repeating' ? 'You were repeating the same thoughts.' : 'You were thinking for far too long without acting.';
  if (strike <= 1) return `${why} Your reasoning was cut off. Do NOT think this through again. Decide now: either call ONE tool with the next concrete step, or answer the user with what you already know in a few sentences.`;
  return `${why} This is the ${strike}nd+ time. Thinking is now switched off for this step. Take the smallest useful action immediately (one tool call), or give a short answer and say what you are unsure about.`;
}

/* ---------- 2. denied-tool tracker ---------- */

// Errors that mean "this call can never succeed as asked" - retrying it is pointless.
const DENIAL_RE = /is not allowed for the|permission rejected|\(permission rule\)|unknown tool:|LOOP DETECTED|protected path|is protected|read-only/i;

const isDenial = (payload) => !!payload && typeof payload === 'object' && typeof payload.error === 'string' && DENIAL_RE.test(payload.error);

/**
 * What exactly was refused: the tool plus its "family" - bash: the command word (rm, git, npm ...), file tools: the path.
 * Blocking works on this key, so a denied `rm` never closes `ls`, and a denied write to one file never closes the others.
 */
function denialKey(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  let family = '';
  if (name === 'bash') family = String(a.command || '').trim().replace(/^(?:\w+=\S*\s+)+/, '').split(/\s+/)[0] || '';
  else family = String(a.path || a.from || a.url || '').trim();
  return family ? `${name}:${family}` : name;
}

/**
 * soft: after this many denials of ONE key (tool + command/path) that exact kind of call is refused without running.
 * hard: this many denials in a row (any tools, no success in between) end the turn - the user has to decide.
 * The tool itself is never taken away from the model, and the tracker lives for one turn only: the next user message starts fresh.
 */
function createDenialTracker({ soft = 2, hard = 6, version = '' } = {}) {
  let ver = version;
  const perKey = new Map();
  const blocked = new Set();
  const reasons = new Map();
  let streak = 0;
  return {
    blocked,
    /** Pass the current permission-grants fingerprint before each call: when the user granted something, every block is lifted and counting starts over. */
    sync(v) { if (v !== ver) { ver = v; blocked.clear(); perKey.clear(); reasons.clear(); streak = 0; return true; } return false; },
    isBlocked: (name, args) => blocked.has(denialKey(name, args)),
    /** Returns { newlyBlocked, stop, message } for one finished tool call. */
    note(name, payload, args) {
      if (!isDenial(payload)) { if (!(payload && payload.error)) streak = 0; return { newlyBlocked: false, stop: false }; }
      streak++;
      const key = denialKey(name, args);
      const n = (perKey.get(key) || 0) + 1;
      perKey.set(key, n);
      reasons.set(key, String(payload.error).slice(0, 200));
      const newlyBlocked = n >= soft && !blocked.has(key);
      if (newlyBlocked) blocked.add(key);
      return {
        newlyBlocked, key, stop: streak >= hard,
        message: newlyBlocked ? `"${key}" was refused ${n} times (${reasons.get(key)}). Do not try it again - not with other arguments either. Other uses of "${name}" still work. Use a different approach, or tell the user which permission you need.` : '',
      };
    },
    summary() { return [...reasons].map(([k, r]) => `• ${k}: ${r}`).join('\n'); },
    get streak() { return streak; },
  };
}

/* ---------- 3. smarter "read the code first" ---------- */

const READ_TOOLS = new Set(['read_file', 'grep', 'lsp']);
const GIT_EVIDENCE = new Set(['git_status', 'git_diff', 'git_log', 'git_show']);   // read-only git plugin: real evidence about the repo
const LISTING_TOOLS = new Set(['list_files', 'glob']);
const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'json_edit', 'move_file', 'delete_file', 'bash']);
// questions about repository state / workflow: git output is the evidence, not source files
const WORKFLOW_RE = /(commit|কমিট|push|পুশ|\bpull\b|branch|ব্রাঞ্চ|\bdiff\b|\bstatus\b|\bstage\b|\bstash\b|\bmerge\b|\brebase\b|\btag\b|changelog|release)/i;

const parse = (m) => { try { return JSON.parse(String(m.content || '')); } catch { return null; } };
const failed = (m) => { const p = parse(m); return !!(p && typeof p === 'object' && p.error); };

/**
 * toolMsgs: the tool messages of the current turn. calls: map tool_call_id -> call (for arguments).
 * Only SUCCESSFUL results count as evidence; a failed read tells the model which path does not exist instead.
 */
function groundingPlan({ prompt, answer, toolMsgs, calls = new Map(), minReads = 2, looksLikeQuestion, cited = [], readPaths = new Set(), mutated = false }) {
  const ok = toolMsgs.filter((m) => !failed(m));
  const okNames = ok.map((m) => m.tool_name);
  const reads = okNames.filter((n) => READ_TOOLS.has(n)).length + okNames.filter((n) => n === 'task').length * 2;
  const gitEvidence = okNames.some((n) => GIT_EVIDENCE.has(n));
  const listed = toolMsgs.some((m) => LISTING_TOOLS.has(m.tool_name));
  const workflow = WORKFLOW_RE.test(String(prompt || ''));

  // a scoped listing with few files: reading all of them is enough (don't demand 2 reads for a 1-file folder)
  let scopedFiles = null;
  for (const m of toolMsgs) {
    if (m.tool_name !== 'list_files' || failed(m)) continue;
    const p = parse(m);
    const call = calls.get(m.tool_call_id);
    const scoped = call && call.function && call.function.arguments && call.function.arguments.path;
    if (scoped && p && Array.isArray(p.files)) scopedFiles = p.files.filter((f) => !String(f).endsWith('/')).length;
  }
  const need = scopedFiles != null ? Math.max(1, Math.min(minReads, scopedFiles)) : minReads;

  const failedPaths = [];
  for (const m of toolMsgs) {
    if (!READ_TOOLS.has(m.tool_name) || !failed(m)) continue;
    const call = calls.get(m.tool_call_id);
    const p = call && call.function && call.function.arguments && call.function.arguments.path;
    if (p) failedPaths.push(String(p));
  }

  // Grounding is needed for questions about the code, or when a bare file listing was the only "research" and the answer talks about files.
  // Workflow questions (commit/diff/status ...) are grounded by git output; no source reads are demanded then.
  const needs = looksLikeQuestion || (listed && !gitEvidence && !workflow);
  const base = { reads, need, failedPaths, gitEvidence, workflow, notice: '', content: '', kind: '' };
  if (mutated || !needs) return base;
  if (workflow && gitEvidence && !looksLikeQuestion) return base;

  if (reads < need) {
    const left = need - reads;
    const avoid = failedPaths.length ? ` These paths do NOT exist, do not try them again: ${[...new Set(failedPaths)].join(', ')}.` : '';
    return { ...base, kind: 'read', notice: `read the code first — ${reads}/${need} successful read(s)`, content: `READ THE CODE FIRST. You still need ${left} successful read(s) of real files (read_file / grep / lsp).${avoid} Pick only files that appeared in a listing or grep result. A file list is not evidence and general knowledge is not allowed. Then answer only from what the tools returned.` };
  }
  if (looksLikeQuestion && !cited.length) return { ...base, kind: 'cite', notice: 'answer needs file:line citations from code read in this turn', content: 'Your answer needs file:line citations for every project claim, taken from files you actually read in this turn (for example lib/agent.js:475). If you cannot cite them, read the file instead of answering from memory.' };
  const unverified = cited.filter((p) => !readPaths.has(p));
  if (looksLikeQuestion && unverified.length) return { ...base, kind: 'unverified', notice: `citations to files not read this turn (${unverified.slice(0, 3).join(', ')})`, content: 'Your answer contains citations to files not read this turn. Read those files with read_file/grep/lsp now, or remove the unsupported citations, then answer only from code you read.' };
  return base;
}

module.exports = {
  createThinkWatch, thinkNudge, DEFAULT_THINK_MAX_CHARS,
  createDenialTracker, denialKey, isDenial, DENIAL_RE,
  groundingPlan, READ_TOOLS, GIT_EVIDENCE, LISTING_TOOLS, MUTATING_TOOLS, WORKFLOW_RE,
};
