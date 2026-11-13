import type { Db } from '../../db'
import { alertCron, alertFromPrompt, alertPrompt, describeAlert, parseAlert, type AlertSpec } from '../../markets/alerts'
import type { StrategyName } from '../../markets/backtest'
import { DISCLAIMER } from '../../markets/forecast'
import type { Markets, MarketResult } from '../../markets/service'
import { describeSchedule, type Scheduler } from '../../scheduler'
import type { ToolDef, ToolOutput } from '../types'

// Stock market tools: quotes, analysis, probabilistic forecasts with an honest skill check, comparisons,
// strategy backtests and price alerts. All read-only market data: SahilBot cannot place trades, move
// money or connect to a brokerage, and these tools never will. Every result ends with its data source,
// as-of date and "Not financial advice."

const GROUP = 'Stocks'
const READ_ONLY = 'Read-only market data and analysis; cannot trade.'
const sym = { type: 'string', description: 'Ticker, e.g. AAPL, BRK.B, SPY, ^SPX, VOD.L' }

const out = (r: MarketResult): ToolOutput => ({
  text: r.text,
  display: r.display,
  meta: { stock: r.card, ...(r.cards ? { stocks: r.cards } : {}) }
})

export function stockTools(markets: Markets, deps: { scheduler: Scheduler; db: Db; liveQuotes: () => boolean }): ToolDef[] {
  const quote: ToolDef<{ symbol: string }> = {
    name: 'stock_quote',
    label: 'Stock quote',
    group: GROUP,
    effect: 'read',
    untrusted: true,
    description: `Current price of a stock, ETF or index with day change, 52-week range, volume, volatility, beta, market cap and P/E. Without a market data key the price is the last daily close and says its date. Shows a stock card in the chat. ${READ_ONLY}`,
    parameters: { type: 'object', properties: { symbol: sym }, required: ['symbol'], additionalProperties: false },
    async run(a, ctx) { return out(await markets.quote(a.symbol, ctx.signal)) }
  }

  const analyze: ToolDef<{ symbol: string }> = {
    name: 'stock_analyze',
    label: 'Analyzing stock',
    group: GROUP,
    effect: 'read',
    untrusted: true,
    description: `Full picture of one stock: returns, technicals (moving averages, RSI, MACD, Bollinger, ATR), risk (volatility, GARCH, drawdown, Sharpe, beta), SEC fundamentals (revenue, earnings, margins, cash, debt) and recent SEC filings with links, plus headlines when a news key is set. ${READ_ONLY}`,
    parameters: { type: 'object', properties: { symbol: sym }, required: ['symbol'], additionalProperties: false },
    async run(a, ctx) { return out(await markets.analyze(a.symbol, ctx.signal)) }
  }

  const fc: ToolDef<{ symbol: string; horizon_days?: number; target_price?: number }> = {
    name: 'stock_forecast',
    label: 'Forecasting range',
    group: GROUP,
    effect: 'read',
    untrusted: true,
    description: `Range of plausible future prices (5/25/50/75/95th percentiles) over a horizon in trading days, P(ending higher), and for a target price P(above it at the horizon) and P(touching it before then). Ensemble of a random walk with EWMA volatility, GARCH(1,1) Monte Carlo and a block bootstrap, with a walk-forward check on the stock's own history against a naive random walk (coverage, error vs naive, direction accuracy). ${DISCLAIMER} Always report the skill numbers with the range.`,
    parameters: {
      type: 'object',
      properties: {
        symbol: sym,
        horizon_days: { type: 'integer', minimum: 1, maximum: 252, description: 'Trading days ahead (default 21 ≈ 1 month; 63 ≈ 3 months; 252 ≈ 1 year)' },
        target_price: { type: 'number', exclusiveMinimum: 0, description: 'Optional price to get probabilities for' }
      },
      required: ['symbol'],
      additionalProperties: false
    },
    async run(a, ctx) { return out(await markets.forecast(a.symbol, { horizonDays: a.horizon_days, target: a.target_price }, ctx.signal)) }
  }

  const compare: ToolDef<{ symbols: string[]; days?: number }> = {
    name: 'stock_compare',
    label: 'Comparing stocks',
    group: GROUP,
    effect: 'read',
    untrusted: true,
    description: `Compare 2-8 stocks/ETFs over the same dates: returns, volatility, max drawdown, Sharpe, beta vs SPY and the correlation matrix of daily returns. ${READ_ONLY}`,
    parameters: {
      type: 'object',
      properties: {
        symbols: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 8 },
        days: { type: 'integer', minimum: 21, maximum: 2520, description: 'Trading days to compare (default 252 ≈ 1 year)' }
      },
      required: ['symbols'],
      additionalProperties: false
    },
    async run(a, ctx) { return out(await markets.compare(a.symbols, { days: a.days }, ctx.signal)) }
  }

  type BtArgs = { symbol: string; strategy: StrategyName; fast?: number; slow?: number; lookback?: number; skip?: number; rebalance?: number; period?: number; entry?: number; exit?: number; years?: number; from?: string; to?: string; cost_bps?: number; slippage_bps?: number }
  const bt: ToolDef<BtArgs> = {
    name: 'stock_backtest',
    label: 'Backtesting',
    group: GROUP,
    effect: 'read',
    untrusted: true,
    description: `Backtest a simple long/flat strategy on daily closes vs buy & hold, with costs and slippage and no look-ahead: buy_hold; sma_cross (fast, slow; default 50/200); momentum (12-1: lookback 252, skip 21, rebalance 21 days); rsi_reversion (period 14, buy below entry 30, sell above exit 50). Period: years back, or from/to dates (YYYY-MM-DD). Returns CAGR, volatility, Sharpe, Sortino, max drawdown, trades and time in market. Warn about overfitting when parameters were tuned. ${READ_ONLY}`,
    parameters: {
      type: 'object',
      properties: {
        symbol: sym,
        strategy: { type: 'string', enum: ['buy_hold', 'sma_cross', 'momentum', 'rsi_reversion'] },
        fast: { type: 'integer', minimum: 2, maximum: 250 }, slow: { type: 'integer', minimum: 3, maximum: 400 },
        lookback: { type: 'integer', minimum: 21, maximum: 504 }, skip: { type: 'integer', minimum: 0, maximum: 63 }, rebalance: { type: 'integer', minimum: 1, maximum: 126 },
        period: { type: 'integer', minimum: 2, maximum: 50 }, entry: { type: 'number', minimum: 1, maximum: 99 }, exit: { type: 'number', minimum: 1, maximum: 99 },
        years: { type: 'number', minimum: 1, maximum: 12 },
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        cost_bps: { type: 'number', minimum: 0, maximum: 100 }, slippage_bps: { type: 'number', minimum: 0, maximum: 100 }
      },
      required: ['symbol', 'strategy'],
      additionalProperties: false
    },
    async run(a, ctx) {
      if (a.strategy === 'sma_cross' && a.fast && a.slow && a.fast >= a.slow) throw new Error('fast must be shorter than slow.')
      const params = Object.fromEntries((['fast', 'slow', 'lookback', 'skip', 'rebalance', 'period', 'entry', 'exit'] as const).filter((k) => a[k] !== undefined).map((k) => [k, a[k]]))
      return out(await markets.backtest(a.symbol, a.strategy, params, { years: a.years ?? (a.from ? undefined : 10), from: a.from, to: a.to, costBps: a.cost_bps, slippageBps: a.slippage_bps }, ctx.signal))
    }
  }

  type AlertArgs = { action?: 'create' | 'list' | 'cancel'; condition?: string; symbol?: string; kind?: 'below' | 'above' | 'move'; threshold?: number; direction?: 'up' | 'down' | 'either'; repeat?: boolean; id?: string }
  const alerts = (): Array<{ id: string; spec: AlertSpec; enabled: boolean; next: number | null; last: string | null }> =>
    deps.scheduler.list().flatMap((t) => { const spec = alertFromPrompt(t.prompt); return spec ? [{ id: t.id, spec, enabled: t.enabled, next: t.nextRun, last: t.lastStatus }] : [] })
  const alert: ToolDef<AlertArgs> = {
    name: 'price_alert',
    label: 'Price alert',
    group: GROUP,
    effect: (a) => (a.action === 'list' ? 'read' : 'write_local'),
    describe: (a) => (a.action === 'cancel' ? `Cancel price alert ${a.id ?? ''}` : a.action === 'list' ? 'List price alerts' : `Price alert: ${a.condition ?? `${a.symbol} ${a.kind} ${a.threshold}`}`),
    description: 'Watch a price and notify the user: create {condition: "AAPL below 180" | "NVDA moves ±5% in a day" | "TSLA above 300" | "MSFT down 3%"} (or symbol + kind below/above/move + threshold [+ direction up/down/either]); repeat=true keeps it on after it fires (default: stop after firing). Checks run on their own as a routine of this bot (every 15 minutes in US market hours with a live quote key, otherwise once a day after the close), without using the model. list; cancel {id}. Alerts only notify: they never buy or sell anything.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'cancel'] },
        condition: { type: 'string', maxLength: 120 },
        symbol: { type: 'string' }, kind: { type: 'string', enum: ['below', 'above', 'move'] }, threshold: { type: 'number', exclusiveMinimum: 0 },
        direction: { type: 'string', enum: ['up', 'down', 'either'] }, repeat: { type: 'boolean' }, id: { type: 'string' }
      },
      additionalProperties: false
    },
    async run(a, ctx) {
      const action = a.action ?? 'create'
      if (action === 'list') {
        const xs = alerts()
        if (!xs.length) return { text: 'No price alerts.', display: 'no alerts' }
        return { text: xs.map((x) => `- [${x.id}] ${describeAlert(x.spec)}${x.spec.repeat ? ' (repeats)' : ''}: ${x.enabled ? `next check ${x.next ? new Date(x.next).toLocaleString() : 'n/a'}` : 'off'}${x.last ? `, last: ${x.last}` : ''}`).join('\n'), display: `${xs.length} alert${xs.length === 1 ? '' : 's'}` }
      }
      if (action === 'cancel') {
        const x = alerts().find((y) => y.id === a.id)
        if (!x) throw new Error(`No price alert with id ${a.id}. Use action "list" to see them.`)
        deps.scheduler.remove(x.id)
        return { text: `Cancelled the alert "${describeAlert(x.spec)}".`, display: `cancelled ${x.spec.symbol} alert` }
      }
      let spec: AlertSpec | null = a.condition ? parseAlert(a.condition) : null
      if (!spec && a.symbol && a.kind && a.threshold) spec = { symbol: markets.data.symbol(a.symbol).display, kind: a.kind, threshold: a.threshold, ...(a.kind === 'move' ? { direction: a.direction ?? 'either' } : {}) }
      if (!spec) throw new Error('Couldn\'t read that condition. Use e.g. "AAPL below 180", "NVDA moves ±5% in a day", or pass symbol, kind (below/above/move) and threshold.')
      if (a.repeat) spec.repeat = true
      // Check the symbol exists (and show where it is now) before scheduling anything.
      const now = await markets.quote(spec.symbol, ctx.signal)
      const live = deps.liveQuotes()
      const thread = deps.db.getThread(ctx.threadId)
      const space = thread ? deps.db.getSpace(thread.spaceId) : undefined
      const t = deps.scheduler.create({ title: `Price alert: ${describeAlert(spec)}`, prompt: alertPrompt(spec), schedule: { type: 'cron', expr: alertCron(live) }, spaceId: thread?.spaceId ?? '', threadId: thread && space?.isMain ? thread.id : null })
      const card = now.card
      card.kind = 'alert'
      card.alert = { condition: describeAlert(spec), schedule: describeSchedule(t.schedule), repeat: !!spec.repeat, routineId: t.id }
      const freq = live ? 'every 15 minutes during US market hours (weekdays)' : 'once each weekday evening after the US close, using daily closes (add a live quote key in Settings → Markets for intraday checks)'
      return {
        text: `Price alert set [${t.id}]: ${describeAlert(spec)}. Checked ${freq}; ${spec.repeat ? 'it stays on after firing' : 'it turns off after it fires'}. Right now: ${now.display}. It only notifies; SahilBot never trades.\n\nData: ${card.source}. Not financial advice.`,
        display: `alert ${describeAlert(spec)}`,
        meta: { stock: card }
      }
    }
  }

  return [quote, analyze, fc, compare, bt, alert]
}
