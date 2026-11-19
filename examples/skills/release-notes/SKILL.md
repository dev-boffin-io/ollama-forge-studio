---
name: release-notes
description: Builds release notes / a CHANGELOG entry from git history, checked against the actual diff.
---
# Workflow: Release Notes

1. **Find the range:** the last tag (`git describe --tags --abbrev=0`) to `HEAD`, or the range the user names. If there is no tag, ask.
2. **Collect:** `git log <range> --no-merges --pretty=format:'%h %s'`. Look at the merge commits / PR titles too when the history uses them.
3. **Verify:** for anything unclear or vague ("fix stuff"), read `git show --stat <hash>` or the diff to find out what it really changed. Do not guess.
4. **Group** (Keep a Changelog style): *Added*, *Changed*, *Fixed*, *Deprecated*, *Removed*, *Security*. Put breaking changes first under a **Breaking** heading with a one-line migration hint.
5. **Write** user-facing language: what changed for the user, not how. One line per change, commit hash or PR number in parentheses when available. Merge duplicates, drop pure chores (formatting, CI tweaks) unless they matter to users.
6. **Output:** show the entry in the reply; if the repo has a `CHANGELOG.md`, insert it at the top below the title in the file's existing format (ask before creating a new file).

Rules: never invent a version number or date; use the one the user gives (or leave `Unreleased`). Never claim a change that is not in the git range.
