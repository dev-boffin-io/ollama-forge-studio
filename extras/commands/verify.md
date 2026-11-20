---
description: Discover and run the project's real verification suite, then report exact commands, failures and gaps.
---
Verify that the current work is safe to hand off.

Input: $ARGUMENTS

1. Find the sources of truth: `AGENTS.md`, `README*`, `package.json`, `pyproject.toml`, `Makefile`, CI workflows and lockfiles. Do not invent commands.
2. List the available checks (lint, typecheck, build, tests, migrations, security scans) and choose the ones that cover the changed files. If a required tool is unavailable, say so instead of skipping it silently.
3. Run the selected commands, preserving their exact output for failures. Fix nothing in this command unless $ARGUMENTS explicitly asks for fixes.
4. Report a table with command -> pass/fail/skipped and the reason for each skip. For every failure include the error, likely cause and the smallest next action.
5. Name any changed area with no automated coverage and suggest the single most useful test to add.

End with one sentence: ready to hand off, or not ready and why.
