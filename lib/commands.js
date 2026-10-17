'use strict';

const log = require('./log');

// Custom slash commands: <dir>/.studio/commands/<name>.md or ~/.config/ollama-studio/commands/<name>.md
//   ---
//   description: Run the tests and fix failures
//   agent: build          # optional
//   ---
//   Run the test suite. $ARGUMENTS   (also $1 $2 ... and @path/to/file to inline a file)

const fs = require('node:fs');
const path = require('node:path');
const { GLOBAL_DIR, studioDir } = require('./config');
const { parseFrontmatter } = require('./agents');
const ws = require('./workspace');

const BUILTIN = {
  init: {
    name: 'init', builtin: true, description: 'create/update AGENTS.md for this directory',
    template: `Create or update \`AGENTS.md\` in the working directory.

The goal is a compact instruction file that helps future agent sessions avoid mistakes and ramp up quickly. Every line should answer: "Would an agent likely miss this without help?" If not, leave it out.

User-provided focus or constraints (honor these):
$ARGUMENTS

How to investigate: read README*, root manifests (package.json, pyproject, go.mod ...), build/test/lint config, CI workflows, and any existing instruction files (AGENTS.md, CLAUDE.md, .cursorrules). Prefer executable sources of truth (scripts, config) over prose. If architecture is unclear, inspect a few representative files to find the real entrypoints.

What to extract: exact developer commands (esp. non-obvious ones), how to run a single test, required command order (lint -> typecheck -> test), directory boundaries and real entrypoints, toolchain quirks, repo-specific conventions that differ from defaults.

Writing rules: concise bullets, no generic advice, no long tutorials, do not invent facts you did not verify. If AGENTS.md exists, improve it in place instead of rewriting from scratch. Write the result with write_file or edit_file.`,
  },
  review: {
    name: 'review', builtin: true, description: 'review changes [commit|branch], defaults to uncommitted',
    template: `You are a code reviewer. Review code changes and give actionable feedback. Do NOT modify files.

Input: $ARGUMENTS

Determine what to review:
1. No arguments: all uncommitted changes. Run \`git diff\`, \`git diff --cached\` and \`git status --short\` (untracked files are new code).
2. A commit hash: run \`git show $ARGUMENTS\`.
3. A branch name: run \`git diff $ARGUMENTS...HEAD\`.

Then read the surrounding code of every changed file for context. Report, ordered by severity: bugs and logic errors, security issues, missing edge cases/error handling, performance problems, and notable style deviations. For each finding give file:line, why it matters, and a concrete fix. If everything looks good say so briefly.`,
  },
};

function loadDir(dir) {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    const name = n.slice(0, -3);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) continue;
    try {
      const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, n), 'utf8'));
      out[name] = { name, builtin: false, description: String(meta.description || ''), agent: meta.agent || undefined, model: meta.model || undefined, template: body };
    } catch (e) { log.warn('commands', `skipping unreadable command ${n}`, e); }
  }
  return out;
}

const loadCommands = () => ({ ...BUILTIN, ...loadDir(path.join(GLOBAL_DIR, 'commands')), ...loadDir(path.join(studioDir(), 'commands')) });

function splitArgs(s) {
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((x) => x.replace(/^["']|["']$/g, ''));
}

/** "/name some args" -> { command, text } or null if not a known command. */
async function expand(input) {
  const m = String(input).match(/^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const command = loadCommands()[m[1]];
  if (!command) return null;
  const argStr = (m[2] || '').trim();
  const args = splitArgs(argStr);
  let text = command.template.replace(/\$ARGUMENTS/g, argStr).replace(/\$([1-9])/g, (_, i) => args[Number(i) - 1] || '');
  // @path -> inline the file
  const refs = [...new Set([...text.matchAll(/(?:^|\s)@([\w./-]+)/g)].map((x) => x[1]))];
  for (const ref of refs) {
    try {
      const content = await ws.readFile(ref);
      text += `\n\nContents of ${ref}:\n\`\`\`\n${content}\n\`\`\``;
    } catch { /* not a file; leave as-is */ }
  }
  return { command, text: text.trim() };
}

module.exports = { loadCommands, expand };
