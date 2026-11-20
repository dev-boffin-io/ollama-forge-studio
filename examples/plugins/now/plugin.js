'use strict';

module.exports = {
  name: 'now',
  version: '1.0.0',
  description: 'Read-only current-time tool for timestamps and timezone checks.',
  setup(api) {
    api.registerTool({
      name: 'now',
      description: 'Return the current time (or parse a supplied ISO timestamp) as ISO, local, Unix milliseconds and timezone. No network, no filesystem access.',
      parameters: {
        type: 'object',
        properties: {
          at: { type: 'string', description: 'Optional ISO timestamp to format instead of the current time.' },
          timezone: { type: 'string', description: 'IANA timezone, e.g. "UTC" or "Europe/Berlin". Defaults to the studio process timezone.' },
          utc: { type: 'boolean', description: 'Force UTC output and omit the local formatting.' },
        },
        additionalProperties: false,
      },
      handler: async (args = {}) => {
        const at = String(args.at || '').trim();
        const date = at ? new Date(at) : new Date();
        if (Number.isNaN(date.getTime())) throw new Error('at must be a valid ISO timestamp');
        if (args.utc === true) {
          return { iso: date.toISOString(), unix_ms: date.getTime(), timezone: 'UTC', output: date.toISOString() };
        }
        const timezone = String(args.timezone || '').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        let local;
        try {
          local = new Intl.DateTimeFormat(undefined, {
            timeZone: timezone,
            dateStyle: 'full',
            timeStyle: 'long',
          }).format(date);
        } catch (e) {
          throw new Error(`invalid timezone ${timezone}: ${e.message}`);
        }
        return {
          iso: date.toISOString(),
          local,
          unix_ms: date.getTime(),
          timezone,
          output: `${local} (${timezone})`,
        };
      },
    });
  },
};
