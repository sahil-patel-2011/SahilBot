---
name: typescript-project
description: Work in a TypeScript/Node project: types, builds, tests, lint.
source: you
uses: 0
category: Coding
---

1. Read package.json scripts and tsconfig; detect the package manager from the lockfile (npm, pnpm, yarn, bun).
2. Install only with approval; run the type check (npx tsc --noEmit) and tests first to know the baseline.
3. Make changes with strict types (no any unless unavoidable), small functions, tests in the project's existing style.
4. After each change: type check, lint if configured, tests. Fix causes, not symptoms.
5. Report what changed, how you checked it, and follow-ups.
