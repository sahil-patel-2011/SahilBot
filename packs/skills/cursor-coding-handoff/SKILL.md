---
name: cursor-coding-handoff
description: Quick path to hand one coding task to Cursor and verify it; points to cursor-task-brief and coding-cursor-orchestration for depth.
source: you
uses: 0
category: Coding
triggers: open in cursor, send to cursor, cursor handoff, cursor hand-off
---

1. Explore the area first (code project/search/read) so you can write a complete brief and review the result.
2. Brief (cursor-task-brief): goal (one outcome), context (what you found, decisions and the user's constraints from your notes), files, errors (exact output), constraints, dont_change, acceptance (checkable), tests (commands). Preview with cursor(action="prompt", …) and fix the gaps it lists.
3. Run: cursor(action="agent", folder, …) for a folder on this Mac, or cursor(action="cloud_launch", repo, …) for a GitHub repo (opens a PR). Save the agent id in your notes.
4. Review the result's "Automatic review": read the diff, tick every acceptance criterion with evidence, run the checks yourself if they weren't run. Cloud: cursor(action="cloud_review", id).
5. Something wrong: send the suggested follow-up with the exact failure (local: resume: true; cloud: cloud_followup). Twice failed on the same point: fix it yourself.
6. Report what changed, how you verified it, and anything left. Only open a file in Cursor (cursor action="open", path, line) when the user wants to look at it.
