import { useEffect, useMemo, useState } from 'react'
import type { Space } from '@shared/types'
import { Mascot, SpaceAvatar } from '../brand'
import * as I from '../icons'

export type PaletteAction = { kind: 'new-chat' } | { kind: 'new-bot' } | { kind: 'new-group' } | { kind: 'new-project' } | { kind: 'scheduled' } | { kind: 'open'; id: string }

/** "To: Start a chat with…" — create a bot or group, or jump to any bot with ⌘1…⌘9. */
export function CommandPalette({ spaces, onPick, onClose }: { spaces: Space[]; onPick: (a: PaletteAction) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const items = useMemo(() => {
    const base: Array<{ a: PaletteAction; label: string; icon: React.ReactNode }> = [
      { a: { kind: 'new-bot' }, label: 'Create new Bot', icon: <span className="pal-icon"><I.Plus size={16} /></span> },
      { a: { kind: 'new-group' }, label: 'Create group chat', icon: <span className="pal-icon"><I.Users size={16} /></span> },
      { a: { kind: 'new-project' }, label: 'New project', icon: <span className="pal-icon"><I.Folder size={15} /></span> },
      { a: { kind: 'new-chat' }, label: 'New chat', icon: <span className="pal-icon"><I.Edit size={15} /></span> },
      { a: { kind: 'scheduled' }, label: 'Scheduled tasks', icon: <span className="pal-icon"><I.Clock size={15} /></span> }
    ]
    const bots = [...spaces].sort((a, b) => Number(b.isMain) - Number(a.isMain)).map((s) => ({
      a: { kind: 'open', id: s.id } as PaletteAction,
      label: s.name + (s.hidden ? ' (hidden)' : ''),
      icon: s.isMain ? <Mascot size={26} /> : s.kind === 'project' ? <span className="pal-icon" style={{ background: s.color, color: 'white' }}><I.Folder size={15} /></span> : <SpaceAvatar color={s.color} shape={s.shape} size={28} group={s.kind === 'group' ? s.members.map((id) => spaces.find((x) => x.id === id)?.color ?? '#999') : undefined} />
    }))
    const all = [...base, ...bots]
    const t = q.trim().toLowerCase()
    return t ? all.filter((x) => x.label.toLowerCase().includes(t)) : all
  }, [spaces, q])

  useEffect(() => setSel(0), [q])
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
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
        <span>To:</span>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Start a chat with…" data-testid="palette-input" />
        <button className="icon-btn" onClick={onClose}><I.Close size={16} /></button>
      </div>
      <div className="palette" data-testid="palette">
        {items.map((it, i) => (
          <button key={i} className={`pal-item${i === sel ? ' on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => onPick(it.a)}>
            {it.icon}
            <span className="pal-label">{it.label}</span>
            {i < 9 && <span className="kbd"><kbd>⌘</kbd><kbd>{i + 1}</kbd></span>}
          </button>
        ))}
      </div>
    </div>
  )
}
