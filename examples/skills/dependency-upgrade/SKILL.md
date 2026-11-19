---
name: dependency-upgrade
description: Upgrades project dependencies safely, step by step, with changelog checks and a test run after every change.
---
# Workflow: Dependency Upgrade

1. **Baseline:** run the project's tests first. If they already fail, tell the user and stop: upgrades cannot be verified on a red baseline. Make sure `git status` is clean or note what is uncommitted.
2. **List outdated packages** with the ecosystem's own tool (`npm outdated`, `pip list --outdated`, `go list -u -m all`, `cargo outdated`). Group them: patch, minor, major.
3. **Upgrade in batches:** all patch updates together, then minor updates, then **one major at a time**. Use the package manager (never hand-edit lockfiles).
4. **Before each major:** read its changelog or migration guide (`webfetch`/`websearch`) and list the breaking changes that affect this codebase (`grep` for the affected APIs).
5. **After every batch:** run build + tests. If something breaks, fix the code for that package or revert that batch (`git checkout -- <manifest> <lockfile>`) and continue with the next one. Never leave the tree red.
6. **Report** as a table: package, old → new, kind, result (ok / adapted code / skipped and why), plus any deprecation or security notes.

Rules: do not upgrade across a major version without reading its notes; do not change the runtime/engine version unless asked; do not commit unless asked.
