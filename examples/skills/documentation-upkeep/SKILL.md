---
name: documentation-upkeep
description: Creates and updates READMEs, API and config references, docstrings and decision records from the code, and detects docs that have drifted. Use when documenting a feature or public API, refreshing a README, writing an ADR, or when documentation may be stale, incomplete or inconsistent with the implementation.
tags: docs, README, API docs, JSDoc, docstring, ADR, drift
---
# Workflow: Documentation Upkeep

1. **Establish the source of truth and convention:** read the code, tests and public interfaces first; find existing docs, templates, heading styles, ADR location/numbering and any tooling before creating anything. Match what exists instead of introducing a second scheme.
2. **Decide the artifact:** README → quick start, commands table, configuration/API link, architecture, contributing; reference → one uniform entry per symbol (type, parameters, defaults, returns, throws, examples, see-also) extracted from code; docstring → purpose, parameters, returns and throws, with inline comments only for *why*; ADR → Status/Date/Context/Decision/Alternatives/Consequences, superseding rather than deleting old decisions.
3. **Draft with placeholders:** create the file with all headings and `[To be written]` markers, then fill one section at a time using surgical edits. Never reprint a whole document to change one paragraph.
4. **Verify every fact:** reopen the referenced source for names, defaults, commands, paths and links; document behavior, not implementation. Include one happy path and one error case per documented API.
5. **Detect drift:** compare doc and code history (`git log -1 --format=%H -- <code>` versus `<doc>`, then `git merge-base --is-ancestor`); if history is inconclusive say "can't tell", never "current". Update affected sections in place, preserving user-written text.
6. **Reader-test:** check that the doc answers a newcomer's questions, has no contradictions or redundant sentences, and that every command can be copied and run. Report files changed, sections added and claims you could not verify.

Rules: no invented commands, versions, dates or links; never rewrite hand-written sections without asking; no secrets in examples.
