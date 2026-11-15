---
name: test-first-development
description: Drive changes with tests - red-green-refactor, reproduce bugs as failing tests first, pick the right test level, keep tests fast and deterministic.
source: you
uses: 0
category: Coding
triggers: tdd, test-driven, test first, red green refactor, write the test before, unit or integration test, what should i test, add unit tests, mock vs stub, test pyramid, failing test that reproduces, test fixtures
---

## When
New behavior, bug fixes, and logic changes in code that has tests or should. A suite that is already red: coding-fix-failing-tests. Pure restructuring: refactor-safely. Browser end-to-end: playwright-testing.

## Loop
1. Pick the smallest next behavior. Write one test that states input and expected output in the domain's words.
2. Run it: code(action="run_tests", filter="<test name>"). It must fail, and for the right reason: the assertion about the behavior, not an import error or typo. A test you never saw fail proves nothing.
3. Write the least code that passes. Hard-coding one case is fine; the next test forces generality.
4. Rerun the filtered test, then the file: green.
5. Refactor code and tests under the safety net (names, duplication, extraction); stay green after each step.
6. Next case: empty, boundary, error path, large input, unicode, concurrent calls if relevant.
7. Finish with the full suite and code(action="typecheck").

## Bugs: reproduce first
- Write a test that fails exactly as reported (same input, same wrong output or exception), then fix. It stays as the regression guard; name it for the behavior, not the ticket number.
- Legacy code without tests: first add characterization tests that record today's behavior, then change it.

## Which level
- Unit: pure logic, parsing, calculations, branching. Milliseconds, many.
- Integration: your code with a real DB (SQLite or a test container), filesystem, the HTTP handler stack, serialization. Use for queries, migrations, request validation.
- End-to-end: only a few critical journeys; slow and brittle.
- Contract/snapshot: API shapes between components; snapshot only small, stable output and read snapshot diffs.
Rule: test at the lowest level that can catch the bug, plus one higher-level test proving the wiring.

## Test doubles
- Mock only at boundaries you don't own: network, clock, randomness, payment or email APIs. Prefer simple fakes (in-memory repository) over deep mock chains.
- Inject time and randomness (pass `now`, seed the RNG) instead of sleeping.
- Never mock the unit under test or assert on private internals; assert outputs and observable effects.

## Good test checklist
- One behavior per test; arrange, act, assert readable at a glance.
- Deterministic: no real network, no wall clock, no order dependence, no shared mutable state.
- Failure message says what broke (expected vs actual).
- Same framework, folder and naming as the repo (match-code-style).

## Example (pytest)
```
def test_parse_duration_accepts_minutes():
    assert parse_duration("90m") == timedelta(minutes=90)

def test_parse_duration_rejects_negative():
    with pytest.raises(ValueError, match="negative"):
        parse_duration("-5m")
```
Run, watch both fail, implement, watch both pass, then add "1h30m".

## Pitfalls
- Writing tests after the code and bending them to match its bugs.
- Tests that still pass with the implementation deleted (they only check mocks).
- Weakening an assertion or adding a skip to get green.
- Huge fixtures nobody can read; build data with small factories.
