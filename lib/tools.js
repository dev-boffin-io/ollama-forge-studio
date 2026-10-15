'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const procs = require('./procs');
const ws = require('./workspace');
const { getWorkDir, studioDir } = require('./config');
const { subagents } = require('./agents');
const P = require('./permission');
const journal = require('./journal');
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
  glob: def('glob', 'Find files by glob pattern, e.g. "**/*.js" or "src/**/*.{ts,tsx}".', { pattern: S('Glob pattern.') }, ['pattern']),
  grep: def('grep', 'Search file contents with a regular expression. Returns "path:line: text" matches.', {
    pattern: S('JavaScript regular expression.'), include: S('Optional glob to limit files, e.g. "*.js".'),
  }, ['pattern']),
  read_file: def('read_file', 'Read a file (output has "N: " line-number prefixes that are NOT part of the file). Reads up to 5000 lines; use offset/limit for more. On a directory it lists entries.', {
    path: S('File path relative to the working directory.'),
    offset: { type: 'number', description: 'First line to read (1-based).' },
    limit: { type: 'number', description: 'Max lines to read (default 5000).' },
  }, ['path']),
  write_file: def('write_file', 'Create a file or completely overwrite an existing one. Parent folders are created automatically. Prefer edit_file for changes to existing files.', {
    path: S('File path relative to the working directory.'), content: S('Full file content.'),
  }, ['path', 'content']),
  edit_file: def('edit_file', 'Replace text in an existing file. old_string must identify exactly one place (include surrounding lines to make it unique) unless replace_all is true. Minor whitespace/indentation differences are tolerated.', {
    path: S('File path relative to the working directory.'),
    old_string: S('Existing text to replace (no line-number prefixes).'),
    new_string: S('Replacement text.'),
    replace_all: { type: 'boolean', description: 'Replace every occurrence (e.g. renaming a variable).' },
  }, ['path', 'old_string', 'new_string']),
  delete_file: def('delete_file', 'Delete a file or folder.', { path: S('Path relative to the working directory.') }, ['path']),
  bash: def('bash', 'Run a shell command in the working directory (git, npm, tests, builds...). Do NOT use it to read/search/edit files; use the dedicated tools. Output is truncated. stdin is closed. IMPORTANT: anything that keeps running (web/file servers, watchers, dev servers, "tail -f") MUST use background=true, otherwise the command blocks until the timeout and is killed. Never append "&" yourself.', {
    command: S('The shell command.'), timeout_seconds: { type: 'number', description: 'Timeout for foreground commands, default 60, max 300.' },
    background: { type: 'boolean', description: 'Start the command detached and return immediately with its id and first output. Use for servers/watchers.' },
  }, ['command']),
  process: def('process', 'Manage background processes started with bash background=true: list them, read their latest output, or kill one.', {
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
  websearch: def('websearch', 'Search the web for up-to-date information. Returns the most relevant results with content snippets. The current year is ' + new Date().getFullYear() + '; use it when searching for recent information.', {
    query: S('Search query.'), numResults: { type: 'number', description: 'Number of results (default 8).' },
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

const CATEGORY = { write_file: 'edit', edit_file: 'edit', delete_file: 'edit', bash: 'bash', read_file: 'read' };
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
    } catch { /* ignore */ }
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
async function executeTool(name, args, ctx) {
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
    case 'glob': return { matches: await ws.glob(String(a.pattern || '')) };
    case 'grep': {
      const matches = await ws.grep(String(a.pattern || ''), a.include);
      return { matches: await truncateOutput(matches.join('\n'), 'grep', ctx.config), count: matches.length };
    }
    case 'read_file':
      await ensure('read', a.path, `read ${a.path}`, name, ctx);
      return readTool(a, ctx);
    case 'write_file': {
      await ensure('edit', a.path, `write ${a.path}`, name, ctx);
      await journal.track(ctx.root, a.path);
      const wr = { ok: true, ...(await ws.writeFile(a.path, a.content)) };
      return withDiagnostics(wr, a.path, ctx);
    }
    case 'edit_file': {
      await ensure('edit', a.path, `edit ${a.path}`, name, ctx);
      const before = await ws.readFile(a.path);
      const { content } = replace(before, String(a.old_string ?? ''), String(a.new_string ?? ''), a.replace_all === true);
      await journal.track(ctx.root, a.path);
      await ws.writeFile(a.path, content);
      return withDiagnostics({ ok: true, path: a.path, ...miniDiff(before, content) }, a.path, ctx);
    }
    case 'delete_file':
      await ensure('edit', a.path, `delete ${a.path}`, name, ctx);
      await journal.track(ctx.root, a.path);
      return ws.deleteFile(a.path);
    case 'bash': {
      if (!a.command) throw new Error('command is required');
      const cmd = String(a.command);
      await ensure('bash', cmd, cmd, name, ctx, P.decideBash(cmd, ctx));
      const secs = Math.min(300, Math.max(1, Number(a.timeout_seconds) || 60));
      if (a.background === true) {
        const r = await procs.startBackground(cmd);
        return { ...r, output: await truncateOutput(r.output || '', 'bash', ctx.config), note: r.running ? 'Running in the background. Use the process tool (list/output/kill) to manage it; it keeps running until killed or the studio stops.' : 'The process already exited.' };
      }
      const r = await procs.runForeground(cmd, secs * 1000, ctx.signal);
      return { ...r, output: await truncateOutput(r.output, 'bash', ctx.config) };
    }
    case 'process': {
      if (a.action === 'list') return { processes: procs.list() };
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
      return { results: await truncateOutput(await web.websearch(String(a.query || ''), ctx.config, Number(a.numResults) || 8), 'websearch', ctx.config) };
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

module.exports = { TOOLS, toolDefsFor, executeTool };
