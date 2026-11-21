import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DocBlock, DocStyle } from '@shared/types'
import { blocksToSlides, plainInline, slideLayout, slidesToBlocks, type Slide } from '@shared/slides'
import { themeOf } from '../../../../main/docs/theme'
import { newId } from '../../../../main/docspace/markdown'
import * as I from '../../icons'

// The deck editor: a strip of slide thumbnails (add, duplicate, delete, reorder) and the selected slide
// as a 16:9 canvas you type into: its title, its points (one per line, indent with Tab) and a picture,
// with speaker notes underneath. The deck is the document's blocks (src/shared/slides.ts), so the bot's
// doc tools, version history, autosave and live merging work as they do for any document.

type Mode = 'type' | 'struct'

const lines = (s: Slide): string => s.points.map((p) => `${'\t'.repeat(p.indent ?? 0)}${p.text}`).join('\n')

/** The text in the points box back to points, keeping ids by position so the bot's merges line up. */
function toPoints(text: string, prev: Slide['points'], taken: Set<string>): Slide['points'] {
  return text.split('\n').map((line, i) => {
    const m = /^(\t| {2})*/.exec(line)?.[0] ?? ''
    const indent = Math.min(3, (m.match(/\t| {2}/g) ?? []).length)
    const id = prev[i]?.id ?? newId(taken)
    taken.add(id)
    return { id, text: line.slice(m.length), ...(indent ? { indent } : {}) }
  })
}

/** A text box that keeps its own text while focused (empty lines aren't stored), synced from the deck otherwise. */
function Field({ value, onChange, className, placeholder, label, multiline, readOnly, onKeyDown, testid }: {
  value: string; onChange: (v: string) => void; className: string; placeholder: string; label: string
  multiline?: boolean; readOnly: boolean; onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void; testid?: string
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  const el = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])
  // Grow with the text, like a text box on a slide.
  useLayoutEffect(() => { const t = el.current; if (t) { t.style.height = '0px'; t.style.height = `${t.scrollHeight}px` } }, [draft])
  return (
    <textarea ref={el} className={className} value={draft} placeholder={placeholder} aria-label={label} readOnly={readOnly} rows={1} spellCheck data-testid={testid}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; setDraft(value) }}
      onChange={(e) => { const v = multiline ? e.target.value : e.target.value.replace(/\n/g, ' '); setDraft(v); onChange(v) }}
      onKeyDown={(e) => {
        if (!multiline && e.key === 'Enter') { e.preventDefault(); return }
        if (multiline && e.key === 'Tab') {
          // Tab / Shift-Tab indent the current line (a sub-point).
          e.preventDefault()
          const t = e.currentTarget
          const start = t.value.lastIndexOf('\n', t.selectionStart - 1) + 1
          const cur = t.selectionStart
          const v = e.shiftKey
            ? (t.value[start] === '\t' ? t.value.slice(0, start) + t.value.slice(start + 1) : t.value)
            : t.value.slice(0, start) + '\t' + t.value.slice(start)
          const moved = v.length - t.value.length
          setDraft(v); onChange(v)
          requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = Math.max(start, cur + moved) })
          return
        }
        onKeyDown?.(e)
      }} />
  )
}

export function SlidesView({ blocks, style, flash, readOnly, onChange, imageUrl, addImage }: {
  blocks: DocBlock[]
  style?: DocStyle
  /** Blocks the bot just changed, with a counter that restarts the flash. */
  flash: Record<string, number>
  readOnly: boolean
  onChange: (blocks: DocBlock[], mode: Mode) => void
  imageUrl: (path: string) => string | null | undefined
  /** Asks for a picture on the Mac; resolves to its path, or null if cancelled. */
  addImage: () => Promise<string | null>
}) {
  const slides = useMemo(() => blocksToSlides(blocks), [blocks])
  const [sel, setSel] = useState(0)
  const strip = useRef<HTMLDivElement>(null)
  const cur = slides[Math.min(sel, slides.length - 1)]
  const at = Math.min(sel, Math.max(0, slides.length - 1))
  const theme = themeOf(style?.theme)
  const font = style?.font ? `"${style.font}", var(--font)` : theme.name === 'classic' ? 'Georgia, "Times New Roman", serif' : '"Avenir Next", Helvetica, Arial, sans-serif'
  const vars = { '--slide-accent': theme.accentText, '--slide-tint': theme.accentTint, '--slide-ink': theme.ink, '--slide-muted': theme.muted, fontFamily: font } as React.CSSProperties

  useEffect(() => { if (sel > slides.length - 1) setSel(Math.max(0, slides.length - 1)) }, [slides.length, sel])
  useEffect(() => { strip.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView({ block: 'nearest' }) }, [at])

  const taken = (): Set<string> => new Set(blocks.map((b) => b.id))
  const commit = (next: Slide[], mode: Mode): void => { const t = taken(); onChange(slidesToBlocks(next, () => { const id = newId(t); t.add(id); return id }), mode) }
  const edit = (patch: Partial<Slide>, mode: Mode = 'type'): void => { if (cur) commit(slides.map((s, i) => (i === at ? { ...s, ...patch } : s)), mode) }

  const blank = (t: Set<string>): Slide => { const id = newId(t); t.add(id); return { id, title: '', points: [], notes: '' } }
  const add = (after = at): void => {
    const t = taken()
    const next = [...slides]
    next.splice(after + 1, 0, blank(t))
    commit(next, 'struct')
    setSel(after + 1)
  }
  const duplicate = (i = at): void => {
    const t = taken()
    const fresh = (): string => { const id = newId(t); t.add(id); return id }
    const s = slides[i]
    const copy: Slide = { ...s, id: fresh(), points: s.points.map((p) => ({ ...p, id: fresh() })), notesId: undefined, imageId: undefined }
    const next = [...slides]
    next.splice(i + 1, 0, copy)
    commit(next, 'struct')
    setSel(i + 1)
  }
  const remove = (i = at): void => {
    if (slides.length <= 1) { commit([{ ...slides[0], title: '', points: [], notes: '', image: undefined, imageId: undefined }], 'struct'); return }
    commit(slides.filter((_, k) => k !== i), 'struct')
    setSel(Math.max(0, i - 1))
  }
  const move = (i: number, to: number): void => {
    if (to < 0 || to >= slides.length || to === i) return
    const next = [...slides]
    const [s] = next.splice(i, 1)
    next.splice(to, 0, s)
    commit(next, 'struct')
    setSel(to)
  }
  const picture = async (): Promise<void> => { const p = await addImage(); if (p) edit({ image: p }, 'struct') }

  const dragFrom = useRef<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const flashed = (s: Slide): number => Math.max(0, ...[s.id, s.notesId, s.imageId, ...s.points.map((p) => p.id)].map((id) => (id ? flash[id] ?? 0 : 0)))

  if (!cur) {
    return (
      <div className="slides-empty">
        <p>This deck has no slides yet.</p>
        {!readOnly && <button className="btn primary" onClick={() => commit([blank(taken())], 'struct')}>Add the first slide</button>}
      </div>
    )
  }
  const layout = slideLayout(cur, at)
  const img = cur.image ? imageUrl(cur.image) : null

  return (
    <div className="slides" style={vars} data-testid="slides">
      <div className="slides-strip" ref={strip} role="listbox" aria-label="Slides" tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const to = at + (e.key === 'ArrowDown' ? 1 : -1); if (e.altKey && !readOnly) move(at, to); else setSel(Math.max(0, Math.min(slides.length - 1, to))) }
          else if (readOnly) return
          else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); remove() }
          else if (e.key === 'Enter') { e.preventDefault(); add() }
          else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate() }
        }}>
        {slides.map((s, i) => {
          const f = flashed(s)
          return (
            <div key={s.id} data-index={i} role="option" aria-selected={i === at} data-testid="slide-thumb"
              className={['slide-thumb-row', i === at ? 'on' : '', dropAt === i ? 'drop' : '', f ? `doc-flash-${f % 2}` : ''].filter(Boolean).join(' ')}
              draggable={!readOnly}
              onClick={() => setSel(i)}
              onDragStart={(e) => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', '') }}
              onDragOver={(e) => { if (dragFrom.current === null) return; e.preventDefault(); setDropAt(i) }}
              onDragEnd={() => { dragFrom.current = null; setDropAt(null) }}
              onDrop={(e) => { e.preventDefault(); if (dragFrom.current !== null) move(dragFrom.current, i); dragFrom.current = null; setDropAt(null) }}>
              <span className="slide-num">{i + 1}</span>
              <div className={`slide-thumb l-${slideLayout(s, i)}`} aria-label={`Slide ${i + 1}: ${plainInline(s.title) || 'Untitled'}`}>
                <div className="st-title">{plainInline(s.title) || (i === 0 ? 'Title' : 'Untitled slide')}</div>
                {s.points.slice(0, 4).map((p) => <div key={p.id} className="st-line" style={{ marginLeft: (p.indent ?? 0) * 6 }}>{plainInline(p.text)}</div>)}
                {s.image && <div className="st-img" />}
              </div>
            </div>
          )
        })}
        {!readOnly && <button className="slides-add" onClick={() => add(slides.length - 1)} data-testid="slide-add"><I.Plus size={14} /> New slide</button>}
      </div>

      <div className="slides-stage">
        {!readOnly && (
          <div className="slides-bar" role="toolbar" aria-label="Slide">
            <span className="muted small">Slide {at + 1} of {slides.length}</span>
            <span className="spacer" />
            <button className="btn" onClick={() => void picture()} data-testid="slide-image"><I.Image size={14} /> {cur.image ? 'Change picture' : 'Picture'}</button>
            {cur.image && <button className="btn" onClick={() => edit({ image: undefined, imageId: undefined }, 'struct')}>Remove picture</button>}
            <button className="btn" onClick={() => duplicate()} title="Duplicate (⌘D in the slide list)">Duplicate</button>
            <button className="btn" onClick={() => move(at, at - 1)} disabled={at === 0} aria-label="Move slide up" title="Move up (⌥↑)">↑</button>
            <button className="btn" onClick={() => move(at, at + 1)} disabled={at === slides.length - 1} aria-label="Move slide down" title="Move down (⌥↓)">↓</button>
            <button className="btn danger" onClick={() => remove()} data-testid="slide-delete">Delete</button>
          </div>
        )}
        <div className={`slide-canvas l-${layout}`} data-testid="slide-canvas">
          <div className="slide-text">
            <Field key={`t-${cur.id}`} className="slide-title" value={cur.title} label="Slide title" readOnly={readOnly} testid="slide-title"
              placeholder={at === 0 ? 'Click to add a title' : 'Slide title'} onChange={(v) => edit({ title: v })} />
            {(layout !== 'image' || !readOnly) && (
              <Field key={`p-${cur.id}`} className={`slide-points${layout === 'title' ? ' subtitle' : ''}`} value={lines(cur)} multiline readOnly={readOnly} testid="slide-points"
                label="Slide points, one per line (Tab for a sub-point)" placeholder={at === 0 ? 'Subtitle' : 'One point per line · Tab for a sub-point'}
                onChange={(v) => edit({ points: toPoints(v, cur.points, taken()) })} />
            )}
          </div>
          {cur.image && (
            <div className="slide-picture">{img ? <img src={img} alt="" draggable={false} /> : <div className="doc-image-missing">{img === undefined ? 'Loading picture…' : 'Picture not available'}</div>}</div>
          )}
          <span className="slide-foot">{at + 1}</span>
        </div>
        <label className="slide-notes">
          <span>Speaker notes</span>
          <Field key={`n-${cur.id}`} className="slide-notes-text" value={cur.notes} multiline readOnly={readOnly} label="Speaker notes" testid="slide-notes"
            placeholder="What to say on this slide (not shown on the slide)" onChange={(v) => edit({ notes: v })} />
        </label>
      </div>
    </div>
  )
}
