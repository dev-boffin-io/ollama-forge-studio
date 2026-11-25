'use strict';

// Paths the AGENT may never write with the file tools (write_file / edit_file / multi_edit / json_edit / move_file / delete_file).
//
// Why: the default permission for "edit" is allow, and several files are effectively *code or policy* that the studio or git
// executes later with the user's privileges. A prompt-injected agent that can rewrite them can turn "edit" into "run anything":
//   * <studio dir>/config.json      permission rules, hooks (sh -c), MCP servers (spawn), sandbox on/off   (reachable as ".studio/config.json")
//   * <studio dir>/fleets.json, project.json, sessions/, recall.db, snapshot.git, plugins/, hooks/
//   * <project>/.git/**             hooks, core.fsmonitor, diff.external, filter drivers ... all run when git runs
//   * <project>/.studio|.claude|.agents/plugins, <project>/.studio/config.json   plugin code / config inside the project
// The user can still edit all of these by hand (editor, terminal, the UI file editor): only the model is blocked.

const fs = require('node:fs');
const path = require('node:path');
const { getWorkDir, studioDir } = require('./config');

const CI = process.platform === 'win32' || process.platform === 'darwin';      // case-insensitive file systems
const fold = (p) => (CI ? p.toLowerCase() : p);

const STUDIO_ENTRIES = ['config.json', 'config.json.broken', 'fleets.json', 'project.json', 'recall.db', 'recall.db-wal', 'recall.db-shm',
  'sessions', 'snapshot.git', 'plugins', 'hooks', 'trust.json'];
const PROJECT_ENTRIES = ['.studio/config.json', '.studio/plugins', '.studio/hooks', '.claude/plugins', '.agents/plugins'];

/** Resolve symlinks of the nearest existing ancestor, then re-append the not-yet-existing rest. */
function canonical(abs) {
  let probe = path.resolve(abs);
  const rest = [];
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) return path.resolve(abs);
    rest.unshift(path.basename(probe));
    probe = up;
  }
  try { return path.join(fs.realpathSync(probe), ...rest); } catch { return path.resolve(abs); }
}

const inside = (p, dir) => { const a = fold(p); const b = fold(dir); return a === b || a.startsWith(b + path.sep); };

function roots() {
  const out = [];
  const add = (dir) => { if (dir && !out.includes(dir)) out.push(dir); };
  try { const s = studioDir(); add(path.resolve(s)); try { add(fs.realpathSync(s)); } catch { /* not created yet */ } } catch { /* no project yet */ }
  return out;
}

/** Why `abs` may not be written by the agent, or null when it may. */
function reason(abs) {
  const candidates = [path.resolve(abs), canonical(abs)];
  const work = (() => { try { return getWorkDir(); } catch { return null; } })();
  const workRoots = work ? [path.resolve(work), (() => { try { return fs.realpathSync(work); } catch { return path.resolve(work); } })()] : [];
  for (const p of candidates) {
    for (const s of roots()) for (const name of STUDIO_ENTRIES) if (inside(p, path.join(s, name))) return `"${name}" in the studio data folder is protected (it holds settings, hooks and history that the studio executes or trusts)`;
    for (const w of workRoots) {
      for (const name of PROJECT_ENTRIES) if (inside(p, path.join(w, ...name.split('/')))) return `"${name}" is protected (its contents are executed or trusted by the studio)`;
      const rel = path.relative(w, p);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep).some((seg) => fold(seg) === '.git')) return 'the .git folder is protected (git hooks and git config run commands)';
    }
  }
  return null;
}

/** Throws a model-readable error for a protected path. */
function assertWritable(abs, relForMessage = '') {
  const why = reason(abs);
  if (!why) return;
  const e = new Error(`Refusing to change ${relForMessage || abs}: ${why}. Do not retry or work around it (no bash tricks either). Tell the user which change you wanted; they can make it by hand.`);
  e.status = 403;
  throw e;
}

module.exports = { reason, assertWritable, canonical, STUDIO_ENTRIES, PROJECT_ENTRIES };
