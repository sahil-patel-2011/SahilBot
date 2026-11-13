import { useEffect, useMemo, useState } from 'react'
import type { UsageReport } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'

// Settings → Usage: this month's cloud spend against the cap, and the last 30 days by day, model and bot.
// Cloud = paid requests (priced when they're made). Local = replies from models on this Mac.

type Metric = 'spend' | 'requests'

const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const usd = (n: number): string => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)
const num = (n: number): string => n.toLocaleString()
const tokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))
const shortDay = (day: string): string => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export function UsagePage() {
  const [r, setR] = useState<UsageReport | null>(null)
  const [err, setErr] = useState('')
  const [metric, setMetric] = useState<Metric>('requests')
  const [tip, setTip] = useState<number | null>(null)

  useEffect(() => {
    let first = true
    const load = (): void => void api.usage.report().then((x) => {
      setR(x); setErr('')
      // Opens on spend when there is any; otherwise on requests.
      if (first) { first = false; setMetric(x.totals.usd > 0 ? 'spend' : 'requests') }
    }).catch((e) => setErr(clean(e)))
    load()
    return api.onBudgetChanged(load)
  }, [])

  const exportCsv = async (): Promise<void> => {
    try {
      const p = await api.usage.exportCsv()
      if (p) toast(`Saved ${p.split('/').pop()}`, 'ok')
    } catch (e) { toast(clean(e), 'error') }
  }

  const dayMax = useMemo(() => Math.max(1e-9, ...(r?.byDay ?? []).map((d) => (metric === 'spend' ? d.usd : d.cloudRequests + d.localRequests))), [r, metric])

  if (!r) return <><h2>Usage</h2>{err ? <div className="us-err" role="alert">{err}</div> : <div className="us-empty">Loading…</div>}</>

  const pct = r.cap > 0 ? Math.min(100, (r.spent / r.cap) * 100) : r.spent > 0 ? 100 : 0
  const level = pct >= 90 ? ' high' : pct >= 70 ? ' mid' : ''
  const modelMax = Math.max(1e-9, ...r.byModel.map((m) => (metric === 'spend' ? m.usd : m.requests)))
  const botMax = Math.max(1e-9, ...r.byBot.map((b) => (metric === 'spend' ? b.usd : b.cloudRequests + b.localRequests)))
  const empty = !r.totals.cloudRequests && !r.totals.localRequests
  const tipDay = tip !== null ? r.byDay[tip] : null

  return (
    <div className="us" data-testid="usage-page">
      <div className="us-title">
        <h2>Usage</h2>
        <button className="btn us-csv" onClick={() => void exportCsv()} disabled={empty} data-testid="usage-export"><I.Share size={14} /> Export CSV</button>
      </div>

      <section className="set-section">
        <div className="set-label">Cloud spend this month</div>
        <div className="set-card us-cap">
          <div className="us-cap-line">
            <span className="us-big">{usd(r.spent)}</span>
            <span className="us-of">of {usd(r.cap)} cap · {num(r.monthRequests)} cloud request{r.monthRequests === 1 ? '' : 's'}</span>
          </div>
          <div className={`us-meter${level}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Share of the monthly cap used"><i style={{ width: `${pct}%` }} /></div>
          <div className="us-note">{r.cap > 0 ? `${Math.round(pct)}% used. Requests that could go past the cap are refused before anything is sent.` : 'The cap is $0: cloud requests are refused. Change it in General.'}</div>
        </div>
      </section>

      <section className="set-section">
        <div className="set-label">Last {r.days} days</div>
        <div className="us-tiles">
          <div className="us-tile"><span>Cloud requests</span><b>{num(r.totals.cloudRequests)}</b></div>
          <div className="us-tile"><span>Local requests</span><b>{num(r.totals.localRequests)}</b></div>
          <div className="us-tile"><span>Tokens in</span><b>{tokens(r.totals.input)}</b></div>
          <div className="us-tile"><span>Tokens out</span><b>{tokens(r.totals.output)}</b></div>
          <div className="us-tile"><span>Cloud spend</span><b>{usd(r.totals.usd)}</b></div>
        </div>
      </section>

      {empty ? <div className="us-empty">No model requests in the last {r.days} days yet.</div> : (
        <>
          <div className="us-metric" role="radiogroup" aria-label="Show">
            {(['requests', 'spend'] as const).map((m) => (
              <button key={m} role="radio" aria-checked={metric === m} className={metric === m ? 'on' : ''} onClick={() => setMetric(m)} data-testid={`usage-metric-${m}`}>{m === 'spend' ? 'Cloud spend' : 'Requests'}</button>
            ))}
          </div>

          <section className="set-section">
            <div className="us-label-row">
              <div className="set-label">By day</div>
              {metric === 'requests' && <div className="us-legend"><span><i className="us-sw local" />Local</span><span><i className="us-sw cloud" />Cloud</span></div>}
            </div>
            <div className="set-card us-days" onMouseLeave={() => setTip(null)}>
              <div className="us-bars" role="img" aria-label={`${metric === 'spend' ? 'Cloud spend' : 'Requests'} per day for the last ${r.days} days`}>
                {r.byDay.map((d, i) => {
                  const local = metric === 'spend' ? 0 : d.localRequests
                  const cloud = metric === 'spend' ? d.usd : d.cloudRequests
                  return (
                    <div key={d.day} className={`us-col${tip === i ? ' hot' : ''}`} onMouseEnter={() => setTip(i)} onFocus={() => setTip(i)} tabIndex={0}
                      aria-label={`${shortDay(d.day)}: ${d.localRequests} local, ${d.cloudRequests} cloud, ${usd(d.usd)}`}>
                      <div className="us-stack">
                        {cloud > 0 && <i className="cloud" style={{ height: `${(cloud / dayMax) * 100}%` }} />}
                        {local > 0 && <i className="local" style={{ height: `${(local / dayMax) * 100}%` }} />}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="us-axis"><span>{shortDay(r.byDay[0].day)}</span><span>Today</span></div>
              <div className="us-tip" aria-live="polite">
                {tipDay ? <><b>{shortDay(tipDay.day)}</b> · {num(tipDay.localRequests)} local · {num(tipDay.cloudRequests)} cloud · {usd(tipDay.usd)}</> : <span>Point at a day for details</span>}
              </div>
            </div>
          </section>

          <section className="set-section">
            <div className="set-label">By model</div>
            <div className="set-card us-list">
              {r.byModel.map((m) => {
                const v = metric === 'spend' ? m.usd : m.requests
                return (
                  <div key={`${m.where}:${m.model}`} className="us-item" title={`${m.model}: ${num(m.requests)} requests · ${tokens(m.input)} in · ${tokens(m.output)} out${m.where === 'cloud' ? ` · ${usd(m.usd)}` : ''}`}>
                    <div className="us-item-top">
                      <span className="us-name">{m.model}</span>
                      <span className={`us-tag ${m.where}`}>{m.where === 'local' ? 'Local' : 'Cloud'}</span>
                      <span className="us-val">{metric === 'spend' ? (m.where === 'local' ? 'Free' : usd(m.usd)) : `${num(m.requests)} req`}</span>
                    </div>
                    <div className="us-track"><i className={m.where} style={{ width: `${(v / modelMax) * 100}%` }} /></div>
                    <div className="us-sub">{tokens(m.input)} in · {tokens(m.output)} out{metric === 'spend' ? ` · ${num(m.requests)} req` : m.where === 'cloud' ? ` · ${usd(m.usd)}` : ''}</div>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="set-section">
            <div className="set-label">By bot</div>
            <div className="set-card us-list">
              {r.byBot.map((b) => {
                const req = b.cloudRequests + b.localRequests
                return (
                  <div key={b.spaceId ?? b.name} className="us-item">
                    <div className="us-item-top">
                      <span className="us-dot" style={{ background: b.color ?? 'var(--text-3)' }} aria-hidden="true" />
                      <span className="us-name">{b.name}</span>
                      <span className="us-val">{metric === 'spend' ? usd(b.usd) : `${num(req)} req`}</span>
                    </div>
                    {metric === 'spend' ? (
                      <div className="us-track"><i className="cloud" style={{ width: `${(b.usd / botMax) * 100}%` }} /></div>
                    ) : (
                      <div className="us-track split">
                        {b.localRequests > 0 && <i className="local" style={{ width: `${(b.localRequests / botMax) * 100}%` }} />}
                        {b.cloudRequests > 0 && <i className="cloud" style={{ width: `${(b.cloudRequests / botMax) * 100}%` }} />}
                      </div>
                    )}
                    <div className="us-sub">{num(b.localRequests)} local · {num(b.cloudRequests)} cloud · {tokens(b.input)} in · {tokens(b.output)} out{metric === 'requests' ? ` · ${usd(b.usd)}` : ''}</div>
                  </div>
                )
              })}
            </div>
            <div className="us-foot">Local requests are counted from model replies saved in your chats, with the token counts your model server reported. Cloud requests made before this update aren’t tied to a bot.</div>
          </section>
        </>
      )}
    </div>
  )
}
