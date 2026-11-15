---
name: legacy-code-migration
description: Migrates legacy code incrementally - inventory, seams, characterization tests, strangler fig, flags, upgrades, data migrations and rollback plans.
source: you
uses: 0
category: Coding
triggers: legacy code, migrate from, migrate the whole, port the codebase, switch to, migrate the codebase, switch from, replace the library, strangler fig, characterization test, golden master test, codemod, framework upgrade, major version upgrade, python 2 to 3, rewrite vs refactor, data migration, backfill, dual write, shadow traffic, parallel run, deprecation plan, monolith migration
---

## When
Replacing or modernizing code that works in production but is hard to change: a framework or language upgrade, moving off a library, splitting a monolith, changing a data store. Small in-place cleanups: read refactor-safely.

## Steps
1. Inventory: entry points (routes, jobs, CLIs), external contracts (APIs, file formats, DB tables other teams read), dependencies and versions, dead code (no callers, no traffic). Record it in todo notes.
2. Find seams: places where you can swap behavior without editing callers (an interface, a module boundary, an HTTP route, a DI binding). If there is none, create one first with a pure refactor.
3. Pin behavior with characterization tests: run the current code on real-ish inputs and assert what it does today, bugs included. Golden master = save outputs to files and diff. These tests define "no regression".
4. Pick the strategy (rules below) and slice the work into steps that each ship independently.
5. Migrate one slice behind a flag or adapter; deploy dark; compare; ramp; delete the old path.
6. Repeat; keep a written rollback for every step.

## Decision rules
- Prefer strangler fig over a big-bang rewrite: route one endpoint/feature at a time to the new implementation via a facade; the old system keeps serving the rest.
- If behavior is poorly understood, parallel run: call both old and new, return old, log diffs. Ship when the diff rate is ~0 for a representative period.
- If an interface must change, add an adapter so old callers keep working, migrate callers, then remove the adapter.
- If a rewrite is truly needed (dead platform), still deliver it in slices with characterization tests as the acceptance criteria.

## Framework and language upgrades
- One major version at a time; read each version's migration guide and changelog.
- Get to zero deprecation warnings on the current version before jumping.
- Use official codemods/automated tools first (e.g. `npx @next/codemod`, `pyupgrade`, `2to3`, OpenRewrite, `go fix`), review their diff, then fix the rest by hand.
- Upgrade the toolchain (runtime, compiler, test runner) in its own commit, separate from code changes.
- Keep the lockfile diff reviewable; upgrade transitive deps deliberately.

## Data migrations
- Expand / migrate / contract: add the new column or table (nullable), dual-write from the app, backfill in batches (idempotent, resumable, throttled, e.g. 1,000 rows per batch), verify counts and checksums, switch reads, stop writing old, drop old later.
- Never rename or drop in the same deploy that stops using it; old app versions still run during rollout.
- Take a backup or snapshot before destructive steps and test the restore.

## Rollback plan (write it before each step)
What flag or deploy reverts it, how long it takes, what data written by the new path needs to be reconciled, and who decides. If a step cannot be rolled back, call that out and get explicit sign-off.

## Pitfalls
- Changing behavior and structure in the same commit, so diffs in outputs can't be attributed.
- "Fixing" bugs that downstream consumers rely on without telling them.
- Leaving both paths alive forever; set a removal date for every flag.
- Migrating untested code without first writing characterization tests.

## Verify
Characterization suite green on old and new; parallel-run diff report near zero; metrics (errors, latency) flat after each ramp step; rollback rehearsed once in staging.
