import { marked, type Token, type Tokens } from 'marked'
import type { ChartSpec } from './chart'

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
//   ```chart  {"type": "column", "categories": [...], "series": [{"name", "values"}]}  ```   a chart (JSON)

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
  | { type: 'chart'; chart: ChartSpec; caption?: string }
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

/** A chart spec from a ```chart fence (JSON; a trailing comma or single quotes are forgiven). */
export function parseChart(text: string): ChartSpec | undefined {
  const tries = [text, text.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"')]
  for (const t of tries) {
    try {
      const c = JSON.parse(t) as ChartSpec
      if (c && typeof c === 'object' && Array.isArray(c.categories) && Array.isArray(c.series)) return { ...c, type: (c.type ?? 'column') as ChartSpec['type'] }
    } catch { /* next */ }
  }
  return undefined
}

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
          const chart = /^(chart|graph)$/i.test(c.lang ?? '') ? parseChart(c.text) : undefined
          if (chart) blocks.push({ type: 'chart', chart, ...(chart.caption ? { caption: chart.caption } : {}) })
          else blocks.push({ type: 'code', text: c.text, ...(c.lang ? { lang: c.lang } : {}) })
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
  // A "Figure: …" caption right after a chart belongs to it.
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i], next = blocks[i + 1]
    if (b.type === 'chart' && !b.caption && next?.type === 'paragraph' && next.style === 'caption' && /^(figure|fig\.|chart|exhibit)/i.test(plainText(next.text))) {
      b.caption = plainText(next.text).replace(/^(figure|fig\.|chart|exhibit)\s*[:.–—-]\s*/i, '')
      blocks.splice(i + 1, 1)
    }
  }
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
      case 'chart': out.push(`\`\`\`chart\n${JSON.stringify({ ...b.chart, ...(b.caption ? { caption: b.caption } : {}) })}\n\`\`\``); break
      case 'page_break': out.push('<!-- pagebreak -->'); break
      case 'toc': out.push('[TOC]'); break
      case 'section': out.push(`<!-- ${b.orientation ?? 'portrait'} -->`); break
      case 'hr': out.push('---'); break
    }
  }
  const notes = Object.entries(footnotes).map(([id, t]) => `[^${id}]: ${t}`)
  return [...out, ...(notes.length ? [notes.join('\n')] : [])].join('\n\n') + '\n'
}

// ------------------------------------------------------------------ typography

/**
 * Typographer's quotes and dashes for prose: "x" → “x”, it's → it’s, -- → –, --- → —, ... → …. `prev` is the
 * character before the text (spans are converted in sequence so quotes after bold text open or close right).
 */
export function smartQuotes(text: string, prev = ' '): string {
  let out = ''
  const t = text.replace(/---/g, '—').replace(/(^|\s)--(?=\s|$)/g, '$1–').replace(/(\d)--(\d)/g, '$1–$2').replace(/\.\.\.(?!\.)/g, '…')
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    const before = i ? t[i - 1] : prev
    const opening = /[\s([{—–/-]/.test(before) || before === ''
    if (c === '"') out += opening ? '“' : '”'
    else if (c === "'") out += opening && !/^\d\ds\b/.test(t.slice(i + 1, i + 4)) ? '‘' : '’'
    else out += c
  }
  return out
}

/** Spans with typographer's quotes (code and links' URLs untouched). */
export function smartSpans(spans: Span[]): Span[] {
  let prev = ' '
  return spans.map((s) => {
    if (s.footnote || s.code) { prev = s.code ? 'x' : prev; return s }
    const text = smartQuotes(s.text, s.break ? ' ' : prev)
    if (text) prev = text[text.length - 1]
    return text === s.text ? s : { ...s, text }
  })
}

const NUMERIC_CELL = /^\s*[-+−(]?\s*[$€£¥]?\s*[-+−]?\d[\d,]*(\.\d+)?\s*(%|pp|pts?|x|×|[kmb]|bn|mm)?\s*[)]?\s*$/i

/** Columns whose body cells are all numbers (or blank / dashes): they're right-aligned with tabular figures. */
export function numericColumns(header: Cell[] | undefined, rows: Cell[][]): boolean[] {
  const n = Math.max(header?.length ?? 0, ...rows.map((r) => r.length))
  return Array.from({ length: n }, (_, c) => {
    const vals = rows.map((r) => r[c]).filter((v) => v !== null && v !== undefined && plainText(v).trim() !== '' && !/^[-–—−]$|^n\/?a$/i.test(plainText(v).trim()))
    return vals.length > 0 && vals.every((v) => typeof v === 'number' || NUMERIC_CELL.test(plainText(v)))
  })
}

/** Row kinds for table styling: a "Total"/"Subtotal" row (by its first cell, or the table's total_row flag). */
export function rowKind(b: Extract<DocBlock, { type: 'table' }>, i: number): 'total' | 'subtotal' | 'body' {
  const first = plainText(b.rows[i]?.[0] ?? '').trim()
  if (/^(grand\s+)?total\b|^total due\b|^net\b/i.test(first)) return 'total'
  if (/^sub-?total\b/i.test(first)) return 'subtotal'
  if (b.total_row && i === b.rows.length - 1) return 'total'
  return 'body'
}

// ------------------------------------------------------------------ HTML (PDF export, previews)

function spansToHtml(text: RichText, notes: Map<string, number>, smart = false): string {
  const spans = spansOf(text)
  return (smart ? smartSpans(spans) : spans).map((s) => {
    if (s.footnote) {
      const n = notes.get(s.footnote) ?? (notes.set(s.footnote, notes.size + 1), notes.size)
      return `<sup class="fn"><a href="#fn-${n}" id="fnref-${n}">${n}</a></sup>`
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

export interface HtmlOptions {
  footnotes?: Record<string, string>
  /** Resolves an image src to a data: URI (or undefined to drop it). */
  image?: (src: string) => string | undefined
  /** Draws a chart block (SVG); without it charts are left out. */
  chart?: (c: ChartSpec) => string
  /** Typographer's quotes and dashes in prose. */
  smart?: boolean
  /** "Table 1.", "Figure 2." numbering on captions. */
  numbering?: boolean
  /** Page numbers for TOC entries by heading id (the PDF's second pass fills them in). */
  tocPages?: Record<string, string>
  /** Heading for the footnotes list (default none: a rule above the notes). */
  notesTitle?: string
  /** "Role — Org | 2021 – Present" headings (level 3+) get the part after " | " set at the right margin. */
  sideHeads?: boolean
}

/** The headings a TOC lists, with their ids, in order. */
export function headingIds(blocks: DocBlock[]): Array<{ level: number; text: string; id: string; index: number }> {
  const used = new Set<string>()
  const out: Array<{ level: number; text: string; id: string; index: number }> = []
  blocks.forEach((b, i) => { if (b.type === 'heading') out.push({ level: b.level, text: plainText(b.text), id: slugId(plainText(b.text), used), index: i }) })
  return out
}

/**
 * Body HTML for blocks: headings get ids, [TOC] lists them, footnotes collect at the end, landscape
 * sections use the named page "landscape", numeric table columns are marked "num".
 */
export function blocksToHtml(blocks: DocBlock[], o: HtmlOptions = {}): string {
  const notes = new Map<string, number>()
  const heads = headingIds(blocks)
  const idAt = new Map(heads.map((h) => [h.index, h.id]))
  const sp = (t: RichText) => spansToHtml(t, notes, o.smart)
  const listHtml = (items: Array<string | ListItem>, ordered: boolean): string =>
    `<${ordered ? 'ol' : 'ul'}${items.some((x) => listItem(x).checked !== undefined) ? ' class="tasks"' : ''}>${items.map((raw) => { const it = listItem(raw); return `<li${it.checked === undefined ? '' : ` class="${it.checked ? 'done' : 'todo'}"`}>${it.checked === undefined ? '' : it.checked ? '<span class="box">☑</span> ' : '<span class="box">☐</span> '}${sp(it.text)}${it.items ? listHtml(it.items, false) : ''}</li>` }).join('')}</${ordered ? 'ol' : 'ul'}>`
  const parts: string[] = []
  let landscape = false, tableNo = 0, figureNo = 0
  const cap = (kind: 'Table' | 'Figure', text: string, n: number): string => {
    const clean = text.replace(new RegExp(`^${kind === 'Table' ? 'table' : '(figure|fig\\.|chart|exhibit)'}\\s*\\d*[a-z]?\\s*[:.–—-]\\s*`, 'i'), '')
    const has = new RegExp(`^${kind === 'Table' ? 'table' : '(figure|fig\\.|exhibit)'}\\s*\\d+`, 'i').test(text)
    return o.numbering && !has ? `<span class="cap-n">${kind} ${n}.</span> ${escapeHtml(o.smart ? smartQuotes(clean) : clean)}` : escapeHtml(o.smart ? smartQuotes(text) : text)
  }
  parts.push('<div class="sec">')
  blocks.forEach((b, i) => {
    switch (b.type) {
      case 'heading': {
        const side = o.sideHeads && b.level >= 3 ? /^(.*\S)\s+\|\s+(.+)$/.exec(plainText(b.text)) : null
        if (side) {
          const role = /^(.*?)\s+([—–]|-{1,2})\s+(.+)$/.exec(side[1])
          const main = role ? `<span class="h-role">${escapeHtml(smartQuotes(role[1]))}</span><span class="h-org"> — ${escapeHtml(smartQuotes(role[3]))}</span>` : `<span class="h-role">${escapeHtml(smartQuotes(side[1]))}</span>`
          parts.push(`<h${b.level} id="${idAt.get(i)}" class="side"><span class="h-main">${main}</span><span class="h-side">${escapeHtml(smartQuotes(side[2]))}</span></h${b.level}>`)
        } else parts.push(`<h${b.level} id="${idAt.get(i)}">${sp(b.text)}</h${b.level}>`)
        break
      }
      case 'paragraph': parts.push(`<p class="${b.style ?? 'normal'}"${b.align ? ` style="text-align:${b.align}"` : ''}>${sp(b.text)}</p>`); break
      case 'list': parts.push(listHtml(b.items, !!b.ordered)); break
      case 'table': {
        const hasHeader = !!b.header && b.header.some((c) => plainText(c).trim() !== '')
        const n = Math.max(b.header?.length ?? 0, ...b.rows.map((r) => r.length))
        const num = numericColumns(b.header, b.rows)
        const al = (c: number) => b.align?.[c] ?? (num[c] ? 'right' : null)
        const cls = (c: number) => { const a = al(c); return a === 'right' ? ' class="r"' : a === 'center' ? ' class="c"' : '' }
        const row = (r: Cell[], tag: 'th' | 'td', kind = 'body') => `<tr${kind !== 'body' ? ` class="${kind}"` : ''}>${Array.from({ length: n }, (_, c) => `<${tag}${cls(c)}>${sp(r[c] === null || r[c] === undefined ? '' : String(r[c]))}</${tag}>`).join('')}</tr>`
        if (b.caption) tableNo++
        const variant = b.variant === 'plain' ? ' plain' : ''
        const wide = n >= 7 ? ' wide' : ''
        const keep = b.rows.length <= 12 ? ' keep' : ''
        parts.push(`<div class="tbl${variant}${keep}">${b.caption ? `<p class="caption tcap">${cap('Table', b.caption, tableNo)}</p>` : ''}<table class="${b.banded === false || b.variant === 'plain' ? '' : 'banded'}${variant}${wide}">${b.widths ? `<colgroup>${b.widths.map((w) => `<col style="width:${w}%">`).join('')}</colgroup>` : ''}${hasHeader ? `<thead>${row(b.header!, 'th')}</thead>` : ''}<tbody>${b.rows.map((r, k) => row(r, 'td', rowKind(b, k))).join('')}</tbody></table></div>`)
        break
      }
      case 'image': {
        const src = o.image?.(b.src)
        if (!src) break
        if (b.caption) figureNo++
        parts.push(`<figure><img src="${src}" alt="${escapeHtml(b.alt ?? b.caption ?? '')}"${b.width ? ` style="width:${b.width}px"` : ''}>${b.caption ? `<figcaption class="caption">${cap('Figure', b.caption, figureNo)}</figcaption>` : ''}</figure>`)
        break
      }
      case 'chart': {
        if (!o.chart) break
        const caption = b.caption ?? b.chart.caption
        if (caption) figureNo++
        parts.push(`<figure class="chart-fig">${o.chart(b.chart)}${caption ? `<figcaption class="caption">${cap('Figure', caption, figureNo)}</figcaption>` : ''}</figure>`)
        break
      }
      case 'quote': parts.push(`<blockquote>${sp(b.text)}${b.cite && !plainText(b.text).includes(b.cite) ? `<cite>— ${escapeHtml(b.cite)}</cite>` : ''}</blockquote>`); break
      case 'callout': {
        const tone = b.tone ?? 'note'
        const label = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' }[tone] ?? 'Note'
        parts.push(`<div class="callout ${tone}"><span class="callout-label">${label}</span>${sp(b.text)}</div>`)
        break
      }
      case 'code': parts.push(`<pre class="${b.text.split('\n').length <= 30 ? 'keep' : ''}"><code${b.lang ? ` class="lang-${escapeHtml(b.lang)}"` : ''}>${escapeHtml(b.text.replace(/\n$/, ''))}</code></pre>`); break
      case 'page_break': parts.push('<div class="pb"></div>'); break
      case 'toc': {
        const levels = b.levels ?? 3
        const entries = heads.filter((h) => h.level <= levels && h.index > i)
        const list = entries.length ? entries : heads.filter((h) => h.level <= levels)
        const top = Math.min(...list.map((h) => h.level))
        parts.push(`<nav class="toc"><p class="toc-title">${escapeHtml(b.title ?? 'Contents')}</p>${list.map((h) => `<a class="l${h.level} d${h.level - top}" href="#${h.id}"><span class="tt">${escapeHtml(o.smart ? smartQuotes(h.text) : h.text)}</span><span class="dots"></span><span class="pg">${o.tocPages ? escapeHtml(o.tocPages[h.id] ?? '') : ''}</span></a>`).join('')}</nav>`)
        break
      }
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
    parts.push(`<section class="footnotes">${o.notesTitle ? `<h2 class="notes-title">${escapeHtml(o.notesTitle)}</h2>` : '<hr>'}<ol>${[...notes.entries()].map(([id, n]) => `<li id="fn-${n}">${spansToHtml(fn[id] ?? `(missing footnote "${id}")`, new Map(), o.smart)} <a class="back" href="#fnref-${n}">↑</a></li>`).join('')}</ol></section>`)
  }
  return parts.join('\n')
}
