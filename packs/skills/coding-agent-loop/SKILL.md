---
name: coding-agent-loop
description: The core loop for any code change - understand, plan, edit minimally, verify, report - with the code and git tools.
source: you
uses: 0
category: Coding
---

1. Orient: code(action="project") gives languages, test/typecheck/lint commands, git branch and changes. Read AGENTS.md / CONTRIBUTING / README if present. git status: note existing uncommitted work so you don't mix it with yours.
2. Find the code: code(action="search", pattern, glob) for text, code(action="symbols", name) for definitions, then code(action="read", path, start, end) the relevant parts, their callers and their tests. Keep reading until you can explain the change in one sentence.
3. Reproduce (bugs): run the failing test or write one that fails for the reported reason (run_tests with a filter).
4. Plan with todo for anything beyond a one-file change. Say in a short note what you're about to change.
5. Edit minimally in the file's own style: code(action="edit", path, old_string, new_string) for one spot (old_string copied exactly from a fresh read), edits=[…] for several spots in one file, apply_patch for multi-file changes. New files: file_write. The result shows the diff: read it.
6. Verify: code(action="typecheck"), then run_tests with a filter for what you touched, then the full suite; lint if the project uses it. Fix the cause of failures; never delete or weaken tests to pass.
7. Check your own diff (git diff): only intended changes, no debug prints, no secrets, no stray files.
8. Commit only if the user wants it (see coding-commit-and-pr).
9. Report: what changed and why (files), the commands you ran and their results, anything not verified or left to do.

Gotchas:
- Edit says "occurs N times": add surrounding lines to old_string. "not found": re-read; the file changed or whitespace differs.
- A missing tool ("command not found", "No module named"): install dependencies asks the user (npm install, pip install -r requirements.txt).
- Long builds/tests: pass timeout; use a filter while iterating.
