// Routines (scheduled tasks) in words, for the bot details panel and the Scheduled screen.
// Pure helpers: no DOM, no api, so they can be unit tested.
import type { LibraryItem, Schedule, ScheduledTask } from '@shared/types'

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "09:00" → "9:00 AM", "17:30" → "5:30 PM". */
export function clock(time: string): string {
  const [h, m] = time.split(':').map(Number)
  if (Number.isNaN(h)) return time
  return clockOf(h, Number.isNaN(m) ? 0 : m ?? 0)
}

function clockOf(h: number, m: number): string {
  const hh = h % 12 === 0 ? 12 : h % 12
  return `${hh}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** Day indexes (0 = Sunday) in words: "Weekdays", "Weekends", "Every day", "Monday", "Mon, Wed, Fri". */
function daysInWords(idx: number[]): string {
  const set = [...new Set(idx)].filter((d) => d >= 0 && d <= 6)
  const has = (xs: number[]): boolean => xs.length === set.length && xs.every((d) => set.includes(d))
  if (set.length === 7) return 'Every day'
  if (has([1, 2, 3, 4, 5])) return 'Weekdays'
  if (has([0, 6])) return 'Weekends'
  if (set.length === 1) return `Every ${DAY_LONG[set[0]]}`
  // Monday first, the way people say a week.
  return set.sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_SHORT[d]).join(', ')
}

function every(minutes: number): string {
  const n = Math.max(1, Math.round(minutes))
  if (n % 1440 === 0) return n === 1440 ? 'Every day' : `Every ${n / 1440} days`
  if (n % 60 === 0) return n === 60 ? 'Every hour' : `Every ${n / 60} hours`
  return n === 1 ? 'Every minute' : `Every ${n} minutes`
}

/** "Thu, Nov 12 at 9:00 AM" (local time). */
export function dateTime(d: Date): string {
  return `${DAY_SHORT[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()} at ${clockOf(d.getHours(), d.getMinutes())}`
}

/** Expands a cron day-of-week field ("1-5", "0,6", "mon") to day indexes, or null if it's not that simple. */
function cronDays(f: string): number[] | null {
  const out: number[] = []
  for (const part of f.toLowerCase().split(',')) {
    const name = (s: string): number => (/^\d$/.test(s) ? Number(s) % 7 : DAY_KEYS.indexOf(s.slice(0, 3)))
    const [a, b] = part.split('-')
    const x = name(a)
    const y = b === undefined ? x : name(b)
    if (x < 0 || y < 0 || part.includes('/')) return null
    for (let d = x; d <= (y < x ? y + 7 : y); d++) out.push(d % 7)
  }
  return out
}

/** A schedule the way a person would say it: "Weekdays at 8:00 AM", "Every 2 hours", "Once · Thu, Nov 12 at 9:00 AM". */
export function describeSchedule(s: Schedule): string {
  switch (s.type) {
    case 'once': {
      const d = new Date(s.at)
      return Number.isNaN(d.getTime()) ? 'Once' : `Once · ${dateTime(d)}`
    }
    case 'every':
      return every(s.minutes)
    case 'daily':
      return `Every day at ${clock(s.time)}`
    case 'weekly': {
      const idx = s.days.map((d) => DAY_KEYS.indexOf(d.slice(0, 3).toLowerCase())).filter((d) => d >= 0)
      return idx.length ? `${daysInWords(idx)} at ${clock(s.time)}` : `Weekly at ${clock(s.time)}`
    }
    case 'cron': {
      const f = s.expr.trim().split(/\s+/)
      if (f.length !== 5) return 'Custom schedule'
      const [mi, h, dom, mo, dow] = f
      const num = (x: string, max: number): number | null => (/^\d+$/.test(x) && Number(x) <= max ? Number(x) : null)
      const step = (x: string): number | null => { const m = /^\*\/(\d+)$/.exec(x); return m ? Number(m[1]) : null }
      if (dom === '*' && mo === '*') {
        const days = dow === '*' ? null : cronDays(dow)
        if (dow === '*' || days) {
          const prefix = days ? daysInWords(days) : 'Every day'
          const M = num(mi, 59)
          const H = num(h, 23)
          if (M !== null && H !== null) return `${prefix} at ${clockOf(H, M)}`
          if (dow === '*') {
            if (step(mi) && h === '*') return every(step(mi)!)
            if (mi === '*' && h === '*') return 'Every minute'
            if (M !== null && h === '*') return M === 0 ? 'Every hour' : `Every hour at :${String(M).padStart(2, '0')}`
            if (M !== null && step(h)) return every(step(h)! * 60)
          }
        }
      }
      if (num(mi, 59) !== null && num(h, 23) !== null && num(dom, 31) !== null && mo === '*' && dow === '*') {
        const d = Number(dom)
        const ord = d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'
        return `Monthly on the ${d}${ord} at ${clockOf(Number(h), Number(mi))}`
      }
      return `Custom schedule (${s.expr.trim()})`
    }
  }
}

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
