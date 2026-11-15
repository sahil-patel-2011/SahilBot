---
name: performance-profiling
description: Make slow code fast by measuring first - profile per stack, fix the biggest hotspot (algorithm, N+1, caching) and prove it with before/after numbers.
source: you
uses: 0
category: Coding
triggers: too slow, profiler, flame graph, cpu profile, memory leak, high latency, n+1 queries, py-spy, pprof, time profiler, benchmark, speed up, lighthouse score, explain analyze, high memory usage
---

## When
Something is slow, burns CPU or memory, or must meet a latency budget. Correctness bugs: debug-systematically.

## Steps
1. Set the metric and target: p50/p95 latency, job wall time, frame time (16.7 ms for 60 fps), peak memory, bundle size. Record the budget in todo notes.
2. Reproduce at realistic data size. Baseline 3-5 runs, take the median; production build, no debugger, logging at normal level.
3. Profile; don't guess.
   - Node: `node --cpu-prof app.js`, open the .cpuprofile in Chrome DevTools; `--heap-prof` or heap snapshots for memory; `clinic flame` or `0x` for flame graphs.
   - Browser: DevTools Performance (long tasks over 50 ms, forced layouts), Lighthouse, React Profiler for re-renders, Network for waterfalls and payload size.
   - Python: `py-spy record -o prof.svg -- python app.py` (or `--pid` to attach), `python -m cProfile -s cumtime app.py`, line_profiler, tracemalloc or memray for memory.
   - Swift/macOS/iOS: Instruments Time Profiler, Allocations, Leaks, on a Release build.
   - Go: `go test -bench . -cpuprofile cpu.out`, `go tool pprof -http=:8080 cpu.out`; net/http/pprof for servers.
   - Rust/C/Linux: `perf record -g` plus flamegraph, `cargo flamegraph`; on macOS Instruments or samply.
   - SQL: `EXPLAIN ANALYZE` (Postgres), `EXPLAIN` (MySQL/SQLite), slow query log; look for seq scans on big tables and bad row estimates.
4. Fix the top hotspot only, by payoff:
   - Algorithm: nested loops or `includes` inside a loop -> Set/Map/dict; sort once; build strings with join.
   - N+1 I/O: a query or request per item -> join, `WHERE id IN (...)`, eager loading (select_related/prefetch_related, Prisma include), batch endpoints; run independent I/O concurrently with a limit.
   - Repeated work: hoist out of loops, memoize pure functions, cache with explicit key, TTL and invalidation.
   - Volume: paginate, select needed columns, stream, compress.
   - Indexes matching the query's WHERE, JOIN and ORDER BY.
   - UI: stop needless re-renders, virtualize long lists, code-split, lazy-load media.
5. Re-measure the same way; keep the change only if it beats run-to-run noise. Re-profile; the hotspot moves.
6. Stop at the budget and note tradeoffs (memory for speed, staleness, complexity).

## Benchmarks that don't lie
- Warm up (JIT, caches, pools), then many iterations; report median and p95, never one run.
- Tools: hyperfine (CLIs), pytest-benchmark or timeit, vitest bench or mitata, `go test -bench`, criterion.
- Use the result so the compiler can't drop the work; same inputs; quiet machine.

## Pitfalls
- Optimizing a function that is 2% of the profile.
- Measuring dev builds or with verbose logging.
- Caches without invalidation, or caching errors.
- Unreadable micro-optimizations with no measured gain.

## Verify
Report the metric, baseline vs after (median, n runs), the profiler evidence, and the change. Run the tests: faster but wrong is a regression.
