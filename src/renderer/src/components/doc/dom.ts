import { escapeInline } from '../../../../main/docspace/inline'

// DOM helpers for the block editor: contentEditable HTML → inline Markdown, and caret positions measured
// in plain-text characters (a <br> counts as one).

const wrap = (inner: string, mark: string): string => {
  const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/)!
  return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : inner
}

function walk(node: Node, top: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeInline((node.textContent ?? '').replace(/ /g, ' ').replace(/​/g, ''))
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as HTMLElement
  const tag = el.tagName
  if (tag === 'BR') return '\n'
  const kids = (): string => [...el.childNodes].map((c) => walk(c, false)).join('')
  switch (tag) {
    case 'B': case 'STRONG': return wrap(kids(), '**')
    case 'I': case 'EM': return wrap(kids(), '*')
    case 'S': case 'STRIKE': case 'DEL': return wrap(kids(), '~~')
    case 'CODE': {
      const t = (el.textContent ?? '').replace(/ /g, ' ')
      if (!t) return ''
      const fence = t.includes('`') ? '``' : '`'
      return `${fence}${fence === '``' ? ` ${t} ` : t}${fence}`
    }
    case 'A': {
      const href = el.getAttribute('href') ?? ''
      const inner = kids()
      return href ? `[${inner}](${href.replace(/\)/g, '%29').replace(/\s/g, '%20')})` : inner
    }
    case 'DIV': case 'P': {
      const inner = kids()
      return top ? inner : `\n${inner}`
    }
    default: {
      // Chromium sometimes styles instead of tagging.
      const st = el.style
      let s = kids()
      if (st && (st.fontWeight === 'bold' || Number(st.fontWeight) >= 600)) s = wrap(s, '**')
      if (st && st.fontStyle === 'italic') s = wrap(s, '*')
      return s
    }
  }
}

/** The editable element's content as inline Markdown. */
export function htmlToInline(el: Node): string {
  const s = [...el.childNodes].map((c, k) => {
    const out = walk(c, false)
    // A leading block element doesn't start with a line break.
    return k === 0 && out.startsWith('\n') && (c as HTMLElement).tagName && /^(DIV|P)$/.test((c as HTMLElement).tagName) ? out.slice(1) : out
  }).join('')
  // A lone trailing <br> is Chromium's placeholder, not a line break.
  return s.replace(/\n$/, '')
}

/** Plain-text length of a node (a <br> counts as one). */
export function textLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').length
  if ((node as HTMLElement).tagName === 'BR') return 1
  let n = 0
  node.childNodes.forEach((c) => { n += textLength(c) })
  return n
}

/** The caret's plain-text offset inside `el` (selection start), or null if the selection isn't in it. */
export function caretOffset(el: HTMLElement, end = false): number | null {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return null
  const r = sel.getRangeAt(0)
  const node = end ? r.endContainer : r.startContainer
  const off = end ? r.endOffset : r.startOffset
  if (!el.contains(node)) return null
  const pre = document.createRange()
  pre.selectNodeContents(el)
  pre.setEnd(node, off)
  const frag = pre.cloneContents()
  return textLength(frag)
}

/** A DOM position for a plain-text offset. */
function locate(el: HTMLElement, offset: number): { node: Node; offset: number } {
  let left = Math.max(0, offset)
  const stack: Node[] = [...el.childNodes].reverse()
  let lastText: Node | null = null
  while (stack.length) {
    const n = stack.pop()!
    if (n.nodeType === Node.TEXT_NODE) {
      const len = (n.textContent ?? '').length
      if (left <= len) return { node: n, offset: left }
      left -= len
      lastText = n
    } else if ((n as HTMLElement).tagName === 'BR') {
      if (left === 0) {
        const parent = n.parentNode!
        return { node: parent, offset: [...parent.childNodes].indexOf(n as ChildNode) }
      }
      left -= 1
    } else stack.push(...[...n.childNodes].reverse())
  }
  if (lastText) return { node: lastText, offset: (lastText.textContent ?? '').length }
  return { node: el, offset: el.childNodes.length }
}

export function setCaret(el: HTMLElement, offset: number | 'start' | 'end'): void {
  const sel = window.getSelection()
  if (!sel) return
  const total = textLength(el)
  const at = offset === 'start' ? 0 : offset === 'end' ? total : Math.min(offset, total)
  const p = locate(el, at)
  const r = document.createRange()
  r.setStart(p.node, p.offset)
  r.collapse(true)
  sel.removeAllRanges()
  sel.addRange(r)
}

export function isCollapsed(): boolean {
  const sel = window.getSelection()
  return !sel || sel.isCollapsed
}

/** Splits the element's content at the caret: Markdown before and after (the element keeps "before"). */
export function splitAtCaret(el: HTMLElement): { before: string; after: string } {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount || !el.contains(sel.getRangeAt(0).startContainer)) return { before: htmlToInline(el), after: '' }
  const r = sel.getRangeAt(0)
  if (!r.collapsed) r.deleteContents()
  const tail = document.createRange()
  tail.setStart(r.startContainer, r.startOffset)
  tail.setEnd(el, el.childNodes.length)
  const frag = tail.extractContents()
  const box = document.createElement('div')
  box.appendChild(frag)
  return { before: htmlToInline(el), after: htmlToInline(box) }
}

/** Removes the first `n` plain-text characters (a Markdown shortcut's prefix). */
export function deleteLeading(el: HTMLElement, n: number): void {
  const a = locate(el, 0)
  const b = locate(el, n)
  const r = document.createRange()
  r.setStart(a.node, a.offset)
  r.setEnd(b.node, b.offset)
  r.deleteContents()
}

/** The caret is on the element's first (or last) visual line. */
export function caretOnEdgeLine(el: HTMLElement, edge: 'first' | 'last'): boolean {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return true
  const r = sel.getRangeAt(0).cloneRange()
  r.collapse(edge === 'first')
  let rect = r.getClientRects()[0] ?? r.getBoundingClientRect()
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    // An empty line has no rect: fall back to the text offset.
    const off = caretOffset(el) ?? 0
    return edge === 'first' ? off === 0 || !el.textContent?.slice(0, off).includes('\n') : off >= textLength(el)
  }
  const box = el.getBoundingClientRect()
  const line = parseFloat(getComputedStyle(el).lineHeight) || 22
  if (edge === 'first') return rect.top - box.top < line * 0.9
  rect = rect as DOMRect
  return box.bottom - rect.bottom < line * 0.9
}

/** Plain text of the current selection inside `root` (empty if none). */
export function selectionTextIn(root: HTMLElement): { text: string; rect: DOMRect } | null {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null
  const r = sel.getRangeAt(0)
  if (!root.contains(r.commonAncestorContainer)) return null
  const text = sel.toString().trim()
  if (!text) return null
  return { text, rect: r.getBoundingClientRect() }
}
