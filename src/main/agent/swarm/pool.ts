// Runs a swarm's members with a parallelism that adapts to the provider: a rate limit (429) halves it
// and pauses new launches with exponential backoff (or the server's Retry-After); steady successes ease
// it back up to the maximum. A gate decides per member whether it may start now (the budget, a cancel).

/** Backoff timing (tests shrink it). */
export const swarmTiming = { backoffMs: 2000, maxBackoffMs: 60_000, recoverAfter: 3 }

/** A helper run failed on a rate limit. */
export const RATE_LIMITED = /\b429\b|rate[ -]?limit|too many requests|overloaded|\b529\b/i

export class AdaptiveLimit {
  limit: number
  /** No new launch before this time (ms epoch). */
  pauseUntil = 0
  /** Rate limits seen. */
  hits = 0
  /** Lowest parallelism reached. */
  low: number
  private streak = 0

  constructor(public readonly max: number, private now: () => number = Date.now) {
    this.limit = Math.max(1, max)
    this.low = this.limit
  }

  rateLimited(afterMs?: number): void {
    this.hits++
    this.streak = 0
    this.limit = Math.max(1, Math.floor(this.limit / 2))
    this.low = Math.min(this.low, this.limit)
    const wait = afterMs ?? Math.min(swarmTiming.maxBackoffMs, swarmTiming.backoffMs * 2 ** Math.min(6, this.hits - 1))
    this.pauseUntil = Math.max(this.pauseUntil, this.now() + wait)
  }

  succeeded(): void {
    if (++this.streak >= swarmTiming.recoverAfter && this.limit < this.max) {
      this.limit++
      this.streak = 0
    }
  }
}

export type Gate = 'go' | 'wait' | 'stop' | 'skip'

/**
 * Runs fn(i) for i in 0..n-1, at most limit.limit at a time. fn returns 'retry' to put its member back at
 * the front of the queue (after a rate limit). gate(i): 'go' starts it; 'wait' holds it until a running
 * member finishes (with none running it becomes 'stop'); 'stop' ends all launching; 'skip' passes this one.
 * onSkip gets every member that never ran, with why.
 */
export async function runPool(n: number, o: {
  limit: AdaptiveLimit
  gate?: (i: number) => Gate
  signal?: AbortSignal
  onSkip?: (i: number, why: 'stopped' | 'budget' | 'cancelled') => void
}, fn: (i: number) => Promise<'retry' | void>): Promise<void> {
  const queue = Array.from({ length: n }, (_, i) => i)
  const active = new Set<Promise<void>>()
  let stopped: 'stopped' | 'budget' | null = null
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(1, ms)))
  while (queue.length || active.size) {
    if (o.signal?.aborted && !stopped) stopped = 'stopped'
    if (stopped) for (const i of queue.splice(0)) o.onSkip?.(i, stopped)
    const paused = Date.now() < o.limit.pauseUntil
    while (!stopped && !paused && queue.length && active.size < o.limit.limit) {
      const i = queue[0]
      const g = o.gate?.(i) ?? 'go'
      if (g === 'skip') { queue.shift(); o.onSkip?.(i, 'cancelled'); continue }
      if (g === 'wait' && active.size) break
      if (g === 'stop' || g === 'wait') { stopped = 'budget'; for (const j of queue.splice(0)) o.onSkip?.(j, 'budget'); break }
      queue.shift()
      const p: Promise<void> = fn(i).then((r) => { if (r === 'retry') queue.unshift(i) }, () => undefined).finally(() => { active.delete(p) })
      active.add(p)
    }
    if (!active.size) {
      if (!queue.length || stopped) break
      // Paused after a rate limit (or waiting on nothing): sleep until launches may resume.
      await sleep(o.limit.pauseUntil - Date.now())
      continue
    }
    const waits: Array<Promise<unknown>> = [...active]
    if (paused && queue.length) waits.push(sleep(o.limit.pauseUntil - Date.now()))
    await Promise.race(waits)
  }
}
