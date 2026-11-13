// Latency timings for model requests and the agent loop. Off by default: set SAHILBOT_DEBUG_TIMING=1
// (or DEBUG=timing) to print them as debug lines. The last few are always kept in memory (tests and
// diagnostics read them with recentTimings()), which costs nothing measurable.

export interface Timing {
  label: string
  /** Milliseconds since the timer started, per mark. */
  marks: Record<string, number>
  total: number
  extra?: Record<string, unknown>
}

const KEEP = 50
const recent: Timing[] = []

export const timingEnabled = (): boolean =>
  process.env.SAHILBOT_DEBUG_TIMING === '1' || /\btiming\b/.test(process.env.DEBUG ?? '')

/** The latest timings, newest last. */
export function recentTimings(label?: string): Timing[] {
  return label ? recent.filter((t) => t.label === label) : [...recent]
}

export function clearTimings(): void {
  recent.length = 0
}

export interface Timer {
  /** Records the first time `name` happens (later calls with the same name are ignored). */
  mark(name: string): void
  /** Milliseconds since start. */
  elapsed(): number
  end(extra?: Record<string, unknown>): Timing
}

export function timer(label: string): Timer {
  const t0 = performance.now()
  const marks: Record<string, number> = {}
  let done: Timing | undefined
  return {
    mark(name) {
      if (!(name in marks)) marks[name] = Math.round(performance.now() - t0)
    },
    elapsed: () => performance.now() - t0,
    end(extra) {
      if (done) return done
      done = { label, marks, total: Math.round(performance.now() - t0), extra }
      recent.push(done)
      if (recent.length > KEEP) recent.shift()
      if (timingEnabled()) {
        const parts = Object.entries(marks).map(([k, v]) => `${k}=${v}ms`)
        const more = extra ? Object.entries(extra).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`) : []
        console.debug(`[timing] ${label} total=${done.total}ms ${[...parts, ...more].join(' ')}`.trim())
      }
      return done
    }
  }
}
