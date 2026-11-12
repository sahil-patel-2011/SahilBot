---
name: debug-systematically
description: Find the real cause of a bug, failing test or crash instead of guessing.
source: you
uses: 0
category: Engineering
---

1. Reproduce it first. Get the exact command and the full error (`run_command`, keep the whole stack trace). If it doesn't reproduce, collect versions, inputs and environment.
2. Read the stack trace bottom-up to the first frame in this project's code; open that file with `file_read`.
3. Form one hypothesis at a time and test it cheaply: add a log/print, run a minimal script, or check a value. Never change several things at once.
4. Narrow down: `git log -p -- <file>` / `git bisect` for regressions; shrink the input until it's minimal.
5. Fix the cause, not the symptom. Add or update a test that fails before the fix and passes after.
6. Run the full relevant test suite to make sure nothing else broke, then explain the cause in one or two plain sentences.
