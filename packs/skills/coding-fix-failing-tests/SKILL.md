---
name: coding-fix-failing-tests
description: Turn a red test run or type-check into green with root-cause fixes, one failure at a time.
source: you
uses: 0
category: Coding
triggers: failing test, tests are failing, test failure, red tests, typecheck errors, tsc errors, make the tests pass, fix the build, broken build
---

1. Run code(action="run_tests") (or typecheck/lint). The result lists failures as file:line - test - message and suggests the first step.
2. Take the first failure. Read the test at that line and the code it exercises (code read with start/end around the line; symbols to jump to definitions).
3. Decide what's wrong: the code (most often), the test's expectation (only if the requirement changed - say so), or the environment (missing dependency, env var, network). Read the whole error, including "expected/received" and the stack's first frame in project code.
4. Make the smallest fix with code edit. Don't special-case the test input, catch-and-ignore errors, add sleeps, or skip/delete tests.
5. Rerun just that test: run_tests(filter = test name or file). Repeat until it passes.
6. Then run the full suite and typecheck: fixes can break other things. Many failures with one cause (an import error, a type change) usually clear together.
7. Stuck after 3 attempts on one failure: stop and re-read more broadly (git log -p for the file, git diff for recent changes), or explain the blocker to the user with what you tried.
8. Report which tests were failing, the root cause, the fix, and the final passing run's summary line.
