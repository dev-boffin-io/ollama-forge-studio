'use strict';

// "Bundled" layer: the agents, skills, commands and plugins shipped in examples/ are loaded by default, BELOW the user's own files
// (bundled < global < project), so anything the user puts in ~/.config/ollama-studio, ~/.studio/<project>, .claude/skills …
// with the same name overrides the bundled one.
//
//   source checkout     scanned straight from <app>/examples/{agents,skills,commands,plugins}
//   single executable   scripts/build.js embeds those files plus a manifest (SEA assets cannot be listed). On first start
//                       they are unpacked to <GLOBAL_DIR>/bundled/<hash>/ so skill folders keep a real base directory
//                       (scripts/, reference/ keep working) and the normal loaders can scan them like any other folder.
//
// Opt out with OLLAMA_STUDIO_NO_BUNDLED=1.

const fs = require('node:fs');
const path = require('node:path');
const log = require('./log');
const { APP_ROOT, GLOBAL_DIR } = require('./config');
const { isSea, getRawAsset } = require('./runtime');

const MANIFEST_KEY = 'examples/manifest.json';
const KEEP = /^[0-9a-f]{12}$/; // names of unpacked build directories (everything else under bundled/ is left alone)

const enabled = () => !/^(1|true|yes|on)$/i.test(process.env.OLLAMA_STUDIO_NO_BUNDLED || '');

/**
 * Unpack an embedded manifest ({ hash, files: [{ path, exec }] }) into <destRoot>/<hash12>/ and return that directory.
 * Idempotent (a `.complete` marker), atomic (write to a temp dir, then rename) and prunes unpacked copies of older builds.
 * `readAsset('examples/<path>')` returns the file's bytes or null.
 */
function unpack(manifest, readAsset, destRoot) {
  const dest = path.join(destRoot, String(manifest.hash).slice(0, 12));
  const done = path.join(dest, '.complete');
  if (!fs.existsSync(done)) {
    fs.mkdirSync(destRoot, { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      for (const f of manifest.files || []) {
        const rel = path.posix.normalize(String(f.path));
        if (rel.startsWith('..') || path.posix.isAbsolute(rel) || rel.includes('\0')) continue; // never write outside tmp
        const data = readAsset('examples/' + rel);
        if (!data) throw new Error(`embedded file missing: ${rel}`);
        const target = path.join(tmp, ...rel.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data, { mode: f.exec ? 0o755 : 0o644 });
      }
      fs.writeFileSync(path.join(tmp, '.complete'), '');
      try { fs.renameSync(tmp, dest); } catch (e) { if (!fs.existsSync(done)) throw e; } // lost a race with another instance: theirs is fine
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  try {
    for (const n of fs.readdirSync(destRoot)) {
      if (KEEP.test(n) && n !== path.basename(dest)) fs.rmSync(path.join(destRoot, n), { recursive: true, force: true });
    }
  } catch { /* pruning is best-effort */ }
  return dest;
}

let unpacked; // single-executable mode: undefined = not tried yet, null = failed, string = directory

function embeddedRoot() {
  if (unpacked !== undefined) return unpacked;
  unpacked = null;
  try {
    const raw = getRawAsset(MANIFEST_KEY);
    if (!raw) return unpacked;
    unpacked = unpack(JSON.parse(raw.toString('utf8')), getRawAsset, path.join(GLOBAL_DIR, 'bundled'));
  } catch (e) {
    log.warn('bundled', 'could not unpack the bundled examples; continuing without them', e);
  }
  return unpacked;
}

/** Directory that holds the bundled `agents/`, `skills/`, `commands/` and `plugins/` folders, or null when there are none / the layer is off. */
function bundledRoot() {
  if (!enabled()) return null;
  if (isSea()) return embeddedRoot();
  const dir = APP_ROOT && path.join(APP_ROOT, 'examples');
  return dir && fs.existsSync(dir) ? dir : null;
}

module.exports = { bundledRoot, unpack, enabled, MANIFEST_KEY };
