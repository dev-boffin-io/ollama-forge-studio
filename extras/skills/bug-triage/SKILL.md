---
name: bug-triage
description: Triages a bug from an error log or stack trace: classifies it, finds the root cause with evidence, and proposes (or applies on request) a minimal fix.
---
# Workflow: Bug Triage

1. **Capture the symptom exactly:** the error message, stack trace, steps, environment, frequency. If it is a pasted log, read it from the first error, not the last (later errors are often consequences).
2. **Locate:** take the top application frame of the stack (skip library frames), open that file and line, then `grep` for the error text and for callers (`lsp` findReferences when available).
3. **Reproduce:** write or run the smallest command/test that triggers it. If it cannot be reproduced, say what is missing (data, config, timing) instead of guessing.
4. **Find the root cause, not the crash site:** ask "why was this value/state possible?" at least twice. Check recent changes with `git log -S'<symbol>'` and `git blame` on the lines involved.
5. **Classify:** severity (data loss / security / crash / wrong result / cosmetic), scope (how many users or paths), regression or long-standing, and the likelihood of recurring.
6. **Propose the minimal fix** and a regression test that fails before and passes after. Apply it only if the user asked for a fix; otherwise stop at the proposal.
7. **Report:** root cause with file:line evidence, why it was not caught, the fix/test, related places with the same pattern (`grep` for them), and what you could not verify.

Rules: never claim a root cause without a reproduction or a concrete code path; do not "fix" by swallowing the exception; do not touch unrelated code.
