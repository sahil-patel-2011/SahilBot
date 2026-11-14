import { marked, type Token, type Tokens } from 'marked'

// The document model every generator shares: a flat list of blocks with inline spans. Markdown is parsed
// into it (with a few extensions: [TOC], page breaks, landscape sections, footnotes, captions, callouts),
// and structured input (the live editor, templates, tools) builds it directly.
//
// Markdown extensions:
//   [TOC]  or  [[toc]]  or  <!-- toc -->           table of contents
//   <!-- pagebreak -->  or  \pagebreak  or  \newpage    page break
//   <!-- landscape -->  /  <!-- portrait -->           start a new section in that orientation
//   text[^1]  …  [^1]: The footnote text.              footnotes
//   ![alt](path/to/image.png "Caption")               image (alone in its paragraph) with a caption
//   Table: Caption  or  Figure 2: Caption             caption paragraph
//   > [!NOTE] text   (NOTE, TIP, IMPORTANT, WARNING, CAUTION)   callout box

export interface Span {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  code?: boolean
  link?: string
  /** A footnote reference: the id of an entry in the document's footnotes (text is ignored). */
  footnote?: string
  /** A line break before this span's text. */
  break?: boolean
}

/** Inline text: a string (inline Markdown allowed: **bold**, *italic*, `code`, [link](url), [^note]) or spans. */
export type RichText = string | Span[]

export interface ListItem {
  text: RichText
  items?: ListItem[]
  checked?: boolean
}

export type Cell = string | number | boolean | null

export type DocBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: RichText }
  | { type: 'paragraph'; text: RichText; style?: 'normal' | 'title' | 'lead' | 'caption' | 'subtitle' | 'small'; align?: 'left' | 'center' | 'right' | 'justify' }
  | { type: 'list'; ordered?: boolean; items: Array<string | ListItem> }
  | { type: 'table'; header?: Cell[]; rows: Cell[][]; widths?: number[]; align?: Array<'left' | 'center' | 'right' | null>; caption?: string; banded?: boolean; total_row?: boolean; variant?: 'grid' | 'plain' }
  | { type: 'image'; src: string; width?: number; height?: number; caption?: string; alt?: string }
  | { type: 'quote'; text: RichText; cite?: string }
  | { type: 'callout'; text: RichText; tone?: 'note' | 'tip' | 'important' | 'warning' | 'caution' }
  | { type: 'code'; text: string; lang?: string }
  | { type: 'page_break' }
  | { type: 'toc'; title?: string; levels?: number }
  | { type: 'section'; orientation?: 'portrait' | 'landscape' }
  | { type: 'hr' }

export interface ParsedDoc {
  blocks: DocBlock[]
  footnotes: Record<string, string>
}

export function unescapeHtml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

// ------------------------------------------------------------------ inline

type Style = Omit<Span, 'text'>

function inlineTokens(tokens: Token[] | undefined, style: Style = {}): Span[] {
  const out: Span[] = []
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong': out.push(...inlineTokens((t as Tokens.Strong).tokens, { ...style, bold: true })); break
      case 'em': out.push(...inlineTokens((t as Tokens.Em).tokens, { ...style, italic: true })); break
      case 'del': out.push(...inlineTokens((t as Tokens.Del).tokens, { ...style, strike: true })); break
      case 'codespan': out.push({ ...style, text: unescapeHtml((t as Tokens.Codespan).text), code: true }); break
      case 'link': {
        const l = t as Tokens.Link
        const inner = inlineTokens(l.tokens, { ...style, link: l.href })
        out.push(...(inner.length ? inner : [{ ...style, text: l.text, link: l.href }]))
        break
      }
      case 'image': out.push({ ...style, text: (t as Tokens.Image).text }); break
      case 'br': out.push({ ...style, text: '', break: true }); break
      case 'html': {
        const raw = (t as Tokens.HTML).raw
        if (/^<br\s*\/?>$/i.test(raw.trim())) out.push({ ...style, text: '', break: true })
        else if (/^<\/?u>$/i.test(raw.trim())) { /* underline tags are dropped; text keeps flowing */ }
        else out.push({ ...style, text: raw.replace(/<[^>]+>/g, '') })
        break
      }
      case 'text': case 'escape': {
        const tt = t as Tokens.Text
        if (tt.tokens?.length) out.push(...inlineTokens(tt.tokens, style))
        else out.push(...footnoteSplit(unescapeHtml(tt.text), style))
        break
      }
      default: out.push({ ...style, text: unescapeHtml((t as { raw?: string }).raw ?? '') })
    }
  }
  return out
}

function footnoteSplit(text: string, style: Style): Span[] {
  const out: Span[] = []
  let last = 0
  for (const m of text.matchAll(/\[\^([^\]\s]+)\]/g)) {
    if (m.index! > last) out.push({ ...style, text: text.slice(last, m.index) })
    out.push({ text: '', footnote: m[1] })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ ...style, text: text.slice(last) })
  return out
}

/** Inline spans for rich text (strings are parsed as inline Markdown). */
export function spansOf(text: RichText | number | boolean | null | undefined): Span[] {
  if (text === null || text === undefined) return []
  if (Array.isArray(text)) return text
  const s = String(text)
  if (!/[*_`[\]<~\\&]/.test(s)) return s ? [{ text: s }] : []
  return mergeSpans(inlineTokens(marked.Lexer.lexInline(s)))
}

function mergeSpans(spans: Span[]): Span[] {
  const out: Span[] = []
  for (const s of spans) {
    const p = out[out.length - 1]
    const same = p && !s.break && !s.footnote && !p.footnote && (['bold', 'italic', 'underline', 'strike', 'code', 'link'] as const).every((k) => p[k] === s[k])
    if (same) p.text += s.text
    else if (s.text || s.break || s.footnote) out.push({ ...s })
  }
  return out
}

/** The plain text of rich text (footnote marks dropped). */
export function plainText(text: RichText | Cell | undefined): string {
  if (text === null || text === undefined) return ''
  if (typeof text === 'number' || typeof text === 'boolean') return String(text)
  return spansOf(text).map((s) => (s.break ? `\n${s.text}` : s.text)).join('')
}

// ------------------------------------------------------------------ block parse

const TOC_LINE = /^\s*(\[TOC\]|\[\[_?toc_?\]\]|<!--\s*toc\s*-->)\s*$/i
const BREAK_LINE = /^\s*(<!--\s*page-?break\s*-->|\\pagebreak|\\newpage|---\s*pagebreak\s*---)\s*$/i
const ORIENT_LINE = /^\s*<!--\s*(landscape|portrait)\s*-->\s*$/i
const CAPTION = /^(table|figure|fig\.|chart|exhibit)\s*\d*[a-z]?\s*[:.–—-]\s+\S/i

/** Parses Markdown (with the extensions above) into blocks and footnotes. */
export function parseMarkdown(md: string): ParsedDoc {
  const footnotes: Record<string, string> = {}
  // Footnote definitions (with indented continuation lines) come out before marked sees them.
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^\[\^([^\]\s]+)\]:\s*(.*)$/.exec(lines[i])
    if (!m) { kept.push(lines[i]); continue }
    let text = m[2]
    while (i + 1 < lines.length && /^( {2,}|\t)\S/.test(lines[i + 1])) text += ` ${lines[++i].trim()}`
    footnotes[m[1]] = text.trim()
  }
  // Marker lines become placeholder paragraphs marked lexes on their own.
  const src = kept.map((l) => (TOC_LINE.test(l) ? '\n§§TOC§§\n' : BREAK_LINE.test(l) ? '\n§§BREAK§§\n' : ORIENT_LINE.test(l) ? `\n§§${ORIENT_LINE.exec(l)![1].toUpperCase()}§§\n` : l)).join('\n')

  const blocks: DocBlock[] = []
  const listItems = (l: Tokens.List): ListItem[] => l.items.map((item) => {
    const para = item.tokens.find((x) => x.type === 'text' || x.type === 'paragraph') as Tokens.Text | undefined
    const sub = item.tokens.filter((x) => x.type === 'list') as Tokens.List[]
    const text = mergeSpans(para ? inlineTokens(para.tokens ?? [{ type: 'text', raw: para.text, text: para.text } as Tokens.Text]) : [{ text: item.text }])
    return { text, ...(sub.length ? { items: sub.flatMap(listItems) } : {}), ...(item.task ? { checked: !!item.checked } : {}) }
  })
  const walk = (tokens: Token[]): void => {
    for (const t of tokens) {
      switch (t.type) {
        case 'heading': {
          const h = t as Tokens.Heading
          blocks.push({ type: 'heading', level: Math.min(4, h.depth) as 1 | 2 | 3 | 4, text: mergeSpans(inlineTokens(h.tokens)) })
          break
        }
        case 'paragraph': {
          const p = t as Tokens.Paragraph
          const raw = p.text.trim()
          if (raw === '§§TOC§§') { blocks.push({ type: 'toc' }); break }
          if (raw === '§§BREAK§§') { blocks.push({ type: 'page_break' }); break }
          if (raw === '§§LANDSCAPE§§' || raw === '§§PORTRAIT§§') { blocks.push({ type: 'section', orientation: raw === '§§LANDSCAPE§§' ? 'landscape' : 'portrait' }); break }
          const toks = (p.tokens ?? []).filter((x) => !(x.type === 'text' && !(x as Tokens.Text).text.trim()))
          if (toks.length === 1 && toks[0].type === 'image') {
            const im = toks[0] as Tokens.Image
            blocks.push({ type: 'image', src: im.href, alt: im.text || undefined, caption: im.title || undefined })
            break
          }
          const spans = mergeSpans(inlineTokens(p.tokens))
          const text = plainText(spans)
          const italicOnly = spans.length > 0 && spans.every((s) => s.italic || !s.text.trim())
          if (CAPTION.test(text) && (italicOnly || /^(table|figure)\s*\d*\s*:/i.test(text))) blocks.push({ type: 'paragraph', style: 'caption', text: spans.map((s) => ({ ...s, italic: undefined })) })
          else blocks.push({ type: 'paragraph', text: spans })
          break
        }
        case 'list': {
          const l = t as Tokens.List
          blocks.push({ type: 'list', ordered: l.ordered, items: listItems(l) })
          break
        }
        case 'blockquote': {
          const q = t as Tokens.Blockquote
          const alert = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(q.text)
          const inner = q.tokens.filter((x) => x.type === 'paragraph') as Tokens.Paragraph[]
          const spans = mergeSpans(inner.flatMap((x, i) => [...(i ? [{ text: '', break: true }] : []), ...inlineTokens(x.tokens)]))
          if (alert) {
            if (spans[0]) spans[0] = { ...spans[0], text: spans[0].text.replace(/^\s*\[!\w+\]\s*/, '') }
            blocks.push({ type: 'callout', tone: alert[1].toLowerCase() as 'note', text: spans.filter((s) => s.text || s.footnote || s.break) })
          } else {
            const last = plainText(spans)
            const cite = /\n\s*[—–-]{1,2}\s*([^\n]+)$/.exec(last)
            blocks.push({ type: 'quote', text: spans, ...(cite ? { cite: cite[1].trim() } : {}) })
          }
          break
        }
        case 'code': {
          const c = t as Tokens.Code
          blocks.push({ type: 'code', text: c.text, ...(c.lang ? { lang: c.lang } : {}) })
          break
        }
        case 'hr': blocks.push({ type: 'hr' }); break
        case 'table': {
          const tb = t as Tokens.Table
          const cell = (c: Tokens.TableCell): Cell => c.text
          blocks.push({ type: 'table', header: tb.header.map(cell), rows: tb.rows.map((r) => r.map(cell)), align: tb.align.map((a) => a ?? null) })
          break
        }
        case 'html': {
          const raw = (t as Tokens.HTML).raw.trim()
          if (/^<br\s*\/?>$/i.test(raw) || !raw.replace(/<!--[\s\S]*?-->/g, '').trim()) break
          blocks.push({ type: 'paragraph', text: raw.replace(/<[^>]+>/g, '') })
          break
        }
        case 'space': break
        default: {
          const raw = (t as { text?: string; raw?: string }).text ?? (t as { raw?: string }).raw ?? ''
          if (raw.trim()) blocks.push({ type: 'paragraph', text: raw.trim() })
        }
      }
    }
  }
  walk(marked.lexer(src))
  // A caption paragraph right before or after a table belongs to it.
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.type !== 'table' || b.caption) continue
    const prev = blocks[i - 1], next = blocks[i + 1]
    const isTableCaption = (x: DocBlock | undefined): x is Extract<DocBlock, { type: 'paragraph' }> => x?.type === 'paragraph' && x.style === 'caption' && /^table/i.test(plainText(x.text))
    const cap = (x: Extract<DocBlock, { type: 'paragraph' }>) => plainText(x.text).replace(/^table\s*[:.–—-]\s*/i, '')
    if (isTableCaption(prev)) { b.caption = cap(prev); blocks.splice(i - 1, 1); i-- }
    else if (isTableCaption(next)) { b.caption = cap(next); blocks.splice(i + 1, 1) }
  }
  return { blocks, footnotes }
}

/** Normalizes the `string | ListItem` entries of a list block. */
export function listItem(i: string | ListItem): ListItem {
  return typeof i === 'string' ? { text: i } : i
}

// ------------------------------------------------------------------ back to Markdown

function spansToMd(text: RichText): string {
  if (typeof text === 'string') return text
  return text.map((s) => {
    if (s.footnote) return `[^${s.footnote}]`
    let t = s.code ? `\`${s.text}\`` : s.text
    if (s.bold && t.trim()) t = `**${t}**`
    if (s.italic && t.trim()) t = `*${t}*`
    if (s.strike && t.trim()) t = `~~${t}~~`
    if (s.link) t = `[${t}](${s.link})`
    return (s.break ? '  \n' : '') + t
  }).join('')
}

const cellMd = (c: Cell): string => (c === null || c === undefined ? '' : String(c).replace(/\|/g, '\\|').replace(/\n/g, ' '))

/** Markdown for blocks (round-trips through parseMarkdown). */
export function blocksToMarkdown(blocks: DocBlock[], footnotes: Record<string, string> = {}): string {
  const out: string[] = []
  const list = (items: Array<string | ListItem>, ordered: boolean, depth: number): string[] =>
    items.flatMap((raw, i) => {
      const it = listItem(raw)
      const mark = ordered ? `${i + 1}.` : '-'
      const box = it.checked === undefined ? '' : it.checked ? '[x] ' : '[ ] '
      return [`${'   '.repeat(depth)}${mark} ${box}${spansToMd(it.text)}`, ...(it.items ? list(it.items, false, depth + 1) : [])]
    })
  for (const b of blocks) {
    switch (b.type) {
      case 'heading': out.push(`${'#'.repeat(b.level)} ${spansToMd(b.text)}`); break
      case 'paragraph': out.push(spansToMd(b.text)); break
      case 'list': out.push(list(b.items, !!b.ordered, 0).join('\n')); break
      case 'table': {
        const header = b.header ?? b.rows[0]?.map(() => '') ?? []
        const n = Math.max(header.length, ...b.rows.map((r) => r.length))
        const pad = (r: Cell[]) => Array.from({ length: n }, (_, i) => cellMd(r[i] ?? null))
        const al = Array.from({ length: n }, (_, i) => (b.align?.[i] === 'right' ? '---:' : b.align?.[i] === 'center' ? ':---:' : '---'))
        out.push([`| ${pad(header).join(' | ')} |`, `| ${al.join(' | ')} |`, ...b.rows.map((r) => `| ${pad(r).join(' | ')} |`)].join('\n') + (b.caption ? `\n\nTable: ${b.caption.replace(/^table\s*\d*\s*[:.]\s*/i, '')}` : ''))
        break
      }
      case 'image': out.push(`![${b.alt ?? ''}](${b.src}${b.caption ? ` "${b.caption.replace(/"/g, "'")}"` : ''})`); break
      case 'quote': out.push(spansToMd(b.text).split('\n').map((l) => `> ${l}`).join('\n') + (b.cite ? `\n>\n> — ${b.cite}` : '')); break
      case 'callout': out.push(`> [!${(b.tone ?? 'note').toUpperCase()}] ${spansToMd(b.text)}`); break
      case 'code': out.push(`\`\`\`${b.lang ?? ''}\n${b.text}\n\`\`\``); break
      case 'page_break': out.push('<!-- pagebreak -->'); break
      case 'toc': out.push('[TOC]'); break
      case 'section': out.push(`<!-- ${b.orientation ?? 'portrait'} -->`); break
      case 'hr': out.push('---'); break
    }
  }
  const notes = Object.entries(footnotes).map(([id, t]) => `[^${id}]: ${t}`)
  return [...out, ...(notes.length ? [notes.join('\n')] : [])].join('\n\n') + '\n'
}

// ------------------------------------------------------------------ HTML (PDF export, previews)

function spansToHtml(text: RichText, notes: Map<string, number>): string {
  return spansOf(text).map((s) => {
    if (s.footnote) {
      const n = notes.get(s.footnote) ?? (notes.set(s.footnote, notes.size + 1), notes.size)
      return `<sup class="fn"><a href="#fn-${n}">${n}</a></sup>`
    }
    let t = escapeHtml(s.text)
    if (s.code) t = `<code>${t}</code>`
    if (s.bold) t = `<strong>${t}</strong>`
    if (s.italic) t = `<em>${t}</em>`
    if (s.underline) t = `<u>${t}</u>`
    if (s.strike) t = `<del>${t}</del>`
    if (s.link && /^(https?:|mailto:|#)/i.test(s.link)) t = `<a href="${escapeHtml(s.link)}">${t}</a>`
    return (s.break ? '<br>' : '') + t
  }).join('')
}

export const slugId = (s: string, used: Set<string>): string => {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'section'
  let id = base
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`
  used.add(id)
  return id
}

/**
 * Body HTML for blocks: headings get ids, [TOC] lists them, footnotes collect at the end, landscape
 * sections use the named page "landscape". `image` resolves an image src to a data: URI (or undefined to drop it).
 */
export function blocksToHtml(blocks: DocBlock[], o: { footnotes?: Record<string, string>; image?: (src: string) => string | undefined } = {}): string {
  const notes = new Map<string, number>()
  const used = new Set<string>()
  const ids = blocks.map((b) => (b.type === 'heading' ? slugId(plainText(b.text), used) : ''))
  const heads = blocks.map((b, i) => (b.type === 'heading' ? { level: b.level, text: plainText(b.text), id: ids[i] } : null)).filter(Boolean) as Array<{ level: number; text: string; id: string }>
  const listHtml = (items: Array<string | ListItem>, ordered: boolean): string =>
    `<${ordered ? 'ol' : 'ul'}>${items.map((raw) => { const it = listItem(raw); return `<li>${it.checked === undefined ? '' : it.checked ? '☑ ' : '☐ '}${spansToHtml(it.text, notes)}${it.items ? listHtml(it.items, false) : ''}</li>` }).join('')}</${ordered ? 'ol' : 'ul'}>`
  const parts: string[] = []
  let landscape = false
  parts.push('<div class="sec">')
  blocks.forEach((b, i) => {
    switch (b.type) {
      case 'heading': parts.push(`<h${b.level} id="${ids[i]}">${spansToHtml(b.text, notes)}</h${b.level}>`); break
      case 'paragraph': parts.push(`<p class="${b.style ?? 'normal'}"${b.align ? ` style="text-align:${b.align}"` : ''}>${spansToHtml(b.text, notes)}</p>`); break
      case 'list': parts.push(listHtml(b.items, !!b.ordered)); break
      case 'table': {
        const n = Math.max(b.header?.length ?? 0, ...b.rows.map((r) => r.length))
        const al = (c: number) => (b.align?.[c] ? ` style="text-align:${b.align[c]}"` : '')
        const row = (r: Cell[], tag: 'th' | 'td') => `<tr>${Array.from({ length: n }, (_, c) => `<${tag}${al(c)}>${spansToHtml(r[c] === null || r[c] === undefined ? '' : String(r[c]), notes)}</${tag}>`).join('')}</tr>`
        parts.push(`${b.caption ? `<p class="caption">${escapeHtml(b.caption)}</p>` : ''}<table class="${b.banded === false ? '' : 'banded'}${b.total_row ? ' total' : ''}">${b.widths ? `<colgroup>${b.widths.map((w) => `<col style="width:${w}%">`).join('')}</colgroup>` : ''}${b.header ? `<thead>${row(b.header, 'th')}</thead>` : ''}<tbody>${b.rows.map((r) => row(r, 'td')).join('')}</tbody></table>`)
        break
      }
      case 'image': {
        const src = o.image?.(b.src)
        if (src) parts.push(`<figure><img src="${src}" alt="${escapeHtml(b.alt ?? '')}"${b.width ? ` style="width:${b.width}px"` : ''}>${b.caption ? `<figcaption class="caption">${escapeHtml(b.caption)}</figcaption>` : ''}</figure>`)
        break
      }
      case 'quote': parts.push(`<blockquote>${spansToHtml(b.text, notes)}${b.cite && !plainText(b.text).includes(b.cite) ? `<cite>— ${escapeHtml(b.cite)}</cite>` : ''}</blockquote>`); break
      case 'callout': parts.push(`<div class="callout ${b.tone ?? 'note'}">${spansToHtml(b.text, notes)}</div>`); break
      case 'code': parts.push(`<pre><code>${escapeHtml(b.text)}</code></pre>`); break
      case 'page_break': parts.push('<div class="pb"></div>'); break
      case 'toc': parts.push(`<nav class="toc"><p class="toc-title">${escapeHtml(b.title ?? 'Contents')}</p>${heads.filter((h) => h.level <= (b.levels ?? 3)).map((h) => `<a class="l${h.level}" href="#${h.id}">${escapeHtml(h.text)}</a>`).join('')}</nav>`); break
      case 'section': {
        const want = b.orientation === 'landscape'
        if (want !== landscape) { landscape = want; parts.push(`</div><div class="sec${want ? ' landscape' : ''}">`) }
        break
      }
      case 'hr': parts.push('<hr>'); break
    }
  })
  parts.push('</div>')
  if (notes.size) {
    const fn = o.footnotes ?? {}
    parts.push(`<section class="footnotes"><hr><ol>${[...notes.entries()].map(([id, n]) => `<li id="fn-${n}">${spansToHtml(fn[id] ?? `(missing footnote "${id}")`, new Map())}</li>`).join('')}</ol></section>`)
  }
  return parts.join('\n')
}
