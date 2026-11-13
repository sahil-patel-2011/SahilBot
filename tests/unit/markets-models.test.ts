import { describe, expect, test } from 'vitest'
import { backtest, signals } from '../../src/main/markets/backtest'
import { fitGarch, garchTermVariance } from '../../src/main/markets/garch'
import { DISCLAIMER, LEVELS, businessDays, combine, forecast, originForecast, pickWeights, pinball, walkForward } from '../../src/main/markets/forecast'
import { rng, seedFrom } from '../../src/main/markets/rng'
import { nelderMead, normCdf, normInv, quantile } from '../../src/main/markets/stats'

/** Geometric random walk with constant daily volatility (zero log drift). */
function randomWalk(n: number, sigma: number, seed: number, start = 100): number[] {
  const r = rng(seed)
  const out = [start]
  for (let i = 0; i < n; i++) out.push(out[out.length - 1] * Math.exp(sigma * r.normal()))
  return out
}
/** Prices whose log returns follow GARCH(1,1). */
function garchPrices(n: number, a: number, b: number, longVar: number, seed: number): { prices: number[]; rets: number[] } {
  const r = rng(seed)
  const omega = longVar * (1 - a - b)
  let s2 = longVar
  const rets: number[] = []
  const prices = [100]
  for (let i = 0; i < n; i++) {
    const e = Math.sqrt(s2) * r.normal()
    rets.push(e)
    prices.push(prices[prices.length - 1] * Math.exp(e))
    s2 = omega + a * e * e + b * s2
  }
  return { prices, rets }
}

describe('numerics', () => {
  test('seeded RNG is deterministic and roughly standard normal', () => {
    const a = rng(42), b = rng(42)
    const xs = Array.from({ length: 20000 }, () => a.normal())
    expect(Array.from({ length: 5 }, () => b.normal())).toEqual(xs.slice(0, 5))
    const m = xs.reduce((s, x) => s + x, 0) / xs.length
    const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length
    expect(Math.abs(m)).toBeLessThan(0.03)
    expect(Math.abs(v - 1)).toBeLessThan(0.04)
    expect(seedFrom('AAPL')).toBe(seedFrom('AAPL'))
    expect(seedFrom('AAPL')).not.toBe(seedFrom('MSFT'))
  })
  test('normal CDF and its inverse', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7)
    expect(normCdf(1.959964)).toBeCloseTo(0.975, 6)
    expect(normInv(0.95)).toBeCloseTo(1.644854, 5)
    expect(normInv(0.05)).toBeCloseTo(-1.644854, 5)
    expect(normInv(0.001)).toBeCloseTo(-3.090232, 4)
  })
  test('Nelder-Mead finds a quadratic minimum', () => {
    const r = nelderMead(([x, y]) => (x - 3) ** 2 + 2 * (y + 1) ** 2, [0, 0])
    expect(r.x[0]).toBeCloseTo(3, 3)
    expect(r.x[1]).toBeCloseTo(-1, 3)
  })
  test('pinball loss', () => {
    // y above every quantile: sum of tau*(y-q) over levels / 5
    const q = [0, 0, 0, 0, 0]
    expect(pinball(q, 1)).toBeCloseTo((0.05 + 0.25 + 0.5 + 0.75 + 0.95) / 5, 12)
    expect(pinball(q, -1)).toBeCloseTo((0.95 + 0.75 + 0.5 + 0.25 + 0.05) / 5, 12)
    expect(pinball(q, 0)).toBe(0)
  })
})

describe('GARCH(1,1)', () => {
  test('recovers known parameters from simulated data', () => {
    const { rets } = garchPrices(6000, 0.08, 0.9, 1e-4, 7)
    const f = fitGarch(rets)
    expect(f.fitted).toBe(true)
    expect(f.alpha).toBeGreaterThan(0.04)
    expect(f.alpha).toBeLessThan(0.13)
    expect(f.persistence).toBeGreaterThan(0.95)
    expect(f.persistence).toBeLessThan(0.9995)
    expect(f.omega).toBeGreaterThan(0)
    expect(Math.sqrt(f.longRunVar)).toBeCloseTo(0.01, 2)
  })
  test('stays bounded and stationary on awkward inputs', () => {
    const short = fitGarch([0.01, -0.01, 0.02])
    expect(short.fitted).toBe(false)
    expect(short.persistence).toBeLessThan(1)
    const flat = fitGarch(new Array(500).fill(0))
    expect(Number.isFinite(flat.nextVar)).toBe(true)
    const iid = fitGarch(Array.from({ length: 2000 }, (_, i) => (i % 2 ? 0.01 : -0.01)))
    expect(iid.alpha + iid.beta).toBeLessThan(0.9995)
    expect(iid.variances.every((v) => v > 0)).toBe(true)
  })
  test('term variance mean-reverts toward the long-run level', () => {
    const { rets } = garchPrices(3000, 0.1, 0.85, 1e-4, 3)
    const f = fitGarch(rets)
    const shocked = { ...f, nextVar: 9 * f.longRunVar }
    expect(garchTermVariance(shocked, 1)).toBeCloseTo(shocked.nextVar, 15)
    expect(garchTermVariance(shocked, 500) / 500).toBeLessThan(1.5 * f.longRunVar)
  })
})

describe('forecast', () => {
  const prices = randomWalk(1500, 0.015, 11)
  const fc = forecast(prices, { h: 21, paths: 3000, seed: 5, target: prices[prices.length - 1] * 1.1 })

  test('percentile paths are ordered at every step and start at the last price', () => {
    const S0 = prices[prices.length - 1]
    expect(fc.p50).toHaveLength(22)
    for (const p of [fc.p5, fc.p25, fc.p50, fc.p75, fc.p95]) expect(p[0]).toBe(S0)
    for (let k = 1; k <= 21; k++) {
      expect(fc.p5[k]).toBeLessThan(fc.p25[k])
      expect(fc.p25[k]).toBeLessThan(fc.p50[k])
      expect(fc.p50[k]).toBeLessThan(fc.p75[k])
      expect(fc.p75[k]).toBeLessThan(fc.p95[k])
    }
    // The band widens with the horizon.
    expect(fc.p95[21] - fc.p5[21]).toBeGreaterThan(fc.p95[5] - fc.p5[5])
  })
  test('zero drift: median near today and P(up) near 50%', () => {
    expect(Math.abs(fc.p50[21] / fc.p50[0] - 1)).toBeLessThan(0.01)
    expect(fc.probUp).toBeGreaterThan(0.45)
    expect(fc.probUp).toBeLessThan(0.55)
  })
  test('target probabilities are consistent', () => {
    const t = fc.target!
    expect(t.probAboveAtEnd + t.probBelowAtEnd).toBeCloseTo(1, 12)
    // Ending above a level means the path got there: touching is at least as likely.
    expect(t.probTouch).toBeGreaterThanOrEqual(t.probAboveAtEnd)
    // A +10% target in a month at ~24% annual vol is unlikely but possible.
    expect(t.probAboveAtEnd).toBeGreaterThan(0.02)
    expect(t.probAboveAtEnd).toBeLessThan(0.25)
    const higher = forecast(prices, { h: 21, paths: 3000, seed: 5, target: prices[prices.length - 1] * 1.2 }).target!
    expect(higher.probAboveAtEnd).toBeLessThan(t.probAboveAtEnd)
  })
  test('reproducible with the same seed', () => {
    const again = forecast(prices, { h: 21, paths: 3000, seed: 5 })
    expect(again.p5).toEqual(fc.p5)
    expect(again.p95).toEqual(fc.p95)
  })
  test('the ensemble is a weighted quantile average', () => {
    const d = (x: number) => ({ q: [LEVELS.map(() => x)], pAbove: () => x, pTouch: () => x })
    const e = combine([{ dist: d(1), w: 3 }, { dist: d(5), w: 1 }])
    expect(e.q[0][2]).toBe(2)
    expect(e.pAbove(0)).toBe(2)
  })
  test('needs enough history; horizon is capped at 252', () => {
    expect(() => forecast([1, 2, 3], { h: 5 })).toThrow(/history/)
    expect(forecast(prices, { h: 999, paths: 200 }).horizon).toBe(252)
  })
  test('disclaimer says it plainly', () => {
    expect(DISCLAIMER).toMatch(/random walk/)
    expect(DISCLAIMER).toMatch(/not a prediction/)
    expect(DISCLAIMER).toMatch(/Not financial advice/)
  })
  test('trading dates skip weekends', () => {
    const fri = Date.UTC(2026, 10, 13, 12)
    const d = businessDays(fri, 3).map((t) => new Date(t).getUTCDay())
    expect(d).toEqual([1, 2, 3])
  })
})

describe('walk-forward evaluation', () => {
  test('about 90% coverage on a true random walk, and no skill vs naive (as it should be)', () => {
    const prices = randomWalk(3000, 0.015, 3)
    const wf = walkForward(prices, { h: 5, step: 5, maxOrigins: 300, seed: 1 })
    expect(wf.samples).toBe(300)
    for (const s of [wf.ensemble, wf.models.rw_ewma, wf.models.garch, wf.models.bootstrap]) {
      expect(s.coverage90).toBeGreaterThan(0.84)
      expect(s.coverage90).toBeLessThan(0.96)
      expect(s.pinballVsNaive).toBeGreaterThan(0.95)
      expect(s.pinballVsNaive).toBeLessThan(1.05)
    }
    expect(wf.naive.coverage90).toBeGreaterThan(0.84)
    expect(wf.directionSkill).toBe(false)
    expect(wf.verdict).toMatch(/no skill at predicting direction/)
  })
  test('volatility clustering: GARCH beats the naive constant-volatility baseline (modestly, but measurably)', () => {
    // Even on data that truly is GARCH, the gain in pinball loss is small (~1-2%): outcome noise dominates.
    const { prices } = garchPrices(3000, 0.25, 0.7, 1e-4, 21)
    const wf = walkForward(prices, { h: 1, step: 1, maxOrigins: 1500, paths: 400, seed: 2 })
    expect(wf.models.garch.pinballVsNaive).toBeLessThan(1)
    expect(wf.models.garch.tVsNaive).toBeLessThan(-2)
    expect(wf.rangeSkill).toBe(true)
    expect(wf.weights.garch).toBeGreaterThan(0)
  })
  test('no look-ahead: a forecast at an origin ignores everything after it', () => {
    const prices = randomWalk(900, 0.02, 9)
    const origin = 700
    const full = originForecast(prices, origin, 21, 400, rng(77))
    // Wreck the future: the forecast must not change.
    const wrecked = prices.map((p, i) => (i > origin ? p * 100 : p))
    const again = originForecast(wrecked, origin, 21, 400, rng(77))
    const cut = originForecast(prices.slice(0, origin + 1), origin, 21, 400, rng(77))
    for (const m of ['rw_ewma', 'garch', 'bootstrap'] as const) {
      expect(again.models[m].q).toEqual(full.models[m].q)
      expect(cut.models[m].q).toEqual(full.models[m].q)
    }
    expect(again.naive.q).toEqual(full.naive.q)
  })
  test('origins never extend past the data; few samples are flagged', () => {
    const prices = randomWalk(550, 0.01, 4)
    const wf = walkForward(prices, { h: 21, minTrain: 252 })
    expect(wf.lastOrigin + 21).toBeLessThanOrEqual(prices.length - 1)
    expect(wf.firstOrigin).toBeGreaterThanOrEqual(252)
    expect(wf.samples).toBeLessThan(30)
    expect(wf.verdict).toMatch(/too few/)
    expect(wf.rangeSkill).toBe(false)
  })
  test('weights: equal when no model beats naive, inverse-loss among those that do', () => {
    const eq = pickWeights({ rw_ewma: new Array(20).fill(2), garch: new Array(20).fill(2), bootstrap: new Array(20).fill(3) }, new Array(20).fill(1))
    expect(Object.values(eq)).toEqual([1 / 3, 1 / 3, 1 / 3])
    const w = pickWeights({ rw_ewma: new Array(20).fill(0.5), garch: new Array(20).fill(1), bootstrap: new Array(20).fill(2) }, new Array(20).fill(1.5))
    expect(w.bootstrap).toBe(0)
    expect(w.rw_ewma).toBeCloseTo(2 / 3, 12)
    expect(w.garch).toBeCloseTo(1 / 3, 12)
    expect(Object.values(pickWeights({ rw_ewma: [0.1], garch: [0.1], bootstrap: [0.1] }, [1]))).toEqual([1 / 3, 1 / 3, 1 / 3])
  })
})

describe('backtests', () => {
  const prices = randomWalk(1500, 0.015, 5)

  test('buy & hold earns the price change less one entry cost', () => {
    const r = backtest(prices, 'buy_hold', {}, { costBps: 5, slippageBps: 5 })
    const expected = (prices[prices.length - 1] / prices[r.start - 1]) * (1 - 0.001) - 1
    expect(r.metrics.totalReturn).toBeCloseTo(expected, 3)
    expect(r.metrics.exposure).toBe(1)
    expect(r.metrics.trades).toBe(1)
  })
  test('no look-ahead: positions up to day t do not depend on prices after t', () => {
    for (const s of ['sma_cross', 'momentum', 'rsi_reversion'] as const) {
      const full = backtest(prices, s)
      const t = 1100
      const cut = backtest(prices.slice(0, t + 1), s)
      expect(cut.positions.slice(0, t + 1)).toEqual(full.positions.slice(0, t + 1))
      // And the position on day t was decided from the close two days earlier.
      const sig = signals(prices.slice(0, t - 1), s)
      expect(full.positions[t]).toBe(sig[t - 2])
    }
  })
  test('a perfect-foresight signal is impossible: shifting the future does not change past equity', () => {
    const a = backtest(prices, 'sma_cross', { fast: 20, slow: 100 })
    const b = backtest(prices.map((p, i) => (i > 1200 ? p * 3 : p)), 'sma_cross', { fast: 20, slow: 100 })
    expect(b.equity.slice(0, 1201)).toEqual(a.equity.slice(0, 1201))
  })
  test('costs reduce returns and tuned parameters trigger an overfitting warning', () => {
    const cheap = backtest(prices, 'rsi_reversion', {}, { costBps: 0, slippageBps: 0 })
    const dear = backtest(prices, 'rsi_reversion', {}, { costBps: 20, slippageBps: 20 })
    expect(dear.metrics.totalReturn).toBeLessThan(cheap.metrics.totalReturn)
    expect(cheap.tuned).toBe(false)
    const tuned = backtest(prices, 'sma_cross', { fast: 17, slow: 83 })
    expect(tuned.tuned).toBe(true)
    expect(tuned.warnings.join(' ')).toMatch(/overfitting/)
  })
  test('momentum and SMA strategies trade and report sane metrics', () => {
    const r = backtest(prices, 'sma_cross', { fast: 20, slow: 100 })
    expect(r.metrics.trades).toBeGreaterThan(0)
    expect(r.metrics.exposure).toBeGreaterThan(0)
    expect(r.metrics.exposure).toBeLessThan(1)
    expect(r.metrics.maxDrawdown).toBeLessThanOrEqual(0)
    expect(Number.isFinite(r.metrics.cagr)).toBe(true)
    expect(Number.isFinite(r.buyHold.sharpe)).toBe(true)
    expect(() => backtest(prices.slice(0, 50), 'momentum')).toThrow(/Not enough history/)
  })
  test('quantile helper', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3)
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
  })
})
