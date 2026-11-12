import { useEffect, useState } from 'react'

// Small global toast stack: short confirmations and errors that go away on their own.

type Toast = { id: number; text: string; kind: 'info' | 'error' | 'ok' }
let next = 1
const listeners = new Set<(t: Toast[]) => void>()
let toasts: Toast[] = []

const set = (t: Toast[]): void => {
  toasts = t
  listeners.forEach((l) => l(toasts))
}

export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const t = { id: next++, text: text.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), kind }
  set([...toasts, t].slice(-4))
  setTimeout(() => set(toasts.filter((x) => x.id !== t.id)), kind === 'error' ? 7000 : 3500)
}

export function Toasts() {
  const [list, setList] = useState<Toast[]>(toasts)
  useEffect(() => {
    listeners.add(setList)
    return () => { listeners.delete(setList) }
  }, [])
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => set(toasts.filter((x) => x.id !== t.id))}>{t.text}</div>
      ))}
    </div>
  )
}
