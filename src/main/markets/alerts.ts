// Price alerts: "AAPL below 180", "NVDA moves ±5% in a day", "TSLA above $300", "MSFT drops 3% in a day".
// An alert is a routine whose prompt starts with ALERT_TAG and a JSON spec. When it runs, the app checks
// the condition with plain data calls (no model), and only writes to the chat and notifies when it fires.

import { normalizeSymbol } from './symbols'

export const ALERT_TAG = '[price-alert]'

export interface AlertSpec {
  symbol: string
  kind: 'below' | 'above' | 'move'
  /** Price level for below/above; percent (5 = 5%) for move. */
  threshold: number
  /** For move: which way counts. */
  direction?: 'up' | 'down' | 'either'
  /** Keep checking after it fires (re-arms once the condition has cleared). Default false: stop after firing. */
  repeat?: boolean
}

/**
 * Parses plain-English alert conditions. Returns null when it can't tell what's meant (the tool then
 * asks for the structured form). Accepts: "<SYM> below|under|<|drops below|falls below <price>",
 * "<SYM> above|over|>|rises above|hits|reaches <price>", "<SYM> moves|swings ±N% [in a day]",
 * "<SYM> up|rises|jumps|gains N%", "<SYM> down|drops|falls|loses N%".
 */
export function parseAlert(text: string): AlertSpec | null {
  const s = text.trim().replace(/\s+/g, ' ')
  const m = /^\$?([A-Za-z^][A-Za-z0-9.\-=^]{0,14})\b\s*(.*)$/.exec(s)
  if (!m) return null
  const sym = normalizeSymbol(m[1])
  if (!sym) return null
  const rest = m[2].toLowerCase().replace(/\bin (a|one|1) (day|session)\b|\bdaily\b|\bintraday\b|\bin a single day\b/g, '').trim()
  const num = (x: string): number => Number(x.replace(/[$,]/g, ''))
  let r: RegExpExecArray | null
  if ((r = /^(?:moves?|swings?|changes?|goes)\s*(?:by\s*)?(?:±|\+\/-|\+-|plus or minus)?\s*(?:more than\s*|over\s*|at least\s*)?(\d+(?:\.\d+)?)\s*%/.exec(rest))) {
    return { symbol: sym.display, kind: 'move', threshold: num(r[1]), direction: 'either' }
  }
  if ((r = /^(?:is\s*)?(?:up|rises?|jumps?|gains?|climbs?|surges?)\s*(?:by\s*)?(?:more than\s*|over\s*|at least\s*)?(\d+(?:\.\d+)?)\s*%/.exec(rest))) {
    return { symbol: sym.display, kind: 'move', threshold: num(r[1]), direction: 'up' }
  }
  if ((r = /^(?:is\s*)?(?:down|drops?|falls?|loses?|declines?|sinks?|tanks?)\s*(?:by\s*)?(?:more than\s*|over\s*|at least\s*)?(\d+(?:\.\d+)?)\s*%/.exec(rest))) {
    return { symbol: sym.display, kind: 'move', threshold: num(r[1]), direction: 'down' }
  }
  if ((r = /^(?:is\s*|goes\s*|trades\s*|closes\s*)?(?:below|under|<=?|drops? (?:below|under|to)|falls? (?:below|under|to)|dips? (?:below|under|to))\s*\$?([\d,]+(?:\.\d+)?)\b/.exec(rest))) {
    return { symbol: sym.display, kind: 'below', threshold: num(r[1]) }
  }
  if ((r = /^(?:is\s*|goes\s*|trades\s*|closes\s*)?(?:above|over|>=?|rises? (?:above|over|to)|hits|reaches|breaks(?: above)?|crosses(?: above)?)\s*\$?([\d,]+(?:\.\d+)?)\b/.exec(rest))) {
    return { symbol: sym.display, kind: 'above', threshold: num(r[1]) }
  }
  return null
}

export function describeAlert(a: AlertSpec): string {
  if (a.kind === 'below') return `${a.symbol} at or below $${a.threshold}`
  if (a.kind === 'above') return `${a.symbol} at or above $${a.threshold}`
  const dir = a.direction === 'up' ? 'up' : a.direction === 'down' ? 'down' : '±'
  return `${a.symbol} ${dir === '±' ? 'moves ±' : `${dir} `}${a.threshold}% or more in a day`
}

export function alertPrompt(a: AlertSpec): string {
  return `${ALERT_TAG} ${JSON.stringify(a)}\nPrice alert: tell me when ${describeAlert(a)}. (SahilBot checks this itself with market data; no action is taken.)`
}

/** The alert spec in a routine's prompt, or null when it isn't a price alert. */
export function alertFromPrompt(prompt: string): AlertSpec | null {
  if (!prompt.startsWith(ALERT_TAG)) return null
  const line = prompt.slice(ALERT_TAG.length).split('\n')[0].trim()
  try {
    const a = JSON.parse(line) as AlertSpec
    if (!a || typeof a.symbol !== 'string' || !['below', 'above', 'move'].includes(a.kind) || !(a.threshold > 0)) return null
    return a
  } catch { return null }
}

export interface AlertObservation {
  price: number
  /** Previous session's close (for daily moves). */
  prevClose?: number
  /** When the price is from (ms). */
  asOf: number
}

/** Whether the condition holds now, and the change used for move alerts. */
export function checkAlert(a: AlertSpec, o: AlertObservation): { hit: boolean; changePct?: number } {
  if (a.kind === 'below') return { hit: o.price <= a.threshold }
  if (a.kind === 'above') return { hit: o.price >= a.threshold }
  if (!o.prevClose || !(o.prevClose > 0)) return { hit: false }
  const ch = (o.price / o.prevClose - 1) * 100
  const hit = a.direction === 'up' ? ch >= a.threshold : a.direction === 'down' ? ch <= -a.threshold : Math.abs(ch) >= a.threshold
  return { hit, changePct: ch }
}

/** New York wall-clock parts for a time. */
function nyParts(t: Date): { wd: number; minutes: number; ymd: string } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' })
  const parts = Object.fromEntries(f.formatToParts(t).map((p) => [p.type, p.value]))
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)
  const hour = Number(parts.hour) % 24
  return { wd, minutes: hour * 60 + Number(parts.minute), ymd: `${parts.year}-${parts.month}-${parts.day}` }
}

/** US regular session (9:30-16:00 New York time, Monday-Friday). Exchange holidays are not known here. */
export function usMarketOpen(t: Date): boolean {
  const p = nyParts(t)
  return p.wd >= 1 && p.wd <= 5 && p.minutes >= 9 * 60 + 30 && p.minutes < 16 * 60
}

/** New York calendar date (YYYY-MM-DD) of a time: used so a daily alert fires at most once per session. */
export function nyDate(t: Date): string {
  return nyParts(t).ymd
}

/**
 * The local-time cron for checking an alert: every 15 minutes across the US session on weekdays when a
 * live quote source is set, otherwise once a day shortly after the close (daily closes only change then).
 * Hours are converted from New York time to this Mac's zone (padded an hour for daylight-saving gaps).
 */
export function alertCron(live: boolean, now = new Date()): string {
  const offsetMin = (d: Date): number => {
    const ny = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }))
    const here = new Date(d.toLocaleString('en-US'))
    return Math.round((here.getTime() - ny.getTime()) / 60_000)
  }
  const off = offsetMin(now)
  const local = (nyMinutes: number): number => (((nyMinutes + off) % 1440) + 1440) % 1440
  if (!live) {
    const m = local(16 * 60 + 40)
    return `${m % 60} ${Math.floor(m / 60)} * * *`
  }
  const start = Math.floor(local(9 * 60 + 30) / 60)
  const end = Math.floor(local(16 * 60) / 60)
  const hours = start <= end ? `${Math.max(0, start - 1)}-${Math.min(23, end)}` : '*'
  return `*/15 ${hours} * * *`
}
