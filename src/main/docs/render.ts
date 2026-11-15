import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { inflateSync } from 'node:zlib'

// Renders finished documents to page images without Office, so the agent (and review_document) can see
// what the reader will see:
//   PDF               every page through macOS PDFKit (osascript JavaScript; no Xcode, no extra installs).
//   DOCX/PPTX/XLSX    macOS Quick Look's Office converter (the same engine as Finder previews) to HTML,
//                     laid out on real pages by Chromium (inside the app), then through PDFKit like a PDF.
//                     Without Electron (plain Node) only the first page is available, as a Quick Look thumbnail.
// Pages are also measured: blank pages, ink at the page edges (cut-off content), how full the last page
// is, slide text that overflows its box and text with too little contrast.

export interface PageImage { page: number; path: string; width: number; height: number }

export interface PageCheck {
  page: number
  /** Share of the page that isn't background (0-1). */
  ink: number
  blank: boolean
  /** Ink touching the outer edge bands (right/bottom/left/top), as a share of that band. */
  edge: { top: number; right: number; bottom: number; left: number }
  /** Bottom of the lowest ink, as a share of the page height. */
  bottom: number
  /** Ink per horizontal band (50 bands, top to bottom), 0-1: where the content sits on the page. */
  rows: number[]
}

/** How far down the page the body reaches (0-1), ignoring the header and footer zones (top 9%, bottom 11%). */
export function bodyFill(c: PageCheck): number {
  const n = c.rows.length
  const from = Math.floor(n * 0.09), to = Math.ceil(n * 0.89)
  let first = -1, last = -1
  for (let i = from; i < to; i++) if (c.rows[i] > 0.002) { if (first < 0) first = i; last = i }
  return last < 0 ? 0 : (last + 1 - from) / (to - from)
}

export interface RenderResult {
  kind: 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'other'
  /** How it was rendered: pdfkit (exact), quicklook (Office files laid out by Quick Look + Chromium), thumbnail (first page only). */
  method: 'pdfkit' | 'quicklook' | 'thumbnail'
  pageCount: number
  /** Page (or slide) sizes in points. */
  sizes: Array<{ w: number; h: number }>
  images: PageImage[]
  /** All pages tiled in one picture (JPEG), for a quick look at the whole document. */
  sheet?: string
  /** The PDF the Office file was laid out as (quicklook method). */
  pdf?: string
  checks: PageCheck[]
  /** Text that overflows its box or the page, found while laying out an Office file. */
  overflow: string[]
  /** Text whose contrast with its background is too low to read comfortably. */
  lowContrast: string[]
  notes: string[]
}

export interface RenderOptions {
  /** Output folder (default: a new temp folder). */
  outDir?: string
  /** Pixel width of each page image (default 1100). */
  width?: number
  /** 1-based pages to save as images (default: all, up to maxPages). */
  pages?: number[]
  /** Most page images to write (default 40). */
  maxPages?: number
  /** Build a contact sheet of all pages (default true). */
  sheet?: boolean
}

export const canRender = (): boolean => process.platform === 'darwin'

function run(cmd: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${(stderr || err.message).toString().trim().slice(0, 400)}`))
      else resolve(stdout.toString())
    })
  })
}

// ------------------------------------------------------------------ PDFKit through osascript

const JXA = `ObjC.import('PDFKit'); ObjC.import('AppKit')
function save(img, path, jpeg) {
  const rep = $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation)
  const props = jpeg ? $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithDouble(0.82), $.NSImageCompressionFactor) : $()
  const data = rep.representationUsingTypeProperties(jpeg ? $.NSBitmapImageFileTypeJPEG : $.NSBitmapImageFileTypePNG, props)
  return data.writeToFileAtomically(path, true)
}
function run(argv) {
  const job = JSON.parse(argv[0])
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(job.pdf))
  if (!doc || doc.isNil()) return JSON.stringify({ error: 'This PDF could not be opened.' })
  const n = Number(doc.pageCount)
  const sizes = [], images = []
  for (let i = 0; i < n; i++) {
    const b = doc.pageAtIndex(i).boundsForBox($.kPDFDisplayBoxCropBox)
    sizes.push({ w: Math.round(b.size.width), h: Math.round(b.size.height) })
  }
  if (job.transparent) {
    // Vector art (Quick Look's shape attachments): drawn on a clear canvas, not white paper.
    const src = $.NSImage.alloc.initWithContentsOfFile(job.pdf)
    const s = sizes[0], w = job.width, h = Math.max(1, Math.round(job.width * s.h / s.w))
    const canvas = $.NSImage.alloc.initWithSize($.NSMakeSize(w, h))
    canvas.lockFocus
    src.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, w, h), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1)
    canvas.unlockFocus
    const path = job.dir + '/' + job.prefix + '001.png'
    if (save(canvas, path, false)) images.push({ page: 1, path, width: w, height: h })
    return JSON.stringify({ pages: n, sizes, images })
  }
  const want = job.pages && job.pages.length ? job.pages : sizes.map((_, i) => i + 1)
  for (const p of want) {
    if (p < 1 || p > n) continue
    const s = sizes[p - 1], w = job.width, h = Math.round(job.width * s.h / s.w)
    const img = doc.pageAtIndex(p - 1).thumbnailOfSizeForBox($.NSMakeSize(w, h), $.kPDFDisplayBoxCropBox)
    const path = job.dir + '/' + job.prefix + String(p).padStart(3, '0') + '.png'
    if (save(img, path, false)) images.push({ page: p, path, width: w, height: h })
  }
  let sheet
  if (job.sheet && n > 0) {
    const count = Math.min(n, job.sheetMax)
    const cols = Math.min(count, count <= 2 ? count : count <= 4 ? 2 : count <= 9 ? 3 : 4)
    const rows = Math.ceil(count / cols)
    const tileW = Math.round((job.sheetWidth - 24 * (cols + 1)) / cols)
    const ratio = Math.max(...sizes.slice(0, count).map((s) => s.h / s.w))
    const tileH = Math.round(tileW * ratio)
    const W = job.sheetWidth, H = rows * (tileH + 40) + 24
    const canvas = $.NSImage.alloc.initWithSize($.NSMakeSize(W, H))
    canvas.lockFocus
    $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.88, 0.89, 0.91, 1).setFill
    $.NSRectFill($.NSMakeRect(0, 0, W, H))
    for (let i = 0; i < count; i++) {
      const s = sizes[i]
      const w = tileW, h = Math.round(tileW * s.h / s.w)
      const c = i % cols, r = Math.floor(i / cols)
      const x = 24 + c * (tileW + 24), yTop = 24 + r * (tileH + 40)
      const y = H - yTop - h
      const img = doc.pageAtIndex(i).thumbnailOfSizeForBox($.NSMakeSize(w * 2, h * 2), $.kPDFDisplayBoxCropBox)
      $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.7, 0.71, 0.74, 1).setFill
      $.NSRectFill($.NSMakeRect(x - 1, y - 1, w + 2, h + 2))
      img.drawInRectFromRectOperationFraction($.NSMakeRect(x, y, w, h), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1)
      const label = $.NSString.stringWithString(String(i + 1))
      const attrs = $.NSDictionary.dictionaryWithObjectsForKeys($([$.NSFont.systemFontOfSize(15), $.NSColor.colorWithCalibratedRedGreenBlueAlpha(0.3, 0.32, 0.36, 1)]), $(['NSFont', 'NSColor']))
      label.drawAtPointWithAttributes($.NSMakePoint(x + w / 2 - 5, y - 26), attrs)
    }
    canvas.unlockFocus
    sheet = job.dir + '/' + job.prefix + 'sheet.jpg'
    if (!save(canvas, sheet, true)) sheet = undefined
  }
  return JSON.stringify({ pages: n, sizes, images, sheet })
}`

let jxaPath: string | undefined
function jxaScript(): string {
  if (jxaPath && existsSync(jxaPath)) return jxaPath
  const dir = mkdtempSync(join(tmpdir(), 'sb-render-'))
  jxaPath = join(dir, 'render.js')
  writeFileSync(jxaPath, JXA)
  return jxaPath
}

interface PdfKitOut { pages: number; sizes: Array<{ w: number; h: number }>; images: PageImage[]; sheet?: string; error?: string }

/** Renders PDF pages to PNG files (and a contact sheet) with PDFKit. */
export async function pdfToImages(pdf: string, o: RenderOptions & { prefix?: string; transparent?: boolean } = {}): Promise<PdfKitOut> {
  if (!canRender()) throw new Error('Rendering pages needs macOS.')
  const dir = o.outDir ?? mkdtempSync(join(tmpdir(), 'sb-pages-'))
  mkdirSync(dir, { recursive: true })
  const job = { pdf, dir, width: Math.round(o.width ?? 1100), pages: o.pages?.slice(0, o.maxPages ?? 40) ?? [], prefix: o.prefix ?? 'page-', transparent: !!o.transparent, sheet: o.sheet !== false && !o.transparent, sheetWidth: 1600, sheetMax: 16 }
  if (!job.pages.length && o.maxPages) job.pages = Array.from({ length: o.maxPages }, (_, i) => i + 1)
  const out = JSON.parse((await run('osascript', ['-l', 'JavaScript', jxaScript(), JSON.stringify(job)])).trim() || '{}') as PdfKitOut
  if (out.error) throw new Error(out.error)
  out.pages = Number(out.pages)
  return out
}

// ------------------------------------------------------------------ pixels

/** Decodes an 8-bit PNG (gray, RGB, RGBA; not interlaced) to RGBA. Returns undefined for other kinds. */
export function decodePng(buf: Buffer): { width: number; height: number; data: Uint8Array } | undefined {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return undefined
  let i = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0
  const idat: Buffer[] = []
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i), name = buf.toString('latin1', i + 4, i + 8)
    const body = buf.subarray(i + 8, i + 8 + len)
    if (name === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; type = body[9]; interlace = body[12] }
    else if (name === 'IDAT') idat.push(body)
    else if (name === 'IEND') break
    i += 12 + len
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[type]
  if (depth !== 8 || !channels || interlace) return undefined
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const px = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0
      const b = y ? px[(y - 1) * stride + x] : 0
      const c = x >= channels && y ? px[(y - 1) * stride + x - channels] : 0
      let v = raw[src + x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      px[y * stride + x] = v & 255
    }
  }
  const data = new Uint8Array(width * height * 4)
  for (let k = 0; k < width * height; k++) {
    const s = k * channels
    const [r, g, b, al] = channels === 1 ? [px[s], px[s], px[s], 255] : channels === 2 ? [px[s], px[s], px[s], px[s + 1]] : channels === 3 ? [px[s], px[s + 1], px[s + 2], 255] : [px[s], px[s + 1], px[s + 2], px[s + 3]]
    // Transparent pixels are white paper.
    data[k * 4] = (r * al + 255 * (255 - al)) / 255; data[k * 4 + 1] = (g * al + 255 * (255 - al)) / 255; data[k * 4 + 2] = (b * al + 255 * (255 - al)) / 255; data[k * 4 + 3] = 255
  }
  return { width, height, data }
}

/** Measures a rendered page: how much ink, where it ends, and whether it touches the page edges. */
export function analyzePage(png: Buffer, page: number, edgeShare = 0.025): PageCheck | undefined {
  const img = decodePng(png)
  if (!img) return undefined
  const { width: W, height: H, data } = img
  // Background: the most common of the four corner colors.
  const at = (x: number, y: number) => { const k = (y * W + x) * 4; return [data[k], data[k + 1], data[k + 2]] }
  const corners = [at(1, 1), at(W - 2, 1), at(1, H - 2), at(W - 2, H - 2)]
  const bg = corners.sort((p, q) => corners.filter((c) => c.join() === q.join()).length - corners.filter((c) => c.join() === p.join()).length)[0]
  const ink = (x: number, y: number): boolean => { const k = (y * W + x) * 4; return Math.abs(data[k] - bg[0]) + Math.abs(data[k + 1] - bg[1]) + Math.abs(data[k + 2] - bg[2]) > 90 }
  let count = 0, lowest = 0
  const ex = Math.max(2, Math.round(W * edgeShare)), ey = Math.max(2, Math.round(H * edgeShare))
  const edge = { top: 0, right: 0, bottom: 0, left: 0 }
  const BANDS = 50
  const rows = new Array<number>(BANDS).fill(0)
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      if (!ink(x, y)) continue
      count++
      rows[Math.min(BANDS - 1, Math.floor((y / H) * BANDS))]++
      if (y > lowest) lowest = y
      if (y < ey) edge.top++
      if (y >= H - ey) edge.bottom++
      if (x < ex) edge.left++
      if (x >= W - ex) edge.right++
    }
  }
  const samples = Math.ceil(W / 2) * Math.ceil(H / 2)
  const band = (n: number, horizontal: boolean) => n / Math.max(1, (horizontal ? Math.ceil(W / 2) * Math.ceil(ey / 2) : Math.ceil(H / 2) * Math.ceil(ex / 2)))
  return {
    page,
    ink: count / samples,
    blank: count / samples < 0.0008,
    edge: { top: band(edge.top, true), right: band(edge.right, false), bottom: band(edge.bottom, true), left: band(edge.left, false) },
    bottom: lowest / H,
    rows: rows.map((r) => r / Math.max(1, Math.ceil(W / 2) * Math.ceil(H / 2 / BANDS)))
  }
}

// ------------------------------------------------------------------ Office files through Quick Look

interface Electronish {
  app: { isReady(): boolean }
  BrowserWindow: new (o: unknown) => {
    loadFile(p: string): Promise<void>
    destroy(): void
    webContents: { printToPDF(o: unknown): Promise<Buffer>; executeJavaScript(code: string): Promise<unknown>; session: { webRequest: { onBeforeRequest(f: (d: { url: string }, cb: (r: { cancel: boolean }) => void) => void): void } } }
  }
}

async function electronMain(): Promise<Electronish | undefined> {
  try {
    const e = (await import('electron')) as unknown as Electronish & { default?: Electronish }
    const m = (e.BrowserWindow ? e : e.default) as Electronish | undefined
    return m?.BrowserWindow && m.app?.isReady() ? m : undefined
  } catch { return undefined }
}

/** Page size and margins (inches) of a .docx's first section. */
export function docxPageSetup(data: Buffer, xml?: string): { w: number; h: number; top: number; right: number; bottom: number; left: number } {
  const def = { w: 8.5, h: 11, top: 1, right: 1, bottom: 1, left: 1 }
  const doc = xml ?? ''
  const pg = /<w:pgSz\b[^>]*>/.exec(doc)?.[0]
  const mar = /<w:pgMar\b[^>]*>/.exec(doc)?.[0]
  const num = (tag: string | undefined, name: string): number | undefined => { const m = tag && new RegExp(`w:${name}="(-?\\d+)"`).exec(tag); return m ? Number(m[1]) / 1440 : undefined }
  void data
  return { w: num(pg, 'w') ?? def.w, h: num(pg, 'h') ?? def.h, top: Math.abs(num(mar, 'top') ?? def.top), right: num(mar, 'right') ?? def.right, bottom: Math.abs(num(mar, 'bottom') ?? def.bottom), left: num(mar, 'left') ?? def.left }
}

const MEASURE = (kind: string) => `(() => {
  const out = { overflow: [], lowContrast: [], slide: null }
  const lum = (c) => { const m = /rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?/.exec(c || ''); if (!m) return null; if (m[4] !== undefined && Number(m[4]) < 0.5) return null; const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(+m[1]) + 0.7152 * f(+m[2]) + 0.0722 * f(+m[3]) }
  // The background behind a point: the first painted thing under it (an image or gradient: unknown).
  const bgAt = (x, y, el) => {
    for (const e of document.elementsFromPoint(x, y)) {
      if (e === el || el.contains(e)) continue
      if (/^(IMG|SVG|CANVAS|VIDEO)$/i.test(e.tagName)) return null
      const s = getComputedStyle(e)
      if (s.backgroundImage && s.backgroundImage !== 'none') return null
      const l = lum(s.backgroundColor); if (l !== null) return l
    }
    return 1
  }
  const snippet = (t) => t.replace(/\\s+/g, ' ').trim().slice(0, 60)
  const slides = [...document.querySelectorAll('div.slide')]
  if (slides.length) out.slide = { w: slides[0].offsetWidth, h: slides[0].offsetHeight }
  const seen = new Set()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent || ''
    if (!text.trim()) continue
    const el = n.parentElement
    const r = document.createRange(); r.selectNodeContents(n)
    const box = r.getBoundingClientRect()
    if (!box.width) continue
    const where = slides.length ? (() => { const i = slides.findIndex((s) => s.contains(el)); return i >= 0 ? 'slide ' + (i + 1) : '' })() : ''
    // Text outside its slide, or outside a fixed-size box that hides overflow.
    const slide = slides.find((s) => s.contains(el))
    if (slide) {
      const sb = slide.getBoundingClientRect()
      if (box.bottom > sb.bottom + 2 || box.right > sb.right + 2) { const k = 'o' + snippet(text); if (!seen.has(k)) { seen.add(k); out.overflow.push((where ? where + ': ' : '') + '"' + snippet(text) + '" runs off the slide') } }
    }
    for (let e = el; e && e !== document.body && !(slide && e === slide); e = e.parentElement) {
      const s = getComputedStyle(e)
      if ((s.overflow === 'hidden' || s.overflowY === 'hidden') && e.clientHeight > 0 && e.scrollHeight > e.clientHeight + 3) {
        const eb = e.getBoundingClientRect()
        if (box.bottom > eb.bottom + 2) { const k = 'o' + snippet(text); if (!seen.has(k)) { seen.add(k); out.overflow.push((where ? where + ': ' : '') + '"' + snippet(text) + '" is cut off by its box') } }
        break
      }
    }
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const vb = r.getBoundingClientRect()
    const fgOwn = (() => { const s = getComputedStyle(el); return (s.backgroundImage && s.backgroundImage !== 'none') ? null : lum(s.backgroundColor) })()
    const fg = lum(getComputedStyle(el).color), bg = fgOwn ?? bgAt(vb.left + Math.min(vb.width / 2, 6), vb.top + vb.height / 2, el)
    if (fg !== null && bg !== null) {
      const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
      const size = parseFloat(getComputedStyle(el).fontSize) || 12
      const big = size >= 18 || (size >= 14 && Number(getComputedStyle(el).fontWeight) >= 600)
      if (ratio < (big ? 3 : 4.5) && out.lowContrast.length < 12) { const k = 'c' + snippet(text); if (!seen.has(k)) { seen.add(k); out.lowContrast.push((where ? where + ': ' : '') + '"' + snippet(text) + '" (contrast ' + ratio.toFixed(1) + ':1)') } }
    }
  }
  ${kind === 'docx' ? `const root = document.body.firstElementChild
  const limit = root ? root.getBoundingClientRect().right + 2 : innerWidth
  for (const t of document.querySelectorAll('table, img')) { const b = t.getBoundingClientRect(); if (b.right > limit + 4) out.overflow.push((t.tagName === 'IMG' ? 'An image' : 'A table') + ' is wider than the text area by ' + Math.round(b.right - limit) + ' pt (cut off in print)') }` : ''}
  return out
})()`

const PB = '\u2063SBPAGEBREAK\u2063', PBB = '\u2063SBBREAKBEFORE\u2063'

async function zipNames(file: string): Promise<string> {
  try { const JSZip = (await import('jszip')).default; return Object.keys((await JSZip.loadAsync(readFileSync(file))).files).join('\n') } catch { return '' }
}

/** Loads a Quick Look page offline (only its own folder), measures it and prints it. */
async function printWith(electron: Electronish, htmlPath: string, bundle: string, kind: string, page: { width: number; height: number }): Promise<{ pdf: Buffer; m: { overflow: string[]; lowContrast: string[] } }> {
  const win = new electron.BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, partition: `sb-ql-${Date.now()}-${Math.random()}` } })
  try {
    win.webContents.session.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith('file://') || !decodeURIComponent(d.url).includes(bundle) }))
    await win.loadFile(htmlPath)
    const m = (await win.webContents.executeJavaScript(MEASURE(kind))) as { overflow: string[]; lowContrast: string[] }
    const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: page, margins: { top: 0, bottom: 0, left: 0, right: 0 } })
    return { pdf, m }
  } finally {
    win.destroy()
  }
}

/**
 * Lays out a .docx, .pptx or .xlsx as a PDF through Quick Look's converter and Chromium (needs the app's
 * main process). Returns undefined when that isn't available.
 */
export async function officeToPdf(file: string, outPdf: string): Promise<{ overflow: string[]; lowContrast: string[]; notes: string[] } | undefined> {
  const electron = await electronMain()
  if (!electron || !canRender()) return undefined
  const ext = extname(file).toLowerCase()
  const kind = ext === '.pptx' ? 'pptx' : ext === '.xlsx' || ext === '.xlsm' ? 'xlsx' : 'docx'
  const work = mkdtempSync(join(tmpdir(), 'sb-ql-'))
  try {
    let source = file
    if (kind === 'docx') {
      // Quick Look drops page breaks: mark them with a token it keeps, and turn the token into real breaks.
      try {
        const JSZip = (await import('jszip')).default
        const zip = await JSZip.loadAsync(readFileSync(file))
        const xml = await zip.file('word/document.xml')?.async('string')
        if (xml) {
          const marked = xml
            .replace(/<w:br\s+w:type="page"\s*\/>/g, `<w:t>${PB}</w:t>`)
            .replace(/(<w:p\b[^>]*>\s*<w:pPr>(?:(?!<\/w:pPr>)[\s\S])*?<w:pageBreakBefore\/>(?:(?!<\/w:pPr>)[\s\S])*?<\/w:pPr>)/g, `$1<w:r><w:t>${PBB}</w:t></w:r>`)
            .replace(/(<w:pPr>(?:(?!<\/w:pPr>)[\s\S])*?<w:sectPr\b[\s\S]*?<\/w:sectPr>(?:(?!<\/w:pPr>)[\s\S])*?<\/w:pPr>)/g, `$1<w:r><w:t>${PB}</w:t></w:r>`)
            // Quick Look prints headers and footers once, at the end of the text: leave them out of the render.
            .replace(/<w:(header|footer)Reference\b[^>]*\/>/g, '')
          if (marked !== xml) {
            zip.file('word/document.xml', marked)
            source = join(work, basename(file))
            writeFileSync(source, await zip.generateAsync({ type: 'nodebuffer' }))
          }
        }
      } catch { /* render without breaks */ }
    }
    await run('qlmanage', ['-p', '-o', work, source], 60_000)
    const bundle = readdirSync(work).map((n) => join(work, n)).find((p) => p.endsWith('.qlpreview'))
    const htmlPath = bundle && join(bundle, 'Preview.html')
    if (!htmlPath || !existsSync(htmlPath)) return undefined
    let html = readFileSync(htmlPath, 'utf8')
    // Vector pieces come as PDF attachments, which Chromium can't show in <img>: rasterize them.
    for (const att of readdirSync(bundle!).filter((n) => /\.pdf$/i.test(n))) {
      try {
        const r = await pdfToImages(join(bundle!, att), { outDir: bundle!, width: 1200, pages: [1], sheet: false, transparent: true, prefix: `${att.replace(/\.pdf$/i, '')}-` })
        if (r.images[0]) html = html.split(`"${att}"`).join(`"${basename(r.images[0].path)}"`)
      } catch { /* leave it out */ }
    }
    html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/\son\w+="[^"]*"/gi, '')
    html = html.split(PB).join('<span style="display:block;break-after:page;height:0"></span>').split(PBB).join('<span style="display:block;break-before:page;height:0"></span>')
    let css: string
    let page: { width: number; height: number }
    if (kind === 'pptx') {
      const m = /div\.slide, div\.loading-slide \{ width: (\d+); height: (\d+);/.exec(html)
      const w = Number(m?.[1] ?? 960), h = Number(m?.[2] ?? 540)
      css = `@page { size: ${w}px ${h}px; margin: 0 } html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; } div.slide { margin: 0 !important; box-shadow: none !important; -webkit-box-shadow: none !important; break-after: page; page-break-after: always; } div.loading-slide { display: none !important; }`
      page = { width: w / 96, height: h / 96 }
    } else if (kind === 'docx') {
      let xml = ''
      try { const JSZip = (await import('jszip')).default; xml = (await (await JSZip.loadAsync(readFileSync(file))).file('word/document.xml')?.async('string')) ?? '' } catch { /* defaults */ }
      const s = docxPageSetup(readFileSync(file), xml)
      // Quick Look writes points as unitless px; zoom 4/3 puts them back at their printed size.
      css = `@page { size: ${s.w}in ${s.h}in; margin: ${s.top}in ${s.right}in ${s.bottom}in ${s.left}in } html { zoom: 1.3333 } body { margin: 0 !important; } body > div:first-of-type { padding: 0 !important; min-height: 0 !important; width: auto !important; overflow: visible !important; }`
      page = { width: s.w, height: s.h }
    } else {
      css = '@page { size: 11in 8.5in; margin: 0.5in } body { margin: 0 }'
      page = { width: 11, height: 8.5 }
    }
    if (kind === 'xlsx') {
      // One page set per sheet (Quick Look shows sheets as tabs of separate pages).
      const tabs = [...html.matchAll(/<div class="TabHeader">([^<]*)<\/div><a href="([^"]+)">/g)].map((m) => ({ name: m[1], href: m[2] }))
      const parts: Buffer[] = []
      const out = { overflow: [] as string[], lowContrast: [] as string[] }
      for (const t of tabs.length ? tabs : [{ name: 'Sheet', href: 'Preview.html' }]) {
        const p = join(bundle!, t.href)
        if (!existsSync(p)) continue
        const sheet = readFileSync(p, 'utf8').replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/\son\w+="[^"]*"/gi, '')
        writeFileSync(p, sheet.replace(/<\/head>/i, `<style>${css} table { margin-bottom: 0 }</style></head>`).replace(/<body([^>]*)>/i, `<body$1><div style="font: 600 13px -apple-system, Helvetica; color: #555; margin: 0 0 8px">${t.name}</div>`))
        const r = await printWith(electron, p, bundle!, kind, page)
        parts.push(r.pdf)
        out.lowContrast.push(...r.m.lowContrast.map((x) => `${t.name}: ${x}`))
      }
      if (!parts.length) return undefined
      const { pdfMerge } = await import('./pdf')
      writeFileSync(outPdf, (await pdfMerge(parts)).buffer)
      return { overflow: [], lowContrast: out.lowContrast.slice(0, 10), notes: [`Sheets drawn by macOS Quick Look, one after another: ${tabs.map((t) => t.name).join(', ')}.`] }
    }
    writeFileSync(htmlPath, html.replace(/<\/head>/i, `<style>${css}</style></head>`))
    const r = await printWith(electron, htmlPath, bundle!, kind, page)
    writeFileSync(outPdf, r.pdf)
    const chartsNote = /<c:chart\b|chart\d*\.xml/.test(await zipNames(file)) ? ' Native charts are not drawn by Quick Look (they show in Word/PowerPoint/Keynote); check their data in the file instead.' : ''
    return {
      overflow: r.m.overflow.slice(0, 15),
      lowContrast: r.m.lowContrast.slice(0, 10),
      notes: [(kind === 'docx' ? 'Laid out by macOS Quick Look (no Word needed). Fonts not installed on this Mac are substituted, so line and page breaks can differ slightly from Word; headers and footers are not shown.' : 'Slides drawn by macOS Quick Look (no PowerPoint needed); fonts not installed on this Mac are substituted.') + chartsNote]
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/** First page only, through a Quick Look thumbnail (works in plain Node too). */
async function thumbnail(file: string, outDir: string, width: number): Promise<PageImage | undefined> {
  await run('qlmanage', ['-t', '-s', String(width), '-o', outDir, file], 30_000)
  const p = join(outDir, `${basename(file)}.png`)
  if (!existsSync(p)) return undefined
  const img = readFileSync(p)
  return { page: 1, path: p, width: img.readUInt32BE(16), height: img.readUInt32BE(20) }
}

/** Renders any supported document's pages to images and measures them. */
export async function renderDocument(file: string, o: RenderOptions = {}): Promise<RenderResult> {
  if (!canRender()) throw new Error('Rendering pages needs macOS.')
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`Not found: ${file}`)
  const ext = extname(file).toLowerCase()
  const kind: RenderResult['kind'] = ext === '.pdf' ? 'pdf' : ext === '.docx' ? 'docx' : ext === '.pptx' ? 'pptx' : ext === '.xlsx' || ext === '.xlsm' ? 'xlsx' : 'other'
  const outDir = o.outDir ?? mkdtempSync(join(tmpdir(), 'sb-pages-'))
  mkdirSync(outDir, { recursive: true })
  const res: RenderResult = { kind, method: 'pdfkit', pageCount: 0, sizes: [], images: [], checks: [], overflow: [], lowContrast: [], notes: [] }
  let pdf = file
  if (kind !== 'pdf') {
    const laid = join(outDir, `${basename(file, ext)}.layout.pdf`)
    const r = await officeToPdf(file, laid).catch((e: Error) => { res.notes.push(`Quick Look layout failed: ${e.message}`); return undefined })
    if (r) {
      pdf = laid
      res.method = 'quicklook'
      res.pdf = laid
      res.overflow = r.overflow
      res.lowContrast = r.lowContrast
      res.notes.push(...r.notes)
    } else {
      const t = await thumbnail(file, outDir, o.width ?? 1100)
      res.method = 'thumbnail'
      if (t) { res.images = [t]; res.pageCount = 1; res.notes.push('Only the first page could be drawn here (a Quick Look thumbnail).') }
      const c = t && analyzePage(readFileSync(t.path), 1)
      if (c) res.checks = [c]
      return res
    }
  }
  const out = await pdfToImages(pdf, { ...o, outDir })
  res.pageCount = out.pages
  res.sizes = out.sizes
  res.images = out.images
  res.sheet = out.sheet
  for (const im of out.images) {
    const c = analyzePage(readFileSync(im.path), im.page)
    if (c) res.checks.push(c)
  }
  return res
}
