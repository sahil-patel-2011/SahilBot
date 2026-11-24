import type { Schedule } from './types'

export type When = Extract<Schedule, { type: 'when' }>

export const WHEN_KIND_WORD: Record<When['kind'], string> = {
  email: 'an email', chat: 'a message', calendar: 'a calendar event', meetings: 'a meeting note', crm: 'a CRM update', docs: 'a doc change', accounting: 'an accounting entry', any: 'something new'
}

/** "When an email from acme.com mentioning invoice arrives". */
export function describeWhen(w: When): string {
  return `When ${WHEN_KIND_WORD[w.kind] ?? 'something new'}${w.from ? ` from ${w.from}` : ''}${w.contains ? ` mentioning ${w.contains}` : ''} arrives`
}

/** "ET", "PT", "GMT+1"…: a short name for a schedule's time zone (the generic one, so it's right all year). */
export function tzLabel(tz: string | undefined): string {
  if (!tz) return ''
  try {
    const generic = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortGeneric' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? ''
    // "ET", "PT", "CT", "MT": the short generic name, where there is one.
    if (generic && generic.length <= 4 && !/^GMT/.test(generic)) return generic
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? tz
  } catch { return tz }
}

/** A schedule's description with its place's time zone, when it has one ("every day at 7:30 ET"). */
export function withTz(text: string, s: Schedule): string {
  const tz = 'tz' in s ? s.tz : undefined
  return tz ? `${text} ${tzLabel(tz)}` : text
}

// Schedules in words, the same everywhere: the routines screens (renderer/src/routines.ts), the schedule tool's
// replies the model relays, and the chat's routine lines. "Weekdays at 7:30 AM ET", never "mon, tue … at 07:30".

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function clockOf(h: number, m: number): string {
  const hh = h % 12 === 0 ? 12 : h % 12
  return `${hh}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

/** "09:00" → "9:00 AM", "17:30" → "5:30 PM". */
export function clock(time: string): string {
  const [h, m] = time.split(':').map(Number)
  if (Number.isNaN(h)) return time
  return clockOf(h, Number.isNaN(m) ? 0 : m ?? 0)
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

/** The same on a place's clock ("Wed, Nov 25 at 7:30 AM" in New York, whatever zone the Mac is in). */
export function dateTimeIn(ms: number, tz?: string): string {
  if (!tz) return dateTime(new Date(ms))
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
    const dow = DAY_SHORT.indexOf(p.weekday)
    if (dow < 0) return dateTime(new Date(ms))
    return `${DAY_SHORT[dow]}, ${MONTHS[Number(p.month) - 1]} ${Number(p.day)} at ${clockOf(Number(p.hour) % 24, Number(p.minute))}`
  } catch { return dateTime(new Date(ms)) }
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

/** A one-off's time that already names its moment ("…Z", "…-05:00"), not a wall-clock time. */
export const hasOffset = (at: string): boolean => /(z|[+-]\d\d:?\d\d)$/i.test(at)

/** A schedule the way a person would say it: "Weekdays at 8:00 AM", "Every 2 hours", "Once · Thu, Nov 12 at 9:00 AM". */
export function describeSchedule(s: Schedule): string {
  return withTz(describeBase(s), s)
}

function describeBase(s: Schedule): string {
  switch (s.type) {
    case 'when':
      return describeWhen(s)
    case 'once': {
      const d = new Date(s.at)
      if (Number.isNaN(d.getTime())) return 'Once'
      // A wall-clock time reads as written; a real moment ("in 3 minutes") reads on the place's clock, or the Mac's.
      return `Once · ${s.tz && hasOffset(s.at) ? dateTimeIn(d.getTime(), s.tz) : dateTime(d)}`
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

/**
 * When a routine runs next: on its place's clock when it has one ("Wed, Nov 25 at 7:30 AM ET"), else on the Mac's
 * ("Wed, Nov 25 at 4:30 AM"). '' when it won't run again.
 */
export function nextLabel(s: Schedule, nextRun: number | null | undefined): string {
  if (nextRun === null || nextRun === undefined || !Number.isFinite(nextRun)) return ''
  const tz = 'tz' in s ? s.tz : undefined
  return tz ? `${dateTimeIn(nextRun, tz)} ${tzLabel(tz)}` : dateTime(new Date(nextRun))
}
