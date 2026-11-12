import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

export type MenuItem = 'sep' | { label: string; icon?: ReactNode; danger?: boolean; run: () => void }

/** Right-click menu at the pointer, kept inside the window. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) })
  }, [x, y])
  useEffect(() => {
    const down = (e: MouseEvent): void => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [onClose])
  return (
    <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu">
      {items.map((it, i) => it === 'sep' ? <div key={i} className="menu-sep" /> : (
        <button key={i} className={`menu-item${it.danger ? ' danger' : ''}`} onClick={() => { onClose(); it.run() }} role="menuitem">
          {it.icon}{it.label}
        </button>
      ))}
    </div>
  )
}
