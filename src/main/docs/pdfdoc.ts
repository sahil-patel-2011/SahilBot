import { chartSvg } from './chart'
import { marginsOf, PAGE_IN, type Citation, type DocxOptions, type Margins, type PageSize } from './docx'
import { loadImage } from './image'
import { blocksToHtml, escapeHtml, headingIds, listItem, parseMarkdown, plainText, smartQuotes, type DocBlock, type ParsedDoc } from './markdown'
import { applyTemplate, longDate } from './templates'
import { themeOf, type DocTheme, type ThemeName } from './theme'

// The PDF engine's pure half (no Electron): documents become themed HTML + CSS for Chromium's print engine
// (create.ts prints it), and the printed PDF is read back and finished here.
//
//   Typography   embedded macOS fonts per theme, kerning and ligatures, hyphenation, widows/orphans,
//                balanced headings, "pretty" paragraph wrapping, tabular figures in tables.
//   Pagination   headings keep with what follows; table rows never split and the header row repeats on
//                every page; figures, callouts and short code blocks stay whole; landscape sections.
//   Furniture    running header (title) and "Page X of Y" in CSS page-margin boxes; cover page without them.
//   Navigation   bookmarks (PDF outline) from headings, clickable TOC with real page numbers (second pass),
//                live links, footnote back-links.
//   Finishing    title/author/subject/keywords/language metadata, "show title" viewer preference, page labels
//                (the cover is "Cover", the body starts at 1), tagged PDF from Chromium.
//   Fitting      fit_pages: tighten spacing, then type size and margins, within readable limits; a nearly
//                empty last page is pulled back automatically.

export interface PdfOptions extends DocxOptions {
  theme?: ThemeName
  /** Base text size in points (default: the theme's, 10-11 pt). */
  fontSize?: number
}

export interface Prepared {
  blocks: DocBlock[]
  footnotes: Record<string, string>
  title: string
  opts: PdfOptions & { docClass?: string; sideHeads?: boolean }
  theme: DocTheme
  hasToc: boolean
  cover: boolean
}

/** Templates, title promotion and the automatic TOC (shared rules with Word). */
export function preparePdf(input: string | DocBlock[] | ParsedDoc, o: PdfOptions = {}): Prepared {
  const parsed: ParsedDoc = typeof input === 'string' ? parseMarkdown(input) : Array.isArray(input) ? { blocks: input, footnotes: {} } : input
  let blocks = parsed.blocks
  let opts: Prepared['opts'] = { ...o }
  if (o.template) {
    const t = applyTemplate(o.template, parsed, o.fields, o.title)
    blocks = t.blocks
    const L = t.layout
    opts = { ...opts, title: opts.title ?? t.title, cover: opts.cover ?? L.cover, toc: opts.toc ?? L.toc, header: opts.header ?? L.header, footer: opts.footer ?? L.footer, pageNumbers: opts.pageNumbers ?? L.pageNumbers, subtitle: opts.subtitle ?? L.subtitle, author: opts.author ?? L.author, date: opts.date ?? L.date, docClass: L.docClass, sideHeads: L.sideHeads, fitPages: opts.fitPages ?? L.fitPages }
  }
  const theme = themeOf(opts.theme, opts.accent)
  const first = blocks[0]
  const h1s = blocks.filter((b) => b.type === 'heading' && b.level === 1).length
  let title = opts.title
  if (first?.type === 'heading' && first.level === 1 && (h1s === 1 || (title && plainText(first.text).trim() === title.trim()))) {
    title ??= plainText(first.text)
    blocks = opts.cover ? blocks.slice(1) : [{ type: 'paragraph', style: 'title', text: first.text }, ...blocks.slice(1)]
  }
  title ??= blocks.find((b) => b.type === 'paragraph' && b.style === 'title') ? plainText((blocks.find((b) => b.type === 'paragraph' && b.style === 'title') as { text: string }).text) : 'Document'
  // Subtitle / author / date under the title when there's no cover.
  if (!opts.cover && (opts.subtitle || (opts.author && !opts.template))) {
    const at = blocks.findIndex((b) => b.type === 'paragraph' && b.style === 'title')
    if (at >= 0 && !(blocks[at + 1]?.type === 'paragraph' && (blocks[at + 1] as { style?: string }).style === 'subtitle')) {
      const extra: DocBlock[] = []
      if (opts.subtitle) extra.push({ type: 'paragraph', style: 'subtitle', text: opts.subtitle })
      const meta = [opts.author, opts.date].filter(Boolean).join(' · ')
      if (meta && !opts.template) extra.push({ type: 'paragraph', style: 'small', text: meta })
      blocks = [...blocks.slice(0, at + 1), ...extra, ...blocks.slice(at + 1)]
    }
  }
  const words = (blocks.map((b) => (b.type === 'table' ? b.rows.flat().map((c) => plainText(c)).join(' ') : b.type === 'list' ? b.items.map((i) => plainText(listItem(i).text)).join(' ') : 'text' in b && typeof b.text !== 'undefined' ? plainText(b.text as string) : '')).join(' ').match(/[A-Za-z0-9']+/g) ?? []).length
  const heads = blocks.filter((b) => b.type === 'heading' && b.level <= 2).length
  if (!blocks.some((b) => b.type === 'toc') && (opts.toc === true || ((opts.toc ?? 'auto') === 'auto' && ((heads >= 4 && words >= 600) || (heads >= 2 && words > 1800))))) {
    let at = 0
    while (at < blocks.length && blocks[at].type === 'paragraph' && ['title', 'subtitle', 'small'].includes((blocks[at] as { style?: string }).style ?? '')) at++
    blocks = [...blocks.slice(0, at), { type: 'toc' }, ...blocks.slice(at)]
  }
  return { blocks, footnotes: { ...parsed.footnotes, ...(opts.footnotes ?? {}) }, title, opts, theme, hasToc: blocks.some((b) => b.type === 'toc'), cover: !!opts.cover }
}

export interface PdfLayout {
  size: PageSize
  landscape: boolean
  margins: { top: number; right: number; bottom: number; left: number }
  /** Base text size, points. */
  fontSize: number
  /** Vertical spacing multiplier (1 = the theme's rhythm). */
  density: number
  pageNumbers: boolean
  /** Running header text ('' for none). */
  header: string
  footer: string
  tocPages?: Record<string, string>
}

export const MIN_FONT = 8.5

export function defaultLayout(p: Prepared): PdfLayout {
  const o = p.opts
  const cls = o.docClass
  const base = cls === 'resume' || cls === 'invoice' ? { top: 0.75, right: 0.85, bottom: 0.75, left: 0.85 } : cls === 'memo' || cls === 'letter' ? { top: 0.9, right: 1, bottom: 0.9, left: 1 } : { top: 0.95, right: 1, bottom: 0.9, left: 1 }
  const header = o.header === false ? '' : (o.header ?? (p.cover || p.hasToc ? p.title : ''))
  return {
    size: o.pageSize ?? 'letter',
    landscape: o.orientation === 'landscape',
    margins: marginsOf(o.margins as Margins | undefined, base),
    fontSize: Math.max(MIN_FONT, Math.min(16, o.fontSize ?? (cls === 'resume' ? p.theme.pdf.size - 0.5 : p.theme.pdf.size))),
    density: cls === 'resume' ? 0.85 : 1,
    pageNumbers: o.pageNumbers ?? true,
    header,
    footer: o.footer ? String(o.footer) : ''
  }
}

/** Progressively tighter layouts for fitting: spacing first, then type, then margins (readable limits). */
export function tighter(l: PdfLayout, step: number): PdfLayout | undefined {
  const steps: Array<Partial<PdfLayout>> = [
    { density: Math.min(l.density, 0.9) },
    { density: Math.min(l.density, 0.8) },
    { fontSize: Math.max(MIN_FONT, l.fontSize - 0.5) },
    { margins: { top: Math.max(0.6, l.margins.top - 0.2), right: Math.max(0.65, l.margins.right - 0.2), bottom: Math.max(0.6, l.margins.bottom - 0.2), left: Math.max(0.65, l.margins.left - 0.2) } },
    { fontSize: Math.max(MIN_FONT, l.fontSize - 0.5), density: Math.min(l.density, 0.72) },
    { fontSize: Math.max(MIN_FONT, l.fontSize - 0.5) }
  ]
  return step < steps.length ? { ...l, ...steps[step] } : undefined
}

const cssStr = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`

export function pageCss(p: Prepared, l: PdfLayout): string {
  const t = p.theme
  const f = l.fontSize
  const u = +(f * t.pdf.leading * l.density).toFixed(2)
  const S = PAGE_IN[l.size]
  const W = l.landscape ? S.h : S.w, H = l.landscape ? S.w : S.h
  const m = l.margins
  const hs = t.scale
  const k = f / t.pdf.size
  const box = `font-family: ${t.pdf.heading}; font-size: 7.5pt; color: ${t.faint}; font-variant-numeric: tabular-nums;`
  const pageNo = t.name === 'minimal' ? 'counter(page) " / " counter(pages)' : '"Page " counter(page) " of " counter(pages)'
  const margins = `
    ${l.header ? `@top-left { content: ${cssStr(l.header)}; ${box} vertical-align: bottom; padding-bottom: 14pt; letter-spacing: 0.02em; }` : ''}
    ${l.footer ? `@bottom-left { content: ${cssStr(l.footer)}; ${box} vertical-align: top; padding-top: 14pt; }` : ''}
    ${l.pageNumbers ? `@bottom-right { content: ${pageNo}; ${box} vertical-align: top; padding-top: 14pt; }` : ''}`
  const plainHead = p.cover ? '' : '@page :first { @top-left { content: none } }'
  const cls = p.opts.docClass ?? ''
  const tableCss = t.table === 'booktabs'
    ? `table:not(.plain) { border-top: 1pt solid ${t.ink}; border-bottom: 1pt solid ${t.ink}; }
       table:not(.plain) thead th { border-bottom: 0.6pt solid ${t.ink}; font-weight: 600; font-variant-caps: all-small-caps; letter-spacing: 0.03em; font-size: ${f}pt; }
       table:not(.plain) td { border-bottom: 0.4pt solid ${t.line}; }
       table:not(.plain) tbody tr:last-child td { border-bottom: none; }`
    : t.table === 'hairline'
      ? `table:not(.plain) thead th { font-weight: 500; font-size: ${f - 2.25}pt; text-transform: uppercase; letter-spacing: 0.07em; color: ${t.muted}; border-bottom: 0.75pt solid ${t.ink}; padding-top: 2pt; }
         table:not(.plain) td { border-bottom: 0.5pt solid ${t.line}; }`
      : `table:not(.plain) thead th { background: ${t.accentTint}; color: ${t.ink}; font-weight: 600; border-bottom: 1.25pt solid ${t.accent}; }
         table:not(.plain) td { border-bottom: 0.5pt solid ${t.line}; }
         table.banded tbody tr:nth-child(even):not(.total):not(.subtotal) td { background: ${t.band}; }`
  const headings = t.name === 'classic'
    ? `h1 { font-size: ${hs.h1 * k}pt; color: ${t.ink}; padding-bottom: 4pt; border-bottom: 0.6pt solid ${t.line}; }
       h2 { font-size: ${hs.h2 * k}pt; color: ${t.accentText}; }
       h3 { font-size: ${hs.h3 * k}pt; font-style: italic; font-weight: 600; }
       h4 { font-size: ${hs.h4 * k}pt; font-variant-caps: all-small-caps; letter-spacing: 0.04em; }`
    : t.name === 'minimal'
      ? `h1 { font-size: ${hs.h1 * k}pt; font-weight: 500; letter-spacing: -0.01em; }
         h2 { font-size: ${(hs.h2 - 2.5) * k}pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: ${t.ink}; padding-top: ${0.5 * u}pt; border-top: 0.6pt solid ${t.line}; }
         h3 { font-size: ${hs.h3 * k}pt; font-weight: 600; }
         h4 { font-size: ${hs.h4 * k}pt; color: ${t.muted}; font-weight: 600; }`
      : `h1 { font-size: ${hs.h1 * k}pt; color: ${t.accentText}; letter-spacing: -0.005em; }
         h2 { font-size: ${hs.h2 * k}pt; }
         h3 { font-size: ${hs.h3 * k}pt; }
         h4 { font-size: ${(hs.h4 - 1.5) * k}pt; text-transform: uppercase; letter-spacing: 0.06em; color: ${t.muted}; }`
  const imgMax = ((H - m.top - m.bottom) * 0.42).toFixed(2)
  return `
  @page { size: ${W}in ${H}in; margin: ${m.top}in ${m.right}in ${m.bottom}in ${m.left}in; ${margins} }
  ${plainHead}
  @page wide { size: ${H}in ${W}in; }
  :root { color-scheme: light; }
  html { font-size: ${f}pt; }
  body { margin: 0; font-family: ${t.pdf.body}; color: ${t.ink}; line-height: ${t.pdf.leading}; font-kerning: normal; font-variant-ligatures: common-ligatures contextual; text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased; }
  p { margin: 0 0 ${0.62 * u}pt; widows: 2; orphans: 2; text-wrap: pretty; hyphens: auto; hyphenate-limit-chars: 7 3 3; }
  h1, h2, h3, h4 { font-family: ${t.pdf.heading}; font-weight: ${t.pdf.headingWeight}; color: ${t.ink}; line-height: 1.22; break-after: avoid; break-inside: avoid; text-wrap: balance; hyphens: manual; }
  h1 { margin: ${1.5 * u}pt 0 ${0.5 * u}pt; } h2 { margin: ${1.25 * u}pt 0 ${0.4 * u}pt; } h3 { margin: ${1 * u}pt 0 ${0.3 * u}pt; } h4 { margin: ${0.9 * u}pt 0 ${0.25 * u}pt; }
  ${headings}
  .sec > :first-child, .sec > nav + h1, .sec > p.title + * { margin-top: 0; }
  h1 + h2, h2 + h3, h3 + h4 { margin-top: ${0.4 * u}pt; }
  strong { font-weight: ${t.name === 'minimal' ? 600 : 650}; }
  a { color: ${t.accentText}; text-decoration: underline; text-decoration-thickness: 0.5pt; text-underline-offset: 1.5pt; }
  p.title { font-family: ${t.pdf.heading}; font-size: ${hs.title * k}pt; font-weight: ${t.name === 'minimal' ? 500 : t.pdf.headingWeight}; line-height: 1.1; letter-spacing: -0.015em; margin: 0 0 ${0.35 * u}pt; text-wrap: balance; hyphens: manual; }
  p.title::after { content: ''; display: block; width: 40pt; height: 2.5pt; background: ${t.accent}; margin-top: ${0.55 * u}pt; }
  p.title:has(+ p.subtitle)::after, p.title:has(+ p.small)::after { display: none; }
  p.subtitle { font-size: ${f + 3}pt; color: ${t.muted}; line-height: 1.35; margin: 0 0 ${0.3 * u}pt; }
  p.subtitle + p.small, p.subtitle:not(:has(+ p.small)) { padding-bottom: ${0.7 * u}pt; border-bottom: 0.75pt solid ${t.line}; margin-bottom: ${1 * u}pt; }
  p.lead { font-size: ${f + 1.5}pt; color: ${t.ink}; line-height: 1.45; }
  p.small { font-size: ${f - 1.5}pt; color: ${t.muted}; }
  .caption { font-size: ${f - 1.5}pt; color: ${t.muted}; line-height: 1.35; margin: 0 0 ${0.3 * u}pt; text-wrap: pretty; }
  .cap-n { font-weight: 600; color: ${t.ink}; }
  ul, ol { margin: 0 0 ${0.62 * u}pt; padding-left: 1.3em; }
  li { margin: 0 0 ${0.22 * u}pt; padding-left: 0.25em; widows: 2; orphans: 2; }
  li > ul, li > ol { margin: ${0.22 * u}pt 0 0; }
  ul > li::marker { color: ${t.accent}; } ol > li::marker { color: ${t.muted}; font-variant-numeric: tabular-nums; font-weight: 600; }
  ul ul { list-style-type: "–  "; } ul ul > li::marker { color: ${t.faint}; }
  ul.tasks { list-style: none; padding-left: 0.2em; } .box { color: ${t.accentText}; }
  .tbl { margin: ${0.45 * u}pt 0 ${0.95 * u}pt; }
  .tbl.keep { break-inside: avoid; }
  .tcap { break-after: avoid; margin-bottom: ${0.35 * u}pt; }
  table { width: 100%; border-collapse: collapse; font-size: ${f - 1}pt; line-height: 1.35; font-variant-numeric: tabular-nums lining-nums; }
  table.wide { font-size: ${Math.max(7.5, f - 2)}pt; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th, td { padding: ${Math.max(2.5, 4 * l.density)}pt 7pt; text-align: left; vertical-align: top; overflow-wrap: break-word; }
  th.r, td.r { text-align: right; } th.c, td.c { text-align: center; }
  td.r { white-space: nowrap; }
  th:first-child, td:first-child { padding-left: 5pt; } th:last-child, td:last-child { padding-right: 5pt; }
  ${tableCss}
  tr.total td { font-weight: 650; border-top: 0.9pt solid ${t.ink}; border-bottom: 1.2pt solid ${t.ink}; background: none; }
  tr.subtotal td { font-weight: 600; border-top: 0.6pt solid ${t.faint}; }
  table.plain td { border: none; padding: 1.5pt 12pt 1.5pt 0; background: none; }
  table.plain td:first-child { color: ${t.muted}; white-space: nowrap; width: 1%; }
  table.plain td:first-child strong { font-weight: 600; color: ${t.muted}; }
  .tbl.plain { margin: ${0.2 * u}pt 0 ${0.8 * u}pt; }
  figure { margin: ${0.7 * u}pt 0 ${0.95 * u}pt; break-inside: avoid; }
  figure img { display: block; max-width: 100%; max-height: ${imgMax}in; margin: 0 auto; object-fit: contain; }
  figure .caption { margin-top: ${0.45 * u}pt; }
  svg.chart { display: block; width: 100%; height: auto; }
  blockquote { margin: ${0.7 * u}pt 0 ${0.9 * u}pt; padding: 1pt 0 1pt 14pt; border-left: 2pt solid ${t.accent}; font-size: ${f + 0.5}pt; font-style: italic; color: ${t.ink}; break-inside: avoid; }
  blockquote cite { display: block; margin-top: 5pt; font-style: normal; font-size: ${f - 1.5}pt; color: ${t.muted}; }
  .callout { margin: ${0.6 * u}pt 0 ${0.9 * u}pt; padding: 8pt 12pt 8.5pt 12pt; border-left: 3pt solid; border-radius: 0 3pt 3pt 0; break-inside: avoid; line-height: 1.45; }
  .callout-label { display: block; font-family: ${t.pdf.heading}; font-size: ${f - 2.5}pt; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 2pt; }
  ${Object.entries(t.tones).map(([k2, v]) => `.callout.${k2} { background: ${v.fill}; border-color: ${v.color}; } .callout.${k2} .callout-label { color: ${v.color}; }`).join('\n  ')}
  pre { font-family: ${t.pdf.mono}; font-size: ${f - 2}pt; line-height: 1.5; background: ${t.band}; border: 0.5pt solid ${t.line}; border-radius: 4pt; padding: 8pt 10pt; margin: ${0.45 * u}pt 0 ${0.9 * u}pt; white-space: pre-wrap; overflow-wrap: anywhere; }
  pre.keep { break-inside: avoid; }
  code { font-family: ${t.pdf.mono}; font-size: 0.86em; background: ${t.band}; padding: 0.5pt 3pt; border-radius: 2pt; }
  pre code { background: none; padding: 0; font-size: inherit; }
  hr { border: none; border-top: 0.75pt solid ${t.line}; margin: ${0.9 * u}pt 0; }
  .pb { break-after: page; }
  .sec.landscape { page: wide; }
  sup.fn { font-size: 0.68em; line-height: 0; vertical-align: super; } sup.fn a { color: ${t.accentText}; text-decoration: none; font-weight: 600; padding: 0 0.5pt; }
  .footnotes { margin-top: ${1.2 * u}pt; font-size: ${f - 1.75}pt; color: ${t.muted}; line-height: 1.4; }
  .footnotes hr { width: 28%; margin: 0 0 ${0.4 * u}pt; border-top-color: ${t.faint}; }
  .footnotes ol { padding-left: 1.4em; } .footnotes li { margin-bottom: 2pt; } .footnotes a.back { text-decoration: none; color: ${t.faint}; }
  .refs { break-inside: avoid; } .refs h2 { break-after: avoid; }
  .refs ol { padding-left: 1.6em; } .refs li { margin-bottom: ${0.25 * u}pt; font-size: ${f - 0.5}pt; overflow-wrap: anywhere; } .refs li::marker { color: ${t.muted}; }
  nav.toc { margin: 0 0 ${1.3 * u}pt; }
  .toc-title { font-family: ${t.pdf.heading}; font-size: ${hs.h2 * k}pt; font-weight: ${t.pdf.headingWeight}; margin: 0 0 ${0.5 * u}pt; break-after: avoid; }
  nav.toc a { display: flex; align-items: baseline; gap: 6pt; color: ${t.ink}; text-decoration: none; padding: ${2.6 * l.density}pt 0; break-inside: avoid; }
  nav.toc a.d0 { font-weight: 600; } nav.toc a.d0:not(:first-of-type) { margin-top: ${2.5 * l.density}pt; }
  nav.toc a.d1 { padding-left: 14pt; } nav.toc a.d2 { padding-left: 28pt; font-size: ${f - 0.5}pt; color: ${t.muted}; } nav.toc a.d3 { padding-left: 42pt; font-size: ${f - 0.5}pt; color: ${t.muted}; }
  nav.toc .tt { flex: 0 1 auto; }
  nav.toc .dots { flex: 1 1 auto; min-width: 12pt; border-bottom: 0.8pt dotted ${t.faint}; transform: translateY(-3pt); }
  nav.toc .pg { flex: 0 0 auto; min-width: 1.4em; text-align: right; font-variant-numeric: tabular-nums; color: ${t.muted}; font-weight: 400; }
  h1.side, h2.side, h3.side, h4.side { display: flex; justify-content: space-between; align-items: baseline; gap: 14pt; }
  .h-org { font-weight: 400; color: ${t.ink}; } .h-side { font-weight: 400; color: ${t.muted}; font-size: ${f - 0.5}pt; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .notes-title { margin-top: ${1.2 * u}pt; }
  ${cls === 'resume' ? `
  p.title { font-size: ${26 * k}pt; margin-bottom: ${0.15 * u}pt; } p.title::after { display: none; }
  p.subtitle { font-size: ${f - 0.5}pt; color: ${t.muted}; padding-bottom: ${0.55 * u}pt; border-bottom: 1.2pt solid ${t.accent}; margin-bottom: ${0.8 * u}pt; }
  h2 { font-size: ${f - 1}pt; text-transform: uppercase; letter-spacing: 0.1em; color: ${t.accentText}; font-weight: 700; margin: ${1.05 * u}pt 0 ${0.35 * u}pt; padding: 0 0 2pt; border: none; border-bottom: 0.6pt solid ${t.line}; }
  h3 { font-size: ${f + 0.25}pt; margin: ${0.7 * u}pt 0 ${0.15 * u}pt; font-style: normal; }
  ul { margin-bottom: ${0.4 * u}pt; } li { margin-bottom: ${0.12 * u}pt; } p { margin-bottom: ${0.45 * u}pt; }` : ''}
  ${cls === 'invoice' ? `
  p.title { font-size: ${28 * k}pt; letter-spacing: 0.02em; text-transform: uppercase; color: ${t.accentText}; }
  table.plain td:first-child { width: auto; white-space: normal; color: ${t.ink}; }
  table.plain td { vertical-align: top; line-height: 1.5; }
  table.plain td strong { color: ${t.muted} !important; font-size: ${f - 2}pt; text-transform: uppercase; letter-spacing: 0.08em; }
  .tbl:not(.plain) { margin-top: ${1 * u}pt; }
  tr.total td { font-size: ${f + 0.5}pt; background: ${t.accentTint}; }` : ''}
  ${cls === 'memo' ? `
  p.title { text-transform: uppercase; letter-spacing: 0.12em; font-size: ${18 * k}pt; color: ${t.ink}; }
  table.plain td:first-child { width: 0.9in; text-transform: uppercase; letter-spacing: 0.06em; font-size: ${f - 2}pt; padding-top: 3pt; }
  table.plain td:first-child strong { font-weight: 600; }` : ''}
  `
}

/** The cover page as its own one-page document (margins 0: designs can bleed). */
export function coverHtml(p: Prepared, l: PdfLayout): string {
  const t = p.theme
  const S = PAGE_IN[l.size]
  const W = l.landscape ? S.h : S.w, H = l.landscape ? S.w : S.h
  const o = p.opts
  const org = o.fields?.organization ?? o.fields?.prepared_for
  const sub = o.subtitle ? `<div class="s">${escapeHtml(smartQuotes(o.subtitle))}</div>` : ''
  const meta = [o.author, o.date ?? longDate()].filter(Boolean).map((x) => `<div class="m">${escapeHtml(smartQuotes(String(x)))}</div>`).join('')
  const conf = o.fields?.confidential || /confidential/i.test(String(o.footer ?? '')) ? '<div class="conf">Confidential</div>' : ''
  const body = t.name === 'classic'
    ? `<div class="cv classic"><div class="rule"></div>${org ? `<div class="org">${escapeHtml(org)}</div>` : ''}<div class="t">${escapeHtml(smartQuotes(p.title))}</div>${sub}<div class="rule"></div><div class="meta">${meta}</div>${conf}</div>`
    : `<div class="cv ${t.name}"><div class="band"></div>${org ? `<div class="org">${escapeHtml(org)}</div>` : ''}<div class="mid"><div class="t">${escapeHtml(smartQuotes(p.title))}</div>${sub}<div class="bar"></div><div class="meta">${meta}</div></div>${conf}</div>`
  const css = `
  @page { size: ${W}in ${H}in; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body { font-family: ${t.pdf.body}; color: ${t.ink}; font-kerning: normal; -webkit-font-smoothing: antialiased; }
  .cv { position: relative; width: ${W}in; height: calc(${H}in - 2px); overflow: hidden; box-sizing: border-box; padding: 0 ${Math.max(0.9, l.margins.left)}in; }
  .t { font-family: ${t.pdf.heading}; font-weight: ${t.name === 'minimal' ? 500 : t.pdf.headingWeight}; font-size: 34pt; line-height: 1.08; letter-spacing: -0.02em; text-wrap: balance; }
  .s { font-size: 15pt; color: ${t.muted}; margin-top: 12pt; line-height: 1.3; text-wrap: balance; }
  .m { font-size: 10.5pt; color: ${t.muted}; margin-top: 3pt; }
  .org { font-family: ${t.pdf.heading}; font-size: 9pt; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: ${t.accentText}; }
  .conf { position: absolute; bottom: 0.8in; left: ${Math.max(0.9, l.margins.left)}in; font-size: 8.5pt; letter-spacing: 0.12em; text-transform: uppercase; color: ${t.faint}; }
  .cv.modern .band { position: absolute; top: 0; left: 0; right: 0; height: 0.22in; background: ${t.accent}; }
  .cv.modern .org, .cv.minimal .org { position: absolute; top: 1.1in; }
  .cv.modern .mid, .cv.minimal .mid { position: absolute; left: ${Math.max(0.9, l.margins.left)}in; right: ${Math.max(0.9, l.margins.right)}in; top: 38%; }
  .cv.modern .bar { width: 56pt; height: 4pt; background: ${t.accent}; margin: 22pt 0 18pt; }
  .cv.minimal .band { display: none; } .cv.minimal .t { font-size: 30pt; } .cv.minimal .mid { top: auto; bottom: 1.6in; }
  .cv.minimal .bar { width: 100%; height: 0.75pt; background: ${t.ink}; margin: 20pt 0 12pt; }
  .cv.classic { display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; }
  .cv.classic .rule { width: 2.4in; height: 0; border-top: 0.75pt solid ${t.ink}; margin: 22pt 0; }
  .cv.classic .t { font-size: 32pt; } .cv.classic .org { margin-bottom: 18pt; }
  .cv.classic .conf { left: 0; right: 0; text-align: center; }
  `
  return `<!doctype html><html lang="${o.lang ?? 'en'}"><head><meta charset="utf-8"><title>${escapeHtml(p.title)}</title><style>${css}</style></head><body>${body}</body></html>`
}

/** The body document's HTML for a layout. */
export function bodyHtml(p: Prepared, l: PdfLayout, o: { baseDir?: string; readImage?: (src: string) => Buffer } = {}): string {
  const t = p.theme
  const S = PAGE_IN[l.size]
  const textW = ((l.landscape ? S.h : S.w) - l.margins.left - l.margins.right) * 72
  const image = (src: string): string | undefined => {
    try {
      const img = loadImage(src, o.baseDir, o.readImage)
      return `data:image/${img.type === 'jpg' ? 'jpeg' : img.type};base64,${img.data.toString('base64')}`
    } catch { return undefined }
  }
  const tocPages = p.hasToc ? (l.tocPages ?? Object.fromEntries(headingIds(p.blocks).map((h) => [h.id, '00']))) : undefined
  const body = blocksToHtml(p.blocks, {
    footnotes: p.footnotes,
    image,
    chart: (c) => chartSvg(c, t, { width: Math.round(textW), height: Math.round(Math.min(textW * 0.5, 260)) }),
    smart: true,
    numbering: !['invoice', 'resume', 'letter', 'memo'].includes(p.opts.docClass ?? ''),
    tocPages,
    sideHeads: p.opts.sideHeads,
    notesTitle: p.cover || p.hasToc ? 'Notes' : undefined
  })
  const refs = p.opts.citations?.length
    ? `<section class="refs"><h2>References</h2><ol>${p.opts.citations.map((c) => { const x: Citation = typeof c === 'string' ? { text: c } : c; return `<li>${escapeHtml(smartQuotes(x.text))}${x.url ? ` <a href="${escapeHtml(x.url)}">${escapeHtml(x.url.replace(/^https?:\/\//, ''))}</a>` : ''}</li>` }).join('')}</ol></section>`
    : ''
  return `<!doctype html><html lang="${p.opts.lang ?? 'en'}"><head><meta charset="utf-8"><title>${escapeHtml(p.title)}</title><style>${pageCss(p, l)}</style></head><body class="doc-${p.opts.docClass ?? 'doc'} theme-${t.name}">${body}${refs}</body></html>`
}

// ------------------------------------------------------------------ reading the printed PDF

export interface PrintedInfo {
  pages: number
  /** Outline entries in document order with their 1-based page. */
  outline: Array<{ title: string; page: number; depth: number }>
  /** How far down the last page the text reaches (0-1 of the page height). */
  lastFill: number
}

/** `margins` (inches) let the page-margin boxes (header, page numbers) be ignored when measuring the last page. */
export async function readPrinted(pdf: Buffer, margins?: { top: number; bottom: number }): Promise<PrintedInfo> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: true })
  const doc = await task.promise
  try {
    const outline: PrintedInfo['outline'] = []
    const walk = async (items: Array<{ title: string; dest: unknown; items: unknown[] }> | null, depth: number): Promise<void> => {
      for (const it of items ?? []) {
        let page = 0
        try {
          const dest = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : (it.dest as unknown[] | null)
          if (dest?.[0]) page = (await doc.getPageIndex(dest[0] as never)) + 1
        } catch { /* unknown */ }
        outline.push({ title: undouble(it.title), page, depth })
        await walk(it.items as never, depth + 1)
      }
    }
    await walk((await doc.getOutline()) as never, 0)
    const last = await doc.getPage(doc.numPages)
    const view = last.view
    const H = view[3] - view[1]
    const items = (await last.getTextContent()).items as Array<{ str?: string; transform?: number[] }>
    const top = H - (margins?.top ?? 0) * 72, bottom = (margins?.bottom ?? 0) * 72
    let low = H, any = false
    for (const it of items) {
      if (!it.str?.trim() || !it.transform) continue
      const y = it.transform[5]
      if (margins && (y < bottom - 2 || y > top + 2)) continue
      low = Math.min(low, y); any = true
    }
    // Share of the text area used on the last page.
    const area = top - bottom
    return { pages: doc.numPages, outline, lastFill: any ? Math.min(1, (top - low) / Math.max(1, area)) : 0 }
  } finally {
    await task.destroy()
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’“”"']/g, '').replace(/\s+/g, ' ').trim()
/** Chromium sometimes writes a heading split across a page boundary twice ("TitleTitle"): undo that. */
export const undouble = (t: string): string => { const h = t.length / 2; return t.length % 2 === 0 && t.length > 2 && t.slice(0, h) === t.slice(h) ? t.slice(0, h) : t }

/** TOC page numbers by heading id, matched to the outline in order. `offset` is added (0: body numbering). */
export function tocPagesFrom(p: Prepared, info: PrintedInfo): Record<string, string> {
  const heads = headingIds(p.blocks)
  const out: Record<string, string> = {}
  let k = 0
  for (const h of heads) {
    const want = norm(smartQuotes(h.text))
    let j = k
    while (j < info.outline.length && norm(undouble(info.outline[j].title)) !== want) j++
    if (j < info.outline.length) { out[h.id] = info.outline[j].page ? String(info.outline[j].page) : ''; k = j + 1 }
  }
  return out
}

// ------------------------------------------------------------------ finishing

export interface FinishMeta { title: string; author?: string; subject?: string; keywords?: string[]; lang?: string }

/** Inserts the cover, sets metadata, language, page labels and the "show title" preference. */
export async function finishPdf(body: Buffer, cover: Buffer | undefined, meta: FinishMeta): Promise<Buffer> {
  const L = await import('pdf-lib')
  const doc = await L.PDFDocument.load(body, { updateMetadata: false })
  if (cover) {
    const src = await L.PDFDocument.load(cover)
    const [page] = await doc.copyPages(src, [0])
    // The cover's structure tags belong to its own document: drop the dangling references.
    page.node.delete(L.PDFName.of('StructParents'))
    doc.insertPage(0, page)
    const nums = doc.context.obj([0, doc.context.obj({ P: L.PDFHexString.fromText('Cover') }), 1, doc.context.obj({ S: L.PDFName.of('D'), St: 1 })])
    doc.catalog.set(L.PDFName.of('PageLabels'), doc.context.obj({ Nums: nums }))
  }
  // Bookmarks: undo doubled titles.
  try {
    const outlines = doc.catalog.lookupMaybe(L.PDFName.of('Outlines'), L.PDFDict)
    const visit = (ref: unknown, depth: number): void => {
      type Dict = import('pdf-lib').PDFDict
      for (let item = ref ? doc.context.lookup(ref as never) as Dict | undefined : undefined, guard = 0; item && guard < 5000; guard++) {
        const t = item.lookup(L.PDFName.of('Title'))
        if (t instanceof L.PDFHexString || t instanceof L.PDFString) { const s = t.decodeText(); const u = undouble(s); if (u !== s) item.set(L.PDFName.of('Title'), L.PDFHexString.fromText(u)) }
        if (depth < 8) visit(item.get(L.PDFName.of('First')), depth + 1)
        const next = item.get(L.PDFName.of('Next'))
        item = next ? doc.context.lookup(next) as Dict : undefined
      }
    }
    if (outlines) visit(outlines.get(L.PDFName.of('First')), 0)
  } catch { /* leave the outline as Chromium wrote it */ }
  doc.setTitle(meta.title, { showInWindowTitleBar: true })
  if (meta.author) doc.setAuthor(meta.author)
  if (meta.subject) doc.setSubject(meta.subject)
  if (meta.keywords?.length) doc.setKeywords(meta.keywords)
  doc.setLanguage(meta.lang ?? 'en-US')
  doc.setCreator('SahilBot')
  doc.setProducer('SahilBot document engine (Chromium, pdf-lib)')
  const now = new Date()
  doc.setCreationDate(now)
  doc.setModificationDate(now)
  return Buffer.from(await doc.save())
}
