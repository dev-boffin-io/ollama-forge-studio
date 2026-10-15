#!/usr/bin/env node
'use strict';

/**
 * Build a single self-contained executable (Node SEA) for the CURRENT platform.
 *
 *   node scripts/build.js            ->  dist/ollama-forge-studio[.exe]
 *
 * Steps: bundle server.js + lib/*.js into one CommonJS file (tiny built-in bundler, no deps),
 * embed public/* as SEA assets, generate the blob, copy the running `node` binary and inject the blob.
 * Needs Node >= 20.12 (22+ recommended). `postject` is fetched on demand via npx.
 * SEA cannot cross-compile: run this on each OS you want a binary for (see .github/workflows/release.yml).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const NAME = 'ollama-forge-studio';
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const OUT = path.join(DIST, NAME + (isWin ? '.exe' : ''));

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) {
  console.error(`Node ${process.versions.node} is too old for single-executable builds (need >= 20.12, 22+ recommended).`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: isWin && cmd === 'npx', ...opts });
  if (r.status !== 0) throw new Error(`command failed: ${cmd} ${args.join(' ')}`);
}

/* ---------- 1. bundle ---------- */

function bundle(entry) {
  const modules = new Map(); // key (posix path relative to ROOT) -> source
  const resolveFile = (from, id) => {
    let p = path.resolve(path.dirname(from), id);
    for (const c of [p, p + '.js', path.join(p, 'index.js')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    throw new Error(`cannot resolve ${id} from ${from}`);
  };
  const keyOf = (file) => path.relative(ROOT, file).split(path.sep).join('/');

  (function visit(file) {
    const key = keyOf(file);
    if (modules.has(key)) return;
    const src = fs.readFileSync(file, 'utf8').replace(/^#!.*\n/, '');
    modules.set(key, src);
    for (const m of src.matchAll(/\brequire\(\s*(['"])(\.{1,2}\/[^'"]*)\1\s*\)/g)) visit(resolveFile(file, m[2]));
    // dynamic / computed relative requires can't be bundled — fail loudly instead of at runtime
    if (/\brequire\(\s*(?!['"])/.test(src)) throw new Error(`non-literal require() in ${key}; the bundler can't follow it`);
  })(entry);

  let out = "'use strict';\nconst __defs = {\n";
  for (const [key, src] of modules) {
    out += `${JSON.stringify(key)}: function (module, exports, require, __filename, __dirname) {\n${src}\n},\n`;
  }
  out += `};
const __path = require('node:path');
const __cache = Object.create(null);
function __load(key) {
  if (__cache[key]) return __cache[key].exports;
  const module = (__cache[key] = { exports: {} });
  const dir = __path.posix.dirname(key);
  const req = (id) => {
    if (!id.startsWith('.')) return require(id);
    const base = __path.posix.normalize(__path.posix.join(dir, id));
    for (const c of [base, base + '.js', base + '/index.js']) if (c in __defs) return __load(c);
    throw new Error('bundle: cannot resolve ' + id + ' from ' + key);
  };
  __defs[key].call(module.exports, module, module.exports, req, key, dir);
  return module.exports;
}
__load(${JSON.stringify(keyOf(entry))});
`;
  return { code: out, count: modules.size };
}

/* ---------- 2. build ---------- */

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const { code, count } = bundle(path.join(ROOT, 'server.js'));
const bundlePath = path.join(DIST, 'bundle.js');
fs.writeFileSync(bundlePath, code);
console.log(`bundled ${count} modules -> dist/bundle.js (${(code.length / 1024).toFixed(0)} KB)`);

const assets = {};
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f);
    else assets['public/' + path.relative(path.join(ROOT, 'public'), f).split(path.sep).join('/')] = f;
  }
})(path.join(ROOT, 'public'));
console.log(`embedding ${Object.keys(assets).length} assets: ${Object.keys(assets).join(', ')}`);

const seaConfig = path.join(DIST, 'sea-config.json');
const blob = path.join(DIST, 'sea-prep.blob');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: bundlePath, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, assets,
}, null, 2));
run(process.execPath, ['--experimental-sea-config', seaConfig]);

fs.copyFileSync(process.execPath, OUT);
fs.chmodSync(OUT, 0o755);
if (isMac) spawnSync('codesign', ['--remove-signature', OUT], { stdio: 'inherit' });

const inject = ['--yes', 'postject', OUT, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (isMac) inject.push('--macho-segment-name', 'NODE_SEA');
run('npx', inject);
if (isMac) run('codesign', ['--sign', '-', OUT]);

for (const f of [bundlePath, seaConfig, blob]) fs.rmSync(f, { force: true });
console.log(`\nbuilt ${path.relative(ROOT, OUT)}  (${(fs.statSync(OUT).size / 1048576).toFixed(0)} MB)`);
