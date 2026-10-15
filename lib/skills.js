'use strict';

// Skills: folders containing SKILL.md with frontmatter { name, description }.
// Scanned in: <dir>/.studio/skills, <dir>/.claude/skills, <dir>/.agents/skills, ~/.config/ollama-studio/skills,
// ~/.claude/skills, ~/.agents/skills, plus config.skills.paths. The model sees name+description and loads the body
// on demand with the `skill` tool.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GLOBAL_DIR, getWorkDir, studioDir } = require('./config');
const { parseFrontmatter } = require('./agents');

function scanDir(root, out) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory() || e.isSymbolicLink()) {
      const file = path.join(full, 'SKILL.md');
      if (fs.existsSync(file)) {
        try {
          const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
          if (typeof meta.name === 'string' && meta.name) {
            out[meta.name] = { name: meta.name, description: typeof meta.description === 'string' ? meta.description : '', location: file, base: full, content: body };
          }
        } catch { /* skip */ }
      } else if (e.isDirectory()) scanDir(full, out); // nested groups
    }
  }
}

function loadSkills(config) {
  const dir = getWorkDir();
  const home = os.homedir();
  const roots = [
    path.join(home, '.claude', 'skills'), path.join(home, '.agents', 'skills'), path.join(GLOBAL_DIR, 'skills'),
    path.join(dir, '.claude', 'skills'), path.join(dir, '.agents', 'skills'), path.join(studioDir(), 'skills'),
    ...((config.skills && config.skills.paths) || []).map((p) => (p.startsWith('~/') ? path.join(home, p.slice(2)) : path.resolve(dir, p))),
  ];
  const out = {}; // later roots win
  for (const r of roots) scanDir(r, out);
  return out;
}

function listFiles(base, limit = 10) {
  const files = [];
  const walk = (d, depth) => {
    if (depth > 3 || files.length >= limit) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= limit) return;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (e.name !== 'SKILL.md') files.push(path.relative(base, f));
    }
  };
  walk(base, 0);
  return files;
}

function load(name, config) {
  const all = loadSkills(config);
  const s = all[name];
  if (!s) throw new Error(`Skill "${name}" not found. Available skills: ${Object.keys(all).join(', ') || 'none'}`);
  return [
    `<skill_content name="${s.name}">`,
    `# Skill: ${s.name}`, '', s.content.trim(), '',
    `Base directory for this skill: ${s.base}`,
    'Relative paths in this skill (e.g. scripts/, reference/) are relative to this base directory (use bash/read_file with the full path).',
    'Note: the file list is sampled.', '',
    '<skill_files>', ...listFiles(s.base).map((f) => `<file>${f}</file>`), '</skill_files>',
    '</skill_content>',
  ].join('\n');
}

/** Prompt section listing the skills available to the model. */
function promptSection(config) {
  const all = Object.values(loadSkills(config));
  if (!all.length) return '';
  return 'Skills provide specialised instructions for specific tasks. When a task matches one, call the "skill" tool with its name BEFORE starting. Available skills:\n' +
    all.map((s) => `- ${s.name}: ${s.description || '(no description)'}`).join('\n');
}

module.exports = { loadSkills, load, promptSection };
