# Skills

Skills are procedures written down so the agent follows them instead of rediscovering them. Each is a folder with a `SKILL.md`. Built-in packs ship in `packs/skills/` (read-only). Yours and learned ones live in the data folder; one with the same name as a built-in replaces it.

## Format

```
---
name: read-stack-traces
description: Decode stack traces and crash logs in JS/TS, Python, ... - find the first own frame, caused-by chains, source maps.
source: you
uses: 0
category: Coding
triggers: stack trace, traceback, exception at line, caused by, segfault, panic at
---

## When
...
## Steps
...
```

- `name`: the folder name (lowercase, dashes).
- `description`: one line, 150 characters or less, saying what the skill does and when to use it. Start with a verb. It is what the selector and the model read first.
- `category`: groups the index (Coding, Engineering, Mechanical Engineering, Electrical Engineering, FRC Programming, FRC Design, Office, Email, Business, Medical, Research, Mac Apps, …).
- `triggers` (optional, recommended): 8-16 comma-separated phrases a user would actually type. Use jargon, tool and file names (`cargo`, `tsconfig`, `h7/g6`, `idempotency key`). Multi-word phrases score higher. Avoid words that fit everything ("code", "fix", "help", "app"), and don't reuse another skill's distinctive phrases.
- Body: 1,800-4,000 characters of dense, expert steps. Use `## When`, `## Steps` or `## Checklist`, `## Decision rules`, `## Pitfalls`, `## Verify`, and an `## Example`. Name SahilBot's tools exactly (`code(action="run_tests")`, `notes(action="add")`). Point to related skills by name.

## How skills reach the model

1. **Index (system prompt, cached).** Your skills appear with their descriptions. Built-in packs appear as names grouped by category, with families folded (`frc-code-{autonomous, swerve, vision}`). Small windows get only the topics.
2. **Per-request suggestions (the `<context>` block).** `SkillStore.suggest()` ranks every skill against the request that opened the run and pins the result to that message:
   - `## Skills that fit this request`: the top 5 (3 on small windows), one line each.
   - On big windows, the best skill's steps are inlined under `## Skill <name>` when it is a clear winner. Its headings are tagged with the skill name. The whole suggestion stays within about 4,800 characters (about 1.2K tokens), and a longer body is cut at a section boundary with a pointer to `read_skill`.
   - Small windows (the compact and chat prompts) get at most about 420 characters and never an inlined body.
   - Lines the model has already seen in this chat aren't repeated.
3. **On demand.** `memory(action="read_skill", name)` returns the whole body.

## Ranking (src/main/skills.ts `rankSkills`)

- Words are lowercased and lightly stemmed, and tech names are normalized (`Next.js` becomes `nextjs`, `C++` becomes `cpp`). Each word is weighted by IDF across all skills, so rare words like "wpilib" or "idempotency" count far more than "design".
- Scoring:
  - Trigger phrase hits score most (multi-word ×1.6), then name words (×1.3), description words (×0.7) and category words (×0.5).
  - A skill with triggers gets ×1.25 when one hits and ×0.8 when none do.
- Context:
  - In a code project or on a code-looking request, coding skills rank higher and non-technical ones lower.
  - The project folder's files name the stack (`Cargo.toml` → rust-project, `pyproject.toml` → python-project, `build.gradle` → java-kotlin-wpilib, `Package.swift`/`.xcodeproj` → swift-ios-app, `pnpm-workspace.yaml` → monorepo-workflow). That playbook is always kept in the list.
  - A code change in a project boosts coding-agent-loop.
  - "cursor" boosts cursor-task-brief and coding-cursor-orchestration.
  - Long-task wording boosts long-task-working-notes.
  - FRC packs need a robotics word to rank high. Code words favor `frc-code-*` and mechanism words favor `frc-design-*`.
- Filtering: a result needs a score of at least 3 and at least 40% of the best score. Your own skills get ×1.1 on ties. Untrusted learned skills are never suggested.
- The catalog is cached until a skill file changes.

Tests: `tests/unit/skills-selection.test.ts` checks:
- 58 example requests across coding, stacks, Cursor, long tasks, engineering, FRC and other domains;
- small talk gets no suggestions;
- the stack is detected from the project folder;
- every built-in skill is found from its own description (at least 92% overall and 75% per domain);
- the size budgets hold.

## Coding and engineering packs

- **Coding core:** coding-agent-loop, codebase-orientation, plan-a-code-change, match-code-style, test-first-development, writing-great-tests, debug-systematically, read-stack-traces, coding-fix-failing-tests, performance-profiling, security-review, code-review, refactor-safely, legacy-code-migration, api-design, backend-services, database-schema-migrations, dependency-hygiene, git-workflow, coding-commit-and-pr, ci-pipeline, devops-cicd-iac, docker-and-deploy, observability, concurrency-async, monorepo-workflow, reading-library-source, write-docs-readme, algorithms-problem-solving, llm-app-engineering.
- **Stacks:** typescript-project, react-frontend, web-app-engineering, new-web-app, python-project, python-script, data-ml-engineering, python-data-analysis, swift-ios-app, mobile-apps, java-kotlin-wpilib, rust-project, go-project, sql-queries, shell-scripting, playwright-testing, api-integration.
- **Cursor:** cursor-task-brief (the brief template, splitting, follow-ups), coding-cursor-orchestration (delegate or not, run, review, iterate), cursor-coding-handoff (the quick path).
- **Long tasks:** long-task-working-notes. It covers the `notes` tool sections, milestone updates, re-reading after summaries and restating the goal before finishing.
- **Engineering:**
  - Core: mechanical-design-process, fits-and-fasteners, design-for-manufacturing, electrical-basics, systems-engineering, engineering-calculations, engineering-report.
  - Specialized: stress-and-strength, tolerance-stackup, material-selection, thermal-analysis, gdt-drawings, circuit-analysis, power-supply-design, pcb-design-review, component-selection, signal-processing, embedded-firmware, electrical-safety-codes.
  - FRC: frc-design-* and frc-code-*.
  - CAD (owned with the onshape tool): cad-onshape-api, frc-design-onshape, cad-workflow.

## The Cursor hand-off (src/code/cursor.ts, the cursor tool)

- **Brief:** `cursor(action="prompt", …)` builds the brief from these fields: goal, context, files, errors, constraints, dont_change, acceptance and tests.
  - `briefGaps` lists what is missing: a vague goal, several tasks in one, no acceptance criteria, no files or context, no verify commands, no error output for a fix, or working notes not copied into the context.
  - The result also shows the chat's working notes, so the user's constraints and the decisions so far get copied into the brief.
- **Rules added to every brief:** never weaken tests to pass; stop and say what's needed when blocked; keep a checklist on multi-step work and re-check every criterion before finishing.
- **Follow-ups:** the first brief is remembered per folder (local) and per agent id (cloud). A follow-up or resumed run restates its goal and criteria under "Original goal (still applies)", and the approval card shows this too.
- **Automatic review:** when Cursor reports done (local `agent`, and `cloud_review` with the PR diff), `reviewCursorChange` checks the diff against the brief. It looks at:
  - files outside the brief's files, and protected paths that changed;
  - removed or skipped tests, and suppressed type or lint checks;
  - debug output and TODOs;
  - dependency or lockfile changes;
  - the size of the diff, and whether tests are missing;
  - the results of the checks.

  Then it lists each acceptance criterion as a checkbox that needs evidence, and gives a ready follow-up.
