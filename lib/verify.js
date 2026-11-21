'use strict';

// Self-correction loop ("edit -> test -> analyse -> fix -> final regression check").
//
//   1. After EVERY successful write_file / edit_file / multi_edit / json_edit the studio immediately checks the file:
//        - syntax check for the file type (node --check, JSON.parse, python compile, bash -n)
//        - the test file that belongs to it (node:test / pytest are detected; any other runner via "editCommand")
//      The verdict is attached to the tool result as `verify`, so the model sees PASS/FAIL in the same step.
//   2. On FAIL the result carries the error output and the repair instructions (read the error, decide syntax vs.
//      logic, fix the CODE, the check re-runs automatically on the next edit). After `maxFixRounds` failures in a
//      row on the same file the model is told to stop looping and report the exact error.
//   3. When the model wants to end its turn and files changed, the FULL test command runs once (regression check).
//      A failure goes back to the model as a notice message (at most `maxFinalRounds` times per turn).
//
//   "verify": {
//     "enabled": true,             // false (or "verify": false) turns the whole loop off
//     "onEdit": true,              // quick check after every edit
//     "final": true,               // full suite before the turn ends
//     "command": "",               // full test command; "" = auto-detect (npm/yarn/pnpm test, pytest, go test, cargo test, make test)
//     "editCommand": "",           // optional per-edit command, placeholders {file} and {test}; "" = built-in checks
//     "editTimeoutSec": 60,
//     "finalTimeoutSec": 280,
//     "maxFixRounds": 4,
//     "maxFinalRounds": 3
//   }
//
// Zero model calls. Commands run through procs.runForeground, so the Docker sandbox (when enabled) applies.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const log = require('./log');
const { getWorkDir } = require('./config');

const win = process.platform === 'win32';

const DEFAULTS = {
  enabled: true,
  onEdit: true,
  final: true,
  command: '',
  editCommand: '',
  editTimeoutSec: 60,
  finalTimeoutSec: 280,
  maxFixRounds: 4,
  maxFinalRounds: 3,
};

function settings(config) {
  const raw = config && config.verify;
  if (raw === false) return { ...DEFAULTS, enabled: false };
  if (raw === true || raw == null || typeof raw !== 'object') return { ...DEFAULTS };
  const s = { ...DEFAULTS, ...raw };
  for (const k of ['editTimeoutSec', 'finalTimeoutSec', 'maxFixRounds', 'maxFinalRounds']) {
    const n = Number(s[k]);
    s[k] = Number.isFinite(n) && n > 0 ? n : DEFAULTS[k];
  }
  return s;
}

const enabled = (config) => settings(config).enabled !== false;

/* ---------- per-turn state (never persisted: a restart simply starts clean) ---------- */

const states = new WeakMap();   // root session -> { dirty, files, finalRounds, turn, fails: Map(path -> n) }

function stateOf(session) {
  if (!session || typeof session !== 'object') return { dirty: false, files: new Set(), finalRounds: 0, turn: 0, fails: new Map() };
  let s = states.get(session);
  if (!s) { s = { dirty: false, files: new Set(), finalRounds: 0, turn: session.turn || 0, fails: new Map() }; states.set(session, s); }
  if ((session.turn || 0) !== s.turn) { s.turn = session.turn || 0; s.finalRounds = 0; s.fails.clear(); }   // a new user message starts a fresh budget
  return s;
}

/** A file was changed by the agent: the final regression check is now due. Subagents report to the root session. */
function markDirty(ctx, relPath) {
  if (!ctx || !enabled(ctx.config)) return;
  const s = stateOf(ctx.root || ctx.session);
  s.dirty = true;
  if (relPath) s.files.add(String(relPath));
}

/* ---------- command discovery ---------- */

const exists = (...p) => fs.existsSync(path.join(...p));
const readText = (...p) => { try { return fs.readFileSync(path.join(...p), 'utf8'); } catch { return ''; } };

function readPackageJson(root) {
  try { return JSON.parse(readText(root, 'package.json')); } catch { return null; }
}

/** The project's full test command, or null when none can be found (then the final check is skipped, never guessed). */
function detectTestCommand(config, root = getWorkDir()) {
  const s = settings(config);
  if (s.command && String(s.command).trim()) return { command: String(s.command).trim(), source: 'config' };

  const pkg = readPackageJson(root);
  const script = pkg && pkg.scripts && pkg.scripts.test;
  if (script && !/no test specified/i.test(script)) {
    const pm = exists(root, 'pnpm-lock.yaml') ? 'pnpm' : exists(root, 'yarn.lock') ? 'yarn' : 'npm';
    return { command: `${pm} test`, source: 'package.json', script: String(script) };
  }
  const py = win ? 'python' : 'python3';
  const pyproject = readText(root, 'pyproject.toml');
  if (exists(root, 'pytest.ini') || /\[tool\.pytest/.test(pyproject) || /\[pytest\]/.test(readText(root, 'setup.cfg')) || (exists(root, 'tests') && /\.py$/.test(safeList(path.join(root, 'tests')).join('\n')))) {
    return { command: `${py} -m pytest -x -q`, source: 'pytest' };
  }
  if (exists(root, 'go.mod')) return { command: 'go test ./...', source: 'go.mod' };
  if (exists(root, 'Cargo.toml')) return { command: 'cargo test', source: 'Cargo.toml' };
  if (/^test\s*:/m.test(readText(root, 'Makefile'))) return { command: 'make test', source: 'Makefile' };
  return null;
}

function safeList(dir) { try { return fs.readdirSync(dir); } catch { return []; } }

const q = (s) => (win ? `"${String(s).replace(/"/g, '""')}"` : `'${String(s).replace(/'/g, `'\\''`)}'`);
const posix = (p) => String(p).replace(/\\/g, '/');

/** Test file that belongs to `rel` (node:test or pytest projects), or null. */
function relatedTest(rel, root = getWorkDir(), config) {
  const r = posix(rel);
  const base = path.posix.basename(r);
  const ext = path.posix.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  const dir = path.posix.dirname(r);
  const pkg = readPackageJson(root);
  const script = String((pkg && pkg.scripts && pkg.scripts.test) || '');

  if (/^\.(js|cjs|mjs)$/.test(ext) && /node\s+(--[\w-]+\s+)*--test\b/.test(script)) {
    if (/\.(test|spec)\.(js|cjs|mjs)$/.test(base)) return { file: r, command: `node --test ${q(r)}` };
    for (const cand of [`test/${stem}.test.js`, `tests/${stem}.test.js`, `${dir}/${stem}.test.js`, `${dir}/${stem}.spec.js`, `${dir}/__tests__/${stem}.test.js`, `test/${stem}.test.mjs`]) {
      if (exists(root, cand)) return { file: cand, command: `node --test ${q(cand)}` };
    }
    return null;
  }
  if (ext === '.py') {
    const py = win ? 'python' : 'python3';
    if (/^(test_.*|.*_test)$/.test(stem)) return { file: r, command: `${py} -m pytest -x -q ${q(r)}` };
    for (const cand of [`tests/test_${stem}.py`, `test/test_${stem}.py`, `${dir}/test_${stem}.py`, `${dir}/${stem}_test.py`]) {
      if (exists(root, cand)) return { file: cand, command: `${py} -m pytest -x -q ${q(cand)}` };
    }
  }
  return null;
}

/* ---------- running things ---------- */

function clip(text, max = 3500) {
  const t = String(text || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();    // no ANSI colours in the model's context
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.3);
  return `${t.slice(0, head)}\n… (${t.length - max} characters omitted) …\n${t.slice(-(max - head))}`;
}

const execQuick = (file, args, cwd, timeoutMs) => new Promise((resolve) => {
  execFile(file, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && err.code === 'ENOENT') return resolve({ skipped: true, output: `${file} is not installed` });
    resolve({ ok: !err, output: `${stdout || ''}${stderr || ''}`, timedOut: !!(err && err.killed) });
  });
});

const NO_JSON_CHECK = /(^|\/)(tsconfig[^/]*|jsconfig[^/]*|\.eslintrc[^/]*|\.babelrc|\.prettierrc|devcontainer|settings|launch|tasks|extensions)\.json$/i;

/** Built-in, instant syntax check for one file. Returns null when the type has no reliable checker. */
async function syntaxCheck(rel, abs, root) {
  const ext = path.extname(rel).toLowerCase();
  const t0 = Date.now();
  const done = (name, command, r) => ({ name, command, ok: r.ok === true, skipped: !!r.skipped, output: r.output || '', ms: Date.now() - t0 });
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') return done('syntax', `node --check ${rel}`, await execQuick(process.execPath, ['--check', abs], root, 20000));
  if (ext === '.json') {
    if (NO_JSON_CHECK.test(posix(rel))) return null;
    try { JSON.parse(fs.readFileSync(abs, 'utf8')); return done('syntax', `JSON.parse ${rel}`, { ok: true }); } catch (e) { return done('syntax', `JSON.parse ${rel}`, { ok: false, output: `${rel}: ${e.message}` }); }
  }
  if (ext === '.py') {
    const py = win ? 'python' : 'python3';
    return done('syntax', `${py} compile ${rel}`, await execQuick(py, ['-c', 'import sys; compile(open(sys.argv[1], "rb").read(), sys.argv[1], "exec")', abs], root, 20000));
  }
  if (ext === '.sh' || ext === '.bash') return done('syntax', `bash -n ${rel}`, await execQuick('bash', ['-n', abs], root, 20000));
  return null;
}

async function runShell(command, secs, ctx) {
  const procs = require('./procs');
  const t0 = Date.now();
  const r = await procs.runForeground(command, secs * 1000, ctx.signal, ctx.config);
  return { ok: r.exit_code === 0, timedOut: !!r.timed_out, aborted: !!r.aborted, output: r.output || '', exitCode: r.exit_code, ms: Date.now() - t0 };
}

/* ---------- 1) immediate check after an edit ---------- */

const REPAIR_NOTE =
  'VERIFY FAILED. Do not move on. (1) Read the error output above carefully. (2) Decide: syntax error (typo, bracket, import) or logic error (assertion mismatch, wrong behaviour)? ' +
  '(3) read_file the failing region, then fix the CODE with edit_file — the check re-runs automatically after your next edit. ' +
  'Do not weaken, skip or delete a test to make it pass unless the test itself is demonstrably wrong (say so if you change it).';

/**
 * Check the file that was just written. Returns the tool result with a `verify` field (and `note` on failure).
 * Never throws: a broken verifier must not break editing.
 */
async function afterEdit(result, relPath, ctx) {
  try {
    const s = settings(ctx.config);
    if (!s.enabled) return result;
    markDirty(ctx, relPath);
    if (!s.onEdit) return result;

    const root = getWorkDir();
    const abs = require('./workspace').safeResolve(String(relPath));
    const checks = [];

    if (s.editCommand && String(s.editCommand).trim()) {
      const rt = relatedTest(relPath, root, ctx.config);
      const cmd = String(s.editCommand).replace(/\{file\}/g, q(posix(relPath))).replace(/\{test\}/g, q(rt ? rt.file : posix(relPath)));
      const r = await runShell(cmd, s.editTimeoutSec, ctx);
      checks.push({ name: 'check', command: cmd, ok: r.ok, output: r.output, ms: r.ms, timedOut: r.timedOut });
    } else {
      const syn = await syntaxCheck(relPath, abs, root);
      if (syn && !syn.skipped) checks.push(syn);
      // only run the related test when the syntax is fine: a syntax error would just produce a noisier failure
      if (!syn || syn.ok || syn.skipped) {
        const rt = relatedTest(relPath, root, ctx.config);
        if (rt) {
          const r = await runShell(rt.command, s.editTimeoutSec, ctx);
          checks.push({ name: 'test', command: rt.command, ok: r.ok, output: r.output, ms: r.ms, timedOut: r.timedOut });
        }
      }
    }
    if (!checks.length) return { ...result, verify: { status: 'skipped', reason: 'no automatic check exists for this file type; the full test command still runs when you finish' } };

    const failed = checks.filter((c) => !c.ok);
    const st = stateOf(ctx.root || ctx.session);
    const key = posix(relPath);
    const line = (c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.command}${c.ms ? ` (${(c.ms / 1000).toFixed(1)}s)` : ''}`;
    if (!failed.length) {
      st.fails.delete(key);
      return { ...result, verify: { status: 'pass', checks: checks.map(line) } };
    }
    const n = (st.fails.get(key) || 0) + 1;
    st.fails.set(key, n);
    const verify = { status: 'fail', checks: checks.map(line), output: failed.map((c) => clip(c.timedOut ? `${c.output}\n[timed out after ${s.editTimeoutSec}s]` : c.output)).join('\n---\n'), attempt: n };
    const stuck = n >= s.maxFixRounds
      ? ` This is failed attempt ${n} on "${key}". STOP guessing: re-read the file and the test from the top, think about the root cause, and if you still cannot fix it, tell the user the exact error instead of looping.`
      : '';
    return { ...result, verify, note: [result.note, REPAIR_NOTE + stuck].filter(Boolean).join(' ') };
  } catch (e) {
    log.debug('verify', 'per-edit verification failed to run', e);
    return result;
  }
}

/* ---------- 3) final regression check at the end of the turn ---------- */

/**
 * Called when the model wants to end its turn. Returns null (nothing to do / all green) or
 * { retry: true, message } to send the failure back to the model.
 */
async function finalCheck({ session, root, config, signal, emit }) {
  const s = settings(config);
  if (!s.enabled || !s.final) return null;
  const st = stateOf(root || session);
  if (!st.dirty) return null;
  const found = detectTestCommand(config);
  if (!found) { st.dirty = false; return null; }                       // nothing to run — never invent a command

  const ctx = { config, signal };
  emit({ type: 'info', text: `⟳ final verification: ${found.command}` });
  const r = await runShell(found.command, s.finalTimeoutSec, ctx);
  if (r.aborted || (signal && signal.aborted)) return null;
  const secs = (r.ms / 1000).toFixed(1);

  if (r.ok) {
    st.dirty = false;
    st.finalRounds = 0;
    st.files.clear();
    emit({ type: 'info', text: `✓ final verification passed: ${found.command} (${secs}s)` });
    return null;
  }
  if (r.timedOut) {
    st.dirty = false;                                                  // a slow suite is not a failure; do not loop on it
    emit({ type: 'warning', message: `Final verification timed out after ${s.finalTimeoutSec}s (${found.command}). Run it in the background to confirm nothing broke.` });
    return null;
  }
  st.finalRounds++;
  if (st.finalRounds > s.maxFinalRounds) {
    st.dirty = false;
    emit({ type: 'warning', message: `Tests still fail after ${s.maxFinalRounds} automatic repair rounds (${found.command}). Review the failure yourself.` });
    return null;
  }
  emit({ type: 'info', text: `✗ final verification failed (${found.command}, exit ${r.exitCode}) — asking the agent to fix it (round ${st.finalRounds}/${s.maxFinalRounds})` });
  const files = [...st.files].slice(0, 20).join(', ') || '(see git diff)';
  const message =
    `[Studio · final verification] You said the work is finished, but the project's test command failed.\n` +
    `Command: ${found.command}   Exit code: ${r.exitCode}   Files you changed this turn: ${files}\n\n` +
    `${clip(r.output, 6000)}\n\n` +
    `Analyse this output: is it a regression caused by your change, or was it already failing before? ` +
    `If you broke it, fix the CODE (read_file first, then edit_file) and make the suite pass; do not weaken or delete tests to get green. ` +
    `If the failure is clearly unrelated to your change and pre-existing, do not touch unrelated code — say so in your final summary. ` +
    `The suite re-runs automatically when you finish again.`;
  return { retry: true, message };
}

/* ---------- system prompt ---------- */

function promptSection(config) {
  const s = settings(config);
  if (!s.enabled) return '';
  return 'Verification loop (automatic): after every write_file/edit_file/multi_edit/json_edit the studio runs a fast check on that file (syntax + its test file) and attaches the verdict to the tool result as `verify`. ' +
    'If `verify.status` is "fail": read the error output, decide whether it is a syntax or a logic error, fix the CODE and edit again — repeat until it passes; do not continue with other work while a check is red, and never silence a failing test. ' +
    (s.final ? 'When you finish, the full test suite runs once more as a regression check; if it fails you will get the output back and must fix it. ' : '') +
    'Never claim the work is done or "tested" unless the verify result or a test run you made shows it passing.';
}

module.exports = { settings, enabled, markDirty, afterEdit, finalCheck, detectTestCommand, relatedTest, syntaxCheck, promptSection, stateOf, clip };
