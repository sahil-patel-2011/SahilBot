---
name: typescript-project
description: Work in a TypeScript or Node codebase - pick the package manager, run tsc, eslint and vitest/jest, fix type, ESM/CJS and async bugs.
source: you
uses: 0
category: Coding
triggers: typescript, tsconfig.json, tsc --noemit, ts2322, esm vs commonjs, err_require_esm, vitest, jest test, eslint error, pnpm, yarn.lock, zod schema, unknown vs any, node version, cannot find module ts
---

## When
TypeScript or Node work (libraries, CLIs, servers). For UI also read react-frontend; a fresh app, new-web-app; red tests, coding-fix-failing-tests.

## Orient
1. code(action="project"), then read package.json (scripts, "type", "engines", "packageManager"), tsconfig.json and anything it "extends", the eslint config.
2. Package manager from the lockfile only: package-lock.json = npm, pnpm-lock.yaml = pnpm, yarn.lock = yarn, bun.lock/bun.lockb = bun. Never run a different one; a second lockfile is a bug.
3. Node version from .nvmrc, .node-version, engines or volta; compare with node -v before chasing odd syntax or fetch errors.
4. Baseline typecheck, lint and tests before editing so pre-existing failures aren't blamed on you.

## Commands
- Typecheck: the "typecheck" script if present, else npx tsc --noEmit (-p path; project references use tsc -b).
- Lint: npx eslint <files> (--fix only on files you touched). Format: npx prettier --check . or npx biome check.
- One test: npx vitest run src/x.test.ts -t "parses dates"; npx jest src/x.test.ts -t "parses dates". Through scripts: pnpm test -- -t "name".
- SahilBot: code(action="typecheck"), code(action="lint"), code(action="run_tests", filter="x.test.ts").

## Idioms
- strict: true stays on. Untrusted values are unknown; narrow with typeof, in, instanceof, Array.isArray or a type guard.
- Model states as discriminated unions (kind field) and end switches with a never check.
- any disables checking; if unavoidable, confine it to one line with a comment. Prefer satisfies over as; ! only when proven.
- Validate every boundary (request bodies, env vars, JSON files, model output) with zod: define the schema, derive the type with z.infer, call safeParse and handle the error branch.
- Async: await or return every promise (enable no-floating-promises). catch (e: unknown) then narrow. Promise.all for independent work, allSettled when partial failure is acceptable; await inside a for loop is serial on purpose or a bug.
- String-literal unions beat enums; const enum breaks under isolatedModules.

## ESM vs CJS
- "type": "module" makes .js files ESM. With module NodeNext, relative imports need the runtime extension (./util.js, even from a .ts file).
- moduleResolution NodeNext for Node code, Bundler for Vite/esbuild apps.
- ERR_REQUIRE_ESM: CJS code requires an ESM-only package. Convert the file to ESM or use await import().
- No __dirname in ESM: use import.meta.dirname (Node 20.11+) or fileURLToPath(import.meta.url).
- tsconfig "paths" only affect the type checker. If tsc passes but runtime says Cannot find module '@/x', the runner needs alias support (Vite resolve.alias, vite-tsconfig-paths, tsx) or switch to package.json "imports" (#src/*).

## Pitfalls
- Editing dist/ or generated files instead of src.
- Turning off strict, adding @ts-ignore, or casting to silence an error. Fix the type.
- JSON.parse and res.json() return any; parse through a schema.
- jest needs a TS transform (ts-jest, swc, babel); vitest environment node vs jsdom mismatches.
- Time-dependent tests: use fake timers and fixed time zones.
- Adding a dependency for a few lines of code; installs ask the user anyway.

## Verify
Typecheck clean, eslint clean on touched files, the targeted test then the full suite green. Report the commands and pass/fail counts.

## Example
```ts
type Shape = { kind: "circle"; r: number } | { kind: "rect"; w: number; h: number };
function area(s: Shape): number {
  switch (s.kind) {
    case "circle": return Math.PI * s.r ** 2;
    case "rect": return s.w * s.h;
    default: { const never: never = s; return never; }
  }
}
```
