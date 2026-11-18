import type { BrainCadence } from '@shared/brain'

// When the brain syncs. Never a background daemon: it runs only while SahilBot is open and the Mac is
// awake, every ~15 minutes while the user is active, hourly once they've been idle a while, and not at all
// on a low battery, in Low Power Mode, while paused, or while the money it would spend isn't there (today's
// brain budget used up, or the monthly limit nearly reached). A free extraction model (local, or the
// ChatGPT plan when allowed) isn't held back by money.

export const MIN = 60_000
export const IDLE_AFTER_MS = 10 * MIN
export const IDLE_EVERY_MS = 60 * MIN
export const LOW_BATTERY = 20

export interface CadenceInput {
  now: number
  /** How long the user has been away from the keyboard and mouse (system-wide). */
  idleMs: number
  activeMinutes: number
  paused: boolean
  asleep?: boolean
  power: { onBattery: boolean; percent?: number; lowPower?: boolean }
  /** Today's brain spend and its cap. */
  todayUsd: number
  dailyUsd: number
  /** The monthly limit is nearly used up (Infinity-safe: the caller decides "tight"). */
  monthTight: boolean
  /** The extraction model costs nothing per request (local model, ChatGPT plan). */
  free: boolean
}

export function cadence(c: CadenceInput): BrainCadence {
  const stop = (paused: string): BrainCadence => ({ everyMs: 0, label: paused, paused })
  if (c.paused) return stop('paused')
  if (c.asleep) return stop('paused while the Mac sleeps')
  if (c.power.lowPower) return stop('paused in Low Power Mode')
  if (c.power.onBattery && typeof c.power.percent === 'number' && c.power.percent < LOW_BATTERY) return stop('paused on battery')
  if (!c.free) {
    if (c.dailyUsd <= 0 || c.todayUsd >= c.dailyUsd) return stop('paused: today’s budget is used')
    if (c.monthTight) return stop('paused: monthly limit nearly used')
  }
  if (c.idleMs >= IDLE_AFTER_MS) return { everyMs: Math.max(IDLE_EVERY_MS, c.activeMinutes * MIN), label: '~1 hr (idle)' }
  const every = c.activeMinutes * MIN
  return { everyMs: every, label: every >= 60 * MIN ? `~${Math.round(every / (60 * MIN))} hr` : `~${c.activeMinutes} min` }
}

/** Due for a scheduled sync now. */
export function due(c: BrainCadence, lastSyncAt: number | undefined, now: number): boolean {
  if (!c.everyMs) return false
  return now - (lastSyncAt ?? 0) >= c.everyMs
}

/** The monthly limit counts as nearly used with less than $0.50 or 5% of it left. */
export function monthTight(mode: 'amount' | 'unlimited' | 'none', cap: number, spent: number): boolean {
  if (mode === 'unlimited') return false
  if (mode === 'none') return true
  const left = cap - spent
  return left < Math.max(0.5, cap * 0.05)
}
