---
name: monorepo-workflow
description: Works inside monorepos - finds the right package, runs scoped and affected-only tasks, keeps package boundaries clean, versions with changesets.
source: you
uses: 0
category: Coding
triggers: monorepo, turborepo, turbo.json, pnpm workspace, pnpm --filter, nx affected, yarn workspaces, npm workspaces, cargo workspace, go.work, gradle multi-project, changesets, workspace protocol, internal package, tsconfig project references, shared eslint config
---

## When
The repo has several packages/apps with a workspace file. Signs: `pnpm-workspace.yaml`, `"workspaces"` in root package.json, `turbo.json`, `nx.json`, `[workspace]` in Cargo.toml, `go.work`, `settings.gradle(.kts)` with `include(...)`.

## Steps
1. Map it: code(action="project"), then read the workspace file and list packages with their names (the `name` field, not the folder). `pnpm ls -r --depth -1`, `npx nx show projects`, `cargo metadata --no-deps`, `go work edit -json`.
2. Find the owning package of the file you're changing (nearest package.json/Cargo.toml/go.mod/build.gradle) and its dependents.
3. Run commands for that package only, from the root with the tool's filter (table below). Running a bare `npm test` at the root may run everything or nothing.
4. Before finishing, run affected-only checks to catch breakage in dependents.
5. If a published package changed, add a changeset.

## Scoped and affected commands
| Tool | One package | Affected since main |
|---|---|---|
| pnpm | `pnpm --filter @acme/api test` | `pnpm --filter "...[origin/main]" test` |
| npm | `npm test -w @acme/api` | (use turbo/nx) |
| yarn | `yarn workspace @acme/api test` | `yarn workspaces foreach --since run test` |
| Turborepo | `turbo run test --filter=@acme/api` | `turbo run test --filter=...[origin/main]` |
| Nx | `nx test api` | `nx affected -t test --base=origin/main` |
| Cargo | `cargo test -p api` | (script over changed crates) |
| Go | `go test ./services/api/...` | (changed module dirs) |
| Gradle | `./gradlew :api:test` | (build scan / dependency graph plugin) |
Add `...` before a filter to include dependents, after it to include dependencies (`@acme/ui...`).

## Boundaries
- Packages import each other only by package name through the public entry (`exports` in package.json / `pub` API / exported Go package). Never `../../other-pkg/src/x`, never deep imports into another package's internals.
- Declare every internal dependency in the consumer's manifest (`"@acme/ui": "workspace:*"`). Undeclared deps work by hoisting luck and break in CI or Docker.
- Enforce layering (apps -> features -> shared libs, never the reverse) with Nx tags/`@nx/enforce-module-boundaries`, eslint `no-restricted-imports`, or dependency-cruiser. No cycles.
- Shared config lives in packages: `@acme/tsconfig` (base.json extended per package), `@acme/eslint-config`, shared prettier. Packages extend them rather than copying.
- TypeScript: use project references (`composite: true`) or build internal packages; don't paper over with `paths` aliases pointing into other packages' `src` unless the toolchain is designed for it.

## Versioning
- Changesets: `pnpm changeset` per user-facing change (patch/minor/major per package), `changeset version` bumps and writes changelogs, `changeset publish` releases. Private apps don't need versions.
- Pick fixed (all packages share a version) or independent versioning and stay consistent.

## Pitfalls
- Installing a dependency in the root instead of the package that uses it (`pnpm add zod --filter @acme/api`).
- Stale build outputs of internal packages making tests pass locally; run the build pipeline (`turbo run build`) before testing dependents.
- Turbo/Nx cache hits hiding changes because `inputs`/`outputs` or env vars aren't declared in the task config.
- Multiple versions of React or another singleton across packages; check with `pnpm why react`.

## Verify
Scoped tests pass for the changed package; affected-only typecheck/test/build pass from the root; `git diff` shows manifest and lockfile changes only where intended.
