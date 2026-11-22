---
name: file-operations
description: Safely creates, edits, moves and deletes project files and scaffolds new modules. Use when adding a file or directory, applying surgical edits, renaming or moving paths, removing dead or obsolete files, or when a change spans several files and needs a plan.
tags: file create, edit, delete, scaffold, rename, move
---
# Workflow: File Operations

1. **Classify the change:** create / edit / move / delete, with exact target paths. Read each existing target and its neighbors first; find one in-repo example of the intended layout and naming conventions.
2. **Resolve and confine paths:** expand `~` and symlinks, confirm each target is inside the intended project root and at least one level below it. Refuse absolute or derived paths that escape the root; never fall back to a broader default path.
3. **Plan multi-file work:** write the intended tree and one action per file before executing. For scaffolds include the entry point, tests, `.gitignore` entries and standard scripts in the same style as existing packages; give each step a `Done when:` check.
4. **Edit surgically:** use exact string replacements for small changes; rewrite a whole file only after reading it fully and only for structural changes. Create parent directories first, preserve encoding and line endings, and never hand-edit generated files or lockfiles.
5. **Delete deliberately:** prove the target is unused (search imports and references, check tests, check `git log`/`git blame`), list what will be removed, and ask before deleting anything you did not create in this session. Log moves so they can be undone; prefer archive/trash when ownership is unclear.
6. **Verify:** inspect `git status --short` and the resulting tree, run the focused test or lint for the touched files, and report each path with its action.

Rules: no silent cleanup, no unrelated files, no destructive `rm -rf` on variables or derived paths; redact secrets; ask when scope or ownership is uncertain.
