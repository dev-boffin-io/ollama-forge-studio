'use strict';

const log = require('./log');

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const procs = require('./procs');
const ws = require('./workspace');
const { getWorkDir, studioDir } = require('./config');
const { subagents, autoCandidates, isAuto } = require('./agents');
const { workflow } = require('./workflow');
const P = require('./permission');
const journal = require('./journal');
const snapshot = require('./snapshot');
const { replace, miniDiff, unifiedDiff, replaceLines, closestRegion } = require('./edit-match');
const mcp = require('./mcp');
const hooks = require('./hooks');
const plugins = require('./plugins');
const lsp = require('./lsp');
const verify = require('./verify');
const skills = require('./skills');
const web = require('./web');
const recall = require('./recall');
const protect = require('./protect');
const locks = require('./locks');

function def(name, description, properties, required) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required: required || [] } } };
}
const S = (description) => ({ type: 'string', description });

const TOOLS = {
  list_files: def('list_files', 'List files and folders as a flat list of relative paths. Pass `path` to list only one folder (recommended); without it the whole project is listed (large projects return only the top two levels).', {
    path: S('Folder to list, relative to the project root (e.g. "lib" or "examples/plugins/git"). Optional.'),
  }, []),
  glob: def('glob', 'Find files by glob pattern, e.g. "**/*.js" or "src/**/*.{ts,tsx}". If results are truncated by the scan budget, match limit, or size limits, the response will include truncated: true and a reason telling you to narrow the pattern or path.', { pattern: S('Glob pattern.') }, ['pattern']),
  grep: def('grep', 'Search file contents with a regular expression. Returns "path:line: text" matches. If results are truncated by the scan budget, match limit, or size limits, the response will include truncated: true and a reason telling you to narrow the pattern or include glob/path.', {
    pattern: S('JavaScript regular expression.'), include: S('Optional glob to limit files, e.g. "*.js".'),
  }, ['pattern']),
  read_file: def('read_file', 'Read a file (output has "N: " line-number prefixes that are NOT part of the file). Reads up to 5000 lines; use offset/limit for more. On a directory it lists entries.', {
    path: S('File path relative to the working directory.'),
    paths: { type: 'array', items: { type: 'string' }, description: 'Read multiple files at once (each keeps its own numbering/size/binary checks; one file failing does not hide others).' },
    offset: { type: 'number', description: 'First line to read (1-based).' },
    limit: { type: 'number', description: 'Max lines to read (default 5000).' },
  }, []),
  move_file: def('move_file', 'Rename or move a file or folder within the working directory. Parent folders of destination are created automatically. Refuses to overwrite an existing destination unless overwrite: true is given. Journaled for Undo (restores source and destination).', {
    from: S('Source path relative to the working directory.'),
    to: S('Destination path relative to the working directory.'),
    overwrite: { type: 'boolean', description: 'Allow overwriting an existing destination.' },
  }, ['from', 'to']),
  write_file: def('write_file', 'Create a file or completely overwrite an existing one. Parent folders are created automatically. Prefer edit_file for changes to existing files.', {
    path: S('File path relative to the working directory.'), content: S('COMPLETE file content (never a fragment or "rest unchanged" placeholder).'),
    confirm_overwrite: { type: 'boolean', description: 'Only for a deliberate full rewrite that shrinks an existing file by more than half.' },
  }, ['path', 'content']),
  edit_file: def('edit_file', 'Replace text in an existing file. ALWAYS read_file first and copy old_string EXACTLY (no "N: " prefixes, real newlines, never \\n escapes). old_string must identify exactly one place (include surrounding lines) unless replace_all is true. Minor whitespace/indentation differences are tolerated. If old_string keeps failing, do NOT retry blindly: use start_line/end_line (1-based, inclusive, numbers from read_file) to replace a range instead.', {
    path: S('File path relative to the working directory.'),
    old_string: S('Existing text to replace (no line-number prefixes). Omit when using start_line.'),
    allow_escapes: { type: 'boolean', description: 'Set true only if old_string/new_string must really contain literal \\n sequences (e.g. editing JSON-in-a-string).' },
    new_string: S('Replacement text (for a line range: the new content of those lines; empty string deletes them).'),
    replace_all: { type: 'boolean', description: 'Replace every occurrence (e.g. renaming a variable).' },
    start_line: { type: 'integer', description: 'Line-range mode: first line to replace (1-based). Use instead of old_string.' },
    end_line: { type: 'integer', description: 'Line-range mode: last line to replace (inclusive). Defaults to start_line.' },
    expect_first_line: S('Line-range mode (optional but recommended): the current text of start_line, to guard against stale line numbers.'),
    dry_run: { type: 'boolean', description: 'If true, show the match/diff that would be applied without writing the file.' },
  }, ['path', 'new_string']),
  multi_edit: def('multi_edit', 'Apply a sequence of edits to one file in order. Each edit uses the existing fuzzy matcher. All-or-nothing: if any edit fails or is ambiguous, nothing is written and the report says which edit failed and why. Journaled as a single change for Undo.', {
    path: S('File path relative to the working directory.'),
    edits: { type: 'array', items: { type: 'object', properties: { old_string: S('Existing text'), new_string: S('Replacement text'), replace_all: { type: 'boolean' } }, required: ['old_string', 'new_string'] }, description: 'List of edits to apply in order.' },
    allow_escapes: { type: 'boolean', description: 'Set true only if edit strings must really contain literal \\n sequences (e.g. editing JSON-in-a-string).' },
  }, ['path', 'edits']),
  json_edit: def('json_edit', 'Get/set/delete a value in a JSON file using a dotted or bracketed path (e.g. providers.0.apiKeyEnv or mcp["github"].command). Writing preserves the file\'s indentation style. For get/delete the path must exist. The result is validated as JSON before writing.', {
    path: S('JSON file path relative to the working directory.'),
    op: { type: 'string', enum: ['get', 'set', 'delete'], description: 'Operation.' },
    key: S('Dotted or bracketed path to the target.'),
    value: { description: 'Value to set (JSON-serialised by the model) — required for set.' },
  }, ['path', 'op', 'key']),
  delete_file: def('delete_file', 'Delete a file or folder.', { path: S('Path relative to the working directory.') }, ['path']),
  bash: def('bash', 'Run a shell command in the working directory (git, npm, tests, builds...). Do NOT use it to read/search/edit files; use the dedicated tools. Output is truncated. stdin is closed. IMPORTANT: anything that keeps running (web/file servers, watchers, dev servers, "tail -f") or takes more than about a minute (gradle/maven builds, npm/pip installs, big downloads, long test suites) MUST use background=true, otherwise the command blocks until the timeout and is killed. After starting a background process do NOT poll it: tell the user in one short sentence what you started, then END YOUR TURN. The studio sends you a notification message with the exit code and the end of the output when the process finishes. Never append "&" yourself.', {
    command: S('The shell command.'), timeout_seconds: { type: 'number', description: 'Timeout for foreground commands, default 60, max 300.' },
    background: { type: 'boolean', description: 'Start the command detached and return immediately with its id and first output. Use for servers, watchers and long jobs (builds, installs).' },
    interactive: { type: 'boolean', description: 'Only with background=true: keep stdin open so you can answer prompts later with process action=input (npm init, REPLs, installers). Prefer non-interactive flags (--yes, -y, --no-input) when the tool has them.' },
  }, ['command']),
  process: def('process', 'Manage background processes started with bash background=true: list them, read their latest output, kill one, or (for processes started with interactive=true) send input to their stdin. Do not call it in a loop to wait for a job: the studio notifies you when a process exits. Use it to inspect errors, to answer a prompt, or to kill a process the user no longer wants.', {
    action: { type: 'string', enum: ['list', 'output', 'kill', 'input'], description: 'list | output | kill | input' }, id: S('Process id (e.g. proc_1) for output/kill/input.'),
    text: S('For action=input: the text to send to stdin. A newline (Enter) is appended unless newline=false. Send an empty string with newline=true to just press Enter.'),
    newline: { type: 'boolean', description: 'For action=input: append Enter after the text (default true). Use false for single keystrokes or raw data.' },
    close_stdin: { type: 'boolean', description: 'For action=input: close stdin afterwards (sends EOF, e.g. to finish `cat` or a piped installer).' },
  }, ['action']),
  todo_write: def('todo_write', 'Create/update the task checklist for a multi-step job. Send the FULL list every time (replaces the old one). Keep one item in_progress; mark items completed as soon as they are done. When every item is completed the checklist is cleared automatically.', {
    todos: { type: 'array', description: 'Items: {content, status} where status is pending | in_progress | completed.', items: { type: 'object' } },
  }, ['todos']),
  task: def('task', 'Delegate a self-contained job to a subagent running in its own session; it returns one final report. Pass task_id from an earlier result to continue that subagent session.', {
    description: S('Short (3-6 words) label.'), prompt: S('Complete instructions; the subagent does not see this conversation.'),
    agent: S('Subagent name (see system prompt). Defaults to "general".'), task_id: S('Optional: resume a previous subagent session.'),
  }, ['description', 'prompt']),
  task_tree: def('task_tree', 'Show the status (queued | running | waiting | completed | failed) of every subagent you started, including their own subagents, as a tree. Use it to see what is still pending; do not poll it in a loop.', {}, []),
  webfetch: def('webfetch', 'Fetch a web page or text resource and return it as markdown (default), text or html. Use it to read documentation or a URL the user gave you.', {
    url: S('Fully formed http(s) URL.'), format: { type: 'string', enum: ['markdown', 'text', 'html'], description: 'Default markdown.' }, timeout: { type: 'number', description: 'Seconds (max 120).' },
  }, ['url']),
  websearch: def('websearch', 'Search the web for up-to-date information (DuckDuckGo). Returns deduplicated results with URLs/titles/snippets. The current year is ' + new Date().getFullYear() + '; use it when searching for recent information.', {
    query: S('Search query.'),
    numResults: { type: 'number', description: 'Number of results (default 8).' },
    recency: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Recency filter.' },
    site_type: { type: 'string', enum: ['docs', 'news', 'any'], description: 'Site type hint.' },
    autoFetchLimit: { type: 'number', description: 'Auto-fetch top N results as short text extracts (0 = off).' },
  }, ['query']),
  recall: def('recall', 'Search the full history of this project\'s conversations (older sessions, and earlier parts of this one that were summarised or pruned out of your context) by keywords. Use it when you need a detail, decision, file content or command output from earlier that you can no longer see. Returns the best matching snippets.', {
    query: S('Keywords to search for (names, identifiers, error messages, distinctive words). Not a full question.'),
    limit: { type: 'number', description: 'Max snippets (default 6, max 12).' },
    scope: { type: 'string', enum: ['project', 'session'], description: 'project (default) = all sessions; session = only this session.' },
  }, ['query']),
  skill: def('skill', 'Load a specialised skill (instructions + resources) by name, topic, or http(s) URL. Hidden bundled skills and web discovery are searched when the name is not listed.', { name: S('Skill name, topic, or an http(s) URL to a SKILL.md file.') }, ['name']),
  lsp: def('lsp', 'Code intelligence via a language server. Operations: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, diagnostics. line and character are 1-based (as shown by read_file).', {
    operation: S('One of: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, diagnostics.'),
    path: S('File path relative to the working directory.'), line: { type: 'number', description: '1-based line.' }, character: { type: 'number', description: '1-based column.' },
    query: S('Only for workspaceSymbol: the symbol query.'),
  }, ['operation', 'path']),
  question: def('question', 'Ask the user a question when you need a decision or missing requirement. Provide short options when sensible; the user can also type their own answer.', {
    question: S('The question.'), options: { type: 'array', description: 'Optional answer choices (strings).', items: { type: 'string' } },
  }, ['question']),
  switch_agent: def('switch_agent', 'Auto mode only: hand the next phase of the work over to another primary agent (see the agent list in the system prompt). Call it when you have finished your part and another agent is clearly better suited to the next step.', {
    agent: S('Name of the primary agent to continue as.'), reason: S('One short sentence: why this agent, why now.'),
  }, ['agent']),
  plan_exit: def('plan_exit', 'Call when the plan is final. Asks the user to approve switching to the build agent to implement it.', {}, []),
};

const CATEGORY = { write_file: 'edit', edit_file: 'edit', multi_edit: 'edit', move_file: 'edit', json_edit: 'edit', delete_file: 'edit', bash: 'bash', read_file: 'read' };
const primaryOnly = new Set(['question', 'plan_exit', 'switch_agent']);   // `task`/`task_tree` are open to subagents too (recursion is capped by lib/workflow.js)

/** Tool schemas visible to an agent (tools it can never use are hidden from the model). */
function toolDefsFor(agent, config, { isChild, inherited = [], auto = false }) {
  const rules = P.rulesFor(agent, config, inherited);
  const builtin = Object.entries(TOOLS)
    .filter(([name]) => {
      if (name === 'skill') return (Object.keys(skills.loadSkills(config)).length > 0 || skills.remoteOn(config)) && !P.disabled('skill', agent, config, inherited);
      if (name === 'lsp') return lsp.available(config) && !P.disabled('lsp', agent, config, inherited);
      if (name === 'recall') return recall.available() && !P.disabled('recall', agent, config, inherited);
      if (name === 'webfetch' || name === 'websearch') return web.netEnabled(config) && !P.disabled(name, agent, config, inherited);
      if (isChild && primaryOnly.has(name)) return false;
      if (isChild && name === 'todo_write' && !(agent.permission && agent.permission.todo_write)) return false;
      if (name === 'plan_exit') return agent.name === 'plan';
      // auto mode: any primary agent may hand over, except plan — leaving plan stays behind the user's approval (plan_exit)
      if (name === 'switch_agent') return !!auto && agent.name !== 'plan' && autoCandidates().some((a) => a.name !== agent.name);
      if (name === 'task' || name === 'task_tree') return subagents().length > 0 && !P.disabled('task', agent, config, inherited);
      const cat = CATEGORY[name];
      return !cat || !P.disabled(cat, agent, config, inherited);
    })
    .map(([, d]) => d);
  const extra = mcp.tools()
    .filter((t) => P.evaluate('mcp', t.name, rules).action !== 'deny')
    .map((t) => ({ type: 'function', function: { name: t.name, description: `[MCP ${t.server}] ${t.description}`.slice(0, 1000), parameters: t.parameters } }));
  const known = new Set([...builtin, ...extra].map((t) => t.function.name));
  const fromPlugins = plugins.toolDefs()
    .filter((t) => !known.has(t.function.name) && P.evaluate('plugin', t.function.name, rules).action !== 'deny')
    .map((t) => ({ ...t, function: { ...t.function, description: `[plugin] ${t.function.description}`.slice(0, 1024) } }));
  return [...builtin, ...extra, ...fromPlugins];
}

/* ---------- output truncation (long output is saved to disk and the model gets a preview + hint) ---------- */

async function truncateOutput(text, tool, config) {
  const maxLines = (config.toolOutput && config.toolOutput.maxLines) || 10000;
  const maxBytes = (config.toolOutput && config.toolOutput.maxBytes) || Math.min(1048576, Math.max(65536, (config.numCtx || 8192) * 2));
  const lines = String(text).split('\n');
  if (lines.length <= maxLines && Buffer.byteLength(text) <= maxBytes) return text;
  let out = [];
  let bytes = 0;
  for (const l of lines) {
    const b = Buffer.byteLength(l) + 1;
    if (out.length >= maxLines || bytes + b > maxBytes) break;
    out.push(l); bytes += b;
  }
  const dir = path.join(studioDir(), 'tool-output');
  await fsp.mkdir(dir, { recursive: true });
  const rel = path.posix.join('.studio', 'tool-output', `${Date.now().toString(36)}-${tool}.txt`);
  await fsp.writeFile(path.join(dir, path.posix.basename(rel)), text, 'utf8');
  return `${out.join('\n')}\n\n...${lines.length - out.length} lines truncated...\nFull output saved to ${rel}. Use grep on it or read_file with offset/limit to see specific parts. Do not read it whole.`;
}

/* ---------- permissions ---------- */

const rejected = new WeakMap();   // session -> Set of "tool|summary" the user already said no to
const rejectedSet = (session) => { if (!session || typeof session !== 'object') return new Set(); if (!rejected.has(session)) rejected.set(session, new Set()); return rejected.get(session); };

async function ensure(permission, pattern, summary, tool, ctx, decision) {
  const d = decision || P.decide(permission, pattern, ctx);
  if (d === 'deny') throw new Error(`${tool}: "${pattern}" is not allowed for the "${ctx.agent.name}" agent (permission rule).`);
  if (d === 'allow') return;
  const key = `${tool}|${summary}`;
  const no = rejectedSet(ctx.session);
  if (no.has(key)) throw new Error(`permission rejected by the user (already rejected this exact action earlier). Do NOT retry it. Choose a different, safer approach or ask the user with the question tool.`);
  const reply = await ctx.askPermission({ tool, category: permission, summary });
  if (reply === 'always') { P.grant(ctx.session, permission, pattern); return; }
  if (reply !== 'once') {
    no.add(key);
    throw new Error('permission rejected by the user. Do NOT retry this command or an equivalent one. Choose a different, less destructive approach, or ask the user what they want with the question tool.');
  }
}

const DOOM_THRESHOLD = 3;

/** Append language-server errors (if any) to a write/edit result so the model can fix them immediately. */
async function withDiagnostics(result, relPath, ctx) {
  let out = result;
  if (lsp.available(ctx.config)) {
    const errs = await lsp.diagnosticsAfterWrite(relPath, ctx.config);
    if (errs) out = { ...result, lsp_errors: errs, note: 'The language server reports errors in this file; fix them.' };
  }
  return verify.afterEdit(out, relPath, ctx);   // self-correction loop: syntax + related test right after every edit (lib/verify.js)
}

const DOOM_HARD = 5;          // identical input this many times in a row: refuse outright (no prompt, grants do not apply)
const FAIL_STREAK = 3;        // the same tool failed this many times in a row: refuse until something else is tried

const sameCall = (c, name, key) => c.function.name === name && JSON.stringify(c.function.arguments || {}) === key;
const failedResult = (m) => !!m && typeof m.content === 'string' && /^\{"error":/.test(m.content);
const pathOf = (c) => { const a = (c.function && c.function.arguments) || {}; return a.path || a.from || ''; };

/**
 * Loop breaker. The current call is already the last entry of session.messages (the assistant message is stored before tools run).
 *  1) identical input DOOM_THRESHOLD times in a row  -> ask the user (as before)
 *  2) identical input DOOM_HARD times in a row        -> refuse, whatever the user granted
 *  3) the same tool failing FAIL_STREAK times in a row (inputs may differ, e.g. an edit_file whose old_string never matches)
 *     -> refuse with concrete recovery steps; any other tool call in between resets it
 */
async function checkDoomLoop(name, args, ctx) {
  const calls = [];
  const results = new Map();
  for (const m of ctx.session.messages) {
    for (const c of m.tool_calls || []) calls.push(c);
    if (m.role === 'tool' && m.tool_call_id) results.set(m.tool_call_id, m);
  }
  const key = JSON.stringify(args || {});
  const hist = calls.slice();
  if (!hist.length || !sameCall(hist[hist.length - 1], name, key)) hist.push({ id: null, function: { name, arguments: args || {} } });   // direct executeTool() calls

  let run = 0;
  for (let i = hist.length - 1; i >= 0 && sameCall(hist[i], name, key); i--) run++;
  if (run >= DOOM_HARD) {
    throw new Error(`LOOP DETECTED: you called "${name}" ${run} times in a row with identical input. It is refused. Stop repeating it: read the last error/output carefully, inspect the current state with read_file/grep/list_files, then change your approach (different command, a line-range edit, or write_file). If you are truly blocked, tell the user what is blocking you.`);
  }

  const prior = hist.slice(0, -1);
  const here = pathOf(hist[hist.length - 1]);
  let streak = 0;
  for (let i = prior.length - 1; i >= 0; i--) {
    const c = prior[i];
    if (c.function.name !== name || (here && pathOf(c) !== here)) break;
    if (!c.id || !failedResult(results.get(c.id))) break;
    streak++;
  }
  if (streak >= FAIL_STREAK) {
    const edit = name === 'edit_file' || name === 'multi_edit';
    const how = edit
      ? `Do NOT guess old_string again. First call read_file on "${here}" (use offset/limit around the region you want), then either copy old_string character-for-character from that output, or call edit_file with start_line/end_line (+ expect_first_line). For heavy rewrites of a small file, use write_file with the full content.`
      : 'Read the error messages above, check the current state with read_file/grep/list_files, and try a different approach.';
    throw new Error(`LOOP DETECTED: "${name}"${here ? ` on "${here}"` : ''} has failed ${streak} times in a row. ${how}`);
  }

  if (run >= DOOM_THRESHOLD) {
    await ensure('doom_loop', name, `The agent called "${name}" ${run} times in a row with identical input (it may be stuck). Continue?`, 'doom_loop', ctx);
  }
}


/**
 * Weak models sometimes send a whole multi-line file as ONE string with literal backslash-n / backslash-quote sequences instead of
 * real newlines. Applied verbatim that would corrupt the file (or never match). Reject it early with a precise message.
 * Escape hatch: pass allow_escapes=true when the text really is meant to contain those sequences.
 */
function looksEscapedBlob(text) {
  const t = typeof text === 'string' ? text : '';
  if (t.length < 200 || /\r?\n/.test(t)) return false;           // short, or already has real newlines
  const nl = (t.match(/\\n/g) || []).length;
  const q = (t.match(/\\"/g) || []).length;
  return nl >= 5 || (nl >= 3 && q >= 3);
}
function assertNotEscapedBlob(a, fields) {
  if (a.allow_escapes === true) return;
  for (const f of fields) {
    if (looksEscapedBlob(a[f])) {
      throw new Error(`"${f}" looks like a whole file squashed into one line with literal \\n and \\" escapes (no real newlines). Do not retry like this. Send real multi-line text: for a small change use a short old_string/new_string (a few real lines), or start_line/end_line; for a full rewrite use write_file with the file content. If the text really must contain literal \\n sequences, pass allow_escapes=true.`);
    }
  }
}

const MUTATORS = new Set(['write_file', 'edit_file', 'multi_edit', 'json_edit']);
const normRel = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
const callPaths = (c) => { const a = (c.function && c.function.arguments) || {}; return (Array.isArray(a.paths) && a.paths.length ? a.paths : [a.path]).filter(Boolean).map(normRel); };

/**
 * Read-before-edit: the model must have the file's text in its LIVE context (a read_file result that was not pruned, or its own
 * successful write/edit of that file). Otherwise it edits from memory and old_string never matches. Sessions without any tool history
 * (direct API / test calls) are exempt.
 */
function assertKnowsFile(ctx, relPath) {
  const msgs = (ctx.session && ctx.session.messages) || [];
  if (!msgs.some((m) => m.tool_calls && m.tool_calls.length)) return;   // no tool history at all (direct API/test call)
  const want = normRel(relPath);
  const results = new Map();
  for (const m of msgs) if (m.role === 'tool' && m.tool_call_id) results.set(m.tool_call_id, m);
  for (const m of msgs) {
    for (const c of m.tool_calls || []) {
      const name = c.function && c.function.name;
      if (name !== 'read_file' && !MUTATORS.has(name)) continue;
      if (!callPaths(c).includes(want)) continue;
      const r = results.get(c.id);
      if (r && !r.pruned && !failedResult(r)) return;
    }
  }
  throw new Error(`Read the file first: "${relPath}" is not in your current context (never read, or its earlier read_file output was pruned). Call read_file on "${relPath}" (use offset/limit for big files), then edit using that exact text.`);
}


/* ---------- stale-file guard: the file on disk must still be what the model last saw ---------- */
const seenHash = new WeakMap();   // session -> Map(path -> sha1 of the content the model last read or wrote)
const sha = (t) => crypto.createHash('sha1').update(String(t)).digest('hex');
function noteSeen(ctx, relPath, content) {
  const s = ctx.session;
  if (!s || typeof s !== 'object') return;
  if (!seenHash.has(s)) seenHash.set(s, new Map());
  seenHash.get(s).set(normRel(relPath), sha(content));
}
function assertFresh(ctx, relPath, diskContent) {
  const s = ctx.session;
  const m = s && typeof s === 'object' ? seenHash.get(s) : null;
  const prev = m && m.get(normRel(relPath));
  if (prev && prev !== sha(diskContent)) {
    throw new Error(`"${relPath}" changed on disk since you last read it (another tool, a command or the user edited it). Call read_file on it again and redo the edit from the current text.`);
  }
}

const editFails = new WeakMap();   // session -> Map(path -> consecutive failed edits)
function noteEdit(ctx, relPath, ok) {
  const s = ctx.session;
  if (!s || typeof s !== 'object') return 0;
  if (!editFails.has(s)) editFails.set(s, new Map());
  const m = editFails.get(s);
  if (ok) { m.delete(relPath); return 0; }
  m.set(relPath, (m.get(relPath) || 0) + 1);
  return m.get(relPath);
}
function editFailure(ctx, relPath, err) {
  const n = noteEdit(ctx, relPath, false);
  const base = err && err.message ? err.message : String(err);
  if (n < 2) throw err instanceof Error ? err : new Error(base);
  throw new Error(`${base}\n[edit failed ${n} times in a row on "${relPath}"] Stop guessing. Use read_file with offset/limit to view the exact lines, then use edit_file with start_line/end_line (and expect_first_line), or write_file for small files.`);
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|7z|exe|dll|so|bin|wasm|mp[34]|mov|avi|woff2?|ttf|otf|class|jar|pyc)$/i;

async function readTool(a, ctx) {
  const rel = String(a.path || '');
  const full = ws.safeResolve(rel);
  let st;
  try { st = await fsp.stat(full); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const base = path.basename(rel).toLowerCase();
    let hint = '';
    try {
      const sib = (await fsp.readdir(path.dirname(full))).filter((n) => n.toLowerCase().includes(base) || base.includes(n.toLowerCase())).slice(0, 3);
      if (sib.length) hint = ` Did you mean: ${sib.map((n) => path.posix.join(path.dirname(rel), n)).join(', ')}?`;
    } catch (e) { log.debug('tools', 'could not suggest similar file names', e); }
    if (!hint) {
      try {
        const here = (await fsp.readdir(path.dirname(full))).slice(0, 15);
        if (here.length) hint = ` Files in "${path.posix.dirname(rel) || '.'}": ${here.join(', ')}. Do not guess other names; use one of these or glob/grep.`;
      } catch (e) { log.debug('tools', 'could not list the folder for a missing file', e); }
    }
    throw new Error(`File not found: ${rel}.${hint}`);
  }
  if (st.isDirectory()) {
    const entries = (await fsp.readdir(full, { withFileTypes: true })).filter((d) => !ws.IGNORED.has(d.name)).map((d) => d.name + (d.isDirectory() ? '/' : '')).sort();
    return { path: rel, type: 'directory', entries };
  }
  if (BINARY_EXT.test(rel)) throw new Error(`Cannot read binary file: ${rel}`);
  const buf = await fsp.readFile(full);
  if (buf.subarray(0, 4096).includes(0)) throw new Error(`Cannot read binary file: ${rel}`);
  const lines = buf.toString('utf8').split('\n');
  const offset = Math.max(1, Number(a.offset) || 1);
  const limit = Math.max(1, Number(a.limit) || 5000);
  const slice = lines.slice(offset - 1, offset - 1 + limit).map((l, i) => `${offset + i}: ${l.length > 10000 ? l.slice(0, 10000) + '... (line truncated)' : l}`);
  const last = offset - 1 + slice.length;
  let content = slice.join('\n');
  const maxBytes = Math.min(1048576, Math.max(65536, (ctx.config.numCtx || 8192) * 2));
  let capped = false;
  if (Buffer.byteLength(content) > maxBytes) {
    const keep = [];
    let b = 0;
    for (const l of slice) { b += Buffer.byteLength(l) + 1; if (b > maxBytes) break; keep.push(l); }
    content = keep.join('\n');
    capped = true;
  }
  const shown = capped ? offset - 1 + content.split('\n').length : last;
  const more = shown < lines.length;
  return { path: rel, total_lines: lines.length, content: content + (more ? `\n\n(Showing lines ${offset}-${shown} of ${lines.length}. Use offset=${shown + 1} to continue.)` : '') };
}

/** git-style diff for a tool result: `diff` (compact, goes to the model) + `ui_diff` (fuller, shown in the UI only, stripped before it reaches the model). */
function diffFields(before, after) {
  const small = miniDiff(before, after);
  if (!small.additions && !small.deletions) return { unchanged: true, additions: 0, deletions: 0 };
  const full = unifiedDiff(before, after, { context: 3, maxLines: 400 });
  return { diff: small.diff, ui_diff: full.diff, additions: full.additions, deletions: full.deletions };
}

async function readIfExists(rel) {
  try { return await ws.readFile(rel); } catch { return null; }     // missing, directory, too large or unreadable: no diff base
}

function hookAbsolute(rel) {
  try { return ws.safeResolve(String(rel || '')); } catch { return null; }
}

function safeHookValue(value, max = 200000) {
  try {
    const json = JSON.stringify(value);
    if (json && json.length > max) return { truncated: true, preview: json.slice(0, max) };
  } catch { /* circular or unserialisable */ }
  return value;
}

async function beforeEdit(ctx, tool, payload) {
  const rel = payload.path || payload.from;
  const absolutePath = payload.absolutePath || hookAbsolute(rel);
  await hooks.preEdit(ctx, { tool, ...payload, ...(absolutePath ? { absolutePath } : {}) });
}

async function afterEdit(ctx, tool, payload) {
  const rel = payload.path || payload.from;
  const absolutePath = payload.absolutePath || hookAbsolute(rel);
  await hooks.fileChange(ctx, { tool, ...payload, ...(absolutePath ? { absolutePath } : {}) });
}

/**
 * Execute one tool call. ctx = { agent, config, session, root, inherited, emit, signal, askPermission, askUser, runSubagent }
 */
/**
 * Gate in front of every file-changing tool: (1) protected paths (studio config, .git, plugins ...) can never be changed by the
 * model, (2) a file that another agent running right now has already changed is claimed by that agent (lib/locks.js).
 */
function guardEdit(name, a, ctx) {
  const rels = name === 'move_file' ? [a.from, a.to] : [a.path];
  const owner = (ctx.root && ctx.root.id) || (ctx.session && ctx.session.id) || null;
  for (const rel of rels) {
    if (!rel) continue;                                       // the tool reports the missing argument itself
    const abs = ws.safeResolve(String(rel));
    protect.assertWritable(abs, String(rel));
    if (!owner) continue;
    const l = locks.acquire(owner, abs, name);
    if (!l.ok) {
      const e = new Error(`"${rel}" is being edited by another agent that is running right now (session ${l.holder.owner}, ${l.holder.tool}). Do not overwrite it: work on other files, or tell the user and retry later.`);
      e.status = 409;
      throw e;
    }
  }
}

/* File-changing tools (write, edit, move, delete). Each case returns, so the switch never falls through. */
async function executeFileEditTool(name, a, ctx) {
  guardEdit(name, a, ctx);
  switch (name) {
    case 'write_file': {
      if (!a.path) throw new Error('path is required');
      if (typeof a.content !== 'string') throw new Error('content must be a string with the COMPLETE file text (it was missing or not text). Nothing was written.');
      await ensure('edit', a.path, `write ${a.path}`, name, ctx);
      const prev = await readIfExists(a.path);
      if (prev !== null) {   // overwriting an existing file: the model must know the current text, and must not truncate it by accident
        assertKnowsFile(ctx, a.path);
        assertFresh(ctx, a.path, prev);
        const oldLines = prev.split('\n').length; const newLines = a.content.split('\n').length;
        if (oldLines >= 40 && newLines < oldLines * 0.5 && a.confirm_overwrite !== true) {
          throw new Error(`Refusing to overwrite "${a.path}": the new content has ${newLines} lines but the file has ${oldLines}. This looks like truncated output. Use edit_file/multi_edit for partial changes, or if you really mean a full rewrite, call write_file again with confirm_overwrite=true and the COMPLETE file.`);
        }
      }
      await beforeEdit(ctx, name, { path: a.path, operation: 'write', content: a.content });
      await journal.track(ctx.root, a.path);
      const wr = { ok: true, ...(await ws.writeFile(a.path, a.content)), created: prev === null };
      if (prev !== null || a.content != null) Object.assign(wr, diffFields(prev ?? '', String(a.content ?? '')));
      noteSeen(ctx, a.path, a.content);
      await afterEdit(ctx, name, { path: a.path, operation: 'write' });
      return withDiagnostics(wr, a.path, ctx);
    }
    case 'edit_file': {
      if (!a.path) throw new Error('path is required');
      if (a.new_string === undefined && a.old_string === undefined) throw new Error('new_string is required');
      assertNotEscapedBlob(a, ['old_string', 'new_string']);
      await ensure('edit', a.path, `edit ${a.path}`, name, ctx);
      if (a.dry_run !== true) assertKnowsFile(ctx, a.path);
      const before = await ws.readFile(a.path);
      if (a.dry_run !== true) assertFresh(ctx, a.path, before);
      const apply = () => (a.start_line != null
        ? replaceLines(before, a.start_line, a.end_line, String(a.new_string ?? ''), a.expect_first_line)
        : replace(before, String(a.old_string ?? ''), String(a.new_string ?? ''), a.replace_all === true));
      let r;
      try { r = apply(); } catch (err) { editFailure(ctx, a.path, err); }
      if (a.dry_run === true) return { dry_run: true, path: a.path, ...diffFields(before, r.content), matched: typeof r.matched === 'string' };
      noteEdit(ctx, a.path, true);
      await beforeEdit(ctx, name, { path: a.path, operation: 'edit', before, old_string: a.old_string, new_string: a.new_string, replace_all: a.replace_all === true });
      await journal.track(ctx.root, a.path);
      await ws.writeFile(a.path, r.content);
      noteSeen(ctx, a.path, r.content);
      await afterEdit(ctx, name, { path: a.path, operation: 'edit' });
      const fuzzy = r.via === 'blockAnchor' || r.via === 'fuzzyLineMatch' ? { fuzzy_match: r.via, note: `old_string matched with the relaxed "${r.via}" matcher. Check the diff is the change you intended; if not, undo and use start_line/end_line.` } : {};
      return withDiagnostics({ ok: true, path: a.path, ...diffFields(before, r.content), ...fuzzy }, a.path, ctx);
    }
    case 'multi_edit': {
      if (!a.path) throw new Error('path is required');
      await ensure('edit', a.path, `edit ${a.path}`, name, ctx);
      const edits = Array.isArray(a.edits) ? a.edits : [];
      for (const e of edits) assertNotEscapedBlob({ ...(e || {}), allow_escapes: a.allow_escapes }, ['old_string', 'new_string']);
      assertKnowsFile(ctx, a.path);
      const before = await ws.readFile(a.path);
      assertFresh(ctx, a.path, before);
      let current = before;
      const applied = [];
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i] || {};
        try {
          const res = replace(current, String(e.old_string ?? ''), String(e.new_string ?? ''), e.replace_all === true);
          current = res.content;
          applied.push({ index: i, ok: true });
        } catch (err) {
          editFailure(ctx, a.path, new Error(`multi_edit failed at edit ${i}: ${err && err.message ? err.message : err}`));
        }
      }
      if (current === before) throw new Error('multi_edit produced no changes');
      noteEdit(ctx, a.path, true);
      await beforeEdit(ctx, name, { path: a.path, operation: 'multi_edit', before, edits });
      await journal.track(ctx.root, a.path);
      await ws.writeFile(a.path, current);
      noteSeen(ctx, a.path, current);
      await afterEdit(ctx, name, { path: a.path, operation: 'multi_edit' });
      return withDiagnostics({ ok: true, path: a.path, edits: applied.length, ...diffFields(before, current) }, a.path, ctx);
    }
    case 'move_file': {
      if (!a.from || !a.to) throw new Error('from and to are required');
      await ensure('edit', a.from, `move ${a.from} -> ${a.to}`, name, ctx);
      await ensure('edit', a.to, `move to ${a.to}`, name, ctx);
      await beforeEdit(ctx, name, { path: a.from, from: a.from, to: a.to, operation: 'move', overwrite: a.overwrite === true });
      await journal.track(ctx.root, a.from);
      await journal.track(ctx.root, a.to);
      if (a.overwrite === true) {
        try { await journal.track(ctx.root, a.to); } catch {}
      }
      const r = await ws.moveFile(a.from, a.to, a.overwrite === true);
      await afterEdit(ctx, name, { path: a.to, from: a.from, to: a.to, operation: 'move' });
      verify.markDirty(ctx, a.to);
      return { ok: true, ...r };
    }
    case 'json_edit': {
      if (!a.path) throw new Error('path is required');
      await ensure('edit', a.path, `json_edit ${a.op} ${a.key} in ${a.path}`, name, ctx);
      const before = await ws.readFile(a.path);
      const res = jsonEdit(before, a.op, a.key, a.value);
      if (a.op !== 'get') {
        await beforeEdit(ctx, name, { path: a.path, operation: 'json_edit', before, json_op: a.op, key: a.key, value: a.value });
        await journal.track(ctx.root, a.path);
        await ws.writeFile(a.path, res.text);
        await afterEdit(ctx, name, { path: a.path, operation: 'json_edit' });
      }
      return a.op === 'get' ? { ok: true, value: res.value } : withDiagnostics({ ok: true, path: a.path, ...diffFields(before, res.text) }, a.path, ctx);
    }
    case 'delete_file':
      if (!a.path) throw new Error('path is required');
      await ensure('edit', a.path, `delete ${a.path}`, name, ctx);
      await beforeEdit(ctx, name, { path: a.path, operation: 'delete' });
      await journal.track(ctx.root, a.path);
      {
        const prev = await readIfExists(a.path);
        const r = await ws.deleteFile(a.path);
        await afterEdit(ctx, name, { path: a.path, operation: 'delete' });
        verify.markDirty(ctx, a.path);
        return prev ? { ...r, deleted: true, ...diffFields(prev, '') } : r;
      }
  }
}

async function executeToolInner(name, args, ctx) {
  const a = args || {};
  const pluginTool = plugins.isTool(name);
  if (!TOOLS[name] && !pluginTool && !mcp.isMcpTool(name)) throw new Error(`unknown tool: ${name}`);
  await checkDoomLoop(name, a, ctx);

  if (pluginTool) {
    await ensure('plugin', name, `${name}(${JSON.stringify(a).slice(0, 300)})`, name, ctx);
    return plugins.callTool(name, a, ctx);
  }
  if (!TOOLS[name]) { // MCP tool
    await ensure('mcp', name, `${name}(${JSON.stringify(a).slice(0, 300)})`, name, ctx);
    return { output: await truncateOutput(await mcp.call(name, a), name, ctx.config) };
  }

  switch (name) {
    case 'recall': {
      if (!recall.available()) return { error: 'history search is unavailable (needs Node >= 22.5 with SQLite FTS5)' };
      recall.indexSession(ctx.session);
      const live = new Set(recall.parts(ctx.session).map((p) => p.h));
      recall.configure(ctx.config);
      const hits = await recall.searchHybrid(String(a.query || ''), {         // keyword + (when config.embedModel is set) semantic
        limit: Math.min(12, Math.max(1, Number(a.limit) || 6)), sid: a.scope === 'session' ? ctx.session.id : null, exclude: live, maxChars: 1200, signal: ctx.signal,
      });
      if (!hits.length) return { results: 'no matches outside your current context — try different or fewer keywords' };
      return { count: hits.length, results: recall.format(hits) };
    }
    case 'list_files': {
      const all = await ws.listFlat(20000);
      const scope = a.path ? String(a.path).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') : '';
      if (scope && scope !== '.') {
        const prefix = scope + '/';
        const inside = all.filter((p) => p.startsWith(prefix) && p.length > prefix.length);
        if (!inside.length) {
          const parent = scope.includes('/') ? scope.slice(0, scope.lastIndexOf('/')) : '';
          const near = all.filter((p) => !p.endsWith('/') && (parent ? p.startsWith(parent + '/') : !p.includes('/'))).slice(0, 15);
          return { error: `Folder not found or empty: ${scope}.${near.length ? ` Files in "${parent || '.'}": ${near.join(', ')}` : ''}` };
        }
        return { path: scope, files: inside.slice(0, 1000), truncated: inside.length > 1000 || undefined };
      }
      if (all.length <= 400) return { files: all };
      const top = all.filter((p) => p.replace(/\/$/, '').split('/').length <= 2);
      return { files: top.slice(0, 400), truncated: true, note: `The project has ${all.length} entries; only the top two levels are shown. Call list_files with path="<folder>" to look inside one folder, or use glob/grep.` };
    }
    case 'glob': {
      const r = await ws.glob(String(a.pattern || ''));
      return Array.isArray(r) ? { matches: r } : { matches: r.matches, truncated: r.truncated, reason: r.reason };
    }
    case 'grep': {
      const r = await ws.grep(String(a.pattern || ''), a.include);
      const matches = r.matches || r;
      const out = { matches: await truncateOutput(Array.isArray(matches) ? matches.join('\n') : String(matches), 'grep', ctx.config), count: Array.isArray(matches) ? matches.length : 0 };
      if (r.truncated) { out.truncated = true; out.reason = r.reason; }
      return out;
    }
    case 'read_file': {
      const paths = Array.isArray(a.paths) && a.paths.length ? a.paths : (a.path ? [a.path] : []);
      if (!paths.length) throw new Error('path or paths is required');
      if (paths.length === 1) {
        await ensure('read', paths[0], `read ${paths[0]}`, name, ctx);
        const rr = await readTool({ ...a, path: paths[0] }, ctx);
        try { noteSeen(ctx, paths[0], await ws.readFile(paths[0])); } catch { /* directories, binaries: nothing to track */ }
        return rr;
      }
      const results = [];
      for (const p of paths) {
        try {
          await ensure('read', p, `read ${p}`, name, ctx);
          results.push({ path: p, ...(await readTool({ ...a, path: p, offset: a.offset, limit: a.limit }, ctx)) });
          try { noteSeen(ctx, p, await ws.readFile(p)); } catch { /* not a text file */ }
        } catch (e) {
          results.push({ path: p, error: String(e && e.message ? e.message : e) });
        }
      }
      return { files: results };
    }
    case 'write_file': case 'edit_file': case 'multi_edit': case 'move_file': case 'json_edit': case 'delete_file':
      return executeFileEditTool(name, a, ctx);
    case 'bash': {
      if (!a.command) throw new Error('command is required');
      const cmd = String(a.command);
      await ensure('bash', cmd, cmd, name, ctx, P.decideBash(cmd, ctx));
      if (ctx.config && ctx.config.snapshots !== false) await snapshot.ensureBefore(ctx.session, { timeoutSec: Number(ctx.config.snapshotTimeoutSec) || 25 });   // bash can change anything: make sure this turn has a 'before' snapshot
      const secs = Math.min(300, Math.max(1, Number(a.timeout_seconds) || 60));
      if (a.background === true) {
        const r = await procs.startBackground(cmd, { sessionId: (ctx.root && ctx.root.id) || (ctx.session && ctx.session.id) || null, config: ctx.config, interactive: a.interactive === true });
        return { ...r, output: await truncateOutput(r.output || '', 'bash', ctx.config), note: r.running ? 'Running in the background; the user sees its live progress in the studio. Do NOT poll it. Tell the user briefly what you started and end your turn now: the studio will send you a notification (exit code + end of output) the moment it finishes. It keeps running until it exits, is killed (process tool / Stop button) or the studio stops.' : 'The process already exited (see exit_code and output above).' };
      }
      const r = await procs.runForeground(cmd, secs * 1000, ctx.signal, ctx.config);
      return { ...r, output: await truncateOutput(r.output, 'bash', ctx.config) };
    }
    case 'process': {
      if (a.action === 'list') return { processes: procs.list({ forModel: true }) };
      if (a.action === 'output') return procs.output(String(a.id || ''));
      if (a.action === 'kill') return procs.kill(String(a.id || ''));
      if (a.action === 'input') {
        if (!a.id) throw new Error('id is required');
        const text = a.text == null ? '' : String(a.text);
        // what the process receives is as powerful as a command: it goes through the bash permission rules (an agent that may not run bash may not type into a shell either)
        // the pattern is sanitised so an "always allow" can only ever remember `stdin→<id> *`, never a command hidden in the typed text
        const shape = `stdin→${String(a.id).replace(/\s+/g, '_')} ${text.slice(0, 200).replace(/[;&|<>$`()\\\n\r]/g, '_')}`;
        await ensure('bash', shape, `send input to ${a.id}: ${text.slice(0, 200)}`, name, ctx);
        return procs.sendInput(String(a.id), text, { newline: a.newline !== false, closeStdin: a.close_stdin === true });
      }
      throw new Error('action must be list, output, kill or input');
    }
    case 'todo_write': {
      const list = Array.isArray(a.todos) ? a.todos : [];
      ctx.session.todos = list.map((t) => ({
        content: String((t && t.content) || t || ''),
        status: ['pending', 'in_progress', 'completed'].includes(t && t.status) ? t.status : 'pending',
        turn: ctx.session.turn,
      }));
      ctx.emit({ type: 'todos', todos: ctx.session.todos });
      return { ok: true, count: ctx.session.todos.length };
    }
    case 'task': {
      const sub = a.agent || 'general';
      await ensure('task', sub, `delegate to subagent "${sub}": ${a.description || ''}`, name, ctx);
      return ctx.runSubagent({ agent: sub, description: a.description, prompt: a.prompt, taskId: a.task_id });
    }
    case 'task_tree': return { counts: workflow.counts(), tasks: workflow.tree(ctx.session.id) };
    case 'webfetch': {
      if (!web.netEnabled(ctx.config)) throw new Error('webfetch: internet access is turned off (netcheck).');
      const url = String(a.url || '');
      if (web.isPrivateHost(url)) await ensure('webfetch_private', url, `fetch (local/private network) ${url}`, name, ctx);
      else await ensure('webfetch', url, `fetch ${url}`, name, ctx);
      const r = await web.webfetch({ url, format: a.format, timeout: a.timeout, allowPrivate: Boolean(ctx.config && ctx.config.webfetch && ctx.config.webfetch.allowPrivate) });
      return { url: r.url, content_type: r.content_type, content: await truncateOutput(r.content, 'webfetch', ctx.config) };
    }
    case 'websearch': {
      if (!web.netEnabled(ctx.config)) throw new Error('websearch: internet access is turned off (netcheck).');
      await ensure('websearch', String(a.query || ''), `web search: ${a.query}`, name, ctx);
      return { results: await truncateOutput(await web.websearch(String(a.query || ''), ctx.config, Number(a.numResults) || 8, { recency: a.recency, site_type: a.site_type, autoFetchLimit: a.autoFetchLimit }), 'websearch', ctx.config) };
    }
    case 'skill': {
      const ref = String(a.name || '').trim();
      const authorize = (cat, pat, sum) => ensure(cat, pat, sum, name, ctx);
      if (skills.isRemoteRef(ref)) {
        if (!skills.remoteOn(ctx.config)) throw new Error('skill: remote skills are off (netcheck or remoteSkills is disabled).');
        if (P.disabled('webfetch', ctx.agent, ctx.config, ctx.inherited)) throw new Error(`skill: loading remote skills is not allowed for the "${ctx.agent.name}" agent (webfetch disabled).`);
        if (web.isPrivateHost(ref)) await ensure('webfetch_private', ref, `load remote skill (local/private network) ${ref}`, name, ctx);
        else await ensure('webfetch', ref, `load remote skill ${ref}`, name, ctx);
        return { content: await skills.loadAny(ref, ctx.config, {}, authorize) };
      }
      const known = Boolean(skills.loadSkills(ctx.config)[ref] || skills.loadRemoteBundled(ref, ctx.config));
      const remote = skills.remoteOn(ctx.config);
      if (!known && remote && (P.disabled('websearch', ctx.agent, ctx.config, ctx.inherited) || P.disabled('webfetch', ctx.agent, ctx.config, ctx.inherited))) {
        throw new Error(`skill: no local skill "${ref}", and remote lookup is not allowed for the "${ctx.agent.name}" agent.`);
      }
      if (known || !remote) await ensure('skill', ref, `load skill ${a.name}`, name, ctx);
      return { content: await skills.loadAny(ref, ctx.config, {}, authorize) };
    }
    case 'lsp': {
      await ensure('lsp', String(a.path || ''), `lsp ${a.operation} ${a.path}`, name, ctx);
      return { result: await truncateOutput(await lsp.operation(a.operation, a.path, a.line, a.character, a.query, ctx.config), 'lsp', ctx.config) };
    }
    case 'question': {
      const answer = await ctx.askUser({ question: String(a.question || ''), options: Array.isArray(a.options) ? a.options.map(String) : [] });
      return { answer };
    }
    case 'switch_agent': {
      if (!isAuto(ctx.session.agent)) throw new Error('switch_agent only works in auto mode');
      const list = autoCandidates();
      const target = list.find((x) => x.name === String(a.agent || '').trim());
      if (!target) throw new Error(`unknown agent "${a.agent}". Choose one of: ${list.filter((x) => x.name !== ctx.agent.name).map((x) => x.name).join(', ')}`);
      if (target.name === ctx.agent.name) return { switched: false, note: `You already are the "${target.name}" agent; keep working.` };
      ctx.session.autoAgent = target.name;                                     // the agent loop adopts it after this step
      ctx.session.autoSwitch = { from: ctx.agent.name, reason: String(a.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200) };
      return { switched: true, note: `Handing the work over to the "${target.name}" agent.` };
    }
    case 'plan_exit': {
      const answer = await ctx.askUser({ question: 'The plan is ready. Switch to the build agent to implement it?', options: ['Yes, build it', 'No, keep planning'] });
      if (/^yes/i.test(answer)) {
        if (isAuto(ctx.session.agent)) ctx.session.autoAgent = 'build';     // stay in auto mode, just continue as build
        else ctx.session.agent = 'build';
        ctx.session.switchedFromPlan = true;
        return { approved: true, note: 'Switching to the build agent.' };
      }
      return { approved: false, user_feedback: answer, note: 'Stay in plan mode and refine the plan.' };
    }
  }
}

const MUTATING = new Set(['write_file', 'edit_file', 'multi_edit', 'json_edit', 'move_file', 'delete_file', 'bash', 'task']);

/** Runs a tool; anything that can change files also drops the cached directory listing (glob/grep/list_files stay fresh). */
async function executeTool(name, args, ctx) {
  const hookCtx = { config: ctx.config, session: ctx.session, agent: ctx.agent, emit: ctx.emit, signal: ctx.signal };
  const base = {
    tool: name,
    args: safeHookValue(args || {}),
    agent: ctx.agent && ctx.agent.name,
    sessionId: (ctx.session && ctx.session.id) || null,
  };
  await hooks.run('on_tool_call', base, { ...hookCtx, blocking: true });
  let result;
  try {
    result = await executeToolInner(name, args, ctx);
  } catch (e) {
    try { await hooks.run('on_tool_result', { ...base, error: String(e && e.message ? e.message : e) }, { ...hookCtx, blocking: false }); } catch (e2) { log.debug('tools', 'on_tool_result hook failed', e2); }
    throw e;
  } finally {
    if (MUTATING.has(name) || plugins.isTool(name) || name.startsWith('mcp_')) ws.invalidateWalk();
  }
  try { await hooks.run('on_tool_result', { ...base, result: safeHookValue(result) }, { ...hookCtx, blocking: false }); } catch (e) { log.debug('tools', 'on_tool_result hook failed', e); }
  return result;
}

module.exports = { TOOLS, toolDefsFor, executeTool };

function detectIndent(s) {
  const m2 = s.match(/\n([ ]{2})[^\n]/);
  if (m2) return '  ';
  const m4 = s.match(/\n([ ]{4})[^\n]/);
  if (m4) return '    ';
  const mt = s.match(/\n(\t)[^\n]/);
  if (mt) return '\t';
  return 2;
}

function parsePath(p) {
  const s = String(p || '');
  const parts = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '.') { if (cur) { parts.push(cur); cur = ''; } i++; continue; }
    if (s[i] === '[') {
      if (cur) { parts.push(cur); cur = ''; }
      i++;
      if (s[i] === '"') { i++; while (i < s.length && s[i] !== '"') { if (s[i] === '\\' && i+1 < s.length) i++; cur += s[i++]; } i++; }
      else if (s[i] === "'") { i++; while (i < s.length && s[i] !== "'") { if (s[i] === '\\' && i+1 < s.length) i++; cur += s[i++]; } i++; }
      else { while (i < s.length && s[i] >= '0' && s[i] <= '9') cur += s[i++]; }
      parts.push(cur); cur = '';
      if (s[i] === ']') i++;
      continue;
    }
    if (s[i] === '\\') { i++; cur += s[i++] || ''; continue; }
    cur += s[i++];
  }
  if (cur) parts.push(cur);
  return parts.filter((x) => x !== '');
}

function getAt(obj, parts) {
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null || typeof cur !== 'object') throw new Error('path does not exist');
    const k = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    if (Array.isArray(cur) && typeof k === 'number') { if (k < 0 || k >= cur.length) throw new Error('path does not exist'); cur = cur[k]; continue; }
    if (typeof k === 'string' && k in cur) { cur = cur[k]; continue; }
    throw new Error('path does not exist');
  }
  return cur;
}

function setAt(obj, parts, value) {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    const nk = /^\d+$/.test(parts[i + 1]) ? Number(parts[i + 1]) : parts[i + 1];
    if (Array.isArray(cur) && typeof k === 'number') {
      if (k < 0) throw new Error('invalid path');
      if (k >= cur.length) {
        while (cur.length <= k) cur.push(null);
      }
      if (cur[k] == null) cur[k] = typeof nk === 'number' ? [] : {};
      cur = cur[k];
    } else if (typeof k === 'string') {
      if (cur == null || typeof cur !== 'object') throw new Error('invalid path');
      if (cur[k] == null) cur[k] = typeof nk === 'number' ? [] : {};
      cur = cur[k];
    } else throw new Error('invalid path');
  }
  const lk = /^\d+$/.test(parts[parts.length - 1]) ? Number(parts[parts.length - 1]) : parts[parts.length - 1];
  if (Array.isArray(cur) && typeof lk === 'number') { if (lk < 0) throw new Error('invalid path'); while (cur.length < lk) cur.push(null); cur[lk] = value; }
  else if (cur && typeof cur === 'object') { if (Array.isArray(cur)) throw new Error('invalid path'); cur[lk] = value; }
  else throw new Error('invalid path');
  return obj;
}

function delAt(obj, parts) {
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    if (cur == null || typeof cur !== 'object') throw new Error('path does not exist');
    if (Array.isArray(cur) && typeof k === 'number') { if (k < 0 || k >= cur.length) throw new Error('path does not exist'); cur = cur[k]; }
    else if (typeof k === 'string' && k in cur) cur = cur[k];
    else throw new Error('path does not exist');
  }
  const lk = /^\d+$/.test(parts[parts.length - 1]) ? Number(parts[parts.length - 1]) : parts[parts.length - 1];
  if (Array.isArray(cur) && typeof lk === 'number') { if (lk < 0 || lk >= cur.length) throw new Error('path does not exist'); cur.splice(lk, 1); }
  else if (typeof cur === 'object' && cur !== null && lk in cur) delete cur[lk];
  else throw new Error('path does not exist');
  return obj;
}

function jsonEdit(text, op, key, value) {
  let obj;
  try { obj = JSON.parse(String(text)); } catch (e) { throw new Error('not valid JSON'); }
  const parts = parsePath(key);
  if (!parts.length) throw new Error('invalid path');
  if (op === 'get') {
    const v = getAt(obj, parts);
    if (v === undefined) throw new Error('key does not exist');
    return { value: v };
  }
  if (op === 'delete') {
    const nj = JSON.parse(JSON.stringify(obj));
    if (delAt(nj, parts) === false) throw new Error('key does not exist');
    try { JSON.stringify(nj); } catch (e) { throw new Error('result is not valid JSON'); }
    const indent = detectIndent(String(text));
    const indentStr = typeof indent === 'number' ? ' '.repeat(indent) : indent;
    const textOut = JSON.stringify(nj, null, indentStr);
    if (!textOut.endsWith('\n')) return { text: textOut + '\n' };
    return { text: textOut };
  } else if (op === 'set') {
    let v = value;
    if (v === undefined && arguments.length < 4) throw new Error('value is required for set');
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch (e) { throw new Error('value is not valid JSON: ' + e.message); }
    }
    const nj = JSON.parse(JSON.stringify(obj));
    setAt(nj, parts, v);
    try { JSON.stringify(nj); } catch (e) { throw new Error('result is not valid JSON'); }
    const indent = detectIndent(String(text));
    const indentStr = typeof indent === 'number' ? ' '.repeat(indent) : indent;
    const textOut = JSON.stringify(nj, null, indentStr);
    if (!textOut.endsWith('\n')) return { text: textOut + '\n' };
    return { text: textOut };
  } else throw new Error('op must be get, set, or delete');
}
