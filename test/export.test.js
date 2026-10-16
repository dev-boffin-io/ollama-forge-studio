'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toMarkdown } = require('../lib/export');

const session = {
  id: 'ses_abc123', title: 'Fix the bug', agent: 'build', model: 'llama3',
  createdAt: 1700000000000, updatedAt: 1700000100000, compactions: 1,
  messages: [
    { role: 'user', content: 'Please fix the login bug', attachments: [{ name: 'shot.png', kind: 'image', size: 123, mode: 'image', path: '.studio/uploads/shot.png' }] },
    { role: 'assistant', thinking: 'Hmm, the bug is in auth.js', content: 'Looking at auth.js now.' , tool_calls: [{ function: { name: 'read_file', arguments: { path: 'auth.js' } } }] },
    { role: 'tool', tool_name: 'read_file', content: '{"path":"auth.js","content":"..."}' },
  ],
  todos: [{ content: 'Find the bug', status: 'completed' }, { content: 'Ship the fix', status: 'pending' }],
  summaries: [],
};

const transcript = [
  { role: 'user', content: 'Summary of the earlier conversation:\n## Objective\n- Earlier work', summary: true },
  ...session.messages,
];

test('toMarkdown: header table, messages, thinking, tool calls and results', () => {
  const md = toMarkdown(session, transcript);
  assert.ok(md.startsWith('# Fix the bug'));
  assert.ok(md.includes('| Session | `ses_abc123` |'));
  assert.ok(md.includes('| Agent | build |'));
  assert.ok(md.includes('## 🧑 User'));
  assert.ok(md.includes('Please fix the login bug'));
  assert.ok(md.includes('📎 **shot.png** (image, 123 bytes)'));
  assert.ok(md.includes('## 🤖 Assistant'));
  assert.ok(md.includes('<details><summary>💭 Thinking</summary>'));
  assert.ok(md.includes('Hmm, the bug is in auth.js'));
  assert.ok(md.includes('**⚙ read_file**'));
  assert.ok(md.includes('"path": "auth.js"'));
  assert.ok(md.includes('↳ result of read_file'));
});

test('toMarkdown: summaries and todos get their own sections', () => {
  const md = toMarkdown(session, transcript);
  assert.ok(md.includes('## 📝 Summary #1 of the earlier conversation'));
  assert.ok(md.includes('## Todos'));
  assert.ok(md.includes('- [x] Find the bug'));
  assert.ok(md.includes('- [ ] Ship the fix'));
});

test('toMarkdown: message counts mention summarised history', () => {
  const md = toMarkdown(session, transcript);
  assert.ok(md.includes('| Messages | 4 (1 of them were summarised out of the live context) |'));
});

test('toMarkdown: tool result plain text fallback and fenced-block escaping', () => {
  const s = {
    ...session,
    messages: [
      { role: 'tool', tool_name: 'bash', content: 'plain\noutput with ``` fences' },
      { role: 'assistant', content: 'done' },
    ],
  };
  const md = toMarkdown(s, s.messages);
  assert.ok(md.includes('```'));
  assert.ok(md.includes('plain'));
  assert.ok(md.includes('output with'));
});
