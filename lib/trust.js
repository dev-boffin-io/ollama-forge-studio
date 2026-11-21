'use strict';

// Project trust (like VS Code "Workspace Trust"): plugins that live INSIDE a project folder
// (.studio/plugins, .claude/plugins, .agents/plugins) are arbitrary JavaScript that would run with your
// privileges the moment you open that folder. They are only loaded once the folder is trusted.
//
// Trusted when any of:  --trust on the command line | OLLAMA_STUDIO_TRUST_PROJECT=1 | the folder is listed in
// <studio home>/trusted-projects.json (written by --trust, the boot prompt or POST /api/trust).

const fs = require('node:fs');
const path = require('node:path');
const { studioRoot, getWorkDir } = require('./config');

const file = () => path.join(studioRoot(), 'trusted-projects.json');
const envTrusted = () => /^(1|true|yes|on)$/i.test(process.env.OLLAMA_STUDIO_TRUST_PROJECT || '');
let sessionTrusted = new Set();   // trusted for this run only (e.g. the user said "once")

function readList() {
  try { const v = JSON.parse(fs.readFileSync(file(), 'utf8')); return Array.isArray(v) ? v : []; } catch { return []; }
}

function isTrusted(dir = getWorkDir()) {
  if (envTrusted() || sessionTrusted.has(dir)) return true;
  return readList().includes(dir);
}

function trust(dir = getWorkDir(), { remember = true } = {}) {
  sessionTrusted.add(dir);
  if (!remember) return;
  const list = readList();
  if (list.includes(dir)) return;
  fs.mkdirSync(studioRoot(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(), JSON.stringify([...list, dir], null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

function untrust(dir = getWorkDir()) {
  sessionTrusted.delete(dir);
  const list = readList().filter((d) => d !== dir);
  try { fs.writeFileSync(file(), JSON.stringify(list, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 }); } catch { /* nothing stored yet */ }
}

const _reset = () => { sessionTrusted = new Set(); };

module.exports = { isTrusted, trust, untrust, _reset };
