import { useEffect, useState } from 'react'
import type { Settings, SpendingMode } from '@shared/types'
import { api } from '../api'

// The monthly spending limit (Settings → General) and the "$X used of $Y this month" bar, shared by the
// Usage page and the profile menu. Three modes: a specific amount, Unlimited (no cap, spend still shown),
// None (pay-per-use API spending off: only the ChatGPT plan via Codex and local models run). Monthly only.

type Patch = (p: Partial<Settings>) => Promise<Settings>

/** The saved mode, or the one an older cloudBudgetUsd implies (> 0: amount, 0: None) (llm/budget.ts spendingMode). */
export function modeOf(s: Pick<Settings, 'cloudBudgetUsd' | 'spendingMode'>): SpendingMode {
  const m = s.spendingMode
  return m === 'amount' || m === 'unlimited' || m === 'none' ? m : typeof s.cloudBudgetUsd === 'number' && s.cloudBudgetUsd <= 0 ? 'none' : 'amount'
}

export const money = (n: number): string => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)

/** "$X used of $Y this month" with a simple progress bar (Unlimited: no cap; None: API spending off). */
export function SpendBar({ spent, cap, mode, compact, testId }: { spent: number; cap: number; mode: SpendingMode; compact?: boolean; testId?: string }) {
  const pct = mode === 'amount' ? (cap > 0 ? Math.min(100, (spent / cap) * 100) : 100) : 0
  const level = pct >= 90 ? ' high' : pct >= 70 ? ' mid' : ''
  const line = mode === 'amount' ? <><b>{money(spent)}</b> used of {money(cap)} this month</>
    : mode === 'unlimited' ? <><b>{money(spent)}</b> used this month · no limit</>
    : <><b>{money(spent)}</b> used this month · API spending off</>
  return (
    <div className={`spend${compact ? ' compact' : ''}`} data-testid={testId}>
      <div className="spend-line">{line}{mode === 'amount' && !compact && <span className="spend-pct">{Math.round(pct)}%</span>}</div>
      <div className={`spend-meter${level}${mode !== 'amount' ? ' open' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={mode === 'amount' ? 'Share of the monthly limit used' : 'Monthly spend'}>
        <i style={{ width: mode === 'amount' ? `${pct}%` : mode === 'unlimited' && spent > 0 ? '100%' : '0%' }} />
      </div>
    </div>
  )
}

/** This month's spend, live (refreshes whenever a paid request is recorded). */
export function useSpend(): { spent: number; cap: number; requests: number; mode: SpendingMode } | null {
  const [b, setB] = useState<{ spent: number; cap: number; requests: number; mode: SpendingMode } | null>(null)
  useEffect(() => {
    const load = (): void => void api.budget().then((x) => setB({ spent: x.spent, cap: x.cap, requests: x.requests, mode: x.mode ?? 'amount' })).catch(() => undefined)
    load()
    return api.onBudgetChanged(load)
  }, [])
  return b
}

const MODES: Array<{ id: SpendingMode; label: string; sub: string }> = [
  { id: 'amount', label: 'Monthly limit', sub: 'A request that could pass this month’s limit is refused before it’s sent.' },
  { id: 'unlimited', label: 'No limit', sub: 'Spend is still tracked and shown.' },
  { id: 'none', label: 'Don\'t spend', sub: 'Only your ChatGPT plan and local models run: nothing pay-per-use.' }
]

/** Settings → Models & Keys → Monthly spending limit. */
export function SpendingLimitSection({ s, patch }: { s: Settings; patch: Patch }) {
  const b = useSpend()
  const mode = modeOf(s)
  const [amount, setAmount] = useState(String(s.cloudBudgetUsd || 200))
  useEffect(() => setAmount(String(s.cloudBudgetUsd || 200)), [s.cloudBudgetUsd])
  const save = (v: string): void => {
    const n = Math.max(0, Math.round((Number(v) || 0) * 100) / 100)
    // $0 as an amount means nothing may be spent: that is the None mode.
    void patch(n > 0 ? { cloudBudgetUsd: n, spendingMode: 'amount' } : { spendingMode: 'none' })
  }
  return (
    <section className="set-section" data-testid="spending-limit">
      <div className="set-label">Monthly spending limit</div>
      <div className="set-card spend-card">
        {b && <SpendBar spent={b.spent} cap={s.cloudBudgetUsd} mode={mode} testId="spend-settings" />}
        <div className="spend-modes" role="radiogroup" aria-label="Monthly spending limit">
          {MODES.map((m) => (
            <button key={m.id} role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => void patch(m.id === 'amount' ? { spendingMode: 'amount', cloudBudgetUsd: Number(amount) > 0 ? Number(amount) : 200 } : { spendingMode: m.id })} data-testid={`spend-mode-${m.id}`}>{m.label}</button>
          ))}
        </div>
        {mode === 'amount' && (
          <div className="spend-amount">
            <span>Up to</span>
            <span className="spend-input"><span className="hint">$</span>
              <input className="set-input" type="number" min={0} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={(e) => save(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save((e.target as HTMLInputElement).value) }} data-testid="budget-cap" />
            </span>
            <span>per month</span>
          </div>
        )}
        <div className="spend-sub">{MODES.find((m) => m.id === mode)!.sub}</div>
      </div>
    </section>
  )
}

/** Settings → AI (outside Developer mode): the limit as one row, and this month's spend in one line. */
export function SpendingLimitRow({ s, patch }: { s: Settings; patch: Patch }) {
  const b = useSpend()
  const mode = modeOf(s)
  const [amount, setAmount] = useState(String(s.cloudBudgetUsd || 200))
  useEffect(() => setAmount(String(s.cloudBudgetUsd || 200)), [s.cloudBudgetUsd])
  const save = (v: string): void => {
    const n = Math.max(0, Math.round((Number(v) || 0) * 100) / 100)
    void patch(n > 0 ? { cloudBudgetUsd: n, spendingMode: 'amount' } : { spendingMode: 'none' })
  }
  const spent = b ? money(b.spent) : '…'
  const line = mode === 'amount' ? `${spent} of ${money(s.cloudBudgetUsd)} used this month` : mode === 'unlimited' ? `${spent} used this month` : `${spent} used this month · nothing pay-per-use runs`
  return (
    <div className="set-row" data-testid="spending-limit">
      <div className="set-row-text">
        <div className="set-row-title">Monthly spending limit</div>
        <div className="set-row-sub" data-testid="spend-settings">{line}</div>
      </div>
      <div className="set-row-ctl">
        {mode === 'amount' && (
          <span className="spend-input"><span className="hint">$</span>
            <input className="set-input" type="number" min={0} step={1} value={amount} aria-label="Monthly limit in dollars" style={{ width: 80 }} onChange={(e) => setAmount(e.target.value)} onBlur={(e) => save(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') save((e.target as HTMLInputElement).value) }} data-testid="budget-cap" />
          </span>
        )}
        <select className="set-select" value={mode} aria-label="Monthly spending limit" data-testid="spend-mode"
          onChange={(e) => { const m = e.target.value as SpendingMode; void patch(m === 'amount' ? { spendingMode: 'amount', cloudBudgetUsd: Number(amount) > 0 ? Number(amount) : 200 } : { spendingMode: m }) }}>
          <option value="amount">Limit</option>
          <option value="unlimited">No limit</option>
          <option value="none">Don't spend</option>
        </select>
      </div>
    </div>
  )
}
