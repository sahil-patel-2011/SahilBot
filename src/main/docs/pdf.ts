// PDF work with pdf-lib: list and fill form fields (optionally flattened), merge, split, extract,
// rotate, stamp text (watermarks, "DRAFT", "Approved") and add page numbers. Everything runs locally and
// writes new files; the original is never changed in place.

export interface PdfField {
  name: string
  type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list' | 'signature' | 'button' | 'unknown'
  value: string | boolean | string[] | null
  options?: string[]
  required: boolean
  readOnly: boolean
  multiline?: boolean
  maxLength?: number
  /** 1-based page the field's first widget is on. */
  page?: number
}

async function lib() {
  return import('pdf-lib')
}

export async function pdfInfo(data: Buffer): Promise<{ pages: number; sizes: Array<{ w: number; h: number; rotation: number }>; title?: string; author?: string; encrypted: boolean; fields: number }> {
  const { PDFDocument } = await lib()
  const doc = await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false })
  const fields = (() => { try { return doc.getForm().getFields().length } catch { return 0 } })()
  return {
    pages: doc.getPageCount(),
    sizes: doc.getPages().map((p) => ({ w: Math.round(p.getWidth()), h: Math.round(p.getHeight()), rotation: p.getRotation().angle })),
    title: doc.getTitle() || undefined,
    author: doc.getAuthor() || undefined,
    encrypted: doc.isEncrypted,
    fields
  }
}

export async function pdfFields(data: Buffer): Promise<PdfField[]> {
  const L = await lib()
  const doc = await L.PDFDocument.load(data, { ignoreEncryption: true })
  const form = doc.getForm()
  const pages = doc.getPages()
  const pageOf = (f: import('pdf-lib').PDFField): number | undefined => {
    const w = f.acroField.getWidgets()[0]
    const ref = w?.P()
    if (ref) { const i = pages.findIndex((p) => p.ref === ref); if (i >= 0) return i + 1 }
    // Fall back to searching every page's annotations for the widget.
    for (let i = 0; i < pages.length; i++) {
      const annots = pages[i].node.Annots()
      if (!annots) continue
      for (let k = 0; k < annots.size(); k++) if (w && doc.context.lookup(annots.get(k)) === w.dict) return i + 1
    }
    return undefined
  }
  return form.getFields().map((f): PdfField => {
    const base = { name: f.getName(), required: f.isRequired(), readOnly: f.isReadOnly(), page: pageOf(f) }
    if (f instanceof L.PDFTextField) return { ...base, type: 'text', value: f.getText() ?? null, multiline: f.isMultiline(), maxLength: f.getMaxLength() }
    if (f instanceof L.PDFCheckBox) return { ...base, type: 'checkbox', value: f.isChecked() }
    if (f instanceof L.PDFRadioGroup) return { ...base, type: 'radio', value: f.getSelected() ?? null, options: f.getOptions() }
    if (f instanceof L.PDFDropdown) return { ...base, type: 'dropdown', value: f.getSelected()[0] ?? null, options: f.getOptions() }
    if (f instanceof L.PDFOptionList) return { ...base, type: 'list', value: f.getSelected(), options: f.getOptions() }
    if (f instanceof L.PDFSignature) return { ...base, type: 'signature', value: null }
    if (f instanceof L.PDFButton) return { ...base, type: 'button', value: null }
    return { ...base, type: 'unknown', value: null }
  })
}

export interface FillResult {
  buffer: Buffer
  filled: string[]
  /** Names given that the form doesn't have (with the closest field names). */
  unknown: Array<{ name: string; suggestions: string[] }>
  problems: string[]
  /** Required fields still empty. */
  missingRequired: string[]
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Fills form fields by name (matching ignores case and punctuation). Checkboxes take true/false/"yes"/"no". */
export async function pdfFill(data: Buffer, values: Record<string, string | number | boolean | string[]>, o: { flatten?: boolean } = {}): Promise<FillResult> {
  const L = await lib()
  const doc = await L.PDFDocument.load(data, { ignoreEncryption: true })
  const form = doc.getForm()
  const fields = form.getFields()
  const byNorm = new Map(fields.map((f) => [norm(f.getName()), f]))
  const filled: string[] = [], problems: string[] = []
  const unknown: FillResult['unknown'] = []
  for (const [name, raw] of Object.entries(values)) {
    const f = fields.find((x) => x.getName() === name) ?? byNorm.get(norm(name))
    if (!f) {
      const n = norm(name)
      unknown.push({ name, suggestions: fields.map((x) => x.getName()).filter((x) => norm(x).includes(n) || n.includes(norm(x))).slice(0, 3) })
      continue
    }
    if (f.isReadOnly()) { problems.push(`${f.getName()} is read-only.`); continue }
    try {
      if (f instanceof L.PDFTextField) {
        const text = Array.isArray(raw) ? raw.join(', ') : String(raw)
        const max = f.getMaxLength()
        if (max !== undefined && text.length > max) problems.push(`${f.getName()}: "${text}" is longer than the field allows (${max}); it was cut.`)
        f.setText(max !== undefined ? text.slice(0, max) : text)
      } else if (f instanceof L.PDFCheckBox) {
        const on = typeof raw === 'boolean' ? raw : /^(true|yes|y|1|x|on|checked)$/i.test(String(raw).trim())
        if (on) f.check()
        else f.uncheck()
      } else if (f instanceof L.PDFRadioGroup || f instanceof L.PDFDropdown) {
        const want = String(Array.isArray(raw) ? raw[0] : raw)
        const opt = f.getOptions().find((x) => x === want) ?? f.getOptions().find((x) => norm(x) === norm(want))
        if (!opt && f instanceof L.PDFRadioGroup) { problems.push(`${f.getName()}: "${want}" is not an option (${f.getOptions().join(', ')}).`); continue }
        if (f instanceof L.PDFRadioGroup) f.select(opt!)
        else f.select(opt ?? want)
      } else if (f instanceof L.PDFOptionList) {
        const wants = (Array.isArray(raw) ? raw : String(raw).split(/\s*,\s*/)).map(String)
        const opts = f.getOptions()
        const picks = wants.map((w) => opts.find((x) => norm(x) === norm(w))).filter((x): x is string => !!x)
        if (picks.length < wants.length) problems.push(`${f.getName()}: some values aren't options (${opts.join(', ')}).`)
        f.select(picks)
      } else {
        problems.push(`${f.getName()} is a ${f.constructor.name.replace(/^PDF/, '')} field; it can't be filled with a value.`)
        continue
      }
      filled.push(f.getName())
    } catch (e) {
      problems.push(`${f.getName()}: ${(e as Error).message}`)
    }
  }
  const missingRequired = fields.filter((f) => f.isRequired() && !filled.includes(f.getName()) && f instanceof L.PDFTextField && !f.getText()).map((f) => f.getName())
  if (o.flatten) {
    try { form.updateFieldAppearances() } catch { /* fonts for exotic fields: flatten anyway */ }
    form.flatten()
  }
  const buffer = Buffer.from(await doc.save())
  return { buffer, filled, unknown, problems, missingRequired }
}

/** "1-3,5,8-" → zero-based page indexes (in order, duplicates kept once). */
export function parsePages(spec: string | undefined, count: number): number[] {
  if (!spec || /^\s*(all|\*)?\s*$/i.test(spec)) return Array.from({ length: count }, (_, i) => i)
  const out: number[] = []
  for (const part of spec.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d+|last)?\s*(-)?\s*(\d+|last)?$/i.exec(part)
    if (!m) throw new Error(`"${part}" is not a page or range (like 1-3, 5, 8-, last).`)
    const num = (x: string | undefined, d: number) => (x === undefined ? d : /last/i.test(x) ? count : Number(x))
    const a = num(m[1], 1), b = m[2] ? num(m[3], count) : a
    if (a < 1 || b > count || a > b) throw new Error(`Pages ${part} are outside 1-${count}.`)
    for (let p = a; p <= b; p++) if (!out.includes(p - 1)) out.push(p - 1)
  }
  return out
}

export async function pdfMerge(files: Buffer[]): Promise<{ buffer: Buffer; pages: number }> {
  const { PDFDocument } = await lib()
  const out = await PDFDocument.create()
  for (const f of files) {
    const src = await PDFDocument.load(f, { ignoreEncryption: true })
    const pages = await out.copyPages(src, src.getPageIndices())
    pages.forEach((p) => out.addPage(p))
  }
  return { buffer: Buffer.from(await out.save()), pages: out.getPageCount() }
}

/** New PDFs from page ranges: ["1-3", "4-"] or every page alone (`each`). */
export async function pdfSplit(data: Buffer, o: { ranges?: string[]; each?: boolean; every?: number }): Promise<Array<{ pages: number[]; buffer: Buffer }>> {
  const { PDFDocument } = await lib()
  const src = await PDFDocument.load(data, { ignoreEncryption: true })
  const n = src.getPageCount()
  let groups: number[][]
  if (o.ranges?.length) groups = o.ranges.map((r) => parsePages(r, n))
  else {
    const size = o.each ? 1 : Math.max(1, o.every ?? 1)
    groups = Array.from({ length: Math.ceil(n / size) }, (_, i) => Array.from({ length: Math.min(size, n - i * size) }, (_, k) => i * size + k))
  }
  const out: Array<{ pages: number[]; buffer: Buffer }> = []
  for (const g of groups) {
    const doc = await PDFDocument.create()
    const pages = await doc.copyPages(src, g)
    pages.forEach((p) => doc.addPage(p))
    out.push({ pages: g.map((i) => i + 1), buffer: Buffer.from(await doc.save()) })
  }
  return out
}

export async function pdfExtract(data: Buffer, pages: string): Promise<{ buffer: Buffer; pages: number[] }> {
  const [r] = await pdfSplit(data, { ranges: [pages] })
  return r
}

export async function pdfRotate(data: Buffer, degrees: number, pages?: string): Promise<{ buffer: Buffer; rotated: number[] }> {
  const { PDFDocument, degrees: deg } = await lib()
  if (degrees % 90 !== 0) throw new Error('Rotate by 90, 180 or 270 degrees.')
  const doc = await PDFDocument.load(data, { ignoreEncryption: true })
  const idx = parsePages(pages, doc.getPageCount())
  for (const i of idx) {
    const p = doc.getPage(i)
    p.setRotation(deg(((p.getRotation().angle + degrees) % 360 + 360) % 360))
  }
  return { buffer: Buffer.from(await doc.save()), rotated: idx.map((i) => i + 1) }
}

export type Position = 'top-left' | 'top-center' | 'top-right' | 'center' | 'bottom-left' | 'bottom-center' | 'bottom-right' | 'diagonal'

const rgbOf = (hex: string | undefined, d: [number, number, number]): [number, number, number] => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '')
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : d
}

/**
 * Draws text on pages. `{n}` and `{total}` are replaced with the page number and count (page numbers:
 * text "Page {n} of {total}", position bottom-center).
 */
export async function pdfStamp(data: Buffer, o: { text: string; pages?: string; position?: Position; size?: number; color?: string; opacity?: number; start?: number }): Promise<{ buffer: Buffer; stamped: number[] }> {
  const { PDFDocument, StandardFonts, rgb, degrees } = await lib()
  const doc = await PDFDocument.load(data, { ignoreEncryption: true })
  const font = await doc.embedFont(o.position === 'diagonal' ? StandardFonts.HelveticaBold : StandardFonts.Helvetica)
  const total = doc.getPageCount()
  const idx = parsePages(o.pages, total)
  const pos = o.position ?? 'bottom-center'
  const size = o.size ?? (pos === 'diagonal' ? 64 : 10)
  const [r, g, b] = rgbOf(o.color, pos === 'diagonal' ? [0.8, 0.1, 0.1] : [0.35, 0.35, 0.35])
  const start = o.start ?? 1
  // Latin-1 only for the standard fonts: replace what they can't draw.
  const safe = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
  for (const i of idx) {
    const page = doc.getPage(i)
    const { width, height } = page.getSize()
    const text = safe(o.text.replace(/\{n\}/g, String(i + start)).replace(/\{total\}/g, String(total + start - 1)))
    const w = font.widthOfTextAtSize(text, size)
    const m = 36
    let x = (width - w) / 2, y = m - size / 2, rotate = 0
    if (pos.startsWith('top')) y = height - m
    if (pos === 'center') y = height / 2
    if (pos.endsWith('left')) x = m
    if (pos.endsWith('right')) x = width - m - w
    if (pos === 'diagonal') {
      const a = Math.atan2(height, width)
      rotate = (a * 180) / Math.PI
      x = width / 2 - (Math.cos(a) * w) / 2
      y = height / 2 - (Math.sin(a) * w) / 2
    }
    page.drawText(text, { x, y, size, font, color: rgb(r, g, b), opacity: o.opacity ?? (pos === 'diagonal' ? 0.25 : 1), rotate: degrees(rotate) })
  }
  return { buffer: Buffer.from(await doc.save()), stamped: idx.map((i) => i + 1) }
}

export async function pdfPageNumbers(data: Buffer, o: { format?: string; position?: Position; start?: number; pages?: string; size?: number } = {}): Promise<{ buffer: Buffer; stamped: number[] }> {
  return pdfStamp(data, { text: o.format ?? 'Page {n} of {total}', position: o.position ?? 'bottom-center', start: o.start, pages: o.pages, size: o.size ?? 9 })
}

/** A simple text PDF (monospace-free, wrapped): for converting text and Markdown without a browser window. */
export async function textToPdf(text: string, o: { title?: string; size?: number } = {}): Promise<Buffer> {
  const { PDFDocument, StandardFonts, rgb } = await lib()
  const doc = await PDFDocument.create()
  if (o.title) doc.setTitle(o.title)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const size = o.size ?? 11
  const W = 612, H = 792, M = 64
  let page = doc.addPage([W, H])
  let y = H - M
  const safe = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/…/g, '...').replace(/•/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
  const lineH = size * 1.45
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(raw)
    const f = heading ? bold : font
    const z = heading ? size + (4 - heading[1].length) * 3 : size
    const words = safe(heading ? heading[2] : raw).split(/(\s+)/)
    let line = ''
    const flush = () => {
      if (y < M + lineH) { page = doc.addPage([W, H]); y = H - M }
      page.drawText(line, { x: M, y, size: z, font: f, color: rgb(0.1, 0.1, 0.1) })
      y -= heading ? z * 1.6 : lineH
      line = ''
    }
    for (const w of words) {
      if (f.widthOfTextAtSize(line + w, z) > W - 2 * M && line.trim()) flush()
      line += line || !/^\s+$/.test(w) ? w : ''
    }
    flush()
  }
  return Buffer.from(await doc.save())
}
