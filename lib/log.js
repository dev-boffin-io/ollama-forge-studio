'use strict';

// Tiny dependency-free logger. Everything that used to be a silent `catch {}` goes through here, so problems leave a trace
// without crashing anything or flooding the console.
//   - file:    <studio home>/logs/studio.log  (rotated at ~2 MB to studio.log.1)
//   - console: warn/error lines only (debug/info only with OLLAMA_STUDIO_LOG=debug)
//   - repeats of the same message within 5 s are collapsed
// Logging itself never throws.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 2 * 1024 * 1024;
const consoleLevel = LEVELS[String(process.env.OLLAMA_STUDIO_LOG || 'warn').toLowerCase()] || LEVELS.warn;

const home = path.resolve(process.env.OLLAMA_STUDIO_HOME || path.join(os.homedir(), '.studio'));
const dir = path.join(home, 'logs');
const file = path.join(dir, 'studio.log');

let ready = false;
let size = 0;
let queue = [];
let flushing = false;
const recent = new Map();            // message -> { at, count }

function ensure() {
  if (ready) return true;
  try {
    fs.mkdirSync(dir, { recursive: true });
    try { size = fs.statSync(file).size; } catch { size = 0; }
    ready = true;
  } catch { ready = false; }
  return ready;
}

function flush() {
  if (flushing || !queue.length || !ensure()) { queue = ready ? queue : []; return; }
  flushing = true;
  const chunk = queue.join('');
  queue = [];
  const done = () => { flushing = false; if (queue.length) setImmediate(flush); };
  try {
    if (size > MAX_BYTES) { try { fs.renameSync(file, file + '.1'); } catch { /* ignore */ } size = 0; }
    size += Buffer.byteLength(chunk);
    fs.appendFile(file, chunk, done);
  } catch { done(); }
}

const text = (err) => {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  const code = err.code || (err.cause && err.cause.code);
  return `${err.message || String(err)}${code ? ` [${code}]` : ''}`;
};

function write(level, scope, msg, err) {
  try {
    const line = `${scope}: ${msg}${err ? ' — ' + text(err) : ''}`;
    const now = Date.now();
    const seen = recent.get(line);
    if (seen && now - seen.at < 5000) { seen.count++; return; }
    if (recent.size > 200) recent.clear();
    recent.set(line, { at: now, count: 1 });
    const stack = err && err.stack && LEVELS[level] >= LEVELS.error ? '\n' + String(err.stack).split('\n').slice(1, 6).join('\n') : '';
    queue.push(`${new Date(now).toISOString()} ${level.toUpperCase().padEnd(5)} ${line}${stack}\n`);
    if (queue.length > 500) queue = queue.slice(-200);
    setImmediate(flush);
    if (LEVELS[level] >= consoleLevel) (level === 'error' || level === 'warn' ? console.error : console.log)(`[${level}] ${line}`);
  } catch { /* logging must never throw */ }
}

/** log.warn('recall', 'index failed', err) — err optional */
const log = {
  debug: (scope, msg, err) => write('debug', scope, msg, err),
  info: (scope, msg, err) => write('info', scope, msg, err),
  warn: (scope, msg, err) => write('warn', scope, msg, err),
  error: (scope, msg, err) => write('error', scope, msg, err),
  /** `promise.catch(log.swallow('scope', 'what failed'))` — best-effort work that must not break the caller. */
  swallow: (scope, msg = 'ignored error') => (err) => write('debug', scope, msg, err),
  /** last `n` lines of the log file (for /api/logs) */
  tail(n = 200) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-Math.max(1, Math.min(2000, n))).join('\n');
    } catch { return ''; }
  },
  file,
};

module.exports = log;
