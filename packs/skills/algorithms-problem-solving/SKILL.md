---
name: algorithms-problem-solving
description: Solves algorithm and interview-style problems methodically - clarify, brute force, match a pattern, analyze complexity, test edges, code cleanly.
source: you
uses: 0
category: Coding
triggers: leetcode, coding interview, dynamic programming, two pointers, sliding window, binary search on answer, bfs dfs, topological sort, union find, heap priority queue, merge intervals, big o complexity, backtracking, memoization, monotonic stack, prefix sum
---

## When
A self-contained problem with inputs, outputs and constraints (interview, contest, or an algorithmic core inside real code). Performance of an existing system: performance-profiling.

## Steps
1. Clarify: input sizes and ranges, duplicates, negatives, empty input, sorted or not, return format, ties. The constraint `n` tells you the target complexity (table below).
2. Examples: work 2 by hand, then list edge cases: empty, one element, all equal, max size, negative, already sorted, disconnected graph.
3. Brute force first, out loud: state it and its complexity. It is your correctness oracle.
4. Find the bottleneck in the brute force (repeated work, nested scan) and match a pattern that removes it.
5. Analyze time and space of the plan before coding.
6. Code cleanly: helper functions, meaningful names, no clever one-liners.
7. Test: run the examples and every edge case; for confidence, compare against the brute force on random small inputs.

## n -> target complexity
| n up to | aim for |
|---|---|
| 10-20 | O(2^n), O(n!) backtracking/bitmask |
| 500 | O(n^3) |
| 5,000 | O(n^2) |
| 10^5-10^6 | O(n log n) or O(n) |
| 10^9+ | O(log n) or O(1), math or binary search |

## Pattern -> signal
| Signal in the problem | Pattern |
|---|---|
| Sorted array, pair/triplet with a sum, palindrome, partition in place | Two pointers |
| Longest/shortest contiguous subarray or substring with a condition | Sliding window (expand right, shrink left) |
| "Seen before?", counts, complement lookup, group anagrams | Hash map/set |
| Range sums, subarray sum equals k | Prefix sums + hash map |
| Minimize the max / maximize the min, "smallest x such that feasible" | Binary search on the answer with a monotone check |
| Shortest path in unweighted grid/graph, levels | BFS |
| Connected components, paths, flood fill, all combinations | DFS / backtracking |
| Top k, k-th largest, merge k sorted, running median | Heap |
| Weighted shortest path, non-negative weights | Dijkstra (heap) |
| Count ways, min cost, overlapping subproblems, choices per step | Dynamic programming |
| Dynamic connectivity, "are these in the same group", cycle in undirected graph | Union-find |
| Dependencies, ordering, prerequisites, cycle in directed graph | Topological sort (Kahn's) |
| Meetings, overlaps, merge ranges, rooms needed | Sort by start, sweep; heap of end times |
| Next greater/smaller element, histogram area | Monotonic stack |
| Prefix lookups, word search | Trie |

## DP recipe
1. Define the state in words: `dp[i]` = best answer for the first i items.
2. Write the transition and base cases; check on a tiny example.
3. Order: top-down memoization to get it right, then bottom-up if stack depth or speed matters.
4. Reduce space when a row only depends on the previous row.

## Pitfalls
- Coding before agreeing on the approach; skipping the brute force and losing the oracle.
- Off-by-one in windows and binary search: write the loop invariant (`lo` always feasible, `hi` always infeasible).
- Integer overflow on sums/products in fixed-width languages; mid as `lo + (hi - lo) // 2`.
- Mutating input that the caller still needs; recursion depth > 10^4 in Python.
- Forgetting visited sets in graph search (infinite loops) or marking visited too late (duplicate queue entries).

## Example
Longest substring without repeating characters: window [l, r], map char -> last index; on repeat, `l = max(l, last[c] + 1)`; answer = max(r - l + 1). O(n) time, O(alphabet) space.

## Verify
Random test harness: generate 1,000 small inputs, assert optimized == brute force, then time the max-size input.
