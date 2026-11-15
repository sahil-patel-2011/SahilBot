---
name: concurrency-async
description: Finds and fixes race conditions, deadlocks and async bugs across JS, Python asyncio, Swift concurrency and Go, and tests them deterministically.
source: you
uses: 0
category: Coding
triggers: race condition, deadlock, lock ordering, mutex contention, event loop blocked, unawaited promise, promise.all vs allsettled, abortcontroller, asyncio gather, asyncio blocking call, mainactor, swift actor, data race, goroutine leak, go test -race, thread safety
---

## When
Intermittent wrong results, hangs, "works locally, fails under load", or writing code with threads, tasks or callbacks. Retry and idempotency at the service level: backend-services.

## Diagnose
1. Name the shared state: what is read and written by more than one task/thread? Every bug lives there.
2. Look for check-then-act (`if not exists: create`), read-modify-write (`count += 1`), and lazy init without a lock.
3. Reproduce under pressure: loop the test 1,000 times, add many concurrent callers, inject `sleep(0)`/yields between the read and the write.
4. For hangs, dump stacks: `kill -QUIT` (Go/Java), `py-spy dump --pid`, Node `--inspect` pause, Xcode thread view. Two threads each waiting on a lock the other holds = deadlock.

## Fix rules
- Prefer no shared mutable state: message passing, immutable data, ownership by one task/actor.
- Otherwise make it atomic: DB constraint + upsert, `SELECT ... FOR UPDATE`, compare-and-swap, atomic counters, or one lock around the whole check-and-act.
- Deadlocks: acquire locks in one global order; hold locks briefly; never call unknown code or do I/O while holding one; use timeouts (`tryLock`) where order cannot be guaranteed.
- Retries after a timeout may duplicate work: make operations idempotent (keys, dedup tables).

## JavaScript / Node
- Every promise is awaited, returned, or explicitly handled; lint with `no-floating-promises`. An unawaited promise loses errors and ordering.
- `Promise.all` fails fast on the first rejection (others keep running); `Promise.allSettled` when you need every result; limit concurrency with p-limit instead of firing 10,000 requests.
- The event loop is single-threaded: CPU work > ~50 ms (JSON of huge payloads, crypto, sync fs) blocks every request. Move it to worker threads or chunk it.
- Cancellation: pass an `AbortController.signal` to fetch and your own functions; abort on timeout or unmount.
- `forEach(async ...)` does not wait; use `for...of` with await or `Promise.all(map(...))`.

## Python asyncio
- `asyncio.gather(*tasks)` cancels nothing on failure by default; prefer `asyncio.TaskGroup` (3.11+) for structured concurrency, or `return_exceptions=True` deliberately.
- Blocking calls (`requests`, `time.sleep`, heavy CPU) inside `async def` freeze the loop. Use async clients, `await asyncio.sleep`, or `await asyncio.to_thread(fn)`.
- Keep a reference to `create_task` results or they can be garbage-collected mid-flight.
- Enable debug mode (`PYTHONASYNCIODEBUG=1`) to log slow callbacks and never-awaited coroutines.

## Swift
- Actors serialize access to their state; but each `await` inside an actor is a suspension point where state can change (reentrancy). Re-check invariants after awaits.
- UI state on `@MainActor`. Turn on strict concurrency checking (Swift 6 mode) and fix `Sendable` warnings rather than silencing them.
- Use `Task` cancellation (`try Task.checkCancellation()`); `.task` modifiers cancel on view disappear.

## Go
- Every goroutine needs a way to exit: `context.Context` cancellation or a closed channel. Leaked goroutines show up in `runtime.NumGoroutine()`.
- Sender closes the channel, never the receiver; unbuffered sends block until received. Use `errgroup` for fan-out with errors.
- Protect maps with `sync.Mutex`/`RWMutex`; concurrent map writes crash.

## Testing concurrency
- Race detectors: `go test -race ./...`, ThreadSanitizer (`-sanitize=thread` in Swift/C/C++), Rust `loom`.
- Stress: run the test in a loop with high parallelism (`go test -count=1000`, `pytest --count` via pytest-repeat).
- Deterministic: inject the clock and scheduler (fake timers, virtual-time test dispatchers, controlled executors) so interleavings are reproducible. A test that passes 99/100 times is a failing test.

## Verify
The stress loop passes N=1,000 with the race detector on, and the original reproduction no longer fails.
