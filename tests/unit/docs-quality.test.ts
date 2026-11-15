import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import { chartProblems, chartSvg, formatNumber, niceScale } from '../../src/main/docs/chart'
import { buildDocx } from '../../src/main/docs/docx'
import { inspectDocx, inspectPptx } from '../../src/main/docs/inspect'
import { blocksToHtml, numericColumns, parseChart, parseMarkdown, smartQuotes, type DocBlock } from '../../src/main/docs/markdown'
import { bodyHtml, coverHtml, defaultLayout, finishPdf, MIN_FONT, pageCss, preparePdf, readPrinted, tighter, tocPagesFrom, undouble } from '../../src/main/docs/pdfdoc'
import { buildPptx } from '../../src/main/docs/pptx'
import { analyzePage, bodyFill, decodePng, docxPageSetup, pdfToImages, type RenderResult } from '../../src/main/docs/render'
import { renderChecks } from '../../src/main/docs/review'
import { applyTemplate } from '../../src/main/docs/templates'
import { contrast, readable, seriesColors, THEME_NAMES, themeOf } from '../../src/main/docs/theme'
import { buildXlsx, loadWorkbook } from '../../src/main/docs/xlsx'

// Document quality: themes and contrast, the PDF engine's layout rules (pagination, TOC page numbers,
// bookmarks, metadata, fitting), charts, templates, structural checks of Word/PowerPoint/Excel output, and
// the page-render checks review_document runs.

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'docsq-')))

const LONG = `# Annual Review

## Executive summary
${'Revenue grew in every region and margin expanded. '.repeat(20)}

## 1. Finance
${'Costs fell as prices held; freight rose but stayed contained. '.repeat(30)}

| Item | FY25 | FY26 |
|---|---|---|
| Revenue | $1,200 | $1,400 |
| Margin | 9.5% | 11.8% |
| Total | $2,000 | $2,300 |

Table: Results

## 2. Customers
${'Members spend more and churn less when they use the monthly credit. '.repeat(30)}

## 3. Operations
${'Inventory turns slipped because the holiday buy landed early. '.repeat(30)}

## 4. Risks
- Supplier concentration
- Labour costs
`

/** A tiny RGB PNG encoder for page-analysis tests. */
function png(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) { const [r, g, b] = paint(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (name: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(name, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([len, body, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** A PDF with an outline (bookmarks) and text at known places, like Chromium prints. */
async function outlinedPdf(titles: Array<[string, number]>, pages: number, lastLineY = 700): Promise<Buffer> {
  const L = await import('pdf-lib')
  const doc = await L.PDFDocument.create()
  const font = await doc.embedFont(L.StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    const p = doc.addPage([612, 792])
    p.drawText(`Body text on page ${i + 1}`, { x: 72, y: i === pages - 1 ? lastLineY : 100, size: 11, font })
    p.drawText(`Page ${i + 1} of ${pages}`, { x: 480, y: 40, size: 8, font })
  }
  const items = titles.map(([t, page]) => doc.context.obj({ Title: L.PDFHexString.fromText(t), Dest: [doc.getPage(page - 1).ref, L.PDFName.of('XYZ'), null, null, null] }))
  const refs = items.map((it) => doc.context.register(it))
  const root = doc.context.obj({ Type: 'Outlines', Count: refs.length })
  const rootRef = doc.context.register(root)
  refs.forEach((r, i) => {
    const d = items[i]
    d.set(L.PDFName.of('Parent'), rootRef)
    if (i > 0) d.set(L.PDFName.of('Prev'), refs[i - 1])
    if (i < refs.length - 1) d.set(L.PDFName.of('Next'), refs[i + 1])
  })
  root.set(L.PDFName.of('First'), refs[0])
  root.set(L.PDFName.of('Last'), refs[refs.length - 1])
  doc.catalog.set(L.PDFName.of('Outlines'), rootRef)
  return Buffer.from(await doc.save())
}

describe('themes', () => {
  test('every theme reads: ink, muted text, accents and callouts pass WCAG AA', () => {
    for (const name of THEME_NAMES) {
      const t = themeOf(name)
      expect(contrast(t.ink, '#FFFFFF')).toBeGreaterThanOrEqual(7)
      expect(contrast(t.muted, '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
      expect(contrast(t.accentText, '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
      expect(contrast(t.ink, t.accentTint)).toBeGreaterThanOrEqual(7)
      for (const tone of Object.values(t.tones)) expect(contrast(tone.color, tone.fill)).toBeGreaterThanOrEqual(4.5)
    }
  })

  test('a too-light brand accent keeps its hue for fills but is darkened for text', () => {
    const t = themeOf('modern', '#FFD400')
    expect(t.accent).toBe('#FFD400')
    expect(contrast(t.accentText, '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
    expect(readable('#FF6A1A')).not.toBe('#FF6A1A')
    expect(readable('#1F5FAD')).toBe('#1F5FAD')
    expect(seriesColors(t, 5)).toHaveLength(5)
    expect(new Set(seriesColors(t, 5)).size).toBe(5)
  })

  test('office fonts are installed on every Mac and PC (no Calibri: Quick Look and Pages swap it for Times)', () => {
    for (const name of THEME_NAMES) expect(['Arial', 'Georgia', 'Helvetica']).toContain(themeOf(name).office.body)
  })
})

describe('typography and blocks', () => {
  test('typographer quotes, dashes and ellipses; code and years kept right', () => {
    expect(smartQuotes('"Hello," she said -- it\'s "done"...')).toBe('“Hello,” she said – it’s “done”…')
    expect(smartQuotes("rock 'n' roll in the '90s")).toBe('rock ‘n’ roll in the ’90s')
    expect(smartQuotes('pages 10--12 --- fine')).toBe('pages 10–12 — fine')
    const html = blocksToHtml(parseMarkdown('Say "hi" and run `echo "x"`').blocks, { smart: true })
    expect(html).toContain('“hi”')
    expect(html).toContain('<code>echo &quot;x&quot;</code>')
  })

  test('tables: numeric columns right-aligned, total rows marked, blank header rows dropped, small tables kept whole', () => {
    const { blocks } = parseMarkdown('| Item | Cost | Share |\n|---|---|---|\n| A | $1,200 | 40% |\n| B | (300) | n/a |\n| Total | $900 | 100% |\n\nTable: Costs')
    const t = blocks[0] as Extract<DocBlock, { type: 'table' }>
    expect(numericColumns(t.header, t.rows)).toEqual([false, true, true])
    const html = blocksToHtml(blocks, { numbering: true })
    expect(html).toContain('<th class="r">Cost</th>')
    expect(html).toContain('<tr class="total">')
    expect(html).toContain('<span class="cap-n">Table 1.</span> Costs')
    expect(html).toContain('class="tbl keep"')
    const noHead = blocksToHtml(parseMarkdown('| | |\n|---|---|\n| **Invoice** | 42 |').blocks)
    expect(noHead).not.toContain('<thead>')
  })

  test('callouts get a label; footnotes link both ways; TOC entries carry page numbers and depth', () => {
    const md = '# T\n\n[TOC]\n\n## One\n\nText[^a]\n\n### Sub\n\n> [!WARNING] Careful\n\n## Two\n\n[^a]: A note'
    const html = blocksToHtml(parseMarkdown(md).blocks, { footnotes: parseMarkdown(md).footnotes, tocPages: { one: '3', sub: '4', two: '5' } })
    expect(html).toContain('<span class="callout-label">Warning</span>')
    expect(html).toMatch(/href="#fn-1" id="fnref-1"/)
    expect(html).toContain('href="#fnref-1"')
    expect(html).toMatch(/class="l2 d0" href="#one"><span class="tt">One<\/span><span class="dots"><\/span><span class="pg">3<\/span>/)
    expect(html).toContain('class="l3 d1" href="#sub"')
  })

  test('chart fences become chart blocks (and round-trip); bad JSON stays a code block', () => {
    const { blocks } = parseMarkdown('```chart\n{"type": "line", "categories": ["Jan", "Feb"], "series": [{"name": "Users", "values": [1, 2]}],}\n```\n\nFigure: Users by month\n\n```chart\nnot json\n```')
    expect(blocks[0]).toMatchObject({ type: 'chart', chart: { type: 'line' }, caption: 'Users by month' })
    expect(blocks[1].type).toBe('code')
    expect(parseChart('{"categories": ["a"], "series": [{"name": "s", "values": [1]}]}')?.type).toBe('column')
  })
})

describe('charts', () => {
  test('nice axis scales and Excel-style number formats', () => {
    expect(niceScale(0, 14570)).toEqual({ lo: 0, hi: 15000, step: 5000 })
    expect(niceScale(0, 9.3)).toEqual({ lo: 0, hi: 10, step: 2 })
    expect(niceScale(-3, 8, 5)).toEqual({ lo: -5, hi: 10, step: 2.5 })
    expect(formatNumber(1234.5, '$#,##0')).toBe('$1,235')
    expect(formatNumber(0.256, '0.0%')).toBe('25.6%')
    expect(formatNumber(-1500, '#,##0')).toBe('−1,500')
  })

  test('SVG: one bar per value, a legend for several series, accessible label; bad specs are reported', () => {
    const t = themeOf('modern')
    const svg = chartSvg({ type: 'column', categories: ['Q1', 'Q2', 'Q3'], series: [{ name: 'A', values: [1, 2, 3] }, { name: 'B', values: [2, 3, 4] }], number_format: '$#,##0' }, t)
    expect((svg.match(/<rect /g) ?? []).length).toBe(6 + 2)
    expect(svg).toContain('role="img"')
    expect(svg).toContain('aria-label="column chart. A: Q1 1, Q2 2, Q3 3; B: Q1 2, Q2 3, Q3 4"')
    for (const type of ['bar', 'line', 'area', 'pie', 'doughnut'] as const) expect(chartSvg({ type, categories: ['a', 'b'], series: [{ name: 's', values: [3, 1] }] }, t)).toMatch(/^<svg[\s\S]*<\/svg>$/)
    expect(chartProblems({ type: 'column', categories: ['a', 'b'], series: [{ name: 's', values: [1] }] })).toEqual(['Series "s" has 1 values for 2 categories.'])
    expect(chartProblems({ type: 'radar' as never, categories: [], series: [] })).toHaveLength(3)
  })
})

describe('PDF engine (layout rules)', () => {
  test('long documents get a TOC after the title; the cover takes the title; templates set the frame', () => {
    const p = preparePdf(LONG, {})
    expect(p.hasToc).toBe(true)
    expect(p.blocks[0]).toMatchObject({ type: 'paragraph', style: 'title' })
    expect(p.blocks[1].type).toBe('toc')
    const c = preparePdf(LONG, { template: 'report', fields: { subtitle: 'Board pack', organization: 'Northwind' } })
    expect(c.cover).toBe(true)
    expect(c.blocks.some((b) => b.type === 'paragraph' && b.style === 'title')).toBe(false)
    expect(c.title).toBe('Annual Review')
    expect(coverHtml(c, defaultLayout(c))).toContain('Board pack')
    expect(defaultLayout(c).header).toBe('Annual Review')
  })

  test('page CSS: running header and "Page X of Y" in margin boxes, keep-with-next headings, repeated table headers, widows/orphans', () => {
    const p = preparePdf(LONG, { template: 'report' })
    const css = pageCss(p, defaultLayout(p))
    expect(css).toMatch(/@top-left \{ content: "Annual Review"/)
    expect(css).toContain('"Page " counter(page) " of " counter(pages)')
    expect(css).toMatch(/h1, h2, h3, h4 \{[^}]*break-after: avoid/)
    expect(css).toContain('thead { display: table-header-group; }')
    expect(css).toContain('tr { break-inside: avoid; }')
    expect(css).toMatch(/widows: 2; orphans: 2/)
    expect(css).toContain('hyphens: auto')
    expect(css).toContain('font-variant-numeric: tabular-nums')
    // Without a cover, the first page carries the title block, not the running header.
    const plain = preparePdf(LONG, { header: 'Running' })
    expect(pageCss(plain, defaultLayout(plain))).toContain('@page :first { @top-left { content: none } }')
    // Header text is a CSS string: quotes can't break out.
    const q = preparePdf('# A "quoted" title', { header: 'A "quoted" \\ title' })
    expect(pageCss(q, defaultLayout(q))).toContain('content: "A \\"quoted\\" \\\\ title"')
  })

  test('layout options: page size, landscape, margins, font size; resume is tighter', () => {
    const p = preparePdf('# T\n\ntext', { pageSize: 'a4', orientation: 'landscape', margins: { top: 0.5, left: 1.25 }, fontSize: 12 })
    const l = defaultLayout(p)
    expect(l).toMatchObject({ size: 'a4', landscape: true, fontSize: 12 })
    expect(l.margins).toMatchObject({ top: 0.5, left: 1.25 })
    expect(pageCss(p, l)).toContain('size: 11.69in 8.27in')
    expect(defaultLayout(preparePdf('# T', { margins: 0.1 })).margins.top).toBe(0.4)
    const r = preparePdf('# Ada\n\nada@x.com · London\n\n## Experience\n\n### Engineer — Acme | 2020 – Now\n\n- Built things', { template: 'resume' })
    expect(r.opts.fitPages).toBe(1)
    expect(defaultLayout(r).density).toBeLessThan(1)
    expect(bodyHtml(r, defaultLayout(r))).toContain('<span class="h-side">2020 – Now</span>')
  })

  test('fitting steps tighten spacing first, then type and margins, never below readable limits', () => {
    const p = preparePdf(LONG, {})
    let l = defaultLayout(p)
    const seen = [l]
    for (let i = 0; ; i++) { const n = tighter(l, i); if (!n) break; seen.push(n); l = n }
    expect(seen.length).toBeGreaterThan(4)
    expect(seen[1].density).toBeLessThan(1)
    expect(seen[1].fontSize).toBe(seen[0].fontSize)
    for (const s of seen) {
      expect(s.fontSize).toBeGreaterThanOrEqual(MIN_FONT)
      expect(s.margins.top).toBeGreaterThanOrEqual(0.6)
      expect(s.density).toBeGreaterThanOrEqual(0.7)
    }
  })

  test('TOC page numbers come from the printed bookmarks, in order (doubled Chromium titles included)', () => {
    const p = preparePdf(LONG, {})
    const info = { pages: 4, lastFill: 0.5, outline: [{ title: 'Executive summary', page: 1, depth: 0 }, { title: '1. Finance', page: 1, depth: 0 }, { title: '2. Customers2. Customers', page: 2, depth: 0 }, { title: '3. Operations', page: 3, depth: 0 }, { title: '4. Risks', page: 4, depth: 0 }] }
    expect(tocPagesFrom(p, info)).toEqual({ 'executive-summary': '1', '1-finance': '1', '2-customers': '2', '3-operations': '3', '4-risks': '4' })
    expect(undouble('AbcAbc')).toBe('Abc')
    expect(undouble('Abc')).toBe('Abc')
  })

  test('reading the printed PDF: page count, bookmarks with pages, how full the last page is (header/footer ignored)', async () => {
    const pdf = await outlinedPdf([['Intro', 1], ['Details', 2]], 2, 650)
    const info = await readPrinted(pdf, { top: 1, bottom: 1 })
    expect(info.pages).toBe(2)
    expect(info.outline).toEqual([{ title: 'Intro', page: 1, depth: 0 }, { title: 'Details', page: 2, depth: 0 }])
    // One line near the top of the text area: about 10% used, though "Page 2 of 2" sits at the bottom.
    expect(info.lastFill).toBeGreaterThan(0.05)
    expect(info.lastFill).toBeLessThan(0.2)
  })

  test('finishing: cover inserted first, page labels, metadata, language, undoubled bookmarks', async () => {
    const body = await outlinedPdf([['OneOne', 1], ['Two', 2]], 2)
    const cover = await outlinedPdf([['Cover', 1]], 1)
    const out = await finishPdf(body, cover, { title: 'Annual Review', author: 'Finance', subject: 'Board pack', keywords: ['retail'], lang: 'en-GB' })
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = pdfjs.getDocument({ data: new Uint8Array(out) })
    const doc = await task.promise
    expect(doc.numPages).toBe(3)
    expect(await doc.getPageLabels()).toEqual(['Cover', '1', '2'])
    const meta = (await doc.getMetadata()).info as Record<string, unknown>
    expect(meta).toMatchObject({ Title: 'Annual Review', Author: 'Finance', Subject: 'Board pack', Language: 'en-GB', Creator: 'SahilBot' })
    expect(((await doc.getOutline()) ?? []).map((o) => o.title)).toEqual(['One', 'Two'])
    await task.destroy()
    const L = await import('pdf-lib')
    const back = await L.PDFDocument.load(out)
    expect(back.catalog.getOrCreateViewerPreferences().getDisplayDocTitle()).toBe(true)
  })
})

describe('templates', () => {
  test('invoice: title, from / bill to / facts header, never invented values', () => {
    const t = applyTemplate('invoice', parseMarkdown('| Item | Amount |\n|---|---|\n| Design | $100 |\n| Total due | $100 |'), { sender: 'Fernwood', recipient: 'Harbor', invoice_number: 'INV-7', due_date: 'Dec 1' })
    expect(t.blocks[0]).toMatchObject({ type: 'paragraph', style: 'title', text: 'Invoice' })
    const head = t.blocks[1] as Extract<DocBlock, { type: 'table' }>
    expect(head.variant).toBe('plain')
    expect(String(head.rows[0][0])).toContain('Fernwood')
    expect(String(head.rows[0][1])).toContain('Harbor')
    expect(String(head.rows[0][2])).toContain('INV-7')
    expect(String(head.rows[0][2])).not.toContain('PO')
    expect(t.title).toBe('Invoice INV-7')
  })

  test('resume: name as title, contact line as subtitle, one page', () => {
    const t = applyTemplate('resume', parseMarkdown('# Ada Lovelace\n\nada@example.com · London\n\n## Experience\n\n### Analyst — Engines Ltd | 1842'))
    expect(t.blocks[0]).toMatchObject({ style: 'title' })
    expect(t.blocks[1]).toMatchObject({ style: 'subtitle' })
    expect(t.layout).toMatchObject({ fitPages: 1, sideHeads: true, docClass: 'resume' })
  })
})

describe('Word, PowerPoint and Excel structure', () => {
  test('docx: theme fonts on every run, tinted header rows (no white-on-accent), native chart part, page count', async () => {
    const md = `${LONG}\n\n\`\`\`chart\n{"type": "column", "categories": ["Q1", "Q2"], "series": [{"name": "Rev", "values": [10, 12]}]}\n\`\`\``
    const r = await buildDocx(md, { accent: '#FFD400' })
    expect(r.stats.pages).toBeGreaterThanOrEqual(2)
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(r.buffer)
    expect(Object.keys(zip.files).some((f) => /^word\/charts\/chart\d+\.xml$/.test(f))).toBe(true)
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('w:ascii="Arial"')
    expect(xml).not.toContain('w:color w:val="FFFFFF"')
    expect(xml).toContain(`w:fill="${themeOf('modern', '#FFD400').accentTint.slice(1)}"`)
    const info = await inspectDocx(r.buffer)
    expect(info.tables[0].headerRow).toBe(true)
    expect(info.paragraphs.some((p) => p.style === 'Caption' && p.text === 'Table 1. Results')).toBe(true)
    const classic = await (await JSZip.loadAsync((await buildDocx(LONG, { theme: 'classic' })).buffer)).file('word/document.xml')!.async('string')
    expect(classic).toContain('w:ascii="Georgia"')
  })

  test('docx: fit_pages shrinks a two-page memo to one page and says how', async () => {
    const memo = Array.from({ length: 6 }, (_, i) => `## Point ${i + 1}\n\n${'This paragraph explains the point in plain words with numbers and context. '.repeat(5)}`).join('\n\n')
    const loose = await buildDocx(memo, { template: 'memo', fields: { to: 'Team', from: 'Me', subject: 'Plan' } })
    expect(loose.stats.pages).toBe(2)
    const fit = await buildDocx(memo, { template: 'memo', fields: { to: 'Team', from: 'Me', subject: 'Plan' }, fitPages: 1 })
    expect(fit.stats.pages).toBe(1)
    expect(fit.notes.join(' ')).toMatch(/Fitted to 1 page\(s\): spacing \d+%/)
  })

  test('docx: margins, page size and base size are real section properties', async () => {
    const r = await buildDocx('# T\n\nHello', { margins: { top: 0.5, left: 1.5 }, pageSize: 'legal', fontSize: 12 })
    const JSZip = (await import('jszip')).default
    const xml = await (await JSZip.loadAsync(r.buffer)).file('word/document.xml')!.async('string')
    expect(docxPageSetup(r.buffer, xml)).toMatchObject({ w: 8.5, h: 14, top: 0.5, left: 1.5, right: 1 })
    const styles = await (await JSZip.loadAsync(r.buffer)).file('word/styles.xml')!.async('string')
    expect(styles).toContain('<w:sz w:val="24"/>')
  })

  test('resume docx: dates on a right tab stop', async () => {
    const r = await buildDocx('# Ada\n\nada@x.com\n\n## Experience\n\n### Engineer — Acme | 2020 – Now\n\n- Built it', { template: 'resume' })
    const JSZip = (await import('jszip')).default
    const xml = await (await JSZip.loadAsync(r.buffer)).file('word/document.xml')!.async('string')
    expect(xml).toMatch(/<w:tab w:val="right"/)
    expect(xml).toContain('2020 – Now')
  })

  test('pptx: slide masters, theme fonts, readable accent text, tinted table header', async () => {
    const r = await buildPptx([
      { title: 'Deck', layout: 'title' },
      { title: 'Numbers', stats: [{ value: '$4M', label: 'ARR' }] },
      { title: 'Table', table: [['Region', 'Revenue'], ['East', 10], ['Total', 10]] },
      { title: 'Part 2', layout: 'section' }
    ], { accent: '#FFD400', style: 'minimal' })
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(r.buffer)
    const layouts = await Promise.all(Object.keys(zip.files).filter((f) => /slideLayouts\/slideLayout\d+\.xml$/.test(f)).map((f) => zip.file(f)!.async('string')))
    expect(layouts.some((x) => /SB_CONTENT/.test(x))).toBe(true)
    const deck = await inspectPptx(r.buffer)
    expect(deck.fonts).toContain('Helvetica')
    expect(deck.slides[0].background).toBeTruthy()
    const s2 = await zip.file('ppt/slides/slide2.xml')!.async('string')
    // The stat value is drawn in the accent darkened to read on the card, not the raw yellow.
    expect(s2).toContain(readable('#FFD400', '#F3F4F6', 3.2).slice(1))
    const s3 = await zip.file('ppt/slides/slide3.xml')!.async('string')
    expect(s3).not.toContain('<a:srgbClr val="FFFFFF"/></a:solidFill><a:latin')
  })

  test('xlsx: header fill is dark enough for its white text, whatever the accent', async () => {
    const r = await buildXlsx([{ name: 'Data', rows: [['Item', 'Cost'], ['A', 1]] }], { accent: themeOf('modern', '#FFD400').accentText })
    const wb = await loadWorkbook(r.buffer)
    const fill = (wb.getWorksheet('Data')!.getCell('A1').fill as { fgColor?: { argb?: string } }).fgColor?.argb ?? ''
    expect(contrast(`#${fill.slice(-6)}`, '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
  })
})

describe('rendered-page checks', () => {
  test('PNG decoding and page measurement: blank pages, edge ink, where the body ends', () => {
    const blank = analyzePage(png(100, 130, () => [255, 255, 255]), 1)!
    expect(blank.blank).toBe(true)
    const text = analyzePage(png(100, 130, (x, y) => (y > 15 && y < 40 && x > 12 && x < 88 && y % 4 === 0 ? [20, 20, 20] : [255, 255, 255])), 2)!
    expect(text.blank).toBe(false)
    expect(text.edge.right).toBe(0)
    expect(bodyFill(text)).toBeGreaterThan(0.1)
    expect(bodyFill(text)).toBeLessThan(0.35)
    const cut = analyzePage(png(100, 130, (x, y) => (y > 20 && y < 60 && x > 12 ? [20, 20, 20] : [255, 255, 255])), 3)!
    expect(cut.edge.right).toBeGreaterThan(0.05)
    expect(decodePng(Buffer.from('not a png'))).toBeUndefined()
  })

  test('review checks from rendered pages: page budget, blank pages, cut-off content, sparse last page, slide overflow', () => {
    const page = (n: number, o: Partial<{ blank: boolean; right: number; rows: number[] }> = {}) => ({ page: n, ink: o.blank ? 0 : 0.05, blank: !!o.blank, edge: { top: 0, right: o.right ?? 0, bottom: 0, left: 0 }, bottom: 0.9, rows: o.rows ?? Array.from({ length: 50 }, (_, i) => (i > 4 && i < 44 ? 0.05 : 0)) })
    const sparse = Array.from({ length: 50 }, (_, i) => (i > 4 && i < 8 ? 0.05 : i === 47 ? 0.02 : 0))
    const r: RenderResult = { kind: 'pdf', method: 'pdfkit', pageCount: 3, sizes: [], images: [], checks: [page(1), page(2, { blank: true, right: 0.2 }), page(3, { rows: sparse })], overflow: [], lowContrast: ['"Fine print" (contrast 2.1:1)'], notes: [] }
    const checks = renderChecks(r, 'pdf', 2)
    const msg = (s: string) => checks.filter((c) => c.status === s).map((c) => c.message).join(' | ')
    expect(msg('fail')).toMatch(/3 pages, expected at most 2: rebuild with fit_pages: 2/)
    expect(msg('fail')).toMatch(/Blank page: 2/)
    expect(msg('warn')).toMatch(/last page is only about \d+% used/)
    expect(msg('warn')).toMatch(/Low-contrast text/)
    expect(msg('pass')).toMatch(/Rendered 3 pages \(exact\)/)
    const deck = renderChecks({ ...r, kind: 'pptx', method: 'quicklook', checks: [], overflow: ['slide 2: "Long text" is cut off by its box'], lowContrast: [] }, 'pptx')
    expect(deck.find((c) => c.status === 'fail')?.message).toMatch(/Overflow: slide 2/)
  })

  test.skipIf(process.platform !== 'darwin')('PDFKit renders every page to PNG and a contact sheet (macOS, no extra installs)', async () => {
    const dir = tmp()
    const pdf = join(dir, 'two.pdf')
    writeFileSync(pdf, await outlinedPdf([['A', 1]], 2))
    const r = await pdfToImages(pdf, { outDir: dir, width: 400 })
    expect(r.pages).toBe(2)
    expect(r.images.map((i) => i.page)).toEqual([1, 2])
    for (const i of r.images) expect(existsSync(i.path)).toBe(true)
    expect(r.sheet && existsSync(r.sheet)).toBe(true)
    const c = analyzePage(readFileSync(r.images[0].path), 1)!
    expect(c.blank).toBe(false)
  }, 20_000)
})
