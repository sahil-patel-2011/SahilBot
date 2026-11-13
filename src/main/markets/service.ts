// High-level market operations: each returns concise text for the model and a StockCardData for the UI.
// Used by the agent tools (src/main/agent/tools/stocks.ts) and the renderer's IPC (watchlist, cards).

import type { StockCardData, WatchlistItem } from '@shared/types'
import { NOT_ADVICE, big, buildCard, date, footer, money, num, pct, pctU, priceLine, techStats, vsBenchmark, type TechStats } from './analysis'
import { checkAlert, describeAlert, nyDate, type AlertSpec } from './alerts'
import { backtest, DEFAULT_PARAMS, STRATEGY_LABEL, type StrategyName, type StrategyParams } from './backtest'
import { TTL } from './cache'
import type { MarketData } from './data'
import { DISCLAIMER, MODEL_LABEL, MODELS, businessDays, forecast, walkForward, type WalkForwardResult } from './forecast'
import { betaCorr, logReturns, maxDrawdown, realizedVol, sharpe } from './indicators'
import { seedFrom } from './rng'
import type { SymbolInfo } from './symbols'
import type { Fundamentals, PriceHistory, Quote } from './types'

export interface MarketResult {
  text: string
  card: StockCardData
  /** compare: one card per symbol. */
  cards?: StockCardData[]
  display: string
}

const BENCH = 'SPY'

/** What an alert remembers between checks (kept by the app per routine). */
export interface AlertState {
  /** Level alerts: may fire (false after firing, until the condition clears). */
  armed: boolean
  /** Move alerts: the session it last fired on. */
  lastDay?: string
  firedAt?: number
}

interface Snapshot {
  info: SymbolInfo
  hist: PriceHistory
  quote: Quote
  stats: TechStats
  name?: string
  beta?: number
  corr?: number
  fundamentals?: Fundamentals | null
}

export class Markets {
  constructor(readonly data: MarketData) {}

  private async snapshot(symbol: string, signal?: AbortSignal, o: { fundamentals?: boolean; beta?: boolean } = {}): Promise<Snapshot> {
    const info = this.data.symbol(symbol)
    const hist = await this.data.daily(symbol, signal)
    if (hist.bars.length < 30) throw new Error(`Only ${hist.bars.length} days of history for ${info.display}: not enough to analyze.`)
    const quote = await this.data.quote(symbol, signal, hist)
    const stats = techStats(hist.bars)
    const company = info.us ? await this.data.company(symbol, signal).catch(() => null) : null
    const snap: Snapshot = { info, hist, quote, stats, name: company?.name }
    const work: Array<Promise<unknown>> = []
    if (o.beta !== false && info.display !== BENCH && info.kind === 'stock') {
      work.push(this.data.daily(BENCH, signal).then((b) => { const r = vsBenchmark(hist.bars, b.bars); if (r.n >= 60) { snap.beta = r.beta; snap.corr = r.corr } }).catch(() => undefined))
    } else if (info.display === BENCH) { snap.beta = 1; snap.corr = 1 }
    if (o.fundamentals && company) work.push(this.data.fundamentals(symbol, signal).then((f) => { snap.fundamentals = f }).catch(() => { snap.fundamentals = null }))
    await Promise.all(work)
    return snap
  }

  private sources(s: Snapshot, extra: string[] = []): string {
    const parts = [s.quote.live ? `${s.quote.source} quote; ${s.hist.source}` : s.hist.source]
    if (s.hist.stale) parts.push('(cached copy: data sources unreachable just now)')
    return [...parts, ...extra].join('; ')
  }

  private makeCard(s: Snapshot, kind: StockCardData['kind'], source: string, disclaimer?: string): StockCardData {
    const c = buildCard({ symbol: s.info.display, name: s.name, currency: s.info.currency, bars: s.hist.bars, quote: s.quote, stats: s.stats, beta: s.beta, fundamentals: s.fundamentals, source, disclaimer })
    c.kind = kind
    return c
  }

  // ---------------------------------------------------------------- quote

  async quote(symbol: string, signal?: AbortSignal): Promise<MarketResult> {
    const s = await this.snapshot(symbol, signal, { fundamentals: true })
    const t = s.stats
    const cur = s.info.currency
    const card = this.makeCard(s, 'quote', this.sources(s, s.fundamentals ? ['SEC EDGAR'] : []))
    const st = card.stats ?? {}
    const lines = [
      `${s.info.display}${s.name ? ` (${s.name})` : ''}: ${priceLine(s.quote, cur)}`,
      `Day change: ${pct(card.change1d, 2)}${card.changeAbs1d !== undefined ? ` (${card.changeAbs1d >= 0 ? '+' : ''}${num(card.changeAbs1d)})` : ''}. 1 month ${pct(t.return1m)}, YTD ${pct(t.returnYtd)}, 1 year ${pct(t.return1y)}.`,
      `52-week range ${money(t.low52, cur)} to ${money(t.high52, cur)} (now ${Math.round(t.rangePosition * 100)}% of the way up). Volume ${big(st.volume, '')} vs 3-month average ${big(t.avgVolume3m, '')}.`,
      `Volatility ${pctU(t.vol1y, 0)} a year (typical daily move about ±${pctU(t.vol1y / Math.sqrt(252), 1)}).${s.beta !== undefined ? ` Beta vs SPY ${num(s.beta)}.` : ''}`,
      ...(st.marketCap ? [`Market cap ${big(st.marketCap)}${st.pe ? `, P/E ${num(st.pe, 1)} (trailing diluted EPS ${money(st.eps)})` : ''}.`] : [])
    ]
    const live = s.quote.live
    return { text: lines.join('\n') + footer(card.source, s.quote.asOf, live), card, display: `${s.info.display} ${money(s.quote.price, cur)} ${pct(card.change1d, 2)}` }
  }

  // ---------------------------------------------------------------- analyze

  async analyze(symbol: string, signal?: AbortSignal): Promise<MarketResult> {
    const s = await this.snapshot(symbol, signal, { fundamentals: true })
    const t = s.stats
    const cur = s.info.currency
    const [filings, news] = await Promise.all([
      s.info.us ? this.data.filings(symbol, 6, signal).catch(() => ({ filings: [] as Array<{ form: string; filed: string; description: string; url: string }>, sic: undefined })) : Promise.resolve({ filings: [], sic: undefined }),
      this.data.news(symbol, 5, signal).catch(() => null)
    ])
    const srcExtra = [...(s.fundamentals || filings.filings.length ? ['SEC EDGAR'] : []), ...(news ? [`${news.source} news`] : [])]
    const card = this.makeCard(s, 'analysis', this.sources(s, srcExtra))
    const f = s.fundamentals
    if (f) card.fundamentals = { revenueTtm: f.revenueTtm, revenueGrowthYoY: f.revenueGrowthYoY, netIncomeTtm: f.netIncomeTtm, epsTtm: f.epsDilutedTtm, grossMargin: f.grossMargin, operatingMargin: f.operatingMargin, cash: f.cash, totalDebt: f.totalDebt, freeCashFlowTtm: f.freeCashFlowTtm, sharesOutstanding: f.sharesOutstanding, fiscalYearEnd: f.fiscalYearEnd }
    if (filings.filings.length) card.filings = filings.filings
    if (news?.items.length) card.news = news.items.map((n) => ({ title: n.title, url: n.url, publishedAt: n.publishedAt, source: n.source }))
    card.technicals = { macd: t.macd, macdSignal: t.macdSignal, bollPercentB: t.bollPercentB, atr14: t.atr14, sma20: t.sma20, return3m: t.return3m, return6m: t.return6m, returnYtd: t.returnYtd, sharpe1y: t.sharpe1y, sortino1y: t.sortino1y, vol1m: t.vol1m }
    const trend = Number.isFinite(t.sma200)
      ? `${t.last > t.sma200 ? 'above' : 'below'} its 200-day average (${money(t.sma200, cur)}) and ${t.last > t.sma50 ? 'above' : 'below'} its 50-day (${money(t.sma50, cur)})${t.sma50 > t.sma200 ? '; 50-day above 200-day' : '; 50-day below 200-day'}`
      : `${t.last > t.sma50 ? 'above' : 'below'} its 50-day average (${money(t.sma50, cur)}); under 200 days of history`
    const rsiWord = t.rsi14 >= 70 ? 'overbought territory by the usual rule of thumb' : t.rsi14 <= 30 ? 'oversold territory by the usual rule of thumb' : 'neutral range'
    const lines = [
      `# ${s.info.display}${s.name ? ` · ${s.name}` : ''}`,
      `Price: ${priceLine(s.quote, cur)}. Day ${pct(card.change1d, 2)}.`,
      `Returns: 1w ${pct(t.return1w)}, 1m ${pct(t.return1m)}, 3m ${pct(t.return3m)}, 6m ${pct(t.return6m)}, YTD ${pct(t.returnYtd)}, 1y ${pct(t.return1y)}.`,
      '',
      '## Technicals (descriptive, not predictive)',
      `- Trend: ${trend}.`,
      `- RSI(14) ${num(t.rsi14, 1)}: ${rsiWord}. MACD ${num(t.macd)} vs signal ${num(t.macdSignal)} (histogram ${num(t.macdHist)}).`,
      `- Bollinger %B ${num(t.bollPercentB)} (0 = lower band, 1 = upper band). ATR(14) ${money(t.atr14, cur)} (${pctU(t.atrPct)} of price).`,
      `- 52-week range ${money(t.low52, cur)}-${money(t.high52, cur)}.`,
      '',
      '## Risk',
      `- Volatility: ${pctU(t.vol1y, 0)}/yr over the last year, ${pctU(t.vol1m, 0)}/yr over the last month; EWMA ${pctU(t.ewmaVol, 0)}; GARCH now ${pctU(t.garchVolNow, 0)} vs long-run ${pctU(t.garchVolLongRun, 0)} (persistence ${num(t.garchPersistence, 3)}).`,
      `- Max drawdown: ${pct(t.maxDrawdown1y)} in the last year, ${pct(t.maxDrawdownAll)} over the ${((t.sessions) / 252).toFixed(1)} years of data.`,
      `- Sharpe ${num(t.sharpe1y)} (1y), ${num(t.sharpe5y)} (up to 5y); Sortino ${num(t.sortino1y)} (1y).${s.beta !== undefined ? ` Beta ${num(s.beta)}, correlation ${num(s.corr)} vs SPY (1y daily).` : ''}`
    ]
    if (f) {
      lines.push('', `## Fundamentals (SEC EDGAR; fiscal year ended ${f.fiscalYearEnd ?? 'n/a'})`,
        `- Revenue TTM ${big(f.revenueTtm)} (last fiscal year ${big(f.revenueFy)}, ${pct(f.revenueGrowthYoY)} vs the year before). Net income TTM ${big(f.netIncomeTtm)}.`,
        `- Margins: gross ${pctU(f.grossMargin)}, operating ${pctU(f.operatingMargin)}. Diluted EPS TTM ${money(f.epsDilutedTtm)}${card.stats?.pe ? `, P/E ${num(card.stats.pe, 1)}` : ''}.`,
        `- Cash ${big(f.cash)}, debt ${big(f.totalDebt)}, equity ${big(f.equity)} (balance sheet ${f.balanceSheetDate ?? 'n/a'}). Free cash flow TTM ${big(f.freeCashFlowTtm)}.`,
        `- Shares outstanding ${big(f.sharesOutstanding, '')}${card.stats?.marketCap ? `, market cap ${big(card.stats.marketCap)}` : ''}. Newest data from a ${f.latestFiling?.form ?? '?'} filed ${f.latestFiling?.filed ?? '?'}.`)
    } else if (s.info.kind === 'stock') {
      lines.push('', '## Fundamentals', '- No SEC company financials (an ETF, fund or non-US listing). Look up its fact sheet with web_search if needed.')
    }
    if (filings.filings.length) {
      lines.push('', '## Recent SEC filings')
      for (const x of filings.filings) lines.push(`- ${x.filed} ${x.form}: ${x.description} ${x.url}`)
    }
    if (news?.items.length) {
      lines.push('', `## Recent headlines (${news.source}; read before relying on them)`)
      for (const n of news.items) lines.push(`- ${date(n.publishedAt)} ${n.source}: ${n.title} ${n.url}`)
    }
    return { text: lines.join('\n') + footer(card.source, s.quote.asOf, s.quote.live), card, display: `Analyzed ${s.info.display}` }
  }

  // ---------------------------------------------------------------- forecast

  /** Walk-forward skill check, cached per symbol, last bar and horizon (it is the slow part). */
  private skill(sym: string, closes: number[], lastT: number, h: number): WalkForwardResult {
    const key = `wf:v1:${sym}:${date(lastT)}:${h}`
    const hit = this.data.cache.get<WalkForwardResult>(key, TTL.fundamentals)
    if (hit) return hit
    const r = walkForward(closes.slice(-2800), { h, seed: seedFrom(`${sym}:${h}`), maxOrigins: h >= 126 ? 60 : 120 })
    this.data.cache.set(key, r)
    return r
  }

  async forecast(symbol: string, o: { horizonDays?: number; target?: number } = {}, signal?: AbortSignal): Promise<MarketResult> {
    const h = Math.min(252, Math.max(1, Math.round(o.horizonDays ?? 21)))
    const s = await this.snapshot(symbol, signal)
    const cur = s.info.currency
    const closes = s.hist.bars.map((b) => b.c)
    if (closes.length < 300) throw new Error(`Only ${closes.length} days of history for ${s.info.display}; a forecast with an honest skill check needs at least 300.`)
    const lastBar = s.hist.bars[s.hist.bars.length - 1]
    const wf = this.skill(s.info.display, closes, lastBar.t, h)
    // The forecast starts from the latest price (a live quote when there is one).
    const series = s.quote.live && s.quote.asOf > lastBar.t ? [...closes, s.quote.price] : closes
    const fc = forecast(series, { h, weights: wf.weights, target: o.target, seed: seedFrom(`${s.info.display}:${date(lastBar.t)}:${h}`) })
    const card = this.makeCard(s, 'forecast', this.sources(s), DISCLAIMER)
    const start = s.quote.live ? s.quote.asOf : lastBar.t
    const dates = [start, ...businessDays(lastBar.t, h)]
    const weightText = MODELS.map((m) => `${MODEL_LABEL[m]} ${Math.round(wf.weights[m] * 100)}%`).join(', ')
    card.forecast = {
      horizonDays: h, dates, p5: fc.p5, p25: fc.p25, p50: fc.p50, p75: fc.p75, p95: fc.p95, probUp: fc.probUp,
      model: `Ensemble: ${weightText}`,
      skill: { coverage90: wf.ensemble.coverage90, pinballVsNaive: wf.ensemble.pinballVsNaive, directionalAccuracy: wf.ensemble.directionalAccuracy, samples: wf.samples }
    }
    card.forecastDetail = {
      verdict: wf.verdict, rangeSkill: wf.rangeSkill, directionSkill: wf.directionSkill, baseRateUp: wf.baseRateUp, naiveCoverage90: wf.naive.coverage90,
      models: MODELS.map((m) => ({ id: m, label: MODEL_LABEL[m], weight: wf.weights[m], coverage90: wf.models[m].coverage90, pinballVsNaive: wf.models[m].pinballVsNaive, directionalAccuracy: wf.models[m].directionalAccuracy, p5: fc.perModel[m].p5, p50: fc.perModel[m].p50, p95: fc.perModel[m].p95, probUp: fc.perModel[m].probUp })),
      ensemble: { coverage90: wf.ensemble.coverage90, pinballVsNaive: wf.ensemble.pinballVsNaive, directionalAccuracy: wf.ensemble.directionalAccuracy, samples: wf.samples, effectiveSamples: wf.effectiveSamples },
      volatility: { ewma: fc.ewmaVolAnnual, garchNow: fc.garch.volNowAnnual, garchLongRun: fc.garch.volLongRunAnnual, historical1y: fc.histVolAnnual }
    }
    const end = dates[dates.length - 1]
    if (fc.target) card.target = { ...fc.target, date: end }
    const P = (x: number): string => `${Math.round(x * 100)}%`
    const lines = [
      `# ${s.info.display}: range of plausible prices over ${h} trading days (to about ${date(end)})`,
      DISCLAIMER.replace(' Not financial advice.', ''),
      `Starting price: ${priceLine(s.quote, cur)}.`,
      '',
      `Ensemble percentiles at the horizon: 5% ${money(fc.p5[h], cur)} · 25% ${money(fc.p25[h], cur)} · median ${money(fc.p50[h], cur)} · 75% ${money(fc.p75[h], cur)} · 95% ${money(fc.p95[h], cur)}.`,
      `So there is roughly a 90% chance (if the past is a fair guide) it ends between ${money(fc.p5[h], cur)} and ${money(fc.p95[h], cur)} (${pct(fc.p5[h] / fc.lastPrice - 1, 0)} to ${pct(fc.p95[h] / fc.lastPrice - 1, 0)}), and a 50% chance between ${money(fc.p25[h], cur)} and ${money(fc.p75[h], cur)}.`,
      `P(ending higher than today) ≈ ${P(fc.probUp)}: the models assume no drift, so this is ~50% by design, not a call.`
    ]
    if (fc.target) {
      lines.push(`Target ${money(fc.target.price, cur)}: P(above it on ${date(end)}) ≈ ${P(fc.target.probAboveAtEnd)}; P(below) ≈ ${P(fc.target.probBelowAtEnd)}; P(a daily close reaches it at some point before then) ≈ ${P(fc.target.probTouch)}.`)
    }
    lines.push('',
      `Volatility inputs (annualized): last year ${pctU(fc.histVolAnnual, 0)}, EWMA ${pctU(fc.ewmaVolAnnual, 0)}, GARCH now ${pctU(fc.garch.volNowAnnual, 0)} reverting to ${pctU(fc.garch.volLongRunAnnual, 0)}.`,
      '',
      `## Honest skill check (walk-forward on ${s.info.display}'s own history, ${wf.samples} past forecasts, about ${wf.effectiveSamples} independent; each used only data available at the time)`,
      `- Ensemble: 90% band held the outcome ${P(wf.ensemble.coverage90)} of the time (target 90%); error ${num(wf.ensemble.pinballVsNaive)}x a naive random walk (below 1 = better; naive's band held ${P(wf.naive.coverage90)}); direction right ${P(wf.ensemble.directionalAccuracy)} vs ${P(wf.baseRateUp)} for always guessing up.`,
      ...MODELS.map((m) => `- ${MODEL_LABEL[m]} (weight ${Math.round(wf.weights[m] * 100)}%): coverage ${P(wf.models[m].coverage90)}, error ${num(wf.models[m].pinballVsNaive)}x naive, median ${money(fc.perModel[m].p50, cur)}, 5-95% ${money(fc.perModel[m].p5, cur)}-${money(fc.perModel[m].p95, cur)}.`),
      `- Verdict: ${wf.verdict}`,
      wf.rangeSkill ? '' : '- Because no model beat the naive baseline meaningfully, read this as "how much it typically moves", nothing more.',
      'Not modelled: earnings dates, news, market crashes beyond what history contains, and US market holidays. Real outcomes can fall outside every band.'
    )
    return { text: lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') + footer(card.source, s.quote.asOf, s.quote.live), card, display: `${s.info.display} ${h}-day range ${money(fc.p5[h], cur)}-${money(fc.p95[h], cur)}` }
  }

  // ---------------------------------------------------------------- compare

  async compare(symbols: string[], o: { days?: number } = {}, signal?: AbortSignal): Promise<MarketResult> {
    const uniq = [...new Set(symbols.map((x) => this.data.symbol(x).display))]
    if (uniq.length < 2 || uniq.length > 8) throw new Error('Compare 2 to 8 different symbols.')
    const days = Math.min(2520, Math.max(21, Math.round(o.days ?? 252)))
    const snaps = await Promise.all(uniq.map((x) => this.snapshot(x, signal)))
    const bars = snaps.map((s) => s.hist.bars)
    // Common window: dates every symbol traded, last `days` of them.
    const dayKey = (t: number): number => Math.floor(t / 86_400_000)
    const sets = bars.map((b) => new Set(b.map((x) => dayKey(x.t))))
    const common = bars[0].filter((x) => sets.every((s) => s.has(dayKey(x.t)))).map((x) => dayKey(x.t)).slice(-(days + 1))
    if (common.length < 30) throw new Error('These symbols have too few trading days in common to compare.')
    const commonSet = new Set(common)
    const closesOn = bars.map((b) => b.filter((x) => commonSet.has(dayKey(x.t))))
    const rets = closesOn.map((b) => b.slice(1).map((x, i) => x.c / b[i].c - 1))
    const n = uniq.length
    const corr = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : betaCorr(rets[i], rets[j]).corr)))
    const spyIdx = uniq.indexOf(BENCH)
    const rows = snaps.map((s, i) => {
      const c = closesOn[i].map((x) => x.c)
      return {
        symbol: s.info.display, name: s.name, price: s.quote.price,
        return1m: s.stats.return1m, return1y: s.stats.return1y,
        periodReturn: c[c.length - 1] / c[0] - 1,
        volatility: realizedVol(logReturns(c)),
        maxDrawdown: maxDrawdown(c).maxDrawdown,
        beta: spyIdx >= 0 ? betaCorr(rets[i], rets[spyIdx]).beta : s.beta,
        sharpe1y: sharpe(rets[i])
      }
    })
    const growth = closesOn.map((b, i) => ({ symbol: uniq[i], points: b.map((x) => [x.t, x.c / b[0].c] as [number, number]) }))
    const cards = snaps.map((s) => this.makeCard(s, 'compare', this.sources(s)))
    const card = { ...cards[0], compare: { symbols: uniq, rows: rows.map(({ periodReturn: _p, ...r }) => r), correlation: corr, growth, days: common.length - 1 } }
    const from = date(closesOn[0][0].t)
    const to = date(closesOn[0][closesOn[0].length - 1].t)
    const lines = [
      `# Comparison over ${common.length - 1} common trading days (${from} to ${to})`,
      '| Symbol | Price | Period return | 1y return | Volatility/yr | Max drawdown | Sharpe | Beta vs SPY |',
      '|---|---|---|---|---|---|---|---|',
      ...rows.map((r, i) => `| ${r.symbol} | ${money(r.price, snaps[i].info.currency)} | ${pct(r.periodReturn)} | ${pct(r.return1y)} | ${pctU(r.volatility, 0)} | ${pct(r.maxDrawdown)} | ${num(r.sharpe1y)} | ${r.beta === undefined ? 'n/a' : num(r.beta)} |`),
      '',
      'Correlation of daily returns (1 = move together, 0 = unrelated, negative = opposite):',
      ...uniq.flatMap((a, i) => uniq.slice(i + 1).map((b, j) => `- ${a} / ${b}: ${num(corr[i][i + 1 + j])}`)),
      '',
      'Past returns and correlations change over time; high correlation means less diversification benefit from holding both.'
    ]
    const src = [...new Set(snaps.map((s) => this.sources(s)))].join('; ')
    const asOf = Math.min(...snaps.map((s) => s.quote.asOf))
    return { text: lines.join('\n') + footer(src, asOf, snaps.every((s) => s.quote.live)), card, cards, display: `Compared ${uniq.join(', ')}` }
  }

  // ---------------------------------------------------------------- backtest

  async backtest(symbol: string, strategy: StrategyName, params: StrategyParams = {}, o: { years?: number; from?: string; to?: string; costBps?: number; slippageBps?: number } = {}, signal?: AbortSignal): Promise<MarketResult> {
    const s = await this.snapshot(symbol, signal, { beta: false })
    let bars = s.hist.bars
    if (o.to) bars = bars.filter((b) => date(b.t) <= o.to!)
    const warmup = Math.max(DEFAULT_PARAMS.momentum.lookback!, params.slow ?? 0, params.lookback ?? 0, 210) + 5
    if (o.from) {
      const i = bars.findIndex((b) => date(b.t) >= o.from!)
      if (i < 0) throw new Error(`No data after ${o.from}.`)
      bars = bars.slice(Math.max(0, i - warmup))
    } else if (o.years) {
      bars = bars.slice(-(Math.round(o.years * 252) + warmup))
    }
    const r = backtest(bars.map((b) => b.c), strategy, params, { costBps: o.costBps, slippageBps: o.slippageBps })
    const card = this.makeCard(s, 'backtest', this.sources(s))
    const eqBH: Array<[number, number]> = []
    let v = 1
    for (let t = r.start; t <= r.end; t++) { if (t > r.start) v *= bars[t].c / bars[t - 1].c; eqBH.push([bars[t].t, v]) }
    const m = r.metrics
    const b = r.buyHold
    card.backtest = {
      strategy: STRATEGY_LABEL[strategy], params: r.params as Record<string, number>, from: bars[r.start].t, to: bars[r.end].t,
      equity: r.equity.slice(r.start).map((e, i) => [bars[r.start + i].t, e] as [number, number]),
      buyHoldEquity: eqBH,
      metrics: { cagr: m.cagr, vol: m.vol, sharpe: m.sharpe, sortino: m.sortino, maxDrawdown: m.maxDrawdown, trades: m.trades, exposure: m.exposure, totalReturn: m.totalReturn },
      buyHold: { cagr: b.cagr, vol: b.vol, sharpe: b.sharpe, sortino: b.sortino, maxDrawdown: b.maxDrawdown, totalReturn: b.totalReturn },
      warnings: r.warnings
    }
    const paramText = Object.entries(r.params).map(([k, x]) => `${k}=${x}`).join(', ') || 'none'
    const lines = [
      `# Backtest: ${STRATEGY_LABEL[strategy]} on ${s.info.display}, ${date(bars[r.start].t)} to ${date(bars[r.end].t)} (${(r.days / 252).toFixed(1)} years)`,
      `Parameters: ${paramText}. Costs: ${(o.costBps ?? 5)} bps commission + ${(o.slippageBps ?? 5)} bps slippage per trade. Signals use closes up to each day; trades happen at the next close (no look-ahead). Long or flat, no leverage.`,
      '',
      '| | Strategy | Buy & hold |',
      '|---|---|---|',
      `| Total return | ${pct(m.totalReturn)} | ${pct(b.totalReturn)} |`,
      `| CAGR | ${pct(m.cagr)} | ${pct(b.cagr)} |`,
      `| Volatility/yr | ${pctU(m.vol)} | ${pctU(b.vol)} |`,
      `| Sharpe | ${num(m.sharpe)} | ${num(b.sharpe)} |`,
      `| Sortino | ${num(m.sortino)} | ${num(b.sortino)} |`,
      `| Max drawdown | ${pct(m.maxDrawdown)} | ${pct(b.maxDrawdown)} |`,
      `| Trades | ${m.trades} | 1 |`,
      `| Time in market | ${pctU(m.exposure, 0)} | 100% |`,
      '',
      `Costs paid: about ${pctU(m.costs, 2)} of capital.`,
      ...r.warnings.map((w) => `Warning: ${w}`)
    ]
    return { text: lines.join('\n') + footer(card.source, bars[r.end].t), card, display: `${STRATEGY_LABEL[strategy]} on ${s.info.display}: CAGR ${pct(m.cagr)} vs ${pct(b.cagr)}` }
  }

  // ---------------------------------------------------------------- watchlist (no model)

  /** Latest values for the watchlist: cached daily data (and a live quote when a key is set). Failures keep the symbol with what's known. */
  async quotes(symbols: string[], signal?: AbortSignal): Promise<WatchlistItem[]> {
    const list = [...new Set(symbols.map((x) => String(x).trim()).filter(Boolean))].slice(0, 50)
    const out: WatchlistItem[] = []
    for (let i = 0; i < list.length; i += 4) {
      const chunk = await Promise.all(list.slice(i, i + 4).map(async (sym): Promise<WatchlistItem> => {
        try {
          const info = this.data.symbol(sym)
          const hist = await this.data.daily(sym, signal)
          const q = await this.data.quote(sym, signal, hist)
          const company = info.us ? await this.data.company(sym, signal).catch(() => null) : null
          const prev = q.prevClose ?? hist.bars[hist.bars.length - 2]?.c
          return {
            symbol: info.display, name: company?.name, currency: info.currency, price: q.price, asOf: q.asOf,
            changeAbs: prev ? q.price - prev : undefined, changePct: prev ? (q.price / prev - 1) * 100 : undefined,
            spark: hist.bars.slice(-60).map((b) => b.c)
          }
        } catch {
          return { symbol: sym.toUpperCase() }
        }
      }))
      out.push(...chunk)
    }
    return out
  }

  // ---------------------------------------------------------------- price alerts (no model)

  /**
   * Checks a price alert. Level alerts (below/above) fire when the condition becomes true and re-arm only
   * after it clears; move alerts fire at most once per trading day. `state` is the alert's saved state.
   */
  async checkAlert(spec: AlertSpec, state: AlertState | undefined, signal?: AbortSignal): Promise<{ fired: boolean; state: AlertState; text?: string; card?: StockCardData; observed: string }> {
    const hist = await this.data.daily(spec.symbol, signal)
    const q = await this.data.quote(spec.symbol, signal, hist)
    const prevClose = q.prevClose ?? hist.bars[hist.bars.length - (q.live && q.asOf > hist.bars[hist.bars.length - 1].t + 6 * 3_600_000 ? 1 : 2)]?.c
    const r = checkAlert(spec, { price: q.price, prevClose, asOf: q.asOf })
    const st: AlertState = { armed: true, ...state }
    const day = q.live ? nyDate(new Date(q.asOf)) : date(q.asOf)
    const observed = `${spec.symbol} ${money(q.price)}${r.changePct !== undefined ? ` (${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(2)}% on the day)` : ''}`
    let fire = false
    if (spec.kind === 'move') {
      fire = r.hit && st.lastDay !== day
      if (fire) st.lastDay = day
    } else {
      fire = r.hit && st.armed
      st.armed = !r.hit
    }
    if (!fire) return { fired: false, state: st, observed }
    st.firedAt = Date.now()
    const info = this.data.symbol(spec.symbol)
    const stats = techStats(hist.bars)
    const card = buildCard({ symbol: info.display, currency: info.currency, bars: hist.bars, quote: q, stats, source: q.live ? `${q.source} quote; ${hist.source}` : hist.source })
    card.kind = 'alert'
    card.alert = { condition: describeAlert(spec), schedule: '', repeat: !!spec.repeat }
    const text = `Price alert: ${observed}, which meets your alert "${describeAlert(spec)}". Price: ${priceLine(q, info.currency)}.${spec.repeat ? ' The alert stays on.' : ' This alert has now been turned off (it fires once).'} SahilBot only watches prices; it never trades. ${NOT_ADVICE}`
    return { fired: true, state: st, text, card, observed }
  }

  /** One card for the UI (quote, or forecast when asked). */
  async card(symbol: string, o: { forecast?: boolean; horizonDays?: number } = {}): Promise<StockCardData> {
    return o.forecast ? (await this.forecast(symbol, { horizonDays: o.horizonDays })).card : (await this.quote(symbol)).card
  }
}

