---
name: coding-cursor-orchestration
description: Decide when to hand coding work to Cursor agents (local or cloud), write the brief, watch them, and review what comes back.
source: you
uses: 0
category: Coding
---

## Delegate or do it yourself?
Do it yourself (code tool) when:
- the change is small or touches 1-3 files you've already read;
- it needs back-and-forth with the user, or judgement you can't write down yet;
- the repo isn't in git (you can't review a Cursor diff cleanly).

Delegate to Cursor when:
- the user asks for Cursor, or the work is big but well specified (a feature across many files, a migration, a refactor with clear rules, a test suite to write);
- there are several independent pieces: one cloud agent per piece, in parallel;
- the repo is on GitHub and a PR is the natural output (cloud agent).
Local agent (cursor action="agent"): the folder is on this Mac and you want the changes uncommitted to review. Cloud agent (cloud_launch): GitHub repo, long work, you want a PR. Check cursor(action="status") first.

## Write the brief (Cursor sees none of this chat)
1. Explore first: code(action="project"), search/symbols/read the area, run the failing test. Put what you learned in `context` (where things live, how they connect, the root cause if known).
2. Call cursor with structured fields; it builds the prompt and shows it in the approval:
   - goal: the outcome, concrete ("Add a --json flag to `export` that prints the rows as JSON lines").
   - files: the files to start with.
   - errors: the exact failing output, if fixing something.
   - constraints: style rules, no new deps, keep the public API, performance limits.
   - dont_change: files/behaviour that must not change ("the database schema", "tests/fixtures/").
   - acceptance: checkable criteria ("`export --json` prints one JSON object per row", "existing CSV output unchanged").
   - tests: commands that must pass (default: the project's type check and tests).
   Use cursor(action="prompt", …) to preview the prompt when the user wants to see it first.

## Run and watch
- Local: cursor(action="agent", folder, goal…). Progress streams live; the result has Cursor's summary, the exact diff against a restore point, and the test/type-check results.
- Cloud: cursor(action="cloud_launch", repo, goal…, wait: true, minutes: 10), or launch and later cursor(action="cloud_wait", id). Waits back off (10s → 60s) and stop at the limit; don't poll in a loop. For long runs, schedule a check instead.

## Review before reporting (never just trust the summary)
1. Read the diff: does it do exactly the goal? Any unrelated edits, deleted tests, weakened assertions, TODOs, hard-coded secrets, debug prints?
2. Run the checks yourself if the result didn't (code run_tests/typecheck). Cloud: cursor(action="cloud_review", id) shows the PR, its checks and diff; or git pr_diff.
3. Problems? Send a precise follow-up: local cursor(action="agent", resume: true, goal: "Fix: …", errors: "<failures>"); cloud cursor(action="cloud_followup", id, goal…). Small fixes: do them yourself with code edit.
4. Report: what changed (files), how you verified it (commands + results), the PR link, and anything left for the user.
