import { useEffect, useState } from 'react'
import type { Space, Thread } from '@shared/types'
import { api } from '../api'
import { SpaceAvatar } from '../brand'
import * as I from '../icons'
import { ContextMenu, type MenuItem } from './ContextMenu'

export function Sidebar(p: {
  spaces: Space[]
  chats: Thread[]
  activeSpaceId: string | null
  activeThreadId: string | null
  userName: string
  onOpenMain: () => void
  onOpenBot: (id: string) => void
  onOpenChat: (id: string) => void
  onNew: () => void
  onCustomize: (s: Space) => void
  onChanged: () => void
  onSettings: () => void
  onConnect: () => void
  onScheduled: () => void
  onNewProject: () => void
  /** Bots pinned to the top like widgets (null = just the main bot). */
  pinned: string[] | null
  onPinned: (ids: string[]) => void
}) {
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [results, setResults] = useState<Thread[] | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)

  useEffect(() => {
    if (!query.trim()) return setResults(null)
    const t = setTimeout(() => void api.threads.search(query.trim()).then(setResults), 150)
    return () => clearTimeout(t)
  }, [query])

  const main = p.spaces.find((s) => s.isMain)
  const pinnedIds = (p.pinned ?? (main ? [main.id] : [])).filter((id) => p.spaces.some((s) => s.id === id))
  const pinnedSpaces = pinnedIds.map((id) => p.spaces.find((s) => s.id === id)!).filter(Boolean)
  // Bots not pinned on top stay in the list (the main bot too, once it's taken off the top).
  const bots = p.spaces.filter((s) => !s.hidden && s.kind !== 'project' && !pinnedIds.includes(s.id))
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTop, setDropTop] = useState(false)
  const pin = (id: string, at?: number): void => {
    const rest = pinnedIds.filter((x) => x !== id)
    rest.splice(at ?? rest.length, 0, id)
    p.onPinned(rest)
  }
  const unpin = (id: string): void => p.onPinned(pinnedIds.filter((x) => x !== id))
  const open = (s: Space): void => (s.isMain ? p.onOpenMain() : p.onOpenBot(s.id))
  const projects = p.spaces.filter((s) => s.kind === 'project' && !s.hidden)
  const colorsOf = (g: Space): string[] => g.members.map((id) => p.spaces.find((s) => s.id === id)?.color).filter((c): c is string => !!c)
  const initials = (p.userName || 'You').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()

  const botMenu = (s: Space, e: React.MouseEvent): void => {
    e.preventDefault()
    const kind = s.kind === 'group' ? 'Group' : s.kind === 'project' ? 'Project' : 'Bot'
    setMenu({
      x: e.clientX, y: e.clientY,
      items: [
        pinnedIds.includes(s.id)
          ? { label: 'Remove from top', icon: <I.Close size={15} />, run: () => unpin(s.id) }
          : { label: 'Pin to top', icon: <I.Pin size={15} />, run: () => pin(s.id) },
        ...(s.isMain ? [] : [{ label: s.pinned ? 'Unpin in list' : 'Pin in list', icon: <I.Pin size={15} />, run: () => void api.spaces.update(s.id, { pinned: !s.pinned }).then(p.onChanged) }]),
        { label: 'Mark as Unread', icon: <I.Sparkle size={15} />, run: () => void api.spaces.markUnread(s.id).then(p.onChanged) },
        'sep',
        { label: `Rename ${kind}`, icon: <I.Edit size={15} />, run: () => setRenaming(s.id) },
        { label: `Customize ${kind}…`, icon: <I.Gear size={15} />, run: () => p.onCustomize(s) },
        'sep',
        { label: 'Copy conversation ID', icon: <I.Copy size={15} />, run: () => void api.threads.list(s.id).then((ts) => navigator.clipboard.writeText(ts[0]?.id ?? s.id)) },
        'sep',
        ...(s.isMain ? [] : [
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
        { label: t.pinned ? 'Unpin' : 'Pin', icon: <I.Pin size={15} />, run: () => void api.threads.update(t.id, { pinned: !t.pinned }).then(p.onChanged) },
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

  const pinnedChats = p.chats.filter((t) => t.pinned)
  const recentChats = p.chats.filter((t) => !t.pinned)
  const chatRow = (t: Thread) => (
    <div key={t.id} className={`thread-item${t.id === p.activeThreadId ? ' active' : ''}`} onContextMenu={(e) => chatMenu(t, e)}>
      {renaming === t.id ? renameInput(t.id, t.title, (v) => api.threads.update(t.id, { title: v })) : (
        <button className="thread-btn" onClick={() => p.onOpenChat(t.id)} data-testid="thread-item">
          <span className="t">{t.title}</span>
          {t.unread && t.id !== p.activeThreadId && <span className="unread-dot" />}
          {t.pinned && <I.Pin size={12} className="pin" />}
        </button>
      )}
    </div>
  )

  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <button className="circle-btn" title="Search (⌘K)" onClick={() => setSearchOpen((o) => !o)}><I.Search /></button>
        <button className="circle-btn" title="Start a chat (⌘N)" onClick={p.onNew} data-testid="new-thread"><I.Plus /></button>
      </div>
      {/* Pinned bots: drag bots here to pin them like widgets; drag them out (or right-click) to remove. */}
      <div className={`pinned-top n${Math.min(pinnedSpaces.length, 3)}${dropTop ? ' drop' : ''}${dragging && !pinnedSpaces.length ? ' empty' : ''}`} data-testid="pinned-top"
        onDragOver={(e) => { if (dragging) { e.preventDefault(); setDropTop(true) } }}
        onDragLeave={() => setDropTop(false)}
        onDrop={(e) => { e.preventDefault(); setDropTop(false); if (dragging) pin(dragging); setDragging(null) }}>
        {pinnedSpaces.length === 0 && !dragging && <div className="pin-empty">Drag a bot here to pin it</div>}
        {pinnedSpaces.map((s, i) => (
          <button key={s.id} className={`brand${p.activeSpaceId === s.id && (!s.isMain || !p.activeThreadId) ? ' on' : ''}`} onClick={() => open(s)} onContextMenu={(e) => botMenu(s, e)}
            draggable onDragStart={(e) => { e.dataTransfer.setData('text/plain', s.id); e.dataTransfer.effectAllowed = 'move'; setDragging(s.id) }} onDragEnd={() => setDragging(null)}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDropTop(false); if (dragging && dragging !== s.id) pin(dragging, i); setDragging(null) }}
            data-testid={s.isMain ? 'main-bot' : 'pinned-bot'} title={s.isMain ? 'SahilBot' : s.name}>
            <SpaceAvatar color={s.color} shape={s.shape} size={pinnedSpaces.length === 1 ? (s.shape === 'mascot' ? 92 : 84) : 52} group={s.kind === 'group' ? colorsOf(s) : undefined} />
            <div className="brand-name">{s.name}</div>
            {s.unread && s.id !== p.activeSpaceId && <span className="unread-dot" />}
          </button>
        ))}
        {dragging && !pinnedSpaces.some((x) => x.id === dragging) && <div className="pin-hint">Drop to pin here</div>}
      </div>
      <div style={{ padding: '0 10px 4px' }}>
        <button className="side-nav" onClick={p.onScheduled} data-testid="nav-scheduled"><I.Clock size={16} />Scheduled</button>
      </div>
      {searchOpen && (
        <div className="search-box">
          <I.Search size={15} />
          <input autoFocus placeholder="Search chats and bots" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (setQuery(''), setSearchOpen(false))} />
        </div>
      )}
      <div className="side-scroll"
        onDragOver={(e) => { if (dragging && pinnedIds.includes(dragging)) e.preventDefault() }}
        onDrop={(e) => { e.preventDefault(); if (dragging && pinnedIds.includes(dragging)) unpin(dragging); setDragging(null) }}>
        {results ? (
          <>
            <div className="side-label">Results</div>
            {results.length ? results.map((t) => (
              <button key={t.id} className="thread-item" onClick={() => {
                const s = p.spaces.find((x) => x.id === t.spaceId)
                if (s && !s.isMain) p.onOpenBot(s.id)
                else p.onOpenChat(t.id)
                setQuery('')
                setSearchOpen(false)
              }}><span className="t">{t.title}</span></button>
            )) : <div className="hint" style={{ padding: '4px 10px' }}>No matches</div>}
          </>
        ) : (
          <>
            {bots.map((s) => (
              <div key={s.id} className={`space-item${s.id === p.activeSpaceId ? ' active' : ''}`} onContextMenu={(e) => botMenu(s, e)}
                draggable onDragStart={(e) => { e.dataTransfer.setData('text/plain', s.id); e.dataTransfer.effectAllowed = 'move'; setDragging(s.id) }} onDragEnd={() => setDragging(null)}>
                <button className="space-btn" onClick={() => open(s)} data-testid="space-item">
                  <SpaceAvatar color={s.color} shape={s.shape} group={s.kind === 'group' ? colorsOf(s) : undefined} />
                  <div className="space-text">
                    {renaming === s.id ? renameInput(s.id, s.name, (v) => api.spaces.update(s.id, { name: v })) : (
                      <div className="space-name">{s.name}{s.pinned && <I.Pin size={12} className="pin" />}</div>
                    )}
                    <div className="space-preview">{s.isMain ? 'Your main assistant' : s.lastPreview ?? (s.kind === 'group' ? `${s.members.length} bots` : 'Say hi')}</div>
                  </div>
                  {s.unread && s.id !== p.activeSpaceId && <span className="unread-dot" />}
                </button>
              </div>
            ))}
            <div className="side-label">Projects <button onClick={p.onNewProject} title="New project" data-testid="new-project">+</button></div>
            {projects.map((s) => (
              <div key={s.id} onContextMenu={(e) => botMenu(s, e)}>
                {renaming === s.id ? renameInput(s.id, s.name, (v) => api.spaces.update(s.id, { name: v })) : (
                  <button className={`project-row${s.id === p.activeSpaceId ? ' active' : ''}`} onClick={() => p.onOpenBot(s.id)} data-testid="project-item">
                    <span className="sq" style={{ background: s.color }}><I.Folder size={13} /></span>
                    <span className="t" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                    {s.unread && <span className="unread-dot" />}
                  </button>
                )}
              </div>
            ))}
            {projects.length === 0 && <div className="hint" style={{ padding: '0 10px 4px' }}>A folder + instructions + chats.</div>}
            {(pinnedChats.length > 0 || recentChats.length > 0) && <div className="side-label">Chats</div>}
            {pinnedChats.map(chatRow)}
            {recentChats.map(chatRow)}
          </>
        )}
      </div>
      <div className="sidebar-bottom">
        <button className="profile" onClick={p.onSettings} title="Settings (⌘,)">{initials}</button>
        <button className="connect" onClick={p.onConnect} data-testid="connect-apps">
          Connect apps
          <span className="connect-dots"><i style={{ background: '#EA4335' }} /><i style={{ background: '#4285F4' }} /><i style={{ background: '#FF642D' }} /></span>
        </button>
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
    </aside>
  )
}
