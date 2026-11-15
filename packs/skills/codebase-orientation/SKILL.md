---
name: codebase-orientation
description: Build a fast mental map of an unfamiliar repo - layout, entry points, build and test commands, conventions, data flow - before changing anything.
source: you
uses: 0
category: Coding
triggers: unfamiliar codebase, new repo, explain this codebase, how is this repo structured, where is the entry point, walk me through the code, onboard me to, repo tour, architecture overview, where does this happen, how does this project work
---

## When
First contact with a repo, or before any change in an area you have not read. Next: plan-a-code-change, then coding-agent-loop. For a single bug go to debug-systematically.

## Steps
1. code(action="project"): languages, package manager, scripts, test/typecheck/lint/build commands, branch, uncommitted changes, recent commits, AGENTS.md/CONTRIBUTING hints. Put the commands in todo notes so they survive summarization.
2. Skim the human docs in this order: AGENTS.md / CLAUDE.md, README, CONTRIBUTING, docs/ index, ADRs. They hold rules the code won't show (do-not-touch dirs, release steps, generated files).
3. Read the manifests: package.json (scripts, main/bin/exports, workspaces), pyproject.toml, Cargo.toml, go.mod, build.gradle, Package.swift, Makefile, Dockerfile, docker-compose.yml. Read .github/workflows too: CI is the truth about how the project is really built and tested.
4. Map the layout: top-level folders plus one level down; label each (app code, tests, scripts, generated, vendored, config, assets). In a monorepo, note packages and which depends on which.
5. Find entry points: main/bin fields, `if __name__ == "__main__"`, `func main`, `@main`, server bootstrap (app.listen, createServer, uvicorn, FastAPI()), Electron main/preload/renderer, CLI parsers, route tables, cron and queue workers. Example: code(action="search", pattern="listen\\(|createServer|argparse|click\\.command|func main").
6. Trace one real request or command end to end: entry -> routing -> handler -> domain logic -> storage or network -> response. Use code(action="symbols", name) to jump to definitions and search for callers. One traced path teaches more than twenty skimmed files.
7. Learn conventions from 2-3 representative files: error handling, logging, config loading, dependency wiring, naming, test layout and fixtures (details in match-code-style).
8. Get a baseline if allowed: run the tests or typecheck once so pre-existing failures are known and not blamed on you. Installs ask the user first.
9. Write the mental map below into todo notes and give the user the short version.

## Mental map template
- Purpose: one sentence.
- Stack: languages, frameworks, runtime versions.
- Commands: install / dev / test / typecheck / lint / build.
- Layout: folder -> role, 5-10 lines.
- Entry points: file:line per process.
- Main flow: A -> B -> C for the core use case.
- State: databases, caches, files, external APIs, required env vars.
- Conventions: errors, logging, tests, naming.
- Hazards: generated code, vendored dirs, flaky areas, baseline failures.

## Decision rules
- Generated output (dist, build, __generated__, *.pb.go, compiled assets): never edit; find the generator and its command.
- Docs and code disagree: trust code and CI, and mention the drift.
- Huge repo: scope to the package the task touches; don't map everything.
- A file shaped oddly: git(action="log", path) shows why before you "fix" it.

## Pitfalls
- Editing before you can name the entry point and the test command.
- Reading files alphabetically instead of following a call path.
- Assuming a framework's default layout; check its config (tsconfig paths, Django settings, vite.config, Gradle source sets).
- Running the root test command when only one monorepo package matters.
