import { useEffect, useState } from 'react'

// Small global toast stack: short confirmations and errors that go away on their own.
// The same message fired again while it's still up refreshes it (with a ×2 count) instead of stacking a
// copy; at most three show at once (the oldest goes first); an error can carry a next step (an action).

export type ToastAction = { label: string; run: () => void }
type Toast = { id: number; text: string; kind: 'info' | 'error' | 'ok'; count: number; action?: ToastAction }
let next = 1
const listeners = new Set<(t: Toast[]) => void>()
let toasts: Toast[] = []
const timers = new Map<number, ReturnType<typeof setTimeout>>()
const MAX = 3

const set = (t: Toast[]): void => {
  toasts = t
  listeners.forEach((l) => l(toasts))
}

const dismiss = (id: number): void => {
  clearTimeout(timers.get(id))
  timers.delete(id)
  set(toasts.filter((x) => x.id !== id))
}

const arm = (t: Toast): void => {
  clearTimeout(timers.get(t.id))
  // Errors (and anything with a next step) stay long enough to read and act on.
  timers.set(t.id, setTimeout(() => dismiss(t.id), t.kind === 'error' || t.action ? 7000 : 3500))
}

export function toast(text: string, kind: Toast['kind'] = 'info', opts: { action?: ToastAction } = {}): void {
  const clean = text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  const dupe = toasts.find((x) => x.text === clean && x.kind === kind)
  if (dupe) {
    const bumped = { ...dupe, count: dupe.count + 1, action: opts.action ?? dupe.action }
    set(toasts.map((x) => (x.id === dupe.id ? bumped : x)))
    arm(bumped)
    return
  }
  const t: Toast = { id: next++, text: clean, kind, count: 1, action: opts.action }
  const all = [...toasts, t]
  for (const old of all.slice(0, Math.max(0, all.length - MAX))) { clearTimeout(timers.get(old.id)); timers.delete(old.id) }
  set(all.slice(-MAX))
  arm(t)
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
        <div key={t.id} className={`toast ${t.kind}${t.action ? ' has-action' : ''}`} role={t.kind === 'error' ? 'alert' : 'status'}
          onClick={() => dismiss(t.id)} title="Dismiss" data-testid="toast">
          <span className="toast-text">{t.text}</span>
          {t.count > 1 && <span className="toast-count" aria-label={`${t.count} times`}>×{t.count}</span>}
          {t.action && (
            <button className="toast-action" onClick={(e) => { e.stopPropagation(); dismiss(t.id); t.action!.run() }} data-testid="toast-action">{t.action.label}</button>
          )}
        </div>
      ))}
    </div>
  )
}
