import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Message, StockCardData, ToolCall } from '@shared/types'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { abbr, asOfText, compose, dayChange, money, openWatchlist, pct, percentScale, shortDate, signed, statPct, toWatchItem, useWatchlist, watchlist } from '../lib/stocks'

// Inline stock card in the chat, from a market tool's result (tool message meta.stock): price and day
// change, a price chart with 1M–1Y ranges and an optional forecast fan, model skill vs a random walk,
// key stats, and actions that hand the next step back to the user through the composer.

/** Small line-chart glyph (same stroke style as icons.tsx). */
export const ChartIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 19h16" /><path d="m5 15 4.5-5 3.5 3 6-7" /><path d="M15 6h4v4" />
  </svg>
)

type Steps = Array<{ call: Pick<ToolCall, 'id' | 'name'>; result?: Pick<Message, 'meta'> }>

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The card data a tool result carries, cleaned (sorted, finite series), or null when it isn't one. */
export function asStockCard(raw: unknown): StockCardData | null {
  const d = raw as Partial<StockCardData> | null
  if (!d || typeof d !== 'object' || typeof d.symbol !== 'string' || !d.symbol.trim() || !fin(d.price)) return null
  const series = (Array.isArray(d.series) ? d.series : [])
    .filter((p): p is [number, number] => Array.isArray(p) && fin(p[0]) && fin(p[1]) && p[1] > 0)
    .sort((a, b) => a[0] - b[0])
  let forecast = d.forecast
  if (forecast) {
    const n = forecast.dates?.length ?? 0
    const ok = n > 0 && (['p5', 'p25', 'p50', 'p75', 'p95'] as const).every((k) => Array.isArray(forecast![k]) && forecast![k].length === n && forecast![k].every(fin))
    if (!ok) forecast = undefined
  }
  return {
    ...d, symbol: d.symbol.trim().toUpperCase(), price: d.price, asOf: fin(d.asOf) ? d.asOf : series.at(-1)?.[0] ?? Date.now(),
    series, forecast, source: typeof d.source === 'string' ? d.source : '', disclaimer: typeof d.disclaimer === 'string' ? d.disclaimer : ''
  } as StockCardData
}

/** Stock cards from a run's tool results, one per symbol (the latest wins). */
export function stocksFromSteps(steps: Steps): Array<{ key: string; data: StockCardData }> {
  const out = new Map<string, { key: string; data: StockCardData }>()
  for (const s of steps) {
    const data = asStockCard(s.result?.meta?.stock)
    if (!data) continue
    out.delete(data.symbol)
    out.set(data.symbol, { key: `stock-${s.call.id}`, data })
  }
  return [...out.values()]
}

type RangeKey = '1M' | '3M' | '6M' | '1Y'
const RANGES: Array<[RangeKey, number]> = [['1M', 31], ['3M', 92], ['6M', 183], ['1Y', 366]]
const DAY = 864e5

/** Model skill in words, from the walk-forward backtest (pinball loss vs a naive random walk; <1 = better). */
function skillInfo(s: NonNullable<StockCardData['forecast']>['skill'], symbol: string): { label: string; edge: boolean; tip: string } | null {
  if (!s || !fin(s.pinballVsNaive)) return null
  const edge = s.pinballVsNaive <= 0.98
  const asPct = (v: number): number => Math.round(v <= 1 ? v * 100 : v)
  const cov = fin(s.coverage90) ? asPct(s.coverage90) : null
  const dir = fin(s.directionalAccuracy) ? asPct(s.directionalAccuracy) : null
  const tip = [
    `Tested on ${s.samples ?? 'several'} past forecasts for ${symbol}.`,
    `Its error was ${Math.round(s.pinballVsNaive * 100)}% of a random walk's (100% = no better than assuming prices just drift; lower is better).`,
    cov !== null ? `The 90% range held the actual price ${cov}% of the time (well calibrated ≈ 90%).${cov < 80 ? ' The ranges ran too narrow, so real swings may be bigger.' : ''}` : '',
    dir !== null ? `It called the direction right ${dir}% of the time.` : '',
    'Past skill does not guarantee future results.'
  ].filter(Boolean).join(' ')
  return { label: edge ? 'Slight edge' : 'No edge over a random walk', edge, tip }
}

export function StockCard({ data }: { data: StockCardData }) {
  const list = useWatchlist()
  const sym = data.symbol.toUpperCase()
  const onList = list.some((x) => x.symbol === sym)
  useEffect(() => { watchlist.remember(data) }, [data])

  const cur = data.currency ?? 'USD'
  const ch = dayChange(data)
  const up = (ch?.abs ?? 0) > 0
  const down = (ch?.abs ?? 0) < 0
  const span = data.series.length > 1 ? (data.series[data.series.length - 1][0] - data.series[0][0]) / DAY : 0
  // Ranges the series covers (plus the first one that shows all of it).
  const ranges = useMemo(() => {
    const out: RangeKey[] = []
    for (const [k, days] of RANGES) {
      out.push(k)
      if (days >= span * 0.9) break
    }
    return out
  }, [span])
  const [range, setRange] = useState<RangeKey>(() => (ranges.includes('3M') ? '3M' : ranges[ranges.length - 1]))
  const scale = percentScale(data)
  const fc = data.forecast
  const skill = skillInfo(fc?.skill, sym)
  const probUp = fc && fin(fc.probUp) ? Math.round(fc.probUp <= 1 ? fc.probUp * 100 : fc.probUp) : null
  const end = fc ? fc.p50.length - 1 : -1

  const add = (): void => {
    if (onList) { openWatchlist(); return }
    void watchlist.add(sym, toWatchItem(data)).then(() => toast(`Added ${sym} to your watchlist`, 'ok'))
  }

  return (
    <section className="stock-card" data-testid="stock-card" data-symbol={sym} aria-label={`${sym}${data.name ? `, ${data.name}` : ''} stock card`}>
      <header className="stk-head">
        <div className="stk-id">
          <span className="stk-sym">{sym}</span>
          {data.name && <span className="stk-name" title={data.name}>{data.name}</span>}
        </div>
        <span className="stk-kind"><ChartIcon size={12} /> Stock</span>
      </header>

      <div className="stk-quote">
        <span className="stk-price" data-testid="stock-price">{money(data.price, cur)}</span>
        {ch && (
          <span className={`stk-change${up ? ' up' : down ? ' down' : ''}`} data-testid="stock-change">
            <span aria-hidden>{up ? '▲' : down ? '▼' : '■'}</span>
            <span className="stk-sr">{up ? 'Up' : down ? 'Down' : 'Unchanged'}</span>
            {signed(ch.abs)} ({pct(ch.pct)})
            <span className="stk-change-when">today</span>
          </span>
        )}
      </div>
      <div className="stk-asof">As of {asOfText(data.asOf)}{data.source ? ` · ${data.source}` : ''}{cur !== 'USD' ? ` · ${cur}` : ''}</div>

      {data.series.length > 1 && (
        <>
          <div className="stk-toolbar">
            <div className="seg-tabs stk-ranges" role="tablist" aria-label="Chart range">
              {ranges.map((k) => (
                <button key={k} role="tab" aria-selected={range === k} className={range === k ? 'on' : ''} onClick={() => setRange(k)} data-testid={`stock-range-${k}`}>{k}</button>
              ))}
            </div>
            {fc && (
              <div className="stk-legend" aria-label="Chart legend">
                <span className="stk-key fan-outer" aria-hidden /><span className="stk-key fan-inner" aria-hidden />
                <span>Range of plausible prices (not a prediction)</span>
              </div>
            )}
          </div>
          <PriceChart data={data} days={RANGES.find(([k]) => k === range)![1]} rangeLabel={range} />
        </>
      )}

      {fc && end >= 0 && (
        <div className="stk-forecast" data-testid="stock-forecast">
          <div className="stk-fc-main">
            {probUp !== null && (
              <span className="stk-prob"><b>{probUp}% chance higher</b> in {fc.horizonDays} trading days</span>
            )}
            {skill && (
              <span className={`stk-skill${skill.edge ? ' edge' : ''}`} tabIndex={0} aria-describedby={`${sym}-skill-tip`} data-testid="stock-skill">
                <span className="stk-skill-dot" aria-hidden />Model skill: {skill.label}
                <span className="stk-tip" role="tooltip" id={`${sym}-skill-tip`}>{skill.tip}</span>
              </span>
            )}
          </div>
          <div className="stk-fc-range">
            Around {shortDate(fc.dates[end])}: middle {money(fc.p50[end], cur)} · half of outcomes {money(fc.p25[end], cur)}–{money(fc.p75[end], cur)} · 90% {money(fc.p5[end], cur)}–{money(fc.p95[end], cur)}
            {fc.model ? <span className="stk-model"> · {fc.model}</span> : null}
          </div>
        </div>
      )}

      <Stats data={data} scale={scale} />

      <div className="stk-actions">
        <button className={`btn stk-btn${onList ? ' on' : ''}`} onClick={add} data-testid="stock-add-watch" aria-pressed={onList}>
          {onList ? <><I.Check size={13} />On watchlist</> : <><I.Plus size={13} />Add to watchlist</>}
        </button>
        <button className="btn stk-btn" onClick={() => compose(`Make a full report page for ${sym}`)} data-testid="stock-report"><I.File size={13} />Open full report</button>
        <button className="btn stk-btn" onClick={() => compose(`Alert me when ${sym} `)} data-testid="stock-alert"><I.Clock size={13} />Set alert…</button>
      </div>

      <footer className="stk-foot">{data.disclaimer || 'For information only. Not financial advice.'}</footer>
    </section>
  )
}

// ---------------------------------------------------------------- stats

function Stats({ data, scale }: { data: StockCardData; scale: 1 | 100 }) {
  const s = data.stats ?? {}
  const cur = data.currency ?? 'USD'
  const rows: Array<{ label: string; value: string; tone?: 'up' | 'down'; title?: string }> = []
  const push = (label: string, value: string | null, extra?: { tone?: 'up' | 'down'; title?: string }): void => { if (value !== null) rows.push({ label, value, ...extra }) }
  const has = (v: number | undefined): v is number => fin(v)
  const tone = (v: number | undefined): 'up' | 'down' | undefined => (v === undefined ? undefined : v > 0 ? 'up' : v < 0 ? 'down' : undefined)
  push('Open', has(s.open) ? money(s.open, cur) : null)
  push('Market cap', has(s.marketCap) ? money(s.marketCap, cur, true) : null)
  push('52-wk range', has(s.low52) && has(s.high52) ? `${money(s.low52, cur)} – ${money(s.high52, cur)}` : null)
  push('Volume', has(s.volume) ? abbr(s.volume) : null, has(s.avgVolume) ? { title: `Average ${abbr(s.avgVolume)}` } : undefined)
  push('Avg volume', has(s.avgVolume) ? abbr(s.avgVolume) : null)
  push('P/E', has(s.pe) ? (s.pe > 0 ? s.pe.toFixed(1) : 'n/a') : null, { title: 'Price ÷ earnings per share (last 12 months)' })
  push('EPS', has(s.eps) ? money(s.eps, cur) : null)
  push('Div. yield', has(s.dividendYield) ? pct(statPct(s.dividendYield, scale), false) : null)
  push('Beta', has(s.beta) ? s.beta.toFixed(2) : null, { title: 'How much it has moved with the market (1 = in step)' })
  push('Volatility', has(s.volatility) ? pct(statPct(s.volatility, scale), false, 1) : null, { title: 'Annualized volatility of daily returns' })
  push('RSI (14)', has(s.rsi14) ? s.rsi14.toFixed(0) : null, { title: 'Relative Strength Index: above 70 often called overbought, below 30 oversold' })
  push('50-day avg', has(s.sma50) ? money(s.sma50, cur) : null)
  push('200-day avg', has(s.sma200) ? money(s.sma200, cur) : null)
  push('Max drawdown', has(s.maxDrawdown) ? pct(-Math.abs(statPct(s.maxDrawdown, scale)!), false, 1) : null, { tone: 'down', title: 'Largest peak-to-trough fall in the period' })
  push('1-month', has(s.return1m) ? pct(statPct(s.return1m, scale), true, 1) : null, { tone: tone(s.return1m) })
  push('1-year', has(s.return1y) ? pct(statPct(s.return1y, scale), true, 1) : null, { tone: tone(s.return1y) })
  if (!rows.length) return null
  return (
    <dl className="stk-stats" data-testid="stock-stats">
      {rows.map((r) => (
        <div key={r.label} className="stk-stat" title={r.title}>
          <dt>{r.label}</dt>
          <dd className={r.tone ?? ''}>{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}

// ---------------------------------------------------------------- chart

function niceTicks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo
  if (!(span > 0)) return [lo]
  const raw = span / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 1) ?? 10 * mag
  const out: number[] = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10))
  return out
}

type Pt = { t: number; v: number; i: number; fc: boolean }

/** Axis labels: whole amounts without cents ("$200"), small prices keep them. */
function axisMoney(v: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: Number.isInteger(v) ? 0 : 2, minimumFractionDigits: 0 }).format(v)
  } catch {
    return money(v, currency)
  }
}

function PriceChart({ data, days, rangeLabel }: { data: StockCardData; days: number; rangeLabel: string }) {
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(520)
  const [hover, setHover] = useState<number | null>(null)
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const cur = data.currency ?? 'USD'

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const sync = (): void => setWidth(Math.max(240, Math.round(el.clientWidth)))
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => setHover(null), [days])

  const W = width
  const H = W < 440 ? 150 : 188
  const padL = 4, padR = 58, padT = 12, padB = 22
  const series = data.series
  const last = series[series.length - 1]
  let vis = series.filter(([t]) => t >= last[0] - days * DAY)
  if (vis.length < 2) vis = series.slice(-2)
  const fc = data.forecast
  const tStart = vis[0][0]
  const tEnd = fc ? Math.max(last[0] + DAY, fc.dates[fc.dates.length - 1]) : last[0]
  const values = vis.map(([, v]) => v).concat(fc ? [...fc.p5, ...fc.p95] : [])
  let lo = Math.min(...values), hi = Math.max(...values)
  const pad = (hi - lo || hi * 0.02 || 1) * 0.08
  lo -= pad; hi += pad
  const x = (t: number): number => padL + ((t - tStart) / Math.max(1, tEnd - tStart)) * (W - padL - padR)
  const y = (v: number): number => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB)
  const f = (n: number): string => n.toFixed(1)

  const line = vis.map(([t, v], i) => `${i ? 'L' : 'M'}${f(x(t))} ${f(y(v))}`).join('')
  const area = `${line}L${f(x(last[0]))} ${H - padB}L${f(x(tStart))} ${H - padB}Z`
  const band = (upper: number[], lower: number[]): string => {
    if (!fc) return ''
    const top = fc.dates.map((t, i) => `L${f(x(t))} ${f(y(upper[i]))}`).join('')
    const bottom = fc.dates.map((t, i) => `L${f(x(t))} ${f(y(lower[i]))}`).reverse().join('')
    return `M${f(x(last[0]))} ${f(y(last[1]))}${top}${bottom}Z`
  }
  const median = fc ? `M${f(x(last[0]))} ${f(y(last[1]))}${fc.dates.map((t, i) => `L${f(x(t))} ${f(y(fc.p50[i]))}`).join('')}` : ''
  const ticks = niceTicks(lo + pad * 0.5, hi - pad * 0.5, H < 170 ? 3 : 4)
  const xLabels: Array<{ t: number; anchor: 'start' | 'middle' | 'end' }> = fc
    ? [{ t: tStart, anchor: 'start' }, { t: last[0], anchor: 'middle' }, { t: tEnd, anchor: 'end' }]
    : [{ t: tStart, anchor: 'start' }, { t: tStart + (last[0] - tStart) / 2, anchor: 'middle' }, { t: last[0], anchor: 'end' }]
  const longRange = days > 200
  // Skip a date label that would collide with one already placed (e.g. a short forecast on the 1Y view).
  const placed: Array<[number, number]> = []
  const shownLabels = xLabels.filter((l) => {
    const w = shortDate(l.t, longRange && l.anchor !== 'middle').length * 6.2
    const left = l.anchor === 'start' ? x(l.t) : l.anchor === 'end' ? x(l.t) - w : x(l.t) - w / 2
    if (placed.some(([a, b]) => left < b + 10 && left + w > a - 10)) return false
    placed.push([left, left + w])
    return true
  })

  const pts: Pt[] = [
    ...vis.map(([t, v], i) => ({ t, v, i, fc: false })),
    ...(fc ? fc.dates.map((t, i) => ({ t, v: fc.p50[i], i, fc: true })) : [])
  ]

  const nearest = (px: number): number => {
    let best = 0, d = Infinity
    pts.forEach((p, i) => { const dd = Math.abs(x(p.t) - px); if (dd < d) { d = dd; best = i } })
    return best
  }
  const hp = hover !== null ? pts[hover] : null
  const first = vis[0][1], lastV = last[1]
  const rangeChange = (lastV / first - 1) * 100
  const summary = `${data.symbol} price chart, ${rangeLabel}: ${money(first, cur)} on ${shortDate(tStart)} to ${money(lastV, cur)} on ${shortDate(last[0])} (${pct(rangeChange)})${fc ? `, with a ${fc.horizonDays}-trading-day range of plausible prices` : ''}. Use the arrow keys to read values.`
  const tipText = hp
    ? hp.fc && fc
      ? `${shortDate(hp.t, longRange)} (forecast): middle ${money(fc.p50[hp.i], cur)}; half of outcomes ${money(fc.p25[hp.i], cur)}–${money(fc.p75[hp.i], cur)}; 90% ${money(fc.p5[hp.i], cur)}–${money(fc.p95[hp.i], cur)}`
      : `${shortDate(hp.t, true)}: ${money(hp.v, cur)}`
    : ''

  return (
    <div className="stk-chart" ref={wrap} data-testid="stock-chart" tabIndex={0} role="group" aria-label={summary}
      onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover(nearest(e.clientX - r.left)) }}
      onPointerLeave={() => setHover(null)}
      onBlur={() => setHover(null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setHover((h) => Math.max(0, Math.min(pts.length - 1, (h ?? (e.key === 'ArrowLeft' ? pts.length : vis.length - 2)) + (e.key === 'ArrowLeft' ? -1 : 1)))) }
        if (e.key === 'Home') { e.preventDefault(); setHover(0) }
        if (e.key === 'End') { e.preventDefault(); setHover(pts.length - 1) }
        if (e.key === 'Escape') setHover(null)
      }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden>
        <defs>
          <linearGradient id={`stk-area-${uid}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--stk-line)" stopOpacity="0.18" />
            <stop offset="1" stopColor="var(--stk-line)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((v) => (
          <g key={v} className="stk-grid">
            <line x1={padL} x2={W - padR + 4} y1={f(y(v))} y2={f(y(v))} />
            <text x={W - padR + 8} y={y(v) + 3.5}>{axisMoney(v, cur)}</text>
          </g>
        ))}
        {fc && (
          <g className="stk-fan" data-testid="stock-fan">
            <rect className="stk-future" x={x(last[0])} y={padT - 4} width={Math.max(0, W - padR - x(last[0]))} height={H - padT - padB + 4} />
            <path className="fan-outer" d={band(fc.p95, fc.p5)} />
            <path className="fan-inner" d={band(fc.p75, fc.p25)} />
            <path className="fan-median" d={median} />
            <line className="stk-today" x1={x(last[0])} x2={x(last[0])} y1={padT - 4} y2={H - padB} />
          </g>
        )}
        <path d={area} fill={`url(#stk-area-${uid})`} />
        <path className="stk-line" d={line} />
        <circle className="stk-last" cx={x(last[0])} cy={y(last[1])} r={3} />
        {shownLabels.map((l) => (
          <text key={`${l.t}-${l.anchor}`} className="stk-xlabel" x={x(l.t)} y={H - 6} textAnchor={l.anchor}>
            {shortDate(l.t, longRange && l.anchor !== 'middle')}
          </text>
        ))}
        {hp && (
          <g className="stk-cross">
            <line x1={x(hp.t)} x2={x(hp.t)} y1={padT - 4} y2={H - padB} />
            <circle cx={x(hp.t)} cy={y(hp.v)} r={4} className={hp.fc ? 'fc' : ''} />
          </g>
        )}
      </svg>
      <div className={`stk-tooltip${hp ? ' on' : ''}`} aria-hidden
        style={hp ? { left: Math.max(8, Math.min(W - 8, x(hp.t))), transform: `translateX(${x(hp.t) > W * 0.62 ? '-100%' : x(hp.t) < W * 0.25 ? '0' : '-50%'})` } : undefined}>
        {hp && (hp.fc && fc ? (
          <>
            <span className="stk-tt-date">{shortDate(hp.t, longRange)} · forecast</span>
            <b>{money(fc.p50[hp.i], cur)}</b>
            <span className="stk-tt-sub">50%: {money(fc.p25[hp.i], cur)}–{money(fc.p75[hp.i], cur)} · 90%: {money(fc.p5[hp.i], cur)}–{money(fc.p95[hp.i], cur)}</span>
          </>
        ) : (
          <><span className="stk-tt-date">{new Date(hp.t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</span><b>{money(hp.v, cur)}</b></>
        ))}
      </div>
      <span className="stk-sr" aria-live="polite">{tipText}</span>
    </div>
  )
}
