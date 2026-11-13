// Backtests of simple, transparent long/flat strategies on daily closes.
//
// Timing (no look-ahead): the signal for day t uses closes up to and including day t. The trade happens
// at the NEXT day's close (t + 1), and the position earns returns from t + 1 onward. So a strategy can
// never trade on a price it couldn't have seen. Each change in position pays costs: commission plus
// slippage, in basis points of the traded amount.
//
// Honesty: a backtest is one path through history. Results that look great usually came from choosing
// the parameters after seeing the data (overfitting), and past returns don't predict future ones.

import { maxDrawdown, rsi, sharpe, sma, sortino } from './indicators'
import { std, TRADING_DAYS } from './stats'

export type StrategyName = 'buy_hold' | 'sma_cross' | 'momentum' | 'rsi_reversion'

export interface StrategyParams {
  /** sma_cross */
  fast?: number
  slow?: number
  /** momentum (12-1): lookback and skip in trading days, rebalanced every `rebalance` days. */
  lookback?: number
  skip?: number
  rebalance?: number
  /** rsi_reversion: buy when RSI(period) < entry, sell when RSI > exit. */
  period?: number
  entry?: number
  exit?: number
}

export const DEFAULT_PARAMS: Record<StrategyName, StrategyParams> = {
  buy_hold: {},
  sma_cross: { fast: 50, slow: 200 },
  momentum: { lookback: 252, skip: 21, rebalance: 21 },
  rsi_reversion: { period: 14, entry: 30, exit: 50 }
}

export const STRATEGY_LABEL: Record<StrategyName, string> = {
  buy_hold: 'Buy & hold',
  sma_cross: 'SMA crossover',
  momentum: 'Momentum (12-1)',
  rsi_reversion: 'RSI mean reversion'
}

/** Target position (0 or 1) decided at the close of each day, using closes[0..t] only. NaN = not enough history (flat). */
export function signals(closes: number[], name: StrategyName, p: StrategyParams = {}): number[] {
  const q = { ...DEFAULT_PARAMS[name], ...p }
  const n = closes.length
  switch (name) {
    case 'buy_hold':
      return new Array(n).fill(1)
    case 'sma_cross': {
      const f = sma(closes, q.fast!)
      const s = sma(closes, q.slow!)
      return closes.map((_, t) => (Number.isFinite(s[t]) ? (f[t] > s[t] ? 1 : 0) : NaN))
    }
    case 'momentum': {
      const out = new Array<number>(n).fill(NaN)
      let pos = NaN
      for (let t = 0; t < n; t++) {
        if (t >= q.lookback! && (Number.isNaN(pos) || (t - q.lookback!) % q.rebalance! === 0)) {
          pos = closes[t - q.skip!] / closes[t - q.lookback!] - 1 > 0 ? 1 : 0
        }
        out[t] = pos
      }
      return out
    }
    case 'rsi_reversion': {
      const r = rsi(closes, q.period!)
      const out = new Array<number>(n).fill(NaN)
      let pos = 0
      for (let t = 0; t < n; t++) {
        if (!Number.isFinite(r[t])) continue
        if (pos === 0 && r[t] < q.entry!) pos = 1
        else if (pos === 1 && r[t] > q.exit!) pos = 0
        out[t] = pos
      }
      return out
    }
  }
}

export interface BacktestMetrics {
  totalReturn: number
  cagr: number
  vol: number
  sharpe: number
  sortino: number
  maxDrawdown: number
  /** Round trips started (entries). */
  trades: number
  /** Share of days holding the stock. */
  exposure: number
  /** Costs paid, as a fraction of starting capital (approximate: summed). */
  costs: number
}

export interface BacktestResult {
  strategy: StrategyName
  params: StrategyParams
  /** Indices into the input: first day with a valid position through the last day. */
  start: number
  end: number
  days: number
  /** Position held on each day (earning that day's return), aligned to the input; NaN before start. */
  positions: number[]
  equity: number[]
  metrics: BacktestMetrics
  buyHold: BacktestMetrics
  /** Non-default parameters: results may be overfit if they were picked after looking at results. */
  tuned: boolean
  warnings: string[]
}

export interface BacktestOptions {
  /** Commission per trade, basis points of traded value (default 5). */
  costBps?: number
  /** Slippage per trade, basis points (default 5). */
  slippageBps?: number
  /** Annual risk-free rate for Sharpe/Sortino (default 0). */
  rf?: number
}

function metricsOf(daily: number[], pos: number[], costs: number, rf: number): BacktestMetrics {
  const eq: number[] = [1]
  for (const r of daily) eq.push(eq[eq.length - 1] * (1 + r))
  const total = eq[eq.length - 1] - 1
  const years = daily.length / TRADING_DAYS
  let trades = 0
  for (let i = 0; i < pos.length; i++) if (pos[i] > 0 && (i === 0 || !(pos[i - 1] > 0))) trades++
  return {
    totalReturn: total,
    cagr: years > 0 && eq[eq.length - 1] > 0 ? eq[eq.length - 1] ** (1 / years) - 1 : NaN,
    vol: std(daily) * Math.sqrt(TRADING_DAYS),
    sharpe: sharpe(daily, rf),
    sortino: sortino(daily, rf),
    maxDrawdown: maxDrawdown(eq).maxDrawdown,
    trades,
    exposure: pos.length ? pos.filter((p) => p > 0).length / pos.length : 0,
    costs
  }
}

export function backtest(closesIn: ArrayLike<number>, name: StrategyName, params: StrategyParams = {}, o: BacktestOptions = {}): BacktestResult {
  const closes = Array.from(closesIn)
  const q = { ...DEFAULT_PARAMS[name], ...params }
  const cost = ((o.costBps ?? 5) + (o.slippageBps ?? 5)) / 10_000
  const rf = o.rf ?? 0
  const sig = signals(closes, name, q)
  // Position earning day t's return (close t-1 -> close t) is the signal from close t-2, traded at close t-1.
  const positions = closes.map((_, t) => (t >= 2 ? sig[t - 2] : NaN))
  let start = positions.findIndex((p) => Number.isFinite(p))
  if (start < 0) throw new Error(`Not enough history for ${STRATEGY_LABEL[name]} with these settings (needs more than ${closes.length} days).`)
  start = Math.max(1, start)
  const daily: number[] = []
  const held: number[] = []
  const bh: number[] = []
  let prev = 0
  let paid = 0
  for (let t = start; t < closes.length; t++) {
    const pos = positions[t]
    const r = closes[t] / closes[t - 1] - 1
    // The trade into `pos` happened at close t-1; its cost hits that day's capital (charged on day t).
    const c = Math.abs(pos - prev) * cost
    paid += c
    daily.push(pos * r - c)
    held.push(pos)
    bh.push(r - (t === start ? cost : 0))
    prev = pos
  }
  const equity: number[] = new Array(start).fill(NaN)
  equity.push(1)
  for (const r of daily) equity.push(equity[equity.length - 1] * (1 + r))
  equity.length = closes.length
  const tuned = Object.entries(params).some(([k, v]) => v !== undefined && (DEFAULT_PARAMS[name] as Record<string, unknown>)[k] !== v)
  const metrics = metricsOf(daily, held, paid, rf)
  const buyHold = metricsOf(bh, bh.map(() => 1), cost, rf)
  const warnings: string[] = []
  if (tuned) warnings.push('These parameters differ from the textbook defaults. If they were chosen after looking at results, this backtest overstates what to expect (overfitting).')
  if (daily.length < 3 * TRADING_DAYS) warnings.push(`Only ${(daily.length / TRADING_DAYS).toFixed(1)} years tested: too short to tell skill from luck.`)
  if (metrics.trades < 10 && name !== 'buy_hold') warnings.push(`Only ${metrics.trades} trades: results depend on a handful of decisions.`)
  warnings.push('One historical path, before taxes; past performance does not predict future returns.')
  return { strategy: name, params: q, start, end: closes.length - 1, days: daily.length, positions: positions.map((p, t) => (t < start ? NaN : p)), equity, metrics, buyHold, tuned, warnings }
}
