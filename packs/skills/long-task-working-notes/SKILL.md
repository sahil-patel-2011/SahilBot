---
name: long-task-working-notes
description: Keep a long or multi-step task on track - durable working notes, plan checkpoints, re-reading after summaries, restating the goal before finishing.
source: you
uses: 0
category: Coding
triggers: long task, long-running, multi-step, overnight, keep track, don't forget, working notes, checkpoint, big refactor, end to end, from scratch, across the codebase, many steps, resume where
---

## When
Any task that will take many steps (roughly 15+ tool calls), spans several files or systems, runs across a Cursor hand-off or a schedule, or will outlive the context window. Older messages get summarized; only the plan (todo) and your notes are carried word for word.

## Steps
1. Start: restate the goal in one sentence and write it down: notes(action="add", section="Goal", text=…). Add the user's rules to Constraints if they aren't captured already; they're the user's, never yours to change.
2. Plan with todo: 3-10 steps the user would recognize, each ending in a checkable result. Exactly one in_progress.
3. Work, and write notes as you go, not at the end:
   - Decisions: what you chose and why ("Kept REST, not GraphQL: the client only needs 3 endpoints").
   - Files: paths created, changed or needed.
   - Identifiers: branch names, PR numbers, Cursor agent ids, job ids, URLs, record ids, version numbers. Exact strings. Secrets by NAME only, never values.
   - State: partial results with their numbers ("12/40 tests migrated; suite green").
   - Failed attempts: what didn't work and why, so it isn't retried after a summary.
   - Open questions: what needs the user; ask them together, once.
   - Next steps: the very next action, specific enough to resume cold.
4. Milestones: when a todo item is done, tick it, then update notes before starting the next one. Correct stale entries with notes(action="update", section, match, text), don't just add contradictions.
5. After a summary or a long gap, or when unsure what was decided: notes(action="read") and the todo list FIRST, then continue from Next steps. Never redo work the notes say is done; verify it quickly instead.
6. Hand-offs (Cursor, another bot, a scheduled run): the receiver sees none of this. Copy the goal, constraints, decisions, file paths and acceptance criteria from your notes into the brief (cursor-task-brief).
7. Before finishing: re-read the Goal and Constraints. Check every acceptance criterion and constraint against what you actually did, with evidence. Run the final verification (tests, typecheck, a re-read of outputs). Then report: goal, what was done, where outputs are, how it was verified, what's left.

## Pitfalls
- Notes written only at the end. A summary can happen at any step.
- Vague entries ("fixed the bug"). Write the file, the cause and the test name.
- Losing the user's mid-task changes. A steer updates Goal/Constraints immediately.
- Retrying a failed approach after a summary because Failed attempts was empty.
- Declaring done against the current step instead of the original goal.

## Example notes
- Goal: Migrate the app's date handling from moment to date-fns; behavior identical; bundle smaller.
- Constraints: No new deps besides date-fns. Don't touch src/legacy/.
- Decisions: Wrap formatting in src/lib/dates.ts so call sites change once.
- Files: src/lib/dates.ts (new); 23 call sites listed in todo item 3.
- State: 15/23 call sites done; npx vitest run green; bundle 412 KB → 371 KB so far.
- Failed attempts: date-fns-tz for zones broke DST tests; use Intl.DateTimeFormat instead.
- Next steps: convert src/reports/*.ts (8 left), then remove moment from package.json (ask first).
