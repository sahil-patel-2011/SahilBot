import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DocBlock, DocStyle } from '@shared/types'
import { blocksToSlides, plainInline, slidesToBlocks, statOf, type Slide, type SlidePoint } from '@shared/slides'
import { deckCss, deckLook, inlineHtml, slideHtml, slidePieces, slideTablesHtml, SLIDE_H, SLIDE_W } from '@shared/slide-render'
import { newId } from '../../../../main/docspace/markdown'
import * as I from '../../icons'

// The deck editor. Slides are drawn by src/shared/slide-render.ts, the same code the PDF, PNG and
// picture-PowerPoint exports use, so the slide you edit is exactly the slide you send. Click any text on
// the slide to type: Enter adds a point, Backspace on an empty point removes it, Tab / Shift-Tab indent.
// Views: Edit (thumbnails + the slide), Grid (every slide) and Present (full screen, arrow keys).
// The deck is the document's blocks (src/shared/slides.ts), so the bot's doc tools, version history,
// autosave and live merging work as they do for any document.

type Mode = 'type' | 'struct'
type View = 'edit' | 'grid'

/** A 1280 × 720 slide scaled to the width of its box. */
function Stage({ children, className, onClick, label, fit }: { children: ReactNode; className?: string; onClick?: () => void; label?: string; fit?: 'width' | 'contain' }) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = (): void => {
      const w = el.clientWidth, h = el.clientHeight
      setScale(fit === 'contain' ? Math.min(w / SLIDE_W, h / SLIDE_H) : w / SLIDE_W)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [fit])
  return (
    <div ref={box} className={`deck-stage${className ? ` ${className}` : ''}`} onClick={onClick} aria-label={label}>
      <div className="deck-stage-inner" style={{ width: SLIDE_W, height: SLIDE_H, transform: `scale(${scale})`, visibility: scale ? 'visible' : 'hidden' }}>{children}</div>
    </div>
  )
}

/** Static slide HTML (thumbnails, grid, Present). The text is escaped by inlineHtml. */
function StaticSlide({ s, i, total, title, img }: { s: Slide; i: number; total: number; title: string; img: (src: string) => string | null | undefined }) {
  return <div className="sbdeck" dangerouslySetInnerHTML={{ __html: slideHtml(s, i, { total, deckTitle: title, img }) }} />
}

/**
 * Text you click to edit, in place on the slide. Shows formatted text (bold, italics) until focused, then
 * the raw text with its Markdown, and keeps its own text while focused so a merge never moves the caret.
 */
function Editable({ value, onChange, onKeyDown, className, placeholder, tag = 'div', readOnly, register, testid }: {
  value: string; onChange: (v: string) => void; onKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void
  className: string; placeholder: string; tag?: 'div' | 'li' | 'h1' | 'b' | 'span'; readOnly: boolean
  register?: (el: HTMLElement | null) => void; testid?: string
}) {
  const el = useRef<HTMLElement | null>(null)
  const focused = useRef(false)
  useLayoutEffect(() => {
    const e = el.current
    if (!e || focused.current) return
    e.innerHTML = value ? inlineHtml(value) : ''
  }, [value])
  const Tag = tag as 'div'
  return (
    <Tag ref={(e: HTMLDivElement | null) => { el.current = e; register?.(e) }} className={`${className} deck-edit`} data-ph={placeholder} data-testid={testid}
      contentEditable={readOnly ? false : 'plaintext-only'} suppressContentEditableWarning spellCheck role="textbox" aria-label={placeholder}
      onFocus={(e) => { focused.current = true; e.currentTarget.textContent = value }}
      onBlur={(e) => { focused.current = false; e.currentTarget.innerHTML = value ? inlineHtml(value) : '' }}
      onInput={(e) => onChange((e.currentTarget.textContent ?? '').replace(/\n/g, ' '))}
      onPaste={(e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\s*\n\s*/g, ' ')) }}
      onKeyDown={onKeyDown} />
  )
}

/** "**0** Label" while you edit a big number: lenient (an empty label or value still counts). */
const looseStat = (t: string): { value: string; label: string } | undefined => {
  const m = /^\*\*([^*]*)\*\*\s*(?:[—–:-]\s*)?(.*)$/.exec(t.trim())
  return m ? { value: m[1].trim(), label: m[2].trim() } : undefined
}

/** Speaker notes: your own text while you type, the latest (yours or the bot's) otherwise. */
function NotesBox({ value, readOnly, onChange }: { value: string; readOnly: boolean; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])
  return (
    <textarea className="slide-notes-text" value={draft} readOnly={readOnly} aria-label="Speaker notes" data-testid="slide-notes"
      placeholder="What to say on this slide (shown in Presenter view and PowerPoint's notes, not on the slide)"
      onFocus={() => { focused.current = true }} onBlur={() => { focused.current = false; setDraft(value) }}
      onChange={(e) => { setDraft(e.target.value); onChange(e.target.value) }} />
  )
}

/** Time since Present started. */
function Elapsed() {
  const [start] = useState(Date.now())
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const s = Math.floor((now - start) / 1000)
  return <span className="deck-elapsed">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>
}

const caretAtStart = (): boolean => { const s = window.getSelection(); return !!s && s.isCollapsed && s.anchorOffset === 0 }

export function SlidesView({ blocks, style, title, flash, readOnly, onChange, imageUrl, addImage }: {
  blocks: DocBlock[]
  style?: DocStyle
  /** The deck's title (the footer of light slides). */
  title: string
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
  const [view, setView] = useState<View>('edit')
  const [viewMenu, setViewMenu] = useState(false)
  const [presenting, setPresenting] = useState<number | null>(null)
  /** Present with notes, the next slide and a timer (P switches). */
  const [presenter, setPresenter] = useState(false)
  const strip = useRef<HTMLDivElement>(null)
  const els = useRef(new Map<string, HTMLElement>())
  const focusNext = useRef<{ key: string; at: 'start' | 'end' } | null>(null)
  const at = Math.min(sel, Math.max(0, slides.length - 1))
  const cur = slides[at]
  const css = useMemo(() => deckCss(deckLook(style)), [style])
  const dragFrom = useRef<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)

  useEffect(() => { if (sel > slides.length - 1) setSel(Math.max(0, slides.length - 1)) }, [slides.length, sel])
  useEffect(() => { strip.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView({ block: 'nearest' }) }, [at])
  /** Focuses a field on the slide now, with the caret at its start or end; false if it isn't rendered. */
  const focusKey = (key: string, where: 'start' | 'end' = 'end'): boolean => {
    const el = els.current.get(key)
    if (!el) return false
    el.focus()
    const r = document.createRange()
    r.selectNodeContents(el)
    r.collapse(where === 'start')
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(r)
    return true
  }
  // Focus an element a structural edit just made (a new point), once it has rendered.
  useEffect(() => {
    const f = focusNext.current
    if (f && focusKey(f.key, f.at)) focusNext.current = null
  })

  // While you type on a slide its layout and which points are big numbers stay as they were when you started
  // (typing "**130** S" mid-word, or a first character in an empty point, mustn't swap the field under the caret);
  // they settle when you leave the slide.
  const frozen = useRef<{ slideId: string; layout: ReturnType<typeof slidePieces>['layout']; stats: Set<string> } | null>(null)
  const [, thaw] = useState(0)

  const taken = (): Set<string> => new Set(blocks.map((b) => b.id))
  const fresh = (t: Set<string>): string => { const id = newId(t); t.add(id); return id }
  const commit = (next: Slide[], mode: Mode): void => { const t = taken(); onChange(slidesToBlocks(next, () => fresh(t)), mode) }
  const edit = (patch: Partial<Slide>, mode: Mode = 'type'): void => { if (cur) commit(slides.map((s, i) => (i === at ? { ...s, ...patch } : s)), mode) }
  const setPoints = (points: SlidePoint[], mode: Mode = 'type'): void => edit({ points }, mode)
  const reg = (key: string) => (el: HTMLElement | null): void => { if (el) els.current.set(key, el); else els.current.delete(key) }

  // ---------------------------------------------------------------- slides

  const blank = (t: Set<string>): Slide => ({ id: fresh(t), title: '', points: [], notes: '' })
  const add = (after = at): void => {
    const t = taken()
    const next = [...slides]
    const s = blank(t)
    next.splice(after + 1, 0, s)
    commit(next, 'struct')
    setSel(after + 1)
    setView('edit')
    focusNext.current = { key: `title:${s.id}`, at: 'end' }
  }
  const duplicate = (i = at): void => {
    const t = taken()
    const s = slides[i]
    const copy: Slide = { ...s, id: fresh(t), kickerId: undefined, points: s.points.map((p) => ({ ...p, id: fresh(t) })), notesId: undefined, imageId: undefined }
    const next = [...slides]
    next.splice(i + 1, 0, copy)
    commit(next, 'struct')
    setSel(i + 1)
  }
  const remove = (i = at): void => {
    if (slides.length <= 1) { commit([{ ...slides[0], kicker: undefined, title: '', points: [], notes: '', image: undefined, imageId: undefined }], 'struct'); return }
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

  // ---------------------------------------------------------------- points (on the selected slide)

  const insertPoint = (afterId: string | null, text = '', indent = 0): void => {
    if (!cur) return
    const id = fresh(taken())
    const k = afterId ? cur.points.findIndex((p) => p.id === afterId) : cur.points.length - 1
    const next = [...cur.points]
    next.splice(k + 1, 0, { id, text, ...(indent ? { indent } : {}) })
    setPoints(next, 'struct')
    focusNext.current = { key: `pt:${id}`, at: 'end' }
  }
  const pointKeys = (p: SlidePoint, list: SlidePoint[]) => (e: React.KeyboardEvent<HTMLElement>): void => {
    if (!cur) return
    const i = list.findIndex((x) => x.id === p.id)
    if (e.key === 'Enter') { e.preventDefault(); insertPoint(p.id, '', p.indent ?? 0); return }
    if (e.key === 'Tab') {
      e.preventDefault()
      setPoints(cur.points.map((x) => (x.id === p.id ? { ...x, indent: Math.max(0, Math.min(3, (x.indent ?? 0) + (e.shiftKey ? -1 : 1))) || undefined } : x)), 'struct')
      focusNext.current = { key: `pt:${p.id}`, at: 'end' }
      return
    }
    if (e.key === 'Backspace' && caretAtStart() && !(e.currentTarget.textContent ?? '')) {
      e.preventDefault()
      const prev = list[i - 1]
      setPoints(cur.points.filter((x) => x.id !== p.id), 'struct')
      focusNext.current = prev ? { key: `pt:${prev.id}`, at: 'end' } : { key: `title:${cur.id}`, at: 'end' }
      return
    }
    if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); focusKey(`pt:${list[i - 1].id}`) }
    if (e.key === 'ArrowUp' && i === 0) { e.preventDefault(); focusKey(`title:${cur.id}`) }
    if (e.key === 'ArrowDown' && i < list.length - 1) { e.preventDefault(); focusKey(`pt:${list[i + 1].id}`) }
  }
  const setPoint = (id: string, text: string): void => { if (cur) setPoints(cur.points.map((x) => (x.id === id ? { ...x, text } : x))) }
  const addStat = (): void => {
    if (!cur) return
    const id = fresh(taken())
    setPoints([...cur.points, { id, text: '**0** Label' }], 'struct')
    if (frozen.current?.slideId === cur.id) frozen.current.stats.add(id)
    focusNext.current = { key: `sv:${id}`, at: 'end' }
  }
  const setStat = (id: string, part: 'value' | 'label', v: string): void => {
    if (!cur) return
    const p = cur.points.find((x) => x.id === id)
    const st = p ? looseStat(p.text) : undefined
    if (!st) return
    const value = (part === 'value' ? v : st.value).replace(/\*/g, '')
    const label = part === 'label' ? v : st.label
    setPoint(id, `**${value}** ${label}`.trimEnd())
  }

  const flashed = (s: Slide): number => Math.max(0, ...[s.id, s.kickerId, s.notesId, s.imageId, ...s.points.map((p) => p.id)].map((id) => (id ? flash[id] ?? 0 : 0)))

  // ---------------------------------------------------------------- Present

  useEffect(() => {
    if (presenting === null) return
    const on = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { setPresenting(null); return }
      if (e.key === 'p' || e.key === 'P') { e.preventDefault(); setPresenter((v) => !v); return }
      if (['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'Enter'].includes(e.key)) { e.preventDefault(); setPresenting((n) => (n === null ? n : Math.min(slides.length - 1, n + 1))) }
      if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); setPresenting((n) => (n === null ? n : Math.max(0, n - 1))) }
    }
    window.addEventListener('keydown', on, true)
    void document.documentElement.requestFullscreen?.().catch(() => undefined)
    return () => { window.removeEventListener('keydown', on, true); if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined) }
  }, [presenting !== null, slides.length]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!cur) {
    return (
      <div className="slides-empty">
        <p>This deck has no slides yet.</p>
        {!readOnly && <button className="btn primary" onClick={() => commit([blank(taken())], 'struct')}>Add the first slide</button>}
      </div>
    )
  }

  const fz = frozen.current?.slideId === cur.id ? frozen.current : null
  const isStat = (x: SlidePoint): boolean => (fz ? fz.stats.has(x.id) && !!looseStat(x.text) : !!statOf(x.text))
  const p = { ...slidePieces(cur, at), ...(fz ? { layout: fz.layout, dark: fz.layout === 'title' || fz.layout === 'section' } : {}) }
  const text = cur.points.filter((x) => !isStat(x))
  const statPts = cur.points.filter(isStat)
  const img = cur.image ? imageUrl(cur.image) : null
  const kicker = (
    <Editable key={`k-${cur.id}`} className="sl-k" value={cur.kicker ?? ''} placeholder={readOnly ? '' : 'Add a label'} readOnly={readOnly} register={reg(`kicker:${cur.id}`)} testid="slide-kicker"
      onChange={(v) => edit({ kicker: v })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); els.current.get(`title:${cur.id}`)?.focus() } }} />
  )
  const heading = (
    <Editable key={`t-${cur.id}`} tag="h1" className="sl-h" value={cur.title} placeholder={at === 0 ? 'Title' : 'Slide title'} readOnly={readOnly} register={reg(`title:${cur.id}`)} testid="slide-title"
      onChange={(v) => edit({ title: v })}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'ArrowDown') { const first = text[0]; if (first) { e.preventDefault(); focusKey(`pt:${first.id}`) } else if (e.key === 'Enter') { e.preventDefault(); insertPoint(null) } }
        if (e.key === 'ArrowUp') { e.preventDefault(); focusKey(`kicker:${cur.id}`) }
      }} />
  )
  const stats = (statPts.length > 0 || !readOnly) && (
    <div className={`sl-stats${statPts.length ? '' : ' deck-ghost'}`}>
      {statPts.map((x) => {
        const st = looseStat(x.text)!
        return (
          <div key={x.id} className="sl-stat">
            <Editable tag="b" className="" value={st.value} placeholder="0" readOnly={readOnly} register={reg(`sv:${x.id}`)} onChange={(v) => setStat(x.id, 'value', v)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); els.current.get(`sl:${x.id}`)?.focus() } if (e.key === 'Backspace' && !(e.currentTarget.textContent ?? '')) { e.preventDefault(); setPoints(cur.points.filter((y) => y.id !== x.id), 'struct') } }} />
            <Editable tag="span" className="" value={st.label} placeholder="Label" readOnly={readOnly} register={reg(`sl:${x.id}`)} onChange={(v) => setStat(x.id, 'label', v)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addStat() } }} />
          </div>
        )
      })}
      {!readOnly && <button className="deck-add-stat" onClick={addStat} data-testid="slide-add-stat" title="A big number with a label">+ Number</button>}
    </div>
  )
  const bullet = (x: SlidePoint, list: SlidePoint[]) => (
    <Editable key={x.id} tag="li" className={`i${Math.min(3, x.indent ?? 0)}`} value={x.text} placeholder="Point" readOnly={readOnly} register={reg(`pt:${x.id}`)} testid="slide-point"
      onChange={(v) => setPoint(x.id, v)} onKeyDown={pointKeys(x, list)} />
  )

  let body: ReactNode
  if (p.dark) {
    const [sub, ...desc] = text
    body = (
      <>
        {kicker}{heading}
        {sub
          ? <Editable key={sub.id} className="sl-sub" value={sub.text} placeholder="Subtitle" readOnly={readOnly} register={reg(`pt:${sub.id}`)} testid="slide-point" onChange={(v) => setPoint(sub.id, v)} onKeyDown={pointKeys(sub, text)} />
          : !readOnly && <div className="sl-sub deck-placeholder" onClick={() => insertPoint(null)}>Subtitle</div>}
        {desc.length > 0 && <div className="sl-desc">{desc.map((x) => <Editable key={x.id} className="" value={x.text} placeholder="Description" readOnly={readOnly} register={reg(`pt:${x.id}`)} testid="slide-point" onChange={(v) => setPoint(x.id, v)} onKeyDown={pointKeys(x, text)} />)}</div>}
        {stats}
      </>
    )
  } else {
    const list = <ul className="sl-pts">{text.map((x) => bullet(x, text))}{!readOnly && !text.length && <li className="i0 deck-placeholder" onClick={() => insertPoint(null)}>Add a point</li>}</ul>
    const tablesHtml = slideTablesHtml(cur)
    const tables = tablesHtml ? <div title="Ask SahilBot to change this table" dangerouslySetInnerHTML={{ __html: tablesHtml }} /> : null
    const pic = cur.image && <figure className="sl-img">{img ? <img src={img} alt="" draggable={false} /> : <div className="doc-image-missing">{img === undefined ? 'Loading picture…' : 'Picture not available'}</div>}</figure>
    body = p.layout === 'image_text'
      ? <div className="sl-cols"><div className="sl-text">{kicker}{heading}{list}{tables}{stats}</div>{pic}</div>
      : <>{kicker}{heading}{list}{tables}{p.layout === 'image' && pic}{stats}</>
  }

  const thumbs = (cls: string) => slides.map((s, i) => {
    const f = flashed(s)
    return (
      <div key={s.id} data-index={i} role="option" aria-selected={i === at} data-testid="slide-thumb"
        className={[cls, i === at ? 'on' : '', dropAt === i ? 'drop' : '', f ? `doc-flash-${f % 2}` : ''].filter(Boolean).join(' ')}
        draggable={!readOnly}
        onClick={() => { setSel(i); if (view === 'grid') setView('edit') }}
        onDoubleClick={() => setPresenting(i)}
        onDragStart={(e) => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', '') }}
        onDragOver={(e) => { if (dragFrom.current === null) return; e.preventDefault(); setDropAt(i) }}
        onDragEnd={() => { dragFrom.current = null; setDropAt(null) }}
        onDrop={(e) => { e.preventDefault(); if (dragFrom.current !== null) move(dragFrom.current, i); dragFrom.current = null; setDropAt(null) }}>
        <span className="slide-num">{i + 1}</span>
        <Stage className="slide-thumb" label={`Slide ${i + 1}: ${plainInline(s.title) || 'Untitled'}`}><StaticSlide s={s} i={i} total={slides.length} title={title} img={imageUrl} /></Stage>
      </div>
    )
  })

  return (
    <div className="slides-wrap" data-testid="slides">
      <style>{css}</style>
      <div className="deck-bar" role="toolbar" aria-label="Deck">
        {!readOnly && <button className="deck-bar-btn" onClick={() => add()} data-testid="slide-add"><I.Plus size={15} /> Add slide</button>}
        <div className="deck-view">
          <button className="deck-bar-btn" aria-haspopup="menu" aria-expanded={viewMenu} onClick={() => setViewMenu((v) => !v)} data-testid="deck-view">View <span className="deck-caret">▾</span></button>
          {viewMenu && (
            <div className="deck-menu" role="menu" onMouseLeave={() => setViewMenu(false)}>
              <button role="menuitemradio" aria-checked={view === 'edit'} onClick={() => { setView('edit'); setViewMenu(false) }}>Slide and thumbnails</button>
              <button role="menuitemradio" aria-checked={view === 'grid'} onClick={() => { setView('grid'); setViewMenu(false) }} data-testid="deck-grid">All slides</button>
              <button role="menuitem" onClick={() => { setPresenting(at); setViewMenu(false) }} data-testid="deck-present">Present from this slide</button>
              <button role="menuitem" onClick={() => { setPresenting(0); setViewMenu(false) }}>Present from the start</button>
              <button role="menuitem" onClick={() => { setPresenter(true); setPresenting(at); setViewMenu(false) }} data-testid="deck-presenter">Presenter view (notes, next slide, timer)</button>
            </div>
          )}
        </div>
        <span className="deck-count">{at + 1} / {slides.length}</span>
        <span className="spacer" />
        {!readOnly && view === 'edit' && (
          <>
            <button className="deck-bar-btn" onClick={() => void picture()} data-testid="slide-image" title={cur.image ? 'Change the picture' : 'Add a picture'}><I.Image size={14} /> {cur.image ? 'Change picture' : 'Picture'}</button>
            {cur.image && <button className="deck-bar-btn" onClick={() => edit({ image: undefined, imageId: undefined }, 'struct')}>Remove picture</button>}
            <button className="deck-bar-btn" onClick={() => duplicate()} title="Duplicate (⌘D in the slide list)">Duplicate</button>
            <button className="deck-bar-btn" onClick={() => move(at, at - 1)} disabled={at === 0} aria-label="Move slide up" title="Move up (⌥↑)">↑</button>
            <button className="deck-bar-btn" onClick={() => move(at, at + 1)} disabled={at === slides.length - 1} aria-label="Move slide down" title="Move down (⌥↓)">↓</button>
            <button className="deck-bar-btn danger" onClick={() => remove()} data-testid="slide-delete" title="Delete this slide">Delete</button>
          </>
        )}
        <button className="deck-bar-btn primary" onClick={() => setPresenting(at)} title="Present (full screen; arrow keys, Esc to stop)"><I.Play size={13} /> Present</button>
      </div>

      {view === 'grid' ? (
        <div className="deck-grid" role="listbox" aria-label="Slides">{thumbs('deck-grid-item')}</div>
      ) : (
        <div className="slides">
          <div className="slides-strip" ref={strip} role="listbox" aria-label="Slides" tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const to = at + (e.key === 'ArrowDown' ? 1 : -1); if (e.altKey && !readOnly) move(at, to); else setSel(Math.max(0, Math.min(slides.length - 1, to))) }
              else if (readOnly) return
              else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); remove() }
              else if (e.key === 'Enter') { e.preventDefault(); add() }
              else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate() }
            }}>
            {thumbs('slide-thumb-row')}
          </div>
          <div className="slides-stage">
            <Stage className="slide-canvas" label={`Slide ${at + 1}`}>
              <div className="sbdeck" data-testid="slide-canvas"
                onFocus={() => { if (frozen.current?.slideId !== cur.id) frozen.current = { slideId: cur.id, layout: slidePieces(cur, at).layout, stats: new Set(cur.points.filter((x) => statOf(x.text)).map((x) => x.id)) } }}
                onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { frozen.current = null; thaw((n) => n + 1) } }}>
                <section className={`sl sl-${p.layout}${p.dark ? ' dark' : ''}`}>
                  {body}
                  {!p.dark && <div className="sl-foot"><span>{plainInline(title)}</span><span>{at + 1}</span></div>}
                </section>
              </div>
            </Stage>
            <label className="slide-notes">
              <span>Speaker notes</span>
              <NotesBox key={`n-${cur.id}`} value={cur.notes} readOnly={readOnly} onChange={(v) => edit({ notes: v })} />
            </label>
            {!readOnly && <p className="deck-tip">Click any text on the slide to edit it. Enter adds a point, Tab makes a sub-point. Write a number as <b>**130** Steps</b> to show it big. Ask SahilBot in the chat to draft or rework slides.</p>}
          </div>
        </div>
      )}

      {presenting !== null && slides[presenting] && presenter && (
        <div className="deck-presenter" role="dialog" aria-label="Presenter view">
          <div className="deck-presenter-main"><Stage fit="contain"><StaticSlide s={slides[presenting]} i={presenting} total={slides.length} title={title} img={imageUrl} /></Stage></div>
          <aside className="deck-presenter-side">
            <div className="deck-presenter-meta"><b>{presenting + 1} / {slides.length}</b><Elapsed /></div>
            <div className="deck-presenter-next">{slides[presenting + 1] ? <><span>Next</span><Stage><StaticSlide s={slides[presenting + 1]} i={presenting + 1} total={slides.length} title={title} img={imageUrl} /></Stage></> : <span>Last slide</span>}</div>
            <div className="deck-presenter-notes" data-testid="presenter-notes">{slides[presenting].notes.trim() || <span className="muted">No notes for this slide.</span>}</div>
            <div className="deck-presenter-keys">← → move · P audience view · Esc stop</div>
          </aside>
        </div>
      )}
      {presenting !== null && slides[presenting] && !presenter && (
        <div className="deck-present" role="dialog" aria-label="Presenting" onClick={() => setPresenting((n) => (n === null ? n : n + 1 >= slides.length ? null : n + 1))}>
          <Stage fit="contain" className="deck-present-stage"><StaticSlide s={slides[presenting]} i={presenting} total={slides.length} title={title} img={imageUrl} /></Stage>
          <div className="deck-present-bar" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setPresenting((n) => Math.max(0, (n ?? 0) - 1))} aria-label="Previous slide">‹</button>
            <span>{presenting + 1} / {slides.length}</span>
            <button onClick={() => setPresenting((n) => Math.min(slides.length - 1, (n ?? 0) + 1))} aria-label="Next slide">›</button>
            <button onClick={() => setPresenter(true)} title="Notes, next slide and a timer (P)">Presenter view</button>
            <button onClick={() => setPresenting(null)}>Esc · Stop</button>
          </div>
        </div>
      )}
    </div>
  )
}
