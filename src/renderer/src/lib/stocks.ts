import { useEffect, useState } from 'react'
import type { StockCardData, WatchlistItem } from '@shared/types'
import { api } from '../api'

// Stock helpers shared by the inline stock card and the watchlist: number formatting, the day change,
// and a tiny watchlist store (persisted through watchlist:get/set, refreshed from stock cards).

// ---------------------------------------------------------------- formatting

export function money(v: number | undefined, currency = 'USD', compact = false): string {
  if (v === undefined || !Number.isFinite(v)) return '–'
  const digits = compact ? undefined : Math.abs(v) >= 1000 ? 0 : Math.abs(v) < 1 ? 4 : 2
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency, notation: compact ? 'compact' : 'standard',
      minimumFractionDigits: compact ? undefined : Math.min(2, digits ?? 2), maximumFractionDigits: compact ? 2 : digits
    }).format(v)
  } catch {
    return `${v.toFixed(2)} ${currency}`
  }
}

/** 2_850_000_000_000 → "2.85T" */
export function abbr(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '–'
  const a = Math.abs(v)
  const [d, s] = a >= 1e12 ? [1e12, 'T'] : a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, '']
  const n = v / d
  return `${n.toFixed(Math.abs(n) >= 100 || d === 1 ? 0 : Math.abs(n) >= 10 ? 1 : 2)}${s}`
}

/** A percent number (1.25 = 1.25%) as "+1.25%". */
export function pct(p: number | undefined, signed = true, digits = 2): string {
  if (p === undefined || !Number.isFinite(p)) return '–'
  const s = Math.abs(p).toFixed(digits)
  return `${signed ? (p > 0 ? '+' : p < 0 ? '−' : '') : p < 0 ? '−' : ''}${s}%`
}

export function signed(v: number, digits = 2): string {
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`
}

export function shortDate(t: number, withYear = false): string {
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) })
}

export function asOfText(t: number): string {
  const d = new Date(t)
  const today = d.toDateString() === new Date().toDateString()
  const time = d.getHours() || d.getMinutes() ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''
  return today ? `today${time ? ` ${time}` : ''}` : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })}${time ? ` ${time}` : ''}`
}

// ---------------------------------------------------------------- units

/**
 * Percent-like stats (returns, yield, volatility, drawdown) may come as fractions (0.12) or percents (12).
 * Decide once per card from the 1-month return or the day change, which the price series can check.
 */
export function percentScale(d: StockCardData): 1 | 100 {
  const s = d.series
  const r1m = d.stats?.return1m
  if (r1m !== undefined && s.length > 15) {
    const last = s[s.length - 1]
    const ago = [...s].reverse().find(([t]) => t <= last[0] - 28 * 864e5)
    if (ago) {
      const r = last[1] / ago[1] - 1
      if (Math.abs(r1m - r * 100) < Math.abs(r1m - r)) return 1
      return 100
    }
  }
  const day = dayChange({ price: d.price, series: d.series })
  const c = d.change1d
  if (day && c !== undefined && Math.abs(day.pct) > 0.01) {
    // change1d reads as a percent (1.2) rather than a fraction (0.012): the stats likely do too.
    if (Math.abs(c - day.pct) < Math.abs(c - day.pct / 100) && Math.abs(c - day.pct) < Math.abs(day.pct) * 0.2) return 1
  }
  return 100
}

/** A percent-like stat as a percent number (12 = 12%). */
export function statPct(v: number | undefined, scale: 1 | 100): number | undefined {
  return v === undefined || !Number.isFinite(v) ? undefined : v * scale
}

/**
 * The day change as { abs, pct } (pct in percent). Worked out from the series (previous close) and
 * cross-checked with change1d, which may be a fraction, a percent or an absolute change.
 */
export function dayChange(d: Pick<StockCardData, 'price' | 'series' | 'change1d'>): { abs: number; pct: number } | null {
  const s = d.series ?? []
  let prev: number | undefined
  if (s.length >= 2) {
    const last = s[s.length - 1][1]
    prev = Math.abs(last - d.price) <= Math.abs(d.price) * 1e-7 ? s[s.length - 2][1] : last
  } else if (s.length === 1 && Math.abs(s[0][1] - d.price) > Math.abs(d.price) * 1e-7) prev = s[0][1]
  const derived = prev ? { abs: d.price - prev, pct: (d.price / prev - 1) * 100 } : null
  const c = d.change1d
  if (c === undefined || !Number.isFinite(c)) return derived
  const asFraction = { abs: d.price - d.price / (1 + c), pct: c * 100 }
  const asPercent = { abs: d.price - d.price / (1 + c / 100), pct: c }
  const asAbs = { abs: c, pct: d.price - c ? (c / (d.price - c)) * 100 : 0 }
  if (!derived) return Math.abs(c) < 0.5 ? asFraction : asPercent
  const best = [asFraction, asPercent, asAbs].sort((a, b) => Math.abs(a.pct - derived.pct) - Math.abs(b.pct - derived.pct))[0]
  // Nothing matches (e.g. a live price vs a stale series): trust the series.
  return Math.abs(best.pct - derived.pct) < Math.max(0.05, Math.abs(derived.pct) * 0.1) ? best : derived
}

export function toWatchItem(d: StockCardData): WatchlistItem {
  const ch = dayChange(d)
  return {
    symbol: d.symbol.toUpperCase(), name: d.name, currency: d.currency, price: d.price, asOf: d.asOf,
    changeAbs: ch?.abs, changePct: ch?.pct, spark: d.series.slice(-30).map(([, v]) => v)
  }
}

// ---------------------------------------------------------------- watchlist store

let items: WatchlistItem[] = []
let loaded: Promise<void> | null = null
const listeners = new Set<(x: WatchlistItem[]) => void>()
/** The latest card data seen this session, by symbol (used when adding, and when no refresh exists). */
const seen = new Map<string, WatchlistItem>()

function emit(next: WatchlistItem[]): void {
  items = next
  listeners.forEach((l) => l(items))
}

function load(): Promise<void> {
  loaded ??= api.watchlist.get().then((x) => emit(x)).catch(() => undefined)
  return loaded
}

async function save(next: WatchlistItem[]): Promise<void> {
  emit(next)
  try { emit(await api.watchlist.set(next)) } catch { /* keep the local list */ }
}

export const watchlist = {
  get: (): WatchlistItem[] => items,
  has: (symbol: string): boolean => items.some((x) => x.symbol === symbol.toUpperCase()),
  async add(symbol: string, data?: WatchlistItem): Promise<void> {
    await load()
    const sym = symbol.trim().toUpperCase()
    if (!sym || items.some((x) => x.symbol === sym)) return
    await save([...items, data ?? seen.get(sym) ?? { symbol: sym }])
  },
  async remove(symbol: string): Promise<void> {
    await load()
    await save(items.filter((x) => x.symbol !== symbol.toUpperCase()))
  },
  async move(symbol: string, to: number): Promise<void> {
    await load()
    const from = items.findIndex((x) => x.symbol === symbol)
    if (from < 0) return
    const next = [...items]
    const [it] = next.splice(from, 1)
    next.splice(Math.max(0, Math.min(next.length, to)), 0, it)
    await save(next)
  },
  /** Newer values for symbols on the list (from a refresh): keeps the order. */
  async update(fresh: WatchlistItem[]): Promise<void> {
    await load()
    const by = new Map(fresh.map((f) => [f.symbol.toUpperCase(), f]))
    let changed = false
    const next = items.map((x) => {
      const f = by.get(x.symbol)
      if (!f || (x.asOf && f.asOf && f.asOf < x.asOf)) return x
      changed = true
      return { ...x, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)), symbol: x.symbol }
    })
    if (changed) await save(next)
  },
  /** A stock card was shown: remember its numbers, and refresh the list entry when they're newer. */
  remember(d: StockCardData): void {
    const w = toWatchItem(d)
    const old = seen.get(w.symbol)
    if (!old || (old.asOf ?? 0) <= (w.asOf ?? 0)) seen.set(w.symbol, w)
    void load().then(() => {
      const cur = items.find((x) => x.symbol === w.symbol)
      if (cur && (cur.asOf ?? 0) < (w.asOf ?? 0)) void watchlist.update([w])
    })
  },
  subscribe(cb: (x: WatchlistItem[]) => void): () => void {
    listeners.add(cb)
    void load()
    return () => { listeners.delete(cb) }
  }
}

export function useWatchlist(): WatchlistItem[] {
  const [list, setList] = useState<WatchlistItem[]>(items)
  useEffect(() => watchlist.subscribe(setList), [])
  return list
}

/** Prefills the composer (App listens) and focuses it; the user reviews and sends. */
export function compose(text: string): void {
  window.dispatchEvent(new CustomEvent('sahilbot:compose', { detail: text }))
}

/** Opens the side panel on the watchlist (App listens). */
export function openWatchlist(): void {
  window.dispatchEvent(new CustomEvent('sahilbot:open-watchlist'))
}
