---
name: code-review
description: Review a diff or PR for correctness, edge cases, error paths, concurrency, compat and tests; report verified, severity-ranked findings by line.
source: you
uses: 0
category: Engineering
triggers: review my, review this code, review this pr, review my diff, code review, look over my changes, pr feedback, before i merge, review the pull request, second pair of eyes, critique my code, check my changes, review uncommitted changes
---

## When
Someone wants a diff, branch or PR reviewed, or you finished a large change of your own. Deep audit: security-review. Pure style: match-code-style. Review means report; edit only if asked.

## Steps
1. Get the change: git(action="diff", stat=true), then git(action="diff") (ref for a branch; git(action="pr_view") and git(action="pr_diff", pr) for GitHub). Over ~500 changed lines: go file by file and say so.
2. Learn the intent: PR description, commit messages, linked issue. Write the intended behavior in one sentence and review against it.
3. Read whole functions and their callers around each hunk with code(action="read"). Many bugs live in what the diff didn't change.
4. Check in this order:
   - Correctness: does it do what it claims for every input? Off-by-one, inverted condition, wrong variable, missing await, mutating shared input, float, integer and timezone math.
   - Edge cases: empty, null/None, zero, negative, huge, unicode, duplicates, first run with no data.
   - Error paths: broad or swallowed catches, partial failure leaving state inconsistent, missing cleanup (finally, defer, close), retries without idempotency, unhelpful messages.
   - Concurrency: races on shared state, check-then-act, missing transactions or locks, unbounded parallelism, async inside forEach.
   - Security: untrusted input into SQL, shell, HTML, paths or URLs; authorization on new endpoints; secrets in the diff.
   - API and compatibility: changed signatures, response shapes, schema, config keys, defaults; all callers and older clients handled; migration included?
   - Tests: cover the new behavior and its failure modes; would they fail if the code were wrong? Run them: code(action="run_tests", filter).
   - Simplicity: dead code, duplication, one-use abstractions, a helper that already exists.
   - Naming and comments: names say what, comments say why. Keep these short.
5. Verify every finding: trace it with concrete values, write a tiny failing test or script, or cite the line that proves it. Drop it or label it a question if unconfirmed.
6. Report.

## Report format
Most severe first; each with severity, file:line, the failure (concrete input -> bad result) and a suggested fix.
- Blocker: wrong results, data loss, security hole, crash on a common path.
- Major: edge-case bug, compat break, risky logic without tests.
- Minor: clarity, small simplification.
- Nit: optional, a few at most.
Close with one line on what's good, what you ran (tests, typecheck) and what you did not check.

## Example
`[Major] src/sync/queue.ts:88` - `items.forEach(async i => await send(i))` doesn't wait, so `flush()` resolves before sends finish and quitting the app drops messages. Fix: `for (const i of items) await send(i)` or `await Promise.all(items.map(send))`.

## Pitfalls
- Reviewing only the hunks.
- Twenty nits burying the one real bug.
- Reporting a bug you didn't trace.
- Redesigning the author's approach to taste; ask about the why instead.
