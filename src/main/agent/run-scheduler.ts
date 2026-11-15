// How many agent runs go at once, and who goes next.
//
// Every top-level run (a chat message, a routine, a goal wake-up, a handoff) asks for a slot before it
// starts. Slots are global (sized to the machine's memory and cores) and shared fairly between bots:
// each bot has its own queue, and a free slot goes to the waiting bot with the fewest runs going, so one
// busy bot can't starve the others. Within a bot, runs the user is waiting on go before unattended ones.
// Under memory pressure (little free memory, or this process grown too big) new runs wait instead of
// starting; one run always may go, so the queue can never stall completely.
//
// Swarm helpers and other runs started from inside a run don't take a slot (their parent holds one and
// the swarm has its own cap). Cloud model calls are network-bound, so many can be in flight across runs.
// CPU-heavy work (rendering, extraction, indexing) goes through the small `cpuSlots` pool instead.
//
// In the Mac app no limit is configured and runs start immediately, exactly as before.

import { cpus, freemem, totalmem } from 'node:os'

export interface RunTicket {
  threadId: string
  /** The bot (space) the run belongs to; its own queue. */
  spaceId: string
  /** The user is waiting on it (typed it), as opposed to a routine or a goal. */
  interactive: boolean
  signal?: AbortSignal
}

export interface MemoryProbe { freeMB: number; rssMB: number }

export interface SchedulerOptions {
  /** Most runs at once. */
  limit: number
  /** Wait for more memory when free system memory drops below this. */
  minFreeMB?: number
  /** Wait when this process's resident memory goes above this. */
  maxRssMB?: number
  probe?: () => MemoryProbe
  /** How often a pressure-blocked queue looks again. */
  recheckMs?: number
}

export interface SchedulerStats {
  limit: number
  running: number
  queued: number
  pressure: boolean
  admitted: number
  maxRunning: number
  bots: Record<string, { running: number; queued: number }>
}

interface Waiting { t: RunTicket; at: number; seq: number; go: (release: () => void) => void }

const defaultProbe = (): MemoryProbe => ({ freeMB: freemem() / 1048576, rssMB: process.memoryUsage().rss / 1048576 })

/** The default run limit for a machine: about one per GB beyond the first, fewer on few cores; 2 to 32. */
export function defaultRunLimit(totalGB = totalmem() / 1024 ** 3, cores = cpus().length || 4): number {
  return Math.max(2, Math.min(32, Math.round((totalGB - 1) * Math.min(1, cores / 4))))
}

/**
 * Memory thresholds for a machine: keep ~6% (at least 200 MB) available; this process may use up to 60%.
 * The free-memory check is Linux only: there os.freemem() is MemAvailable (page cache counts as free), while
 * macOS reports only truly unused pages, which is small on a healthy Mac. There the size cap alone applies.
 */
export function defaultMemoryLimits(totalMB = totalmem() / 1048576, platform: NodeJS.Platform = process.platform): { minFreeMB?: number; maxRssMB: number } {
  return { ...(platform === 'linux' ? { minFreeMB: Math.max(200, Math.round(totalMB * 0.06)) } : {}), maxRssMB: Math.round(totalMB * 0.6) }
}

export class RunScheduler {
  private running = new Map<string, number>()
  /** When each bot last got a slot (a counter). */
  private served = new Map<string, number>()
  private queues = new Map<string, Waiting[]>()
  private total = 0
  private seq = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private admitted = 0
  private maxRunning = 0
  private lastPressure = false
  onChange?: (s: SchedulerStats) => void
  /** A run is waiting (its position among all waiting runs, 1 = next). */
  onQueued?: (t: RunTicket, position: number, reason: 'limit' | 'memory') => void

  constructor(private o: SchedulerOptions) {}

  setLimit(limit: number): void { this.o.limit = Math.max(1, Math.round(limit)); this.pump() }
  get limit(): number { return this.o.limit }

  /** Resolves with a release function once the run may go. A run stopped while waiting goes at once (it will just end). */
  admit(t: RunTicket): Promise<() => void> {
    return new Promise((resolve) => {
      const w: Waiting = { t, at: Date.now(), seq: ++this.seq, go: resolve }
      const q = this.queues.get(t.spaceId) ?? []
      // The user's own runs go ahead of this bot's unattended ones (but behind its other interactive ones).
      const i = t.interactive ? q.findIndex((x) => !x.t.interactive) : -1
      if (i >= 0) q.splice(i, 0, w)
      else q.push(w)
      this.queues.set(t.spaceId, q)
      t.signal?.addEventListener('abort', () => {
        const qq = this.queues.get(t.spaceId)
        const k = qq?.indexOf(w) ?? -1
        if (k < 0 || !qq) return
        qq.splice(k, 1)
        if (!qq.length) this.queues.delete(t.spaceId)
        resolve(() => undefined)
        this.changed()
      }, { once: true })
      this.pump()
      if (this.queues.get(t.spaceId)?.includes(w)) this.onQueued?.(t, this.position(w), this.lastPressure ? 'memory' : 'limit')
    })
  }

  private position(w: Waiting): number {
    return [...this.queues.values()].flat().filter((x) => x.seq <= w.seq).length
  }

  private pressure(): boolean {
    if (!this.o.minFreeMB && !this.o.maxRssMB) return false
    const m = (this.o.probe ?? defaultProbe)()
    return (!!this.o.minFreeMB && m.freeMB < this.o.minFreeMB) || (!!this.o.maxRssMB && m.rssMB > this.o.maxRssMB)
  }

  /**
   * The waiting bot with the fewest runs going; among those, the user's own runs first, then the bot served
   * longest ago (round-robin, so a bot with a long queue takes turns instead of keeping every free slot),
   * then whoever has waited longest.
   */
  private next(): Waiting | undefined {
    let best: { w: Waiting; r: number; served: number } | undefined
    for (const [bot, q] of this.queues) {
      const head = q[0]
      if (!head) continue
      const r = this.running.get(bot) ?? 0
      const served = this.served.get(bot) ?? -1
      const better = !best || r < best.r || (r === best.r && (
        Number(head.t.interactive) > Number(best.w.t.interactive) || (head.t.interactive === best.w.t.interactive && (
          served < best.served || (served === best.served && head.seq < best.w.seq)))))
      if (better) best = { w: head, r, served }
    }
    return best?.w
  }

  private pump(): void {
    while (this.total < this.o.limit) {
      const w = this.next()
      if (!w) break
      this.lastPressure = this.total > 0 && this.pressure()
      if (this.lastPressure) { this.retryLater(); break }
      const q = this.queues.get(w.t.spaceId)!
      q.shift()
      if (!q.length) this.queues.delete(w.t.spaceId)
      this.total++
      this.admitted++
      this.maxRunning = Math.max(this.maxRunning, this.total)
      this.running.set(w.t.spaceId, (this.running.get(w.t.spaceId) ?? 0) + 1)
      this.served.set(w.t.spaceId, this.admitted)
      if (this.served.size > 5000) this.served.clear()
      let released = false
      w.go(() => {
        if (released) return
        released = true
        this.total--
        const n = (this.running.get(w.t.spaceId) ?? 1) - 1
        if (n > 0) this.running.set(w.t.spaceId, n)
        else this.running.delete(w.t.spaceId)
        this.pump()
      })
    }
    this.changed()
  }

  private retryLater(): void {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.pump() }, this.o.recheckMs ?? 1000)
    this.timer.unref?.()
  }

  private changed(): void { try { this.onChange?.(this.stats()) } catch { /* listeners are best-effort */ } }

  stats(): SchedulerStats {
    const bots: SchedulerStats['bots'] = {}
    for (const [b, n] of this.running) bots[b] = { running: n, queued: 0 }
    for (const [b, q] of this.queues) bots[b] = { running: bots[b]?.running ?? 0, queued: q.length }
    return { limit: this.o.limit, running: this.total, queued: [...this.queues.values()].reduce((a, q) => a + q.length, 0), pressure: this.lastPressure, admitted: this.admitted, maxRunning: this.maxRunning, bots }
  }

  dispose(): void { if (this.timer) clearTimeout(this.timer); this.timer = null }
}

/** A plain counting semaphore for CPU-heavy work (rendering, extraction, indexing). */
export class Slots {
  private busy = 0
  private waiting: Array<() => void> = []
  constructor(private size: number) {}
  setSize(n: number): void { this.size = Math.max(1, n); this.drain() }
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    // A waiter is handed the slot of the run that finished (busy stays counted), so none can jump ahead.
    if (this.busy >= this.size) await new Promise<void>((r) => this.waiting.push(r))
    else this.busy++
    try { return await fn() } finally { this.release() }
  }
  private release(): void {
    const next = this.busy <= this.size ? this.waiting.shift() : undefined
    if (next) next()
    else this.busy--
  }
  private drain(): void { while (this.busy < this.size && this.waiting.length) { this.busy++; this.waiting.shift()!() } }
  get active(): number { return this.busy }
}

// ------------------------------------------------------------------ the process-wide gate

let scheduler: RunScheduler | null = null

/** Unlimited unless configured (the Mac app); SahilBot Server configures it at boot. */
export const cpuSlots = new Slots(Number.MAX_SAFE_INTEGER)

let helperMax = Number.POSITIVE_INFINITY
/** The most swarm helpers any bot may use on this machine (SahilBot Server lowers it on small boards). */
export function helperCeiling(): number { return helperMax }
export function setHelperCeiling(n: number | null): void { helperMax = n && n > 0 ? Math.round(n) : Number.POSITIVE_INFINITY }

/** Turns run scheduling on (or off with null). */
export function configureRuns(o: SchedulerOptions | null): RunScheduler | null {
  scheduler?.dispose()
  scheduler = o ? new RunScheduler(o) : null
  return scheduler
}

export function runScheduler(): RunScheduler | null {
  return scheduler
}

/** Waits for a slot when scheduling is on; otherwise goes at once. */
export function admitRun(t: RunTicket): Promise<() => void> {
  return scheduler ? scheduler.admit(t) : Promise.resolve(() => undefined)
}
