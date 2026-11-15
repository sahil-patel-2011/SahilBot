---
name: writing-great-tests
description: Writes fast, deterministic, meaningful tests - picks the right level, uses fixtures and factories, mocks only at boundaries, fixes flaky tests.
source: you
uses: 0
category: Coding
triggers: flaky test, test pyramid, testing trophy, unit vs integration, test fixtures, test factory, mock vs stub, over-mocking, freeze time in tests, snapshot test, code coverage, test isolation, test naming, contract test, testcontainers, test doubles
---

## When
Adding tests, deciding what kind to write, or making a suite reliable. Writing the test before the code: test-first-development. Browser end-to-end tests: playwright-testing. Fixing currently failing tests: coding-fix-failing-tests.

## Pick the level
| Level | What it proves | Speed | Use for |
|---|---|---|---|
| Unit | one function/class logic | ms | pure logic, edge cases, algorithms, parsers |
| Integration | your code + real DB/queue/filesystem/HTTP layer | 100 ms-s | queries, repositories, handlers, serialization |
| E2E | the whole system through the UI or public API | s-min | a few critical user journeys (sign up, checkout) |
Pyramid: many unit, fewer integration, few e2e. Trophy (web apps): weight toward integration, because that's where most real bugs are. Either way, e2e stays small and critical-path only.

## Steps
1. Name the behavior, not the method: `rejects_expired_coupon`, `returns_404_when_order_missing`. A failing test name should read like a broken spec.
2. Arrange-Act-Assert, one behavior per test; assert on outputs and observable effects, not internal calls.
3. Build data with factories (`makeUser({ role: "admin" })`, factory_boy, fishery) that fill valid defaults; override only what the test cares about.
4. Fixtures for expensive setup (DB, server), scoped carefully; each test still creates its own rows.
5. Run the new test, watch it fail for the right reason (break the code briefly), then pass.

## Isolation and determinism
- No shared mutable state between tests; order must not matter (run with random order: `pytest -p randomly`, `vitest --sequence.shuffle`).
- DB: wrap each test in a transaction and roll back, or truncate; use a real engine (Testcontainers) rather than SQLite standing in for Postgres.
- Time: inject a clock or freeze it (`freezegun`, `vi.useFakeTimers()`, `jest.setSystemTime`). Never `sleep` to wait; wait for a condition.
- Randomness: seed it or inject the generator.
- Network: no real external calls; stub at the HTTP boundary (msw, nock, responses, WireMock) or use contract tests.

## Mocking rules
- Mock only at boundaries you don't own or that are slow/non-deterministic: payment APIs, email, clock, external HTTP.
- Don't mock your own modules to test their callers; that tests the mock and breaks on every refactor.
- Prefer fakes (in-memory repo) over mocks with call assertions. If a test needs 5 mocks, the design needs a seam.

## Flaky tests
1. Reproduce: run it 100x alone and in the full suite (`--count`, `--repeat-each`, `-count=100`).
2. Classify: timing/async (missing await, fixed sleeps), shared state/order dependence, real time or timezone, randomness, external service, resource limits in CI.
3. Fix the cause; quarantine with a ticket only as a short-term measure. Retries hide bugs.

## Pitfalls
- Snapshot tests of large output: reviewers rubber-stamp updates. Keep snapshots small and stable, or assert specific fields.
- Chasing coverage numbers. Coverage shows untested code; it doesn't prove tested code is checked. Look at uncovered branches in changed files, not the global percent.
- Tests that assert implementation details (private methods, exact SQL strings).
- Giant shared fixtures where nobody knows which fields matter.

## Verify
New tests fail when the behavior is broken and pass when fixed; suite passes in random order and 10x in a row; runtime of the unit suite stays under a minute.

## Example
```ts
it("rejects an expired coupon", () => {
  const clock = fixedClock("2026-01-02");
  const coupon = makeCoupon({ expiresAt: "2026-01-01" });
  expect(applyCoupon(cart(), coupon, clock)).toEqual({ ok: false, reason: "expired" });
});
```
