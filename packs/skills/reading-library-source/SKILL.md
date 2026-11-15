---
name: reading-library-source
description: Learns how an unfamiliar library really behaves - installed version, version-matched docs, its source and tests, changelogs, and a tiny spike.
source: you
uses: 0
category: Coding
triggers: node_modules source, site-packages, read library source, which version is installed, lockfile version, cargo registry src, go mod cache, changelog breaking change, undocumented behavior, library internals, github issue for library, spike to test api, method does not exist, deprecated api, d.ts type definitions, upgrade broke
---

## When
Before using an API you haven't used in this project, when docs and behavior disagree, when an upgrade broke something, or when an error comes from inside a dependency. Rule: never guess an API signature, option name or default. Look it up for the installed version.

## Steps
1. Installed version (the lockfile is the truth, not the range in the manifest):
   - npm/pnpm/yarn: `npm ls <pkg>`, `pnpm why <pkg>`, or `node_modules/<pkg>/package.json` `version`.
   - Python: `pip show <pkg>` or `python -c "import pkg; print(pkg.__version__, pkg.__file__)"`; lock in poetry.lock/uv.lock.
   - Rust: Cargo.lock; Go: go.mod / `go list -m all | grep <mod>`; Swift: Package.resolved; Gradle: `./gradlew dependencies`.
2. Docs for that exact version: versioned docs site, or the README/docs folder at the matching git tag. Use web_search / fetch_page; note the URL in todo notes. Docs for `latest` are a common source of wrong answers.
3. Read the installed source (it is what actually runs):
   - JS: `node_modules/<pkg>/` (check `package.json` `exports`/`main` for the entry; `.d.ts` files give exact signatures).
   - Python: the `__file__` path in site-packages; `inspect.getsource(fn)`.
   - Rust: `~/.cargo/registry/src/*/<crate>-<ver>/`; Go: `$(go env GOMODCACHE)/<module>@<ver>/`; Swift: `.build/checkouts/` or DerivedData SourcePackages.
   Use code(action="search", pattern, path) and code(action="read") on those paths; start from the public function and follow it one or two levels.
4. Examples and tests: the library's own `examples/` and test files at that tag show intended usage and edge cases better than blog posts.
5. Changes and bugs: CHANGELOG / release notes between your version and latest; search the repo's issues for the exact error message.
6. Spike: write a 10-30 line script in a scratch file that calls the API exactly as you plan to, prints the result, and exercises the edge you care about (empty input, error, timeout, defaults). Run it with run_command. Delete it afterwards or keep it as a test.
7. Only then write the real code; cite the version and source location in your report if behavior was surprising.

## Decision rules
- If the docs and source disagree, trust the source for this version and note it.
- If a symbol isn't found in the installed version, it was added later or renamed: check the changelog before upgrading.
- If behavior depends on a default, set it explicitly in your code.
- If the library is unmaintained or the behavior is a known bug, wrap it behind your own small function so it can be replaced.

## Pitfalls
- Reading the GitHub main branch while running a version from two years ago.
- Trusting an LLM-remembered signature or a Stack Overflow answer for a different major version.
- Editing files in node_modules/site-packages to "fix" things; changes vanish on install. Use a patch tool (patch-package, `pnpm patch`) if truly needed.
- Multiple installed copies (`npm ls <pkg>` shows duplicates) so you read one and run another.
- Python: a local file named like the package (`requests.py`) shadowing the real one.

## Verify
The spike's output matches what your code assumes; the version you read docs for equals the lockfile version.

## Example
```bash
npm ls zod                      # zod@3.23.8
sed -n '1,80p' node_modules/zod/lib/types.d.ts | grep -n "safeParse"
```
