/**
 * Startup timing, off unless SAHILBOT_TIMING=1. Each mark prints the time since the process started
 * (performance.timeOrigin is the process's own start) and since the previous mark, so a slow phase of
 * launch (module load, database, tool registry, window, first paint) shows up as one big gap:
 *   SAHILBOT_TIMING=1 npm start      →  [timing]   412ms (+38ms)  window created
 * The renderer reports its own first paint over IPC ('timing:mark'), so the log runs to the moment the
 * home screen is on the glass. Costs nothing when off: marks are a single boolean check.
 */
export const TIMING = process.env.SAHILBOT_TIMING === '1'

let last = 0
const seen: Array<{ label: string; at: number }> = []

export function mark(label: string): void {
  if (!TIMING) return
  const at = performance.now()
  seen.push({ label, at })
  console.log(`[timing] ${at.toFixed(0).padStart(6)}ms (+${(at - last).toFixed(0)}ms)  ${label}`)
  last = at
}

/** Every mark so far (tests read these to check time-to-window stays where it is). */
export function marks(): ReadonlyArray<{ label: string; at: number }> {
  return seen
}
