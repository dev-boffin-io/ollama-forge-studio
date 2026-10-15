'use strict';

/** Render a whole session (archived + live messages) as readable Markdown. */

const fence = (s) => { let f = '```'; while (String(s).includes(f)) f += '`'; return f; };
const block = (s, lang = '') => { const f = fence(s); return `${f}${lang}\n${String(s).replace(/\n$/, '')}\n${f}`; };
const iso = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '-');

/** Tool results are usually small JSON objects; show string fields as real text instead of escaped one-liners. */
function renderToolResult(raw) {
  let obj = null;
  try { obj = JSON.parse(raw); } catch { /* plain text */ }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return block(raw);
  return Object.entries(obj).map(([k, v]) => (typeof v === 'string'
    ? `**${k}:**\n\n${block(v)}`
    : `**${k}:** \`${JSON.stringify(v)}\``)).join('\n\n');
}

function toMarkdown(session, transcript) {
  const live = session.messages.length;
  const archived = transcript.length - live;
  const out = [];
  out.push(`# ${session.title || '(untitled session)'}`, '');
  out.push(`> Exported from Ollama Forge Studio on ${iso(Date.now())}`, '');
  out.push('| | |', '|---|---|',
    `| Session | \`${session.id}\` |`, `| Agent | ${session.agent || '-'} |`, `| Model | ${session.model || '-'} |`,
    `| Created | ${iso(session.createdAt)} |`, `| Last updated | ${iso(session.updatedAt)} |`,
    `| Messages | ${transcript.length}${archived > 0 ? ` (${archived} of them were summarised out of the live context)` : ''} |`,
    `| Summaries | ${(session.summaries || []).length || session.compactions || 0} |`, '');

  let summaryNo = 0;
  for (const m of transcript) {
    if (m.role === 'assistant' && m.summary) continue;            // "Understood…" acknowledgement
    if (m.role === 'user' && m.summary) {
      summaryNo++;
      out.push('---', '', `## 📝 Summary #${summaryNo} of the earlier conversation`, '',
        m.content.replace(/^Summary of the earlier conversation:\n/, ''), '');
    } else if (m.role === 'user') {
      out.push('---', '', '## 🧑 User', '', (m.attachments ? (m.display != null ? m.display : m.content) : (m.display || m.content)) || '', '');
      for (const a of m.attachments || []) out.push(`📎 **${a.name}** (${a.kind}, ${a.size} bytes) — ${a.mode}${a.note ? ': ' + a.note : ''} · \`${a.path}\``);
      if ((m.attachments || []).length) out.push('');
    } else if (m.role === 'assistant') {
      out.push('---', '', '## 🤖 Assistant', '');
      if (m.thinking) out.push('<details><summary>💭 Thinking</summary>', '', m.thinking, '', '</details>', '');
      if (m.content) out.push(m.content, '');
      for (const c of m.tool_calls || []) {
        const args = c.function.arguments || {};
        out.push(`**⚙ ${c.function.name}**`, '', block(JSON.stringify(args, null, 2), 'json'), '');
      }
    } else if (m.role === 'tool') {
      const body = m.full != null ? m.full : m.content;            // `full` = original of a later-pruned output
      out.push(`<details><summary>↳ result of ${m.tool_name || 'tool'}${m.pruned ? ' (pruned from context, full output kept here)' : ''}</summary>`, '', renderToolResult(String(body)), '', '</details>', '');
    }
  }
  const todos = session.todos || [];
  if (todos.length) {
    out.push('---', '', '## Todos', '', ...todos.map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content || t.text || JSON.stringify(t)}`), '');
  }
  return out.join('\n');
}

module.exports = { toMarkdown };
