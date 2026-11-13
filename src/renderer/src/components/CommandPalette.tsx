import { useEffect, useMemo, useState } from 'react'
import type { Space, Thread } from '@shared/types'
import { Mascot, SpaceAvatar } from '../brand'
import * as I from '../icons'

export type PaletteAction =
  | { kind: 'new-chat' } | { kind: 'new-bot' } | { kind: 'new-group' } | { kind: 'new-project' }
  | { kind: 'scheduled' } | { kind: 'projects' } | { kind: 'files' } | { kind: 'connect' } | { kind: 'settings' }
  | { kind: 'open'; id: string } | { kind: 'chat'; id: string }

type Item = { a: PaletteAction; label: string; sub?: string; icon: React.ReactNode; group: string }

/** ⌘K: jump to any bot or chat, or run a command (new bot, Projects, Files, Scheduled…). ⌘1…⌘9 picks. */
export function CommandPalette({ spaces, chats = [], onPick, onClose }: { spaces: Space[]; chats?: Thread[]; onPick: (a: PaletteAction) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const items = useMemo(() => {
    const ico = (n: React.ReactNode): React.ReactNode => <span className="pal-icon">{n}</span>
    const commands: Item[] = [
      { a: { kind: 'new-bot' }, label: 'Create new Bot', icon: ico(<I.Plus size={16} />), group: 'Start' },
      { a: { kind: 'new-chat' }, label: 'New chat', icon: ico(<I.Edit size={15} />), group: 'Start' },
      { a: { kind: 'new-group' }, label: 'Create group chat', icon: ico(<I.Users size={16} />), group: 'Start' },
      { a: { kind: 'new-project' }, label: 'New project', icon: ico(<I.Folder size={15} />), group: 'Start' },
      { a: { kind: 'projects' }, label: 'Projects', sub: 'All your projects', icon: ico(<I.Folder size={15} />), group: 'Go to' },
      { a: { kind: 'files' }, label: 'Files', sub: 'Everything your bots made', icon: ico(<I.File size={15} />), group: 'Go to' },
      { a: { kind: 'scheduled' }, label: 'Scheduled', sub: 'Routines and scheduled tasks', icon: ico(<I.Clock size={15} />), group: 'Go to' },
      { a: { kind: 'connect' }, label: 'Connect apps', icon: ico(<I.Plug size={15} />), group: 'Go to' },
      { a: { kind: 'settings' }, label: 'Settings', icon: ico(<I.Gear size={15} />), group: 'Go to' }
    ]
    const bots: Item[] = [...spaces].sort((a, b) => Number(b.isMain) - Number(a.isMain)).map((s) => ({
      a: { kind: 'open', id: s.id } as PaletteAction,
      label: s.name + (s.hidden ? ' (hidden)' : ''),
      sub: s.lastPreview?.replace(/\s+/g, ' ').slice(0, 90),
      group: s.kind === 'project' ? 'Projects' : 'Bots',
      icon: s.isMain ? <Mascot size={28} /> : s.kind === 'project' ? <span className="pal-icon" style={{ background: s.color, color: 'white' }}><I.Folder size={15} /></span> : <SpaceAvatar color={s.color} shape={s.shape} size={28} group={s.kind === 'group' ? s.members.map((id) => spaces.find((x) => x.id === id)?.color ?? '#999') : undefined} />
    }))
    const recent: Item[] = chats.slice(0, 30).map((t) => ({ a: { kind: 'chat', id: t.id }, label: t.title.replace(/^⏰ /, ''), icon: ico(<I.Reply size={14} style={{ transform: 'scaleX(-1)' }} />), group: 'Chats' }))
    const t = q.trim().toLowerCase()
    // Without a query: start something, your bots, places to go, projects, then a few recent chats.
    if (!t) return [...commands.filter((c) => c.group === 'Start'), ...bots.filter((b) => b.group === 'Bots'), ...commands.filter((c) => c.group === 'Go to'), ...bots.filter((b) => b.group === 'Projects'), ...recent.slice(0, 5)]
    return [...bots, ...commands, ...recent].filter((x) => x.label.toLowerCase().includes(t) || (x.group !== 'Chats' && x.sub?.toLowerCase().includes(t)))
  }, [spaces, chats, q])

  useEffect(() => setSel(0), [q])
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { if (!e.defaultPrevented) { e.preventDefault(); onClose() } }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)) }
      else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); onPick(items[sel].a) }
      else if (e.metaKey && /^[1-9]$/.test(e.key)) {
        const it = items[Number(e.key) - 1]
        if (it) { e.preventDefault(); onPick(it.a) }
      }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [items, sel, onPick, onClose])

  return (
    <div className="palette-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette-to">
        <I.Search size={16} />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search bots, chats and commands" aria-label="Search bots, chats and commands" data-testid="palette-input" />
        <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)"><I.Close size={16} /></button>
      </div>
      <div className="palette" data-testid="palette">
        {items.map((it, i) => (
          <div key={i} className="pal-entry">
            {(i === 0 || items[i - 1].group !== it.group) && <div className="pal-group">{it.group}</div>}
            <button className={`pal-item${i === sel ? ' on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => onPick(it.a)}>
              {it.icon}
              <span className="pal-label">{it.label}{it.sub && <span className="pal-sub">{it.sub}</span>}</span>
              {i < 9 && <span className="kbd"><kbd>⌘</kbd><kbd>{i + 1}</kbd></span>}
            </button>
          </div>
        ))}
        {!items.length && <div className="pal-empty">Nothing matches “{q}”</div>}
      </div>
    </div>
  )
}
