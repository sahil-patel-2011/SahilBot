import { readFileSync } from 'node:fs'
import { extname } from 'node:path'

// Text extraction for the formats people actually attach. Everything runs locally.

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.bmp'])
export const RICH_EXT = new Set(['.pdf', '.docx', '.xlsx', '.xlsm', '.pptx'])

export function mimeFor(path: string): string {
  const e = extname(path).toLowerCase()
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.html': 'text/html', '.htm': 'text/html', '.json': 'application/json',
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv'
  } as Record<string, string>)[e] ?? 'application/octet-stream'
}

export async function pdfText(path: string): Promise<{ text: string; pages: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: true }).promise
  const out: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    let line = ''
    const lines: string[] = []
    for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
      line += item.str ?? ''
      if (item.hasEOL) { lines.push(line); line = '' }
    }
    if (line) lines.push(line)
    out.push(`--- Page ${i} ---\n${lines.join('\n').trim()}`)
  }
  await doc.cleanup()
  return { text: out.join('\n\n'), pages: doc.numPages }
}

export async function docxText(path: string): Promise<string> {
  const mammoth = await import('mammoth')
  return (await mammoth.extractRawText({ path })).value.trim()
}

export async function docxHtml(path: string): Promise<string> {
  const mammoth = await import('mammoth')
  return (await mammoth.convertToHtml({ path })).value
}

type Cell = string | number | boolean | null

export async function xlsxSheets(path: string, maxRows = 2000): Promise<Array<{ name: string; rows: Cell[][] }>> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(path)
  return sheetsOf(wb, maxRows)
}

/** The same, from the file's bytes (the knowledge base reads a file once, without following links). */
export async function xlsxSheetsFrom(data: Buffer, maxRows = 2000): Promise<Array<{ name: string; rows: Cell[][] }>> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(data as unknown as ArrayBuffer)
  return sheetsOf(wb, maxRows)
}

function sheetsOf(wb: import('exceljs').Workbook, maxRows: number): Array<{ name: string; rows: Cell[][] }> {
  return wb.worksheets.map((ws) => {
    const rows: Cell[][] = []
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n > maxRows) return
      const vals = (row.values as unknown[]).slice(1).map((v): Cell => {
        if (v === null || v === undefined) return null
        if (typeof v === 'object') {
          const o = v as { formula?: string; result?: Cell; text?: string; richText?: Array<{ text: string }> }
          if (o.formula) return `=${o.formula} → ${o.result ?? ''}`
          if (o.richText) return o.richText.map((t) => t.text).join('')
          if (o.text) return o.text
          if (v instanceof Date) return v.toISOString().slice(0, 10)
          return JSON.stringify(v)
        }
        return v as Cell
      })
      rows.push(vals)
    })
    return { name: ws.name, rows }
  })
}

export async function xlsxText(path: string): Promise<string> {
  const sheets = await xlsxSheets(path)
  return sheets.map((s) => `--- Sheet "${s.name}" (${s.rows.length} rows) ---\n${s.rows.map((r) => r.map((c) => (c === null ? '' : String(c))).join('\t')).join('\n')}`).join('\n\n')
}

export async function pptxSlides(path: string): Promise<Array<{ n: number; texts: string[]; notes: string }>> {
  return pptxSlidesFrom(readFileSync(path))
}

/** The same, from the file's bytes. */
export async function pptxSlidesFrom(data: Buffer): Promise<Array<{ n: number; texts: string[]; notes: string }>> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(data)
  const slideFiles = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]))
  const texts = (xml: string): string[] =>
    xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decode(m[1])).join('')).filter((t) => t.trim())
  const out = []
  for (const f of slideFiles) {
    const n = Number(f.match(/(\d+)\.xml$/)![1])
    const xml = await zip.file(f)!.async('string')
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${n}.xml`)
    const notes = notesFile ? texts(await notesFile.async('string')).filter((t) => !/^\d+$/.test(t)).join(' ') : ''
    out.push({ n, texts: texts(xml), notes })
  }
  return out
}

function decode(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
}

export async function pptxText(path: string): Promise<string> {
  return (await pptxSlides(path)).map((s) => `--- Slide ${s.n} ---\n${s.texts.join('\n')}${s.notes ? `\n[Notes] ${s.notes}` : ''}`).join('\n\n')
}

/** Readable text for any supported rich format. */
export async function richText(path: string): Promise<string> {
  const e = extname(path).toLowerCase()
  if (e === '.pdf') {
    const r = await pdfText(path)
    return r.text.replace(/--- Page \d+ ---\s*/g, '').trim() ? r.text : `(${r.pages}-page PDF with no extractable text; it may be scanned images. Ask the user, or open it in the browser and take a screenshot.)`
  }
  if (e === '.docx') return docxText(path)
  if (e === '.xlsx' || e === '.xlsm') return xlsxText(path)
  if (e === '.pptx') return pptxText(path)
  throw new Error(`Unsupported format ${e}`)
}
