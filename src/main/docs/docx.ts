import { fitBox, loadImage } from './image'
import { chartProblems } from './chart'
import { listItem, parseMarkdown, rowKind, plainText, spansOf, type Cell, type DocBlock, type ListItem, type ParsedDoc, type RichText, type Span } from './markdown'
import { applyTemplate, longDate, type TemplateFields, type TemplateKind } from './templates'
import { seriesColors, themeOf, type ThemeName } from './theme'

export type PageSize = 'letter' | 'a4' | 'legal'
export type Margins = number | { top?: number; right?: number; bottom?: number; left?: number }
/** Margins in inches, clamped to 0.4"-2". */
export function marginsOf(m: Margins | undefined, d: { top: number; right: number; bottom: number; left: number }): { top: number; right: number; bottom: number; left: number } {
  const c = (v: number | undefined, dv: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(2, Math.max(0.4, v)) : dv)
  if (typeof m === 'number') return { top: c(m, d.top), right: c(m, d.right), bottom: c(m, d.bottom), left: c(m, d.left) }
  return { top: c(m?.top, d.top), right: c(m?.right, d.right), bottom: c(m?.bottom, d.bottom), left: c(m?.left, d.left) }
}
/** Page size in inches (portrait). */
export const PAGE_IN: Record<PageSize, { w: number; h: number }> = { letter: { w: 8.5, h: 11 }, a4: { w: 8.27, h: 11.69 }, legal: { w: 8.5, h: 14 } }

// Word documents with real styles (Title, Subtitle, Heading 1-4, Caption, Quote…), an automatic table of
// contents with page numbers, headers and footers with "Page X of Y", tables with header rows, banding
// and column widths, images, footnotes, a references list, page breaks and landscape sections.
//
// Public API (also used by the live document editor for export):
//   renderDocx(input: string | DocBlock[] | ParsedDoc, options?: DocxOptions): Promise<Buffer>
//   buildDocx(input, options) → { buffer, warnings, stats }

export interface Citation {
  id?: string
  text: string
  url?: string
}

export interface DocxOptions {
  /** Document title (file properties; the cover and the header use it). Default: the first H1. */
  title?: string
  subtitle?: string
  author?: string
  /** Shown on the cover. Default: today. */
  date?: string
  /** '#RRGGBB' for headings, table headers and rules. */
  accent?: string
  /** Body font (default Arial: on every Mac and PC, so previews match Word) and heading font (default: the body font). */
  font?: string
  headingFont?: string
  /** Body size in points (default 11). */
  fontSize?: number
  /** Table of contents: true, false, or 'auto' (default): when there are 4+ section headings and no [TOC] marker. */
  toc?: boolean | 'auto'
  /** A cover page with title, subtitle, author and date. */
  cover?: boolean
  /** Header text on every page (not the cover). Default: the title when there is a cover or a TOC; false for none. */
  header?: string | false
  /** Footer text (left); page numbers go on the right. */
  footer?: string | false
  /** "Page X of Y" in the footer (default true). */
  pageNumbers?: boolean
  orientation?: 'portrait' | 'landscape'
  pageSize?: PageSize
  /** Page margins in inches: one number for all sides, or per side (default: the theme's, about 1"). */
  margins?: Margins
  /** Visual theme shared with PDFs and decks: modern (default), classic, minimal. */
  theme?: ThemeName
  /** Aim for at most this many pages: spacing tightens first, then the type and margins, within readable limits. */
  fitPages?: number
  /** Document language (BCP 47, default "en-US"): hyphenation, screen readers, metadata. */
  lang?: string
  /** Keywords for the file's properties. */
  keywords?: string[]
  /** Footnote texts by id (Markdown [^id]: text definitions are collected automatically). */
  footnotes?: Record<string, string>
  /** Sources listed at the end under "References". */
  citations?: Array<string | Citation>
  /** Frame the content in a template. */
  template?: TemplateKind
  fields?: TemplateFields
  /** Relative image paths resolve here; or give readImage to control where images may come from. */
  baseDir?: string
  readImage?: (src: string) => Buffer
  /** Render a lone first H1 in the Title style (default true). */
  promoteTitle?: boolean
}

export interface DocxStats {
  headings: number
  words: number
  tables: number
  images: number
  footnotes: number
  sections: number
  toc: boolean
  pages?: number
}

const LETTER = { w: 12240, h: 15840 }
const A4 = { w: 11906, h: 16838 }
const LEGAL = { w: 12240, h: 20160 }
const hex = (c: string | undefined, d: string): string => (/^#?[0-9a-f]{6}$/i.test(c ?? '') ? c!.replace('#', '').toUpperCase() : d)
const NUMERIC = /^\s*[-+(]?\s*[$€£¥]?\s*[-+]?\d[\d,]*(\.\d+)?\s*%?\s*[)]?\s*(k|m|bn|b|x)?\s*$/i

/** Words in rich text, for stats. */
const words = (s: string): number => (s.match(/[A-Za-z0-9À-ɏ']+/g) ?? []).length

export async function renderDocx(input: string | DocBlock[] | ParsedDoc, options: DocxOptions = {}): Promise<Buffer> {
  return (await buildDocx(input, options)).buffer
}

export async function buildDocx(input: string | DocBlock[] | ParsedDoc, options: DocxOptions = {}): Promise<{ buffer: Buffer; warnings: string[]; stats: DocxStats; notes: string[] }> {
  const d = await import('docx')
  const charts = await import('docx/charts').catch(() => undefined)
  let warnings: string[] = []
  const notes: string[] = []
  const parsed: ParsedDoc = typeof input === 'string' ? parseMarkdown(input) : Array.isArray(input) ? { blocks: input, footnotes: {} } : input
  const footnoteText: Record<string, string> = { ...parsed.footnotes, ...(options.footnotes ?? {}) }
  let o: DocxOptions = { ...options }
  let sideHeads = false
  let docClass: string | undefined
  let blocks = parsed.blocks
  if (o.template) {
    const t = applyTemplate(o.template, { blocks, footnotes: footnoteText }, o.fields, o.title)
    blocks = t.blocks
    const L = t.layout
    o = {
      ...o,
      title: o.title ?? t.title,
      cover: o.cover ?? L.cover,
      toc: o.toc ?? L.toc,
      header: o.header ?? L.header,
      footer: o.footer ?? L.footer,
      pageNumbers: o.pageNumbers ?? L.pageNumbers,
      subtitle: o.subtitle ?? L.subtitle,
      author: o.author ?? L.author,
      date: o.date ?? L.date,
      promoteTitle: o.promoteTitle ?? L.promoteTitle,
      fitPages: o.fitPages ?? L.fitPages
    }
    sideHeads = !!L.sideHeads
    docClass = L.docClass
  }

  const theme = themeOf(o.theme, o.accent)
  // Text in the accent is darkened until it reads (≥ 4.5:1); rules and fills keep the accent itself.
  const accent = hex(theme.accentText, '1F4E79')
  const rule = hex(theme.accent, '1F4E79')
  const tint = hex(theme.accentTint, 'EEF3FB')
  const font = o.font?.trim() || theme.office.body
  const headingFont = o.headingFont?.trim() || (o.font?.trim() ? font : theme.office.heading)
  const mono = theme.office.mono
  const baseSize = Math.max(8.5, Math.min(16, o.fontSize ?? (docClass === 'resume' ? 10.5 : 11)))
  let size = Math.round(baseSize * 2)
  const page = o.pageSize === 'a4' ? A4 : o.pageSize === 'legal' ? LEGAL : LETTER
  const baseMargins = marginsOf(o.margins, docClass === 'resume' || docClass === 'invoice' ? { top: 0.75, right: 0.85, bottom: 0.75, left: 0.85 } : { top: 1, right: 1, bottom: 1, left: 1 })
  let mg = { top: Math.round(baseMargins.top * 1440), right: Math.round(baseMargins.right * 1440), bottom: Math.round(baseMargins.bottom * 1440), left: Math.round(baseMargins.left * 1440) }
  let dens = docClass === 'resume' ? 0.85 : 1
  const sp = (n: number): number => Math.round(n * dens)
  const textWidth = (landscape: boolean): number => (landscape ? page.h : page.w) - mg.left - mg.right
  const INK = hex(theme.ink, '1A1A1A'), MUTED = hex(theme.muted, '5F6368'), LINE = hex(theme.line, 'D0D5DD'), BAND = hex(theme.band, 'F2F4F7')

  // Title: a lone first H1 becomes the document title.
  const h1s = blocks.filter((b): b is Extract<DocBlock, { type: 'heading' }> => b.type === 'heading' && b.level === 1)
  let title = o.title
  const first = blocks[0]
  if (o.promoteTitle !== false && first?.type === 'heading' && first.level === 1 && (h1s.length === 1 || (title && plainText(first.text).trim() === title.trim()))) {
    title ??= plainText(first.text)
    blocks = o.cover ? blocks.slice(1) : [{ type: 'paragraph', style: 'title', text: first.text }, ...blocks.slice(1)]
  }
  title ??= h1s[0] ? plainText(h1s[0].text) : 'Document'

  const sectionHeads = blocks.filter((b) => b.type === 'heading' && b.level <= 2).length
  const hasTocMarker = blocks.some((b) => b.type === 'toc')
  // Auto: a contents page pays off for long documents with several sections (review_document asks for one
  // from 4 sections and 800 words, so this triggers a little earlier).
  const roughWords = blocks.reduce((n, b) => n + words(b.type === 'table' ? b.rows.flat().map((c) => plainText(c)).join(' ') : b.type === 'list' ? b.items.map((i) => plainText(listItem(i).text)).join(' ') : 'text' in b ? plainText(b.text as RichText) : ''), 0)
  const wantToc = !hasTocMarker && (o.toc === true || ((o.toc ?? 'auto') === 'auto' && ((sectionHeads >= 4 && roughWords >= 600) || (sectionHeads >= 2 && roughWords > 1800))))
  if (wantToc) {
    // After the title block (and subtitle/lead) when there is no cover; at the top of the body with one.
    let at = 0
    while (at < blocks.length && blocks[at].type === 'paragraph' && ['title', 'subtitle'].includes((blocks[at] as { style?: string }).style ?? '')) at++
    blocks = [...blocks.slice(0, at), { type: 'toc' }, { type: 'page_break' }, ...blocks.slice(at)]
  }
  const hasToc = blocks.some((b) => b.type === 'toc')
  const headerText = o.header === false ? '' : o.header ?? (o.cover || hasToc ? title : '')
  const pageNumbers = o.pageNumbers ?? true

  // Everything below is built per layout (fit_pages tries tighter ones).
  const compose = () => {
  warnings = []
  // ---- inline runs
  const fnIds = new Map<string, number>()
  type Run = InstanceType<typeof d.TextRun> | InstanceType<typeof d.ExternalHyperlink> | InstanceType<typeof d.FootnoteReferenceRun>
  const runs = (text: RichText | Cell, extra: { bold?: boolean; italics?: boolean; color?: string; size?: number; font?: string } = {}): Run[] =>
    spansOf(text as RichText).map((s: Span): Run => {
      if (s.footnote) {
        if (!footnoteText[s.footnote]) warnings.push(`Footnote [^${s.footnote}] has no text.`)
        let n = fnIds.get(s.footnote)
        if (!n) { n = fnIds.size + 1; fnIds.set(s.footnote, n) }
        return new d.FootnoteReferenceRun(n)
      }
      const r = {
        text: s.text,
        bold: s.bold || extra.bold || undefined,
        italics: s.italic || extra.italics || undefined,
        strike: s.strike || undefined,
        underline: s.underline ? {} : undefined,
        color: extra.color,
        size: s.code ? Math.max(16, (extra.size ?? size) - 2) : extra.size,
        // Fonts set on the run too: Quick Look, Pages and Google Docs ignore Word's document defaults.
        font: s.code ? mono : extra.font ?? font,
        break: s.break ? 1 : undefined
      }
      if (s.link && /^(https?:|mailto:)/i.test(s.link)) return new d.ExternalHyperlink({ link: s.link, children: [new d.TextRun({ ...r, style: 'Hyperlink' })] })
      return new d.TextRun(r)
    })

  // ---- block rendering
  type Child = InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table> | InstanceType<typeof d.TableOfContents>
  interface Sec { landscape: boolean; children: Child[] }
  const sections: Sec[] = [{ landscape: o.orientation === 'landscape', children: [] }]
  const cur = (): Sec => sections[sections.length - 1]
  const push = (c: Child): void => { cur().children.push(c) }
  const HEAD = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4]
  const stats: DocxStats = { headings: 0, words: 0, tables: 0, images: 0, footnotes: 0, sections: 1, toc: hasToc }
  let listInstance = 0, tableNo = 0, figureNo = 0

  const listBlock = (items: Array<string | ListItem>, ordered: boolean, level: number, instance: number): void => {
    for (const raw of items) {
      const it = listItem(raw)
      const box = it.checked === undefined ? [] : [new d.TextRun({ text: it.checked ? '☑ ' : '☐ ' })]
      stats.words += words(plainText(it.text))
      push(new d.Paragraph({
        children: [...box, ...runs(it.text)],
        ...(ordered ? { numbering: { reference: 'num', level, instance } } : { bullet: { level } }),
        spacing: { after: sp(60) }
      }))
      if (it.items?.length) listBlock(it.items, false, Math.min(level + 1, 3), instance)
    }
  }

  const table = (b: Extract<DocBlock, { type: 'table' }>): void => {
    const plain = b.variant === 'plain'
    const rowsAll: Cell[][] = [...(b.header ? [b.header] : []), ...b.rows]
    const n = Math.max(1, ...rowsAll.map((r) => r.length))
    if (!b.rows.length && !b.header) return
    stats.tables++
    const width = textWidth(cur().landscape)
    // Column widths: given (percent or relative), else from the content length.
    const weights = b.widths?.length === n && b.widths.every((w) => w > 0)
      ? b.widths
      : Array.from({ length: n }, (_, c) => {
        // Room for the longest word of the header (so "Region" never wraps as "Regio/n") and the body text.
        const headWord = Math.max(0, ...plainText(b.header?.[c] ?? '').split(/\s+/).map((w) => w.length))
        const body = Math.max(0, ...b.rows.map((r) => plainText(r[c] ?? '').length))
        return Math.min(40, Math.max(6, headWord * 1.15 + 3, body + 2))
      })
    const total = weights.reduce((a, w) => a + w, 0)
    const colW = weights.map((w) => Math.max(500, Math.round((w / total) * width)))
    const numericCol = Array.from({ length: n }, (_, c) => {
      const vals = b.rows.map((r) => r[c]).filter((v) => v !== null && v !== undefined && String(v).trim() !== '' && !/^[-–—]$/.test(String(v).trim()))
      return vals.length > 0 && vals.every((v) => typeof v === 'number' || NUMERIC.test(plainText(v)))
    })
    const align = (c: number) => {
      const a = b.align?.[c] ?? (numericCol[c] ? 'right' : 'left')
      return a === 'right' ? d.AlignmentType.RIGHT : a === 'center' ? d.AlignmentType.CENTER : d.AlignmentType.LEFT
    }
    if (b.caption) {
      tableNo++
      const cap = /^table\s*\d+/i.test(b.caption) ? b.caption : `Table ${tableNo}. ${b.caption.replace(/^table\s*[:.–—-]\s*/i, '')}`
      push(new d.Paragraph({ style: 'Caption', keepNext: true, children: runs(cap) }))
    }
    // Table styles follow the theme: tinted (header fill + accent rule), booktabs (rules only) or hairline.
    const none = { style: d.BorderStyle.NONE, size: 0, color: 'FFFFFF' }
    const line = { style: d.BorderStyle.SINGLE, size: 4, color: LINE }
    const strong = (c: string, sz = 8) => ({ style: d.BorderStyle.SINGLE, size: sz, color: c })
    const hasHeader = !!b.header && b.header.some((c) => plainText(c).trim() !== '')
    const kindOf = (i: number): 'total' | 'subtotal' | 'body' => rowKind(b, i)
    const cellOf = (v: Cell, c: number, kind: 'head' | 'body' | 'total' | 'subtotal', band: boolean, last: boolean) => new d.TableCell({
      width: { size: colW[c], type: d.WidthType.DXA },
      margins: { top: sp(60), bottom: sp(60), left: 110, right: 110 },
      verticalAlign: d.VerticalAlign.CENTER,
      shading: kind === 'head' && !plain && theme.table === 'tinted' ? { fill: tint, type: d.ShadingType.CLEAR, color: 'auto' } : band ? { fill: BAND, type: d.ShadingType.CLEAR, color: 'auto' } : undefined,
      borders: plain ? { top: none, bottom: none, left: none, right: none }
        : kind === 'head' ? { top: theme.table === 'booktabs' ? strong(INK, 8) : none, bottom: theme.table === 'tinted' ? strong(rule, 10) : strong(INK, 6), left: none, right: none }
          : kind === 'total' ? { top: strong(INK, 6), bottom: strong(INK, 10), left: none, right: none }
            : { top: none, bottom: last && theme.table === 'booktabs' ? strong(INK, 8) : line, left: none, right: none },
      children: [new d.Paragraph({
        style: 'TableText',
        alignment: kind === 'head' ? (numericCol[c] ? d.AlignmentType.RIGHT : d.AlignmentType.LEFT) : align(c),
        children: runs(v === null || v === undefined ? '' : typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 6 }) : String(v), kind === 'head' ? { bold: true, color: theme.table === 'hairline' ? MUTED : INK, size: theme.table === 'hairline' ? Math.max(14, size - 4) : undefined } : kind === 'total' || kind === 'subtotal' ? { bold: true } : {})
      })]
    })
    const banded = !plain && b.banded !== false && theme.table === 'tinted'
    const rows = [
      ...(hasHeader ? [new d.TableRow({ tableHeader: true, cantSplit: true, children: Array.from({ length: n }, (_, c) => cellOf(b.header![c] ?? '', c, 'head', false, false)) })] : []),
      ...b.rows.map((r, i) => {
        const k = kindOf(i)
        return new d.TableRow({ cantSplit: true, children: Array.from({ length: n }, (_, c) => cellOf(r[c] ?? '', c, k, banded && i % 2 === 1 && k === 'body', i === b.rows.length - 1)) })
      })
    ]
    for (const r of rowsAll) for (const v of r) stats.words += words(plainText(v ?? ''))
    push(new d.Table({
      width: { size: colW.reduce((a, w) => a + w, 0), type: d.WidthType.DXA },
      columnWidths: colW,
      layout: d.TableLayoutType.FIXED,
      borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
      rows
    }))
    push(new d.Paragraph({ spacing: { after: sp(160) }, children: [] }))
  }

  const chart = (b: Extract<DocBlock, { type: 'chart' }>): void => {
    const problems = chartProblems(b.chart)
    if (problems.length || !charts) { warnings.push(`Chart${b.chart?.title ? ` "${b.chart.title}"` : ''} left out: ${problems.join(' ') || 'charts unavailable'}`); return }
    const c = b.chart
    const colors = seriesColors(theme, Math.max(c.series.length, c.categories.length)).map((x) => x.replace('#', ''))
    const w = Math.round((textWidth(cur().landscape) / 1440) * 96)
    const common = { title: c.title ? { text: c.title } : undefined, transformation: { width: w, height: Math.round(w * 0.5) }, font: { name: font }, chartArea: { fill: 'FFFFFF', border: 'none' as const } }
    const pie = c.type === 'pie' || c.type === 'doughnut'
    const series = (pie ? c.series.slice(0, 1) : c.series).map((x, i) => ({ name: x.name, values: x.values.map((v) => (v === null || v === undefined ? null : Number(v))), color: colors[i], ...(pie ? { colors: c.categories.map((_, k) => colors[k]) } : {}) }))
    try {
      const opts = {
        type: c.type,
        categories: c.categories.map(String),
        series,
        ...(c.stacked && !pie ? { stacking: 'stacked' } : {}),
        ...(pie ? {} : { valueAxis: { numberFormat: c.number_format, gridlines: true }, legend: c.series.length > 1 ? { position: 'top' } : false }),
        ...(c.show_values ?? (pie || c.categories.length * c.series.length <= 12) ? { dataLabels: { showValue: !pie, showPercent: pie, numberFormat: c.number_format } } : {}),
        ...common,
        altText: { name: c.title ?? 'Chart', description: '', title: c.title ?? '' }
      }
      stats.images++
      push(new d.Paragraph({ alignment: d.AlignmentType.CENTER, keepNext: !!b.caption, spacing: { before: sp(120), after: b.caption ? 40 : sp(160) }, children: [new charts.ChartRun(opts as never)] }))
    } catch (e) {
      warnings.push(`Chart${c.title ? ` "${c.title}"` : ''} left out: ${(e as Error).message}`)
      return
    }
    const caption = b.caption ?? c.caption
    if (caption) {
      figureNo++
      push(new d.Paragraph({ style: 'Caption', alignment: d.AlignmentType.CENTER, children: runs(/^(figure|fig\.|chart|exhibit)\s*\d+/i.test(caption) ? caption : `Figure ${figureNo}. ${caption}`) }))
    }
  }

  const image = (b: Extract<DocBlock, { type: 'image' }>): void => {
    let img
    try {
      img = loadImage(b.src, o.baseDir, o.readImage)
    } catch (e) {
      warnings.push((e as Error).message)
      return
    }
    stats.images++
    const maxW = Math.round((textWidth(cur().landscape) / 1440) * 96)
    const want = b.width ? { width: b.width, height: b.height ?? Math.round((b.width * img.height) / Math.max(1, img.width)) } : { width: img.width, height: img.height }
    const box = fitBox(want.width, want.height, maxW, 8 * 96)
    push(new d.Paragraph({
      alignment: d.AlignmentType.CENTER,
      keepNext: !!b.caption,
      spacing: { before: sp(120), after: b.caption ? 40 : sp(160) },
      children: [new d.ImageRun({ type: img.type, data: img.data, transformation: box, altText: { name: b.alt ?? b.caption ?? 'Image', description: b.alt ?? b.caption ?? '', title: b.caption ?? b.alt ?? '' } })]
    }))
    if (b.caption) {
      figureNo++
      const cap = /^(figure|fig\.|chart|exhibit)\s*\d+/i.test(b.caption) ? b.caption : `Figure ${figureNo}. ${b.caption.replace(/^(figure|fig\.)\s*[:.–—-]\s*/i, '')}`
      push(new d.Paragraph({ style: 'Caption', alignment: d.AlignmentType.CENTER, children: runs(cap) }))
    }
  }

  const TONE: Record<string, { label: string; color: string; fill: string }> = Object.fromEntries(Object.entries(theme.tones).map(([k, v]) => [k, { label: v.label, color: v.color.replace('#', ''), fill: v.fill.replace('#', '') }]))

  if (o.cover) {
    push(new d.Paragraph({ spacing: { before: 2400 }, children: [] }))
    push(new d.Paragraph({ style: 'Title', children: runs(title, { font: headingFont }) }))
    if (o.subtitle) push(new d.Paragraph({ style: 'Subtitle', children: runs(o.subtitle, { font: headingFont }) }))
    push(new d.Paragraph({ border: { bottom: { style: d.BorderStyle.SINGLE, size: 18, color: rule, space: 1 } }, spacing: { after: 360 }, children: [] }))
    if (o.author) push(new d.Paragraph({ children: runs(o.author, { color: MUTED }) }))
    push(new d.Paragraph({ children: runs(o.date ?? longDate(), { color: MUTED }) }))
    push(new d.Paragraph({ children: [new d.PageBreak()] }))
  }

  let lastWasBreak = false
  for (const b of blocks) {
    const isBreak = b.type === 'page_break'
    switch (b.type) {
      case 'heading': {
        stats.headings++
        stats.words += words(plainText(b.text))
        const side = sideHeads && b.level >= 3 ? /^(.*\S)\s+\|\s+(.+)$/.exec(plainText(b.text)) : null
        if (side) {
          const role = /^(.*?)\s+([—–]|-{1,2})\s+(.+)$/.exec(side[1])
          push(new d.Paragraph({
            heading: HEAD[b.level - 1], keepNext: true, keepLines: true,
            tabStops: [{ type: d.TabStopType.RIGHT, position: textWidth(cur().landscape) }],
            children: [
              ...(role ? [new d.TextRun({ text: role[1], font: headingFont }), new d.TextRun({ text: ` — ${role[3]}`, bold: false, font: headingFont })] : [new d.TextRun({ text: side[1], font: headingFont })]),
              new d.TextRun({ text: '\t', font: headingFont }), new d.TextRun({ text: side[2], bold: false, color: MUTED, font: headingFont, size: size - 1 })
            ]
          }))
        } else push(new d.Paragraph({ heading: HEAD[b.level - 1], children: runs(b.text, { font: headingFont }), keepNext: true, keepLines: true }))
        break
      }
      case 'paragraph': {
        const style = b.style === 'title' ? 'Title' : b.style === 'subtitle' ? 'Subtitle' : b.style === 'caption' ? 'Caption' : b.style === 'lead' ? 'Lead' : b.style === 'small' ? 'Small' : undefined
        if (!plainText(b.text).trim() && !spansOf(b.text).some((s) => s.break)) break
        stats.words += words(plainText(b.text))
        const al = b.align === 'center' ? d.AlignmentType.CENTER : b.align === 'right' ? d.AlignmentType.RIGHT : b.align === 'justify' ? d.AlignmentType.JUSTIFIED : undefined
        push(new d.Paragraph({ ...(style ? { style } : {}), ...(al ? { alignment: al } : {}), children: runs(b.text, style === 'Title' || style === 'Subtitle' ? { font: headingFont } : {}) }))
        break
      }
      case 'list': listBlock(b.items, !!b.ordered, 0, b.ordered ? ++listInstance : 0); break
      case 'table': table(b); break
      case 'image': image(b); break
      case 'chart': chart(b); break
      case 'quote': {
        stats.words += words(plainText(b.text))
        push(new d.Paragraph({ style: 'Quote', children: runs(b.text) }))
        if (b.cite && !plainText(b.text).includes(b.cite)) push(new d.Paragraph({ style: 'Quote', alignment: d.AlignmentType.RIGHT, children: runs(`— ${b.cite}`, { italics: false }) }))
        break
      }
      case 'callout': {
        const t = TONE[b.tone ?? 'note'] ?? TONE.note
        stats.words += words(plainText(b.text))
        push(new d.Paragraph({
          shading: { fill: t.fill, type: d.ShadingType.CLEAR, color: 'auto' },
          border: { left: { style: d.BorderStyle.SINGLE, size: 24, color: t.color, space: 8 } },
          indent: { left: 200, right: 200 },
          spacing: { before: sp(120), after: sp(160) },
          keepLines: true,
          children: [new d.TextRun({ text: `${t.label}: `, bold: true, color: t.color, font: headingFont }), ...runs(b.text)]
        }))
        break
      }
      case 'code': {
        const ls = b.text.replace(/\n$/, '').split('\n')
        ls.forEach((l, i) => push(new d.Paragraph({ style: 'CodeBlock', keepNext: i < ls.length - 1, children: [new d.TextRun({ text: l || ' ' })] })))
        break
      }
      case 'page_break': if (!lastWasBreak) push(new d.Paragraph({ children: [new d.PageBreak()] })); break
      case 'toc': {
        push(new d.Paragraph({ style: 'TocTitle', children: [new d.TextRun(b.title ?? 'Contents')] }))
        push(new d.TableOfContents(b.title ?? 'Contents', { hyperlink: true, headingStyleRange: `1-${Math.min(4, Math.max(1, b.levels ?? 3))}` }))
        break
      }
      case 'section': {
        const want = b.orientation === 'landscape'
        if (want !== cur().landscape) {
          if (!cur().children.length) cur().landscape = want
          else { sections.push({ landscape: want, children: [] }); stats.sections++ }
        }
        break
      }
      case 'hr': push(new d.Paragraph({ border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: LINE, space: 1 } }, spacing: { after: sp(160) }, children: [] })); break
    }
    lastWasBreak = isBreak
  }

  // References
  if (o.citations?.length) {
    const level = blocks.some((b) => b.type === 'heading' && b.level === 1) ? 0 : 1
    push(new d.Paragraph({ heading: HEAD[level], children: [new d.TextRun('References')], keepNext: true }))
    o.citations.forEach((c, i) => {
      const cit: Citation = typeof c === 'string' ? { text: c } : c
      push(new d.Paragraph({
        indent: { left: 540, hanging: 540 },
        spacing: { after: 80 },
        children: [new d.TextRun(`[${i + 1}] `), ...runs(cit.text), ...(cit.url ? [new d.TextRun(' '), new d.ExternalHyperlink({ link: cit.url, children: [new d.TextRun({ text: cit.url, style: 'Hyperlink' })] })] : [])]
      }))
    })
  }

  const unused = Object.keys(footnoteText).filter((k) => !fnIds.has(k))
  if (unused.length) warnings.push(`Footnote${unused.length > 1 ? 's' : ''} ${unused.map((k) => `[^${k}]`).join(', ')} never referenced in the text.`)
  const footnotes: Record<number, { children: InstanceType<typeof d.Paragraph>[] }> = {}
  for (const [id, n] of fnIds) footnotes[n] = { children: [new d.Paragraph({ style: 'FootnoteText', children: runs(footnoteText[id] ?? '') as InstanceType<typeof d.TextRun>[] })] }
  stats.footnotes = fnIds.size

  // ---- headers / footers
  const header = (landscape: boolean) => new d.Header({
    children: headerText
      ? [new d.Paragraph({ alignment: d.AlignmentType.RIGHT, border: { bottom: { style: d.BorderStyle.SINGLE, size: 4, color: LINE, space: 4 } }, children: [new d.TextRun({ text: headerText, size: 16, color: MUTED, font: headingFont })], tabStops: [{ type: d.TabStopType.RIGHT, position: textWidth(landscape) }] })]
      : [new d.Paragraph({ children: [] })]
  })
  const footer = (landscape: boolean) => new d.Footer({
    children: [new d.Paragraph({
      tabStops: [{ type: d.TabStopType.RIGHT, position: textWidth(landscape) }],
      children: [
        ...(o.footer ? [new d.TextRun({ text: o.footer, size: 16, color: MUTED, font: headingFont })] : []),
        ...(pageNumbers ? [new d.TextRun({ size: 16, color: MUTED, font: headingFont, children: [new d.Tab(), 'Page ', d.PageNumber.CURRENT, ' of ', d.PageNumber.TOTAL_PAGES] })] : [])
      ]
    })]
  })
  const blank = () => ({ headers: { first: new d.Header({ children: [new d.Paragraph({ children: [] })] }) }, footers: { first: new d.Footer({ children: [new d.Paragraph({ children: [] })] }) } })

  const make = (estimate: unknown) => new d.Document({
    title,
    subject: o.subtitle,
    creator: o.author?.replace(/^Prepared by /, '') || 'SahilBot',
    ...(o.keywords?.length ? { keywords: o.keywords.join(', ') } : {}),
    description: o.subtitle,
    features: estimate ? undefined : { updateFields: hasToc },
    ...(estimate ? { pageNumbers: estimate as never } : {}),
    footnotes,
    styles: {
      default: {
        document: { run: { font, size, color: INK }, paragraph: { spacing: { after: sp(140), line: Math.round(276 * (dens < 1 ? 0.96 : 1)) } } },
        title: { run: { font: headingFont, size: Math.round(theme.scale.title * 1.75), bold: theme.name !== 'minimal', color: INK }, paragraph: { spacing: { after: sp(120) } } },
        heading1: { run: { font: headingFont, size: Math.round(theme.scale.h1 * 1.7), bold: theme.name !== 'minimal', color: theme.name === 'modern' ? accent : INK }, paragraph: { spacing: { before: sp(360), after: sp(120) }, keepNext: true, keepLines: true } },
        heading2: { run: { font: headingFont, size: Math.round(theme.scale.h2 * 1.75), bold: true, color: theme.name === 'classic' ? accent : INK, ...(theme.labels === 'caps' ? { allCaps: true, characterSpacing: 20 } : {}) }, paragraph: { spacing: { before: sp(280), after: sp(100) }, keepNext: true, keepLines: true } },
        heading3: { run: { font: headingFont, size: Math.round(theme.scale.h3 * 1.85), bold: true, italics: theme.name === 'classic', color: INK }, paragraph: { spacing: { before: sp(220), after: sp(80) }, keepNext: true, keepLines: true } },
        heading4: { run: { font: headingFont, size: Math.round(theme.scale.h4 * 2), bold: true, color: MUTED }, paragraph: { spacing: { before: sp(180), after: sp(60) }, keepNext: true, keepLines: true } },
        caption: { run: { font, size: Math.max(16, size - 3), italics: false, color: MUTED }, paragraph: { spacing: { before: 60, after: sp(120) } } },
        hyperlink: { run: { color: accent, underline: {} } },
        footnoteText: { run: { font, size: Math.max(16, size - 4) } }
      },
      paragraphStyles: [
        { id: 'Subtitle', name: 'Subtitle', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: headingFont, size: size + 8, color: MUTED }, paragraph: { spacing: { after: sp(240) } } },
        { id: 'Quote', name: 'Quote', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font, italics: true, color: INK }, paragraph: { indent: { left: 540, right: 540 }, spacing: { before: sp(120), after: sp(160) }, border: { left: { style: d.BorderStyle.SINGLE, size: 18, color: rule, space: 10 } } } },
        { id: 'Lead', name: 'Lead', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font, size: size + 3, color: INK }, paragraph: { spacing: { after: sp(200) } } },
        { id: 'Small', name: 'Small', basedOn: 'Normal', next: 'Normal', run: { font, size: Math.max(14, size - 4), color: MUTED } },
        { id: 'CodeBlock', name: 'Code Block', basedOn: 'Normal', next: 'Normal', run: { font: mono, size: Math.max(16, size - 4) }, paragraph: { spacing: { after: 0, line: 252 }, shading: { fill: BAND, type: d.ShadingType.CLEAR, color: 'auto' }, indent: { left: 120, right: 120 } } },
        { id: 'TableText', name: 'Table Text', basedOn: 'Normal', run: { font, size: Math.max(16, size - 2) }, paragraph: { spacing: { after: 0, line: 252 } } },
        { id: 'TocTitle', name: 'TOC Heading', basedOn: 'Normal', next: 'Normal', run: { font: headingFont, size: 32, bold: true, color: INK }, paragraph: { spacing: { after: sp(200) } } }
      ]
    },
    numbering: {
      config: [{
        reference: 'num',
        levels: [0, 1, 2, 3].map((level) => ({ level, format: level === 1 ? d.LevelFormat.LOWER_LETTER : level === 2 ? d.LevelFormat.LOWER_ROMAN : d.LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: d.AlignmentType.START, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } }))
      }]
    },
    sections: sections.filter((s, i) => s.children.length || i === 0).map((s, i) => ({
      properties: {
        titlePage: i === 0 && !!o.cover,
        page: {
          size: { width: page.w, height: page.h, orientation: s.landscape ? d.PageOrientation.LANDSCAPE : d.PageOrientation.PORTRAIT },
          margin: { top: mg.top, bottom: mg.bottom, left: mg.left, right: mg.right, header: Math.min(708, Math.round(mg.top / 2)), footer: Math.min(708, Math.round(mg.bottom / 2)) }
        }
      },
      headers: { default: header(s.landscape), ...(i === 0 && o.cover ? blank().headers : {}) },
      footers: { default: footer(s.landscape), ...(i === 0 && o.cover ? blank().footers : {}) },
      children: s.children.length ? s.children : [new d.Paragraph({ children: [] })]
    }))
  })

  return { make, stats }
  }

  // Pages as Word lays them out (docx's layout engine; fonts it doesn't know are measured as the closest it does).
  const layoutMod = await import('docx/layout').catch(() => undefined)
  const countPages = (doc: unknown): number | undefined => {
    try { return layoutMod?.layoutDocument(doc as never, { guess: true }).pages.length } catch { return undefined }
  }
  let built = compose()
  let pages = countPages(built.make(undefined))
  const want = o.fitPages && o.fitPages > 0 ? Math.round(o.fitPages) : undefined
  if (want && pages && pages > want) {
    const start = { size, dens, mg: { ...mg } }
    const steps: Array<() => void> = [
      () => { dens = Math.min(dens, 0.85) },
      () => { dens = Math.min(dens, 0.72) },
      () => { size = Math.max(17, size - 1) },
      () => { mg = { top: Math.max(864, mg.top - 288), right: Math.max(936, mg.right - 288), bottom: Math.max(864, mg.bottom - 288), left: Math.max(936, mg.left - 288) } },
      () => { size = Math.max(17, size - 1); dens = Math.min(dens, 0.62) },
      () => { size = Math.max(17, size - 1) }
    ]
    for (const step of steps) {
      step()
      built = compose()
      pages = countPages(built.make(undefined))
      if (pages && pages <= want) break
    }
    const what = [dens < start.dens ? `spacing ${Math.round(dens * 100)}%` : '', size < start.size ? `text ${size / 2} pt (was ${start.size / 2})` : '', mg.left < start.mg.left ? `margins ${(mg.top / 1440).toFixed(2)}"/${(mg.left / 1440).toFixed(2)}"` : ''].filter(Boolean).join(', ')
    notes.push(pages && pages <= want ? `Fitted to ${want} page(s): ${what}.` : `Could not fit ${want} page(s) within readable limits (smallest text ${size / 2} pt): about ${pages} pages. Shorten the content.`)
  }
  const { make, stats } = built
  stats.pages = pages
  // Page numbers for the table of contents come from the same layout; if that can't run, Word fills them in on open.
  let buffer: Buffer
  if (hasToc && layoutMod) {
    try {
      buffer = await d.Packer.toBuffer(make(layoutMod.estimatePageNumbersWith({ guess: true })))
    } catch {
      buffer = await d.Packer.toBuffer(make(undefined))
    }
  } else {
    buffer = await d.Packer.toBuffer(make(undefined))
  }
  return { buffer, warnings, stats, notes }
}
