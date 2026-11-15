---
name: refactor-safely
description: Restructure code without changing behavior - pin it with characterization tests, take tiny tool-assisted steps, one kind of change per commit.
source: you
uses: 0
category: Engineering
triggers: refactor, clean up this code, extract function, rename everywhere, characterization tests, strangler fig, restructure, split this file, remove duplication, tech debt, move to a module, simplify this function, decouple
---

## When
Improving structure (names, modules, duplication, coupling) with zero behavior change. If behavior must change too, refactor first, commit, then change behavior (plan-a-code-change).

## Steps
1. State the target shape and the reason in one sentence ("split the 1,200-line sync.ts into transport, queue and retry so retry can be tested").
2. Safety net: run the area's tests, code(action="run_tests", filter). Make sure they exercise the code: break a line on purpose, watch a test fail, restore. Thin coverage: add characterization tests that call the code with representative and edge inputs and assert whatever it returns today, odd results included. Golden files or snapshots suit large outputs.
3. Baseline: tests green, code(action="typecheck") clean, git(action="status") clean or your other work stashed. Commit the new tests on their own.
4. Take tiny behavior-preserving steps: rename, extract function or variable, inline, move, change signature, replace a conditional with a table or polymorphism, delete dead code. After each: typecheck plus filtered tests. Red means undo that step, not debug forward.
5. Prefer mechanical tools to hand edits: LSP or IDE rename, compiler errors as the to-do list after a signature change, codemods (jscodeshift, ts-morph, comby), `ruff --fix`, `cargo fix`, gopls rename. Before renaming or moving, search every reference, including strings, dynamic imports, config, docs and mocks: code(action="search", pattern).
6. One kind of change per commit: "Rename X to Y", "Move parser to lib/parse", "Extract retry policy". Never mix with formatting or behavior changes, so each commit is verifiable in seconds.
7. Finish with the full suite, typecheck, lint and build if present. Summarize what moved where and state that behavior is unchanged.

## Big refactors: strangler pattern
- Build the new module beside the old one; move callers over one at a time (adapter or feature flag); delete the old path once it has no callers.
- Every commit stays green and mergeable on its own.
- For risky logic, run old and new side by side and compare outputs before switching.

## Decision rules
- No tests and none cheap to add: restrict yourself to tool-driven mechanical changes and tell the user the risk.
- Public names: keep the old export as a deprecated alias for a release.
- A step that requires changing a test's expected value is not a refactor; stop and reconsider.
- Stop when the stated goal is met.

## Pitfalls
- "While I'm here" behavior fixes inside a refactor commit.
- Moving and editing a file in the same commit; git loses rename detection and the diff becomes unreadable.
- Missing string-based references (route names, DI keys, serialized fields, reflection).
- Refactoring code the user didn't ask about.
