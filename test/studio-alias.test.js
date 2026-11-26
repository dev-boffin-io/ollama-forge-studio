'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setup } = require('./helpers');

const ctx = setup();
const cfg = require('../lib/config');
const agents = require('../lib/agents');
const procs = require('../lib/procs');

const D = '/home/u/.studio/proj-ab12cd34';

test('expandStudioAlias: standalone .studio words become the real data folder, look-alikes stay', () => {
  assert.equal(cfg.expandStudioAlias('unzip .studio/uploads/a.zip -d out', D), `unzip ${D}/uploads/a.zip -d out`);
  assert.equal(cfg.expandStudioAlias('ls ./.studio', D), `ls ${D}`);
  assert.equal(cfg.expandStudioAlias('cp "x" ".studio/uploads/y"; echo .studio', D), `cp "x" "${D}/uploads/y"; echo ${D}`);
  const same = 'cat ~/.studio/x $HOME/.studio/y foo/.studio/z .studio-x my.studio/q';
  assert.equal(cfg.expandStudioAlias(same, D), same);
  if (process.platform !== 'win32') assert.equal(cfg.expandStudioAlias('ls .studio/u', '/home/J S/.studio/p'), 'ls /home/J\\ S/.studio/p/u');
});

test('bash tool: ".studio/uploads/x" reaches the file that lives in the per-project data folder', { skip: process.platform === 'win32' }, async () => {
  const up = path.join(cfg.studioDir(), 'uploads');
  fs.mkdirSync(up, { recursive: true });
  fs.writeFileSync(path.join(up, 'dcaf9464-file.txt'), 'hello-from-upload');
  const r = await procs.runForeground('cat .studio/uploads/dcaf9464-file.txt', 10000, null, {});
  assert.equal(r.exit_code, 0);
  assert.match(r.output, /hello-from-upload/);
});

test('composeSystem tells the agent where .studio really is and what it holds', () => {
  const text = agents.composeSystem({ agent: agents.getAgent('build'), config: cfg.loadConfig(), canDelegate: false, rules: [], session: null });
  assert.ok(text.includes(`Studio data folder (NOT inside the project): ${cfg.studioDir()}`));
  assert.match(text, /uploads\/\s+files the user attached/);
  assert.match(text, /tool-output\//);
  assert.match(text, /Never look for "\.studio" inside the working directory/);
});
