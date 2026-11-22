import { useState, type ReactNode } from 'react'
import type { Space, Thread } from '@shared/types'
import { api } from '../api'
import { SpaceAvatar } from '../brand'
import * as I from '../icons'
import { ConnectedIcons } from './ConnectedIcons'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { duplicateBot, importBot, shareBot } from './BotShare'
import { Target, useGoalsNeedingYou } from './TasksView'
import { BrainIcon } from './BrainView'
import { openUsageGlance } from './UsagePage'
import { money, useSpend } from './SpendingLimit'
import { countLabel } from '@shared/read-state'
import { rowSubtitle } from '../lib/ux'
import { useDevMode } from '../lib/dev-mode'
import { UpdateButton } from './UpdateButton'
import { sidebarStatusText } from './FunctionBots'
import { useBotStatus } from '../lib/bot-status'

/** The profile menu's usage line: "Usage · $3.20 of $200 this month". */
const spendLabel = (b: ReturnType<typeof useSpend>): string => !b ? 'Usage' : b.mode === 'amount' ? `Usage · ${money(b.spent)} of ${money(b.cap)} this month` : `Usage · ${money(b.spent)} this month`

export type MainView = 'home' | 'projects' | 'files' | 'tasks' | 'brain'

const Star = ({ size = 10 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.8 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 16.8l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z" fill="currentColor" /></svg>
)

/**
 * The bots-first sidebar (design/bot-ui.md): Search and New bot up top, pinned bots as big
 * widgets, one row per bot with its last message, then Projects and Chats, hidden bots at the
 * very bottom, and you + Connect apps in the footer.
 */
export function Sidebar(p: {
  spaces: Space[]
  chats: Thread[]
  activeSpaceId: string | null
  activeThreadId: string | null
  view: MainView
  userName: string
  onOpenMain: () => void
  onOpenBot: (id: string) => void
  onOpenChat: (id: string) => void
  onNew: () => void
  onNewBot: () => void
  /** The empty list's "Make a bot": a New bot that sets itself up with you in its chat. */
  onSetupBot?: () => void
  onSearch: () => void
  onView: (v: MainView) => void
  onCustomize: (s: Space) => void
  onChanged: () => void
  onSettings: () => void
  onConnect: () => void
  onScheduled: () => void
  onNewProject: () => void
  pinned: string[] | null
  onPinned: (ids: string[]) => void
  modelLabel?: string
  /** Chats working right now, and the bots/projects they belong to. */
  runningThreads?: Set<string>
  runningSpaces?: Set<string>
  /** Chats (and their bots) waiting on you: an approval, a question or a plan to OK. */
  needThreads?: Set<string>
  needSpaces?: Set<string>
}) {
  const dev = useDevMode()
  const botStatus = useBotStatus()
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dragging, setDragging] = useState<{ kind: 'space' | 'chat'; id: string } | null>(null)
  const [over, setOver] = useState<string | null>(null)
  /** Goals waiting on you: a dot on the Tasks button. */
  const goalsNeedYou = useGoalsNeedingYou()
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('sb-sections') ?? '{}') as Record<string, boolean> } catch { return {} }
  })
  /** Sections start open, except Hidden bots. */
  const openIn = (o: Record<string, boolean>, k: string): boolean => (k === 'hidden' ? o[k] === true : o[k] !== false)
  const isOpen = (k: string): boolean => openIn(open, k)
  const toggle = (k: string): void => setOpen((o) => {
    const n = { ...o, [k]: !openIn(o, k) }
    try { localStorage.setItem('sb-sections', JSON.stringify(n)) } catch { /* private mode */ }
    return n
  })

  const main = p.spaces.find((s) => s.isMain)
  // Every saved pin (hidden bots keep theirs); only visible ones are shown.
  const allPinned = (p.pinned ?? (main ? [main.id] : [])).filter((id) => p.spaces.some((s) => s.id === id))
  const pinnedIds = allPinned.filter((id) => !p.spaces.find((s) => s.id === id)!.hidden)
  const pinnedSpaces = pinnedIds.map((id) => p.spaces.find((s) => s.id === id)!).filter(Boolean)
  const pinnedChats = p.chats.filter((t) => t.pinned)
  const bots = p.spaces.filter((s) => !s.hidden && s.kind !== 'project' && !pinnedIds.includes(s.id))
  const projects = p.spaces.filter((s) => s.kind === 'project' && !s.hidden && !pinnedIds.includes(s.id))
  const hidden = p.spaces.filter((s) => s.hidden && !s.isMain)
  const recents = p.chats.filter((t) => !t.pinned)
  const colorsOf = (g: Space): string[] => g.members.map((id) => p.spaces.find((s) => s.id === id)?.color).filter((c): c is string => !!c)

  /** Pin, or move onto `target`'s place (after it when dragging down, before it when dragging up). */
  const pinSpace = (id: string, target?: string): void => {
    const from = allPinned.indexOf(id)
    const rest = allPinned.filter((x) => x !== id)
    const t = target ? rest.indexOf(target) : -1
    rest.splice(t < 0 ? rest.length : from >= 0 && from <= t ? t + 1 : t, 0, id)
    p.onPinned(rest)
  }
  const unpinSpace = (id: string): void => p.onPinned(allPinned.filter((x) => x !== id))
  const pinChat = (id: string, on: boolean): void => void api.threads.update(id, { pinned: on }).then(p.onChanged)
  const openSpace = (s: Space): void => (s.isMain ? p.onOpenMain() : p.onOpenBot(s.id))
  const isActive = (s: Space): boolean => s.id === p.activeSpaceId && (!s.isMain || !p.activeThreadId) && p.view === 'home'

  const spaceMenu = (s: Space, e: React.MouseEvent): void => {
    e.preventDefault()
    const kind = s.kind === 'group' ? 'Group' : s.kind === 'project' ? 'Project' : 'Bot'
    setMenu({
      x: e.clientX, y: e.clientY,
      items: s.hidden ? [
        { label: 'Show in sidebar', icon: <I.Plus size={15} />, run: () => void api.spaces.update(s.id, { hidden: false }).then(p.onChanged) },
        { label: `Customize ${kind}…`, icon: <I.Gear size={15} />, run: () => p.onCustomize(s) },
        'sep',
        {
          label: 'Delete', icon: <I.Trash size={15} />, danger: true,
          run: () => { if (confirm(`Delete "${s.name}" and its conversation? This can't be undone.`)) void api.spaces.remove(s.id).then(p.onChanged) }
        }
      ] : [
        pinnedIds.includes(s.id)
          ? { label: 'Unpin', icon: <I.Pin size={15} />, run: () => unpinSpace(s.id) }
          : { label: 'Pin', icon: <I.Pin size={15} />, run: () => pinSpace(s.id) },
        { label: 'Mark as Unread', icon: <I.Sparkle size={15} />, run: () => void api.spaces.markUnread(s.id).then(p.onChanged) },
        'sep',
        { label: `Rename ${kind}`, icon: <I.Edit size={15} />, run: () => setRenaming(s.id) },
        { label: `Customize ${kind}…`, icon: <I.Gear size={15} />, run: () => p.onCustomize(s) },
        ...(s.kind === 'bot' ? [
          { label: 'Share as template…', icon: <I.Share size={15} />, run: () => void shareBot(s) },
          { label: 'Duplicate', icon: <I.Copy size={15} />, run: () => void duplicateBot(s) }
        ] as MenuItem[] : []),
        'sep',
        { label: 'Copy conversation ID', icon: <I.Copy size={15} />, run: () => void api.threads.list(s.id).then((ts) => navigator.clipboard.writeText(ts[0]?.id ?? s.id)) },
        ...(s.isMain ? [] : [
          'sep',
          { label: 'Hide from sidebar', icon: <I.Close size={15} />, run: () => void api.spaces.update(s.id, { hidden: true }).then(p.onChanged) },
          {
            label: 'Delete', icon: <I.Trash size={15} />, danger: true,
            run: () => { if (confirm(`Delete "${s.name}" and its conversation? This can't be undone.`)) void api.spaces.remove(s.id).then(p.onChanged) }
          }
        ] as MenuItem[])
      ]
    })
  }

  const chatMenu = (t: Thread, e: React.MouseEvent): void => {
    e.preventDefault()
    setMenu({
      x: e.clientX, y: e.clientY,
      items: [
        { label: t.pinned ? 'Unpin' : 'Pin', icon: <I.Pin size={15} />, run: () => pinChat(t.id, !t.pinned) },
        { label: 'Mark as Unread', icon: <I.Sparkle size={15} />, run: () => void api.threads.update(t.id, { unread: true }).then(p.onChanged) },
        { label: 'Rename', icon: <I.Edit size={15} />, run: () => setRenaming(t.id) },
        { label: 'Copy conversation ID', icon: <I.Copy size={15} />, run: () => void navigator.clipboard.writeText(t.id) },
        'sep',
        { label: 'Delete', icon: <I.Trash size={15} />, danger: true, run: () => { if (confirm(`Delete "${t.title}"?`)) void api.threads.remove(t.id).then(p.onChanged) } }
      ]
    })
  }

  const spend = useSpend()
  const meMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({
      x: e.type === 'contextmenu' ? e.clientX : r.left, y: e.type === 'contextmenu' ? e.clientY : r.top - 8,
      items: [
        { label: 'Settings', icon: <I.Gear size={15} />, run: p.onSettings },
        // This month's spend at a glance ("$X used of $Y this month"); opens the compact usage card.
        { label: spendLabel(spend), icon: <I.Clock size={15} />, run: openUsageGlance },
        'sep',
        { label: 'Projects', icon: <I.Folder size={15} />, run: () => p.onView('projects') },
        { label: 'Artifacts', icon: <I.Layers size={15} />, run: () => p.onView('files') },
        { label: 'Scheduled', icon: <I.Clock size={15} />, run: p.onScheduled },
        { label: 'Tasks', icon: <Target size={15} />, run: () => p.onView('tasks') },
        { label: 'Connect apps', icon: <I.Plug size={15} />, run: p.onConnect },
        'sep',
        { label: 'Import bot…', icon: <I.Users size={15} />, run: () => void importBot() }
      ]
    })
  }

  const renameInput = (id: string, value: string, save: (v: string) => Promise<unknown>) => (
    <input className="rename" autoFocus defaultValue={value}
      onBlur={(e) => { const v = e.target.value.trim(); setRenaming(null); if (v && v !== value) void save(v).then(p.onChanged) }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { e.preventDefault(); setRenaming(null) } }}
      data-testid={`rename-${id}`} />
  )

  const drag = (kind: 'space' | 'chat', id: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; setDragging({ kind, id }) },
    onDragEnd: () => { setDragging(null); setOver(null) }
  })

  /**
   * Needs you, working, or unread: one quiet mark on the right. Needs you (accent) wins: a run waiting on your
   * answer isn't working. Unread is blue; a bot with more than one unread reply shows the count instead of the dot.
   */
  const status = (working: boolean, needs: boolean, unread: boolean, count?: number): ReactNode =>
    needs ? <span className="need-dot" title="Needs you" role="img" aria-label="Needs you" data-testid="needs-you" />
      : working ? <span className="row-spin" title="Working" role="img" aria-label="Working" />
        : unread && countLabel(count) ? <span className="unread-count" title={`${countLabel(count)} unread`} role="img" aria-label={`${countLabel(count)} unread`} data-testid="unread-count">{countLabel(count)}</span>
          : unread ? <span className="unread-dot" title="Unread" role="img" aria-label="Unread" data-testid="unread-dot" /> : null
  /** A running chat or bot (not one waiting on you): its name gets a slow, quiet shimmer (CSS only; none with reduced motion). */
  const runName = (on: boolean, waiting = false): string => (on && !waiting ? ' run-name' : '')

  const avatar = (s: Space, size: number): ReactNode => s.kind === 'project'
    ? <span className="proj-tile" style={{ background: s.color, width: Math.round(size * 0.8), height: Math.round(size * 0.8), borderRadius: Math.round(size * 0.26) }}><I.Folder size={Math.round(size * 0.36)} /></span>
    : <SpaceAvatar color={s.color} shape={s.shape} size={size} group={s.kind === 'group' ? colorsOf(s) : undefined} />

  const testId = (s: Space): string => (s.isMain ? 'main-bot' : s.kind === 'project' ? 'project-item' : 'space-item')
  const needs = (s: Space): boolean => !!p.needSpaces?.has(s.id) && !isActive(s)
  const working = (s: Space): boolean => !!p.runningSpaces?.has(s.id)
  /** Bots (and groups) count their unread replies; projects and SahilBot itself (its chats are listed below) just get the dot. */
  const botCount = (s: Space): number | undefined => (s.kind === 'project' || s.isMain ? undefined : s.unreadCount)

  /** A pinned bot: a big avatar with its name under it. */
  const widget = (s: Space) => (
    <div key={s.id} className={`pin-widget${isActive(s) ? ' active' : ''}${over === `w:${s.id}` ? ' over' : ''}`}
      onContextMenu={(e) => spaceMenu(s, e)} {...drag('space', s.id)}
      onDragOver={(e) => { if (dragging?.kind === 'space' && dragging.id !== s.id) { e.preventDefault(); e.stopPropagation(); setOver(`w:${s.id}`) } }}
      onDrop={(e) => {
        // Only bots reorder here; a chat dropped on an avatar falls through to the pinned area (which pins it).
        if (dragging?.kind !== 'space') return
        e.preventDefault(); e.stopPropagation(); setOver(null)
        if (dragging.id !== s.id) pinSpace(dragging.id, s.id)
        setDragging(null)
      }}>
      {renaming === s.id ? (
        <>
          <span className="pw-avatar">{avatar(s, 26)}</span>
          {renameInput(s.id, s.name, (v) => api.spaces.update(s.id, { name: v }))}
        </>
      ) : (
        <button className="pw-btn" onClick={() => openSpace(s)} data-testid={testId(s)} title={s.lastPreview ? `${s.name}: ${s.lastPreview.slice(0, 120)}` : s.name}>
          <span className="pw-avatar">
            {avatar(s, pinnedSpaces.length === 1 ? 92 : 58)}
            {s.isMain && s.shape !== 'mascot' && <span className="pw-star"><Star /></span>}
            {(working(s) || needs(s) || (s.unread && !isActive(s))) && <span className="pw-status">{status(working(s), needs(s), !!s.unread && !isActive(s), botCount(s))}</span>}
          </span>
          <span className={`pw-name${runName(working(s), needs(s))}`}>{s.name}</span>
        </button>
      )}
    </div>
  )

  /** A bot (or group) in the list: avatar, name, its last message, status. */
  const botRow = (s: Space) => (
    <div key={s.id} className={`bot-row${isActive(s) ? ' active' : ''}`} onContextMenu={(e) => spaceMenu(s, e)} {...drag('space', s.id)}>
      {renaming === s.id ? (
        <div className="br-btn">
          <span className="br-avatar">{avatar(s, 28)}</span>
          {renameInput(s.id, s.name, (v) => api.spaces.update(s.id, { name: v }))}
        </div>
      ) : (
        <button className="br-btn" onClick={() => openSpace(s)} data-testid={testId(s)} title={s.lastPreview ? `${s.name}: ${s.lastPreview.replace(/\s+/g, ' ').slice(0, 160)}` : s.name}>
          <span className="br-avatar">{avatar(s, 28)}</span>
          <span className="br-text">
            <span className={`br-name${runName(working(s), needs(s))}`}>{s.name}</span>
            {(() => {
              // Working / Pulling context in place of the preview while it runs; nothing extra when Idle or Done.
              const st = s.isMain || needs(s) ? null : sidebarStatusText(botStatus[s.id], !!s.unread)
              return st ? <span className="br-preview br-status" data-testid={`sidebar-bot-status-${s.id}`}>{st}</span> : <span className="br-preview">{rowSubtitle(s)}</span>
            })()}
          </span>
          {status(working(s), needs(s), !!s.unread && !isActive(s), botCount(s))}
        </button>
      )}
    </div>
  )

  /** A compact row: projects and hidden bots. */
  const smallRow = (s: Space, id: string) => (
    <div key={s.id} className={`nav-row${isActive(s) ? ' active' : ''}`} onContextMenu={(e) => spaceMenu(s, e)} {...(s.hidden ? {} : drag('space', s.id))}>
      {renaming === s.id ? renameInput(s.id, s.name, (v) => api.spaces.update(s.id, { name: v })) : (
        <button className="nav-btn" onClick={() => openSpace(s)} data-testid={id} title={s.lastPreview ? `${s.name}: ${s.lastPreview.slice(0, 120)}` : s.name}>
          <span className="row-icon">{avatar(s, 22)}</span>
          <span className={`t${runName(working(s), needs(s))}`}>{s.name}</span>
          {status(working(s), needs(s), !!s.unread && !isActive(s), botCount(s))}
        </button>
      )}
    </div>
  )

  const chatRow = (t: Thread) => (
    <div key={t.id} className={`nav-row${t.id === p.activeThreadId ? ' active' : ''}`} onContextMenu={(e) => chatMenu(t, e)} {...drag('chat', t.id)}>
      {renaming === t.id ? renameInput(t.id, t.title, (v) => api.threads.update(t.id, { title: v })) : (
        <button className="nav-btn chat" onClick={() => p.onOpenChat(t.id)} data-testid="thread-item" title={t.title}>
          {t.pinned && <I.Pin size={13} className="row-pin" />}
          <span className={`t${runName(!!p.runningThreads?.has(t.id), !!p.needThreads?.has(t.id) && t.id !== p.activeThreadId)}`}>{t.title.replace(/^⏰ /, '')}</span>
          {t.title.startsWith('⏰') && <I.Clock size={14} className="row-tail" />}
          {status(!!p.runningThreads?.has(t.id), !!p.needThreads?.has(t.id) && t.id !== p.activeThreadId, t.unread && t.id !== p.activeThreadId)}
        </button>
      )}
    </div>
  )

  const section = (key: string, title: string, children: ReactNode, actions?: ReactNode) => (
    <div className="nav-section sb-section">
      <div className="nav-label">
        <button onClick={() => toggle(key)} aria-expanded={isOpen(key)}>{title}<I.Chevron size={12} style={{ transform: isOpen(key) ? undefined : 'rotate(-90deg)' }} /></button>
        {actions && <span className="nav-label-actions">{actions}</span>}
      </div>
      {isOpen(key) && children}
    </div>
  )

  const dropOnList = (e: React.DragEvent): void => {
    e.preventDefault(); setOver(null)
    if (dragging?.kind === 'space' && pinnedIds.includes(dragging.id)) unpinSpace(dragging.id)
    if (dragging?.kind === 'chat') pinChat(dragging.id, false)
    setDragging(null)
  }

  return (
    <aside className={`sidebar sb2${dragging ? ' is-dragging' : ''}`} onDragOver={(e) => { if (dragging) e.preventDefault() }}>
      <div className="sb-top drag">
        <button className="sb-circle" onClick={p.onSearch} title="Search bots, chats, commands and settings (⌘K)" aria-label="Search (⌘K)" data-testid="nav-search"><I.Search size={16} /></button>
      </div>
      {/* Claude-style: one clear way to start, then the few places you go, then your bots and chats. */}
      <nav className="sb-nav" aria-label="Main">
        <button className="sb-nav-item sb-new" onClick={p.onNew} title="New chat (⌘N)" data-testid="new-chat"><span className="sb-nav-icon new"><I.Plus size={15} /></span><span>New chat</span><kbd>⌘N</kbd></button>
        <button className={`sb-nav-item tk-nav${p.view === 'tasks' ? ' on' : ''}`} onClick={() => p.onView('tasks')}
          title="Questions and approvals waiting for you, and your bots' goals" aria-label={goalsNeedYou ? `Needs you: ${goalsNeedYou} waiting` : 'Needs you and tasks'} data-testid="nav-tasks">
          <span className="sb-nav-icon"><I.Inbox size={16} /></span><span>Needs you</span>
          {goalsNeedYou > 0 && <span className="tk-nav-count" aria-hidden="true" data-testid="nav-tasks-count">{goalsNeedYou > 9 ? '9+' : goalsNeedYou}</span>}
        </button>
        <button className="sb-nav-item" onClick={() => window.dispatchEvent(new CustomEvent('sahilbot:open-vault', { detail: { path: null } }))} title="Notes your bots keep: people, projects and decisions (opens in Obsidian too)" data-testid="nav-vault"><span className="sb-nav-icon"><I.Vault size={16} /></span><span>Notes</span></button>
        <button className={`sb-nav-item${p.view === 'files' ? ' on' : ''}`} onClick={() => p.onView('files')} title="Documents, decks, sheets and images your bots made" data-testid="nav-artifacts"><span className="sb-nav-icon" data-testid="nav-files"><I.Layers size={16} /></span><span>Artifacts</span></button>
        <button className={`sb-nav-item${p.view === 'brain' ? ' on' : ''}`} onClick={() => p.onView('brain')} title="What SahilBot knows from your connected accounts" data-testid="nav-brain"><span className="sb-nav-icon"><BrainIcon size={16} /></span><span>Brain</span></button>
      </nav>

      <div className="side-scroll">
        <div className={`pin-grid${over === 'pinned' ? ' drop' : ''}${dragging?.kind === 'space' || dragging?.kind === 'chat' ? ' dragging' : ''}${pinnedSpaces.length ? '' : ' empty'}${pinnedSpaces.length === 1 ? ' one' : ''}`} data-testid="pinned-top"
          onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver('pinned') } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null) }}
          onDrop={(e) => {
            e.preventDefault(); setOver(null)
            if (dragging?.kind === 'space') pinSpace(dragging.id)
            if (dragging?.kind === 'chat') pinChat(dragging.id, true)
            setDragging(null)
          }}>
          {pinnedSpaces.map(widget)}
          {!pinnedSpaces.length && dragging && <div className="pin-drop-hint">Drop here to pin</div>}
        </div>

        <div className="nav-label sb-bots-label">
          <span>Bots</span>
          <span className="nav-label-actions">{bots.length > 0 && <button className="nav-add" onClick={p.onNewBot} title="Add a bot" aria-label="Add a bot" data-testid="new-bot"><I.Plus size={14} /></button>}</span>
        </div>

        <div className={`sb-lists${over === 'list' ? ' drop' : ''}`} onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver('list') } }} onDrop={dropOnList}>
          <div className="bot-list">
            {bots.map(botRow)}
            {!bots.length && (
              <button className="bot-row ghost" onClick={p.onNewBot} data-testid="sidebar-make-bot">
                <span className="br-btn">
                  <span className="br-avatar ghost-avatar"><I.Plus size={18} /></span>
                  <span className="br-text"><span className="br-name">Add a bot</span></span>
                </span>
              </button>
            )}
          </div>

          {section('projects', 'Projects', (
            <>
              {projects.map((s) => smallRow(s, 'project-item'))}
            </>
          ), (
            <>
              <button className="nav-add" onClick={() => p.onView('projects')} title="All projects" aria-label="All projects" data-testid="nav-projects"><I.Folder size={14} /></button>
              <button className="nav-add" onClick={p.onNewProject} title="New project: a folder with its own instructions and chats" aria-label="New project" data-testid="new-project"><I.Plus size={14} /></button>
            </>
          ))}

          {section('recents', 'Recents', (
            <>
              {pinnedChats.map(chatRow)}
              {recents.map(chatRow)}
            </>
          ), (
            <>
              <button className="nav-add" onClick={p.onScheduled} title="Scheduled: routines and reminders" aria-label="Scheduled routines" data-testid="nav-scheduled"><I.Clock size={14} /></button>
            </>
          ))}

          {hidden.length > 0 && (
            <div className="sb-hidden">
              <button className="sb-hidden-toggle" onClick={() => toggle('hidden')} aria-expanded={isOpen('hidden')} data-testid="hidden-bots">
                <I.Chevron size={12} style={{ transform: isOpen('hidden') ? undefined : 'rotate(-90deg)' }} />
                Hidden bots ({hidden.length})
              </button>
              {isOpen('hidden') && hidden.map((s) => smallRow(s, 'hidden-item'))}
            </div>
          )}
        </div>
      </div>

      <UpdateButton busy={p.runningThreads?.size ?? 0} />
      <div className="sb-bottom">
        <button className="sb-me" onClick={p.onSettings} onContextMenu={meMenu} aria-label="Settings" title={`Settings (⌘,)${dev && p.modelLabel ? ` · ${p.modelLabel}` : ''}\nRight-click for scheduled, usage and more`} data-testid="profile"><I.Gear size={17} /></button>
        <button className="sb-connect" onClick={p.onConnect} data-testid="connect-apps">
          <ConnectedIcons max={3} />
          <I.Plug size={16} className="sb-plug" />
          <span>Connect apps</span>
        </button>
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </aside>
  )
}
