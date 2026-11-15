import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import * as I from '../icons'

// Shared UI primitives (styles in styles-system.css). Older screens get the same look from grouped selectors
// there; new and reworked UI uses these directly:
//   Card / CardHead      a card in the chat or a panel (one radius, one hairline, no shadow)
//   Pill                 a small status badge (neutral, ok, accent, danger, warn)
//   SetSection / SetRow  a Settings group and its rows; long row descriptions clamp to two lines
//   ClampText            two lines with a "More" link (only when the text really is longer)
//   Disclosure           rarely used options behind one quiet "Advanced" row
//   Segmented            a 2–7 option switcher (radio semantics)

export function Card({ className, children, testId, live, ...rest }: { className?: string; children: ReactNode; testId?: string; live?: boolean } & Record<`data-${string}`, string | undefined>) {
  return <div className={`ui-card${live ? ' live' : ''}${className ? ` ${className}` : ''}`} data-testid={testId} {...rest}>{children}</div>
}

/** A card's header: icon · title · quiet meta · status on the right · chevron (when it collapses). */
export function CardHead({ icon, title, meta, status, open, onToggle }: { icon?: ReactNode; title: ReactNode; meta?: ReactNode; status?: ReactNode; open?: boolean; onToggle?: () => void }) {
  const inner = (
    <>
      {icon}
      <span className="ui-card-title">{title}</span>
      {meta && <span className="ui-card-meta">{meta}</span>}
      {status !== undefined && <span className="ui-card-status">{status}</span>}
      {onToggle && <I.Chevron size={13} style={{ transform: open ? 'rotate(180deg)' : undefined, flex: 'none', marginLeft: status === undefined ? 'auto' : undefined }} />}
    </>
  )
  return onToggle
    ? <button type="button" className="ui-card-head" onClick={onToggle} aria-expanded={open}>{inner}</button>
    : <div className="ui-card-head">{inner}</div>
}

export function Pill({ tone, children, title, testId }: { tone?: 'ok' | 'accent' | 'danger' | 'warn'; children: ReactNode; title?: string; testId?: string }) {
  return <span className={`ui-pill${tone ? ` ${tone}` : ''}`} title={title} data-testid={testId}>{children}</span>
}

/** Text clamped to two lines, with More / Less when (and only when) it overflows. */
export function ClampText({ children, className = 'set-row-sub' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [over, setOver] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || open) return
    const check = (): void => setOver(el.scrollHeight > el.clientHeight + 1)
    check()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, children])
  return (
    <div className={className}>
      <div ref={ref} className={`ui-clamp${open ? ' open' : ''}`}>{children}</div>
      {(over || open) && <button type="button" className="ui-more" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'Less' : 'More'}</button>}
    </div>
  )
}

/** A Settings group: a short label, an optional one-line description, then one card of rows. */
export function SetSection({ title, sub, children, testId, className }: { title?: ReactNode; sub?: ReactNode; children: ReactNode; testId?: string; className?: string }) {
  return (
    <section className={`set-section${className ? ` ${className}` : ''}`} data-testid={testId}>
      {title && <div className="set-label">{title}</div>}
      {sub && <div className="set-sub">{sub}</div>}
      <div className="set-card">{children}</div>
    </section>
  )
}

/** One Settings row: title (+ badge), a description clamped to two lines, the control on the right. */
export function SetRow({ title, sub, children, testId, badge }: { title: ReactNode; sub?: ReactNode; children?: ReactNode; testId?: string; badge?: ReactNode }) {
  return (
    <div className="set-row" data-testid={testId}>
      <div className="set-row-text">
        <div className="set-row-title">{title}{badge}</div>
        {sub && <ClampText>{sub}</ClampText>}
      </div>
      {children && <div className="set-row-ctl">{children}</div>}
    </div>
  )
}

/** Rarely used options behind one quiet row. Closed by default; the browser keeps it keyboard-accessible. */
export function Disclosure({ title, sub, children, defaultOpen, testId, className }: { title: ReactNode; sub?: ReactNode; children: ReactNode; defaultOpen?: boolean; testId?: string; className?: string }) {
  return (
    <details className={`ui-disclosure${className ? ` ${className}` : ''}`} open={defaultOpen} data-testid={testId}>
      <summary>
        <I.Chevron size={13} className="ui-disclosure-chev" />
        <span>{title}</span>
        {sub && <span className="ui-disclosure-sub">{sub}</span>}
      </summary>
      <div className="ui-disclosure-body">{children}</div>
    </details>
  )
}

/** A segmented control (radio semantics). */
export function Segmented<T extends string>({ value, options, onChange, label, testIdPrefix, className }: {
  value: T; options: Array<{ id: T; label: ReactNode; title?: string }>; onChange: (v: T) => void; label: string; testIdPrefix?: string; className?: string
}) {
  return (
    <div className={`ui-seg${className ? ` ${className}` : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={o.id === value} className={o.id === value ? 'on' : ''} title={o.title}
          onClick={() => onChange(o.id)} data-testid={testIdPrefix ? `${testIdPrefix}-${o.id}` : undefined}>{o.label}</button>
      ))}
    </div>
  )
}
