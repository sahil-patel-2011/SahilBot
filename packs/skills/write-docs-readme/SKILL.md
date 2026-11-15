---
name: write-docs-readme
description: Write READMEs, docstrings, ADRs and changelogs that are accurate and runnable - quickstart, config, troubleshooting - verifying every command shown.
source: you
uses: 0
category: Coding
triggers: readme, write documentation, docstring, adr, architecture decision record, changelog, getting started guide, document this function, jsdoc, contributing guide, release notes, troubleshooting section, quickstart
---

## When
A project needs a README or docs, code needs docstrings, a decision needs recording, or a release needs notes. Endpoint reference content: api-design.

## Steps
1. Pick the reader: a new user (running in 5 minutes), a contributor (build and test), or a future maintainer (why). One primary reader per document.
2. Take facts from the code, not memory: code(action="project") for commands; manifests for versions and scripts; config loaders for env vars and defaults (search `process.env`, `os.environ`, `getenv`); CLI parsers for flags.
3. Draft, then run every documented command from a clean state (fresh clone or clean checkout when possible). Anything you couldn't run is reported as unverified.
4. Keep docs next to what they describe; link rather than duplicate.

## README outline
1. Name and one sentence: what it is, for whom. Screenshot or GIF for UI.
2. Why / features: 3-6 concrete bullets.
3. Requirements: OS, runtime versions, external services.
4. Quickstart ending in a visible result:
   ```
   git clone https://github.com/org/tool && cd tool
   npm ci
   cp .env.example .env    # set API_URL
   npm run dev             # open http://localhost:5173
   ```
5. Usage: the 3 commonest tasks with examples and expected output.
6. Configuration: table of name, default, required, meaning.
7. Development: test, lint, build; layout in a few lines.
8. Troubleshooting: real errors with exact text (searchable) and the fix.
9. License and contributing link.

## Docstrings and comments
- Public API: one-line summary of what (not how), params with units and valid ranges, return value, errors raised, an example when usage isn't obvious. Use the repo's format: TSDoc/JSDoc, Google or NumPy docstrings, rustdoc `///` with doctests, Swift `///` markup, Go comments starting with the identifier.
- Comments explain why (constraint, bug link, tradeoff), not what the next line does. Delete comments the code has outgrown.

## ADRs
`docs/adr/NNNN-short-title.md` with Status (proposed, accepted, superseded by NNNN), Context, Decision (one active-voice paragraph), Consequences (good and bad), Alternatives considered. Under a page; once accepted, supersede rather than edit.

## Changelogs and release notes
- CHANGELOG.md with an Unreleased section; groups Added, Changed, Deprecated, Removed, Fixed, Security; newest first; ISO dates; versions linked to diffs.
- Write the user-visible effect ("CSV export no longer drops the last row"), not commit messages. Breaking changes and migration steps go first.
- Semver: breaking -> major, feature -> minor, fix -> patch.

## Verify
- Each command ran and printed what the doc claims; links resolve; versions match manifests; env var names match the code (search them).
- Doc examples compile or pass where tooling allows (rustdoc tests, Python doctest).

## Pitfalls
- A quickstart that silently relies on setup already done on your machine.
- Documenting intended behavior instead of current behavior.
- Walls of prose; use short sections, tables and code blocks.
