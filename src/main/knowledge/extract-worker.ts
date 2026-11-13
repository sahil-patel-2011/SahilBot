import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

// Rich documents (PDF, Word, PowerPoint, Excel) are parsed off the main thread: a worker with memory
// limits and a time limit, so a hostile or broken file can't freeze or crash SahilBot. Office files are
// zip archives: their total unpacked size is checked first (a zip bomb is refused before any parsing).

export type RichKind = 'pdf' | 'docx' | 'pptx' | 'xlsx'

export type RichResult =
  | { kind: 'pdf'; pages: Array<{ n: number; text: string }> }
  | { kind: 'docx'; html: string }
  | { kind: 'pptx'; slides: Array<{ n: number; texts: string[]; notes: string }> }
  | { kind: 'xlsx'; sheets: Array<{ name: string; rows: Array<Array<string | number | boolean | null>> }> }

/** Most a docx/pptx/xlsx may unpack to, and most entries it may have. */
export const MAX_ZIP_UNCOMPRESSED = 200 * 1024 * 1024
export const MAX_ZIP_ENTRIES = 20_000
/** Time and memory one document may take. */
export const EXTRACT_TIMEOUT_MS = 60_000
export const EXTRACT_MAX_HEAP_MB = 512

/**
 * Total unpacked size and entry count of a zip, read from its central directory (no unpacking).
 * Throws when it isn't a readable zip. ZIP64 archives report their 64-bit sizes.
 */
export function zipStats(buf: Buffer): { entries: number; uncompressed: number } {
  // End of central directory: signature 0x06054b50 in the last 64 KB + 22 bytes.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip file')
  let entries = buf.readUInt16LE(eocd + 10)
  let size = buf.readUInt32LE(eocd + 12)
  let offset = buf.readUInt32LE(eocd + 16)
  // ZIP64: the locator sits just before the end record.
  if ((entries === 0xffff || offset === 0xffffffff) && eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z64 = Number(buf.readBigUInt64LE(eocd - 12))
    if (z64 + 56 > buf.length || buf.readUInt32LE(z64) !== 0x06064b50) throw new Error('bad zip64 record')
    entries = Number(buf.readBigUInt64LE(z64 + 32))
    size = Number(buf.readBigUInt64LE(z64 + 40))
    offset = Number(buf.readBigUInt64LE(z64 + 48))
  }
  if (offset + size > buf.length) throw new Error('bad zip directory')
  let total = 0
  let p = offset
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip entry')
    let uncompressed = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    if (uncompressed === 0xffffffff) {
      // ZIP64 extra field (id 0x0001): the 64-bit uncompressed size comes first.
      let e = p + 46 + nameLen
      const end = e + extraLen
      while (e + 4 <= end) {
        const id = buf.readUInt16LE(e)
        const len = buf.readUInt16LE(e + 2)
        if (id === 0x0001 && len >= 8) { uncompressed = Number(buf.readBigUInt64LE(e + 4)); break }
        e += 4 + len
      }
    }
    total += uncompressed
    p += 46 + nameLen + extraLen + commentLen
  }
  return { entries, uncompressed: total }
}

/** Why an Office file is refused before parsing (too many entries, or unpacks too big), or ''. */
export function zipProblem(buf: Buffer, max = MAX_ZIP_UNCOMPRESSED): string {
  let s: { entries: number; uncompressed: number }
  try { s = zipStats(buf) } catch (e) { return `unreadable: ${(e as Error).message}` }
  if (s.entries > MAX_ZIP_ENTRIES) return `too many parts inside (${s.entries})`
  if (s.uncompressed > max) return `unpacks to more than ${Math.round(max / 1024 / 1024)} MB`
  return ''
}

/**
 * The worker's code (CommonJS, run with eval so no extra build entry is needed). It loads the same
 * libraries the file tools use, resolved from the app's own node_modules.
 */
export const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const req = createRequire(workerData.base)
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
async function run() {
  const data = Buffer.from(workerData.data)
  const kind = workerData.kind
  if (kind === 'pdf') {
    const pdfjs = await import(pathToFileURL(req.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href)
    const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true }).promise
    const pages = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      let line = ''
      const lines = []
      for (const item of content.items) { line += item.str || ''; if (item.hasEOL) { lines.push(line); line = '' } }
      if (line) lines.push(line)
      pages.push({ n: i, text: lines.join('\n').trim() })
    }
    await doc.cleanup()
    return { kind, pages }
  }
  if (kind === 'docx') {
    const mammoth = req('mammoth')
    return { kind, html: (await mammoth.convertToHtml({ buffer: data })).value }
  }
  if (kind === 'pptx') {
    const JSZip = req('jszip')
    const zip = await JSZip.loadAsync(data)
    const files = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]))
    const texts = (xml) => xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decode(m[1])).join('')).filter((t) => t.trim())
    const slides = []
    for (const f of files) {
      const n = Number(f.match(/(\d+)\.xml$/)[1])
      const xml = await zip.file(f).async('string')
      const nf = zip.file('ppt/notesSlides/notesSlide' + n + '.xml')
      const notes = nf ? texts(await nf.async('string')).filter((t) => !/^\d+$/.test(t)).join(' ') : ''
      slides.push({ n, texts: texts(xml), notes })
    }
    return { kind, slides }
  }
  if (kind === 'xlsx') {
    const ExcelJS = req('exceljs')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(data)
    const maxRows = workerData.maxRows
    const sheets = wb.worksheets.map((ws) => {
      const rows = []
      ws.eachRow({ includeEmpty: false }, (row, n) => {
        if (n > maxRows) return
        rows.push(row.values.slice(1).map((v) => {
          if (v === null || v === undefined) return null
          if (typeof v === 'object') {
            if (v.formula) return '=' + v.formula + ' → ' + (v.result ?? '')
            if (v.richText) return v.richText.map((t) => t.text).join('')
            if (v.text) return v.text
            if (v instanceof Date) return v.toISOString().slice(0, 10)
            return JSON.stringify(v)
          }
          return v
        }))
      })
      return { name: ws.name, rows }
    })
    return { kind, sheets }
  }
  throw new Error('unsupported kind ' + kind)
}
run().then((ok) => parentPort.postMessage({ ok }), (e) => parentPort.postMessage({ error: String((e && e.message) || e) }))
`

/** Where the worker resolves its libraries from: this file (dev, tests) or the app bundle. */
function base(): string {
  try {
    if (typeof __filename === 'string' && __filename) return __filename
  } catch { /* ESM without __filename */ }
  return join(process.cwd(), 'index.js')
}

/** The worker couldn't load its libraries here (e.g. a packaged build without them): parse in-process. */
let workerBroken = false
const LOAD_ERROR = /Cannot find module|ERR_MODULE_NOT_FOUND|ERR_WORKER|Invalid asar|ENOTDIR/

/**
 * Parses one rich document in a worker thread with a memory cap and a time limit. Rejects with
 * "timed out" or the parser's error; the worker is always terminated.
 */
export function extractRich(kind: RichKind, data: Buffer, o: { timeoutMs?: number; maxRows?: number; maxHeapMb?: number } = {}): Promise<RichResult> {
  if (workerBroken) return extractInProcess(kind, data, o.maxRows ?? 1000)
  return new Promise<RichResult>((resolve, reject) => {
    let settled = false
    let worker: Worker
    try {
      worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { kind, data: new Uint8Array(data), base: base(), maxRows: o.maxRows ?? 1000 },
        resourceLimits: { maxOldGenerationSizeMb: o.maxHeapMb ?? EXTRACT_MAX_HEAP_MB, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 },
        stdout: true, stderr: true
      })
    } catch (e) {
      workerBroken = true
      void extractInProcess(kind, data, o.maxRows ?? 1000).then(resolve, reject)
      return
    }
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate().catch(() => undefined)
      fn()
    }
    const timer = setTimeout(() => done(() => reject(new Error('timed out'))), o.timeoutMs ?? EXTRACT_TIMEOUT_MS)
    worker.on('message', (m: { ok?: RichResult; error?: string }) => done(() => {
      if (m.ok) resolve(m.ok)
      else if (m.error && LOAD_ERROR.test(m.error)) { workerBroken = true; extractInProcess(kind, data, o.maxRows ?? 1000).then(resolve, reject) }
      else reject(new Error(m.error ?? 'failed'))
    }))
    worker.on('error', (e: Error) => done(() => reject(new Error(/ERR_WORKER_OUT_OF_MEMORY|heap/i.test(`${(e as NodeJS.ErrnoException).code ?? ''} ${e.message}`) ? 'too big to read (ran out of memory)' : e.message))))
    worker.on('exit', (code) => done(() => reject(new Error(`stopped (${code})`))))
  })
}

/** Fallback only: the same parsing on this thread (still behind the zip-size check). */
async function extractInProcess(kind: RichKind, data: Buffer, maxRows: number): Promise<RichResult> {
  const docs = await import('../docs/read')
  if (kind === 'pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true }).promise
    const pages: Array<{ n: number; text: string }> = []
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent()
      let line = ''
      const lines: string[] = []
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) { line += item.str ?? ''; if (item.hasEOL) { lines.push(line); line = '' } }
      if (line) lines.push(line)
      pages.push({ n: i, text: lines.join('\n').trim() })
    }
    await doc.cleanup()
    return { kind, pages }
  }
  if (kind === 'docx') {
    const mammoth = await import('mammoth')
    return { kind, html: (await mammoth.convertToHtml({ buffer: data })).value }
  }
  if (kind === 'pptx') return { kind, slides: await docs.pptxSlidesFrom(data) }
  return { kind, sheets: await docs.xlsxSheetsFrom(data, maxRows) }
}
