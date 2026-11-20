'use strict';

// text_search: pure Node.js regex/string search across project files (zero external dependencies).
//
// Replaces external binary-based search with a fast, zero-dependency Node.js file search tool.
// Searches files inside the working directory for text or regular expression matches.
//
// Config (optional in config.json):
//   "textSearch": { "maxBytes": 2000000, "ignoreFolders": ["node_modules", ".git", "dist", "build"] }

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.studio', 'coverage']);

function isBinaryFile(buffer) {
  const len = Math.min(buffer.length, 512);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

module.exports = {
  name: 'text',
  version: '1.0.0',
  description: 'Pure Node.js file search plugin (text_search) with regex support and no external dependencies.',
  setup(api) {
    const root = path.resolve(api.workDir);
    const pluginConfig = (api.config && api.config.textSearch) || {};
    const ignoreFolders = new Set([...DEFAULT_IGNORE, ...(Array.isArray(pluginConfig.ignoreFolders) ? pluginConfig.ignoreFolders : [])]);
    const maxBytes = Math.max(1, Number(pluginConfig.maxBytes) || 2 * 1024 * 1024);

    api.registerTool({
      name: 'search',
      description: 'Search project files for a plain text string or regular expression. Pure Node.js, zero external binaries needed. Returns file:line matches.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'String or regex pattern to search for.' },
          regex: { type: 'boolean', description: 'Treat query as a regular expression (default: false).' },
          case_sensitive: { type: 'boolean', description: 'Case-sensitive search (default: false).' },
          path: { type: 'string', description: 'Subdirectory or file to search relative to working directory (default: whole project).' },
          extension: { type: 'string', description: 'Filter by file extension, e.g. "js", "ts", "py".' },
          max_results: { type: 'number', description: 'Max results to return (default: 50, max: 200).' },
        },
        required: ['query'],
      },
      handler: async (args, ctx = {}) => {
        const queryStr = String(args.query || '').trim();
        if (!queryStr) throw new Error('query is required');

        const rel = String(args.path || '.');
        const target = path.resolve(root, rel);
        if (target !== root && !target.startsWith(root + path.sep)) {
          throw new Error('path must stay inside the working directory');
        }
        if (!fs.existsSync(target)) throw new Error(`path not found: ${rel}`);

        const maxResults = Math.min(200, Math.max(1, Number(args.max_results) || 50));
        const isRegex = Boolean(args.regex);
        const caseSensitive = Boolean(args.case_sensitive);
        const extFilter = args.extension ? String(args.extension).replace(/^\./, '').toLowerCase() : null;

        let matcher;
        if (isRegex) {
          try {
            matcher = new RegExp(queryStr, caseSensitive ? 'g' : 'gi');
          } catch (e) {
            throw new Error(`Invalid regex "${queryStr}": ${e.message}`);
          }
        } else {
          const lowerQuery = queryStr.toLowerCase();
          matcher = (line) => (caseSensitive ? line.includes(queryStr) : line.toLowerCase().includes(lowerQuery));
        }

        const matches = [];
        let totalCount = 0;

        function searchFile(filePath) {
          if (ctx.signal && ctx.signal.aborted) return;
          if (extFilter && path.extname(filePath).slice(1).toLowerCase() !== extFilter) return;

          let stat;
          try {
            stat = fs.statSync(filePath);
          } catch {
            return;
          }

          if (stat.size > maxBytes) return;

          let content;
          try {
            const buf = fs.readFileSync(filePath);
            if (isBinaryFile(buf)) return;
            content = buf.toString('utf8');
          } catch {
            return;
          }

          const lines = content.split(/\r?\n/);
          const relPath = path.relative(root, filePath);

          for (let i = 0; i < lines.length; i++) {
            if (ctx.signal && ctx.signal.aborted) break;
            const line = lines[i];
            let hit = false;

            if (isRegex) {
              matcher.lastIndex = 0;
              hit = matcher.test(line);
            } else {
              hit = matcher(line);
            }

            if (hit) {
              totalCount++;
              if (matches.length < maxResults) {
                matches.push(`${relPath}:${i + 1}: ${line.trim().slice(0, 200)}`);
              }
            }
          }
        }

        function walk(dirPath) {
          if (ctx.signal && ctx.signal.aborted) return;
          let entries;
          try {
            entries = fs.readdirSync(dirPath, { withFileTypes: true });
          } catch {
            return;
          }

          for (const entry of entries) {
            if (ctx.signal && ctx.signal.aborted) return;
            if (ignoreFolders.has(entry.name)) continue;

            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
              walk(fullPath);
            } else if (entry.isFile()) {
              searchFile(fullPath);
            }
          }
        }

        const targetStat = fs.statSync(target);
        if (targetStat.isDirectory()) {
          walk(target);
        } else if (targetStat.isFile()) {
          searchFile(target);
        }

        return {
          output: matches.length ? matches.join('\n') : 'no matches',
          matches: totalCount,
          ...(totalCount > maxResults ? { truncated: `${totalCount - maxResults} more matches` } : {}),
        };
      },
    });
  },
};
