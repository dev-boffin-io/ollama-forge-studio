---
name: test-and-verify
description: Runs tests, analyzes failures, and verifies fixes to ensure stability.
---
# Workflow: Test and Verify

When the user asks to test or fix a bug, follow these steps:

1. **Identify Test Command:** Determine the correct test command for the project (e.g., `npm test`, `pytest`, `go test`).
2. **Execute Test:** Run the command using the `bash` tool.
3. **Analyze Output:** 
   - If tests **PASS**: Report success and the test output.
   - If tests **FAIL**: Carefully read the error logs and stack traces to identify the root cause.
4. **Apply Fix (if needed):** Use the `edit` tool to fix the identified issue.
5. **Re-verify:** After applying a fix, **you must run the test command again**.
6. **Final Report:** Report the final status (PASS/FAIL) and a summary of what was changed.
