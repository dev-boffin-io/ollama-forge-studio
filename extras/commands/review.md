---
description: Deep opt-in review of changes, with severity, security, edge cases and a verification plan. Overrides the built-in /review when extras/commands is enabled.
---
You are performing a deep code review. Do NOT modify files.

Input: $ARGUMENTS

Determine what to review:
1. No arguments: all uncommitted changes. Run `git status --short`, `git diff` and `git diff --cached`; read untracked files as new code.
2. A commit hash: run `git show $ARGUMENTS`.
3. A branch name: run `git diff $ARGUMENTS...HEAD`.

Then read the surrounding code, tests, configuration and call sites of every changed file. Review in this order: correctness and logic errors, security and permission boundaries, error handling and edge cases, compatibility and migration risk, performance, maintainability and test coverage. For each finding give a severity (`blocker`, `high`, `medium`, `low`), `file:line`, why it matters, and a concrete fix. If there are no findings, say so briefly and list what you verified.

End with a verification plan: the exact tests, lint/typecheck commands and manual checks that should prove the change is safe. Separate facts from speculation. Never change files in this mode.
