---
name: coding-cursor-orchestration
description: Decide when to hand coding work to Cursor agents (local or cloud), run them, review what comes back against the brief, and iterate.
source: you
uses: 0
category: Coding
triggers: cursor, cursor agent, cursor-agent, cursor cloud, cursor background agent, use cursor, in cursor, let cursor, delegate to cursor, review cursor, cursor pr, cursor result
---

## Delegate or do it locally?
Do it yourself (code tool) when:
- the change is small, or touches 1-3 files you've already read (writing the brief costs more than the edit);
- it needs back-and-forth with the user, or judgement you can't write down yet;
- the repo isn't in git (no clean diff to review), or the task needs this Mac's apps, secrets or hardware;
- Cursor already failed twice on the same point.
Delegate when:
- the user asks for Cursor, or the work is big but well specified (a feature across many files, a migration with clear rules, a test suite);
- there are several independent pieces: one cloud agent per piece, in parallel;
- the repo is on GitHub and a PR is the natural output (cloud).
Local (cursor action="agent"): folder on this Mac, changes stay uncommitted for review. Cloud (cloud_launch): GitHub repo, long work, a PR. Check cursor(action="status") first.

## Steps
1. Explore first: code(action="project"), search/symbols/read the area, reproduce the bug. You must understand the change well enough to review it.
2. Record the plan and decisions: todo for the steps, notes(action="add") for decisions, constraints, files and the Cursor agent id once you have it, so a long run survives summarization.
3. Write the brief with the cursor-task-brief skill; preview with cursor(action="prompt", …) and fix the gaps it lists.
4. Run it.
   - Local: cursor(action="agent", folder, goal, …). Progress streams live.
   - Cloud: cursor(action="cloud_launch", repo, goal, …, wait: true, minutes: 10), or launch and later cursor(action="cloud_wait", id). Waits back off (10s to 60s) and stop at the limit. Don't poll in a loop; schedule a check for long runs.
5. Review. Every result ends with an "Automatic review" section. It flags:
   - scope outside the brief's files;
   - protected paths that changed;
   - removed or skipped tests, and suppressed type or lint checks;
   - debug output, TODOs and dependency changes;
   - failing checks.
   It also gives the acceptance checklist and a ready follow-up. Then:
   - Read every hunk of the diff. The summary is a claim; the diff is the truth.
   - Tick each acceptance item with evidence: a passing test, command output, or the line in the diff.
   - If the checks weren't run (cloud, or verify off), run them yourself: code(action="typecheck"), code(action="run_tests").
   - Cloud: cursor(action="cloud_review", id) shows the PR, its checks, the diff and the review.
6. Iterate precisely: send the suggested follow-up, edited to name file:line and the exact failure. Local: agent with resume: true and errors. Cloud: cloud_followup. Small fixes: do them yourself with code(action="edit").
7. Report: what changed (files), how you verified it (commands and results), the PR link, and anything left for the user. Restate the original goal and say whether each criterion is met.

## Pitfalls
- Trusting "all tests pass" in Cursor's summary without seeing a run.
- Briefs that say "see above" or "as discussed": Cursor has no above.
- Sending a follow-up that only says "still broken". Paste the output.
- Several agents editing the same files in parallel. That makes merge conflicts; sequence them instead.
- Committing or pushing Cursor's local changes without the user asking (see coding-commit-and-pr).
