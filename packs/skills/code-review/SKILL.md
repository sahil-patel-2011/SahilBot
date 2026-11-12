---
name: code-review
description: Review code changes (a diff, a PR, or files) for bugs, security issues and clarity before they ship.
source: you
uses: 0
category: Engineering
---

1. Get the change: `run_command` `git diff --stat` then `git diff` (or `gh pr diff <n>`). Read the full files around each change with `file_read`, not just the hunks.
2. Understand intent first: read the PR description / commit message and any linked issue.
3. Check, in order of severity:
   - Correctness: edge cases (empty, null, huge, unicode), off-by-one, error paths, async/race conditions, resource leaks.
   - Security: injection (SQL, shell, path traversal), secrets in code, auth checks, unsafe deserialization.
   - Behavior changes for existing callers; missing migrations.
   - Tests: do they cover the new behavior and the failure modes? Run them (`npm test`, `pytest`, etc.).
   - Readability: naming, dead code, duplicated logic. Keep style comments brief.
4. Verify each finding before reporting it: trace the code path or write a tiny repro. Drop anything you can't confirm.
5. Report: findings ranked most severe first, each with file:line, what goes wrong (concrete input → bad result), and a suggested fix.
