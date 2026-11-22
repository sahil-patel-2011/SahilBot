import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Goal, GoalPatch, Space } from '@shared/types'
import { api } from '../api'
import { SpaceAvatar } from '../brand'
import * as I from '../icons'
import { toast } from '../lib/toast'
import { when } from '../routines'
import { NeedsYouInbox } from './NeedsYou'

// The Tasks board: every bot's long-running goals, grouped Active / Needs you / Scheduled / Done, with
// progress, the next check-in, spend against the cap and the latest journal line. Pause, resume, open
// the chat, continue now, change the budget, or abandon. Spec: design/bot-ui.md (tokens, cards 16px).

export const Target = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="0.9" fill="currentColor" />
  </svg>
)

export type GoalColumn = 'active' | 'needs' | 'scheduled' | 'done'

/** Which column a goal sits in. "Needs you" wins over everything that isn't finished. */
export function goalColumn(g: Goal, now = Date.now()): GoalColumn {
  if (g.status === 'done' || g.status === 'abandoned') return 'done'
  if (g.status === 'waiting_user' || g.status === 'blocked' || g.asks.length) return 'needs'
  if (g.status === 'paused') return 'scheduled'
  if (g.running || !g.nextWakeAt || g.nextWakeAt <= now) return 'active'
  return 'scheduled'
}

const COLUMNS: Array<{ key: GoalColumn; label: string; empty: string }> = [
  { key: 'active', label: 'Active', empty: 'Nothing working right now.' },
  { key: 'needs', label: 'Needs you', empty: 'Nothing waiting on you.' },
  { key: 'scheduled', label: 'Waiting · scheduled', empty: 'No check-ins coming up.' },
  { key: 'done', label: 'Done', empty: 'Finished goals show up here.' }
]

const money = (n: number): string => `$${(Math.round(n * 100) / 100).toFixed(2)}`
const done = (g: Goal): number => g.milestones.filter((m) => m.status === 'done' || m.status === 'skipped').length

function ago(t: number, now = Date.now()): string {
  const m = Math.round((now - t) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return d < 30 ? `${d}d ago` : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** The state line under a card's title. */
export function goalStateLine(g: Goal, now = Date.now()): string {
  if (g.running) return 'Working on it now…'
  switch (g.status) {
    case 'done': return 'Done'
    case 'abandoned': return 'Abandoned'
    case 'paused': return g.statusReason ? `Paused · ${g.statusReason}` : 'Paused'
    case 'blocked': return 'Blocked'
    case 'waiting_user': return g.asks.length ? `${g.asks.length} action${g.asks.length === 1 ? '' : 's'} waiting for your OK` : 'Waiting for you'
    default: return g.nextWakeAt ? (g.nextWakeAt <= now ? 'Checking in shortly' : `Next check-in ${when(g.nextWakeAt, now).replace(/^Today at /, 'today at ').replace(/^Tomorrow at /, 'tomorrow at ')}`) : 'No check-in scheduled'
  }
}

/** Live list of every goal (refreshes on goals:changed and once a minute for "next check-in" times). */
export function useGoals(): { goals: Goal[] | null; reload: () => void } {
  const [goals, setGoals] = useState<Goal[] | null>(null)
  const reload = useCallback(() => { void api.goals.list().then(setGoals).catch(() => setGoals([])) }, [])
  useEffect(() => {
    reload()
    const off = api.goals.onChange(reload)
    const t = setInterval(reload, 60_000)
    return () => { off(); clearInterval(t) }
  }, [reload])
  return { goals, reload }
}

const run = async (fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
  try { await fn(); if (ok) toast(ok, 'ok'); return true } catch (e) { toast((e as Error).message, 'error'); return false }
}

export function TasksView(p: { spaces: Space[]; onOpenChat: (threadId: string, botId: string) => void }) {
  const { goals, reload } = useGoals()
  const [paused, setPaused] = useState(false)
  const [bot, setBot] = useState<string | null>(null)
  useEffect(() => { void api.settings.get().then((s) => setPaused(!!s.routinesPaused)) }, [goals])

  const byId = useMemo(() => new Map(p.spaces.map((s) => [s.id, s])), [p.spaces])
  const bots = useMemo(() => [...new Set((goals ?? []).map((g) => g.botId))].map((id) => byId.get(id)).filter((s): s is Space => !!s), [goals, byId])
  const shown = (goals ?? []).filter((g) => !bot || g.botId === bot)
  const now = Date.now()
  const cols = COLUMNS.map((c) => ({ ...c, items: shown.filter((g) => goalColumn(g, now) === c.key).sort((a, b) => c.key === 'scheduled' ? (a.nextWakeAt ?? 9e15) - (b.nextWakeAt ?? 9e15) : b.updatedAt - a.updatedAt) }))

  return (
    <div className="page tk-page" data-testid="tasks-view">
      <div className="page-head">
        <h1>Needs you</h1>
        {bots.length > 1 && (
          <div className="tk-filter" role="tablist" aria-label="Bot">
            <button role="tab" aria-selected={!bot} className={!bot ? 'on' : ''} onClick={() => setBot(null)}>All bots</button>
            {bots.map((b) => (
              <button key={b.id} role="tab" aria-selected={bot === b.id} className={bot === b.id ? 'on' : ''} onClick={() => setBot(b.id)}>
                <SpaceAvatar color={b.color} shape={b.shape} size={16} />{b.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="set-sub">Goals your bots pursue over hours or days. They check in on their own, stay inside each goal’s budget, and leave anything risky for you.</div>
      <NeedsYouInbox spaces={p.spaces} onOpenChat={(threadId, botId) => p.onOpenChat(threadId, botId)} />
      {paused && (
        <div className="tk-banner" role="status">
          <I.Clock size={15} /><span>All routines are paused, so goals won’t check in until you resume them.</span>
          <button className="bd-btn" onClick={() => void run(() => api.alwaysOn.pauseRoutines(false)).then(() => reload())}>Resume routines</button>
        </div>
      )}
      {goals === null ? <div className="hint">Loading…</div> : goals.length === 0 ? (
        <div className="empty-state tk-empty">
          <span className="tk-empty-icon"><Target size={24} /></span>
          <b>No goals yet</b>
          <div>Ask a bot for something that takes days, like “get my scouting database ready before Saturday” or “track these 5 stocks and summarize weekly”. It proposes a goal and a budget for you to OK.</div>
        </div>
      ) : (
        <div className="tk-board">
          {cols.map((c) => (
            <section key={c.key} className={`tk-col ${c.key}`} aria-label={c.label} data-testid={`tasks-col-${c.key}`}>
              <header className="tk-col-head"><i aria-hidden="true" /><span>{c.label}</span><b>{c.items.length}</b></header>
              {c.items.length === 0 ? <div className="tk-col-empty">{c.empty}</div> : c.items.map((g) => (
                <GoalCard key={g.id} goal={g} bot={byId.get(g.botId)} column={c.key} onOpen={() => g.threadId && p.onOpenChat(g.threadId, g.botId)} reload={reload} />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function GoalCard({ goal: g, bot, column, onOpen, reload }: { goal: Goal; bot?: Space; column: GoalColumn; onOpen: () => void; reload: () => void }) {
  // A goal stopped by its spend cap opens on its budget, which is what needs changing.
  const [open, setOpen] = useState(g.status === 'blocked')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const finished = g.status === 'done' || g.status === 'abandoned'
  const n = done(g)
  const pct = g.milestones.length ? Math.round((n / g.milestones.length) * 100) : 0
  const spendPct = g.maxUsd > 0 ? Math.min(100, Math.round((g.spentUsd / g.maxUsd) * 100)) : g.spentUsd > 0 ? 100 : 0
  const last = [...g.journal].reverse().find((e) => e.kind === 'note' || e.kind === 'milestone') ?? [...g.journal].reverse().find((e) => e.kind !== 'status')
  const canResume = g.status === 'paused' || g.status === 'waiting_user' || g.status === 'blocked'

  const patch = (x: GoalPatch, ok?: string): Promise<void> => {
    setBusy(true)
    return run(() => api.goals.update(g.id, x), ok).then(() => { setBusy(false); reload() })
  }
  const continueNow = (): void => {
    setBusy(true)
    void run(() => api.goals.runNow(g.id)).then((ok) => { setBusy(false); reload(); if (ok) onOpen() })
  }

  return (
    <article className={`tk-card${finished ? ' finished' : ''}`} data-testid="goal-card" data-status={g.status} style={{ '--bot': bot?.color ?? 'var(--accent)' } as React.CSSProperties}>
      <div className="tk-card-top">
        {bot ? <SpaceAvatar color={bot.color} shape={bot.shape} size={26} /> : <span className="tk-noavatar" />}
        <span className="tk-bot">{bot?.name ?? 'Deleted bot'}</span>
        {g.running && <span className="tk-live" title="Working now"><span className="row-spin" />Working</span>}
        {!g.running && column === 'needs' && <span className="tk-chip needs">{g.status === 'blocked' ? 'Blocked' : 'Needs you'}</span>}
        {!g.running && g.status === 'paused' && <span className="tk-chip">Paused</span>}
        {g.status === 'done' && <span className="tk-chip ok"><I.Check size={12} />Done</span>}
      </div>

      <button className="tk-title" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? 'Hide details' : 'Show milestones and journal'}>
        <h3>{g.title}</h3>
        <span className={`tk-chev${open ? ' up' : ''}`}><I.Chevron size={14} /></span>
      </button>

      <div className="tk-progress" aria-label={`${n} of ${g.milestones.length} milestones done`}>
        <div className="tk-bar"><i style={{ width: `${pct}%` }} /></div>
        <span>{n}/{g.milestones.length}</span>
      </div>

      <div className="tk-facts">
        <span className="tk-fact"><I.Clock size={13} />{goalStateLine(g)}</span>
        <span className={`tk-fact spend${spendPct >= 90 ? ' hot' : ''}`} title="Cloud model spend for this goal (local models are free)">
          <span className="tk-meter"><i style={{ width: `${spendPct}%` }} /></span>{money(g.spentUsd)} <em>of {money(g.maxUsd)}</em>
        </span>
      </div>

      {column === 'needs' && g.statusReason && <p className="tk-reason">{g.statusReason}</p>}
      {column === 'needs' && g.asks.length > 0 && !g.statusReason && <p className="tk-reason">{g.asks.map((a) => a.summary).join(' · ')}</p>}
      {last && <p className="tk-last" title={last.text}><span>{last.text}</span><em>{ago(last.at)}</em></p>}

      {open && <GoalDetails goal={g} busy={busy} onSave={(x) => void patch(x, 'Saved')} />}

      <div className="tk-actions">
        {column === 'needs' && !finished && (
          <button className="bd-btn primary" disabled={busy || g.running} onClick={continueNow} title="Work on it now, with you there to approve what's waiting">Continue now</button>
        )}
        {!finished && (canResume
          ? <button className="bd-btn" disabled={busy} onClick={() => void patch({ status: 'active' })} data-testid="goal-pause">Resume</button>
          : <button className="bd-btn" disabled={busy} onClick={() => void patch({ status: 'paused' })} data-testid="goal-pause">Pause</button>)}
        <button className="bd-btn" disabled={!g.threadId} onClick={onOpen} data-testid="goal-open">Open chat</button>
        {!finished && <button className="bd-icon tk-abandon" aria-label="Abandon goal" title="Abandon goal" onClick={() => setConfirm(true)} data-testid="goal-abandon"><I.Trash size={14} /></button>}
      </div>
      {confirm && (
        <div className="rt-confirm block tk-confirm" role="alertdialog" aria-label="Abandon goal">
          <span>Abandon “{g.title}”? It stops for good; the chat and journal stay.</span>
          <button className="bd-btn" onClick={() => setConfirm(false)}>Cancel</button>
          <button className="bd-btn danger" onClick={() => { setConfirm(false); void patch({ status: 'abandoned' }) }} data-testid="goal-abandon-confirm">Abandon</button>
        </div>
      )}
    </article>
  )
}

const MARK: Record<string, ReactNode> = {
  done: <I.Check size={12} />, skipped: <span>–</span>, in_progress: <span className="tk-dot-live" />, pending: null
}

function toDateInput(t: number | null): string {
  if (!t) return ''
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function GoalDetails({ goal: g, busy, onSave }: { goal: Goal; busy: boolean; onSave: (p: GoalPatch) => void }) {
  const [cap, setCap] = useState(String(g.maxUsd))
  const [runs, setRuns] = useState(String(g.maxRunsPerDay))
  const [end, setEnd] = useState(toDateInput(g.endAt))
  useEffect(() => { setCap(String(g.maxUsd)); setRuns(String(g.maxRunsPerDay)); setEnd(toDateInput(g.endAt)) }, [g.maxUsd, g.maxRunsPerDay, g.endAt])
  const finished = g.status === 'done' || g.status === 'abandoned'
  const endAt = end ? new Date(`${end}T23:59:00`).getTime() : null
  const changed = Number(cap) !== g.maxUsd || Number(runs) !== g.maxRunsPerDay || (endAt ?? null) !== (g.endAt ? new Date(`${toDateInput(g.endAt)}T23:59:00`).getTime() : null)
  const save = (): void => {
    const x: GoalPatch = {}
    if (Number(cap) !== g.maxUsd) x.maxUsd = Number(cap)
    if (Number(runs) !== g.maxRunsPerDay) x.maxRunsPerDay = Number(runs)
    if (end !== toDateInput(g.endAt)) x.endAt = endAt
    onSave(x)
  }
  return (
    <div className="tk-details">
      <div className="tk-done-when"><label>Done when</label><p>{g.doneWhen}</p></div>
      <ol className="tk-milestones">
        {g.milestones.map((m) => (
          <li key={m.id} className={m.status}><span className="tk-mark" aria-hidden="true">{MARK[m.status]}</span><span>{m.title}</span></li>
        ))}
      </ol>
      {g.journal.length > 0 && (
        <>
          <label className="tk-label">Journal</label>
          <ul className="tk-journal">
            {g.journal.slice(-6).reverse().map((e, i) => (
              <li key={`${e.at}-${i}`} className={e.kind ?? 'note'}><em>{when(e.at).replace(/^Today at /, '')}</em><span>{e.text}</span></li>
            ))}
          </ul>
        </>
      )}
      {!finished && (
        <div className="tk-budget">
          <label>Spend cap<span className="tk-input"><i>$</i><input type="number" min={0} max={50} step={0.5} value={cap} onChange={(e) => setCap(e.target.value)} aria-label="Spend cap in dollars" /></span></label>
          <label>Check-ins a day<input type="number" min={1} max={24} step={1} value={runs} onChange={(e) => setRuns(e.target.value)} aria-label="Check-ins a day" /></label>
          <label>Ends<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="End date" /></label>
          <button className="bd-btn" disabled={busy || !changed} onClick={save}>Save</button>
        </div>
      )}
      <div className="tk-meta">{g.wakes} check-in{g.wakes === 1 ? '' : 's'}{g.lastWakeAt ? ` · last ${ago(g.lastWakeAt)}` : ''} · started {new Date(g.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</div>
    </div>
  )
}

/** Bot details → Goals: this bot's goals with progress and a pause switch. */
export function BotGoals({ spaceId }: { spaceId: string }) {
  const { goals, reload } = useGoals()
  const [openId, setOpenId] = useState<string | null>(null)
  const mine = (goals ?? []).filter((g) => g.botId === spaceId && g.status !== 'abandoned')
  const toggle = (g: Goal, on: boolean): void => { void run(() => api.goals.update(g.id, { status: on ? 'active' : 'paused' })).then(reload) }
  return (
    <>
      <div className="bd-section-title">Goals</div>
      <div className="bd-card" data-testid="bot-goals">
        {goals !== null && mine.length === 0 && <div className="bd-empty">Ask in chat for something that takes days to start a goal.</div>}
        {mine.map((g) => {
          const finished = g.status === 'done'
          const on = !finished && g.status !== 'paused' && g.status !== 'waiting_user' && g.status !== 'blocked'
          return (
            <div key={g.id} className={`rt-row tk-bd-row${on || finished ? '' : ' paused'}`} data-testid="bot-goal-row">
              <button className="rt-main" onClick={() => setOpenId(openId === g.id ? null : g.id)} title={g.title} aria-expanded={openId === g.id}>
                <span className="rt-icon"><Target size={16} /></span>
                <span className="rt-text">
                  <b>{g.title}</b>
                  <span>{done(g)}/{g.milestones.length} · {goalStateLine(g)}</span>
                </span>
              </button>
              {!finished && (
                <button type="button" role="switch" aria-checked={on} aria-label={on ? 'Pause goal' : 'Resume goal'} title={on ? 'Pause goal' : 'Resume goal'}
                  className={`rt-switch${on ? ' on' : ''}`} onClick={() => toggle(g, !on)} data-testid="bot-goal-toggle"><i /></button>
              )}
              {openId === g.id && (
                <ol className="tk-milestones compact">
                  {g.milestones.map((m) => <li key={m.id} className={m.status}><span className="tk-mark" aria-hidden="true">{MARK[m.status]}</span><span>{m.title}</span></li>)}
                  <li className="tk-bd-spend">{money(g.spentUsd)} of {money(g.maxUsd)} spent</li>
                </ol>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

/** Goals waiting on the user (for the sidebar's Tasks button dot). */
export function useGoalsNeedingYou(): number {
  const [n, setN] = useState(0)
  // Bots' questions and approvals waiting in the Needs-you inbox count too, and Agent mode's prompts.
  const [q, setQ] = useState(0)
  useEffect(() => {
    const load = (): void => { void api.goals.list().then((gs) => setN(gs.filter((g) => goalColumn(g) === 'needs').length)).catch(() => undefined) }
    const loadQ = (): void => { void api.needsYou?.list().then((xs) => setQ(xs.filter((x) => (x.source === 'queue' || x.source === 'brain') && x.status === 'open').length)).catch(() => undefined) }
    load()
    loadQ()
    const off = api.goals.onChange(load)
    const offQ = api.needsYou?.onChange(loadQ)
    return () => { off(); offQ?.() }
  }, [])
  return n + q
}
