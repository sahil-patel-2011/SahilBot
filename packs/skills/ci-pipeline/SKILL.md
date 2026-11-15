---
name: ci-pipeline
description: Set up and fix GitHub Actions CI - read failing logs, reproduce locally with the same versions, caching, matrices, flaky tests, env and secret gaps.
source: you
uses: 0
category: Coding
triggers: github actions, ci is failing, workflow yaml, gh run view, passes locally but fails in ci, flaky test, actions cache, build matrix, continuous integration, pipeline red, .github/workflows, ci setup, required status check
---

## When
Creating CI, or a CI job is red. Failures that also happen locally: coding-fix-failing-tests too. Branch and PR mechanics: git-workflow.

## Fixing a red run
1. Find it: `gh run list --branch <b> -L 5`, `gh run view <id>` (jobs, steps), `gh run view <id> --log-failed` (failed steps only); for a PR, `gh pr checks`. Start at the first error, not the last line.
2. Classify: code or test failure, environment difference, infrastructure (network, rate limit, runner), or flake.
3. Reproduce locally with the workflow's exact commands and versions: read runs-on, setup-node/setup-python versions, env, working-directory and each run line. Use CI install modes (`npm ci`, `--frozen-lockfile`, `uv sync --locked`) and set `CI=true` (disables watch mode, stops snapshot writes).
4. Usual environment gaps:
   - Runtime version drift: pin in .nvmrc or .python-version and use `node-version-file: .nvmrc`.
   - Case-sensitive Linux filesystem (`./Utils` vs utils.ts passes on macOS only).
   - Missing env vars or secrets (fork PRs get none), UTC timezone and C locale, no display for browsers, fewer CPUs, files present locally but gitignored.
   - Lockfile out of sync with the manifest.
5. Fix the cause, push (asks the user), then follow: `gh run watch <id>`. For infra flukes only, `gh run rerun <id> --failed`.

## Flaky tests
- Confirm: loop the test locally, rerun in CI, check history with `gh run list`.
- Causes: order dependence, shared state, sleeps and real time, real network, unawaited promises, port collisions, timeouts tight for slow runners.
- Fix the test (inject the clock, await properly, isolate state). Quarantine with an issue link only with the user's OK; blanket retries hide real bugs.

## Setting up
```
name: ci
on:
  push: { branches: [main] }
  pull_request:
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
permissions: { contents: read }
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: npm run lint && npm run typecheck && npm test
```
- Run the same scripts developers run, and run them locally before pushing.
- Caching: the setup-* `cache:` input or actions/cache keyed on the lockfile hash; cache dependencies, not outputs you then trust.
- Matrix only for versions and OSes you support: `strategy: { fail-fast: false, matrix: { node: [20, 22], os: [ubuntu-latest, macos-latest] } }`.
- Secrets live in repository or environment secrets as `${{ secrets.NAME }}`, never echoed; minimal permissions; pin third-party actions to a tag or SHA.
- macOS runners cost more; reserve them for macOS builds (Electron or Swift signing).

## Pitfalls
- Pushing ten blind workflow edits instead of reproducing locally (or with `act`).
- Raising timeouts to hide a hang.
- `pull_request_target` that checks out PR code, exposing secrets.
