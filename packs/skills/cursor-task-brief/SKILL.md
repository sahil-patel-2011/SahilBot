---
name: cursor-task-brief
description: Write the brief for a Cursor agent hand-off - goal, context, files, errors, constraints, don't-touch list, acceptance criteria, tests - with examples.
source: you
uses: 0
category: Coding
triggers: cursor brief, cursor prompt, brief for cursor, tell cursor, ask cursor to, cursor agent task, cursor background agent, cursor cloud agent, hand off to cursor, delegate to cursor, acceptance criteria, task brief
---

## When
Before any cursor(action="agent" | "cloud_launch" | "cloud_followup"). Cursor sees none of this chat, none of your notes and none of the files you read: the brief is all it knows. Deciding whether to delegate, running it and reviewing the result: coding-cursor-orchestration.

## The template (pass these fields; the tool builds the prompt)
- goal: ONE outcome, stated as what must be true when done. Behavior, where, for whom. Not "improve export" but "`export --json` writes one JSON object per row to stdout; CSV stays the default".
- context: what you already learned, so Cursor doesn't rediscover it: where the code lives and how it connects, the root cause if known, relevant decisions and the user's constraints from your notes (notes(action="read")), versions, gotchas. 3-12 lines.
- files: the files to start with (existing and new). Narrow beats complete.
- errors: the exact failing output (test name, message, first own stack frame). Never paraphrase an error.
- constraints: style rules, "no new dependencies", "keep the public API", "Node 18 support", performance limits.
- dont_change: paths or behavior that must stay as they are ("migrations/", "the CSV format", "tests/fixtures/").
- acceptance: 2-5 checkable criteria, each verifiable by a command, a test or reading a specific spot. Include the unchanged behavior that must still work.
- tests: the commands that must pass (defaults to the project's type check and tests; name a filter for speed plus the full suite).

## Checklist before sending
1. Run cursor(action="prompt", …) first: it lists what the brief is missing and shows your working notes so you can copy what matters. Fix every gap it names.
2. One outcome per brief. Several "and"s, a numbered list of features, or >1 reviewable diff: split it (see Splitting).
3. Every acceptance criterion is checkable without asking you.
4. Everything Cursor needs to decide is written down; anything only the user can decide is decided first.
5. Secrets: never paste keys or tokens; name the env var instead.

## Splitting into Cursor-sized tasks
- Size: one behavior change, 1-8 files, a diff you can review in a few minutes, tests included.
- Order by dependency: schema/types first, then logic, then UI, then docs. Each task leaves the build green.
- Independent pieces (no shared files) can run as parallel cloud agents; dependent ones go one after another, each brief stating what the previous one already did.
- Refactors: separate the mechanical move/rename from behavior changes.

## Follow-ups
- Local: cursor(action="agent", folder, resume: true, goal: "Fix: …", errors: "<exact failures>"). Cloud: cursor(action="cloud_followup", id, goal: …).
- Say exactly what is wrong (file:line, the failing criterion, the output) and what done looks like. The tool restates the first brief's goal and criteria for you.
- Two failed follow-ups on the same point: stop delegating that point; fix it yourself with code(action="edit").

## Example
goal: "Settings → Export gets a 'Include archived' checkbox; when on, exportRows() includes archived rows."
context: "exportRows lives in src/export/rows.ts and filters archived=false at line ~40. The settings form is src/ui/ExportPanel.tsx (React, zod schema in the same file). The user wants it off by default."
files: ["src/export/rows.ts", "src/ui/ExportPanel.tsx", "src/export/rows.test.ts"]
constraints: ["No new dependencies", "Match the existing checkbox component"]
dont_change: ["src/db/", "the CSV column order"]
acceptance: ["Unchecked (default): output identical to today", "Checked: archived rows included, marked archived=true", "A unit test covers both"]
tests: ["npx vitest run src/export", "npx tsc --noEmit"]
