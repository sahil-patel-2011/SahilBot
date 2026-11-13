import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  adjustSplits, alignedReturns, atr, betaCorr, bollinger, ema, ewmaVariance, ewmaVol, logReturns, macd, maxDrawdown, range52w,
  realizedVol, returns, rsi, sharpe, sma, sortino, trailingReturn, trueRange
} from '../../src/main/markets/indicators'
import { parseStooqCsv } from '../../src/main/markets/providers'
import { techStats } from '../../src/main/markets/analysis'
import type { Bar } from '../../src/main/markets/types'

const FX = join(__dirname, '..', 'fixtures', 'markets')
const bar = (c: number, i: number, range = 0): Bar => ({ t: Date.UTC(2024, 0, 1 + i, 12), o: c, h: c + range / 2, l: c - range / 2, c, v: 1000 })

describe('returns', () => {
  test('simple and log returns', () => {
    const r = returns([100, 110, 99])
    expect(r[0]).toBeCloseTo(0.1, 12)
    expect(r[1]).toBeCloseTo(-0.1, 12)
    const lr = logReturns([100, 110, 99])
    expect(lr[0]).toBeCloseTo(Math.log(1.1), 12)
    expect(lr[1]).toBeCloseTo(Math.log(0.9), 12)
  })
  test('trailing return', () => {
    expect(trailingReturn([1, 2, 3, 4], 2)).toBeCloseTo(4 / 2 - 1)
    expect(trailingReturn([1, 2], 5)).toBeNaN()
  })
})

describe('moving averages', () => {
  test('SMA', () => {
    const s = sma([1, 2, 3, 4, 5], 3)
    expect(s.slice(0, 2).every(Number.isNaN)).toBe(true)
    expect(s.slice(2)).toEqual([2, 3, 4])
  })
  test('EMA seeded with the SMA of the first n values', () => {
    // n=3: k=0.5; seed mean(1,2,3)=2; then 4*0.5+2*0.5=3; 5*0.5+3*0.5=4
    expect(ema([1, 2, 3, 4, 5], 3).slice(2)).toEqual([2, 3, 4])
    // Leading NaNs (as in MACD's signal) are skipped.
    expect(ema([NaN, NaN, 2, 2, 2, 2], 3).slice(4)).toEqual([2, 2])
  })
})

describe('RSI (Wilder)', () => {
  // The worked example from StockCharts' RSI article (14-period).
  const closes = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826, 45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028, 46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515, 45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628, 43.1314]
  const want = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.3, 33.08, 37.77]
  test('matches the published reference values', () => {
    const r = rsi(closes, 14)
    expect(r.slice(0, 14).every(Number.isNaN)).toBe(true)
    r.slice(14).forEach((v, i) => expect(v).toBeCloseTo(want[i], 2))
  })
  test('edge cases: only gains = 100, only losses = 0, flat = 50', () => {
    expect(rsi(Array.from({ length: 20 }, (_, i) => i), 14).at(-1)).toBe(100)
    expect(rsi(Array.from({ length: 20 }, (_, i) => 50 - i), 14).at(-1)).toBe(0)
    expect(rsi(new Array(20).fill(7), 14).at(-1)).toBe(50)
  })
})

describe('MACD', () => {
  test('on a straight line the MACD converges to the EMA lag difference: (26-1)/2 - (12-1)/2 = 7', () => {
    const m = macd(Array.from({ length: 400 }, (_, i) => i))
    expect(m.macd.at(-1)).toBeCloseTo(7, 6)
    expect(m.signal.at(-1)).toBeCloseTo(7, 6)
    expect(m.hist.at(-1)).toBeCloseTo(0, 6)
  })
  test('flat prices give zero', () => {
    const m = macd(new Array(60).fill(10))
    expect(m.macd.at(-1)).toBe(0)
    expect(m.signal.at(-1)).toBe(0)
  })
})

describe('Bollinger Bands', () => {
  test('population standard deviation, hand-computed', () => {
    // Window [2,4,4,4,5,5,7,9]: mean 5, population sd 2.
    const b = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2)
    expect(b.mid.at(-1)).toBe(5)
    expect(b.upper.at(-1)).toBe(9)
    expect(b.lower.at(-1)).toBe(1)
    expect(b.percentB.at(-1)).toBe(1) // close 9 sits on the upper band
  })
})

describe('ATR', () => {
  test('constant range bars: ATR equals the range', () => {
    const bars = Array.from({ length: 30 }, (_, i) => bar(100, i, 2))
    expect(atr(bars, 14).at(-1)).toBeCloseTo(2, 12)
  })
  test('true range includes gaps from the previous close', () => {
    const bars: Bar[] = [bar(100, 0, 2), { t: 1, o: 110, h: 111, l: 109, c: 110, v: 0 }]
    expect(trueRange(bars)).toEqual([2, 11])
  })
  test('Wilder smoothing after the seed', () => {
    const bars = Array.from({ length: 16 }, (_, i) => bar(100, i, i < 15 ? 2 : 16))
    // seed = mean of TR[1..14] = 2; next = (2*13 + 16)/14 = 3
    expect(atr(bars, 14)[15]).toBeCloseTo(3, 12)
  })
})

describe('volatility', () => {
  test('realized volatility annualizes with sqrt(252)', () => {
    const r = [0.01, -0.01, 0.01, -0.01]
    // sample sd of ±0.01 alternating (n=4): sqrt(4*1e-4/3)
    expect(realizedVol(r)).toBeCloseTo(Math.sqrt(4e-4 / 3) * Math.sqrt(252), 12)
    expect(realizedVol([0.5, 0.01, -0.01, 0.01, -0.01], 4)).toBeCloseTo(Math.sqrt(4e-4 / 3) * Math.sqrt(252), 12)
  })
  test('EWMA variance recursion and forecast', () => {
    const r = [0.02, -0.01, 0.03]
    const v = ewmaVariance(r, 0.94)
    const seed = (0.02 ** 2 + 0.01 ** 2 + 0.03 ** 2) / 3
    expect(v[0]).toBeCloseTo(seed, 15)
    expect(v[1]).toBeCloseTo(0.94 * seed + 0.06 * 0.02 ** 2, 15)
    expect(v[3]).toBeCloseTo(0.94 * v[2] + 0.06 * 0.03 ** 2, 15)
    expect(ewmaVol(r)).toBeCloseTo(Math.sqrt(v[3] * 252), 12)
  })
})

describe('beta, correlation, drawdown, ratios', () => {
  test('beta and correlation of an exact multiple', () => {
    const b = [0.01, -0.02, 0.015, 0.003, -0.007]
    const r = betaCorr(b.map((x) => 2 * x + 0.001), b)
    expect(r.beta).toBeCloseTo(2, 12)
    expect(r.corr).toBeCloseTo(1, 12)
    expect(betaCorr(b.map((x) => -x), b).corr).toBeCloseTo(-1, 12)
  })
  test('aligned returns skip dates missing from either series', () => {
    const a: Bar[] = [bar(100, 0), bar(110, 1), bar(121, 3)]
    const b: Bar[] = [bar(10, 0), bar(11, 2), bar(12, 3)]
    const al = alignedReturns(a, b)
    expect(al.a).toHaveLength(1)
    expect(al.a[0]).toBeCloseTo(0.21, 12)
    expect(al.b[0]).toBeCloseTo(0.2, 12)
  })
  test('max drawdown is the largest peak-to-trough fall', () => {
    const d = maxDrawdown([100, 120, 90, 130, 104, 140])
    expect(d.maxDrawdown).toBeCloseTo(-0.25, 12) // 120 -> 90
    expect([d.peak, d.trough]).toEqual([1, 2])
    expect(maxDrawdown([1, 2, 3]).maxDrawdown).toBe(0)
  })
  test('Sharpe and Sortino', () => {
    const r = [0.01, -0.005, 0.02, -0.01, 0.005]
    const m = 0.004
    const sd = Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / 4)
    expect(sharpe(r)).toBeCloseTo((m / sd) * Math.sqrt(252), 10)
    const dd = Math.sqrt((0.005 ** 2 + 0.01 ** 2) / 5)
    expect(sortino(r)).toBeCloseTo((m / dd) * Math.sqrt(252), 10)
  })
  test('52-week range uses highs and lows of the last 252 sessions', () => {
    const bars = Array.from({ length: 300 }, (_, i) => bar(i < 40 ? 1000 : 100 + (i % 10), i, 2))
    const r = range52w(bars)
    expect(r.high).toBe(110)
    expect(r.low).toBe(99)
  })
})

describe('split adjustment for unadjusted providers', () => {
  test('a 4:1 split is detected and earlier prices divided', () => {
    const bars = [bar(400, 0), bar(404, 1), bar(101.5, 2), bar(102, 3)]
    const r = adjustSplits(bars)
    expect(r.splits).toHaveLength(1)
    expect(r.splits[0].ratio).toBe(4)
    expect(r.bars[1].c).toBeCloseTo(101, 10)
    expect(r.bars[2].c).toBe(101.5)
  })
  test('a real 20% crash is left alone', () => {
    const bars = [bar(100, 0), bar(80, 1), bar(81, 2)]
    expect(adjustSplits(bars).splits).toEqual([])
  })
})

describe('real data (AAPL daily, Feb 2015 - Feb 2017, saved fixture)', () => {
  const bars = parseStooqCsv(readFileSync(join(FX, 'aapl-stooq.csv'), 'utf8'))
  test('technical summary is internally consistent', () => {
    const s = techStats(bars)
    expect(bars).toHaveLength(506)
    expect(s.last).toBeCloseTo(135.35, 2)
    expect(s.vol1y).toBeGreaterThan(0.15)
    expect(s.vol1y).toBeLessThan(0.35)
    expect(s.low52).toBeLessThan(s.last)
    expect(s.high52).toBeGreaterThanOrEqual(s.last)
    expect(s.rsi14).toBeGreaterThan(0)
    expect(s.rsi14).toBeLessThan(100)
    expect(s.maxDrawdown1y).toBeLessThan(0)
    expect(s.garchPersistence).toBeLessThan(1)
  })
  test('beta of AAPL vs the S&P 500 (2014-2016) is near 1', () => {
    const rows = readFileSync(join(FX, 'aapl-spx-closes.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','))
    const r = betaCorr(returns(rows.map((x) => +x[1])), returns(rows.map((x) => +x[2])))
    expect(r.beta).toBeGreaterThan(0.8)
    expect(r.beta).toBeLessThan(1.4)
    expect(r.corr).toBeGreaterThan(0.4)
  })
})
