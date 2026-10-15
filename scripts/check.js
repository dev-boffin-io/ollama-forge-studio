'use strict';
// CI sanity check: every JS file must parse, and the server must load without errors.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'workspace'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full); else if (e.name.endsWith('.js')) files.push(full);
  }
};
walk(root);

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { failed++; console.error(`✗ ${path.relative(root, f)}\n${r.stderr}`); }
}
// all lib modules must also load
for (const f of files.filter((x) => x.startsWith(path.join(root, 'lib')))) {
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(f)})`], { encoding: 'utf8', env: { ...process.env, OLLAMA_STUDIO_HOME: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'studio-')) } });
  if (r.status !== 0) { failed++; console.error(`✗ require ${path.relative(root, f)}\n${r.stderr}`); }
}
console.log(`${files.length} files checked, ${failed} problem(s)`);
process.exit(failed ? 1 : 0);
