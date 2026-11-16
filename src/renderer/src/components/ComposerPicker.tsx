import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { EffortChoice, ModelInfo, ModelList, PermissionMode } from '@shared/types'
import * as I from '../icons'
import { AUTO_ENTRIES, autoUnavailableReason, pickerModels, toDownload } from '@shared/model-picker'
import { THINKING_LABEL, pickerLabel, runnable, shortModelName, splitModels, thinkingLevels } from '../lib/picker'

// The composer's one picker, under the box on the right: model, thinking and permissions in one button
// ("Auto" until something is overridden). The menu opens upward; Thinking, More models and Permissions
// open as side flyouts (to the left, where the window has room). Keys: ↑↓ move, → / Enter open a flyout,
// ← / Esc close it (Esc again closes the menu), 1–4 pick one of the top models.

const THINKING: Array<{ id: EffortChoice; sub: string }> = [
  { id: 'auto', sub: 'Recommended. More for real tasks, less for quick chats' },
  { id: 'low', sub: 'Fastest. Quick answers, little thinking' },
  { id: 'medium', sub: 'Balanced. Some thinking on every request' },
  { id: 'high', sub: 'Thinks things through more carefully' },
  { id: 'xhigh', sub: 'Deep thinking for hard problems and long tasks' },
  { id: 'max', sub: 'Thinks as long as it needs. Slowest; most tokens' }
]

/** Autonomy levels, least to most on its own. Bypass shows only when Settings → Advanced allows it. */
export const MODES: Array<{ id: PermissionMode; label: string; sub: string }> = [
  { id: 'ask', label: 'Ask first', sub: 'Approve every action that changes something' },
  { id: 'auto', label: 'Auto', sub: 'Routine steps run on their own. Asks before installing, sending, buying, posting or deleting' },
  { id: 'autonomous', label: 'Autonomous', sub: 'Also runs builds, tests, installs from the project\'s lockfile, git and file changes in your folders. Still asks before deleting, sending, buying, or going outside your folders' },
  { id: 'bypass', label: 'Bypass', sub: 'Everything runs except hard stops. Resets on restart.' }
]

const TIER = ['Instant', 'Light', 'Standard', 'Heavy']

const RefreshIcon = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
  </svg>
)

type Sub = 'thinking' | 'more' | 'perm'

export interface PickerProps {
  models: ModelList | null
  model: string
  onModel: (id: string) => void
  onRefreshModels: () => void
  onManageModels?: () => void
  thinking?: EffortChoice
  onThinking?: (e: EffortChoice) => void
  mode: PermissionMode
  onMode: (m: PermissionMode) => void
  allowBypass?: boolean
  /** A bot or group chat: model and thinking are chosen for each request (shown, not editable). */
  autoBot?: boolean
}

const ITEMS = '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)'
const isCloud = (m: ModelInfo): boolean => m.note === 'remote'

/** One model's sub-line: tier, where it runs (size on this Mac or cloud), and why it's limited here. */
function modelSub(m: ModelInfo, withId: boolean): string {
  const where = isCloud(m) ? m.providerName : `${m.requiredGB} GB`
  const limit = !m.fits && m.note && !isCloud(m) ? ` · ${m.note}` : ''
  return `${TIER[m.tier] ?? 'Standard'}${withId && m.label ? ` · ${m.id}` : ''} · ${where}${m.vision ? ' · sees images' : ''}${limit}`
}

export function ComposerPicker(p: PickerProps) {
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState<Sub | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const main = useRef<HTMLDivElement>(null)
  const fly = useRef<HTMLDivElement>(null)
  const rows = useRef<Partial<Record<Sub, HTMLButtonElement | null>>>({})
  const hover = useRef<number | undefined>(undefined)
  /** Where focus goes once the menu or a flyout renders (keyboard opens focus an item; mouse opens the menu itself). */
  const pendingFocus = useRef<'menu' | 'item' | 'sub' | null>(null)

  const list = p.models
  const usable = pickerModels(list)
  const { top, more } = splitModels(usable)
  const current = usable.find((m) => m.id === p.model)
  const modes = MODES.filter((m) => m.id !== 'bypass' || p.allowBypass || p.mode === 'bypass')
  const mode = MODES.find((m) => m.id === p.mode) ?? MODES[1]
  const hasThinking = !!(p.thinking && p.onThinking)
  const levels = thinkingLevels(p.autoBot ? 'auto' : p.model)
  const thinkingShown = THINKING.filter((t) => levels.includes(t.id) || t.id === p.thinking)
  const label = pickerLabel({ model: p.model, models: usable, thinking: hasThinking ? p.thinking : undefined, mode: p.mode, autoBot: p.autoBot })
  const autoVariants = AUTO_ENTRIES.filter((e) => e.id !== 'auto' && (e.id !== 'auto:local' || !list?.localOff))
  const inMore = p.model !== 'auto' && (more.some((m) => m.id === p.model) || autoVariants.some((e) => e.id === p.model))
  const toGet = toDownload(list).length

  const clearHover = (): void => { if (hover.current !== undefined) window.clearTimeout(hover.current); hover.current = undefined }
  const close = (refocus = false): void => {
    clearHover()
    setOpen(false)
    setSub(null)
    if (refocus) btn.current?.focus()
  }
  const openSub = (s: Sub, focus: boolean): void => {
    clearHover()
    if (focus) pendingFocus.current = 'sub'
    setSub(s)
  }
  const closeSub = (refocus: boolean): void => {
    clearHover()
    if (refocus && sub) rows.current[sub]?.focus()
    setSub(null)
  }
  const pickModel = (id: string, keyboard: boolean): void => { p.onModel(id); close(keyboard) }

  // Outside clicks close the menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => { if (!wrap.current?.contains(e.target as Node)) close() }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  useEffect(() => () => clearHover(), [])

  // Keys while the menu is open (latest state through a ref; one listener per open).
  const onKey = useRef<(e: KeyboardEvent) => void>(() => undefined)
  onKey.current = (e: KeyboardEvent): void => {
    if (e.isComposing) return
    const active = document.activeElement as HTMLElement | null
    const inFly = !!(sub && fly.current && active && fly.current.contains(active))
    if (e.key === 'Escape') {
      e.preventDefault()
      if (sub) closeSub(true)
      else close(true)
      return
    }
    if (e.key === 'Tab') { close(); return }
    if (e.key === 'ArrowLeft') {
      if (sub) { e.preventDefault(); closeSub(true) }
      return
    }
    if (e.key === 'ArrowRight') {
      const s = active?.closest<HTMLElement>('[data-sub]')?.dataset.sub as Sub | undefined
      if (s && !inFly) { e.preventDefault(); openSub(s, true) }
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      const level = inFly ? fly.current : main.current
      if (!level) return
      e.preventDefault()
      const items = Array.from(level.querySelectorAll<HTMLElement>(ITEMS))
      if (!items.length) return
      const i = active ? items.indexOf(active) : -1
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
        : e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1)
      // Moving through the main list closes a flyout that was opened from another row.
      if (!inFly && sub && items[next] !== rows.current[sub]) setSub(null)
      items[next].focus()
      return
    }
    if (/^[1-4]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && !p.autoBot) {
      const m = top[Number(e.key) - 1]
      if (m && runnable(m)) { e.preventDefault(); pickModel(m.id, true) }
    }
  }
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent): void => onKey.current(e)
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [open])

  // Focus after opening: the checked item (keyboard) or the menu itself (mouse), so the keys work either way.
  useLayoutEffect(() => {
    const want = pendingFocus.current
    if (!want) return
    if (want === 'sub') {
      if (!fly.current) return
      pendingFocus.current = null
      const el = fly.current.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)') ?? fly.current.querySelector<HTMLElement>(ITEMS)
      el?.focus()
      return
    }
    if (!main.current) return
    pendingFocus.current = null
    if (want === 'item') (main.current.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)') ?? main.current.querySelector<HTMLElement>(ITEMS))?.focus()
    else menu.current?.focus({ preventScroll: true })
  }, [open, sub])

  // Flyout placement: beside its row (left of the menu when there's room, else right, else over it), and
  // moved up or down so it stays inside the window.
  useLayoutEffect(() => {
    const f = fly.current
    const m = menu.current
    const r = sub ? rows.current[sub] : null
    if (!f || !m || !r) return
    const place = (): void => {
      const pad = 8
      const gap = 6
      const mr = m.getBoundingClientRect()
      const rr = r.getBoundingClientRect()
      const w = f.offsetWidth
      const h = f.offsetHeight
      f.style.left = ''
      f.style.right = ''
      if (mr.left - gap - w >= pad) { f.style.right = `calc(100% + ${gap}px)`; f.dataset.side = 'left' }
      else if (mr.right + gap + w <= window.innerWidth - pad) { f.style.left = `calc(100% + ${gap}px)`; f.dataset.side = 'right' }
      else { f.style.left = `${Math.max(pad, Math.min(mr.left, window.innerWidth - pad - w)) - mr.left - m.clientLeft}px`; f.dataset.side = 'over' }
      const origin = mr.top + m.clientTop
      let top = rr.top - origin - 6
      if (origin + top + h > window.innerHeight - pad) top = window.innerHeight - pad - h - origin
      if (origin + top < pad) top = pad - origin
      f.style.top = `${Math.round(top)}px`
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [sub, open, list])

  /** A row that opens a flyout: hover (after a beat), click, Enter, Space or → open it. */
  const subRow = (s: Sub, o: { testId: string; icon: ReactNode; label: string; value?: ReactNode; title?: string }): ReactNode => (
    <button ref={(el) => { rows.current[s] = el }} className={`menu-item cpick-row cpick-subrow${sub === s ? ' open' : ''}`} role="menuitem"
      aria-haspopup="menu" aria-expanded={sub === s} data-sub={s} data-testid={o.testId} title={o.title}
      onMouseEnter={() => { clearHover(); if (sub !== s) hover.current = window.setTimeout(() => setSub(s), sub ? 120 : 90) }}
      onClick={(e) => openSub(s, e.detail === 0)}>
      <span className="cpick-ico" aria-hidden>{o.icon}</span>
      <span className="cpick-text">{o.label}</span>
      {o.value !== undefined && <span className="cpick-val">{o.value}</span>}
      <I.Chevron size={13} className="cpick-chev" aria-hidden />
    </button>
  )
  /** Hovering a plain row closes an open flyout (after a beat, so a diagonal move into the flyout survives). */
  const plainHover = (): void => { clearHover(); if (sub) hover.current = window.setTimeout(() => setSub(null), 260) }

  const check = (on: boolean): ReactNode => <span className="check cpick-check" aria-hidden>{on && <I.Check size={14} />}</span>

  const autoWhy = autoUnavailableReason('auto', list)
  const flyout = (): ReactNode => {
    if (sub === 'thinking') return (
      <>
        <div className="menu-head">Thinking · a level you pick is used as is</div>
        {thinkingShown.map((t) => (
          <button key={t.id} className="menu-item cpick-row" role="menuitemradio" aria-checked={t.id === p.thinking}
            onClick={(e) => { p.onThinking!(t.id); close(e.detail === 0) }} data-testid={`thinking-${t.id}`}>
            {check(t.id === p.thinking)}
            <span className="cpick-text">{THINKING_LABEL[t.id]}<span className="sub">{t.sub}</span></span>
          </button>
        ))}
        {levels.length < THINKING.length && <div className="menu-foot">This model offers {levels.length > 1 ? 'only these levels' : 'no thinking levels'}.</div>}
      </>
    )
    if (sub === 'perm') return (
      <>
        <div className="menu-head">Permissions · this chat</div>
        {modes.map((m) => (
          <button key={m.id} className="menu-item cpick-row" role="menuitemradio" aria-checked={m.id === p.mode}
            onClick={(e) => { p.onMode(m.id); close(e.detail === 0) }} data-testid={`mode-${m.id}`}>
            {check(m.id === p.mode)}
            <span className="cpick-text">{m.id === 'bypass' ? <span className="ui-text-danger">{m.label}</span> : m.label}<span className="sub">{m.sub}</span></span>
          </button>
        ))}
        <div className="menu-foot">Passwords are never shared, and purchases always ask, at every level.</div>
      </>
    )
    if (sub === 'more') {
      if (!list) return <div className="menu-head">Loading models…</div>
      const groups = [...new Set(more.map((m) => m.providerName))]
      return (
        <>
          <div className="menu-head">Auto, narrowed</div>
          {autoVariants.map((e) => {
            // A variant with nothing to route to says why (and stays pickable: models may come back).
            const why = autoUnavailableReason(e.id, list)
            return (
              <button key={e.id} className={`menu-item cpick-row${why ? ' unavailable' : ''}`} role="menuitemradio" aria-checked={p.model === e.id}
                onClick={(ev) => pickModel(e.id, ev.detail === 0)} data-testid="model-option" data-auto={e.id}>
                {check(p.model === e.id)}
                <span className="cpick-text">{e.label}<span className="sub">{why ?? e.sub}</span></span>
                {why && <span className="mm-badge" data-testid="auto-unavailable">Unavailable</span>}
              </button>
            )
          })}
          {groups.map((g) => (
            <div key={g} role="group" aria-label={g}>
              <div className="menu-sep" />
              <div className="menu-head">{g}{more.some((m) => m.providerName === g && !isCloud(m)) ? ` · this Mac: ${list.totalGB} GB` : ''}</div>
              {more.filter((m) => m.providerName === g).map((m) => (
                <button key={m.id} className="menu-item cpick-row" role="menuitemradio" aria-checked={m.id === p.model} disabled={!runnable(m)}
                  onClick={(e) => pickModel(m.id, e.detail === 0)} title={m.fits ? m.id : m.note} data-testid="model-option">
                  {check(m.id === p.model)}
                  <span className="cpick-text">{m.label || m.id}<span className="sub">{modelSub(m, true)}</span></span>
                </button>
              ))}
            </div>
          ))}
          {!more.length && <div className="cpick-empty">Every model you can use is in the list already.</div>}
          <div className="menu-sep" />
          {p.onManageModels && (
            <button className="menu-item cpick-row" role="menuitem" onClick={() => { close(); p.onManageModels!() }} data-testid="manage-models">
              <span className="cpick-ico" aria-hidden><I.Gear size={14} /></span>
              <span className="cpick-text">Manage models…{toGet > 0 && <span className="sub">{toGet} recommended for this Mac to download</span>}</span>
            </button>
          )}
          <button className="menu-item cpick-row" role="menuitem" onClick={() => p.onRefreshModels()} data-testid="refresh-models">
            <span className="cpick-ico" aria-hidden><RefreshIcon /></span>
            <span className="cpick-text">Refresh list</span>
          </button>
        </>
      )
    }
    return null
  }

  const permIcon = p.mode === 'bypass' ? <span className="dot red" /> : p.mode === 'autonomous' ? <I.Play size={13} /> : <I.Shield size={14} />
  const thinkingValue = THINKING_LABEL[p.thinking ?? 'auto']

  return (
    <div ref={wrap} className={`pick under-pick cpick${p.mode === 'bypass' ? ' bypass' : ''}${p.mode === 'autonomous' ? ' autonomous' : ''}${open ? ' is-open' : ''}`}>
      <button ref={btn} className="cpick-btn" data-testid="model-picker" aria-haspopup="menu" aria-expanded={open}
        title={`${label} · model, thinking and permissions for this chat`}
        onClick={(e) => {
          if (open) { close(); return }
          pendingFocus.current = e.detail === 0 ? 'item' : 'menu'
          setOpen(true)
        }}>
        {p.mode === 'bypass' && <span className="dot red" aria-label="Bypass is on" />}
        {p.mode === 'autonomous' && <I.Play size={12} />}
        <span className="cpick-label">{label}</span>
        <I.Chevron size={13} className="cpick-btn-chev" aria-hidden />
      </button>
      {open && (
        <div ref={menu} className="menu right cpick-menu model-menu" tabIndex={-1} data-testid="picker-menu">
          <div ref={main} className="cpick-main" role="menu" aria-label="Model, thinking and permissions">
            {p.autoBot ? (
              <>
                <div className="cpick-hint">Model and thinking: chosen automatically for each request</div>
                <button className="menu-item cpick-row" role="menuitem" disabled aria-disabled data-testid="model-auto-bot">
                  <span className="cpick-ico" aria-hidden><I.Cpu size={14} /></span>
                  <span className="cpick-text">Model</span><span className="cpick-val">Auto (bot)</span>
                </button>
                {hasThinking && (
                  <button className="menu-item cpick-row" role="menuitem" disabled aria-disabled data-testid="thinking-picker">
                    <span className="cpick-ico" aria-hidden><I.Sparkle size={14} /></span>
                    <span className="cpick-text">Thinking</span><span className="cpick-val">Auto (bot)</span>
                  </button>
                )}
              </>
            ) : (
              <>
                <button className={`menu-item cpick-row cpick-model${autoWhy ? ' unavailable' : ''}`} role="menuitemradio" aria-checked={p.model === 'auto'}
                  onMouseEnter={plainHover} onClick={(e) => pickModel('auto', e.detail === 0)} data-testid="model-option" data-auto="auto">
                  {check(p.model === 'auto')}
                  <span className="cpick-text">Auto <span className="cpick-rec">(recommended)</span><span className="sub">{autoWhy ?? 'The right model for each message, local or cloud'}</span></span>
                  {autoWhy && <span className="mm-badge" data-testid="auto-unavailable">Unavailable</span>}
                </button>
                {list && !list.ok && (
                  <div className="cpick-error">
                    <div className="cpick-error-title">No model server answered</div>
                    <div className="hint">{list.error}</div>
                  </div>
                )}
                {!list && <div className="menu-head">Loading models…</div>}
                {top.map((m, i) => (
                  <button key={m.id} className="menu-item cpick-row cpick-model" role="menuitemradio" aria-checked={m.id === p.model}
                    disabled={!runnable(m)} onMouseEnter={plainHover} onClick={(e) => pickModel(m.id, e.detail === 0)}
                    title={m.fits ? m.id : m.note} aria-keyshortcuts={String(i + 1)} data-testid="model-option">
                    {check(m.id === p.model)}
                    <span className="cpick-text">{shortModelName(m.id, m)}<span className="sub">{modelSub(m, false)}</span></span>
                    <kbd className="cpick-key" aria-hidden>{i + 1}</kbd>
                  </button>
                ))}
                {hasThinking && (
                  <>
                    <div className="menu-sep" />
                    {subRow('thinking', { testId: 'thinking-picker', icon: <I.Sparkle size={14} />, label: 'Thinking', value: thinkingValue, title: 'Thinking for this chat' })}
                  </>
                )}
                <div className="menu-sep" />
                {subRow('more', { testId: 'more-models', icon: <I.Cpu size={14} />, label: 'More models', value: inMore ? shortModelName(p.model, current) : undefined })}
              </>
            )}
            <div className="menu-sep" />
            {subRow('perm', {
              testId: 'mode-picker', icon: permIcon, label: 'Permissions',
              value: <span className={p.mode === 'bypass' ? 'ui-text-danger' : undefined}>{mode.label}</span>,
              title: 'Autonomy: how much SahilBot does without asking'
            })}
          </div>
          {sub && (
            <div ref={fly} className={`cpick-fly cpick-fly-${sub}`} role="menu" aria-label={sub === 'thinking' ? 'Thinking' : sub === 'perm' ? 'Permissions' : 'More models'}
              data-testid={`picker-${sub}`} onMouseEnter={clearHover}>
              {flyout()}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
