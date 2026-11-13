// GARCH(1,1) volatility model, fit by Gaussian quasi-maximum likelihood.
//
//   r_t = eps_t,   eps_t = sigma_t * z_t,   sigma2_t = omega + alpha * eps2_{t-1} + beta * sigma2_{t-1}
//
// Robustness choices (stock returns are noisy and the likelihood surface is flat near alpha + beta = 1):
// - Variance targeting: omega = v * (1 - alpha - beta) with v the sample variance, so the long-run
//   variance always matches the data and only alpha and beta are estimated.
// - Bounded by construction: alpha in (0, 0.4), beta in (0, 0.9995 - alpha), so the process is always
//   stationary (alpha + beta < 0.9995) and variances stay positive.
// - Several starting points; the best likelihood wins. Too little data falls back to RiskMetrics-like
//   values (alpha 0.06, beta 0.93) and says so (fitted: false).

import { mean, nelderMead } from './stats'

export interface GarchFit {
  omega: number
  alpha: number
  beta: number
  /** alpha + beta: how slowly a volatility shock fades (0.98 = half-life of ~34 days). */
  persistence: number
  /** Long-run daily variance (= sample variance under variance targeting). */
  longRunVar: number
  /** Conditional variances for each return (sigma2_t), then the forecast for the next, unseen return. */
  variances: number[]
  /** Variance forecast for the next day. */
  nextVar: number
  /** Standardized residuals eps_t / sigma_t (unit variance, mean ~0). */
  residuals: number[]
  logLik: number
  /** The mean removed before fitting. */
  mu: number
  fitted: boolean
}

const sig = (x: number): number => 1 / (1 + Math.exp(-x))
const logit = (p: number): number => Math.log(p / (1 - p))
const MAX_ALPHA = 0.4
const MAX_PERSIST = 0.9995

function toParams(x: number[]): { alpha: number; beta: number } {
  const alpha = MAX_ALPHA * sig(x[0])
  const beta = (MAX_PERSIST - alpha) * sig(x[1])
  return { alpha, beta }
}
function fromParams(alpha: number, beta: number): number[] {
  return [logit(alpha / MAX_ALPHA), logit(beta / (MAX_PERSIST - alpha))]
}

/** Filters variances through the returns; returns the negative Gaussian log-likelihood (constant dropped). */
function filter(eps: number[], omega: number, alpha: number, beta: number, v0: number, out?: number[]): number {
  let s2 = v0
  let nll = 0
  for (let t = 0; t < eps.length; t++) {
    if (out) out[t] = s2
    nll += 0.5 * (Math.log(s2) + (eps[t] * eps[t]) / s2)
    s2 = omega + alpha * eps[t] * eps[t] + beta * s2
  }
  if (out) out[eps.length] = s2
  return nll
}

export function fitGarch(logRets: ArrayLike<number>, opts: { demean?: boolean; warm?: { alpha: number; beta: number } } = {}): GarchFit {
  const r = Array.from(logRets).filter(Number.isFinite)
  const mu = opts.demean === false ? 0 : mean(r) || 0
  const eps = r.map((x) => x - mu)
  const v = eps.length ? eps.reduce((s, e) => s + e * e, 0) / eps.length : 1e-4
  const longRunVar = v > 0 ? v : 1e-4
  const finish = (alpha: number, beta: number, fitted: boolean): GarchFit => {
    const omega = longRunVar * (1 - alpha - beta)
    const variances = new Array<number>(eps.length + 1)
    const nll = filter(eps, omega, alpha, beta, longRunVar, variances)
    const residuals = eps.map((e, t) => e / Math.sqrt(variances[t]))
    return { omega, alpha, beta, persistence: alpha + beta, longRunVar, variances, nextVar: variances[eps.length], residuals, logLik: -nll - 0.5 * eps.length * Math.log(2 * Math.PI), mu, fitted }
  }
  if (eps.length < 120) return finish(0.06, 0.93, false)
  const objective = (x: number[]): number => {
    const { alpha, beta } = toParams(x)
    return filter(eps, longRunVar * (1 - alpha - beta), alpha, beta, longRunVar)
  }
  const starts: Array<[number, number]> = [[0.05, 0.9], [0.1, 0.85], [0.03, 0.95], [0.15, 0.6]]
  if (opts.warm) starts.unshift([Math.min(MAX_ALPHA * 0.99, Math.max(1e-4, opts.warm.alpha)), Math.max(1e-4, Math.min(opts.warm.beta, MAX_PERSIST - opts.warm.alpha - 1e-4))])
  let best: { x: number[]; fx: number } | null = null
  for (const [a, b] of opts.warm ? starts.slice(0, 2) : starts) {
    const res = nelderMead(objective, fromParams(a, b), { step: 0.6, maxIter: 300, tol: 1e-9 })
    if (!best || res.fx < best.fx) best = res
  }
  if (!best || !Number.isFinite(best.fx)) return finish(0.06, 0.93, false)
  const { alpha, beta } = toParams(best.x)
  return finish(alpha, beta, true)
}

/**
 * Expected average daily variance over the next h days (for analytic intervals): the GARCH term
 * structure mean-reverts from nextVar toward the long-run variance at rate persistence.
 */
export function garchTermVariance(fit: GarchFit, h: number): number {
  const p = fit.persistence
  let total = 0
  let dev = fit.nextVar - fit.longRunVar
  for (let k = 0; k < h; k++) { total += fit.longRunVar + dev; dev *= p }
  return total
}
