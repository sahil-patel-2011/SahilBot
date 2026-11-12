---
name: performance-profiling
description: Find and fix what makes code or an app slow.
source: you
uses: 0
category: Coding
---

1. Measure first: reproduce with a timing or benchmark; never optimize blind.
2. Profile: node --cpu-prof, Python cProfile or py-spy, database EXPLAIN, the browser's network/performance tools.
3. Fix the biggest hotspot (algorithmic complexity, N+1 queries, repeated work, missing cache, large payloads).
4. Measure again and report before and after numbers.
