---
name: test-and-dev-server
description: Runs the project's real test commands and launches or stops local dev servers for verification. Use when asked to run tests, start a dev server, verify a change in a browser, add a failing test first, or reproduce a check with the repository's own tooling.
tags: test runner, dev server, playwright, browser, npm test, pytest, localhost
---
# Workflow: Tests and Dev Server

1. **Discover commands, never assume:** read manifests, Makefiles, wrappers, README/CONTRIBUTING and CI to find install, focused-test, full-suite, lint/typecheck, build and dev-server commands plus their ports. Prefer checked-in wrappers (`make test`, `npm test -- <file>`, `pytest -k ...`).
2. **Baseline first:** record `git status --short` and run the smallest relevant test. If it already fails, report that before making changes.
3. **Test-first when changing behavior:** write a test at the public seam, watch it RED, implement minimally, watch it GREEN, then refactor with tests still green. Assert on behavior and edge cases, not implementation details; use descriptive names and prefer real → fake → stub → mock.
4. **Run the gates in order:** focused test → related tests → full suite → lint/typecheck → build. Use the focused command while iterating and the full suite once at the end; stop at the first failure and feed the specific error back, not the whole log.
5. **Launch dev servers deliberately:** start with the repo's `dev` script, capture logs to a temp file, wait for the port/health check rather than sleeping blindly, and keep the PID so you can stop it. For backend plus frontend, start both on their own ports. If a helper script exists, call it with `--help` first and treat it as a black box.
6. **Verify in the browser when the UI changed:** navigate, wait for `networkidle`, screenshot/inspect DOM and console, then act with discovered selectors. Write automation to `/tmp`, use headless Chromium, and close the browser.
7. **Clean up:** stop every process you started, delete temp scripts, and report commands, pass/fail status, ports used and remaining failures.

Rules: never leave a server running or a temp script behind; never mark a check green if it was skipped; redact secrets from output.
