# extras: optional agents-skills-tools, **not** loaded by default

Everything in `examples/` ships with the studio and is active for everyone, so it is kept small (every skill and tool costs
prompt tokens on every request). Things that are useful to *some* people live here and are switched on explicitly.

| Path | What | Needs |
|---|---|---|
| `skills/api-designer` | REST / GraphQL / JSON-RPC design with a validated contract | – |
| `skills/docker-expert` | Dockerfile + compose hardening, verified by building | Docker (optional, for verifying) |
| `skills/database-migration` | safe migrations, expand→contract, rollback, dry run | the project's migration tool |
| `skills/i18n-l10n` | extract strings, plurals, locale-completeness check | – |
| `skills/bug-triage` | log / stack trace → evidence-based root cause | – |
| `plugins/http-request` | tool `http_request`: API client with secret injection, private-network guard, size caps | – (Node 18+) |
| `plugins/ast-search` | tool `ast_search`: structural code search | the external `ast-grep` binary (`npm i -g @ast-grep/cli`) |

## Enable (config.json, global or per project)

Use absolute paths to this folder (or copy what you want into `~/.config/ollama-studio/skills/` / `<project>/.studio/skills/`,
resp. `.../plugins/`):

```json
{
  "skills":  { "paths": ["/path/to/ollama-forge-studio/extras/skills"] },
  "plugins": { "paths": ["/path/to/ollama-forge-studio/extras/plugins"] },
  "permission": { "plugin": { "ast_search": "allow" } }
}
```

Pick single items by pointing a path at a folder that contains only those (e.g. symlink the ones you want into one folder).
Reload plugins with `POST /api/plugins/reload`. `extras/` is **not** embedded in the single-file executable (opt-in by design):
with the binary, copy the folders you want into the global `skills/` or `plugins/` directory.

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

## `ast_search` plugin

Registers nothing (and logs a warning) when `ast-grep` is not installed. Read-only. Pattern examples:
`fetchUser($ID)` (ts), `class $C extends Base { $$$BODY }`, `console.log($$$ARGS)`.
