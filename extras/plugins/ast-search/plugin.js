'use strict';

// ast_search: structural code search through the external `ast-grep` binary (https://ast-grep.github.io), OPTIONAL.
//
// grep finds text; this finds code SHAPES, e.g. every call `fetchUser($ID)` regardless of formatting, every
// `class $C extends Base`, or `console.log($$$ARGS)` inside async functions. Patterns use ast-grep's syntax:
//   $NAME = one node, $$$ARGS = zero or more nodes.
//
// Nothing is bundled: if neither `ast-grep` nor `sg` is on PATH the plugin registers NO tool (and says so in the log), so the
// studio stays zero-dependency. Install: `npm i -g @ast-grep/cli`, `brew install ast-grep`, `cargo install ast-grep`.
// Read-only: it never rewrites code. Plugin tools ask by default; allow it with  "permission": { "plugin": { "ast_search": "allow" } }.

const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const LANGS = ['js', 'jsx', 'ts', 'tsx', 'python', 'go', 'rust', 'java', 'kotlin', 'c', 'cpp', 'csharp', 'ruby', 'php', 'swift', 'bash', 'html', 'css', 'json', 'yaml', 'lua'];

function findBinary() {
  for (const bin of ['ast-grep', 'sg']) {
    try {
      const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (/ast-grep/i.test(out)) return bin;     // `sg` can also be the Linux "setgroups" tool: check the banner
    } catch { /* try next */ }
  }
  return null;
}

module.exports = {
  name: 'ast',
  version: '1.0.0',
  description: 'Optional structural code search (ast_search) powered by the external ast-grep binary.',
  setup(api) {
    const bin = findBinary();
    if (!bin) { api.log.warn('ast-grep not found on PATH: ast_search is not available (install @ast-grep/cli to enable it)'); return; }
    const root = path.resolve(api.workDir);

    api.registerTool({
      name: 'search',
      description: 'Structural code search (AST, via ast-grep). Pattern syntax: code with metavariables, `$X` = one node, `$$$ARGS` = any number of nodes. '
        + 'Example: pattern "fetchUser($ID)" lang "ts"; pattern "class $C extends Base { $$$BODY }". Returns file:line and the matched code. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'ast-grep pattern (valid code in the target language with $METAVARS).' },
          lang: { type: 'string', enum: LANGS, description: 'Language of the pattern and the files to search.' },
          path: { type: 'string', description: 'File or folder to search, relative to the working directory (default: whole project).' },
          max_results: { type: 'number', description: 'Default 50, max 200.' },
        },
        required: ['pattern', 'lang'],
      },
      handler: async (args, ctx = {}) => {
        const pattern = String(args.pattern || '').trim();
        if (!pattern) throw new Error('pattern is required');
        if (!LANGS.includes(args.lang)) throw new Error(`lang must be one of: ${LANGS.join(', ')}`);
        const rel = String(args.path || '.');
        const target = path.resolve(root, rel);
        if (target !== root && !target.startsWith(root + path.sep)) throw new Error('path must stay inside the working directory');
        if (!fs.existsSync(target)) throw new Error(`path not found: ${rel}`);
        const max = Math.min(200, Math.max(1, Number(args.max_results) || 50));

        // execFile = no shell. `--pattern=` / `--lang=` keep a pattern that starts with "-" from being read as a flag.
        const argv = ['run', `--pattern=${pattern}`, `--lang=${args.lang}`, '--json=compact', '--', target];
        const { stdout, stderr, code } = await new Promise((resolve) => {
          const child = execFile(bin, argv, { cwd: root, maxBuffer: 20 * 1024 * 1024, timeout: 60000, encoding: 'utf8' }, (err, so, se) => {
            resolve({ stdout: so || '', stderr: se || '', code: err ? (typeof err.code === 'number' ? err.code : -1) : 0 });
          });
          if (ctx.signal) ctx.signal.addEventListener('abort', () => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, { once: true });
        });
        let matches;
        try { matches = JSON.parse(stdout || '[]'); } catch { throw new Error('ast-grep failed: ' + (stderr || stdout || `exit ${code}`).trim().slice(0, 600)); }
        if (!Array.isArray(matches)) throw new Error('unexpected ast-grep output');
        const rows = matches.slice(0, max).map((m) => `${path.relative(root, path.resolve(root, m.file))}:${(m.range && m.range.start ? m.range.start.line : 0) + 1}: ${String(m.text || '').split('\n')[0].slice(0, 200)}${String(m.text || '').includes('\n') ? ' …' : ''}`);
        return {
          output: rows.length ? rows.join('\n') : 'no matches',
          matches: matches.length,
          ...(matches.length > max ? { truncated: `${matches.length - max} more matches; narrow the pattern or path` } : {}),
        };
      },
    });
  },
};
