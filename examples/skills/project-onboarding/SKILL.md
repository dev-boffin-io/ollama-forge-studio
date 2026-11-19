---
name: project-onboarding
description: Explores an unfamiliar repository and writes (or refreshes) a concise AGENTS.md with verified commands, layout and conventions.
---
# Workflow: Project Onboarding

Use when the user asks to "understand", "onboard to" or "set up AGENTS.md for" a project, or when no `AGENTS.md` / `CLAUDE.md` exists.

1. **Inventory:** list the top-level files; read the manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `Makefile`) and any CI workflow. Note language, framework, package manager.
2. **Find the commands:** install, build, run/dev, test, lint, format. Take them from scripts/CI, never from memory.
3. **Verify:** run the cheap ones (lint, a single test file or the whole suite if it is fast) with `bash`. Mark a command as *verified* only if it ran; otherwise write "(not verified)".
4. **Map the layout:** one line per important directory (what lives there, entry points). Skip generated and vendored folders.
5. **Collect conventions:** naming, error handling, test style, commit style, anything surprising that a newcomer would get wrong. Quote real examples with file paths.
6. **Write `AGENTS.md`** (or update the existing one, keeping the user's text): at most ~60 lines, sections *Commands*, *Layout*, *Conventions*, *Gotchas*.
7. **Report:** what you wrote, which commands you could not verify, and open questions.

Rules: do not invent commands or paths; do not paste secrets or contents of `.env` files; never overwrite hand-written sections of an existing AGENTS.md without asking.
