'use strict';
// Zero-dependency lint for the rules this project cares about most. Exit 1 on any finding.
//  1. Frontend: innerHTML may only be built from a template that contains ${…} if every interpolation is
//     escaped, a number (Number(…)), or a trusted builder (escapeHtml, renderMarkdown, resultHtml). Otherwise it is an XSS risk.
//  2. No eval() / new Function() anywhere in the shipped code.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'workspace', 'test', 'examples', 'extras', 'scripts']);
const TRUSTED = /escapeHtml|renderMarkdown|resultHtml|truncate\(/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const findings = [];
for (const file of walk(root)) {
  const rel = path.relative(root, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const where = `${rel}:${i + 1}`;
    if (/\binnerHTML\s*\+?=/.test(line) && line.includes('${')) {
      // Strip the template's static text and keep only the interpolations, then require each to be trusted or escaped.
      const interps = [...line.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
      const bad = interps.filter((x) => !/^\s*Number\(|escapeHtml|renderMarkdown|resultHtml|truncate|summarize|\bhtml\b/.test(x));
      if (bad.length) findings.push(`${where}: innerHTML interpolates unescaped value(s): ${bad.join(', ')}`);
    }
    if (/(^|[^\w.])eval\s*\(|new\s+Function\s*\(/.test(line) && !line.trim().startsWith('//')) {
      findings.push(`${where}: eval / new Function is not allowed`);
    }
  });
}

if (findings.length) {
  for (const f of findings) console.error('✗ ' + f);
  console.error(`\n${findings.length} lint problem(s)`);
  process.exit(1);
}
console.log('lint: no problems');
