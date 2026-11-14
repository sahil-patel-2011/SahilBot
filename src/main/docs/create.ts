import { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { buildDocx, type Citation, type DocxOptions } from './docx'
import { loadImage } from './image'
import { blocksToHtml, escapeHtml, parseMarkdown, plainText, type DocBlock, type ParsedDoc } from './markdown'
import { buildPptx, type SlideSpec } from './pptx'
import { applyTemplate, longDate, type TemplateFields, type TemplateKind } from './templates'
import { buildXlsx, type SheetSpec, type WorkbookOptions } from './xlsx'

// Documents are rendered from a small, deterministic spec: Markdown (or blocks) for prose (docx, pdf),
// slides for decks, sheets for spreadsheets. The model writes data, never library code.
// The generators live in docx.ts, pptx.ts, xlsx.ts; this file keeps the original entry points
// (markdownToDocx, slidesToPptx, sheetsToXlsx, markdownToPdf, createDocument) and adds renderPdf.

export type { SlideSpec } from './pptx'
export type { SheetSpec } from './xlsx'

export interface DocSpec {
  path: string
  title?: string
  markdown?: string
  /** Structured content instead of markdown (docx, pdf). */
  blocks?: DocBlock[]
  slides?: SlideSpec[]
  sheets?: SheetSpec[]
  accent?: string
  // Word and PDF
  template?: TemplateKind
  fields?: TemplateFields
  subtitle?: string
  author?: string
  toc?: boolean
  cover?: boolean
  header?: string | false
  footer?: string | false
  page_numbers?: boolean
  orientation?: 'portrait' | 'landscape'
  page_size?: 'letter' | 'a4'
  font?: string
  citations?: Array<string | Citation>
  footnotes?: Record<string, string>
  // Decks
  theme?: 'light' | 'dark'
  slide_numbers?: boolean
  // Workbooks
  summary?: WorkbookOptions['summary']
  currency?: string
}

export interface CreateResult {
  bytes: number
  kind: string
  /** Things the generator fixed or couldn't do (split slides, missing images, formula errors…). */
  warnings?: string[]
  /** Slides actually written (long slides continue on extra slides). */
  slides?: number
}

const DEFAULT_ACCENT = '#FF6A1A'

// ------------------------------------------------------------------ pdf

const css = (accent: string, o: { landscape?: boolean; size?: 'letter' | 'a4' }): string => `
  @page { size: ${o.size === 'a4' ? 'A4' : 'Letter'}${o.landscape ? ' landscape' : ''}; margin: 0.9in 0.85in; }
  @page wide { size: ${o.size === 'a4' ? 'A4' : 'Letter'} landscape; }
  body { font: 11pt/1.55 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1a1a1a; }
  h1 { font-size: 20pt; margin: 18pt 0 8pt; color: ${accent}; page-break-after: avoid; }
  h2 { font-size: 15pt; margin: 16pt 0 6pt; color: #111; page-break-after: avoid; }
  h3 { font-size: 12.5pt; margin: 14pt 0 4pt; color: ${accent}; page-break-after: avoid; }
  h4 { font-size: 11pt; margin: 12pt 0 4pt; font-style: italic; }
  p { margin: 0 0 8pt; } ul, ol { margin: 0 0 8pt; padding-left: 18pt; } li { margin: 2pt 0; }
  p.title { font-size: 26pt; font-weight: 700; margin: 0 0 4pt; letter-spacing: -0.01em; }
  p.title::after { content: ''; display: block; width: 48pt; height: 3pt; background: ${accent}; margin-top: 8pt; border-radius: 2pt; }
  p.subtitle { font-size: 14pt; color: #5f6368; } p.lead { font-size: 13pt; color: #374151; } p.small { font-size: 9pt; color: #5f6368; }
  .caption { font-size: 9pt; font-style: italic; color: #5f6368; margin: 4pt 0 6pt; }
  table { border-collapse: collapse; width: 100%; margin: 4pt 0 12pt; font-size: 9.5pt; page-break-inside: auto; }
  thead { display: table-header-group; } tr { page-break-inside: avoid; }
  th { background: ${accent}; color: white; text-align: left; } th, td { padding: 4pt 7pt; border: 0.5pt solid #d0d5dd; }
  table.banded tbody tr:nth-child(even) td { background: #f2f4f7; }
  table.total tbody tr:last-child td { font-weight: 700; border-top: 1.5pt solid #1a1a1a; }
  code { font: 9pt "SF Mono", Menlo, monospace; background: #f1f1f1; padding: 1pt 3pt; border-radius: 3pt; }
  pre { background: #f4f4f4; padding: 8pt 10pt; border-radius: 6pt; white-space: pre-wrap; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 3pt solid ${accent}; margin: 8pt 0; padding: 2pt 12pt; color: #374151; font-style: italic; }
  blockquote cite { display: block; text-align: right; font-style: normal; color: #5f6368; }
  .callout { border-left: 4pt solid #2563eb; background: #eff6ff; padding: 6pt 10pt; margin: 8pt 0; border-radius: 3pt; }
  .callout.warning { border-color: #d97706; background: #fffbeb; } .callout.caution { border-color: #dc2626; background: #fef2f2; }
  .callout.tip { border-color: #16a34a; background: #f0fdf4; } .callout.important { border-color: #7c3aed; background: #f5f3ff; }
  figure { margin: 10pt 0; text-align: center; page-break-inside: avoid; } img { max-width: 100%; max-height: 7.5in; }
  hr { border: none; border-top: 0.75pt solid #d0d5dd; margin: 12pt 0; }
  .pb { page-break-after: always; }
  .sec.landscape { page: wide; }
  .toc { margin: 0 0 18pt; } .toc-title { font-size: 16pt; font-weight: 700; margin-bottom: 6pt; }
  .toc a { display: block; color: #1a1a1a; text-decoration: none; padding: 1.5pt 0; border-bottom: 0.5pt dotted #ccc; }
  .toc a.l2 { padding-left: 14pt; } .toc a.l3 { padding-left: 28pt; font-size: 10pt; } .toc a.l4 { padding-left: 42pt; font-size: 10pt; }
  .cover { height: 8.4in; display: flex; flex-direction: column; justify-content: center; page-break-after: always; }
  .cover .t { font-size: 34pt; font-weight: 700; line-height: 1.15; } .cover .s { font-size: 16pt; color: #5f6368; margin-top: 8pt; }
  .cover .rule { width: 64pt; height: 4pt; background: ${accent}; margin: 18pt 0; border-radius: 2pt; } .cover .m { color: #5f6368; margin-top: 2pt; }
  .footnotes { font-size: 9pt; color: #374151; } sup.fn a { color: ${accent}; text-decoration: none; }
  a { color: #1d4ed8; }
`

/** Same options as Word documents (fonts aside: the PDF uses the system font). */
export type PdfOptions = DocxOptions

/**
 * A PDF from Markdown or blocks through Chromium's print engine: real headings (with a PDF outline),
 * cover, table of contents, tables, images, footnotes, landscape sections, header and "Page X of Y" footer.
 */
export async function renderPdf(input: string | DocBlock[] | ParsedDoc, o: PdfOptions = {}): Promise<Buffer> {
  const parsed: ParsedDoc = typeof input === 'string' ? parseMarkdown(input) : Array.isArray(input) ? { blocks: input, footnotes: {} } : input
  let blocks = parsed.blocks
  let opts = { ...o }
  if (o.template) {
    const t = applyTemplate(o.template, parsed, o.fields, o.title)
    blocks = t.blocks
    opts = { ...opts, title: opts.title ?? t.title, cover: opts.cover ?? t.layout.cover, toc: opts.toc ?? t.layout.toc, header: opts.header ?? t.layout.header, pageNumbers: opts.pageNumbers ?? t.layout.pageNumbers, subtitle: opts.subtitle ?? t.layout.subtitle, author: opts.author ?? t.layout.author, date: opts.date ?? t.layout.date }
  }
  const accent = /^#[0-9a-f]{6}$/i.test(opts.accent ?? '') ? opts.accent! : DEFAULT_ACCENT
  const first = blocks[0]
  const h1s = blocks.filter((b) => b.type === 'heading' && b.level === 1).length
  let title = opts.title
  if (first?.type === 'heading' && first.level === 1 && h1s === 1) {
    title ??= plainText(first.text)
    blocks = opts.cover ? blocks.slice(1) : [{ type: 'paragraph', style: 'title', text: first.text }, ...blocks.slice(1)]
  }
  title ??= 'Document'
  const heads = blocks.filter((b) => b.type === 'heading' && b.level <= 2).length
  const roughWords = (blocksToHtml(blocks).replace(/<[^>]+>/g, ' ').match(/[A-Za-z0-9']+/g) ?? []).length
  if (!blocks.some((b) => b.type === 'toc') && (opts.toc === true || ((opts.toc ?? 'auto') === 'auto' && ((heads >= 4 && roughWords >= 600) || (heads >= 2 && roughWords > 1800))))) {
    let at = 0
    while (at < blocks.length && blocks[at].type === 'paragraph' && ['title', 'subtitle'].includes((blocks[at] as { style?: string }).style ?? '')) at++
    blocks = [...blocks.slice(0, at), { type: 'toc' }, ...blocks.slice(at)]
  }
  const image = (src: string): string | undefined => {
    try {
      const img = loadImage(src, opts.baseDir, opts.readImage)
      return `data:image/${img.type === 'jpg' ? 'jpeg' : img.type};base64,${img.data.toString('base64')}`
    } catch { return undefined }
  }
  const cover = opts.cover ? `<section class="cover"><div class="t">${escapeHtml(title)}</div>${opts.subtitle ? `<div class="s">${escapeHtml(opts.subtitle)}</div>` : ''}<div class="rule"></div>${opts.author ? `<div class="m">${escapeHtml(opts.author)}</div>` : ''}<div class="m">${escapeHtml(opts.date ?? longDate())}</div></section>` : ''
  const body = blocksToHtml(blocks, { footnotes: { ...parsed.footnotes, ...(opts.footnotes ?? {}) }, image })
  const refs = opts.citations?.length ? `<h2>References</h2><ol>${opts.citations.map((c) => { const x = typeof c === 'string' ? { text: c } : c; return `<li>${escapeHtml(x.text)}${x.url ? ` <a href="${escapeHtml(x.url)}">${escapeHtml(x.url)}</a>` : ''}</li>` }).join('')}</ol>` : ''
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${css(accent, { landscape: opts.orientation === 'landscape', size: opts.pageSize })}</style></head><body>${cover}${body}${refs}</body></html>`
  const headerText = opts.header === false ? '' : opts.header ?? (opts.cover ? title : '')
  const numbers = opts.pageNumbers ?? true
  const small = 'font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:8pt;color:#6b7280;width:100%;padding:0 0.85in;'
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } })
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    return await win.webContents.printToPDF({
      printBackground: true,
      // The CSS @page rules decide the size, so landscape sections come out landscape.
      preferCSSPageSize: true,
      pageSize: opts.pageSize === 'a4' ? 'A4' : 'Letter',
      landscape: opts.orientation === 'landscape',
      generateDocumentOutline: true,
      displayHeaderFooter: !!headerText || numbers || !!opts.footer,
      headerTemplate: `<div style="${small}text-align:right">${escapeHtml(headerText || '')}</div>`,
      footerTemplate: `<div style="${small}display:flex;justify-content:space-between"><span>${escapeHtml(opts.footer || '')}</span><span>${numbers ? 'Page <span class="pageNumber"></span> of <span class="totalPages"></span>' : ''}</span></div>`
    })
  } finally {
    win.destroy()
  }
}

/** The original entry point: a PDF from Markdown. */
export async function markdownToPdf(markdown: string, title: string, accent: string): Promise<Buffer> {
  return renderPdf(markdown, { title, accent, toc: false, pageNumbers: false, header: false })
}

// ------------------------------------------------------------------ original entry points

export async function markdownToDocx(markdown: string, title: string, accent: string): Promise<Buffer> {
  return (await buildDocx(markdown, { title, accent })).buffer
}

export async function slidesToPptx(slides: SlideSpec[], title: string, accent: string): Promise<Buffer> {
  return (await buildPptx(slides, { title, accent })).buffer
}

export async function sheetsToXlsx(sheets: SheetSpec[], accent: string): Promise<Buffer> {
  return (await buildXlsx(sheets, { accent })).buffer
}

// ------------------------------------------------------------------ entry

/** Options for where images may be read from (the tool limits them to the workspace and attached folders). */
export interface CreateOptions {
  readImage?: (src: string) => Buffer
}

export async function createDocument(fullPath: string, spec: DocSpec, co: CreateOptions = {}): Promise<CreateResult> {
  const ext = extname(fullPath).toLowerCase()
  const title = spec.title ?? spec.slides?.[0]?.title ?? fullPath.split('/').pop()!.replace(/\.\w+$/, '')
  const accent = /^#[0-9a-f]{6}$/i.test(spec.accent ?? '') ? spec.accent! : DEFAULT_ACCENT
  const prose = (): string | DocBlock[] => {
    if (spec.blocks?.length) return spec.blocks
    if (spec.markdown !== undefined) return spec.markdown
    throw new Error(`A ${ext === '.pdf' ? 'PDF' : 'Word document'} needs "markdown" (or "blocks").`)
  }
  const docOpts = (): DocxOptions => ({
    title: spec.title, accent, template: spec.template, fields: spec.fields, subtitle: spec.subtitle, author: spec.author,
    toc: spec.toc, cover: spec.cover, header: (spec.header as unknown) === true ? undefined : spec.header, footer: (spec.footer as unknown) === true ? undefined : spec.footer, pageNumbers: spec.page_numbers,
    orientation: spec.orientation, pageSize: spec.page_size, font: spec.font, citations: spec.citations, footnotes: spec.footnotes,
    baseDir: dirname(fullPath), readImage: co.readImage
  })
  let buf: Buffer
  let warnings: string[] = []
  let slides: number | undefined
  switch (ext) {
    case '.pdf':
      buf = await renderPdf(prose(), { ...docOpts(), accent })
      break
    case '.docx': {
      const r = await buildDocx(prose(), docOpts())
      buf = r.buffer
      warnings = r.warnings
      break
    }
    case '.pptx': {
      if (!spec.slides?.length) throw new Error('A deck needs "slides".')
      const r = await buildPptx(spec.slides, { title, accent, theme: spec.theme, font: spec.font, slideNumbers: spec.slide_numbers, footer: typeof spec.footer === 'string' ? spec.footer : undefined, author: spec.author, baseDir: dirname(fullPath), readImage: co.readImage })
      buf = r.buffer
      warnings = r.warnings
      slides = r.slides
      break
    }
    case '.xlsx': {
      if (!spec.sheets?.length) throw new Error('A spreadsheet needs "sheets".')
      const r = await buildXlsx(spec.sheets, { accent, summary: spec.summary, currency: spec.currency, title: spec.title, author: spec.author })
      buf = r.buffer
      warnings = r.warnings
      break
    }
    case '.md':
    case '.txt':
    case '.html':
    case '.csv':
      throw new Error(`Use file_write for ${ext} files.`)
    default:
      throw new Error(`Unsupported document type "${ext}". Use .pdf, .docx, .pptx or .xlsx.`)
  }
  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, buf)
  return { bytes: buf.length, kind: ext.slice(1).toUpperCase(), ...(warnings.length ? { warnings } : {}), ...(slides !== undefined ? { slides } : {}) }
}
