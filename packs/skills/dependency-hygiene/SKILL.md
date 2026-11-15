---
name: dependency-hygiene
description: Choose, add, pin, audit, upgrade and remove dependencies safely - need, upkeep, license, size, CVEs, lockfiles - installing only with user approval.
source: you
uses: 0
category: Coding
triggers: add a dependency, npm package, add this package, new dependency, write it myself, add a library, which library should i use, npm audit, pip-audit, cargo audit, lockfile, package-lock.json, upgrade dependencies, outdated packages, dependabot, vulnerable dependency, unused dependencies, license check, pin versions, peer dependency conflict
---

## When
Considering a new package, upgrading, answering an audit warning, or pruning unused deps. In SahilBot, installs and network commands ask the user; never install or upgrade without their yes, and say exactly what will be installed and why.

## Before adding
1. Need: can the standard library or an existing dependency do it (fetch, URL, crypto.randomUUID, structuredClone, pathlib, dataclasses, itertools)? A 10-line helper beats a dependency for trivial code.
2. Already present? Search the manifests and lockfile; reuse it at that version.
3. Health: recent releases and commits, issue responsiveness, maintainer count, downloads, known adopters. Archived or abandoned: no.
4. License: MIT, BSD, Apache-2.0, ISC are usually fine; GPL, AGPL, SSPL or no license need the user's decision for distributed or closed-source apps.
5. Footprint: install size and transitive deps (`npm view <pkg> dependencies`, bundlephobia for frontend), native builds (node-gyp, Rust toolchain), platform support (Electron's Node ABI, Apple Silicon wheels).
6. Security: advisories (GitHub Advisory DB, OSV), install scripts (postinstall), typosquats (check the exact name and publisher).
7. Propose: package@version, why, alternatives, size, license. After a yes, install with the manager the lockfile implies: package-lock.json -> npm, pnpm-lock.yaml -> pnpm, yarn.lock -> yarn, bun.lock -> bun, uv.lock / poetry.lock / requirements.txt, Cargo.lock, go.sum.
8. Dev-only tools go in devDependencies or a dev group.

## Lockfiles and pinning
- Commit lockfiles for apps. Libraries publish ranges but still lock for CI.
- CI installs exactly: `npm ci`, `pnpm install --frozen-lockfile`, `uv sync --locked`, `pip install --require-hashes -r requirements.txt`, `cargo build --locked`.
- No `*` or `latest`. Don't hand-edit lockfiles; resolve lockfile conflicts by regenerating from the merged manifest.

## Upgrades
1. List: `npm outdated`, `pip list --outdated`, `cargo outdated`, `go list -u -m all`.
2. One package (or one tightly coupled group) per change; read the changelog or migration guide for majors.
3. Typecheck, tests and build after each; commit separately so a bad upgrade is one revert.
4. Batch patch/minor bumps only when tests are strong; majors go alone.

## Audits
- `npm audit --omit=dev`, `pnpm audit`, `pip-audit`, `cargo audit`, `govulncheck ./...`, `osv-scanner`.
- Triage each: is the vulnerable code reachable, is it dev-only, is a fixed version out? Upgrade the direct dependency; overrides/resolutions for transitive ones only as a stopgap. Avoid `npm audit fix --force`; it can jump majors.
- Record accepted risks with a reason.

## Removing
Find candidates with `npx knip` or `npx depcheck` (JS), `deptry` (Python), `cargo machete` or `cargo udeps`, `go mod tidy`. Confirm with code(action="search") for imports, dynamic requires, config plugins and CLI use in scripts before removing.

## Pitfalls
- Installing with a different package manager than the lockfile.
- Upgrading everything at once, then not knowing what broke.
- Global installs to make one thing work.
