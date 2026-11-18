import type { BrainApi, BrainSettings } from '@shared/brain'
import { DEFAULT_BRAIN } from '@shared/brain'

// The brain's settings, stored as one object in the settings table ('brain:settings'). Junk reads as the
// default; every number is clamped, so a bad value can never make the brain spend more or run more often.

export const SETTINGS_KEY = 'brain:settings'
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const SOURCE_ID = /^[\w-]{1,40}$/

const num = (v: unknown, def: number, min: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def)
const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

export function cleanBrainSettings(v: unknown): BrainSettings {
  const x = obj(v)
  const d = DEFAULT_BRAIN
  const sources: Record<string, boolean> = {}
  for (const [k, on] of Object.entries(obj(x.sources)).slice(0, 60)) if (SOURCE_ID.test(k) && typeof on === 'boolean') sources[k] = on
  const q = obj(x.quietHours)
  const pre = obj(x.preApproved)
  return {
    paused: bool(x.paused, d.paused),
    sources,
    dailyUsd: Math.round(num(x.dailyUsd, d.dailyUsd, 0, 20) * 100) / 100,
    backfillDays: Math.round(num(x.backfillDays, d.backfillDays, 1, 90)),
    maxItemsPerSync: Math.round(num(x.maxItemsPerSync, d.maxItemsPerSync, 5, 300)),
    activeMinutes: Math.round(num(x.activeMinutes, d.activeMinutes, 5, 240)),
    agentMode: bool(x.agentMode, d.agentMode),
    quietHours: { start: typeof q.start === 'string' && HHMM.test(q.start) ? q.start : d.quietHours.start, end: typeof q.end === 'string' && HHMM.test(q.end) ? q.end : d.quietHours.end },
    maxPromptsPerDay: Math.round(num(x.maxPromptsPerDay, d.maxPromptsPerDay, 0, 20)),
    // Only drafting can be pre-approved: there is deliberately no "always send".
    preApproved: { draft: bool(pre.draft, d.preApproved.draft) },
    usePlan: bool(x.usePlan, d.usePlan)
  }
}

/** The user's change applied to the current settings (only known keys; sources merge). */
export function patchBrainSettings(cur: BrainSettings, patch: Parameters<BrainApi['setSettings']>[0]): BrainSettings {
  const p = obj(patch)
  const next: Record<string, unknown> = { ...cur, sources: { ...cur.sources }, quietHours: { ...cur.quietHours }, preApproved: { ...cur.preApproved } }
  for (const k of ['paused', 'dailyUsd', 'backfillDays', 'maxItemsPerSync', 'activeMinutes', 'agentMode', 'maxPromptsPerDay', 'usePlan'] as const) if (k in p) next[k] = p[k]
  for (const [k, on] of Object.entries(obj(p.sources))) if (SOURCE_ID.test(k) && typeof on === 'boolean') (next.sources as Record<string, boolean>)[k] = on
  Object.assign(next.quietHours as object, obj(p.quietHours))
  Object.assign(next.preApproved as object, obj(p.preApproved))
  return cleanBrainSettings(next)
}

/** "21:00" → minutes after midnight. */
export const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** Inside quiet hours (local time); a window that crosses midnight ("21:00" → "08:00") works too. */
export function inQuietHours(q: BrainSettings['quietHours'], now: number): boolean {
  const d = new Date(now)
  const m = d.getHours() * 60 + d.getMinutes()
  const a = minutesOf(q.start), b = minutesOf(q.end)
  if (a === b) return false
  return a < b ? m >= a && m < b : m >= a || m < b
}

/** When quiet hours end next (ms), or `now` when it isn't quiet. */
export function quietEnds(q: BrainSettings['quietHours'], now: number): number {
  if (!inQuietHours(q, now)) return now
  const d = new Date(now)
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(q.end.slice(0, 2)), Number(q.end.slice(3, 5)))
  if (end.getTime() <= now) end.setDate(end.getDate() + 1)
  return end.getTime()
}
