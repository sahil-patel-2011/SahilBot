import { useEffect, useRef, useState } from 'react'
import * as I from '../icons'

/**
 * ⌘F: find in this chat. Matches are highlighted with the CSS Custom Highlight API (no DOM changes, so React's
 * tree is untouched); Enter goes to the next one, ⇧Enter the previous, Esc closes.
 */
type HL = { set(name: string, h: unknown): void; delete(name: string): void }
const highlights = (): HL | undefined => (globalThis as unknown as { CSS?: { highlights?: HL } }).CSS?.highlights
const Highlight = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight

export function findRanges(root: Element, query: string): Range[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: Range[] = []
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => ((n.parentElement?.closest('button, svg, .stamp, [aria-hidden="true"]')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  })
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = (n.nodeValue ?? '').toLowerCase()
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
      const r = document.createRange()
      r.setStart(n, i)
      r.setEnd(n, i + q.length)
      out.push(r)
    }
  }
  return out
}

export function FindBar({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const [ranges, setRanges] = useState<Range[]>([])
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => { input.current?.focus() }, [])
  // Re-find when the query changes, and as new messages arrive.
  useEffect(() => {
    const root = document.querySelector('[data-testid="thread"]')
    if (!root) return
    const run = (): void => { const r = findRanges(root, q); setRanges(r); setAt((a) => (r.length ? Math.min(a, r.length - 1) : 0)) }
    run()
    const mo = new MutationObserver(() => run())
    mo.observe(root, { childList: true, subtree: true, characterData: true })
    return () => mo.disconnect()
  }, [q])
  useEffect(() => { setAt(0) }, [q])
  // Paint: all matches, and the current one stronger; scroll it into view.
  useEffect(() => {
    const hl = highlights()
    if (!hl || !Highlight) return
    hl.set('find', new Highlight(...ranges))
    const cur = ranges[at]
    if (cur) {
      hl.set('find-current', new Highlight(cur))
      cur.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } else hl.delete('find-current')
  }, [ranges, at])
  useEffect(() => () => { highlights()?.delete('find'); highlights()?.delete('find-current') }, [])

  const step = (d: 1 | -1): void => { if (ranges.length) setAt((a) => (a + d + ranges.length) % ranges.length) }
  return (
    <div className="find-bar" role="search" data-testid="find-bar">
      <I.Search size={14} />
      <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find in this chat" aria-label="Find in this chat" data-testid="find-input"
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1) }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
        }} />
      <span className="find-count" data-testid="find-count" aria-live="polite">{q.trim() ? (ranges.length ? `${at + 1} of ${ranges.length}` : 'No matches') : ''}</span>
      <button className="icon-btn" onClick={() => step(-1)} disabled={!ranges.length} aria-label="Previous match" title="Previous (⇧Enter)"><I.Chevron size={14} style={{ transform: 'rotate(180deg)' }} /></button>
      <button className="icon-btn" onClick={() => step(1)} disabled={!ranges.length} aria-label="Next match" title="Next (Enter)"><I.Chevron size={14} /></button>
      <button className="icon-btn" onClick={onClose} aria-label="Close find" title="Close (Esc)" data-testid="find-close"><I.Close size={14} /></button>
    </div>
  )
}
