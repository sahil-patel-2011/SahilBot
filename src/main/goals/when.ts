import { usMarketOpen } from '../markets/alerts'

// "When should I wake up?" in the words a bot writes for follow_up: "in 2h", "tomorrow 9am",
// "monday at 8:30", "tonight", "when market opens", or an ISO date/time (local). Pure: no clock of
// its own, so it can be unit tested.

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** "9am", "9:30 pm", "17:30", "noon", "midnight" → [hours, minutes], or null. */
export function parseClock(s: string): [number, number] | null {
  const t = s.trim().toLowerCase()
  if (/^noon$|^midday$/.test(t)) return [12, 0]
  if (/^midnight$/.test(t)) return [0, 0]
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/.exec(t)
  if (!m) return null
  let h = Number(m[1])
  const mi = Number(m[2] ?? 0)
  const ap = m[3]?.[0]
  // A bare number needs am/pm or a colon to be a time ("in 3" is not 3 o'clock).
  if (!ap && m[2] === undefined) return null
  if (mi > 59 || h > 23 || (ap && (h < 1 || h > 12))) return null
  if (ap === 'p' && h < 12) h += 12
  if (ap === 'a' && h === 12) h = 0
  return [h, mi]
}

const at = (base: Date, [h, m]: [number, number], addDays = 0): Date => {
  const d = new Date(base)
  d.setDate(d.getDate() + addDays)
  d.setHours(h, m, 0, 0)
  return d
}

/** The next US market open (9:30 New York, Monday-Friday) after `now`, plus a few minutes for quotes to settle. */
export function nextMarketOpen(now: Date, settleMin = 5): Date {
  return marketEdge(now, true, settleMin)
}

/** The next US market close (16:00 New York) after `now`, plus a few minutes for closing prices. */
export function nextMarketClose(now: Date, settleMin = 10): Date {
  return marketEdge(now, false, settleMin)
}

function marketEdge(now: Date, opening: boolean, settleMin: number): Date {
  // The session opens at :30 and closes at :00 New York time, so a half-hour grid lands on both exactly
  // (zones that are whole or half hours from New York; others are found within half an hour).
  const t = new Date(now)
  t.setSeconds(0, 0)
  t.setMinutes(t.getMinutes() < 30 ? 30 : 60)
  for (let i = 0; i < 10 * 48; i++, t.setTime(t.getTime() + 30 * MIN)) {
    const open = usMarketOpen(t)
    const before = usMarketOpen(new Date(t.getTime() - 30 * MIN))
    if (opening ? open && !before : !open && before) return new Date(t.getTime() + settleMin * MIN)
  }
  return new Date(now.getTime() + DAY)
}

const UNITS: Record<string, number> = {
  m: MIN, min: MIN, mins: MIN, minute: MIN, minutes: MIN,
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
  d: DAY, day: DAY, days: DAY,
  w: 7 * DAY, wk: 7 * DAY, week: 7 * DAY, weeks: 7 * DAY
}

/**
 * When `text` means, strictly after `now`, or null if it isn't understood. Days without a time mean
 * 9:00 local; a time of day that already passed today means tomorrow.
 */
export function parseWhen(text: string, now: Date): Date | null {
  const s = text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,!]+$/, '')
  if (!s) return null

  // ISO-ish: 2026-11-14, 2026-11-14 09:30, 2026-11-14T09:30(:00)
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(s)
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), iso[4] ? Number(iso[4]) : 9, iso[5] ? Number(iso[5]) : 0, 0, 0)
    return Number.isNaN(d.getTime()) || d <= now ? null : d
  }

  if (/\bmarkets? (opens?|opening)\b|\bmarket open\b|\bopening bell\b/.test(s)) return nextMarketOpen(now)
  if (/\bmarkets? (closes?|closing)\b|\bmarket close\b|\bclosing bell\b|\bafter (the )?close\b/.test(s)) return nextMarketClose(now)

  if (/^(now|asap|soon|shortly|right away)$/.test(s)) return new Date(now.getTime() + 15 * MIN)

  // "in 2h", "in 90 minutes", "in an hour", "in half an hour", "in 1h30m", "2 hours from now"
  const rel = /^(?:in )?(.+?)(?: from now| later)?$/.exec(s)
  if (rel && (s.startsWith('in ') || / from now$| later$/.test(s))) {
    const body = rel[1].replace(/^half an? hour$/, '30 minutes').replace(/^an? /, '1 ')
    let total = 0
    let matched = ''
    for (const m of body.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)) {
      const unit = UNITS[m[2]]
      if (!unit) return null
      total += Number(m[1]) * unit
      matched += m[0]
    }
    if (total > 0 && matched.replace(/\s/g, '') === body.replace(/\s|and/g, '')) return new Date(now.getTime() + total)
  }

  // Strip filler: "on", "at", "next", "this", "the"
  const words = s.replace(/\b(on|at|by|around|the)\b/g, ' ').replace(/\s+/g, ' ').trim()

  const part = (w: string): [number, number] | null => {
    if (/^(morning)$/.test(w)) return [9, 0]
    if (/^(afternoon)$/.test(w)) return [14, 0]
    if (/^(evening)$/.test(w)) return [18, 0]
    if (/^(night)$/.test(w)) return [20, 0]
    return parseClock(w)
  }

  if (/^tonight$/.test(words)) {
    const d = at(now, [20, 0])
    return d > now ? d : at(now, [20, 0], 1)
  }
  if (/^this (morning|afternoon|evening)$/.test(words)) {
    const d = at(now, part(words.split(' ')[1])!)
    return d > now ? d : null
  }

  // tomorrow [time | morning | evening]
  const tm = /^tomorrow(?: (.+))?$/.exec(words)
  if (tm) {
    const c = tm[1] ? part(tm[1]) : [9, 0] as [number, number]
    return c ? at(now, c, 1) : null
  }

  // next week → next Monday 9:00
  if (/^next week$/.test(words)) {
    const add = ((1 - now.getDay() + 7) % 7) || 7
    return at(now, [9, 0], add)
  }

  // [next] monday [time]
  const wd = /^(?:next |this )?(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*(?: (.+))?$/.exec(words)
  if (wd) {
    const idx = DAYS.findIndex((d) => d.startsWith(wd[1].slice(0, 3)))
    if (idx < 0) return null
    const c = wd[2] ? part(wd[2]) : [9, 0] as [number, number]
    if (!c) return null
    let add = (idx - now.getDay() + 7) % 7
    // "monday" on a Monday after that time, or "next monday" on a Monday: a week from today.
    if (add === 0 && (at(now, c) <= now || /^next /.test(words))) add = 7
    return at(now, c, add)
  }

  // A time of day: today if it's still ahead, else tomorrow.
  const c = part(words)
  if (c) {
    const d = at(now, c)
    return d > now ? d : at(now, c, 1)
  }
  return null
}
