'use strict';

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

module.exports = {
  name: 'json',
  version: '1.0.0',
  description: 'Read-only JSON formatting and inspection tool bundled with the studio.',
  setup(api) {
    api.registerTool({
      name: 'format',
      description: 'Validate, pretty-print and optionally sort keys of a JSON string. Reads no files and has no side effects.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'JSON text to validate and format.' },
          indent: { type: 'number', description: 'Indent width from 0 to 8 (default 2).' },
          sort_keys: { type: 'boolean', description: 'Sort object keys recursively.' },
          max_chars: { type: 'number', description: 'Maximum output length from 1000 to 100000 (default 20000).' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      handler: async (args = {}) => {
        const text = String(args.text ?? '');
        if (!text.trim()) throw new Error('text is required');
        if (text.length > 1000000) throw new Error('text is too large (1,000,000 character limit)');
        const indent = Math.min(8, Math.max(0, Number.isFinite(Number(args.indent)) ? Number(args.indent) : 2));
        const max = Math.min(100000, Math.max(1000, Number.isFinite(Number(args.max_chars)) ? Number(args.max_chars) : 20000));
        let value;
        try {
          value = JSON.parse(text);
        } catch (e) {
          throw new Error(`invalid JSON: ${e.message}`);
        }
        if (args.sort_keys === true) value = sortKeys(value);
        const formatted = JSON.stringify(value, null, indent);
        if (formatted === undefined) throw new Error('value is not JSON-serializable');
        const truncated = formatted.length > max;
        return {
          ok: true,
          output: truncated ? formatted.slice(0, max) + '\n… output truncated' : formatted,
          chars: formatted.length,
          truncated,
          indent,
          sort_keys: args.sort_keys === true,
        };
      },
    });
  },
};
