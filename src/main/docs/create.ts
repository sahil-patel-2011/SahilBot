import { BrowserWindow } from 'electron'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { chartProblems } from './chart'
import { buildDocx, type Citation, type DocxOptions, type Margins, type PageSize } from './docx'
import { loadImage } from './image'
import type { DocBlock, ParsedDoc } from './markdown'
import { bodyHtml, coverHtml, defaultLayout, finishPdf, preparePdf, readPrinted, tighter, tocPagesFrom, type PdfLayout, type PdfOptions } from './pdfdoc'
import { buildPptx, type SlideSpec } from './pptx'
import type { TemplateFields, TemplateKind } from './templates'
import { themeOf, type ThemeName } from './theme'
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
  page_size?: PageSize
  /** Inches: one number, or {top, right, bottom, left}. */
  margins?: Margins
  /** Base text size in points (readable range 8.5-16). */
  font_size?: number
  /** Aim for at most this many pages (spacing, then type and margins tighten within readable limits). */
  fit_pages?: number
  font?: string
  citations?: Array<string | Citation>
  footnotes?: Record<string, string>
  lang?: string
  keywords?: string[]
  /** Look shared by every format: modern (default), classic, minimal. Decks also take light | dark (background). */
  theme?: ThemeName | 'light' | 'dark'
  /** Deck background (default light). */
  background?: 'light' | 'dark'
  // Decks
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
  /** Pages (PDF: exact; Word: as Word lays them out, estimated). */
  pages?: number
  /** Layout changes the engine made (fitting to pages, tightening). */
  notes?: string[]
}

// ------------------------------------------------------------------ pdf

export type { PdfOptions } from './pdfdoc'

export interface PdfBuild {
  buffer: Buffer
  pages: number
  warnings: string[]
  /** What the engine did to the layout (fitting, tightening). */
  notes: string[]
}

/** Prints HTML to PDF in a hidden, offline, script-free window. */
async function printHtml(html: string): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'sb-pdf-'))
  const file = join(dir, 'doc.html')
  writeFileSync(file, html)
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, partition: 'sb-pdf-print' } })
  try {
    await win.loadFile(file)
    return await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, generateDocumentOutline: true, generateTaggedPDF: true })
  } finally {
    win.destroy()
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A PDF from Markdown or blocks through Chromium's print engine (see pdfdoc.ts for what it does): themed
 * typography, cover, TOC with page numbers, bookmarks, running header and "Page X of Y", fitted to a page
 * count when asked, finished with metadata.
 */
export async function buildPdf(input: string | DocBlock[] | ParsedDoc, o: PdfOptions = {}): Promise<PdfBuild> {
  const p = preparePdf(input, o)
  const warnings: string[] = []
  const notes: string[] = []
  const io = { baseDir: o.baseDir, readImage: o.readImage }
  for (const b of p.blocks) {
    if (b.type === 'image') { try { loadImage(b.src, o.baseDir, o.readImage) } catch (e) { warnings.push((e as Error).message) } }
    if (b.type === 'chart') { const pr = chartProblems(b.chart); if (pr.length) warnings.push(`Chart${b.chart.title ? ` "${b.chart.title}"` : ''}: ${pr.join(' ')}`) }
  }
  let layout = defaultLayout(p)
  const render = async (l: PdfLayout) => { const buf = await printHtml(bodyHtml(p, l, io)); return { l, buf, info: await readPrinted(buf, l.margins) } }
  let r = await render(layout)
  const want = p.opts.fitPages && p.opts.fitPages > 0 ? Math.round(p.opts.fitPages) - (p.cover ? 1 : 0) : undefined
  if (want && r.info.pages > want) {
    // Fit to N pages: tighten step by step; keep the first layout that fits.
    let best = r
    for (let step = 0, l: PdfLayout | undefined = tighter(layout, 0); l; l = tighter(best.l, ++step)) {
      const t = await render(l)
      best = t
      if (t.info.pages <= want) break
    }
    if (best.info.pages <= want) notes.push(`Fitted to ${want + (p.cover ? 1 : 0)} page(s): ${describe(layout, best.l)}.`)
    else notes.push(`Could not fit ${want + (p.cover ? 1 : 0)} page(s) within readable limits (smallest type ${best.l.fontSize} pt): ${best.info.pages + (p.cover ? 1 : 0)} pages. Shorten the content.`)
    r = best
  } else if (!want && r.info.pages > 1 && r.info.lastFill < 0.2) {
    // A last page with a few lines on it: tighten the spacing a little to pull them back.
    for (let step = 0; step < 2; step++) {
      const t = await render(tighter(r.l, step)!)
      if (t.info.pages < r.info.pages) { notes.push(`Tightened spacing slightly so the last page isn't nearly empty (${r.info.pages} → ${t.info.pages} pages).`); r = t; break }
    }
  }
  layout = r.l
  // One page: "Page 1 of 1" is noise, unless page numbers were asked for.
  if (r.info.pages === 1 && o.pageNumbers === undefined && layout.pageNumbers) { layout = { ...layout, pageNumbers: false }; r = await render(layout) }
  // TOC page numbers: a second pass with the pages the first one found (a third if that moved anything).
  if (p.hasToc) {
    for (let pass = 0; pass < 2; pass++) {
      const pages = tocPagesFrom(p, r.info)
      if (layout.tocPages && Object.entries(pages).every(([k, v]) => layout.tocPages![k] === v)) break
      layout = { ...layout, tocPages: pages }
      r = await render(layout)
    }
  }
  const missing = r.info.outline.length === 0 && p.blocks.some((b) => b.type === 'heading')
  if (missing) warnings.push('The PDF has no bookmarks (outline).')
  const cover = p.cover ? await printHtml(coverHtml(p, layout)) : undefined
  const author = p.opts.author?.replace(/^Prepared by /, '') ?? p.opts.fields?.author ?? p.opts.fields?.from
  const buffer = await finishPdf(r.buf, cover, { title: p.title, author, subject: p.opts.subtitle, keywords: o.keywords, lang: o.lang })
  return { buffer, pages: r.info.pages + (cover ? 1 : 0), warnings, notes }
}

function describe(a: PdfLayout, b: PdfLayout): string {
  const out: string[] = []
  if (b.density < a.density) out.push(`spacing ${Math.round(b.density * 100)}%`)
  if (b.fontSize < a.fontSize) out.push(`text ${b.fontSize} pt (was ${a.fontSize})`)
  if (b.margins.left < a.margins.left || b.margins.top < a.margins.top) out.push(`margins ${b.margins.top.toFixed(2)}"/${b.margins.left.toFixed(2)}"`)
  return out.join(', ') || 'no changes'
}

export async function renderPdf(input: string | DocBlock[] | ParsedDoc, o: PdfOptions = {}): Promise<Buffer> {
  return (await buildPdf(input, o)).buffer
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
  const accent = /^#[0-9a-f]{6}$/i.test(spec.accent ?? '') ? spec.accent! : undefined
  const docTheme: ThemeName | undefined = spec.theme === 'light' || spec.theme === 'dark' ? undefined : spec.theme
  const prose = (): string | DocBlock[] => {
    if (spec.blocks?.length) return spec.blocks
    if (spec.markdown !== undefined) return spec.markdown
    throw new Error(`A ${ext === '.pdf' ? 'PDF' : 'Word document'} needs "markdown" (or "blocks").`)
  }
  const docOpts = (): DocxOptions => ({
    title: spec.title, accent, template: spec.template, fields: spec.fields, subtitle: spec.subtitle, author: spec.author,
    toc: spec.toc, cover: spec.cover, header: (spec.header as unknown) === true ? undefined : spec.header, footer: (spec.footer as unknown) === true ? undefined : spec.footer, pageNumbers: spec.page_numbers,
    orientation: spec.orientation, pageSize: spec.page_size, margins: spec.margins, fontSize: spec.font_size, fitPages: spec.fit_pages, theme: docTheme,
    font: spec.font, citations: spec.citations, footnotes: spec.footnotes, lang: spec.lang, keywords: spec.keywords,
    baseDir: dirname(fullPath), readImage: co.readImage
  })
  let buf: Buffer
  let warnings: string[] = []
  let notes: string[] = []
  let slides: number | undefined
  let pages: number | undefined
  switch (ext) {
    case '.pdf': {
      const { font: _font, ...pdfOpts } = docOpts()
      const r = await buildPdf(prose(), pdfOpts)
      buf = r.buffer
      warnings = r.warnings
      notes = r.notes
      pages = r.pages
      break
    }
    case '.docx': {
      const r = await buildDocx(prose(), docOpts())
      buf = r.buffer
      warnings = r.warnings
      notes = r.notes ?? []
      pages = r.stats.pages
      break
    }
    case '.pptx': {
      if (!spec.slides?.length) throw new Error('A deck needs "slides".')
      const background = spec.background ?? (spec.theme === 'dark' ? 'dark' : 'light')
      const r = await buildPptx(spec.slides, { title, accent, theme: background, style: docTheme, font: spec.font, slideNumbers: spec.slide_numbers, footer: typeof spec.footer === 'string' ? spec.footer : undefined, author: spec.author, baseDir: dirname(fullPath), readImage: co.readImage })
      buf = r.buffer
      warnings = r.warnings
      slides = r.slides
      break
    }
    case '.xlsx': {
      if (!spec.sheets?.length) throw new Error('A spreadsheet needs "sheets".')
      const r = await buildXlsx(spec.sheets, { accent: themeOf(docTheme, accent).accentText, summary: spec.summary, currency: spec.currency, title: spec.title, author: spec.author })
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
  return { bytes: buf.length, kind: ext.slice(1).toUpperCase(), ...(warnings.length ? { warnings } : {}), ...(slides !== undefined ? { slides } : {}), ...(pages !== undefined ? { pages } : {}), ...(notes.length ? { notes } : {}) }
}
