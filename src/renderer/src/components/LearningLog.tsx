import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { LearnedItem, LearnedKind, LearningSettings, LearningStatus, Space } from '@shared/types'
import { api } from '../api'
import * as I from '../icons'
import { toast } from '../lib/toast'
import '../styles-learning.css'
import { ClampText } from './ui'

// Settings → Memory → What I learned: everything SahilBot learned on its own while the app was idle
// (memories, skills, lessons, and memory tidying), grouped by day, each with Undo; plus the switches
// for learning, cloud use and its daily cap, and when it ran and will run next. A rule learned from a
// chat that read outside content, and a skill from a borderline run, wait here for Approve or Dismiss.

const KIND: Record<LearnedKind, { label: string; icon: (p: { size?: number }) => ReactNode; tone: string }> = {
  memory: { label: 'Memory', icon: (p) => <I.Sparkle {...p} />, tone: 'mem' },
  skill: { label: 'Skill', icon: (p) => <I.ListIcon {...p} />, tone: 'skill' },
  lesson: { label: 'Lesson', icon: (p) => <I.Shield {...p} />, tone: 'lesson' },
  merge: { label: 'Merged', icon: (p) => <I.Copy {...p} />, tone: 'tidy' },
  stale: { label: 'Out of date', icon: (p) => <I.Clock {...p} />, tone: 'tidy' },
  trim: { label: 'Tidied', icon: (p) => <I.Trash {...p} />, tone: 'tidy' }
}

type Filter = 'all' | 'memory' | 'skill' | 'lesson' | 'tidy'
const FILTERS: Array<{ f: Filter; label: string }> = [
  { f: 'all', label: 'All' }, { f: 'memory', label: 'Memories' }, { f: 'skill', label: 'Skills' }, { f: 'lesson', label: 'Lessons' }, { f: 'tidy', label: 'Tidying' }
]
const inFilter = (k: LearnedKind, f: Filter): boolean => f === 'all' || (f === 'tidy' ? k === 'merge' || k === 'stale' || k === 'trim' : k === f)

const ORIGIN: Record<string, string> = { app: 'From a connected app', handoff: 'From another bot', routine: 'From a routine' }

const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function dayLabel(t: number): string {
  const d = new Date(t)
  const today = new Date()
  const start = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((start(today) - start(d)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: diff < 7 ? 'long' : undefined, month: 'short', day: 'numeric', ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) })
}

const time = (t: number): string => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

function ago(t: number, now: number): string {
  const m = Math.round((now - t) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return dayLabel(t).toLowerCase() === 'yesterday' ? 'yesterday' : dayLabel(t)
}

export function LearningLog({ spaces }: { spaces: Space[] }) {
  const [status, setStatus] = useState<LearningStatus | null>(null)
  const [items, setItems] = useState<LearnedItem[] | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [showAll, setShowAll] = useState(false)
  const [cap, setCap] = useState('')
  const [now, setNow] = useState(Date.now())
  const busyUndo = useRef(new Set<string>())
  const byId = useMemo(() => new Map(spaces.map((s) => [s.id, s])), [spaces])

  const reload = (): void => {
    void api.learning.status().then((s) => { setStatus(s); setCap((c) => (c === '' ? s.settings.dailyUsd.toFixed(2) : c)) }).catch(() => undefined)
    void api.learning.list(300).then(setItems).catch(() => setItems([]))
  }
  useEffect(() => {
    reload()
    let t: ReturnType<typeof setTimeout> | null = null
    const off = api.learning.onChanged(() => { if (!t) t = setTimeout(() => { t = null; reload() }, 250) })
    const tick = setInterval(() => { setNow(Date.now()); void api.learning.status().then(setStatus).catch(() => undefined) }, 20_000)
    return () => { off(); clearInterval(tick); if (t) clearTimeout(t) }
  }, [])

  const save = async (patch: Partial<LearningSettings>): Promise<void> => {
    if (!status) return
    const next = { ...status.settings, ...patch }
    setStatus({ ...status, settings: next, enabled: next.enabled ?? status.enabled })
    try {
      await api.settings.set({ learning: next })
      reload()
    } catch (e) { toast(clean(e), 'error'); reload() }
  }

  const saveCap = (): void => {
    const n = Number(cap.replace(/[^0-9.]/g, ''))
    if (!Number.isFinite(n) || n < 0) { setCap(status?.settings.dailyUsd.toFixed(2) ?? '0.25'); return }
    const v = Math.min(5, Math.round(n * 100) / 100)
    setCap(v.toFixed(2))
    if (v !== status?.settings.dailyUsd) void save({ dailyUsd: v })
  }

  const learnNow = async (): Promise<void> => {
    try {
      setStatus(await api.learning.runNow())
      toast('Learning from your recent chats…', 'ok')
    } catch (e) { toast(clean(e), 'error') }
  }

  const undo = async (it: LearnedItem): Promise<void> => {
    if (busyUndo.current.has(it.id)) return
    busyUndo.current.add(it.id)
    try {
      setItems(await api.learning.undo(it.id))
      toast(it.kind === 'skill' ? 'Skill removed' : it.kind === 'memory' || it.kind === 'lesson' ? 'Forgotten. It won\'t be learned again.' : 'Put back', 'ok')
    } catch (e) { toast(clean(e), 'error') } finally { busyUndo.current.delete(it.id) }
  }

  const decide = async (it: LearnedItem, ok: boolean): Promise<void> => {
    if (busyUndo.current.has(it.id)) return
    busyUndo.current.add(it.id)
    try {
      setItems(await (ok ? api.learning.approve(it.id) : api.learning.dismiss(it.id)))
      toast(ok ? (it.kind === 'skill' ? 'Approved: bots can use this skill now.' : 'Approved and saved.') : 'Dismissed. It won\'t be learned again.', 'ok')
    } catch (e) { toast(clean(e), 'error') } finally { busyUndo.current.delete(it.id) }
  }

  const waiting = (items ?? []).filter((x) => x.pending).length
  const shown = (items ?? []).filter((x) => inFilter(x.kind, filter))
  const limited = showAll ? shown : shown.slice(0, 40)
  const days: Array<{ label: string; items: LearnedItem[] }> = []
  for (const it of limited) {
    const label = dayLabel(it.at)
    const last = days.at(-1)
    if (last?.label === label) last.items.push(it)
    else days.push({ label, items: [it] })
  }
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, memory: 0, skill: 0, lesson: 0, tidy: 0 }
    for (const x of items ?? []) { if (x.undone) continue; c.all++; for (const f of ['memory', 'skill', 'lesson', 'tidy'] as Filter[]) if (inFilter(x.kind, f)) c[f]++ }
    return c
  }, [items])

  const on = status?.enabled ?? false
  const st = status?.settings
  const line = (): ReactNode => {
    if (!status) return 'Loading…'
    if (status.running) return <><span className="ll-pulse" aria-hidden />Learning now{status.job ? `: ${status.job.toLowerCase()}` : ''}…</>
    if (!on) return 'Off. Nothing is learned in the background; bots still save what you tell them.'
    if (status.blocked) return status.blocked
    const parts: string[] = []
    if (status.lastRunAt) parts.push(`Last ran ${ago(status.lastRunAt, now)}${status.lastSummary ? `: ${status.lastSummary}` : ''}`)
    else parts.push('Hasn\'t run yet.')
    if (status.nextRunAt) parts.push(status.nextRunAt <= now + 60_000 ? 'Next run as soon as you\'re away for 2 minutes.' : `Next run around ${time(status.nextRunAt)}, when you're away.`)
    return parts.join(' ')
  }

  return (
    <section className="set-section ll" data-testid="learning-log">
      <div className="ll-head">
        <div>
          <div className="ll-title"><I.Sparkle size={15} />What I learned</div>
          <div className="ll-sub">While SahilBot is open and you're away, it reviews recent chats to remember what you didn't ask it to, turn work that went well into skills, and learn from mistakes. It stops the moment you're back.</div>
        </div>
      </div>

      <div className="set-card">
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Learn while SahilBot is open</div>
            <ClampText>{status && !status.localAvailable && !st?.cloudAllowed ? 'Needs a local model (Ollama or LM Studio), or cloud learning below.' : 'Uses your background model, local first. Never after you quit.'}</ClampText>
          </div>
          <div className="set-row-ctl">
            <button role="switch" aria-checked={on} aria-label="Learn while SahilBot is open" className={`switch${on ? ' on' : ''}`} disabled={!status}
              onClick={() => void save({ enabled: !on })} data-testid="learning-enabled"><i /></button>
          </div>
        </div>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-row-title">Use cloud models for learning</div>
            <ClampText>Only when no local model is available. Spending stops at the daily cap (it also counts toward your monthly cloud budget).</ClampText>
          </div>
          <div className="set-row-ctl ll-cloud">
            {st?.cloudAllowed && (
              <label className="ll-cap" title="Daily cap for learning">
                <span>$</span>
                <input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} onBlur={saveCap} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} aria-label="Daily cap in dollars" data-testid="learning-cap" />
                <span>/day</span>
              </label>
            )}
            <button role="switch" aria-checked={!!st?.cloudAllowed} aria-label="Use cloud models for learning" className={`switch${st?.cloudAllowed ? ' on' : ''}`} disabled={!status}
              onClick={() => void save({ cloudAllowed: !st?.cloudAllowed })} data-testid="learning-cloud"><i /></button>
          </div>
        </div>
        <div className="set-row ll-status-row">
          <div className="set-row-text">
            <div className={`ll-status${status?.running ? ' live' : ''}${on && status?.blocked ? ' warn' : ''}`} data-testid="learning-status">{line()}</div>
            {status?.model && on && (
              <ClampText>
                {status.cloud ? 'Cloud' : 'Local'} model: {status.model}
                {status.cloud && ` · $${status.spentTodayUsd.toFixed(2)} of $${status.settings.dailyUsd.toFixed(2)} used today`}
              </ClampText>
            )}
          </div>
          <div className="set-row-ctl">
            <button className="mm-btn" disabled={!status || status.running || (!!status.blocked && on)} onClick={() => void learnNow()} data-testid="learning-now">
              <I.Play size={13} />{status?.running ? 'Learning…' : 'Learn now'}
            </button>
          </div>
        </div>
      </div>

      {waiting > 0 && (
        <div className="set-card"><div className="ll-status warn" data-testid="learning-waiting">{waiting === 1 ? '1 item is' : `${waiting} items are`} waiting for your OK below: learned from a chat that also read outside content (a web page, email or another app), so nothing is used until you approve it.</div></div>
      )}

      {(items?.length ?? 0) > 0 && (
        <div className="mm-chips ll-chips" role="tablist" aria-label="Filter what was learned">
          {FILTERS.map(({ f, label }) => (
            <button key={f} role="tab" aria-selected={filter === f} className={`mm-chip${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>{label}<span>{counts[f]}</span></button>
          ))}
        </div>
      )}

      {items === null ? null : shown.length === 0 ? (
        <div className="set-card"><div className="mm-empty">{items.length === 0 ? 'Nothing learned yet. After you\'ve used SahilBot for a while, what it picks up shows here, and you can undo anything.' : 'Nothing of this kind yet.'}</div></div>
      ) : (
        <div className="ll-days">
          {days.map((d) => (
            <div className="ll-day" key={d.label}>
              <div className="mm-group-head"><span>{d.label}</span><span className="mm-count">{d.items.length}</span></div>
              <div className="set-card">
                {d.items.map((it) => {
                  const k = KIND[it.kind] ?? KIND.memory
                  const sp = it.spaceId ? byId.get(it.spaceId) : undefined
                  return (
                    <div className={`ll-row${it.undone ? ' undone' : ''}`} key={it.id} data-testid="learning-row">
                      <span className={`ll-icon ${k.tone}`} aria-hidden>{k.icon({ size: 14 })}</span>
                      <div className="ll-main">
                        <div className="ll-text">{it.kind === 'skill' ? <code>{it.title}</code> : it.title}</div>
                        {it.detail && <div className="ll-detail">{it.detail}</div>}
                        <div className="mm-meta ll-meta">
                          <span>{k.label}</span>
                          <span>{time(it.at)}</span>
                          {sp && <span className="mm-scope bot" style={{ '--mm-dot': sp.color } as CSSProperties}><i className="mm-dot" />{sp.name}</span>}
                          {it.threadId && (
                            <span><button className="link-btn ll-link" onClick={() => void api.learning.openChat(it.threadId!)} title="Open the chat it came from">
                              {it.threadTitle ? `“${it.threadTitle.slice(0, 48)}${it.threadTitle.length > 48 ? '…' : ''}”` : 'Source chat'}
                            </button></span>
                          )}
                          {it.pending && <span className="ll-tag" title="Learned from a chat that also read outside content. Nothing is saved or used until you approve it.">Waiting for your OK</span>}
                          {it.untrusted && !it.pending && <span className="ll-tag" title="Its source text came from a web page, email, another app or another bot. It's kept only for this bot as an unverified fact, never as a rule.">Unverified source</span>}
                          {it.origin && ORIGIN[it.origin] && <span className="ll-tag soft">{ORIGIN[it.origin]}</span>}
                        </div>
                      </div>
                      <div className="ll-actions">
                        {it.pending ? (
                          <>
                            <button className="mm-btn" onClick={() => void decide(it, true)} data-testid="learning-approve"><I.Check size={13} />Approve</button>
                            <button className="mm-btn" onClick={() => void decide(it, false)} data-testid="learning-dismiss"><I.Close size={13} />Dismiss</button>
                          </>
                        ) : it.undone ? <span className="ll-undone">{it.detail === 'Dismissed' ? 'Dismissed' : 'Undone'}</span>
                          : it.canUndo ? <button className="mm-btn" onClick={() => void undo(it)} data-testid="learning-undo"><I.Reply size={13} />Undo</button>
                          : <span className="ll-undone" title="It was changed or removed since, so there is nothing to undo">Changed since</span>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
          {limited.length < shown.length && <button className="link-btn mm-more" onClick={() => setShowAll(true)}>Show all {shown.length}</button>}
        </div>
      )}
    </section>
  )
}
