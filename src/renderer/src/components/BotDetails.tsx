import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { BotMaxSettings, LibraryItem, PermissionMode, RoutineRun, ScheduledTask, Space } from '@shared/types'
import { api } from '../api'
import { SpaceAvatar } from '../brand'
import * as I from '../icons'
import { describeSchedule, groupLibrary, host, routineStatus, when } from '../routines'
import { BotShareRows } from './BotShare'
import { BotGoals } from './TasksView'
import { BotStatusLine } from './FunctionBots'

type Tab = 'details' | 'library'
type Filter = 'all' | 'file' | 'link'

/** The bot's color for accents, unless it's so dark or light it would vanish in one of the themes. */
function accentOf(color: string | undefined): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color ?? '')
  if (!m) return 'var(--accent)'
  const n = parseInt(m[1], 16)
  const lum = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
  return lum < 0.18 || lum > 0.9 ? 'var(--accent)' : `#${m[1]}`
}

const clean = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function Toggle({ on, onChange, label, testId }: { on: boolean; onChange: (v: boolean) => void; label: string; testId?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} className={`rt-switch${on ? ' on' : ''}`} data-testid={testId}
      onClick={(e) => { e.stopPropagation(); onChange(!on) }}>
      <i />
    </button>
  )
}

/** Bot details panel (right side): profile, routines, library. Spec: design/bot-ui.md. */
export function BotDetails(p: { space: Space; threadId: string | null; onClose: () => void; onCustomize: () => void; onChanged: () => void; onEditRoutine: (text: string) => void }) {
  const { space } = p
  const [tab, setTab] = useState<Tab>('details')
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [runs, setRuns] = useState<Record<string, RoutineRun[]>>({})
  const [openId, setOpenId] = useState<string | null>(null)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [starting, setStarting] = useState<Set<string>>(new Set())
  const [err, setErr] = useState('')
  const [name, setName] = useState(space.name)
  const [label, setLabel] = useState(space.label ?? '')

  useEffect(() => { setName(space.name); setLabel(space.label ?? '') }, [space.id, space.name, space.label])
  useEffect(() => { setOpenId(null); setMenuId(null); setConfirmId(null); setErr(''); setTab('details') }, [space.id])

  const load = useCallback(async (): Promise<void> => {
    const all = (await api.schedules.list()).filter((t) => t.spaceId === space.id).sort((a, b) => a.createdAt - b.createdAt)
    setTasks(all)
    const hist = await Promise.all(all.map(async (t) => [t.id, await api.schedules.runs(t.id).catch(() => [])] as const))
    setRuns(Object.fromEntries(hist))
    setStarting(new Set())
  }, [space.id])
  useEffect(() => { void load(); return api.schedules.onChange(() => void load()) }, [load])

  // Escape closes the menu, then the routine view, then the panel. App's run-stopping Esc handler
  // (registered first, at mount) steps aside while this panel is open, so Esc here never stops a run.
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      // Not when something else already used this Esc (a menu, a rename, a modal's own close) or a modal is over the panel.
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('.scrim, .palette-wrap, .voice-mode, .settings-page')) return
      e.preventDefault()
      if (menuId || confirmId) { setMenuId(null); setConfirmId(null) } else if (openId) setOpenId(null)
      else p.onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [menuId, confirmId, openId, p])

  const saveSpace = async (patch: Parameters<typeof api.spaces.update>[1]): Promise<void> => {
    try {
      await api.spaces.update(space.id, patch)
      p.onChanged()
    } catch (e) { setErr(clean(e)) }
  }
  const commitName = (): void => {
    const n = name.replace(/\s+/g, ' ').trim()
    if (!n) { setName(space.name); return }
    if (n !== space.name) void saveSpace({ name: n })
  }
  const commitLabel = (): void => {
    const l = label.replace(/\s+/g, ' ').trim()
    if (l !== (space.label ?? '')) void saveSpace({ label: l || null })
  }

  const running = (id: string): boolean => starting.has(id) || runs[id]?.[0]?.status === 'running'
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setErr('')
    try { await fn() } catch (e) { setErr(clean(e)) }
  }
  const setEnabled = (t: ScheduledTask, on: boolean): Promise<void> => act(() => api.schedules.update(t.id, { enabled: on }))
  const test = (t: ScheduledTask): Promise<void> => {
    setStarting((s) => new Set(s).add(t.id))
    return act(() => api.schedules.runNow(t.id))
  }
  const edit = (t: ScheduledTask): void => { setMenuId(null); p.onEditRoutine(`Edit routine "${t.title}": `) }
  const remove = (t: ScheduledTask): Promise<void> => act(async () => {
    await api.schedules.remove(t.id)
    setConfirmId(null)
    if (openId === t.id) setOpenId(null)
  })

  const open = tasks.find((t) => t.id === openId) ?? null

  return (
    <aside className="bd" data-testid="bot-details" style={{ '--bot': accentOf(space.color) } as CSSProperties} aria-label={`${space.name} details`}>
      <div className="bd-bar">
        {open ? (
          <button className="bd-back" onClick={() => setOpenId(null)} data-testid="routine-back"><I.Chevron size={15} /> Routines</button>
        ) : <span />}
        <button className="bd-icon" onClick={p.onClose} aria-label="Close" title="Close"><I.Close size={15} /></button>
      </div>

      {open ? (
        <RoutineView task={open} runs={runs[open.id] ?? []} running={running(open.id)} confirming={confirmId === open.id}
          onPause={() => void setEnabled(open, !open.enabled)} onTest={() => void test(open)} onEdit={() => edit(open)}
          onDelete={() => setConfirmId(open.id)} onCancelDelete={() => setConfirmId(null)} onConfirmDelete={() => void remove(open)} err={err} />
      ) : (
        <>
          <div className="bd-hero">
            <div className="bd-avatar"><SpaceAvatar color={space.color} shape={space.shape} icon={space.icon} size={88} /></div>
            <input className="bd-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName} maxLength={60} aria-label="Bot name"
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setName(space.name); e.stopPropagation(); e.currentTarget.blur() } }} />
            <input className="bd-label" value={label} onChange={(e) => setLabel(e.target.value)} onBlur={commitLabel} placeholder="Add a label" maxLength={80} aria-label="Label" data-testid="bot-label"
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setLabel(space.label ?? ''); e.stopPropagation(); e.currentTarget.blur() } }} />
            {space.kind !== 'project' && <BotStatusLine space={space} />}
          </div>

          <div className="bd-tabs" role="tablist">
            {(['details', 'library'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)} data-testid={`bot-tab-${t}`}>
                {t === 'details' ? 'Details' : 'Library'}
              </button>
            ))}
          </div>

          {tab === 'details' ? (
            <div className="bd-body">
              {space.kind !== 'group' && <BotGoals spaceId={space.id} />}
              {/* Routines are made, changed and removed by asking the bot in chat; here you see them and can pause one. */}
              {tasks.length > 0 && <>
                <div className="bd-section-title">Routines</div>
                <div className="bd-card">
                  {tasks.map((t) => (
                    <div key={t.id} className={`rt-row${t.enabled ? '' : ' paused'}`} data-testid="routine-row">
                      <button className="rt-main" onClick={() => { setMenuId(null); setOpenId(t.id) }} title={t.title}>
                        <span className="rt-icon"><I.Clock size={16} /></span>
                        <span className="rt-text">
                          <b>{t.title}</b>
                          <span data-testid="routine-status">{routineStatus(t, running(t.id))}</span>
                        </span>
                      </button>
                      <Toggle on={t.enabled} onChange={(v) => void setEnabled(t, v)} label={t.enabled ? 'Pause routine' : 'Resume routine'} testId="routine-toggle" />
                    </div>
                  ))}
                </div>
                <p className="bd-agent-note" data-testid="routine-hint">To add, change or remove one, just ask in the chat.</p>
              </>}
              {err && <div className="bd-err" role="alert">{err}</div>}

              {/* Just the basics. Notifications are automatic, memory is one vault that remembers the most, and the bot
                  picks its own models and tools: none of that needs a switch. Anything else, ask the bot in chat. */}
              <div className="bd-section-title">Settings</div>
              <div className="bd-card" data-testid="bot-behaviour">
                <AutonomyRow space={space} />
                <button className="bd-row bd-row-btn" onClick={p.onCustomize} data-testid="bot-customize">
                  <span className="bd-row-text">Customize look and instructions…</span>
                  <span className="bd-chev"><I.Chevron size={14} /></span>
                </button>
              </div>
              <BotShareRows space={space} />
              {!space.isMain && space.kind === 'bot' && <BotRemoveRows space={space} onChanged={p.onChanged} onClose={p.onClose} />}
            </div>
          ) : (
            <Library spaceId={space.id} />
          )}
        </>
      )}
    </aside>
  )
}

function RoutineView(p: { task: ScheduledTask; runs: RoutineRun[]; running: boolean; confirming: boolean; err: string; onPause: () => void; onTest: () => void; onEdit: () => void; onDelete: () => void; onCancelDelete: () => void; onConfirmDelete: () => void }) {
  const t = p.task
  return (
    <div className="bd-body rt-detail" data-testid="routine-detail">
      <div className="rt-head">
        <span className="rt-icon big"><I.Clock size={20} /></span>
        <div>
          <h3>{t.title}</h3>
          <span className={`rt-state${p.running ? ' running' : t.enabled ? ' on' : ''}`}>{p.running ? 'Running…' : t.enabled ? 'Active' : 'Paused'}</span>
        </div>
      </div>

      <div className="bd-card rt-facts">
        <div className="rt-fact"><label>Instruction</label><p className="rt-prompt">{t.prompt}</p></div>
        <div className="rt-fact"><label>When to run</label><p>{describeSchedule(t.schedule)}</p></div>
        <div className="rt-fact"><label>Next run</label><p>{t.enabled && t.nextRun ? when(t.nextRun) : t.enabled ? 'Not scheduled' : 'Paused'}</p></div>
      </div>

      <div className="rt-actions">
        <button className="bd-btn" onClick={p.onPause}>{t.enabled ? 'Pause' : 'Resume'}</button>
        <button className="bd-btn" onClick={p.onTest} disabled={p.running} data-testid="routine-test">{p.running ? 'Running…' : 'Test'}</button>
        <button className="bd-btn" onClick={p.onEdit} data-testid="routine-edit">Edit</button>
        <button className="bd-btn danger" onClick={p.onDelete} data-testid="routine-delete">Delete</button>
      </div>
      {p.confirming && (
        <div className="rt-confirm block" role="alertdialog" aria-label="Delete routine">
          <span>Delete “{t.title}”? This can’t be undone.</span>
          <button className="bd-btn" onClick={p.onCancelDelete}>Cancel</button>
          <button className="bd-btn danger" onClick={p.onConfirmDelete} data-testid="routine-delete-confirm">Delete</button>
        </div>
      )}
      {p.err && <div className="bd-err" role="alert">{p.err}</div>}

      <div className="bd-section-title">Run history</div>
      <div className="bd-card rt-history" data-testid="routine-history">
        {p.runs.length === 0 && <div className="bd-empty">No runs yet</div>}
        {p.runs.map((r) => (
          <div key={r.id} className={`rt-run ${r.status}`}>
            <span className="rt-dot" aria-hidden="true" />
            <div className="rt-run-text">
              <b>{r.status === 'running' ? 'Running' : r.status === 'succeeded' ? 'Succeeded' : 'Failed'}{r.test ? <em> · Test</em> : null}</b>
              <span>{when(r.startedAt)}{r.finishedAt && r.status !== 'running' ? ` · ${duration(r.finishedAt - r.startedAt)}` : ''}</span>
              {r.reason && <span className="rt-reason">{r.reason}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`
}

const PER_GROUP = 5

function Library({ spaceId }: { spaceId: string }) {
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [shown, setShown] = useState<Record<string, number>>({})

  useEffect(() => {
    let live = true
    setItems(null)
    api.spaces.library(spaceId).then((xs) => { if (live) setItems(xs) }).catch(() => { if (live) setItems([]) })
    return () => { live = false }
  }, [spaceId])
  useEffect(() => setShown({}), [filter, spaceId])

  const groups = useMemo(() => groupLibrary((items ?? []).filter((x) => filter === 'all' || x.kind === filter)), [items, filter])

  const openItem = (it: LibraryItem): void => {
    // Docs: a live document opens in its chat's Document tab.
    if (it.docId) window.dispatchEvent(new CustomEvent('sahilbot:open-doc', { detail: { docId: it.docId, threadId: it.threadId } }))
    else if (it.kind === 'link' && it.url) window.open(it.url, '_blank', 'noopener')
    else if (it.path) void api.files.open(it.path).catch(() => api.files.reveal(it.path!))
  }

  return (
    <div className="bd-body lib" data-testid="bot-library">
      <div className="lib-filters" role="tablist" aria-label="Show">
        {([['all', 'All'], ['file', 'Files'], ['link', 'Links']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)} data-testid={`library-filter-${k}`}>{l}</button>
        ))}
      </div>
      {items === null && <div className="bd-empty">Loading…</div>}
      {items !== null && groups.length === 0 && (
        <div className="bd-empty">{filter === 'link' ? 'No links yet.' : filter === 'file' ? 'No files yet.' : 'Files and links from this chat show up here.'}</div>
      )}
      {groups.map((g) => {
        const n = shown[g.key] ?? PER_GROUP
        return (
          <div key={g.key} className="lib-group">
            <div className="bd-section-title">{g.label}</div>
            <div className="bd-card">
              {g.items.slice(0, n).map((it) => (
                <button key={`${it.kind}:${it.path ?? it.url}`} className="lib-item" onClick={() => openItem(it)} title={it.path ?? it.url} data-testid="library-item">
                  <span className={`lib-icon ${it.kind}`}>{it.kind === 'file' ? <I.File size={16} /> : <I.Globe size={16} />}</span>
                  <span className="lib-text">
                    <b>{it.title}</b>
                    <span>{it.docId ? 'Live document' : it.kind === 'link' && it.url ? host(it.url) : folderOf(it.path ?? '')}</span>
                  </span>
                  <span className="lib-time">{when(it.at).replace(/^Today at /, '')}</span>
                </button>
              ))}
              {g.items.length > n && (
                <button className="lib-more" onClick={() => setShown((s) => ({ ...s, [g.key]: n + PER_GROUP }))}>Show more</button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function folderOf(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 2] : ''
}

/**
 * The permission level this bot's new chats start in (Settings keeps it; Bypass is only ever per chat). A bot
 * with its own job defaults to Auto, and changing it applies to its open conversation too.
 */
function AutonomyRow({ space }: { space: Space }) {
  const spaceId = space.id
  const bot = space.kind === 'bot' && !space.isMain
  const [s, setS] = useState<{ mine?: PermissionMode; app: PermissionMode; all: Record<string, PermissionMode> } | null>(null)
  useEffect(() => {
    let alive = true
    void api.settings.get().then((x) => { if (alive) setS({ mine: x.botModes?.[spaceId], app: x.defaultMode ?? 'auto', all: x.botModes ?? {} }) })
    return () => { alive = false }
  }, [spaceId])
  if (!s) return null
  const names: Record<string, string> = { ask: 'Ask', auto: 'Auto', autonomous: 'Auto' }
  const pick = (v: string): void => {
    const all = { ...s.all }
    if (v === '') delete all[spaceId]
    else all[spaceId] = v as PermissionMode
    setS({ ...s, mine: (v || undefined) as PermissionMode | undefined, all })
    const saved = bot && v ? api.botAutonomy.setLevel(spaceId, v as PermissionMode) : api.settings.set({ botModes: all })
    void Promise.resolve(saved).then(() => window.dispatchEvent(new Event('sahilbot:settings-changed')))
  }
  const mine = s.mine === 'autonomous' ? 'auto' : s.mine
  const level = mine ?? (bot ? 'auto' : undefined)
  const sub = level === 'ask' ? 'Asks before every change.' : level === 'auto' ? 'Works on its own; asks before money, passwords, deleting and posting.' : 'Each chat can change it under its message box.'
  return (
    <label className="bd-row">
      <span className="bd-row-text">{bot ? 'Permissions' : 'Permissions for new chats'}<span className="bd-row-sub">{sub}</span></span>
      <select className="bd-select" value={bot ? level : mine ?? ''} onChange={(e) => pick(e.target.value)} data-testid="bot-autonomy" aria-label="Permissions for new chats">
        {!bot && <option value="">Default ({names[s.app] ?? 'Auto'})</option>}
        <option value="ask">Ask</option>
        <option value="auto">Auto</option>
      </select>
    </label>
  )
}

/**
 * Max: Off (only when you turn it on in the composer) / Auto (teams up only for big tasks; default) / Always, Max helpers (1-50)
 * and what one Max run may spend in a routine. Older installs kept these as the Swarm setting (read as the fallback).
 */
export function MaxRows({ spaceId }: { spaceId: string }) {
  const [all, setAll] = useState<Record<string, Partial<BotMaxSettings>> | null>(null)
  const [old, setOld] = useState<Partial<BotMaxSettings>>({})
  useEffect(() => {
    let alive = true
    void api.settings.get().then((x) => { if (alive) { setAll(x.botMax ?? {}); setOld(x.botSwarm?.[spaceId] ?? {}) } })
    return () => { alive = false }
  }, [spaceId])
  if (!all) return null
  const mine = { ...old, ...(all[spaceId] ?? {}) }
  const mode = mine.mode ?? 'auto'
  const max = mine.maxHelpers ?? 20
  const routine = mine.routineUsd ?? 1
  const save = (patch: Partial<BotMaxSettings>): void => {
    const next = { ...all, [spaceId]: { ...mine, ...patch } }
    setAll(next)
    void api.settings.set({ botMax: next }).then(() => window.dispatchEvent(new Event('sahilbot:settings-changed')))
  }
  return (
    <>
      <label className="bd-row">
        <span className="bd-row-text">Max<span className="bd-row-sub">{mode === 'off' ? 'Only when you turn Max on under the message box.' : mode === 'always' ? 'Every request runs many agents: a team, a swarm, judged attempts or a mix.' : 'Teams up only for big tasks (reports, big comparisons, many files); small ones stay with one agent.'}</span></span>
        <select className="bd-select" value={mode} onChange={(e) => save({ mode: e.target.value as BotMaxSettings['mode'] })} data-testid="bot-max-mode" aria-label="Max">
          <option value="off">Off</option>
          <option value="auto">Auto</option>
          <option value="always">Always</option>
        </select>
      </label>
      {mode !== 'off' && (
        <>
          <label className="bd-row">
            <span className="bd-row-text">Max helpers<span className="bd-row-sub">Up to 50, sized to each task.</span></span>
            <input className="bd-select bd-num" type="number" min={1} max={50} value={max} data-testid="bot-max-helpers" aria-label="Max helpers"
              onChange={(e) => { const n = Math.round(Number(e.target.value)); if (Number.isFinite(n)) save({ maxHelpers: Math.min(50, Math.max(1, n)) }) }} />
          </label>
          <label className="bd-row">
            <span className="bd-row-text">Routine Max budget<span className="bd-row-sub">Most one Max run may spend in a routine. $0 = none.</span></span>
            <input className="bd-select bd-num" type="number" min={0} max={100} step={0.5} value={routine} data-testid="bot-max-routine" aria-label="Routine Max budget"
              onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) save({ routineUsd: Math.min(100, Math.max(0, n)) }) }} />
          </label>
        </>
      )}
    </>
  )
}

/** Hide a bot from the sidebar, or delete it (asks first): right in its profile, no right-click needed. */
function BotRemoveRows({ space, onChanged, onClose }: { space: Space; onChanged: () => void; onClose: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const hide = async (): Promise<void> => { await api.spaces.update(space.id, { hidden: !space.hidden }); onChanged() }
  const del = async (): Promise<void> => { await api.spaces.remove(space.id); onChanged(); onClose() }
  return (
    <>
      <div className="bd-section-title">Remove</div>
      <div className="bd-card">
        <button className="bd-row bd-row-btn" onClick={() => void hide()} data-testid="bot-hide">
          <span className="bd-row-text">{space.hidden ? 'Show in the sidebar' : 'Hide from the sidebar'}<span className="bd-row-sub">{space.hidden ? 'It comes back with its chat and routines.' : 'Its chat and routines stay; find it under Hidden bots.'}</span></span>
        </button>
        {!confirm ? (
          <button className="bd-row bd-row-btn danger" onClick={() => setConfirm(true)} data-testid="bot-delete">
            <span className="bd-row-text">Delete {space.name}<span className="bd-row-sub">Removes the bot, its chat and its routines.</span></span>
          </button>
        ) : (
          <div className="rt-confirm block" role="alertdialog" aria-label="Delete bot">
            <span>Delete {space.name} and its chat? This can’t be undone.</span>
            <button className="bd-btn" onClick={() => setConfirm(false)}>Cancel</button>
            <button className="bd-btn danger" onClick={() => void del()} data-testid="bot-delete-confirm">Delete</button>
          </div>
        )}
      </div>
    </>
  )
}
