import { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { marked, type Token, type Tokens } from 'marked'

// Documents are rendered from a small, deterministic spec: Markdown for prose
// (docx, pdf), slides for decks, sheets for spreadsheets. The model writes data,
// never library code.

export interface SlideSpec {
  title: string
  subtitle?: string
  bullets?: string[]
  notes?: string
  table?: string[][]
  layout?: 'title' | 'bullets' | 'two_column' | 'section' | 'quote'
  right?: string[]
}

export interface SheetSpec {
  name: string
  rows: Array<Array<string | number | boolean | null>>
  header?: boolean
  widths?: number[]
}

export interface DocSpec {
  path: string
  title?: string
  markdown?: string
  slides?: SlideSpec[]
  sheets?: SheetSpec[]
  accent?: string
}

const css = (accent: string): string => `
  @page { size: Letter; margin: 0.9in 0.85in; }
  body { font: 11pt/1.55 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1a1a1a; }
  h1 { font-size: 22pt; margin: 0 0 12pt; letter-spacing: -0.01em; }
  h1::after { content: ''; display: block; width: 48pt; height: 3pt; background: ${accent}; margin-top: 8pt; border-radius: 2pt; }
  h2 { font-size: 15pt; margin: 18pt 0 6pt; color: #111; }
  h3 { font-size: 12.5pt; margin: 14pt 0 4pt; }
  p { margin: 0 0 8pt; } ul, ol { margin: 0 0 8pt; padding-left: 18pt; } li { margin: 2pt 0; }
  table { border-collapse: collapse; width: 100%; margin: 6pt 0 12pt; font-size: 10pt; }
  th { background: ${accent}; color: white; text-align: left; } th, td { padding: 5pt 7pt; border: 0.5pt solid #ccc; }
  tr:nth-child(even) td { background: #f6f6f6; }
  code { font: 9.5pt "SF Mono", Menlo, monospace; background: #f1f1f1; padding: 1pt 3pt; border-radius: 3pt; }
  pre { background: #f4f4f4; padding: 8pt 10pt; border-radius: 6pt; white-space: pre-wrap; }
  blockquote { border-left: 3pt solid ${accent}; margin: 8pt 0; padding: 2pt 10pt; color: #444; }
  img { max-width: 100%; }
`

export async function markdownToPdf(markdown: string, title: string, accent: string): Promise<Buffer> {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${css(accent)}</style></head><body>${marked.parse(markdown, { async: false })}</body></html>`
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } })
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    return await win.webContents.printToPDF({ printBackground: true, pageSize: 'Letter', generateDocumentOutline: true })
  } finally {
    win.destroy()
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

// ------------------------------------------------------------------ docx

export async function markdownToDocx(markdown: string, title: string, accent: string): Promise<Buffer> {
  const d = await import('docx')
  const color = accent.replace('#', '')
  type Run = InstanceType<typeof d.TextRun> | InstanceType<typeof d.ExternalHyperlink>
  const inline = (tokens: Token[] | undefined, style: { bold?: boolean; italics?: boolean } = {}): Run[] =>
    (tokens ?? []).flatMap((t): Run[] => {
      switch (t.type) {
        case 'strong': return inline((t as Tokens.Strong).tokens, { ...style, bold: true })
        case 'em': return inline((t as Tokens.Em).tokens, { ...style, italics: true })
        case 'codespan': return [new d.TextRun({ text: (t as Tokens.Codespan).text, font: 'Menlo', size: 19, ...style })]
        case 'link': return [new d.ExternalHyperlink({ link: (t as Tokens.Link).href, children: [new d.TextRun({ text: (t as Tokens.Link).text, style: 'Hyperlink', ...style })] })]
        case 'br': return [new d.TextRun({ text: '', break: 1 })]
        case 'text': {
          const tt = t as Tokens.Text
          return tt.tokens?.length ? inline(tt.tokens, style) : [new d.TextRun({ text: unescape(tt.text), ...style })]
        }
        default: return [new d.TextRun({ text: unescape((t as { raw?: string }).raw ?? ''), ...style })]
      }
    })

  const children: Array<InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>> = []
  const HEAD = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3, d.HeadingLevel.HEADING_4]
  const list = (l: Tokens.List, level: number): void => {
    for (const item of l.items) {
      const para = item.tokens.find((x) => x.type === 'text' || x.type === 'paragraph') as Tokens.Text | undefined
      children.push(new d.Paragraph({
        children: inline(para?.tokens ?? [{ type: 'text', raw: item.text, text: item.text } as Tokens.Text]),
        ...(l.ordered ? { numbering: { reference: 'num', level } } : { bullet: { level } })
      }))
      for (const sub of item.tokens) if (sub.type === 'list') list(sub as Tokens.List, Math.min(level + 1, 3))
    }
  }

  for (const t of marked.lexer(markdown)) {
    switch (t.type) {
      case 'heading': {
        const h = t as Tokens.Heading
        children.push(new d.Paragraph({ heading: HEAD[Math.min(h.depth, 4) - 1], children: inline(h.tokens) }))
        break
      }
      case 'paragraph': children.push(new d.Paragraph({ children: inline((t as Tokens.Paragraph).tokens), spacing: { after: 120 } })); break
      case 'list': list(t as Tokens.List, 0); break
      case 'blockquote': children.push(new d.Paragraph({ children: [new d.TextRun({ text: (t as Tokens.Blockquote).text, italics: true })], indent: { left: 400 } })); break
      case 'code': for (const line of (t as Tokens.Code).text.split('\n')) children.push(new d.Paragraph({ children: [new d.TextRun({ text: line, font: 'Menlo', size: 18 })] })); break
      case 'hr': children.push(new d.Paragraph({ border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 1 } } })); break
      case 'table': {
        const tb = t as Tokens.Table
        const cell = (c: Tokens.TableCell, header: boolean) => new d.TableCell({
          children: [new d.Paragraph({ children: inline(c.tokens, header ? { bold: true } : {}) })],
          shading: header ? { fill: color, type: d.ShadingType.CLEAR, color: 'auto' } : undefined
        })
        children.push(new d.Table({
          width: { size: 100, type: d.WidthType.PERCENTAGE },
          rows: [
            new d.TableRow({ tableHeader: true, children: tb.header.map((c) => cell(c, true)) }),
            ...tb.rows.map((r) => new d.TableRow({ children: r.map((c) => cell(c, false)) }))
          ]
        }))
        children.push(new d.Paragraph({ text: '' }))
        break
      }
      default: break
    }
  }

  const doc = new d.Document({
    title,
    creator: 'SahilBot',
    styles: {
      default: { document: { run: { font: 'Helvetica Neue', size: 22 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', run: { size: 40, bold: true, color: '111111' }, paragraph: { spacing: { after: 200 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', run: { size: 30, bold: true, color }, paragraph: { spacing: { before: 280, after: 120 } } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', run: { size: 25, bold: true }, paragraph: { spacing: { before: 200, after: 80 } } }
      ]
    },
    numbering: { config: [{ reference: 'num', levels: [0, 1, 2, 3].map((level) => ({ level, format: d.LevelFormat.DECIMAL, text: `%${level + 1}.`, alignment: d.AlignmentType.START, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) }] },
    sections: [{ children }]
  })
  return d.Packer.toBuffer(doc)
}

function unescape(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

// ------------------------------------------------------------------ pptx

export async function slidesToPptx(slides: SlideSpec[], title: string, accent: string): Promise<Buffer> {
  const PptxGenJS = (await import('pptxgenjs')).default
  const p = new PptxGenJS()
  p.layout = 'LAYOUT_WIDE'
  p.title = title
  p.author = 'SahilBot'
  const A = accent.replace('#', '')
  const INK = '1A1A1A', MUTED = '666666'
  slides.forEach((s, i) => {
    const sl = p.addSlide()
    sl.background = { color: 'FFFFFF' }
    const layout = s.layout ?? (i === 0 && !s.bullets?.length && !s.table ? 'title' : 'bullets')
    if (layout === 'title' || layout === 'section') {
      sl.background = { color: layout === 'title' ? INK : A }
      sl.addShape(p.ShapeType.rect, { x: 0.8, y: 3.1, w: 1.2, h: 0.08, fill: { color: layout === 'title' ? A : 'FFFFFF' } })
      sl.addText(s.title, { x: 0.8, y: 1.6, w: 11.5, h: 1.4, fontSize: 40, bold: true, color: 'FFFFFF', fontFace: 'Helvetica Neue', valign: 'bottom' })
      if (s.subtitle) sl.addText(s.subtitle, { x: 0.8, y: 3.35, w: 11.5, h: 1, fontSize: 20, color: 'DDDDDD', fontFace: 'Helvetica Neue', valign: 'top' })
    } else if (layout === 'quote') {
      sl.addText(`“${s.title}”`, { x: 1.2, y: 1.5, w: 10.9, h: 3, fontSize: 32, italic: true, color: INK, fontFace: 'Georgia', align: 'center', valign: 'middle' })
      if (s.subtitle) sl.addText(`— ${s.subtitle}`, { x: 1.2, y: 4.6, w: 10.9, h: 0.6, fontSize: 18, color: MUTED, align: 'center' })
    } else {
      sl.addShape(p.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: A } })
      sl.addText(s.title, { x: 0.7, y: 0.4, w: 12, h: 0.9, fontSize: 30, bold: true, color: INK, fontFace: 'Helvetica Neue' })
      if (s.subtitle) sl.addText(s.subtitle, { x: 0.7, y: 1.15, w: 12, h: 0.5, fontSize: 16, color: MUTED })
      const top = s.subtitle ? 1.8 : 1.5
      const bullets = (items: string[], x: number, w: number): void => {
        sl.addText(items.map((t) => ({ text: t, options: { bullet: { indent: 18 }, paraSpaceAfter: 10 } })), { x, y: top, w, h: 5.4, fontSize: 20, color: INK, fontFace: 'Helvetica Neue', valign: 'top' })
      }
      if (s.table?.length) {
        const [head, ...rows] = s.table
        sl.addTable([head.map((h) => ({ text: h, options: { bold: true, color: 'FFFFFF', fill: { color: A } } })), ...rows.map((r) => r.map((c) => ({ text: String(c) })))],
          { x: 0.7, y: top, w: 11.9, fontSize: 14, border: { type: 'solid', color: 'DDDDDD', pt: 0.5 }, fontFace: 'Helvetica Neue' })
      } else if (layout === 'two_column') {
        bullets(s.bullets ?? [], 0.7, 5.8)
        bullets(s.right ?? [], 6.8, 5.8)
      } else if (s.bullets?.length) {
        bullets(s.bullets, 0.7, 11.9)
      }
      sl.addText(`${i + 1}`, { x: 12.3, y: 6.9, w: 0.6, h: 0.4, fontSize: 11, color: MUTED, align: 'right' })
    }
    if (s.notes) sl.addNotes(s.notes)
  })
  return (await p.write({ outputType: 'nodebuffer' })) as Buffer
}

// ------------------------------------------------------------------ xlsx

export async function sheetsToXlsx(sheets: SheetSpec[], accent: string): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'SahilBot'
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31) || 'Sheet1')
    s.rows.forEach((row) => {
      ws.addRow(row.map((c) => (typeof c === 'string' && c.startsWith('=') ? { formula: c.slice(1) } : c)))
    })
    const header = s.header ?? true
    if (header && s.rows.length) {
      const r = ws.getRow(1)
      r.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${accent.replace('#', '').toUpperCase()}` } }
      ws.views = [{ state: 'frozen', ySplit: 1 }]
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, s.rows[0].length) } }
    }
    const cols = Math.max(0, ...s.rows.map((r) => r.length))
    for (let c = 1; c <= cols; c++) {
      const w = s.widths?.[c - 1] ?? Math.min(48, Math.max(8, ...s.rows.map((r) => String(r[c - 1] ?? '').length + 2)))
      ws.getColumn(c).width = w
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

// ------------------------------------------------------------------ entry

export async function createDocument(fullPath: string, spec: DocSpec): Promise<{ bytes: number; kind: string }> {
  const ext = extname(fullPath).toLowerCase()
  const title = spec.title ?? spec.slides?.[0]?.title ?? fullPath.split('/').pop()!.replace(/\.\w+$/, '')
  const accent = /^#[0-9a-f]{6}$/i.test(spec.accent ?? '') ? spec.accent! : '#FF6A1A'
  let buf: Buffer
  switch (ext) {
    case '.pdf':
      if (!spec.markdown) throw new Error('A PDF needs "markdown".')
      buf = await markdownToPdf(spec.markdown, title, accent)
      break
    case '.docx':
      if (!spec.markdown) throw new Error('A Word document needs "markdown".')
      buf = await markdownToDocx(spec.markdown, title, accent)
      break
    case '.pptx':
      if (!spec.slides?.length) throw new Error('A deck needs "slides".')
      buf = await slidesToPptx(spec.slides, title, accent)
      break
    case '.xlsx':
      if (!spec.sheets?.length) throw new Error('A spreadsheet needs "sheets".')
      buf = await sheetsToXlsx(spec.sheets, accent)
      break
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
  return { bytes: buf.length, kind: ext.slice(1).toUpperCase() }
}
