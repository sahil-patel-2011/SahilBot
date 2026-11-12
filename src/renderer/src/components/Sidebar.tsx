import { useState, type ReactNode } from 'react'
import type { Space, Thread } from '@shared/types'
import { api } from '../api'
import { SpaceAvatar } from '../brand'
import * as I from '../icons'
import { ContextMenu, type MenuItem } from './ContextMenu'

export type MainView = 'home' | 'projects' | 'files'

/**
 * The sidebar: actions at the top (New chat, Search, Projects, Files, Scheduled, Connect apps), then
 * Pinned (drag bots, projects or chats here), Bots, Projects and Recents, with you at the bottom.
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
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dragging, setDragging] = useState<{ kind: 'space' | 'chat'; id: string } | null>(null)
  const [over, setOver] = useState<'pinned' | 'list' | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('sb-sections') ?? '{}') as Record<string, boolean> } catch { return {} }
  })
  const toggle = (k: string): void => setOpen((o) => {
    const n = { ...o, [k]: o[k] === false }
    try { localStorage.setItem('sb-sections', JSON.stringify(n)) } catch { /* private mode */ }
    return n
  })
  const isOpen = (k: string): boolean => open[k] !== false

  const main = p.spaces.find((s) => s.isMain)
  const pinnedIds = (p.pinned ?? (main ? [main.id] : [])).filter((id) => p.spaces.some((s) => s.id === id && !s.hidden))
  const pinnedSpaces = pinnedIds.map((id) => p.spaces.find((s) => s.id === id)!).filter(Boolean)
  const pinnedChats = p.chats.filter((t) => t.pinned)
  const bots = p.spaces.filter((s) => !s.hidden && s.kind !== 'project' && !pinnedIds.includes(s.id))
  const projects = p.spaces.filter((s) => s.kind === 'project' && !s.hidden && !pinnedIds.includes(s.id))
  const recents = p.chats.filter((t) => !t.pinned)
  const colorsOf = (g: Space): string[] => g.members.map((id) => p.spaces.find((s) => s.id === id)?.color).filter((c): c is string => !!c)
  const initials = (p.userName || 'You').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()

  const pinSpace = (id: string, at?: number): void => {
    const rest = pinnedIds.filter((x) => x !== id)
    rest.splice(at ?? rest.length, 0, id)
    p.onPinned(rest)
  }
  const unpinSpace = (id: string): void => p.onPinned(pinnedIds.filter((x) => x !== id))
  const pinChat = (id: string, on: boolean): void => void api.threads.update(id, { pinned: on }).then(p.onChanged)
  const openSpace = (s: Space): void => (s.isMain ? p.onOpenMain() : p.onOpenBot(s.id))

  const spaceMenu = (s: Space, e: React.MouseEvent): void => {
    e.preventDefault()
    const kind = s.kind === 'group' ? 'Group' : s.kind === 'project' ? 'Project' : 'Bot'
    setMenu({
      x: e.clientX, y: e.clientY,
      items: [
        pinnedIds.includes(s.id)
          ? { label: 'Unpin', icon: <I.Pin size={15} />, run: () => unpinSpace(s.id) }
          : { label: 'Pin', icon: <I.Pin size={15} />, run: () => pinSpace(s.id) },
        { label: 'Mark as Unread', icon: <I.Sparkle size={15} />, run: () => void api.spaces.markUnread(s.id).then(p.onChanged) },
        'sep',
        { label: `Rename ${kind}`, icon: <I.Edit size={15} />, run: () => setRenaming(s.id) },
        { label: `Customize ${kind}…`, icon: <I.Gear size={15} />, run: () => p.onCustomize(s) },
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

  const renameInput = (id: string, value: string, save: (v: string) => Promise<unknown>) => (
    <input className="rename" autoFocus defaultValue={value}
      onBlur={(e) => { const v = e.target.value.trim(); setRenaming(null); if (v && v !== value) void save(v).then(p.onChanged) }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null) }}
      data-testid={`rename-${id}`} />
  )

  const drag = (kind: 'space' | 'chat', id: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'move'; setDragging({ kind, id }) },
    onDragEnd: () => { setDragging(null); setOver(null) }
  })

  const spaceRow = (s: Space, pinnedRow: boolean, i = 0) => (
    <div key={s.id} className={`nav-row${s.id === p.activeSpaceId && (!s.isMain || !p.activeThreadId) && p.view === 'home' ? ' active' : ''}`} onContextMenu={(e) => spaceMenu(s, e)} {...drag('space', s.id)}
      onDrop={pinnedRow ? (e) => { e.preventDefault(); e.stopPropagation(); setOver(null); if (dragging?.kind === 'space' && dragging.id !== s.id) pinSpace(dragging.id, i); setDragging(null) } : undefined}>
      {renaming === s.id ? renameInput(s.id, s.name, (v) => api.spaces.update(s.id, { name: v })) : (
        <button className="nav-btn" onClick={() => openSpace(s)} data-testid={s.isMain ? 'main-bot' : s.kind === 'project' ? 'project-item' : 'space-item'} title={s.lastPreview ?? s.name}>
          {s.kind === 'project'
            ? <span className="row-icon proj" style={{ background: s.color }}><I.Folder size={12} /></span>
            : <span className="row-icon"><SpaceAvatar color={s.color} shape={s.shape} size={22} group={s.kind === 'group' ? colorsOf(s) : undefined} /></span>}
          <span className="t">{s.name}</span>
          {s.unread && s.id !== p.activeSpaceId && <span className="unread-dot" />}
        </button>
      )}
    </div>
  )

  const chatRow = (t: Thread) => (
    <div key={t.id} className={`nav-row${t.id === p.activeThreadId ? ' active' : ''}`} onContextMenu={(e) => chatMenu(t, e)} {...drag('chat', t.id)}>
      {renaming === t.id ? renameInput(t.id, t.title, (v) => api.threads.update(t.id, { title: v })) : (
        <button className="nav-btn chat" onClick={() => p.onOpenChat(t.id)} data-testid="thread-item" title={t.title}>
          <span className="t">{t.title.replace(/^⏰ /, '')}</span>
          {t.title.startsWith('⏰') && <I.Clock size={14} className="row-tail" />}
          {t.unread && t.id !== p.activeThreadId && <span className="unread-dot" />}
        </button>
      )}
    </div>
  )

  const section = (key: string, title: string, children: ReactNode, action?: ReactNode) => (
    <div className="nav-section">
      <div className="nav-label">
        <button onClick={() => toggle(key)} aria-expanded={isOpen(key)}>{title}<I.Chevron size={12} style={{ transform: isOpen(key) ? undefined : 'rotate(-90deg)' }} /></button>
        {action}
      </div>
      {isOpen(key) && children}
    </div>
  )

  return (
    <aside className="sidebar" onDragOver={(e) => { if (dragging) e.preventDefault() }}>
      <div className="sidebar-top drag" />
      <div className="nav-actions">
        <button className="nav-new" onClick={p.onNew} data-testid="new-chat"><I.Plus size={17} /><span>New chat</span><kbd>⌘N</kbd></button>
        <button className="nav-item" onClick={p.onSearch} data-testid="nav-search"><I.Search size={17} /><span>Search</span><kbd>⌘K</kbd></button>
        <button className={`nav-item${p.view === 'projects' ? ' on' : ''}`} onClick={() => p.onView('projects')} data-testid="nav-projects"><I.Folder size={17} /><span>Projects</span></button>
        <button className={`nav-item${p.view === 'files' ? ' on' : ''}`} onClick={() => p.onView('files')} data-testid="nav-files"><I.File size={17} /><span>Files</span></button>
        <button className="nav-item" onClick={p.onScheduled} data-testid="nav-scheduled"><I.Clock size={17} /><span>Scheduled</span></button>
        <button className="nav-item" onClick={p.onConnect} data-testid="connect-apps"><I.Plug size={17} /><span>Connect apps</span></button>
      </div>

      <div className="side-scroll">
        <div className={`nav-pinned${over === 'pinned' ? ' drop' : ''}`} data-testid="pinned-top"
          onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver('pinned') } }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            e.preventDefault(); setOver(null)
            if (dragging?.kind === 'space') pinSpace(dragging.id)
            if (dragging?.kind === 'chat') pinChat(dragging.id, true)
            setDragging(null)
          }}>
          {section('pinned', 'Pinned', (
            <>
              {pinnedSpaces.map((s, i) => spaceRow(s, true, i))}
              {pinnedChats.map(chatRow)}
              {!pinnedSpaces.length && !pinnedChats.length && <div className="nav-empty">Drag bots, projects or chats here</div>}
            </>
          ))}
        </div>
        <div onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver('list') } }}
          onDrop={(e) => {
            e.preventDefault(); setOver(null)
            if (dragging?.kind === 'space' && pinnedIds.includes(dragging.id)) unpinSpace(dragging.id)
            if (dragging?.kind === 'chat') pinChat(dragging.id, false)
            setDragging(null)
          }}>
          {section('bots', 'Bots', (
            <>
              {bots.map((s) => spaceRow(s, false))}
              {!bots.length && <div className="nav-empty">Bots you make show up here</div>}
            </>
          ), <button className="nav-add" onClick={p.onNewBot} title="New bot" data-testid="new-bot"><I.Plus size={14} /></button>)}
          {section('projects', 'Projects', (
            <>
              {projects.map((s) => spaceRow(s, false))}
              {!projects.length && <div className="nav-empty">A folder, instructions and chats</div>}
            </>
          ), <button className="nav-add" onClick={p.onNewProject} title="New project" data-testid="new-project"><I.Plus size={14} /></button>)}
          {section('recents', 'Recents', (
            <>
              {recents.map(chatRow)}
              {!recents.length && <div className="nav-empty">Your chats show up here</div>}
            </>
          ))}
        </div>
      </div>

      <div className="sidebar-bottom">
        <button className="me" onClick={p.onSettings} title="Settings (⌘,)" data-testid="profile">
          <span className="me-avatar">{initials}</span>
          <span className="me-text"><b>{p.userName || 'You'}</b>{p.modelLabel && <span>{p.modelLabel}</span>}</span>
        </button>
        <button className="icon-btn" onClick={p.onSettings} title="Settings (⌘,)"><I.Gear size={17} /></button>
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </aside>
  )
}
