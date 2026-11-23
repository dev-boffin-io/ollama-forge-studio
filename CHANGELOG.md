# Changelog

## Unreleased

- **New:** skills are auto-shortlisted by relevance, with `skills.auto` controls and frontmatter `auto: false`; hidden extended skills can be loaded from disk via `skills.remotesPath` or embedded with `--with-remotes`, and local names win.
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
