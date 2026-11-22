---
name: dependency-setup
description: Detects the project's package manager and installs, adds, removes or audits dependencies reproducibly. Use when setting up a project, installing from a lockfile, adding a new package, choosing dev versus runtime deps, or checking installed packages and vulnerabilities; for version upgrades use the bundled dependency-upgrade skill instead.
tags: install, npm, pnpm, yarn, pip, uv, lockfile, package manager, audit
---
# Workflow: Dependency Setup

1. **Detect the manager from evidence:** read the manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`) and lockfiles (`package-lock.json` → npm, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb` → bun, `uv.lock` or `requirements*.txt` → uv/pip). Cross-check `packageManager`, CI and `engines`; stop and ask if two lockfiles compete.
2. **Choose the operation:** clean install (`npm ci`, `pnpm install --frozen-lockfile`, `uv sync`) for an existing lockfile; add with the manager (`npm add <pkg>`, `pnpm add -D <pkg>`, `uv add --dev <pkg>`); remove with its `remove`/`uninstall` equivalent. Never hand-edit manifests or lockfiles and never mix managers.
3. **Gate install scripts:** before allowing a new package's scripts to run, inspect what they do and approve only what is needed; pin the manager version where the repo does. Keep credentials in env vars, never in commands you print.
4. **Decide dev versus runtime:** tools and test frameworks go to dev dependencies; anything imported by shipped code goes to runtime. Prefer the stdlib or an existing utility over a new package — check maintenance, license and bundle cost first.
5. **Verify after every change:** run the build plus focused/full tests, inspect the manifest and lockfile diff (`git diff -- package.json <lockfile>`), and run the native audit against the committed lockfile. Triage high/critical findings by reachability; never auto-run `npm audit fix --force`.
6. **Report:** manager and version, exact commands, packages added or removed, audit findings and deferrals, and verification results.

Rules: no hand-edited lockfiles, no forced audit fixes, no runtime or engine changes unless asked, no commits unless asked; for upgrades hand off to `dependency-upgrade`.
