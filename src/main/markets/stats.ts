// Small numeric helpers shared by the indicators, models and backtests. Pure functions, no I/O.

export const TRADING_DAYS = 252

export function mean(xs: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < xs.length; i++) s += xs[i]
  return xs.length ? s / xs.length : NaN
}

/** Sample standard deviation (n - 1). */
export function std(xs: ArrayLike<number>): number {
  const n = xs.length
  if (n < 2) return NaN
  const m = mean(xs)
  let s = 0
  for (let i = 0; i < n; i++) s += (xs[i] - m) ** 2
  return Math.sqrt(s / (n - 1))
}

/** Population standard deviation (n), as Bollinger Bands use it. */
export function pstd(xs: ArrayLike<number>): number {
  const n = xs.length
  if (!n) return NaN
  const m = mean(xs)
  let s = 0
  for (let i = 0; i < n; i++) s += (xs[i] - m) ** 2
  return Math.sqrt(s / n)
}

/** Linear-interpolated quantile of an ascending-sorted array (type 7, like numpy's default). */
export function quantileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length
  if (!n) return NaN
  if (n === 1) return sorted[0]
  const h = (n - 1) * Math.min(1, Math.max(0, p))
  const lo = Math.floor(h)
  const hi = Math.min(n - 1, lo + 1)
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo])
}

export function quantile(xs: ArrayLike<number>, p: number): number {
  return quantileSorted(Float64Array.from(xs).sort(), p)
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf; error < 1.5e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2)
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2
}

/** Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9 after one Newton step). */
export function normInv(p: number): number {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  let x: number
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p))
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  } else if (p <= 1 - lo) {
    const q = p - 0.5
    const r = q * q
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  // One Halley step against the CDF tightens the tails.
  const e = normCdf(x) - p
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2)
  return x - u / (1 + (x * u) / 2)
}

/**
 * Nelder-Mead minimizer for small, smooth problems (GARCH has 2 free parameters here). Returns the best
 * point found; never throws. Non-finite objective values count as +Infinity, so bad regions are avoided.
 */
export function nelderMead(f: (x: number[]) => number, x0: number[], opts: { step?: number; maxIter?: number; tol?: number } = {}): { x: number[]; fx: number; iterations: number } {
  const n = x0.length
  const step = opts.step ?? 0.5
  const maxIter = opts.maxIter ?? 200 * n
  const tol = opts.tol ?? 1e-8
  const val = (x: number[]): number => { const v = f(x); return Number.isFinite(v) ? v : Infinity }
  let simplex = [x0.slice(), ...Array.from({ length: n }, (_, i) => { const x = x0.slice(); x[i] += step; return x })]
  let fs = simplex.map(val)
  let it = 0
  for (; it < maxIter; it++) {
    const order = fs.map((v, i) => i).sort((a, b) => fs[a] - fs[b])
    simplex = order.map((i) => simplex[i])
    fs = order.map((i) => fs[i])
    if (Math.abs(fs[n] - fs[0]) <= tol * (Math.abs(fs[0]) + tol)) break
    const centroid = Array.from({ length: n }, (_, j) => simplex.slice(0, n).reduce((s, p) => s + p[j], 0) / n)
    const at = (t: number): number[] => centroid.map((c, j) => c + t * (simplex[n][j] - c))
    const xr = at(-1); const fr = val(xr)
    if (fr < fs[0]) {
      const xe = at(-2); const fe = val(xe)
      if (fe < fr) { simplex[n] = xe; fs[n] = fe } else { simplex[n] = xr; fs[n] = fr }
    } else if (fr < fs[n - 1]) {
      simplex[n] = xr; fs[n] = fr
    } else {
      const xc = fr < fs[n] ? at(-0.5) : at(0.5)
      const fc = val(xc)
      if (fc < Math.min(fr, fs[n])) { simplex[n] = xc; fs[n] = fc } else {
        // Shrink toward the best point.
        for (let i = 1; i <= n; i++) { simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j])); fs[i] = val(simplex[i]) }
      }
    }
  }
  let best = 0
  for (let i = 1; i <= n; i++) if (fs[i] < fs[best]) best = i
  return { x: simplex[best], fx: fs[best], iterations: it }
}
