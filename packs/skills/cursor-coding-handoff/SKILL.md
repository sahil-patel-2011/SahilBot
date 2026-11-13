---
name: cursor-coding-handoff
description: Hand a coding task to Cursor and verify the result.
source: you
uses: 0
category: Coding
---

1. Make the task specific: goal, files/areas, constraints (style, no new dependencies) and how to verify (tests to run).
2. Use cursor(action="agent", folder, task) for local work, or cloud_launch for a GitHub repo (it can open a PR).
3. When it finishes, review: git diff, run the tests and the app. Don't just trust its summary.
4. If something's wrong, send a follow-up with resume: true describing exactly what to fix.
5. Report what changed and how you verified it.
