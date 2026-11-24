// Routines (scheduled tasks) in words, for the bot details panel and the Scheduled screen.
// Pure helpers: no DOM, no api, so they can be unit tested.
import type { LibraryItem, Schedule, ScheduledTask } from '@shared/types'
import { clock, clockOf, dateTime, describeSchedule, nextLabel } from '@shared/when'

// Schedules in words live in @shared/when, so the schedule tool, the chat's routine lines and these screens all say
// the same thing ("Weekdays at 7:30 AM ET").
export { clock, dateTime, describeSchedule, nextLabel }

/** Start of the local day containing `t`. */
function dayStart(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** A run or file time: "Today at 9:02 AM", "Yesterday at 9:02 AM", "Mon, Nov 9 at 9:02 AM". */
export function when(t: number, now = Date.now()): string {
  const d = new Date(t)
  const at = clockOf(d.getHours(), d.getMinutes())
  const days = Math.round((dayStart(now) - dayStart(t)) / 86_400_000)
  if (days === 0) return `Today at ${at}`
  if (days === 1) return `Yesterday at ${at}`
  if (days === -1) return `Tomorrow at ${at}`
  return dateTime(d)
}

/** A time from `when` inside a line ("· next tomorrow at 7:30 AM"): Today, Yesterday and Tomorrow lowercase there. */
export function midSentence(text: string): string {
  return text.replace(/^(Today|Yesterday|Tomorrow)\b/, (w) => w.toLowerCase())
}

/** A routine's next run beside its schedule: on the place's clock when it has one ("Wed, Nov 25 at 7:30 AM ET"), never the Mac's 4:30. */
export function nextRunText(s: Schedule, nextRun: number, now = Date.now()): string {
  return 'tz' in s && s.tz ? nextLabel(s, nextRun) : when(nextRun, now)
}

export type LibraryGroup = { key: 'today' | 'week' | 'older'; label: string; items: LibraryItem[] }

/** Library items grouped Today / This week (the 6 days before today) / Older, newest first; empty groups dropped. */
export function groupLibrary(items: LibraryItem[], now = Date.now()): LibraryGroup[] {
  const today = dayStart(now)
  const week = today - 6 * 86_400_000
  const groups: LibraryGroup[] = [
    { key: 'today', label: 'Today', items: [] },
    { key: 'week', label: 'This week', items: [] },
    { key: 'older', label: 'Older', items: [] }
  ]
  for (const it of [...items].sort((a, b) => b.at - a.at)) groups[it.at >= today ? 0 : it.at >= week ? 1 : 2].items.push(it)
  return groups.filter((g) => g.items.length)
}

/** "example.com" from a URL; the URL itself if it doesn't parse. */
export function host(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

/**
 * What a routine row says, always true right now: running, done (a one-time that has run), paused, starting
 * (due, about to begin or waiting for the bot to finish a reply), or its schedule.
 */
export function routineStatus(t: Pick<ScheduledTask, 'schedule' | 'enabled' | 'nextRun' | 'lastRun' | 'lastStatus'>, isRunning: boolean, now = Date.now()): string {
  if (isRunning) return 'Running…'
  const at = (ms: number): string => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  if (t.schedule.type === 'once' && t.nextRun === null) return t.lastRun ? `Done · ran ${at(t.lastRun)}` : t.lastStatus?.startsWith('skipped') ? 'Missed (SahilBot was closed)' : 'Done'
  if (!t.enabled) return 'Paused'
  if (t.nextRun !== null && t.nextRun <= now) return 'Starting now…'
  return describeSchedule(t.schedule)
}

// The New routine form (components/RoutineForm.tsx).
export type Repeat = 'once' | 'daily' | 'weekdays' | 'weekly'

/** The schedule the form describes (null when something's missing or in the past). */
export function formSchedule(o: { repeat: Repeat; date: string; time: string; days: string[] }, now = new Date()): Schedule | null {
  if (!/^\d{2}:\d{2}$/.test(o.time)) return null
  if (o.repeat === 'once') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) return null
    const at = `${o.date}T${o.time}:00`
    return new Date(at).getTime() > now.getTime() ? { type: 'once', at } : null
  }
  if (o.repeat === 'daily') return { type: 'daily', time: o.time }
  if (o.repeat === 'weekdays') return { type: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: o.time }
  return o.days.length ? { type: 'weekly', days: o.days, time: o.time } : null
}

/** A short title from what it does ("Send me a science fact" → "Send me a science fact"). */
export function titleFrom(prompt: string): string {
  const t = prompt.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')
  return t.length > 48 ? `${t.slice(0, 47).replace(/\s+\S*$/, '')}…` : t
}
