import { useEffect, useMemo, useState } from 'react'
import type { UsageDashboard, UsageGlance } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { SpendBar, money } from './SpendingLimit'
import '../styles-usage-dash.css'

// Settings → Usage: this month's spend against the monthly limit, this week and lifetime, tokens per day (30
// days) and per week (12 weeks), and this month per model, provider and bot. Cloud = pay-per-use requests
// (priced when made, with the providers' own token detail); local = replies from models on this Mac. Plain SVG
// charts. The compact card (profile menu, ⌘K "Usage") is UsageGlanceHost below.

const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const num = (n: number): string => Math.round(n).toLocaleString()
export const tokens = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)))
const pct = (x: number): string => (x <= 0 ? '—' : x < 0.001 ? '<0.1%' : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`)
const shortDay = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const since = (t: number | null): string => (t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '')

interface Bar { key: string; label: string; local: number; cloud: number; tip: string }

/** A clean stacked bar chart (cloud over local), in SVG: gridlines, a max label, hover / focus details. */
function BarChart({ bars, title, axis, testId }: { bars: Bar[]; title: string; axis: [string, string]; testId: string }) {
  const [hot, setHot] = useState<number | null>(null)
  const W = 600
  const H = 132
  const max = Math.max(1, ...bars.map((b) => b.local + b.cloud))
  // A round top for the scale: 1, 2, 5 x 10^n.
  const step = 10 ** Math.floor(Math.log10(max))
  const top = [1, 2, 5, 10].map((m) => m * step).find((v) => v >= max) ?? max
  const slot = W / bars.length
  const bw = Math.max(2, Math.min(28, slot * 0.64))
  const y = (v: number): number => H - (v / top) * H
  const tip = hot !== null ? bars[hot] : null
  return (
    <div className="ud-chart" onMouseLeave={() => setHot(null)} data-testid={testId}>
      <svg viewBox={`0 0 ${W} ${H + 1}`} preserveAspectRatio="none" role="img" aria-label={title} className="ud-svg">
        {[0.5, 1].map((f) => <line key={f} x1={0} x2={W} y1={y(top * f)} y2={y(top * f)} className="ud-grid" />)}
        <line x1={0} x2={W} y1={H} y2={H} className="ud-base" />
        {bars.map((b, i) => {
          const x = i * slot + (slot - bw) / 2
          const hl = y(b.local)
          const hc = y(b.local + b.cloud)
          return (
            <g key={b.key} className={hot === i ? 'hot' : ''} onMouseEnter={() => setHot(i)} onFocus={() => setHot(i)} tabIndex={0} aria-label={b.tip}>
              <rect x={i * slot} y={0} width={slot} height={H} className="ud-hit" />
              {b.local > 0 && <rect x={x} y={hl} width={bw} height={Math.max(1, H - hl)} rx={Math.min(3, bw / 3)} className="ud-local" />}
              {b.cloud > 0 && <rect x={x} y={hc} width={bw} height={Math.max(1, hl - hc)} rx={Math.min(3, bw / 3)} className="ud-cloud" />}
            </g>
          )
        })}
      </svg>
      <div className="ud-scale"><span>{tokens(top)}</span><span>{tokens(top / 2)}</span></div>
      <div className="ud-axis"><span>{axis[0]}</span><span>{axis[1]}</span></div>
      <div className="ud-tip" aria-live="polite">{tip ? <><b>{tip.label}</b> · {tip.tip}</> : <span>Point at a bar for details</span>}</div>
    </div>
  )
}

type Group = 'model' | 'provider'

export function UsagePage() {
  const [d, setD] = useState<UsageDashboard | null>(null)
  const [err, setErr] = useState('')
  const [group, setGroup] = useState<Group>('model')

  useEffect(() => {
    const load = (): void => void api.usage.dashboard().then((x) => { setD(x); setErr('') }).catch((e) => setErr(clean(e)))
    load()
    return api.onBudgetChanged(load)
  }, [])

  const exportCsv = async (): Promise<void> => {
    try {
      const p = await api.usage.exportCsv()
      if (p) toast(`Saved ${p.split('/').pop()}`, 'ok')
    } catch (e) { toast(clean(e), 'error') }
  }

  const dayBars = useMemo<Bar[]>(() => (d?.days ?? []).map((x) => ({ key: x.day, label: shortDay(x.day), local: x.localTokens, cloud: x.cloudTokens, tip: `${tokens(x.tokens)} tokens · ${num(x.requests)} requests · ${money(x.usd)}` })), [d])
  const weekBars = useMemo<Bar[]>(() => (d?.weeks ?? []).map((x) => ({ key: x.start, label: `Week of ${shortDay(x.start)}`, local: x.localTokens, cloud: x.cloudTokens, tip: `${tokens(x.tokens)} tokens · ${num(x.requests)} requests · ${money(x.usd)}` })), [d])

  if (!d) return <><h3 className="set-h3">Spending</h3>{err ? <div className="us-err" role="alert">{err}</div> : <div className="us-empty">Loading…</div>}</>

  const life = d.lifetime
  const lifeTokens = life.input + life.cached + life.cacheWrite + life.output + life.local.input + life.local.output
  const rows = group === 'model' ? d.byModel.map((m) => ({ ...m, key: `${m.where}:${m.model}`, name: m.model, sub: m.where === 'local' ? 'Local' : providerName(m.provider), fast: m.fastRequests })) : d.byProvider.map((p) => ({ ...p, key: p.provider, sub: p.where === 'local' ? 'On this Mac' : 'Cloud', fast: 0 }))
  const empty = !life.requests && !life.local.requests

  return (
    <div className="us ud" data-testid="usage-page">
      <div className="us-title">
        <h3 className="set-h3">Spending</h3>
        <button className="btn us-csv" onClick={() => void exportCsv()} disabled={!life.requests} data-testid="usage-export"><I.Share size={14} /> Export CSV</button>
      </div>

      <section className="set-section">
        <div className="set-label">This month</div>
        <div className="set-card ud-month">
          <SpendBar spent={d.limit.spent} cap={d.limit.cap} mode={d.limit.mode} testId="usage-spend" />
          <div className="ud-note">{d.limit.mode === 'amount' ? 'Requests that could go past the monthly limit are refused before anything is sent.' : d.limit.mode === 'unlimited' ? 'No monthly limit is set.' : 'Pay-per-use API spending is off: only your ChatGPT plan and local models run.'} Change it in Models &amp; Keys.</div>
        </div>
      </section>

      <div className="ud-tiles" data-testid="usage-tiles">
        <div className="us-tile"><span>This week</span><b>{money(d.week.usd)}</b><em>{tokens(d.week.tokens)} tokens</em></div>
        <div className="us-tile"><span>This month</span><b>{money(d.monthTotals.usd)}</b><em>{num(d.monthTotals.requests)} {d.monthTotals.requests === 1 ? 'request' : 'requests'}</em></div>
        <div className="us-tile"><span>Lifetime spend</span><b>{money(life.usd)}</b><em>{life.since ? `since ${since(life.since)}` : 'nothing yet'}</em></div>
        <div className="us-tile"><span>Lifetime tokens</span><b>{tokens(lifeTokens)}</b><em>{num(life.requests + life.local.requests)} {life.requests + life.local.requests === 1 ? 'request' : 'requests'}</em></div>
      </div>

      {empty ? <div className="us-empty">No model requests yet.</div> : (
        <>
          <section className="set-section">
            <div className="us-label-row">
              <div className="set-label">Tokens per day · last 30 days</div>
              <div className="us-legend"><span><i className="us-sw cloud" />Cloud</span><span><i className="us-sw local" />Local</span></div>
            </div>
            <div className="set-card ud-card"><BarChart bars={dayBars} title="Tokens per day for the last 30 days" axis={[dayBars[0] ? dayBars[0].label : '', 'Today']} testId="usage-days" /></div>
          </section>

          <section className="set-section">
            <div className="set-label">Tokens per week · last 12 weeks</div>
            <div className="set-card ud-card"><BarChart bars={weekBars} title="Tokens per week for the last 12 weeks" axis={[weekBars[0] ? shortDay(d.weeks[0].start) : '', 'This week']} testId="usage-weeks" /></div>
          </section>

          <section className="set-section">
            <div className="us-label-row">
              <div className="set-label">This month by {group}</div>
              <div className="us-metric" role="radiogroup" aria-label="Group by">
                {(['model', 'provider'] as const).map((g) => <button key={g} role="radio" aria-checked={group === g} className={group === g ? 'on' : ''} onClick={() => setGroup(g)} data-testid={`usage-group-${g}`}>{g === 'model' ? 'Model' : 'Provider'}</button>)}
              </div>
            </div>
            <div className="set-card ud-table-card">
              {rows.length ? (
                <div className="ud-scroll">
                  <table className="ud-table" data-testid="usage-table">
                    <thead><tr><th className="l">{group === 'model' ? 'Model' : 'Provider'}</th><th>Requests</th><th>Input</th><th>Cached</th><th>Output</th><th>Reasoning</th><th>Cost</th><th>Share</th></tr></thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.key}>
                          <td className="l"><div className="ud-name" title={r.name}>{r.name}</div><div className="ud-sub">{r.sub}{r.fast ? ` · ${num(r.fast)} fast` : ''}</div></td>
                          <td>{num(r.requests)}</td>
                          <td>{tokens(r.input)}</td>
                          <td>{r.cached ? tokens(r.cached) : '—'}</td>
                          <td>{tokens(r.output)}</td>
                          <td>{r.reasoning ? tokens(r.reasoning) : '—'}</td>
                          <td>{r.where === 'local' ? 'Free' : money(r.usd)}</td>
                          <td><div className="ud-share"><i style={{ width: `${Math.min(100, r.share * 100)}%` }} /></div><span className="ud-sharev">{pct(r.share)}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <div className="us-empty">Nothing this month yet.</div>}
            </div>
            <div className="us-foot">Input counts uncached prompt tokens; cached tokens were read from the provider’s prompt cache at a fraction of the price. Output includes reasoning, which is billed as output. Share is of this month’s spend (of tokens when nothing was spent).</div>
          </section>

          <section className="set-section">
            <div className="set-label">This month by bot</div>
            <div className="set-card us-list" data-testid="usage-bots">
              {d.byBot.length ? d.byBot.map((b) => (
                <div key={b.spaceId ?? b.name} className="us-item">
                  <div className="us-item-top">
                    <span className="us-dot" style={{ background: b.color ?? 'var(--text-3)' }} aria-hidden="true" />
                    <span className="us-name">{b.name}</span>
                    <span className="us-val">{money(b.usd)}</span>
                  </div>
                  <div className="us-track"><i className="cloud" style={{ width: `${Math.min(100, b.share * 100)}%` }} /></div>
                  <div className="us-sub">{num(b.requests)} {b.requests === 1 ? 'request' : 'requests'} · {tokens(b.tokens)} tokens · {pct(b.share)}</div>
                </div>
              )) : <div className="us-empty">Nothing this month yet.</div>}
            </div>
            <div className="us-foot">Local requests are counted from model replies saved in your chats, with the token counts your model server reported. Lifetime totals keep every month; requests made before token detail was recorded show their input without the cached split.</div>
          </section>
        </>
      )}
    </div>
  )
}

const providerName = (id: string): string => ({ anthropic: 'Anthropic', openai: 'OpenAI', xai: 'xAI', openrouter: 'OpenRouter', chatgpt: 'ChatGPT plan' } as Record<string, string>)[id] ?? 'Cloud'

// ------------------------------------------------------------------ the compact card

/** Opens the compact usage card (profile menu "Usage", ⌘K "Usage"). */
export const openUsageGlance = (): void => { window.dispatchEvent(new CustomEvent('sahilbot:usage-glance')) }

/** The compact card: spend against the monthly limit, this week, lifetime and the last 7 days. Mounted once (main.tsx). */
export function UsageGlanceHost() {
  const [open, setOpen] = useState(false)
  const [g, setG] = useState<UsageGlance | null>(null)
  useEffect(() => {
    const show = (): void => { setOpen(true); void api.usage.glance().then(setG).catch(() => undefined) }
    window.addEventListener('sahilbot:usage-glance', show)
    return () => window.removeEventListener('sahilbot:usage-glance', show)
  }, [])
  useEffect(() => {
    if (!open) return
    const off = api.onBudgetChanged(() => void api.usage.glance().then(setG).catch(() => undefined))
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', esc)
    return () => { off(); window.removeEventListener('keydown', esc) }
  }, [open])
  if (!open) return null
  const max = Math.max(1, ...(g?.days ?? []))
  return (
    <div className="ug-scrim" onClick={() => setOpen(false)} data-testid="usage-glance">
      <div className="ug-card" role="dialog" aria-modal="true" aria-label="Usage" onClick={(e) => e.stopPropagation()}>
        <div className="ug-head"><b>Usage</b><button className="icon-btn" aria-label="Close" onClick={() => setOpen(false)}><I.Close size={14} /></button></div>
        {!g ? <div className="us-empty">Loading…</div> : (
          <>
            <SpendBar spent={g.spent} cap={g.cap} mode={g.mode} compact testId="usage-glance-spend" />
            <div className="ug-stats">
              <div><span>This week</span><b>{money(g.weekUsd)}</b></div>
              <div><span>Lifetime</span><b>{money(g.lifetimeUsd)}</b></div>
            </div>
            <div className="ug-spark" aria-label="Tokens per day, last 7 days">
              {g.days.map((v, i) => <i key={i} style={{ height: `${Math.max(3, (v / max) * 100)}%` }} title={`${tokens(v)} tokens`} />)}
            </div>
            <div className="ug-foot"><span>Last 7 days of tokens</span><button className="link-btn" onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('sahilbot:open-settings', { detail: 'usage' })) }} data-testid="usage-glance-more">Details</button></div>
          </>
        )}
      </div>
    </div>
  )
}
