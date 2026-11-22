---
name: code-quality-pass
description: Behavior-preserving refactors, clarity cleanups and formatting/lint passes. Use when code works but is hard to read, when asked to simplify, clean up or tidy a function or file, when a formatter or linter must be applied, or before finishing any change to verify style and static analysis.
tags: refactor, simplify, formatting, lint, prettier, eslint, ruff
---
# Workflow: Quality Pass

1. **Freeze behavior:** run the focused test for the target before changing anything and record its outputs, errors and side effects. If you cannot explain what the code does and why it exists (check callers, error paths, tests, `git blame`), read more first.
2. **Find the project's rules:** read rules/AGENTS files and neighboring code; discover the actual lint, format, typecheck and build commands from manifests, configs and CI. Never impose an external style.
3. **Apply concrete signals only:** nesting of 3+ levels → guard clauses; functions of 50+ lines → split; nested ternary → mapping or `if`; boolean flag arguments → options object; 5+ duplicated lines → extract; vague names (`data`, `temp`, `res`) → descriptive ones. Delete comments that restate code; keep comments that explain *why*. Never remove error handling, weaken types or inline a named concept to save a line.
4. **One change at a time:** refactor → focused test → repeat; revert the last step if it fails. Above ~500 lines use a codemod or AST transform instead of hand edits. Keep refactors separate from feature work.
5. **Format and validate:** format touched files with the repo's formatter, then lint → typecheck → focused tests → build, stopping at the first failing gate. Never silence a check to get green: no new `eslint-disable`, `@ts-ignore`, skipped tests or lowered thresholds without asking.
6. **Report:** before/after shape, commands run with results, and any issue deliberately left alone.

Rules: tests must pass unmodified — if a test needs editing, behavior changed; stay in scope; if no test exists, add one or state that verification was manual.
