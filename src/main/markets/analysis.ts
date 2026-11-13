// Turns price history into the numbers a person (and the stock card) needs: technicals, risk, returns,
// and the StockCardData the chat renders. Pure functions.

import type { StockCardData } from '@shared/types'
import { alignedReturns, atr, betaCorr, bollinger, ewmaVol, logReturns, macd, maxDrawdown, range52w, realizedVol, rsi, sharpe, sma, sortino, trailingReturn, returns as simpleReturns } from './indicators'
import { fitGarch } from './garch'
import type { Bar, Fundamentals, Quote } from './types'

export const NOT_ADVICE = 'Not financial advice.'

export interface TechStats {
  last: number
  asOf: number
  change1d?: number
  changeAbs1d?: number
  return1w: number
  return1m: number
  return3m: number
  return6m: number
  return1y: number
  returnYtd: number
  high52: number
  low52: number
  rangePosition: number
  sma20: number
  sma50: number
  sma200: number
  rsi14: number
  macd: number
  macdSignal: number
  macdHist: number
  bollPercentB: number
  atr14: number
  atrPct: number
  vol1m: number
  vol1y: number
  ewmaVol: number
  garchVolNow: number
  garchVolLongRun: number
  garchPersistence: number
  maxDrawdown1y: number
  maxDrawdownAll: number
  sharpe1y: number
  sortino1y: number
  sharpe5y: number
  volume: number
  avgVolume3m: number
  sessions: number
  firstDate: number
}

const lastOf = (xs: number[]): number => xs[xs.length - 1]

export function techStats(bars: Bar[]): TechStats {
  if (bars.length < 2) throw new Error('Not enough price history.')
  const closes = bars.map((b) => b.c)
  const lr = logReturns(closes)
  const sr = simpleReturns(closes)
  const last = bars[bars.length - 1]
  const m = macd(closes)
  const yStart = Date.UTC(new Date(last.t).getUTCFullYear(), 0, 1)
  const before = bars.filter((b) => b.t < yStart)
  const ytdBase = before.length ? before[before.length - 1].c : NaN
  const atr14 = lastOf(atr(bars, 14))
  const g = fitGarch(lr.slice(-1260))
  const r52 = range52w(bars)
  return {
    last: last.c, asOf: last.t,
    change1d: bars.length >= 2 ? last.c / bars[bars.length - 2].c - 1 : undefined,
    changeAbs1d: bars.length >= 2 ? last.c - bars[bars.length - 2].c : undefined,
    return1w: trailingReturn(closes, 5), return1m: trailingReturn(closes, 21), return3m: trailingReturn(closes, 63),
    return6m: trailingReturn(closes, 126), return1y: trailingReturn(closes, 252), returnYtd: last.c / ytdBase - 1,
    high52: r52.high, low52: r52.low, rangePosition: r52.position,
    sma20: lastOf(sma(closes, 20)), sma50: lastOf(sma(closes, 50)), sma200: lastOf(sma(closes, 200)),
    rsi14: lastOf(rsi(closes, 14)),
    macd: lastOf(m.macd), macdSignal: lastOf(m.signal), macdHist: lastOf(m.hist),
    bollPercentB: lastOf(bollinger(closes).percentB),
    atr14, atrPct: atr14 / last.c,
    vol1m: realizedVol(lr, 21), vol1y: realizedVol(lr, 252), ewmaVol: ewmaVol(lr.slice(-1000)),
    garchVolNow: Math.sqrt(g.nextVar * 252), garchVolLongRun: Math.sqrt(g.longRunVar * 252), garchPersistence: g.persistence,
    maxDrawdown1y: maxDrawdown(closes.slice(-253)).maxDrawdown, maxDrawdownAll: maxDrawdown(closes).maxDrawdown,
    sharpe1y: sharpe(sr.slice(-252)), sortino1y: sortino(sr.slice(-252)), sharpe5y: sharpe(sr.slice(-1260)),
    volume: last.v, avgVolume3m: bars.slice(-63).reduce((s, b) => s + b.v, 0) / Math.min(63, bars.length),
    sessions: bars.length, firstDate: bars[0].t
  }
}

/** Beta and correlation against a benchmark over the last `days` common sessions. */
export function vsBenchmark(bars: Bar[], bench: Bar[], days = 252): { beta: number; corr: number; n: number } {
  const mine = bars.slice(-(days + 40))
  const from = mine[0]?.t ?? 0
  const al = alignedReturns(mine, bench.filter((b) => b.t >= from - 7 * 86_400_000))
  return betaCorr(al.a.slice(-days), al.b.slice(-days))
}

// ---------------------------------------------------------------- formatting

export const pct = (x: number | undefined, d = 1): string => (x === undefined || !Number.isFinite(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`)
export const pctU = (x: number | undefined, d = 1): string => (x === undefined || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(d)}%`)
export const num = (x: number | undefined, d = 2): string => (x === undefined || !Number.isFinite(x) ? 'n/a' : x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }))
export function money(x: number | undefined, cur = 'USD'): string {
  if (x === undefined || !Number.isFinite(x)) return 'n/a'
  const sym = cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : cur === 'JPY' ? '¥' : ''
  return `${sym}${num(x, Math.abs(x) >= 1000 ? 0 : 2)}${sym ? '' : ` ${cur}`}`
}
export function big(x: number | undefined, cur = 'USD'): string {
  if (x === undefined || !Number.isFinite(x)) return 'n/a'
  const a = Math.abs(x)
  const [v, u] = a >= 1e12 ? [x / 1e12, 'T'] : a >= 1e9 ? [x / 1e9, 'B'] : a >= 1e6 ? [x / 1e6, 'M'] : a >= 1e3 ? [x / 1e3, 'K'] : [x, '']
  return `${cur === 'USD' ? '$' : ''}${v.toFixed(Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2)}${u}`
}
export const date = (t: number): string => new Date(t).toISOString().slice(0, 10)

/** "Last close on 2026-11-12 (Stooq daily closes)" or "Live price 2026-11-13 10:41 ET (Finnhub)". */
export function priceLine(q: Quote, cur = 'USD'): string {
  if (q.live) {
    const when = new Date(q.asOf).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    return `${money(q.price, cur)} (live/delayed quote, ${when} New York time, ${q.source})`
  }
  return `${money(q.price, cur)} (last daily close on ${date(q.asOf)}, ${q.source}; not a live price)`
}

export function footer(source: string, asOf: number, live = false): string {
  return `\n\nData: ${source}. As of ${live ? new Date(asOf).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : `the ${date(asOf)} close`}. ${NOT_ADVICE}`
}

// ---------------------------------------------------------------- the card

export function buildCard(o: {
  symbol: string
  name?: string
  currency?: string
  bars: Bar[]
  quote: Quote
  stats: TechStats
  beta?: number
  fundamentals?: Fundamentals | null
  source: string
  disclaimer?: string
}): StockCardData {
  const { stats: s, quote: q, fundamentals: f } = o
  const prev = q.prevClose ?? (q.live ? s.last : o.bars[o.bars.length - 2]?.c)
  const change1d = prev ? q.price / prev - 1 : s.change1d
  const series: Array<[number, number]> = o.bars.slice(-252).map((b) => [b.t, b.c])
  // A live price newer than the last daily bar extends the series so the chart ends at the quote.
  if (q.live && q.asOf > (series[series.length - 1]?.[0] ?? 0) + 6 * 3_600_000) series.push([q.asOf, q.price])
  const finite = (x: number | undefined): number | undefined => (x !== undefined && Number.isFinite(x) ? x : undefined)
  const stats: StockCardData['stats'] = {}
  const put = (k: keyof NonNullable<StockCardData['stats']>, v: number | undefined): void => { const x = finite(v); if (x !== undefined) stats[k] = x }
  put('open', q.live ? q.open : o.bars[o.bars.length - 1].o)
  put('high52', s.high52); put('low52', s.low52)
  put('volume', q.volume ?? s.volume); put('avgVolume', s.avgVolume3m)
  if (f?.sharesOutstanding) put('marketCap', f.sharesOutstanding * q.price)
  if (f?.epsDilutedTtm && f.epsDilutedTtm > 0) put('pe', q.price / f.epsDilutedTtm)
  put('eps', f?.epsDilutedTtm)
  if (f?.dividendsPerShareTtm) put('dividendYield', f.dividendsPerShareTtm / q.price)
  put('beta', o.beta)
  put('volatility', s.vol1y); put('rsi14', s.rsi14); put('sma50', s.sma50); put('sma200', s.sma200)
  put('maxDrawdown', s.maxDrawdown1y); put('return1m', s.return1m); put('return1y', s.return1y)
  return {
    symbol: o.symbol, name: o.name, currency: o.currency ?? 'USD',
    price: q.price, asOf: q.asOf, change1d: finite(change1d),
    changeAbs1d: prev ? q.price - prev : finite(s.changeAbs1d),
    live: q.live,
    series, stats, source: o.source,
    disclaimer: o.disclaimer ?? `${q.live ? 'Quote may be delayed.' : `Last close on ${date(q.asOf)}, not a live price.`} ${NOT_ADVICE}`
  }
}
