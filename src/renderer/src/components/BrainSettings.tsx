import { useEffect, useState } from 'react'
import type { BrainApi, BrainStatus } from '@shared/brain'
import { api } from '../api'
import { toast } from '../lib/toast'
import { Toggle } from './Toggle'

// The brain's settings (Settings → Memory → Your brain, and the Brain page's Settings): Agent mode with its
// quiet hours and daily cap, drafting without asking (never sending), the daily brain budget, how often it
// refreshes, how far a first read goes back, the ChatGPT plan, and Pause. Each change saves at once.

const money = (n: number): string => (n <= 0 ? '$0.00' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)
const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1)
/** "claude-haiku-5-5" → "Claude Haiku 5.5", "gpt-6-luna" → "GPT-6 Luna"; anything else as it is. */
export function modelName(id?: string): string {
  const x = (id ?? '').replace(/^[\w-]+\/(?=claude|gpt)/, '')
  let m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(x)
  if (m) return `Claude ${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  m = /^gpt-([\d.]+)-([a-z]+)$/.exec(x)
  if (m) return `GPT-${m[1]} ${cap(m[2])}`
  if (/^chatgpt-plan\//.test(id ?? '')) return `ChatGPT plan (${(id ?? '').split('/').pop()})`
  return id ?? ''
}
const short = modelName

export function useBrainStatus(): [BrainStatus | null, () => void] {
  const [st, setSt] = useState<BrainStatus | null>(null)
  const load = (): void => { void api.brain?.status().then(setSt).catch(() => undefined) }
  useEffect(() => {
    load()
    const off = api.brain?.onChanged(load)
    return () => { off?.() }
  }, [])
  return [st, load]
}

export function BrainSettings({ status, onChange, compact }: { status?: BrainStatus | null; onChange?: (s: BrainStatus) => void; compact?: boolean }) {
  const [own, reload] = useBrainStatus()
  const st = status ?? own
  const [budget, setBudget] = useState('')
  useEffect(() => { if (st && budget === '') setBudget(st.settings.dailyUsd.toFixed(2)) }, [st, budget])
  if (!st) return null
  const s = st.settings
  const save = (patch: Parameters<BrainApi['setSettings']>[0], ok?: string): void => {
    void api.brain.setSettings(patch).then((x) => { onChange?.(x); reload(); if (ok) toast(ok, 'ok') }).catch((e: Error) => toast(e.message, 'error'))
  }
  const saveCap = (): void => {
    const n = Math.round(Number(budget.replace(/[^0-9.]/g, '')) * 100) / 100
    if (!Number.isFinite(n) || n < 0) { setBudget(s.dailyUsd.toFixed(2)); return }
    setBudget(n.toFixed(2))
    if (n !== s.dailyUsd) save({ dailyUsd: n })
  }
  return (
    <div className={`brain-settings${compact ? ' compact' : ''}`} data-testid="brain-settings">
      <section className="set-section">
        <div className="set-card">
          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-title">Agent mode: SahilBot reaches out</div>
              <div className="set-row-sub">After each refresh it looks for deadlines, requests and gaps and asks you first, with one-click actions. It proposes; it acts only when you click.</div>
            </div>
            <div className="set-row-ctl"><Toggle on={s.agentMode} onChange={(v) => save({ agentMode: v }, v ? 'Agent mode is on' : 'Agent mode is off')} label="Agent mode" testId="brain-agent-mode" /></div>
          </div>
          {s.agentMode && (
            <>
              <div className="set-row">
                <div className="set-row-text"><div className="set-row-title">Prompts a day</div><div className="set-row-sub">The most useful ones first; dismissed kinds come up less.</div></div>
                <div className="set-row-ctl">
                  <select className="set-select" value={s.maxPromptsPerDay} onChange={(e) => save({ maxPromptsPerDay: Number(e.target.value) })} aria-label="Prompts a day" data-testid="brain-max-prompts">
                    {[1, 2, 3, 5, 8, 10].concat([1, 2, 3, 5, 8, 10].includes(s.maxPromptsPerDay) ? [] : [s.maxPromptsPerDay]).sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              </div>
              <div className="set-row">
                <div className="set-row-text"><div className="set-row-title">Quiet hours</div><div className="set-row-sub">No prompts, notifications or phone pushes in between.</div></div>
                <div className="set-row-ctl brain-quiet">
                  <input type="time" className="set-input" value={s.quietHours.start} onChange={(e) => e.target.value && save({ quietHours: { start: e.target.value } })} aria-label="Quiet from" data-testid="brain-quiet-start" />
                  <span>to</span>
                  <input type="time" className="set-input" value={s.quietHours.end} onChange={(e) => e.target.value && save({ quietHours: { end: e.target.value } })} aria-label="Quiet until" data-testid="brain-quiet-end" />
                </div>
              </div>
              <div className="set-row">
                <div className="set-row-text">
                  <div className="set-row-title">Draft without asking</div>
                  <div className="set-row-sub">When someone asks you for something, SahilBot starts the draft and leaves it in Needs you for review. Sending always waits for you.</div>
                </div>
                <div className="set-row-ctl"><Toggle on={s.preApproved.draft} onChange={(v) => save({ preApproved: { draft: v } })} label="Draft without asking" testId="brain-predraft" /></div>
              </div>
            </>
          )}
        </div>
      </section>
      <section className="set-section">
        <div className="set-card">
          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-title">Daily brain budget</div>
              <div className="set-row-sub">Today {money(st.stats.todayUsd)}. It also counts toward your monthly limit; at the cap the brain waits for tomorrow.</div>
            </div>
            <div className="set-row-ctl brain-money">
              <span>$</span>
              <input className="set-input" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} onBlur={saveCap} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} aria-label="Daily brain budget in dollars" data-testid="brain-daily-budget" />
            </div>
          </div>
          <div className="set-row">
            <div className="set-row-text"><div className="set-row-title">Refresh while you’re active</div><div className="set-row-sub">Hourly when you’re away; paused on a low battery or in Low Power Mode. Only while SahilBot is open.</div></div>
            <div className="set-row-ctl">
              <select className="set-select" value={s.activeMinutes} onChange={(e) => save({ activeMinutes: Number(e.target.value) })} aria-label="Refresh every" data-testid="brain-cadence">
                {[15, 30, 60, 120].concat([15, 30, 60, 120].includes(s.activeMinutes) ? [] : [s.activeMinutes]).sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n < 60 ? `Every ${n} minutes` : n === 60 ? 'Every hour' : `Every ${n / 60} hours`}</option>)}
              </select>
            </div>
          </div>
          {!compact && (
            <div className="set-row">
              <div className="set-row-text"><div className="set-row-title">First read goes back</div><div className="set-row-sub">When a source is new you see the estimate and say OK first.</div></div>
              <div className="set-row-ctl">
                <select className="set-select" value={s.backfillDays} onChange={(e) => save({ backfillDays: Number(e.target.value) })} aria-label="First read goes back" data-testid="brain-backfill-days">
                  {[7, 14, 30, 60, 90].concat([7, 14, 30, 60, 90].includes(s.backfillDays) ? [] : [s.backfillDays]).sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n} days</option>)}
                </select>
              </div>
            </div>
          )}
          <div className="set-row">
            <div className="set-row-text"><div className="set-row-title">Use my ChatGPT plan for the brain</div><div className="set-row-sub">Off keeps the plan’s limits for your own chats.</div></div>
            <div className="set-row-ctl"><Toggle on={s.usePlan} onChange={(v) => save({ usePlan: v })} label="Use my ChatGPT plan for the brain" testId="brain-use-plan" /></div>
          </div>
          <div className="set-row">
            <div className="set-row-text">
              <div className="set-row-title">Pause the brain</div>
              <div className="set-row-sub">{st.routing.extract ? `Reads on ${short(st.routing.extract)}${st.routing.brief ? `, writes briefs on ${short(st.routing.brief)}` : ''}. Never the premium models.` : st.routing.blocked ?? 'No model is available yet.'}</div>
            </div>
            <div className="set-row-ctl"><Toggle on={s.paused} onChange={(v) => save({ paused: v }, v ? 'The brain is paused' : 'The brain is on')} label="Pause the brain" testId="brain-pause" /></div>
          </div>
        </div>
      </section>
    </div>
  )
}
