---
name: doc-generator
description: Generates technical documentation, README updates, and in-code comments.
---
# Workflow: Documentation Generation

When the user asks to document code or update README, follow these steps:

1. **Analyze Code:** Read the relevant files to understand the logic, parameters, return values, and purpose of the code.
2. **Generate Comments:** 
   - For functions/classes: Add clear, concise docstrings (e.g., JSDoc, Python docstrings) explaining what it does, its arguments, and its return type.
   - For complex logic: Add inline comments to explain "why" something is done, not just "what".
3. **Update README:** If the changes affect the project's usage, API, or installation, update the `README.md` file accordingly.
4. **Verify Style:** Ensure the documentation follows the existing project style and tone.
5. **Final Report:** List the files that were documented or updated.
