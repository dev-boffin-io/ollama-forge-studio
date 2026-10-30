'use strict';

const log = require('./log');

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const procs = require('./procs');
const ws = require('./workspace');
const { getWorkDir, studioDir } = require('./config');
const { subagents } = require('./agents');
const P = require('./permission');
const journal = require('./journal');
const snapshot = require('./snapshot');
const { replace, miniDiff } = require('./edit-match');
const mcp = require('./mcp');
const lsp = require('./lsp');
const skills = require('./skills');
const web = require('./web');
const recall = require('./recall');

function def(name, description, properties, required) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required: required || [] } } };
}
const S = (description) => ({ type: 'string', description });

const TOOLS = {
  list_files: def('list_files', 'List files and folders in the working directory as a flat list of relative paths.', {}, []),
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
    path: S('File path relative to the working directory.'), content: S('Full file content.'),
  }, ['path', 'content']),
  edit_file: def('edit_file', 'Replace text in an existing file. old_string must identify exactly one place (include surrounding lines to make it unique) unless replace_all is true. Minor whitespace/indentation differences are tolerated.', {
    path: S('File path relative to the working directory.'),
    old_string: S('Existing text to replace (no line-number prefixes).'),
    new_string: S('Replacement text.'),
    replace_all: { type: 'boolean', description: 'Replace every occurrence (e.g. renaming a variable).' },
    dry_run: { type: 'boolean', description: 'If true, show the match/diff that would be applied without writing the file.' },
  }, ['path', 'old_string', 'new_string']),
  multi_edit: def('multi_edit', 'Apply a sequence of edits to one file in order. Each edit uses the existing fuzzy matcher. All-or-nothing: if any edit fails or is ambiguous, nothing is written and the report says which edit failed and why. Journaled as a single change for Undo.', {
    path: S('File path relative to the working directory.'),
    edits: { type: 'array', items: { type: 'object', properties: { old_string: S('Existing text'), new_string: S('Replacement text'), replace_all: { type: 'boolean' } }, required: ['old_string', 'new_string'] }, description: 'List of edits to apply in order.' },
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
  }, ['command']),
  process: def('process', 'Manage background processes started with bash background=true: list them, read their latest output, or kill one. Do not call it in a loop to wait for a job: the studio notifies you when a process exits. Use it to inspect errors, or to kill a process the user no longer wants.', {
    action: { type: 'string', enum: ['list', 'output', 'kill'], description: 'list | output | kill' }, id: S('Process id (e.g. proc_1) for output/kill.'),
  }, ['action']),
  todo_write: def('todo_write', 'Create/update the task checklist for a multi-step job. Send the FULL list every time. Keep one item in_progress.', {
    todos: { type: 'array', description: 'Items: {content, status} where status is pending | in_progress | completed.', items: { type: 'object' } },
  }, ['todos']),
  task: def('task', 'Delegate a self-contained job to a subagent running in its own session; it returns one final report. Pass task_id from an earlier result to continue that subagent session.', {
    description: S('Short (3-6 words) label.'), prompt: S('Complete instructions; the subagent does not see this conversation.'),
    agent: S('Subagent name (see system prompt). Defaults to "general".'), task_id: S('Optional: resume a previous subagent session.'),
  }, ['description', 'prompt']),
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
  skill: def('skill', 'Load a specialised skill (instructions + resources) by name. Only names listed in the system prompt are valid.', { name: S('Skill name.') }, ['name']),
  lsp: def('lsp', 'Code intelligence via a language server. Operations: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, diagnostics. line and character are 1-based (as shown by read_file).', {
    operation: S('One of: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, diagnostics.'),
    path: S('File path relative to the working directory.'), line: { type: 'number', description: '1-based line.' }, character: { type: 'number', description: '1-based column.' },
    query: S('Only for workspaceSymbol: the symbol query.'),
  }, ['operation', 'path']),
  question: def('question', 'Ask the user a question when you need a decision or missing requirement. Provide short options when sensible; the user can also type their own answer.', {
    question: S('The question.'), options: { type: 'array', description: 'Optional answer choices (strings).', items: { type: 'string' } },
  }, ['question']),
  plan_exit: def('plan_exit', 'Call when the plan is final. Asks the user to approve switching to the build agent to implement it.', {}, []),
};

const CATEGORY = { write_file: 'edit', edit_file: 'edit', multi_edit: 'edit', move_file: 'edit', json_edit: 'edit', delete_file: 'edit', bash: 'bash', read_file: 'read' };
const primaryOnly = new Set(['question', 'plan_exit', 'task']);

/** Tool schemas visible to an agent (tools it can never use are hidden from the model). */
function toolDefsFor(agent, config, { isChild, inherited = [] }) {
  const rules = P.rulesFor(agent, config, inherited);
  const builtin = Object.entries(TOOLS)
    .filter(([name]) => {
      if (name === 'skill') return Object.keys(skills.loadSkills(config)).length > 0 && !P.disabled('skill', agent, config, inherited);
      if (name === 'lsp') return lsp.available(config) && !P.disabled('lsp', agent, config, inherited);
      if (name === 'recall') return recall.available() && !P.disabled('recall', agent, config, inherited);
      if (name === 'webfetch' || name === 'websearch') return !P.disabled(name, agent, config, inherited);
      if (isChild && primaryOnly.has(name)) return false;
      if (isChild && name === 'todo_write' && !(agent.permission && agent.permission.todo_write)) return false;
      if (name === 'plan_exit') return agent.name === 'plan';
      if (name === 'task') return subagents().length > 0 && !P.disabled('task', agent, config, inherited);
      const cat = CATEGORY[name];
      return !cat || !P.disabled(cat, agent, config, inherited);
    })
    .map(([, d]) => d);
  const extra = mcp.tools()
    .filter((t) => P.evaluate('mcp', t.name, rules).action !== 'deny')
    .map((t) => ({ type: 'function', function: { name: t.name, description: `[MCP ${t.server}] ${t.description}`.slice(0, 1000), parameters: t.parameters } }));
  return [...builtin, ...extra];
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

async function ensure(permission, pattern, summary, tool, ctx, decision) {
  const d = decision || P.decide(permission, pattern, ctx);
  if (d === 'deny') throw new Error(`${tool}: "${pattern}" is not allowed for the "${ctx.agent.name}" agent (permission rule).`);
  if (d === 'allow') return;
  const reply = await ctx.askPermission({ tool, category: permission, summary });
  if (reply === 'always') { P.grant(ctx.session, permission, pattern); return; }
  if (reply !== 'once') throw new Error('permission rejected by the user');
}

const DOOM_THRESHOLD = 3;

/** Append language-server errors (if any) to a write/edit result so the model can fix them immediately. */
async function withDiagnostics(result, relPath, ctx) {
  if (!lsp.available(ctx.config)) return result;
  const errs = await lsp.diagnosticsAfterWrite(relPath, ctx.config);
  return errs ? { ...result, lsp_errors: errs, note: 'The language server reports errors in this file; fix them.' } : result;
}

/** Same tool + identical input N times in a row = the model is stuck. */
async function checkDoomLoop(name, args, ctx) {
  const calls = [];
  for (const m of ctx.session.messages) for (const c of m.tool_calls || []) calls.push(c.function);
  const recent = calls.slice(-(DOOM_THRESHOLD - 1));
  const key = JSON.stringify(args || {});
  if (recent.length === DOOM_THRESHOLD - 1 && recent.every((c) => c.name === name && JSON.stringify(c.arguments || {}) === key)) {
    await ensure('doom_loop', name, `The agent called "${name}" ${DOOM_THRESHOLD} times in a row with identical input (it may be stuck). Continue?`, 'doom_loop', ctx);
  }
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

/**
 * Execute one tool call. ctx = { agent, config, session, root, inherited, emit, signal, askPermission, askUser, runSubagent }
 */
async function executeToolInner(name, args, ctx) {
  const a = args || {};
  if (!TOOLS[name] && !mcp.isMcpTool(name)) throw new Error(`unknown tool: ${name}`);
  await checkDoomLoop(name, a, ctx);

  if (!TOOLS[name]) { // MCP tool
    await ensure('mcp', name, `${name}(${JSON.stringify(a).slice(0, 300)})`, name, ctx);
    return { output: await truncateOutput(await mcp.call(name, a), name, ctx.config) };
  }

  switch (name) {
    case 'recall': {
      if (!recall.available()) return { error: 'history search is unavailable (needs Node >= 22.5 with SQLite FTS5)' };
      recall.indexSession(ctx.session);
      const live = new Set(recall.parts(ctx.session).map((p) => p.h));
      const hits = recall.search(String(a.query || ''), {
        limit: Math.min(12, Math.max(1, Number(a.limit) || 6)), sid: a.scope === 'session' ? ctx.session.id : null, exclude: live, maxChars: 1200,
      });
      if (!hits.length) return { results: 'no matches outside your current context — try different or fewer keywords' };
      return { count: hits.length, results: recall.format(hits) };
    }
    case 'list_files': return { files: await ws.listFlat(1000) };
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
        return readTool({ ...a, path: paths[0] }, ctx);
      }
      const results = [];
      for (const p of paths) {
        try {
          await ensure('read', p, `read ${p}`, name, ctx);
          results.push({ path: p, ...(await readTool({ ...a, path: p, offset: a.offset, limit: a.limit }, ctx)) });
        } catch (e) {
          results.push({ path: p, error: String(e && e.message ? e.message : e) });
        }
      }
      return { files: results };
    }
    case 'write_file': {
      await ensure('edit', a.path, `write ${a.path}`, name, ctx);
      await journal.track(ctx.root, a.path);
      const wr = { ok: true, ...(await ws.writeFile(a.path, a.content)) };
      return withDiagnostics(wr, a.path, ctx);
    }
    case 'edit_file': {
      await ensure('edit', a.path, `edit ${a.path}`, name, ctx);
      const before = await ws.readFile(a.path);
      if (a.dry_run === true) {
        const r = replace(before, String(a.old_string ?? ''), String(a.new_string ?? ''), a.replace_all === true);
        return { dry_run: true, path: a.path, ...miniDiff(before, r.content), matched: typeof r.matched === 'string' };
      }
      const r = replace(before, String(a.old_string ?? ''), String(a.new_string ?? ''), a.replace_all === true);
      await journal.track(ctx.root, a.path);
      await ws.writeFile(a.path, r.content);
      return withDiagnostics({ ok: true, path: a.path, ...miniDiff(before, r.content) }, a.path, ctx);
    }
    case 'multi_edit': {
      await ensure('edit', a.path, `edit ${a.path}`, name, ctx);
      const edits = Array.isArray(a.edits) ? a.edits : [];
      const before = await ws.readFile(a.path);
      let current = before;
      const applied = [];
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i] || {};
        try {
          const res = replace(current, String(e.old_string ?? ''), String(e.new_string ?? ''), e.replace_all === true);
          current = res.content;
          applied.push({ index: i, ok: true });
        } catch (err) {
          throw new Error(`multi_edit failed at edit ${i}: ${err && err.message ? err.message : err}`);
        }
      }
      if (current === before) throw new Error('multi_edit produced no changes');
      await journal.track(ctx.root, a.path);
      await ws.writeFile(a.path, current);
      return withDiagnostics({ ok: true, path: a.path, edits: applied.length, ...miniDiff(before, current) }, a.path, ctx);
    }
    case 'move_file': {
      await ensure('edit', a.from, `move ${a.from} -> ${a.to}`, name, ctx);
      await ensure('edit', a.to, `move to ${a.to}`, name, ctx);
      await journal.track(ctx.root, a.from);
      await journal.track(ctx.root, a.to);
      const r = await ws.moveFile(a.from, a.to, a.overwrite === true);
      return { ok: true, ...r };
    }
    case 'json_edit': {
      await ensure('edit', a.path, `json_edit ${a.op} ${a.key} in ${a.path}`, name, ctx);
      const before = await ws.readFile(a.path);
      const res = jsonEdit(before, a.op, a.key, a.value);
      if (a.op !== 'get') {
        await journal.track(ctx.root, a.path);
        await ws.writeFile(a.path, res.text);
      }
      return a.op === 'get' ? { ok: true, value: res.value } : { ok: true, path: a.path };
    }
    case 'delete_file':
      await ensure('edit', a.path, `delete ${a.path}`, name, ctx);
      await journal.track(ctx.root, a.path);
      return ws.deleteFile(a.path);
    case 'bash': {
      if (!a.command) throw new Error('command is required');
      const cmd = String(a.command);
      await ensure('bash', cmd, cmd, name, ctx, P.decideBash(cmd, ctx));
      if (ctx.config && ctx.config.snapshots !== false) await snapshot.ensureBefore(ctx.session, { timeoutSec: Number(ctx.config.snapshotTimeoutSec) || 25 });   // bash can change anything: make sure this turn has a 'before' snapshot
      const secs = Math.min(300, Math.max(1, Number(a.timeout_seconds) || 60));
      if (a.background === true) {
        const r = await procs.startBackground(cmd, { sessionId: (ctx.root && ctx.root.id) || (ctx.session && ctx.session.id) || null });
        return { ...r, output: await truncateOutput(r.output || '', 'bash', ctx.config), note: r.running ? 'Running in the background; the user sees its live progress in the studio. Do NOT poll it. Tell the user briefly what you started and end your turn now: the studio will send you a notification (exit code + end of output) the moment it finishes. It keeps running until it exits, is killed (process tool / Stop button) or the studio stops.' : 'The process already exited (see exit_code and output above).' };
      }
      const r = await procs.runForeground(cmd, secs * 1000, ctx.signal);
      return { ...r, output: await truncateOutput(r.output, 'bash', ctx.config) };
    }
    case 'process': {
      if (a.action === 'list') return { processes: procs.list({ forModel: true }) };
      if (a.action === 'output') return procs.output(String(a.id || ''));
      if (a.action === 'kill') return procs.kill(String(a.id || ''));
      throw new Error('action must be list, output or kill');
    }
    case 'todo_write': {
      const list = Array.isArray(a.todos) ? a.todos : [];
      ctx.session.todos = list.map((t) => ({
        content: String((t && t.content) || t || ''),
        status: ['pending', 'in_progress', 'completed'].includes(t && t.status) ? t.status : 'pending',
      }));
      ctx.emit({ type: 'todos', todos: ctx.session.todos });
      return { ok: true, count: ctx.session.todos.length };
    }
    case 'task': {
      const sub = a.agent || 'general';
      await ensure('task', sub, `delegate to subagent "${sub}": ${a.description || ''}`, name, ctx);
      return ctx.runSubagent({ agent: sub, description: a.description, prompt: a.prompt, taskId: a.task_id });
    }
    case 'webfetch': {
      const url = String(a.url || '');
      if (web.isPrivateHost(url)) await ensure('webfetch_private', url, `fetch (local/private network) ${url}`, name, ctx);
      else await ensure('webfetch', url, `fetch ${url}`, name, ctx);
      const r = await web.webfetch({ url, format: a.format, timeout: a.timeout });
      return { url: r.url, content_type: r.content_type, content: await truncateOutput(r.content, 'webfetch', ctx.config) };
    }
    case 'websearch': {
      await ensure('websearch', String(a.query || ''), `web search: ${a.query}`, name, ctx);
      return { results: await truncateOutput(await web.websearch(String(a.query || ''), ctx.config, Number(a.numResults) || 8, { recency: a.recency, site_type: a.site_type, autoFetchLimit: a.autoFetchLimit }), 'websearch', ctx.config) };
    }
    case 'skill': {
      await ensure('skill', String(a.name || ''), `load skill ${a.name}`, name, ctx);
      return { content: skills.load(String(a.name || ''), ctx.config) };
    }
    case 'lsp': {
      await ensure('lsp', String(a.path || ''), `lsp ${a.operation} ${a.path}`, name, ctx);
      return { result: await truncateOutput(await lsp.operation(a.operation, a.path, a.line, a.character, a.query, ctx.config), 'lsp', ctx.config) };
    }
    case 'question': {
      const answer = await ctx.askUser({ question: String(a.question || ''), options: Array.isArray(a.options) ? a.options.map(String) : [] });
      return { answer };
    }
    case 'plan_exit': {
      const answer = await ctx.askUser({ question: 'The plan is ready. Switch to the build agent to implement it?', options: ['Yes, build it', 'No, keep planning'] });
      if (/^yes/i.test(answer)) { ctx.session.agent = 'build'; ctx.session.switchedFromPlan = true; return { approved: true, note: 'Switching to the build agent.' }; }
      return { approved: false, user_feedback: answer, note: 'Stay in plan mode and refine the plan.' };
    }
  }
}

const MUTATING = new Set(['write_file', 'edit_file', 'delete_file', 'bash', 'task']);

/** Runs a tool; anything that can change files also drops the cached directory listing (glob/grep/list_files stay fresh). */
async function executeTool(name, args, ctx) {
  try { return await executeToolInner(name, args, ctx); }
  finally { if (MUTATING.has(name) || name.startsWith('mcp_')) ws.invalidateWalk(); }
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
    return { value: getAt(obj, parts) };
  }
  if (op === 'delete') {
    delAt(obj, parts);
  } else if (op === 'set') {
    let v = value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* keep string */ } }
    if (v === undefined && arguments.length < 4) throw new Error('value is required for set');
    setAt(obj, parts, v);
  } else throw new Error('op must be get, set, or delete');
  try { JSON.stringify(obj); } catch (e) { throw new Error('result is not valid JSON'); }
  const indent = detectIndent(String(text));
  const indentStr = typeof indent === 'number' ? ' '.repeat(indent) : indent;
  const textOut = JSON.stringify(obj, null, indentStr) + '\n';
  return { text: textOut };
}
