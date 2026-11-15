---
name: read-stack-traces
description: Decode stack traces and crash logs in JS/TS, Python, Java/Kotlin, Swift, Rust and Go - find the first own frame, caused-by chains, source maps.
source: you
uses: 0
category: Coding
triggers: stack trace, traceback, exception, caused by, segfault, panic, uncaught error, nullpointerexception, typeerror cannot read properties, fatal error, source map, minified stack, unhandled promise rejection, what does this error mean, exc_bad_access
---

## When
An error dump appears and you need where and why. Then fix it with debug-systematically.

## Method
1. Get all of it: the message, every frame, every "Caused by" / "During handling of the above" / "direct cause" block. Truncated traces mislead.
2. Read the error type and message first; they often name the problem outright (missing key, wrong type, bad path).
3. Find the first frame in this project's code; skip runtime, framework, node_modules, site-packages and vendor frames. That is where your code passed the bad value or crashed. Then look a few frames around it for who called it with what.
4. Open it: code(action="read", path, start=line-15, end=line+15). Ask which value makes this line fail.
5. Chained errors: the root cause is the original one (Java: the last Caused by; Python: printed first, above "direct cause").
6. Confirm with a log of the actual values before fixing.

## Frame order per language
- Python: most recent call last. Bottom line = type and message; the frame above it raised.
- JS/TS (V8): most recent first, `at fn (file:line:col)`. `at async fn` marks async hops; await keeps stacks, bare .then chains lose them. `node --enable-source-maps` maps compiled JS back to TS. Browsers apply source maps when .map files are served; for production minified traces, map with that build's .map files or the error tracker's uploaded maps.
- Java/Kotlin: most recent first; read the final Caused by block. `... 12 more` = frames shared with the enclosing trace. Kotlin coroutines: `-Dkotlinx.coroutines.debug` gives readable traces.
- Swift/ObjC: crash reports need symbolication (dSYM via Xcode Organizer or `atos`). EXC_BAD_ACCESS = invalid or freed memory; "Unexpectedly found nil while unwrapping" = force unwrap; EXC_BREAKPOINT is usually a Swift runtime trap (index out of range, overflow, failed force cast).
- Rust: `RUST_BACKTRACE=1` (or `full`). The panic message and location print first; find your crate's frames below std/core.
- Go: panic message, then goroutine stacks most recent first, `file.go:42 +0x1d`. `GOTRACEBACK=all` shows every goroutine; "all goroutines are asleep" = deadlock.
- C/C++: run under lldb/gdb and `bt`, or build with `-fsanitize=address`.

## Common signatures
- `Cannot read properties of undefined (reading 'x')`: the object before `.x` is undefined; trace its origin (missing await, wrong key, empty response).
- `KeyError`, `'NoneType' object has no attribute`: missing data or a function returned None.
- `ModuleNotFoundError`, `Cannot find module`: deps not installed, wrong venv or cwd, path alias not configured.
- `ECONNREFUSED`, `ETIMEDOUT`: service down or wrong host/port; environment, not logic.
- `ENOENT`: path resolved against the wrong working directory.
- `NullPointerException`: Java 14+ "because ... is null" names the culprit.
- `RecursionError`, `Maximum call stack size exceeded`: repeating frames; find the cycle.
- `Unhandled promise rejection`: missing await or catch at the frame shown.
- Rust `called Option::unwrap() on a None value`: handle the None.

## Pitfalls
- Patching the deepest library frame instead of your call site.
- Reading only file names and skipping the message.
- Debugging compiled output when a source map exists.
