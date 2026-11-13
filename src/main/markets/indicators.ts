// Technical indicators and risk statistics. Pure functions over plain arrays, oldest value first.
// Indicator arrays keep the input's length and hold NaN where there isn't enough history yet, so index i
// always means "as of bar i" and never uses data after bar i (no look-ahead).
//
// Conventions: returns, volatilities and drawdowns are fractions (0.012 = 1.2%); volatility is
// annualized with 252 trading days unless a function says otherwise.

import type { Bar } from './types'
import { mean, pstd, std, TRADING_DAYS } from './stats'

/** Simple returns c[i]/c[i-1] - 1 (length n - 1). */
export function returns(closes: ArrayLike<number>): number[] {
  const out: number[] = []
  for (let i = 1; i < closes.length; i++) out.push(closes[i] / closes[i - 1] - 1)
  return out
}

/** Log returns ln(c[i]/c[i-1]) (length n - 1). */
export function logReturns(closes: ArrayLike<number>): number[] {
  const out: number[] = []
  for (let i = 1; i < closes.length; i++) out.push(Math.log(closes[i] / closes[i - 1]))
  return out
}

export function sma(values: ArrayLike<number>, n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN)
  let s = 0
  for (let i = 0; i < values.length; i++) {
    s += values[i]
    if (i >= n) s -= values[i - n]
    if (i >= n - 1) out[i] = s / n
  }
  return out
}

/** EMA with alpha 2/(n+1), seeded with the SMA of the first n values (the usual charting convention). */
export function ema(values: ArrayLike<number>, n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN)
  const k = 2 / (n + 1)
  // Start at the first run of n finite values (MACD's signal line feeds an EMA that begins with NaNs).
  let start = 0
  while (start < values.length && !Number.isFinite(values[start])) start++
  if (values.length - start < n) return out
  let prev = 0
  for (let i = start; i < start + n; i++) prev += values[i]
  prev /= n
  out[start + n - 1] = prev
  for (let i = start + n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/** Wilder's RSI (default 14). The first value is at index n. */
export function rsi(closes: ArrayLike<number>, n = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN)
  if (closes.length <= n) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) gain += d; else loss -= d
  }
  gain /= n
  loss /= n
  const val = (): number => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss))
  out[n] = val()
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n
    loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n
    out[i] = val()
  }
  return out
}

export function macd(closes: ArrayLike<number>, fast = 12, slow = 26, signal = 9): { macd: number[]; signal: number[]; hist: number[] } {
  const ef = ema(closes, fast)
  const es = ema(closes, slow)
  const line = ef.map((v, i) => v - es[i])
  const sig = ema(line, signal)
  return { macd: line, signal: sig, hist: line.map((v, i) => v - sig[i]) }
}

/** Bollinger Bands: SMA(n) ± k population standard deviations. */
export function bollinger(closes: ArrayLike<number>, n = 20, k = 2): { mid: number[]; upper: number[]; lower: number[]; percentB: number[] } {
  const mid = sma(closes, n)
  const upper = new Array<number>(closes.length).fill(NaN)
  const lower = new Array<number>(closes.length).fill(NaN)
  const percentB = new Array<number>(closes.length).fill(NaN)
  for (let i = n - 1; i < closes.length; i++) {
    const sd = pstd(Array.prototype.slice.call(closes, i - n + 1, i + 1) as number[])
    upper[i] = mid[i] + k * sd
    lower[i] = mid[i] - k * sd
    percentB[i] = upper[i] === lower[i] ? 0.5 : (closes[i] - lower[i]) / (upper[i] - lower[i])
  }
  return { mid, upper, lower, percentB }
}

/** True range of bar i (the first bar has no previous close: high - low). */
export function trueRange(bars: Bar[]): number[] {
  return bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))))
}

/** Wilder's ATR (default 14): seeded with the mean of the first n true ranges (from bar 1). */
export function atr(bars: Bar[], n = 14): number[] {
  const tr = trueRange(bars)
  const out = new Array<number>(bars.length).fill(NaN)
  if (bars.length <= n) return out
  let a = 0
  for (let i = 1; i <= n; i++) a += tr[i]
  a /= n
  out[n] = a
  for (let i = n + 1; i < bars.length; i++) {
    a = (a * (n - 1) + tr[i]) / n
    out[i] = a
  }
  return out
}

/** Annualized realized volatility of the last `window` log returns (all of them when omitted). */
export function realizedVol(logRets: ArrayLike<number>, window?: number, periodsPerYear = TRADING_DAYS): number {
  const xs = window ? Array.prototype.slice.call(logRets, -window) as number[] : Array.from(logRets)
  return std(xs) * Math.sqrt(periodsPerYear)
}

/**
 * EWMA (RiskMetrics) variance path: s2[i] is the variance forecast for return i made with returns before i.
 * s2[n] (one past the end) is the forecast for the next, unseen return. Daily (not annualized).
 */
export function ewmaVariance(logRets: ArrayLike<number>, lambda = 0.94): number[] {
  const n = logRets.length
  const out = new Array<number>(n + 1).fill(NaN)
  if (n < 2) return out
  // Seed with the variance of the first (up to) 30 returns, around zero (daily mean is ~0).
  const seedN = Math.min(30, n)
  let v = 0
  for (let i = 0; i < seedN; i++) v += logRets[i] ** 2
  v /= seedN
  for (let i = 0; i < n; i++) {
    out[i] = v
    v = lambda * v + (1 - lambda) * logRets[i] ** 2
  }
  out[n] = v
  return out
}

/** Annualized EWMA volatility forecast for the next day. */
export function ewmaVol(logRets: ArrayLike<number>, lambda = 0.94, periodsPerYear = TRADING_DAYS): number {
  const v = ewmaVariance(logRets, lambda)
  return Math.sqrt(v[v.length - 1]) * Math.sqrt(periodsPerYear)
}

/** Beta and correlation of an asset's returns against a benchmark's, over the same dates. */
export function betaCorr(asset: ArrayLike<number>, bench: ArrayLike<number>): { beta: number; corr: number; n: number } {
  const n = Math.min(asset.length, bench.length)
  if (n < 3) return { beta: NaN, corr: NaN, n }
  const a = Array.prototype.slice.call(asset, -n) as number[]
  const b = Array.prototype.slice.call(bench, -n) as number[]
  const ma = mean(a)
  const mb = mean(b)
  let cov = 0, va = 0, vb = 0
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb)
    va += (a[i] - ma) ** 2
    vb += (b[i] - mb) ** 2
  }
  return { beta: vb ? cov / vb : NaN, corr: va && vb ? cov / Math.sqrt(va * vb) : NaN, n }
}

export function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return betaCorr(a, b).corr
}

/**
 * Aligns two bar series on their common dates and returns their simple daily returns over those dates
 * (a return needs both its day and the previous common day). Dates missing from either are skipped.
 */
export function alignedReturns(a: Bar[], b: Bar[]): { a: number[]; b: number[]; dates: number[] } {
  const day = (t: number): number => Math.floor(t / 86_400_000)
  const mb = new Map(b.map((x) => [day(x.t), x.c]))
  const common = a.filter((x) => mb.has(day(x.t)))
  const out = { a: [] as number[], b: [] as number[], dates: [] as number[] }
  for (let i = 1; i < common.length; i++) {
    out.a.push(common[i].c / common[i - 1].c - 1)
    out.b.push(mb.get(day(common[i].t))! / mb.get(day(common[i - 1].t))! - 1)
    out.dates.push(common[i].t)
  }
  return out
}

/** Largest peak-to-trough fall, as a negative fraction (-0.25 = fell 25% from a high), with where it happened. */
export function maxDrawdown(values: ArrayLike<number>): { maxDrawdown: number; peak: number; trough: number } {
  let peak = 0, best = 0, bestPeak = 0, bestTrough = 0
  for (let i = 0; i < values.length; i++) {
    if (values[i] > values[peak]) peak = i
    const dd = values[i] / values[peak] - 1
    if (dd < best) { best = dd; bestPeak = peak; bestTrough = i }
  }
  return { maxDrawdown: best, peak: bestPeak, trough: bestTrough }
}

/** Annualized Sharpe ratio of periodic simple returns; rf is the annual risk-free rate. */
export function sharpe(rets: ArrayLike<number>, rf = 0, periodsPerYear = TRADING_DAYS): number {
  const ex = Array.from(rets, (r) => r - rf / periodsPerYear)
  const sd = std(ex)
  return sd > 0 ? (mean(ex) / sd) * Math.sqrt(periodsPerYear) : NaN
}

/** Annualized Sortino ratio: mean excess return over downside deviation (root mean square of negative excess returns). */
export function sortino(rets: ArrayLike<number>, rf = 0, periodsPerYear = TRADING_DAYS): number {
  const ex = Array.from(rets, (r) => r - rf / periodsPerYear)
  if (!ex.length) return NaN
  const dd = Math.sqrt(ex.reduce((s, r) => s + Math.min(0, r) ** 2, 0) / ex.length)
  return dd > 0 ? (mean(ex) / dd) * Math.sqrt(periodsPerYear) : NaN
}

/** 52-week (last 252 sessions) high and low from the bars' highs and lows, with where today sits in the range (0..1). */
export function range52w(bars: Bar[]): { high: number; low: number; position: number } {
  const last = bars.slice(-TRADING_DAYS)
  if (!last.length) return { high: NaN, low: NaN, position: NaN }
  let high = -Infinity, low = Infinity
  for (const b of last) { if (b.h > high) high = b.h; if (b.l < low) low = b.l }
  const c = last[last.length - 1].c
  return { high, low, position: high > low ? (c - low) / (high - low) : 0.5 }
}

/** Return over the last n sessions (c[-1] / c[-1-n] - 1), NaN when the history is shorter. */
export function trailingReturn(closes: ArrayLike<number>, n: number): number {
  const L = closes.length
  return L > n ? closes[L - 1] / closes[L - 1 - n] - 1 : NaN
}

/**
 * Splits in unadjusted data (some keyed providers): a one-day move that matches a common split ratio
 * (2:1, 3:1, 3:2, 4:1, 5:1, 10:1, 20:1 and reverse 1:5, 1:10...) within 3%, and is larger than 35%, is
 * treated as a split and earlier prices are divided by the ratio. Returns new bars; the input is unchanged.
 */
export function adjustSplits(bars: Bar[]): { bars: Bar[]; splits: Array<{ t: number; ratio: number }> } {
  const ratios = [2, 3, 1.5, 4, 5, 7, 8, 10, 15, 20, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 8, 1 / 10, 1 / 15, 1 / 20, 1 / 25, 1 / 50]
  const out = bars.map((b) => ({ ...b }))
  const splits: Array<{ t: number; ratio: number }> = []
  for (let i = out.length - 1; i >= 1; i--) {
    const move = out[i - 1].c / out[i].c
    if (Math.abs(Math.log(move)) < Math.log(1.35)) continue
    const r = ratios.find((x) => Math.abs(move / x - 1) < 0.03)
    if (!r) continue
    splits.push({ t: out[i].t, ratio: r })
    for (let j = 0; j < i; j++) {
      out[j].o /= r; out[j].h /= r; out[j].l /= r; out[j].c /= r; out[j].v *= r
    }
  }
  return { bars: out, splits: splits.reverse() }
}
