# Changelog

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
