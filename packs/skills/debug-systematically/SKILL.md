---
name: debug-systematically
description: Find a bug's root cause by reproducing, isolating, testing one hypothesis at a time and bisecting, then fix it with a regression test.
source: you
uses: 0
category: Engineering
triggers: root cause, why is this broken, debug this, intermittent bug, heisenbug, git bisect, minimal repro, works on my machine, it used to work, wrong output, race condition, can't reproduce, regression
---

## When
Wrong output, crash, hang, intermittent failure, "it used to work". Decoding an error dump: read-stack-traces. A red test suite: coding-fix-failing-tests. Slowness: performance-profiling.

## Steps
1. Reproduce. Get the exact command, input, environment and full output (run_command; keep the whole trace). Record it in todo notes. No repro: collect runtime/OS versions, lockfile, config, env vars, data and timing, then follow the user's exact steps.
2. Make the repro fast and automatic: a failing test or a tiny script. A 2-second loop beats a 2-minute one.
3. Pin the symptom: expected vs actual, the first bad value, which inputs fail and which pass.
4. Isolate. Halve the input until it stops failing, disable code paths, stub dependencies, run one test alone. Find the boundary where good turns bad.
5. Hypothesize one cause at a time and predict what you'd observe if it were true. Test cheaply: a log of actual values, a breakpoint, an assertion, reading the path. Log each hypothesis and its result in notes so you don't loop.
6. Regressions: find the change. git(action="log", path) and git(action="diff", ref) on suspect files; for a search across commits, via run_command: `git bisect start`, `git bisect bad`, `git bisect good <sha>`, `git bisect run <test command>`, then `git bisect reset`. For dependency regressions, diff the lockfile.
7. Fix the root cause, not the symptom. Keep asking why until the answer is in your logic: not "add a null check" but "why is it null here?".
8. Add a regression test that fails before the fix and passes after. Remove temporary logging.
9. Run the related tests, then the full suite. Explain the cause in 1-2 sentences and why the fix addresses it.

## Instrumentation
- Log at boundaries: inputs, branch taken, outputs, with ids and types (`repr()` in Python; `console.dir(x, { depth: null })` in Node).
- Debuggers: `node --inspect-brk` plus Chrome DevTools, `breakpoint()` / `python -m pdb`, lldb for Swift/Rust/C, dlv for Go.
- Library debug output: `DEBUG=*`, `logging.DEBUG`, `RUST_LOG=debug`, `GODEBUG`.

## Intermittent bugs
- Suspects: shared mutable state, async ordering, timeouts, caches, time zones and DST, locale, random seeds, test order, resource limits.
- Run in a loop until it fails (`for i in $(seq 50); do <cmd> || break; done`), randomize test order, add artificial delays to widen a race window.

## Decision rules
- Three hypotheses failed: stop guessing and widen observation (more logging, git diff of recent changes, read the dependency's source).
- Bug in a dependency: confirm with a minimal repro outside your code, then pin, patch or work around, and tell the user.
- Changed several things at once: revert and reapply one at a time.
- Can't reproduce after real effort: report what you tried, add targeted logging, and say what evidence would settle it.

## Pitfalls
- Fixing before reproducing, so you can't know it's fixed.
- Catching and swallowing the exception.
- Leaving debug prints in the diff.
- Trusting the bug report's diagnosis instead of its symptoms.
