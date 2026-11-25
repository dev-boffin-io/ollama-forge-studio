'use strict';

// Does this project's own git configuration make "harmless" git commands (git status / diff / log ...) run programs?
// git executes commands named in the repository config: core.fsmonitor (git status), diff.external and diff.<driver>.textconv
// (git diff), core.pager, core.sshCommand, filter drivers, includes ... A repository that arrives as an archive, or whose
// .git/config was changed by an injected model, can therefore run code from a command the permission layer auto-allows.
// permission.decideBash() asks instead of allowing whenever risky() is true.

const fs = require('node:fs');
const path = require('node:path');

function gitDir(work) {
  const dot = path.join(work, '.git');
  let st;
  try { st = fs.statSync(dot); } catch { return null; }
  if (st.isDirectory()) return dot;
  try {                                                   // worktree / submodule: ".git" is a file "gitdir: <path>"
    const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dot, 'utf8'));
    return m ? path.resolve(work, m[1].trim()) : null;
  } catch { return null; }
}

const SAFE_BOOL = new Set(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off']);
const EXEC_KEYS = new Set(['external', 'textconv', 'pager', 'sshcommand', 'editor', 'askpass', 'hookspath', 'cmd', 'command', 'program', 'proxy', 'gpgprogram']);

/** Pure: inspect the text of a git config file. Returns the first risky line (trimmed) or null. */
function riskyLine(text) {
  let section = '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/^\s+|\s+$/g, '');
    if (!line || line[0] === '#' || line[0] === ';') continue;
    const sec = /^\[\s*([^\s\]"]+)(?:\s+"([^"]*)")?\s*\]$/.exec(line);
    if (sec) { section = sec[1].toLowerCase(); continue; }
    if (/^\[/.test(line)) { section = ''; continue; }
    const kv = /^([A-Za-z][\w-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const value = (kv[2] || '').replace(/^"|"$/g, '').trim();
    if (section === 'include' || section === 'includeif') return line;                 // pulls in files we cannot see
    if (key === 'fsmonitor' && !SAFE_BOOL.has(value.toLowerCase())) return line;       // a hook program
    if (EXEC_KEYS.has(key)) return line;
    if (section === 'filter' && ['clean', 'smudge', 'process'].includes(key) && !/^git-lfs(\s|$)/.test(value)) return line;
    if (section === 'alias' && value.startsWith('!')) return line;
  }
  return null;
}

/** Cheap enough to call on every bash decision (one small file read). Never throws. */
function risky(work) {
  try {
    if (!work) return false;
    const dir = gitDir(work);
    if (!dir) return false;
    for (const name of ['config', 'config.worktree']) {
      let text = '';
      try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
      if (riskyLine(text)) return true;
    }
    return false;
  } catch { return false; }
}

module.exports = { risky, riskyLine, gitDir };
