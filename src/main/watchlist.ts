import type { WatchlistItem } from '@shared/types'

// The stock watchlist: a short ordered list of symbols with the last values seen, kept in settings.

const KEY = 'watchlist'
const MAX = 60

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Keeps only well-formed items: upper-case symbols (no duplicates), finite numbers, a short sparkline. */
export function cleanWatchlist(raw: unknown): WatchlistItem[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: WatchlistItem[] = []
  for (const x of raw as Array<Partial<WatchlistItem> | null>) {
    const symbol = typeof x?.symbol === 'string' ? x.symbol.trim().toUpperCase() : ''
    if (!/^[A-Z0-9.\-^=]{1,15}$/.test(symbol) || seen.has(symbol)) continue
    seen.add(symbol)
    const item: WatchlistItem = { symbol }
    if (typeof x!.name === 'string' && x!.name.trim()) item.name = x!.name.trim().slice(0, 80)
    if (typeof x!.currency === 'string' && /^[A-Za-z]{3}$/.test(x!.currency)) item.currency = x!.currency.toUpperCase()
    for (const k of ['price', 'changeAbs', 'changePct', 'asOf'] as const) {
      const v = num(x![k])
      if (v !== undefined) item[k] = v
    }
    if (Array.isArray(x!.spark)) {
      const s = x!.spark.filter((v): v is number => num(v) !== undefined).slice(-60)
      if (s.length) item.spark = s
    }
    out.push(item)
    if (out.length >= MAX) break
  }
  return out
}

export function getWatchlist(db: { getSetting<T>(k: string): T | undefined }): WatchlistItem[] {
  return cleanWatchlist(db.getSetting<unknown>(KEY))
}

export function setWatchlist(db: { setSetting(k: string, v: unknown): void }, items: unknown): WatchlistItem[] {
  const clean = cleanWatchlist(items)
  db.setSetting(KEY, clean)
  return clean
}
