// Probabilistic price forecasts, and an honest walk-forward check of how good they are.
//
// READ THIS FIRST: daily stock prices are close to a random walk at horizons of days to months. No model
// here (or anywhere, reliably) predicts where a price will go. What these models CAN do is describe a
// calibrated range of plausible outcomes: how wide the spread of outcomes is likely to be, given how
// volatile the stock has been. That is useful for risk ("a 1-in-20 bad month is about -15%"), not for
// picking direction. Every result says: "Prices are close to a random walk at these horizons; this is a
// range of plausible outcomes, not a prediction. Not financial advice."
//
// Models (all with zero drift in log price, so the median outcome is today's price; past drift is
// mostly noise and extrapolating it is the classic way these tools mislead people):
//   rw_ewma   - random walk; volatility from an EWMA (RiskMetrics, lambda 0.94) of recent returns.
//   garch     - GARCH(1,1) Monte Carlo: volatility shocks fade toward the long-run level; shocks are
//               resampled from the model's own standardized residuals (filtered historical simulation),
//               so fat tails and skew in the stock's history carry through.
//   bootstrap - circular block bootstrap of the last ~5 years of (demeaned) daily returns, blocks of 10
//               days so volatility clustering within blocks is kept.
// Baseline ("naive"): a random walk with constant volatility equal to the last year's realized daily
// volatility. Skill is always reported relative to it.
//
// Ensemble: weighted average of the models' quantiles. In the walk-forward test the weights at each
// origin come only from forecasts whose outcomes were already known at that origin (no look-ahead);
// models that don't beat the naive baseline get no extra weight, and if none do, weights are equal.

import { fitGarch, type GarchFit } from './garch'
import { ewmaVariance, logReturns } from './indicators'
import { rng, type Rng } from './rng'
import { normCdf, normInv, quantileSorted, std } from './stats'

export const DISCLAIMER = 'Prices are close to a random walk at these horizons; this is a range of plausible outcomes, not a prediction. Not financial advice.'
export const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95] as const
export type ModelName = 'rw_ewma' | 'garch' | 'bootstrap'
export const MODELS: ModelName[] = ['rw_ewma', 'garch', 'bootstrap']
export const MODEL_LABEL: Record<ModelName | 'naive' | 'ensemble', string> = {
  rw_ewma: 'Random walk + EWMA volatility',
  garch: 'GARCH(1,1) Monte Carlo',
  bootstrap: 'Block bootstrap of past returns',
  naive: 'Naive random walk (1-year volatility)',
  ensemble: 'Ensemble'
}

/** Distribution of the cumulative log return at each step 1..h (or only the last step). */
export interface Dist {
  /** q[k][l]: quantile LEVELS[l] of the cumulative log return after step k + 1 (one row when terminal-only). */
  q: number[][]
  /** P(cumulative log return at the horizon > x). */
  pAbove(x: number): number
  /** P(the daily close reaches log level x at least once by the horizon); x > 0 up, x < 0 down. */
  pTouch(x: number): number
}

const Z = LEVELS.map((p) => normInv(p))

/** Analytic zero-drift Gaussian random walk with daily volatility sigma. */
function gaussianDist(sigma: number, h: number, perStep: boolean): Dist {
  const s = Math.max(sigma, 1e-6)
  const steps = perStep ? Array.from({ length: h }, (_, k) => k + 1) : [h]
  const sh = s * Math.sqrt(h)
  return {
    q: steps.map((k) => Z.map((z) => z * s * Math.sqrt(k))),
    pAbove: (x) => 1 - normCdf(x / sh),
    // Reflection principle, with Broadie-Glasserman's shift (0.5826 sigma) for daily rather than continuous monitoring.
    pTouch: (x) => (x === 0 ? 1 : Math.min(1, 2 * (1 - normCdf((Math.abs(x) + 0.5826 * s) / sh))))
  }
}

function lowerBound(sorted: Float64Array, x: number): number {
  let lo = 0, hi = sorted.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m }
  return lo
}

/** Turns simulated paths into a Dist. `walk(path, emit)` must call emit(step, cumulative) for steps 0..h-1. */
function monteCarloDist(h: number, paths: number, perStep: boolean, walk: (emit: (k: number, cum: number) => void) => void): Dist {
  const rows = perStep ? h : 1
  const at = Array.from({ length: rows }, () => new Float64Array(paths))
  const mx = new Float64Array(paths)
  const mn = new Float64Array(paths)
  for (let p = 0; p < paths; p++) {
    let hi = -Infinity, lo = Infinity
    walk((k, cum) => {
      if (cum > hi) hi = cum
      if (cum < lo) lo = cum
      if (perStep) at[k][p] = cum
      else if (k === h - 1) at[0][p] = cum
    })
    mx[p] = hi
    mn[p] = lo
  }
  for (const a of at) a.sort()
  mx.sort()
  mn.sort()
  const term = at[rows - 1]
  return {
    q: at.map((a) => LEVELS.map((l) => quantileSorted(a, l))),
    pAbove: (x) => 1 - lowerBound(term, x + 1e-15) / paths,
    pTouch: (x) => (x === 0 ? 1 : x > 0 ? 1 - lowerBound(mx, x) / paths : lowerBound(mn, x + 1e-15) / paths)
  }
}

export interface ModelInputs {
  /** Daily log returns up to and including the forecast origin. */
  rets: number[]
  h: number
  paths: number
  perStep: boolean
  rng: Rng
  /** Previous GARCH fit to warm-start from (walk-forward). */
  warm?: { alpha: number; beta: number }
}

export function rwEwmaDist(i: ModelInputs): { dist: Dist; sigma: number } {
  const v = ewmaVariance(i.rets.slice(-1000))
  const sigma = Math.sqrt(v[v.length - 1])
  return { dist: gaussianDist(sigma, i.h, i.perStep), sigma }
}

/** The baseline: zero-drift random walk with the last year's realized daily volatility. */
export function naiveDist(rets: number[], h: number, perStep = false): { dist: Dist; sigma: number } {
  const sigma = std(rets.slice(-252))
  return { dist: gaussianDist(sigma, h, perStep), sigma }
}

export function garchDist(i: ModelInputs): { dist: Dist; fit: GarchFit } {
  const fit = fitGarch(i.rets.slice(-1260), { warm: i.warm })
  // Standardized residuals, recentred and rescaled to exactly mean 0, variance 1.
  const z = fit.residuals.filter(Number.isFinite)
  const zm = z.reduce((s, x) => s + x, 0) / Math.max(1, z.length)
  const zs = Math.sqrt(z.reduce((s, x) => s + (x - zm) ** 2, 0) / Math.max(1, z.length)) || 1
  const pool = z.length >= 250 ? Float64Array.from(z, (x) => (x - zm) / zs) : null
  const { omega, alpha, beta, nextVar } = fit
  const dist = monteCarloDist(i.h, i.paths, i.perStep, (emit) => {
    let s2 = nextVar
    let cum = 0
    for (let k = 0; k < i.h; k++) {
      const shock = pool ? pool[i.rng.int(pool.length)] : i.rng.normal()
      const e = Math.sqrt(s2) * shock
      cum += e
      emit(k, cum)
      s2 = omega + alpha * e * e + beta * s2
    }
  })
  return { dist, fit }
}

export function bootstrapDist(i: ModelInputs, block = 10): { dist: Dist } {
  const raw = i.rets.slice(-1260)
  const m = raw.reduce((s, x) => s + x, 0) / Math.max(1, raw.length)
  const pool = raw.map((x) => x - m)
  const n = pool.length
  const L = n >= 100 ? block : Math.max(1, Math.floor(n / 10))
  const dist = monteCarloDist(i.h, i.paths, i.perStep, (emit) => {
    let cum = 0
    let pos = i.rng.int(n)
    for (let k = 0; k < i.h; k++) {
      if (k % L === 0) pos = i.rng.int(n)
      cum += pool[pos % n]
      pos++
      emit(k, cum)
    }
  })
  return { dist }
}

export function modelDist(name: ModelName, i: ModelInputs): { dist: Dist; fit?: GarchFit; sigma?: number } {
  if (name === 'rw_ewma') return rwEwmaDist(i)
  if (name === 'garch') return garchDist(i)
  return bootstrapDist(i)
}

/** Weighted quantile average (Vincentization) of several distributions; probabilities are weighted too. */
export function combine(dists: Array<{ dist: Dist; w: number }>): Dist {
  const total = dists.reduce((s, d) => s + d.w, 0) || 1
  const ws = dists.map((d) => d.w / total)
  const rows = dists[0].dist.q.length
  return {
    q: Array.from({ length: rows }, (_, k) => LEVELS.map((_l, l) => dists.reduce((s, d, j) => s + ws[j] * d.dist.q[k][l], 0))),
    pAbove: (x) => dists.reduce((s, d, j) => s + ws[j] * d.dist.pAbove(x), 0),
    pTouch: (x) => dists.reduce((s, d, j) => s + ws[j] * d.dist.pTouch(x), 0)
  }
}

/** Pinball (quantile) loss averaged over LEVELS, for quantiles q of an outcome y. */
export function pinball(q: ArrayLike<number>, y: number): number {
  let s = 0
  for (let l = 0; l < LEVELS.length; l++) {
    const tau = LEVELS[l]
    s += y >= q[l] ? tau * (y - q[l]) : (1 - tau) * (q[l] - y)
  }
  return s / LEVELS.length
}

// ---------------------------------------------------------------- walk-forward evaluation

export interface SkillReport {
  /** Share of outcomes inside the 5-95% band (target 0.90). */
  coverage90: number
  /** Mean pinball loss on log returns. */
  pinball: number
  /** pinball / naive pinball: below 1 = better than the naive baseline, above 1 = worse. */
  pinballVsNaive: number
  /** Share of origins where the median's sign (ties = up) matched the outcome's. */
  directionalAccuracy: number
  /** t-statistic of the loss difference vs naive, adjusted for overlapping horizons (|t| < 2: no real difference). */
  tVsNaive: number
  samples: number
}

export interface WalkForwardResult {
  horizon: number
  step: number
  samples: number
  /** Samples adjusted for overlap (independent horizons' worth). */
  effectiveSamples: number
  /** Share of origins whose outcome was up: what "always guess up" would score on direction. */
  baseRateUp: number
  naive: { coverage90: number; pinball: number }
  models: Record<ModelName, SkillReport>
  ensemble: SkillReport
  /** Weights for a forecast made now, from every evaluated origin. */
  weights: Record<ModelName, number>
  /** Some model (or the ensemble) beats the naive baseline by a statistically meaningful margin. */
  rangeSkill: boolean
  /** Direction calls beat both 50% and the base rate by a meaningful margin (rare: expect false). */
  directionSkill: boolean
  verdict: string
  /** First and last origin dates' indices into the input. */
  firstOrigin: number
  lastOrigin: number
}

export interface WalkForwardOptions {
  h: number
  /** Days between forecast origins (default about h/2). */
  step?: number
  /** Returns needed before the first origin (default 504, or 252 for short histories). */
  minTrain?: number
  /** Most recent origins evaluated (default 120). */
  maxOrigins?: number
  /** Monte Carlo paths per model per origin (default 600). */
  paths?: number
  seed?: number
}

/** The forecasts at one origin, using only closes[0..origin] (the slice is the no-look-ahead guarantee). */
export function originForecast(closes: number[], origin: number, h: number, paths: number, r: Rng, warm?: { alpha: number; beta: number }): { naive: Dist; models: Record<ModelName, Dist>; fit: GarchFit } {
  const hist = closes.slice(Math.max(0, origin + 1 - 1300), origin + 1)
  const rets = logReturns(hist)
  const base: ModelInputs = { rets, h, paths, perStep: false, rng: r, warm }
  const g = garchDist(base)
  return {
    naive: naiveDist(rets, h).dist,
    models: { rw_ewma: rwEwmaDist(base).dist, garch: g.dist, bootstrap: bootstrapDist(base).dist },
    fit: g.fit
  }
}

/** Inverse-loss weights among models that beat naive on the known outcomes; equal weights otherwise. */
export function pickWeights(losses: Record<ModelName, number[]>, naive: number[], minSamples = 10): Record<ModelName, number> {
  const equal = Object.fromEntries(MODELS.map((m) => [m, 1 / MODELS.length])) as Record<ModelName, number>
  if (naive.length < minSamples) return equal
  const nv = naive.reduce((s, x) => s + x, 0) / naive.length
  const avg = Object.fromEntries(MODELS.map((m) => [m, losses[m].reduce((s, x) => s + x, 0) / losses[m].length])) as Record<ModelName, number>
  const good = MODELS.filter((m) => avg[m] < nv)
  if (!good.length) return equal
  const inv = good.map((m) => 1 / avg[m])
  const sum = inv.reduce((s, x) => s + x, 0)
  return Object.fromEntries(MODELS.map((m) => [m, good.includes(m) ? inv[good.indexOf(m)] / sum : 0])) as Record<ModelName, number>
}

function tStat(diffs: number[], overlap: number): number {
  const n = diffs.length
  if (n < 5) return 0
  const m = diffs.reduce((s, x) => s + x, 0) / n
  const sd = std(diffs)
  const nEff = Math.max(2, n / Math.max(1, overlap))
  return sd > 0 ? m / (sd / Math.sqrt(nEff)) : 0
}

export function walkForward(closesIn: ArrayLike<number>, o: WalkForwardOptions): WalkForwardResult {
  const closes = Array.from(closesIn)
  const h = Math.max(1, Math.round(o.h))
  const step = Math.max(1, o.step ?? Math.max(1, Math.round(h / 2)))
  const minTrain = o.minTrain ?? (closes.length >= 504 + h + 60 * step ? 504 : 252)
  const paths = o.paths ?? 600
  const r = rng(o.seed ?? 12345)
  const origins: number[] = []
  for (let i = closes.length - 1 - h; i >= minTrain; i -= step) origins.push(i)
  origins.reverse()
  const keep = origins.slice(-(o.maxOrigins ?? 120))
  const losses = { rw_ewma: [] as number[], garch: [] as number[], bootstrap: [] as number[] }
  const ensLoss: number[] = []
  const naiveLoss: number[] = []
  const hits = { rw_ewma: 0, garch: 0, bootstrap: 0, ensemble: 0, naive: 0 }
  const dirHits = { rw_ewma: 0, garch: 0, bootstrap: 0, ensemble: 0 }
  let ups = 0
  let warm: { alpha: number; beta: number } | undefined
  const known: number[] = [] // index into keep of origins whose outcome is known at the current origin
  const recLoss: Array<Record<ModelName, number> & { naive: number }> = []
  const inBand = (q: number[], y: number): boolean => y >= q[0] && y <= q[4]
  const upCall = (q: number[]): boolean => q[2] >= -1e-12
  for (let k = 0; k < keep.length; k++) {
    const i = keep[k]
    const y = Math.log(closes[i + h] / closes[i])
    const f = originForecast(closes, i, h, paths, r, warm)
    warm = { alpha: f.fit.alpha, beta: f.fit.beta }
    // Ensemble weights from outcomes known by origin i (origin j + h <= i).
    while (known.length < k && keep[known.length] + h <= i) known.push(known.length)
    const w = pickWeights(
      Object.fromEntries(MODELS.map((m) => [m, known.map((j) => recLoss[j][m])])) as Record<ModelName, number[]>,
      known.map((j) => recLoss[j].naive)
    )
    const ens = combine(MODELS.map((m) => ({ dist: f.models[m], w: w[m] })))
    const qN = f.naive.q[0]
    const rec = { naive: pinball(qN, y) } as Record<ModelName, number> & { naive: number }
    naiveLoss.push(rec.naive)
    if (inBand(qN, y)) hits.naive++
    for (const m of MODELS) {
      const q = f.models[m].q[0]
      rec[m] = pinball(q, y)
      losses[m].push(rec[m])
      if (inBand(q, y)) hits[m]++
      if (upCall(q) === y > 0) dirHits[m]++
    }
    recLoss.push(rec)
    const qE = ens.q[0]
    ensLoss.push(pinball(qE, y))
    if (inBand(qE, y)) hits.ensemble++
    if (upCall(qE) === y > 0) dirHits.ensemble++
    if (y > 0) ups++
  }
  const n = keep.length
  const overlap = h / step
  const nv = naiveLoss.reduce((s, x) => s + x, 0) / Math.max(1, n)
  const report = (loss: number[], hit: number, dir: number): SkillReport => {
    const p = loss.reduce((s, x) => s + x, 0) / Math.max(1, n)
    return { coverage90: hit / Math.max(1, n), pinball: p, pinballVsNaive: nv > 0 ? p / nv : NaN, directionalAccuracy: dir / Math.max(1, n), tVsNaive: tStat(loss.map((x, j) => x - naiveLoss[j]), overlap), samples: n }
  }
  const models = Object.fromEntries(MODELS.map((m) => [m, report(losses[m], hits[m], dirHits[m])])) as Record<ModelName, SkillReport>
  const ensemble = report(ensLoss, hits.ensemble, dirHits.ensemble)
  const weights = pickWeights(losses, naiveLoss)
  const effectiveSamples = Math.round(n / Math.max(1, overlap))
  const baseRateUp = ups / Math.max(1, n)
  // Meaningfully better than naive: lower loss with t < -2 (a ~95% one-sided bar).
  const rangeSkill = n >= 30 && [ensemble, ...MODELS.map((m) => models[m])].some((s) => s.pinballVsNaive < 1 && s.tVsNaive < -2)
  const se = Math.sqrt(0.25 / Math.max(1, effectiveSamples))
  const directionSkill = n >= 30 && ensemble.directionalAccuracy > Math.max(0.5, baseRateUp) + 2 * se
  return {
    horizon: h, step, samples: n, effectiveSamples, baseRateUp,
    naive: { coverage90: hits.naive / Math.max(1, n), pinball: nv },
    models, ensemble, weights, rangeSkill, directionSkill,
    verdict: verdict({ n, effectiveSamples, ensemble, rangeSkill, directionSkill, baseRateUp }),
    firstOrigin: keep[0] ?? -1, lastOrigin: keep[keep.length - 1] ?? -1
  }
}

function verdict(o: { n: number; effectiveSamples: number; ensemble: SkillReport; rangeSkill: boolean; directionSkill: boolean; baseRateUp: number }): string {
  if (o.n < 30) return `Only ${o.n} past forecasts could be checked (about ${o.effectiveSamples} independent), too few to judge skill: treat the range as rough.`
  const pct = (x: number): string => `${Math.round(x * 100)}%`
  const cov = o.ensemble.coverage90
  const calib = cov < 0.84 ? `too narrow (the 90% band held the outcome only ${pct(cov)} of the time; real risk is larger than shown)` : cov > 0.96 ? `too wide (held the outcome ${pct(cov)} of the time)` : `well calibrated (the 90% band held the outcome ${pct(cov)} of the time)`
  const range = o.rangeSkill
    ? `The range was measurably sharper than a naive random walk (loss ${o.ensemble.pinballVsNaive.toFixed(2)}x naive).`
    : `The range was no better than a naive random walk in a statistically meaningful way (loss ${o.ensemble.pinballVsNaive.toFixed(2)}x naive).`
  const dir = o.directionSkill
    ? `Direction calls beat chance (${pct(o.ensemble.directionalAccuracy)} right vs ${pct(Math.max(0.5, o.baseRateUp))}), but treat that with suspicion: it rarely persists.`
    : `There is no skill at predicting direction: up/down calls were right ${pct(o.ensemble.directionalAccuracy)} of the time, versus ${pct(o.baseRateUp)} for always guessing "up".`
  return `Past forecasts on this stock: intervals were ${calib}. ${range} ${dir}`
}

// ---------------------------------------------------------------- live forecast

export interface ForecastResult {
  horizon: number
  lastPrice: number
  /** Price percentiles at step 0..h (index 0 = the last close). */
  p5: number[]
  p25: number[]
  p50: number[]
  p75: number[]
  p95: number[]
  probUp: number
  weights: Record<ModelName, number>
  /** Each model's own view at the horizon (prices) and probability of ending up. */
  perModel: Record<ModelName, { p5: number; p50: number; p95: number; probUp: number }>
  /** P(price ends above / below the target at the horizon), P(it trades through it at a daily close by then). */
  target?: { price: number; probAboveAtEnd: number; probBelowAtEnd: number; probTouch: number }
  garch: { alpha: number; beta: number; persistence: number; volNowAnnual: number; volLongRunAnnual: number; fitted: boolean }
  ewmaVolAnnual: number
  histVolAnnual: number
}

export function forecast(closesIn: ArrayLike<number>, o: { h: number; paths?: number; seed?: number; weights?: Record<ModelName, number>; target?: number }): ForecastResult {
  const closes = Array.from(closesIn)
  const h = Math.min(252, Math.max(1, Math.round(o.h)))
  const paths = o.paths ?? 4000
  const seed = o.seed ?? 1
  const rets = logReturns(closes.slice(-1300))
  if (rets.length < 60) throw new Error('Not enough price history for a forecast (need at least 60 trading days).')
  const S0 = closes[closes.length - 1]
  const base = (k: number): ModelInputs => ({ rets, h, paths, perStep: true, rng: rng(seed + k * 7919) })
  const rw = rwEwmaDist(base(0))
  const g = garchDist(base(1))
  const bs = bootstrapDist(base(2))
  const dists: Record<ModelName, Dist> = { rw_ewma: rw.dist, garch: g.dist, bootstrap: bs.dist }
  const weights = o.weights ?? (Object.fromEntries(MODELS.map((m) => [m, 1 / 3])) as Record<ModelName, number>)
  const ens = combine(MODELS.map((m) => ({ dist: dists[m], w: weights[m] })))
  const col = (l: number): number[] => [S0, ...ens.q.map((row) => S0 * Math.exp(row[l]))]
  const perModel = Object.fromEntries(MODELS.map((m) => {
    const last = dists[m].q[h - 1]
    return [m, { p5: S0 * Math.exp(last[0]), p50: S0 * Math.exp(last[2]), p95: S0 * Math.exp(last[4]), probUp: dists[m].pAbove(0) }]
  })) as ForecastResult['perModel']
  const ann = Math.sqrt(252)
  const out: ForecastResult = {
    horizon: h, lastPrice: S0,
    p5: col(0), p25: col(1), p50: col(2), p75: col(3), p95: col(4),
    probUp: ens.pAbove(0), weights, perModel,
    garch: { alpha: g.fit.alpha, beta: g.fit.beta, persistence: g.fit.persistence, volNowAnnual: Math.sqrt(g.fit.nextVar) * ann, volLongRunAnnual: Math.sqrt(g.fit.longRunVar) * ann, fitted: g.fit.fitted },
    ewmaVolAnnual: rw.sigma * ann,
    histVolAnnual: std(rets.slice(-252)) * ann
  }
  if (o.target && o.target > 0) {
    const x = Math.log(o.target / S0)
    const above = ens.pAbove(x)
    out.target = { price: o.target, probAboveAtEnd: above, probBelowAtEnd: 1 - above, probTouch: ens.pTouch(x) }
  }
  return out
}

/** Weekday dates after `from` (ms), one per trading step; US market holidays are not skipped. */
export function businessDays(from: number, n: number): number[] {
  const out: number[] = []
  const d = new Date(from)
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() + 1)
    const wd = d.getUTCDay()
    if (wd !== 0 && wd !== 6) out.push(d.getTime())
  }
  return out
}
