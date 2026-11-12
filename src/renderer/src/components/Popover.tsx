import { useEffect, useRef, useState, type ReactNode } from 'react'

/** A button that toggles a menu and closes it on outside click or Escape. */
export function Popover({ label, className, menuClass, children, title, testId }: {
  label: ReactNode
  className?: string
  menuClass?: string
  title?: string
  testId?: string
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className={`pick ${className ?? ''}`} ref={ref}>
      <button onClick={() => setOpen((o) => !o)} title={title} data-testid={testId}>{label}</button>
      {open && <div className={`menu ${menuClass ?? ''}`}>{children(() => setOpen(false))}</div>}
    </div>
  )
}
