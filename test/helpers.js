'use strict';
// Shared test setup: a throwaway OLLAMA_STUDIO_HOME + project directory.
// setup() MUST be called before any lib/* module is required (config is read at load time).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-home-'));
  process.env.OLLAMA_STUDIO_HOME = home;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-proj-'));
  const cfg = require('../lib/config');
  cfg.setWorkDir(dir);
  const cleanup = () => {
    for (const d of [home, dir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  };
  process.on('exit', cleanup);
  return { home, dir, cfg, studioDir: cfg.studioDir() };
}

module.exports = { setup };
