# Security policy

## Threat model

Ollama Forge Studio is a **local** tool that lets an AI model read/write files and run commands in a folder you pick.
It assumes: you trust yourself, you do **not** automatically trust (a) web pages open in your browser, (b) other machines on your network,
(c) the contents of a repository you open, (d) text the model reads from files or the web (prompt injection).

| Threat | Mitigation |
|---|---|
| Malicious web page calls `http://127.0.0.1:<port>/api/*` (CSRF) | `Origin` / `Sec-Fetch-Site` checks, JSON-only writes |
| DNS rebinding | Host-name allow-list while bound to loopback |
| Other machines reach the server | token required for any non-loopback bind |
| Opening an untrusted repo runs its plugins / local LSP binaries | project trust gate |
| Model or injected text exfiltrates secrets from the environment | secrets stripped from child-process environments |
| `webfetch` used to reach cloud metadata / internal services | resolved-IP check, manual redirects |
| Stolen `config.json` | mode `0600`; prefer `apiKeyEnv` over storing keys |
| Injected text makes the model rewrite settings, hooks, plugins or `.git` with the (default-allowed) file tools | `lib/protect.js`: the studio config / hooks / plugins / history and everything under `.git` can never be written by the model, symlinks included |
| Shell operators hide a command behind an allowed one (`ls & curl …`) | quote-aware command splitter (`& ; \| && \|\|` newline); unterminated quotes, `$'…'`, substitutions and redirects are never auto-allowed |
| Repository config that runs programs (`core.fsmonitor`, `diff.external`, textconv, filters, includes) | `git` commands are not auto-allowed while `.git/config` contains such keys (`lib/gitsafe.js`), not even with an "always" grant |
| "Always allow" turns into a blanket licence | interpreters, wrappers (`node`, `python`, `env`, `find`, `xargs` …) and risky subcommands (`git push`, `docker run`, `npm run` …) are remembered for the exact command only |
| Sandboxed code edits host-side config / hooks | the studio folder is not mounted by default (read-only if you opt in); `.git/config`, `.git/hooks` and plugin folders are read-only inside the container; capabilities dropped; runs as your uid |
| Two agents overwrite each other's files | path claims between agents running at the same time (`lib/locks.js`) |

## Out of scope / known limits

- The model can do whatever you click *Allow* on. Shell commands ask first (only harmless read-only commands such as `ls`, `pwd`, `git status` run silently), and `edit` is allowed by default. Use `permission` rules and the Docker sandbox for untrusted work; the sandbox is off by default and the studio prints a warning at startup when it is off.
- `config.json` is written with mode `0600`, but Windows does not enforce POSIX modes, so that file is only as private as the Windows user profile.
- DNS rebinding *between* the webfetch resolve step and the connection (TOCTOU).
- `bash` can still write anywhere you allow it to. The file-tool protection (`lib/protect.js`) does not inspect shell commands: shell commands ask first, and the Docker sandbox mounts the sensitive paths read-only.
- Path claims between agents cover the file tools only, not shell commands; true per-agent isolation (a git worktree per agent) is not implemented.
- Prompt injection cannot be fully prevented; it is mitigated by permission prompts.
- The VS Code extension does not send the access token (works with the default loopback mode).

## Reporting

Please report vulnerabilities privately to the maintainer (open a private security advisory on the repository) instead of a public issue.
