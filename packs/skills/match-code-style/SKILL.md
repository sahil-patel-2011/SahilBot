---
name: match-code-style
description: Write code that blends into the codebase - naming, errors, imports, formatting, comments, existing helpers - by copying the nearest analog.
source: you
uses: 0
category: Coding
triggers: match the existing style, follow the conventions, consistent with the codebase, naming conventions, house style, looks like the rest of the code, idiomatic for this repo, prettier config, editorconfig, code formatting, import order, same pattern as
---

## When
Every edit in an existing codebase. The bar: a reviewer can't tell which lines you wrote. Learning conventions on a new repo: codebase-orientation. Changing conventions on purpose: refactor-safely.

## Steps
1. Find the nearest analogous code: the sibling function, the neighboring endpoint or component, the last similar feature. code(action="search") for a comparable name; git(action="log") to find a recent similar commit and git(action="diff", ref) to see its full shape. Copy that shape, then change the details.
2. Read the enforced rules: .editorconfig, .prettierrc, ESLint config, ruff/black/isort in pyproject.toml, rustfmt.toml, .swiftlint.yml, .golangci.yml. Tooling beats taste.
3. Match these, roughly in the order reviewers notice them:
   - Naming: case, verb choice (get vs fetch vs load), boolean prefixes (is/has), file names (kebab vs Pascal), test names.
   - Error handling: exceptions vs Result/err returns, custom error classes, where errors are caught, how they are logged, message wording.
   - Imports: absolute vs relative, path aliases (@/), group order, named vs default exports, barrel files.
   - Structure: function length, early returns, classes vs functions, hooks, dependency injection, where constants and types live.
   - Types: strictness, interface vs type, Optional vs `| None`, explicit return types if neighbors have them.
   - Async: async/await vs promise chains vs callbacks; the project's concurrency helpers.
   - Comments and docstrings: same density and format (JSDoc, Google or NumPy docstrings); no comments narrating obvious lines.
   - Logging: the project logger, levels, structured fields; no stray print or console.log.
   - Tests: same framework, fixtures, factories, location, naming, assertion style.
4. Reuse existing helpers. Before writing a utility (dates, HTTP client, retry, validation, paths), search for one. A duplicate helper is a style bug.
5. Keep the diff minimal: don't reformat untouched lines, reorder imports you didn't touch, or rename for taste. Whitespace churn hides the real change.
6. If the repo uses a formatter or linter, run it on just the files you changed: code(action="lint", path).

## Decision rules
- File and repo disagree: follow the file (local consistency), unless the repo documents a migration toward a new style; then follow the documented direction.
- No example exists: use the language's mainstream guide (PEP 8, Effective Go, Swift API Design Guidelines, Rust API Guidelines, the TypeScript handbook).
- Don't introduce a new library, paradigm or pattern for one change (classes in a functional codebase, RxJS where promises rule).
- Never fix style in files you aren't otherwise touching unless asked.

## Example
Neighbor in src/services/user.ts:
`export async function getUser(id: string): Promise<User> { const row = await db.user.findUnique({ where: { id } }); if (!row) throw new NotFoundError('user', id); return toUser(row); }`
New code belongs in src/services/team.ts as `getTeam(id)`, throws the same NotFoundError, maps through a `toTeam` helper. Not `fetch_team` returning null from a new utils file.

## Verify
- git(action="diff") shows no unrelated lines.
- Formatter and lint clean on touched files.
- New names read consistently next to their neighbors when you search them.
