// Waiting for the UI to settle after an action: read the screen state until two reads in a row agree
// (or a timeout), so the result the model gets describes where the app ended up, not a frame mid-way
// through an animation or a window opening.

export interface SettleOptions {
  /** Give up waiting after this long and report the last read. */
  timeoutMs: number
  /** Pause between reads. */
  intervalMs: number
  /** First read after this long (lets the action start). */
  initialDelayMs?: number
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface Settled<T> {
  state: T
  /** Two consecutive reads matched before the timeout. */
  stable: boolean
  reads: number
  waitedMs: number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function waitForSettle<T>(read: () => Promise<T>, same: (a: T, b: T) => boolean, o: SettleOptions): Promise<Settled<T>> {
  const sleep = o.sleep ?? defaultSleep
  const now = o.now ?? Date.now
  const start = now()
  const stop = (): void => { if (o.signal?.aborted) throw new DOMException('stopped', 'AbortError') }
  await sleep(o.initialDelayMs ?? o.intervalMs)
  stop()
  let last = await read()
  let reads = 1
  while (now() - start < o.timeoutMs) {
    await sleep(o.intervalMs)
    stop()
    const cur = await read()
    reads++
    if (same(last, cur)) return { state: cur, stable: true, reads, waitedMs: now() - start }
    last = cur
  }
  return { state: last, stable: false, reads, waitedMs: now() - start }
}
