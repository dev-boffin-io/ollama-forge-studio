'use strict';

const log = require('./log');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { isSea } = require('./runtime');

// Source checkout: config.json + ./workspace live next to the code (as before).
// Single executable: there is no source tree, so the global config lives in GLOBAL_DIR instead.
// (GLOBAL_DIR keeps its historical name so existing agents/commands/skills/config keep working.)
const APP_ROOT = isSea() ? null : path.resolve(__dirname, '..');
const GLOBAL_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ollama-studio');
const CONFIG_PATH = APP_ROOT ? path.join(APP_ROOT, 'config.json') : path.join(GLOBAL_DIR, 'config.json');
const LEGACY_WORKSPACE = APP_ROOT ? path.join(APP_ROOT, 'workspace') : null;

const DEFAULT_CONFIG = {
  endpoint: 'http://localhost:11434',
  model: '',
  agent: 'build',
  thinking: false,
  visionModel: '',             // optional: a vision-capable model that describes images when the chat model can't see them
  maxUploadMB: 500,
  recallAuto: true,            // auto-inject keyword matches from older history (SQLite FTS5; needs Node >= 22.5)
  temperature: 0.2,
  numCtx: 0,                   // 0 = auto (detect from the model, capped by autoCtxMax); or a fixed number
  autoCtxMax: 131072,
  smallModel: '',              // optional cheaper model ref for titles + summaries
  apiKey: '',                  // optional key for the default provider (plain local Ollama needs none)
  providers: {},               // extra providers: { id: { type: 'ollama'|'openai'|'anthropic', endpoint, apiKey|apiKeyEnv, contextWindow, maxTokens } }
  defaultProvider: 'default',  // 'default' = the top-level `endpoint`
  mcp: {},                     // { name: { type: 'local', command: [...], environment: {} } | { type: 'remote', url, headers } }
  lsp: {},                     // { name: { command: [...], extensions: ['.py'] } } or false to disable LSP
  websearch: { provider: 'exa' }, // exa | ddg | searxng (+ url)
  skills: { paths: [] },
  maxIterations: 200,
  requestTimeoutMs: 600000,
  autoCompact: true,
  // rules; value = allow|ask|deny, or a pattern map (last matching rule wins).
  permission: {
    edit: 'allow',
    bash: { '*': 'ask', 'ls *': 'allow', 'pwd': 'allow', 'git status*': 'allow', 'git diff*': 'allow', 'git log*': 'allow', 'rm *': 'ask' },
  },
  instructions: [],            // extra instruction files, e.g. ["docs/rules.md", "~/my-rules.md"]
  toolOutput: {},              // { maxLines, maxBytes } before long tool output is saved to <studio data dir>/tool-output/
  systemPrompt:
    'You are an autonomous software engineer working inside the current project directory. ' +
    'You read and change real files ONLY by calling the provided tools. ' +
    'Never invent file contents in plain text and claim they exist — actually call the tools. ' +
    'Work step by step: explore with list_files/glob/grep/read_file, then edit, then verify. ' +
    'Prefer edit_file for small changes (copy old_string exactly from read_file output, without the line-number prefixes). All paths are relative to the project directory. ' +
    'When finished, give a short summary of what you did.',
};

let workDir = process.cwd();

/** Directory the agent works in (wherever you launch it). */
function getWorkDir() { return workDir; }

// Studio data (sessions, uploads, recall index, snapshots, ...) lives in the user's HOME, never inside the project:
//   ~/.studio/<project-name>-<hash>/{sessions,uploads,tool-output,plans,agents,skills,commands,snapshot.git,recall.db,config.json}
// One folder per project directory, so session data of different projects never mixes.
// Override the root with $OLLAMA_STUDIO_HOME.
const STUDIO_HOME = path.resolve(process.env.OLLAMA_STUDIO_HOME || path.join(os.homedir(), '.studio'));
const VIRTUAL_PREFIX = '.studio';   // how the agent addresses this folder in tool paths (".studio/uploads/x"); see workspace.safeResolve

function projectKey(dir) {
  const name = path.basename(dir).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 40) || 'project';
  return `${name}-${crypto.createHash('sha1').update(dir).digest('hex').slice(0, 8)}`;
}
function studioRoot() { return STUDIO_HOME; }
function studioDir() { return path.join(STUDIO_HOME, projectKey(workDir)); }

function setWorkDir(dir) {
  const resolved = path.resolve(String(dir || process.cwd()));
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) throw new Error(`not a directory: ${resolved}`);
  workDir = fs.realpathSync(resolved);
  // Launched from the app's own folder? Use the legacy sandbox so the studio never edits itself.
  if (APP_ROOT && workDir === APP_ROOT) {
    fs.mkdirSync(LEGACY_WORKSPACE, { recursive: true });
    workDir = fs.realpathSync(LEGACY_WORKSPACE);
  }
  fs.mkdirSync(studioDir(), { recursive: true });
  const meta = path.join(studioDir(), 'project.json');
  if (!fs.existsSync(meta)) fs.writeFileSync(meta, JSON.stringify({ path: workDir, created: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  return workDir;
}

function readJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') log.warn('config', `cannot read ${file}`, e);
    return {};
  }
  try { return JSON.parse(raw); } catch (e) {
    // a hand-edited file with a typo: say so (once), keep a copy, and fall back to defaults instead of crashing
    log.error('config', `${file} is not valid JSON — using defaults until it is fixed`, e);
    try { fs.copyFileSync(file, file + '.broken'); } catch (e2) { log.debug('config', 'could not back up the broken config', e2); }
    return {};
  }
}

/** defaults < global config.json < <studio data dir>/config.json (~/.studio/<project>/config.json) */
function loadConfig() {
  const global = readJson(CONFIG_PATH);
  const local = readJson(path.join(studioDir(), 'config.json'));
  const merged = { ...DEFAULT_CONFIG, ...global, ...local };
  merged.permission = { ...DEFAULT_CONFIG.permission, ...(global.permission || {}), ...(local.permission || {}) };
  for (const k of ['providers', 'mcp']) merged[k] = { ...(global[k] || {}), ...(local[k] || {}) };
  return merged;
}

function saveConfig(patch) {
  const current = readJson(CONFIG_PATH);
  const next = { ...current, ...(patch || {}) };
  if (patch && patch.providers) {
    // the browser only ever sees masked keys; keep the stored secret when it sends the mask back
    const old = current.providers || {};
    next.providers = {};
    for (const [id, p] of Object.entries(patch.providers)) {
      if (!/^[A-Za-z0-9_-]+$/.test(id) || id === 'default') continue;
      const np = { ...p };
      if (typeof np.apiKey === 'string' && np.apiKey.startsWith('••••')) np.apiKey = (old[id] && old[id].apiKey) || '';
      if (!np.apiKey) delete np.apiKey;
      next.providers[id] = np;
    }
  }
  if (patch && typeof patch.apiKey === 'string' && patch.apiKey.startsWith('••••')) next.apiKey = current.apiKey || '';
  if (!next.apiKey) delete next.apiKey;
  if (typeof next.endpoint === 'string') next.endpoint = next.endpoint.trim().replace(/\/+$/, '');
  if (!next.endpoint) next.endpoint = DEFAULT_CONFIG.endpoint;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return loadConfig();
}

module.exports = {
  APP_ROOT, CONFIG_PATH, GLOBAL_DIR, DEFAULT_CONFIG,
  getWorkDir, setWorkDir, studioDir, studioRoot, projectKey, VIRTUAL_PREFIX, loadConfig, saveConfig,
};
