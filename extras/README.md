# extras: optional agents-skills-tools, **not** loaded by default

Everything in `examples/` ships with the studio and is active for everyone, so it is kept small (every skill and tool costs
prompt tokens on every request). Things that are useful to *some* people live here and are switched on explicitly.

| Path | What | Needs |
|---|---|---|
| `agents/release-manager` | version bumps, changelog/release notes, tags and release verification | – |
| `agents/support-triage` | logs / stack traces → reproduction, scope and ranked root causes | – |
| `commands/review.md` | deep opt-in review that overrides the built-in `/review` | – |
| `commands/verify.md` | discover and run the project's real checks, then report gaps | – |
| `skills/api-designer` | REST / GraphQL / JSON-RPC design with a validated contract | – |
| `skills/docker-expert` | Dockerfile + compose hardening, verified by building | Docker (optional, for verifying) |
| `skills/database-migration` | safe migrations, expand→contract, rollback, dry run | the project's migration tool |
| `plugins/text-search` | tool `text_search`: pure Node.js regex/text file search | – (Node 18+) |

`bug-triage` and `i18n-l10n` are now bundled defaults in `examples/skills/`. `http-request` is now a bundled default in `examples/plugins/`.

## Enable (config.json, global or per project)

Use absolute paths to this folder (or copy what you want into the matching global / project folders):

```json
{
  "agents":   { "paths": ["/path/to/ollama-forge-studio/extras/agents"] },
  "commands": { "paths": ["/path/to/ollama-forge-studio/extras/commands"] },
  "skills":   { "paths": ["/path/to/ollama-forge-studio/extras/skills"] },
  "plugins":  { "paths": ["/path/to/ollama-forge-studio/extras/plugins"] },
  "permission": { "plugin": { "text_search": "allow" } }
}
```

Pick single items by pointing a path at a folder that contains only those (e.g. symlink the ones you want into one folder).
Reload plugins with `POST /api/plugins/reload`. `extras/` is **not** embedded in the single-file executable (opt-in by design):
with the binary, copy the folders you want into the global `agents/`, `commands/`, `skills/` or `plugins/` directory.

## `http_request` plugin

```json
"http": {
  "allowHosts":   ["api.github.com", "*.example.com"],
  "allowPrivate": ["localhost:3000"],
  "allowEnv":     ["GITHUB_TOKEN"],
  "maxBytes":     20000
}
```

- Headers may use `{{env:GITHUB_TOKEN}}`; only variables in `allowEnv` are substituted, so the model never sees the secret.
- Public hosts: allowed unless `allowHosts` is set (then only those). Hosts that resolve to loopback / private / link-local
  addresses ask first, unless listed in `allowPrivate`. Redirects are never followed.
- Plugin tools ask by default (`plugin` permission, the pattern is the tool name only, so per-host rules are done by the
  plugin's own config above). **It runs in the studio process, not in the Docker sandbox.**

## `text_search` plugin

Read-only, zero external binaries. Configure it with `"textSearch": { "maxBytes": 2000000, "ignoreFolders": ["dist"] }`.
Pattern examples: `fetchUser`, `fetchUser\\(\\d+\\)` with `"regex": true`, `TODO|FIXME` with `"regex": true`.
