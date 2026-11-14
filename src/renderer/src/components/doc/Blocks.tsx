import { useLayoutEffect, useRef, useState } from 'react'
import type { DocBlock, DocBlockType, DocCalloutTone } from '@shared/types'
import { inlineToHtml } from '../../../../main/docspace/inline'
import { caretOffset, htmlToInline, setCaret } from './dom'

// The blocks of the document editor: each text block is its own small contentEditable (uncontrolled: the
// DOM is only rewritten when the block's Markdown changes from outside, so typing never loses the caret).

export interface BlockCtx {
  readOnly: boolean
  numbers: Map<string, number>
  /** Elements by key: a block id, or "<tableId>:<row>:<col>" for table cells. */
  register(key: string, el: HTMLElement | null): void
  text(id: string, md: string, el: HTMLElement): void
  key(e: React.KeyboardEvent, b: DocBlock, el: HTMLElement): void
  paste(e: React.ClipboardEvent, b: DocBlock, el: HTMLElement): void
  /** The block got focus (it is the toolbar's target). */
  focus(id: string): void
  patch(id: string, p: Partial<DocBlock>, structural?: boolean): void
  remove(id: string): void
  /** Adds an empty paragraph after the block and focuses it. */
  after(id: string): void
  nav(id: string, dir: 'up' | 'down'): void
  imageUrl(path: string): string | null | undefined
}

export const TYPE_LABEL: Record<DocBlockType, string> = {
  p: 'Text', h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', bullet: 'Bulleted list', numbered: 'Numbered list', check: 'Checklist',
  quote: 'Quote', code: 'Code', table: 'Table', divider: 'Divider', image: 'Image', callout: 'Callout'
}

const PLACEHOLDER: Partial<Record<DocBlockType, string>> = {
  h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', bullet: 'List', numbered: 'List', check: 'To-do', quote: 'Quote', callout: 'Callout'
}

const TONES: DocCalloutTone[] = ['info', 'tip', 'warn', 'danger']
const TONE_ICON: Record<DocCalloutTone, string> = { info: 'ℹ︎', tip: '✦', warn: '!', danger: '✕' }
const TONE_NAME: Record<DocCalloutTone, string> = { info: 'Note', tip: 'Tip', warn: 'Warning', danger: 'Caution' }

export function EditableText({ value, onInput, onKeyDown, onFocus, onPaste, placeholder, className, label, register, readOnly }: {
  value: string
  onInput: (md: string, el: HTMLElement) => void
  onKeyDown?: (e: React.KeyboardEvent, el: HTMLElement) => void
  onFocus?: () => void
  onPaste?: (e: React.ClipboardEvent, el: HTMLElement) => void
  placeholder?: string
  className?: string
  label: string
  register?: (el: HTMLElement | null) => void
  readOnly?: boolean
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const last = useRef<string | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || last.current === value) return
    const focused = document.activeElement === el
    const off = focused ? caretOffset(el) : null
    el.innerHTML = inlineToHtml(value)
    last.current = value
    if (focused && off !== null) setCaret(el, off)
  })
  return (
    <div
      ref={(el) => { ref.current = el; register?.(el) }}
      className={`doc-text${className ? ` ${className}` : ''}`}
      contentEditable={!readOnly}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      aria-readonly={readOnly || undefined}
      data-placeholder={placeholder}
      spellCheck
      onInput={() => {
        const el = ref.current!
        if (el.innerHTML === '<br>') el.innerHTML = ''
        const md = htmlToInline(el)
        last.current = md
        onInput(md, el)
      }}
      onKeyDown={(e) => onKeyDown?.(e, ref.current!)}
      onFocus={onFocus}
      onPaste={(e) => onPaste?.(e, ref.current!)}
    />
  )
}

/** One block, editable. */
export function BlockBody({ b, ctx }: { b: DocBlock; ctx: BlockCtx }) {
  const textProps = {
    value: b.text ?? '',
    readOnly: ctx.readOnly,
    label: TYPE_LABEL[b.type],
    register: (el: HTMLElement | null) => ctx.register(b.id, el),
    onInput: (md: string, el: HTMLElement) => ctx.text(b.id, md, el),
    onKeyDown: (e: React.KeyboardEvent, el: HTMLElement) => ctx.key(e, b, el),
    onPaste: (e: React.ClipboardEvent, el: HTMLElement) => ctx.paste(e, b, el),
    onFocus: () => ctx.focus(b.id),
    placeholder: PLACEHOLDER[b.type] ?? "Type, or press '/' for blocks"
  }
  switch (b.type) {
    case 'h1': case 'h2': case 'h3': case 'p':
      return <EditableText {...textProps} className={`t-${b.type}`} />
    case 'quote':
      return <div className="doc-quote"><EditableText {...textProps} /></div>
    case 'bullet':
      return (
        <div className="doc-li">
          <span className="doc-marker" aria-hidden>{['•', '◦', '▪'][(b.indent ?? 0) % 3]}</span>
          <EditableText {...textProps} />
        </div>
      )
    case 'numbered':
      return (
        <div className="doc-li">
          <span className="doc-marker num" aria-hidden>{ctx.numbers.get(b.id) ?? 1}.</span>
          <EditableText {...textProps} />
        </div>
      )
    case 'check':
      return (
        <div className={`doc-li doc-check${b.checked ? ' done' : ''}`}>
          <input type="checkbox" checked={!!b.checked} disabled={ctx.readOnly} aria-label={b.checked ? 'Done' : 'Not done'}
            onChange={(e) => ctx.patch(b.id, { checked: e.target.checked }, true)} />
          <EditableText {...textProps} />
        </div>
      )
    case 'callout': {
      const tone = b.tone ?? 'info'
      return (
        <div className={`doc-callout tone-${tone}`}>
          <button className="doc-callout-icon" disabled={ctx.readOnly} title={`${TONE_NAME[tone]} (click to change)`} aria-label={`Callout style: ${TONE_NAME[tone]}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => ctx.patch(b.id, { tone: TONES[(TONES.indexOf(tone) + 1) % TONES.length] }, true)}>{TONE_ICON[tone]}</button>
          <EditableText {...textProps} />
        </div>
      )
    }
    case 'code':
      return <CodeBlock b={b} ctx={ctx} />
    case 'table':
      return <TableBlock b={b} ctx={ctx} />
    case 'divider':
      return (
        <div className="doc-divider" tabIndex={0} role="separator" aria-label="Divider" ref={(el) => ctx.register(b.id, el)} onFocus={() => ctx.focus(b.id)}
          onKeyDown={(e) => {
            if (ctx.readOnly) return
            if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); ctx.remove(b.id) }
            else if (e.key === 'Enter') { e.preventDefault(); ctx.after(b.id) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); ctx.nav(b.id, 'up') }
            else if (e.key === 'ArrowDown') { e.preventDefault(); ctx.nav(b.id, 'down') }
          }}><hr /></div>
      )
    case 'image':
      return <ImageBlock b={b} ctx={ctx} />
  }
}

function CodeBlock({ b, ctx }: { b: DocBlock; ctx: BlockCtx }) {
  const ta = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  })
  return (
    <div className="doc-code">
      <input className="doc-code-lang" value={b.lang ?? ''} placeholder="language" aria-label="Code language" readOnly={ctx.readOnly} spellCheck={false}
        onChange={(e) => ctx.patch(b.id, { lang: e.target.value.replace(/[^\w+#.-]/g, '').slice(0, 20) || undefined })} onFocus={() => ctx.focus(b.id)} />
      <textarea ref={(el) => { ta.current = el; ctx.register(b.id, el) }} value={b.text ?? ''} spellCheck={false} readOnly={ctx.readOnly} aria-label="Code"
        onFocus={() => ctx.focus(b.id)}
        onChange={(e) => ctx.patch(b.id, { text: e.target.value })}
        onKeyDown={(e) => {
          const el = e.currentTarget
          if (e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault()
            const s = el.selectionStart
            const v = el.value
            ctx.patch(b.id, { text: `${v.slice(0, s)}  ${v.slice(el.selectionEnd)}` })
            requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2 })
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ctx.after(b.id) } else if (e.key === 'ArrowUp' && el.selectionStart === 0 && el.selectionEnd === 0) { e.preventDefault(); ctx.nav(b.id, 'up') } else if (e.key === 'ArrowDown' && el.selectionStart === el.value.length) { e.preventDefault(); ctx.nav(b.id, 'down') } else if (e.key === 'Backspace' && !el.value) { e.preventDefault(); ctx.patch(b.id, { type: 'p', text: '', lang: undefined }, true) }
        }} />
    </div>
  )
}

function TableBlock({ b, ctx }: { b: DocBlock; ctx: BlockCtx }) {
  const rows = b.rows?.length ? b.rows : [['']]
  const cols = Math.max(1, ...rows.map((r) => r.length))
  const [cur, setCur] = useState<[number, number] | null>(null)
  const header = b.header !== false
  const setRows = (next: string[][], structural = true): void => ctx.patch(b.id, { rows: next }, structural)
  const grid = (): string[][] => rows.map((r) => Array.from({ length: cols }, (_, k) => r[k] ?? ''))
  const focusCell = (r: number, c: number): void => { requestAnimationFrame(() => { const el = document.querySelector<HTMLElement>(`[data-cell="${b.id}:${r}:${c}"]`); if (el) { el.focus(); setCaret(el, 'end') } }) }
  return (
    <div className="doc-table-wrap" onFocus={() => ctx.focus(b.id)}>
      <table className={`doc-table${header ? ' has-header' : ''}`}>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {Array.from({ length: cols }, (_, ci) => {
                const Cell = ri === 0 && header ? 'th' : 'td'
                return (
                  <Cell key={ci} className={cur && cur[0] === ri && cur[1] === ci ? 'on' : ''}>
                    <CellText value={r[ci] ?? ''} readOnly={ctx.readOnly} label={`Row ${ri + 1}, column ${ci + 1}`} id={`${b.id}:${ri}:${ci}`}
                      register={(el) => ctx.register(`${b.id}:${ri}:${ci}`, el)}
                      onFocus={() => { setCur([ri, ci]); ctx.focus(b.id) }}
                      onInput={(md) => { const g = grid(); g[ri][ci] = md.replace(/\n/g, ' '); setRows(g, false) }}
                      onKeyDown={(e) => {
                        if (e.key === 'Tab') {
                          e.preventDefault()
                          let [r2, c2] = e.shiftKey ? [ri, ci - 1] : [ri, ci + 1]
                          if (c2 >= cols) { r2++; c2 = 0 }
                          if (c2 < 0) { r2--; c2 = cols - 1 }
                          if (r2 >= rows.length && !ctx.readOnly) { setRows([...grid(), Array(cols).fill('')]); r2 = rows.length }
                          if (r2 >= 0 && r2 <= rows.length) focusCell(r2, c2)
                        } else if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          if (ri + 1 < rows.length) focusCell(ri + 1, ci)
                          else ctx.after(b.id)
                        } else if (e.key === 'ArrowUp' && ri === 0) { e.preventDefault(); ctx.nav(b.id, 'up') } else if (e.key === 'ArrowDown' && ri === rows.length - 1) { e.preventDefault(); ctx.nav(b.id, 'down') }
                      }} />
                  </Cell>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {!ctx.readOnly && (
        <div className="doc-table-tools" role="toolbar" aria-label="Table">
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => { const g = grid(); g.splice(cur ? cur[0] + 1 : g.length, 0, Array(cols).fill('')); setRows(g) }} data-testid="table-add-row">+ Row</button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => { const at = cur ? cur[1] + 1 : cols; setRows(grid().map((r) => { const x = [...r]; x.splice(at, 0, ''); return x })) }} data-testid="table-add-col">+ Column</button>
          <button onMouseDown={(e) => e.preventDefault()} disabled={rows.length < 2} onClick={() => { const g = grid(); g.splice(cur ? cur[0] : g.length - 1, 1); setCur(null); setRows(g) }}>− Row</button>
          <button onMouseDown={(e) => e.preventDefault()} disabled={cols < 2} onClick={() => { const at = cur ? cur[1] : cols - 1; setCur(null); setRows(grid().map((r) => r.filter((_, k) => k !== at))) }}>− Column</button>
          <label className="doc-table-hdr"><input type="checkbox" checked={header} onChange={(e) => ctx.patch(b.id, { header: e.target.checked }, true)} /> Header row</label>
        </div>
      )}
    </div>
  )
}

function CellText({ value, onInput, onKeyDown, onFocus, readOnly, label, register, id }: {
  value: string; onInput: (md: string) => void; onKeyDown: (e: React.KeyboardEvent) => void; onFocus: () => void; readOnly: boolean; label: string
  register: (el: HTMLElement | null) => void; id: string
}) {
  return (
    <EditableText value={value} readOnly={readOnly} label={label} className="doc-cell" onInput={(md) => onInput(md)} onKeyDown={(e) => onKeyDown(e)} onFocus={onFocus}
      register={(el) => { if (el) el.dataset.cell = id; register(el) }} />
  )
}

function ImageBlock({ b, ctx }: { b: DocBlock; ctx: BlockCtx }) {
  const url = b.src ? ctx.imageUrl(b.src) : null
  return (
    <figure className="doc-image" tabIndex={0} ref={(el) => ctx.register(b.id, el)} onFocus={() => ctx.focus(b.id)} aria-label={b.alt ? `Image: ${b.alt}` : 'Image'}
      onKeyDown={(e) => {
        if (ctx.readOnly || e.target !== e.currentTarget) return
        if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); ctx.remove(b.id) } else if (e.key === 'Enter') { e.preventDefault(); ctx.after(b.id) } else if (e.key === 'ArrowUp') { e.preventDefault(); ctx.nav(b.id, 'up') } else if (e.key === 'ArrowDown') { e.preventDefault(); ctx.nav(b.id, 'down') }
      }}>
      {url ? <img src={url} alt={b.alt ?? ''} draggable={false} /> : <div className="doc-image-missing">{url === undefined ? 'Loading image…' : `Image not available: ${b.src ?? ''}`}</div>}
      <input className="doc-caption" value={b.alt ?? ''} placeholder="Add a caption" readOnly={ctx.readOnly} aria-label="Caption"
        onChange={(e) => ctx.patch(b.id, { alt: e.target.value || undefined })} />
    </figure>
  )
}

/** A block as read-only HTML (diff view, fading-out deleted blocks). */
export function BlockStatic({ b, num = 1, words }: { b: DocBlock; num?: number; words?: Array<{ t: 'same' | 'add' | 'del'; s: string }> }) {
  const html = (md: string): { __html: string } => ({ __html: inlineToHtml(md) })
  const body = words ? (
    <span className="doc-words">{words.map((w, i) => (w.t === 'same' ? <span key={i}>{w.s}</span> : w.t === 'add' ? <ins key={i}>{w.s}</ins> : <del key={i}>{w.s}</del>))}</span>
  ) : null
  const text = body ?? <span dangerouslySetInnerHTML={html(b.text ?? '')} />
  switch (b.type) {
    case 'h1': case 'h2': case 'h3': return <div className={`doc-text t-${b.type}`}>{text}</div>
    case 'p': return <div className="doc-text">{text}</div>
    case 'quote': return <div className="doc-quote"><div className="doc-text">{text}</div></div>
    case 'bullet': return <div className="doc-li"><span className="doc-marker">•</span><div className="doc-text">{text}</div></div>
    case 'numbered': return <div className="doc-li"><span className="doc-marker num">{num}.</span><div className="doc-text">{text}</div></div>
    case 'check': return <div className={`doc-li doc-check${b.checked ? ' done' : ''}`}><input type="checkbox" checked={!!b.checked} readOnly disabled /><div className="doc-text">{text}</div></div>
    case 'callout': return <div className={`doc-callout tone-${b.tone ?? 'info'}`}><span className="doc-callout-icon">{TONE_ICON[b.tone ?? 'info']}</span><div className="doc-text">{text}</div></div>
    case 'code': return <div className="doc-code"><pre>{body ?? b.text}</pre></div>
    case 'divider': return <div className="doc-divider"><hr /></div>
    case 'image': return <div className="doc-image-missing">Image{b.alt ? `: ${b.alt}` : ''} ({b.src})</div>
    case 'table': return (
      <table className={`doc-table${b.header !== false ? ' has-header' : ''}`}><tbody>
        {(b.rows ?? []).map((r, ri) => <tr key={ri}>{r.map((c, ci) => (ri === 0 && b.header !== false ? <th key={ci} dangerouslySetInnerHTML={html(c)} /> : <td key={ci} dangerouslySetInnerHTML={html(c)} />))}</tr>)}
      </tbody></table>
    )
  }
}
