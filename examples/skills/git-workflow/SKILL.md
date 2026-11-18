---
name: git-workflow
description: Automates git operations like staging, committing with meaningful messages, and pushing.
---
# Workflow: Git Workflow

When the user asks to commit changes or push code, follow these steps:

1. **Check Status:** Run `git status` to see which files have been modified, added, or deleted.
2. **Stage Changes:** Use `git add <file>` or `git add .` to stage the relevant changes.
3. **Craft Commit Message:** 
   - Write a concise, meaningful commit message following conventional commits (e.g., `feat: add user authentication` or `fix: resolve memory leak in parser`).
   - The message should describe *what* changed and *why*.
4. **Commit:** Run `git commit -m "<message>"` to commit the staged changes.
5. **Push (Optional):** If requested, run `git push` to upload the changes to the remote repository.
6. **Final Report:** Confirm the commit hash and the status of the repository.
