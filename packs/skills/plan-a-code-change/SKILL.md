---
name: plan-a-code-change
description: Plan a non-trivial code change - acceptance criteria, every touch point, smallest design, ordered todo steps, risks and rollback - before editing.
source: you
uses: 0
category: Coding
triggers: implementation plan, plan this change, scope the change, touch points, blast radius, which files need to change, rollback plan, before i start coding, break this into steps, design the change, impact analysis, risky change
---

## When
Anything beyond one obvious edit: a feature, a behavior change, a cross-module fix, renaming something public. Read codebase-orientation first if the area is new; execute with coding-agent-loop.

## Steps
1. Restate the goal as acceptance criteria: inputs, expected outputs, what must not change. Ask the user only about choices that change the design, never about facts you can look up.
2. Locate the core: code(action="search") for the feature's words, code(action="symbols", name) for the main functions and types.
3. Enumerate every touch point. For each symbol you will change, search for:
   - callers and implementers, including string and dynamic uses (route names, event names, DI keys, reflection, serialized field names)
   - tests, fixtures and snapshots that pin it
   - types and schemas: TS types, Pydantic models, protobuf/OpenAPI, DB schema and migrations
   - config: env vars, feature flags, settings files, CI, Dockerfile
   - docs and comments that will become false
   - outside consumers: other monorepo packages, public API users, old app versions, stored data
4. Pick the smallest design that meets the criteria. Extend an existing pattern before inventing an abstraction; prefer additive changes (new optional parameter, new endpoint) over changing a signature with many callers. Note the one alternative you rejected and why.
5. Order work so every step leaves the build green: types/schema, then core logic with tests, then callers, then docs. Keep refactor steps separate from behavior steps (refactor-safely).
6. Write it with todo(items, notes): one item per verifiable step, naming files and the proving check (test name or command). Put acceptance criteria, the touch-point list and the commands in notes.
7. Risks and rollback: what could break (data, compatibility, performance, security), how you'd notice, how to undo (revert commit, flag off, down migration). Flag irreversible steps (data deletion, applied migrations, public API removal) to the user before doing them.
8. Share the plan in a few lines, then proceed unless the user asked to approve first.

## Decision rules
- More than ~10 files or 2 subsystems: propose separately mergeable pieces.
- Public API or persisted format changes need a compatibility path (api-design, database-schema-migrations).
- If you can't say how a step will be verified, it is too vague; split it.
- Unsure how existing code behaves: spike first (read, or a scratch script) before fixing the design.
- Run the relevant tests before changing anything, so you have a baseline.

## Example todo
1. Add `timezone` to UserSettings type and schema (src/types/user.ts, migrations/) - typecheck
2. Use it in formatDate (src/lib/date.ts) with tests for UTC, America/Chicago, missing - run_tests date
3. Update the 3 callers found by searching `formatDate(` - typecheck
4. Settings UI field plus test - run_tests settings
5. README config table - reread
Risk: old clients omit the field -> default UTC. Rollback: revert; the column is nullable, so no down migration is needed.

## Pitfalls
- Searching only the exact symbol and missing dynamic or string references.
- Planning a rewrite when a 20-line change works.
- Forgetting tests, docs and config as touch points.
- Plans with steps like "update logic" that name no file and no check.
