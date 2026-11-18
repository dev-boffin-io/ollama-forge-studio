---
name: refactor-expert
description: Analyzes code for complexity and applies clean code principles to improve readability and maintainability.
---
# Workflow: Code Refactoring

When the user asks to refactor or clean up code, follow these steps:

1. **Analyze Complexity:** Read the target code and identify "code smells" (e.g., long functions, deep nesting, duplicate logic, or poor naming).
2. **Plan Refactor:** 
   - Decide on a strategy (e.g., extracting functions, simplifying conditionals, or using better design patterns).
   - Ensure the refactor does not change the external behavior of the code.
3. **Execute Refactor:** Use the `edit` tool to apply the changes incrementally.
4. **Verify Integrity:** 
   - After refactoring, run existing tests to ensure no regressions were introduced.
   - If no tests exist, perform a manual check of the logic.
5. **Final Report:** Summarize what was refactored and why (e.g., "Extracted `calculateTotal` into a separate function to reduce complexity").
