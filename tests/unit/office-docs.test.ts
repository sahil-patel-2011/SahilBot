import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildDocx } from '../../src/main/docs/docx'
import { Engine, portableFormula, type Book, type Value } from '../../src/main/docs/formula'
import { inspectDocx, inspectPptx } from '../../src/main/docs/inspect'
import { blocksToMarkdown, parseMarkdown, plainText } from '../../src/main/docs/markdown'
import { buildPptx, planSlides } from '../../src/main/docs/pptx'
import { formatReview, reviewDocument } from '../../src/main/docs/review'
import { buildXlsx, columnStats, editWorkbook, loadWorkbook, parseCsv, readSheets, sheetFromCsv } from '../../src/main/docs/xlsx'

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'office-')))

// A 2×1 red PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAEElEQVR4nGP4z8DAwMDAAAAJ+gH/2bDFsgAAAABJRU5ErkJggg==', 'base64')

const REPORT = `# Market Report

A short lead paragraph that cites a source[^1].

## Summary
Revenue grew in every region.

## Revenue
| Region | Q1 | Q2 |
|---|---|---|
| North | $1,200 | $1,400 |
| South | 900 | 950 |
| East | 300 | 320 |
| West | 410 | 400 |

Table: Revenue by region

### Notes on method
Numbers are unaudited.

![Logo](logo.png "Company logo")

<!-- pagebreak -->

## Outlook
> [!WARNING] Costs are rising.

<!-- landscape -->

## Appendix
Wide content.

[^1]: Company filings, 2026.
`

describe('Word documents', () => {
  test('round trip: styles, TOC with page numbers, header/footer page numbers, table, image, footnote, landscape section', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'logo.png'), PNG)
    const r = await buildDocx(REPORT, { accent: '#2563EB', toc: true, baseDir: dir, citations: ['Annual report 2026', { text: 'Market data', url: 'https://example.com/data' }] })
    expect(r.warnings).toEqual([])
    const d = await inspectDocx(r.buffer)
    expect(d.title).toBe('Market Report')
    expect(d.headings.map((h) => `${h.level}:${h.text}`)).toEqual(['2:Summary', '2:Revenue', '3:Notes on method', '2:Outlook', '2:Appendix', '2:References'])
    expect(d.toc.present).toBe(true)
    expect(d.toc.entries).toBeGreaterThanOrEqual(5)
    expect(d.toc.pageNumbers).toBe(true)
    expect(d.pageNumberField).toBe(true)
    expect(d.headers.join(' ')).toContain('Market Report')
    expect(d.footers.join(' ')).toMatch(/Page/)
    expect(d.tables).toHaveLength(1)
    expect(d.tables[0].rows[0]).toEqual(['Region', 'Q1', 'Q2'])
    expect(d.tables[0].headerRow).toBe(true)
    expect(d.tables[0].banded).toBe(true)
    expect(d.paragraphs.some((p) => p.style === 'Caption' && p.text === 'Table 1. Revenue by region')).toBe(true)
    expect(d.paragraphs.some((p) => p.style === 'Caption' && p.text === 'Figure 1. Company logo')).toBe(true)
    expect(d.images).toBe(1)
    expect(d.footnotes).toEqual(['Company filings, 2026.'])
    expect(d.sections.map((s) => s.orientation)).toEqual(['portrait', 'landscape'])
    expect(d.paragraphs.some((p) => p.pageBreak)).toBe(true)
    expect(d.paragraphs.some((p) => /\[2\]\s+Market data https:\/\/example\.com\/data/.test(p.text))).toBe(true)
    expect(Object.values(d.styles)).toEqual(expect.arrayContaining(['Title', 'Subtitle', 'Heading 1', 'Heading 2', 'Heading 3', 'caption', 'Quote', 'toc 1']))
    const review = await reviewDocument({ data: r.buffer, name: 'report.docx' })
    expect(review.checks.filter((c) => c.status === 'fail')).toEqual([])
  })

  test('templates frame the content without placeholders', async () => {
    const memo = await inspectDocx((await buildDocx('Please submit Q4 budgets by Friday.', { template: 'memo', fields: { to: 'All managers', from: 'Finance', subject: 'Q4 budgets', date: 'November 14, 2026' } })).buffer)
    expect(memo.title).toBe('Memorandum')
    expect(memo.tables[0].rows).toEqual([['To', 'All managers'], ['From', 'Finance'], ['Date', 'November 14, 2026'], ['Subject', 'Q4 budgets']])
    expect(memo.toc.present).toBe(false)

    const letter = await inspectDocx((await buildDocx('Thank you for meeting with us last week.', { template: 'letter', fields: { sender: 'Ada Park', sender_address: '1 Main St; Springfield', recipient: 'Sam Lee', date: 'November 14, 2026' } })).buffer)
    const lines = letter.paragraphs.map((p) => p.text)
    expect(lines[0]).toBe('Ada Park\n1 Main St\nSpringfield')
    expect(lines).toEqual(expect.arrayContaining(['November 14, 2026', 'Dear Sam Lee,', 'Thank you for meeting with us last week.', 'Sincerely,']))
    expect(letter.pageNumberField).toBe(false)

    const proposal = await buildDocx('# Website Redesign\n\n## Goals\nA.\n\n## Scope\nB.\n\n## Timeline\nC.\n\n## Budget\nD.', { template: 'proposal', toc: true, fields: { prepared_for: 'Acme', prepared_by: 'Studio Nine' } })
    const p = await inspectDocx(proposal.buffer)
    expect(p.title).toBe('Website Redesign')
    expect(p.toc.present).toBe(true)
    expect(p.paragraphs.map((x) => x.text)).toContain('Prepared for Acme · Prepared by Studio Nine')
    expect(p.headers.join(' ')).toContain('Website Redesign')
    // Automatic contents only for long documents.
    const short = await inspectDocx((await buildDocx('# T\n\n## A\nx\n\n## B\nx\n\n## C\nx\n\n## D\nx')).buffer)
    expect(short.toc.present).toBe(false)
    const long = await inspectDocx((await buildDocx(`# T\n\n${['A', 'B', 'C', 'D'].map((h) => `## ${h}\n${'Plenty of words here. '.repeat(40)}`).join('\n\n')}`)).buffer)
    expect(long.toc.present).toBe(true)

    const notes = await inspectDocx((await buildDocx('## Decisions\n- Ship on Monday', { template: 'meeting_notes', title: 'Launch sync', fields: { date: '2026-11-14', attendees: ['Ann', 'Bo'] } })).buffer)
    expect(notes.title).toBe('Launch sync')
    expect(notes.tables[0].rows).toEqual([['Date', '2026-11-14'], ['Attendees', 'Ann, Bo']])
  })

  test('markdown model round-trips through blocks', () => {
    const p = parseMarkdown(REPORT)
    expect(p.footnotes).toEqual({ 1: 'Company filings, 2026.' })
    expect(p.blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'heading', 'paragraph', 'heading', 'table', 'heading', 'paragraph', 'image', 'page_break', 'heading', 'callout', 'section', 'heading', 'paragraph'])
    const table = p.blocks.find((b) => b.type === 'table')!
    expect(table.type === 'table' && table.caption).toBe('Revenue by region')
    const again = parseMarkdown(blocksToMarkdown(p.blocks, p.footnotes))
    expect(again.blocks.map((b) => b.type)).toEqual(p.blocks.map((b) => b.type))
    expect(plainText(again.blocks[1].type === 'paragraph' ? again.blocks[1].text : '')).toBe('A short lead paragraph that cites a source.')
  })
})

describe('formulas', () => {
  const book = (cells: Record<string, Value | string>): Book => ({
    sheet: (n) => (/^(s|data)$/i.test(n) ? (n.toLowerCase() === 'data' ? 'Data' : 'S') : undefined),
    size: () => ({ rows: 10, cols: 5 }),
    cell: (s, r, c) => {
      const v = cells[`${s}!${String.fromCharCode(64 + c)}${r}`]
      if (v === undefined) return undefined
      return typeof v === 'string' && v.startsWith('=') ? { formula: v.slice(1) } : { value: v as Value }
    }
  })
  test('arithmetic, aggregates, lookups, criteria and errors', () => {
    const e = new Engine(book({ 'S!A1': 10, 'S!A2': 20, 'S!A3': 30, 'S!B1': 'x', 'S!B2': 'y', 'S!B3': 'x', 'Data!A1': 'North', 'Data!B1': 5, 'Data!A2': 'South', 'Data!B2': 7, 'S!C1': '=A1/0', 'S!C2': '=C3', 'S!C3': '=C2' }))
    const f = (x: string) => e.evalFormula(x, 'S')
    expect(f('=SUM(A1:A3)*2+1')).toBe(121)
    expect(f('=AVERAGE(A1:A3)')).toBe(20)
    expect(f('=IF(A1>5,"big","small")')).toBe('big')
    expect(f('=SUMIF(B1:B3,"x",A1:A3)')).toBe(40)
    expect(f('=COUNTIFS(B1:B3,"x",A1:A3,">15")')).toBe(1)
    expect(f('=VLOOKUP("South",Data!A1:B2,2,FALSE)')).toBe(7)
    expect(f('=INDEX(Data!B1:B2,MATCH("North",Data!A1:A2,0))')).toBe(5)
    expect(f('=XLOOKUP("West",Data!A1:A2,Data!B1:B2,"none")')).toBe('none')
    expect(f('=ROUND(2/3,2)')).toBe(0.67)
    expect(f('=TEXT(1234.5,"$#,##0.00")')).toBe('$1,234.50')
    expect(String(f('=1/0'))).toBe('#DIV/0!')
    expect(String(f('=IFERROR(C1,"n/a")'))).toBe('n/a')
    expect(String(e.cellValue('S', 2, 3))).toBe('#CIRC!')
    expect(String(f('=Nope!A1'))).toBe('#REF!')
    expect(() => f('=FORECAST.ETS(1,2,3)')).toThrow(/not supported/)
  })
  test('XLOOKUP is rewritten to INDEX/MATCH that works everywhere', () => {
    expect(portableFormula('=XLOOKUP(A2,Data!A:A,Data!C:C,"Not found")')).toBe('IFERROR(INDEX(Data!C:C,MATCH(A2,Data!A:A,0)),"Not found")')
    expect(portableFormula('=SUM(XLOOKUP(A2,B:B,C:C),1)')).toBe('SUM(IFERROR(INDEX(C:C,MATCH(A2,B:B,0)),NA()),1)')
  })
})

describe('Excel workbooks', () => {
  test('typed columns, formulas with results, totals, freeze, filter, validation, conditional formats and a summary', async () => {
    const r = await buildXlsx([{
      name: 'Sales',
      columns: [
        { header: 'Date', type: 'date' }, { header: 'Region', options: ['North', 'South'] }, { header: 'Units', type: 'integer' },
        { header: 'Price', type: 'currency' }, { header: 'Revenue', type: 'currency', formula: '=C{r}*D{r}' }, { header: 'Manager' }
      ],
      rows: [['2026-01-05', 'North', 10, '$12.50', null, '=XLOOKUP(B2,Team!A:A,Team!B:B,"?")'], ['2026-01-06', 'South', 4, 20, null, '=XLOOKUP(B3,Team!A:A,Team!B:B,"?")']],
      totals: true,
      conditional: [{ column: 'Revenue', type: 'greater_than', value: 100, color: 'green' }, { column: 'Units', type: 'data_bar' }]
    }, { name: 'Team', rows: [['Region', 'Manager'], ['North', 'Ann'], ['South', 'Bo']] }], { summary: true })
    expect(r.errors).toEqual([])
    const wb = await loadWorkbook(r.buffer)
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Sales', 'Team'])
    const s = wb.getWorksheet('Sales')!
    expect(s.getCell('A2').value).toBeInstanceOf(Date)
    expect(s.getCell('A2').numFmt).toBe('yyyy-mm-dd')
    expect(s.getCell('D2').value).toBe(12.5)
    expect(s.getCell('D2').numFmt).toContain('#,##0.00')
    expect(s.getCell('E2').value).toEqual({ formula: 'C2*D2', result: 125 })
    expect(s.getCell('F2').value).toEqual({ formula: 'IFERROR(INDEX(Team!B:B,MATCH(B2,Team!A:A,0)),"?")', result: 'Ann' })
    expect(s.getCell('A4').value).toBe('Total')
    expect(s.getCell('E4').value).toEqual({ formula: 'SUM(E2:E3)', result: 205 })
    const sheets = readSheets(wb)
    const sales = sheets.find((x) => x.name === 'Sales')!
    expect(sales.frozen).toEqual({ rows: 1, cols: 0 })
    expect(sales.autoFilter).toBeTruthy()
    expect(sales.validations).toBe(1)
    expect(sales.conditionalFormats).toBe(2)
    const summary = sheets[0].cells.filter((c) => c.formula).map((c) => [c.formula, c.value])
    expect(summary).toEqual(expect.arrayContaining([['=SUM(Sales!E2:E3)', 205], ['=ROWS(Sales!A2:A3)', 2]]))
    const review = await reviewDocument({ data: r.buffer, name: 'sales.xlsx' })
    expect(review.pass).toBe(true)
  })

  test('in-place edits keep styles, append above the totals row and recompute', async () => {
    const r = await buildXlsx([{ name: 'Costs', columns: [{ header: 'Item' }, { header: 'Qty', type: 'integer' }, { header: 'Cost', type: 'currency' }, { header: 'Line', type: 'currency', formula: '=B{r}*C{r}' }], rows: [['Pens', 10, 1.5, null], ['Paper', 2, 6, null]], totals: true }])
    const wb = await loadWorkbook(r.buffer)
    const res = editWorkbook(wb, [{ sheet: 'Costs', append: [['Ink', 3, 20, null]] }, { sheet: 'Costs', cell: 'B2', value: 20 }])
    expect(res.errors).toEqual([])
    const ws = wb.getWorksheet('Costs')!
    expect(ws.getCell('A4').value).toBe('Ink')
    expect(ws.getCell('D4').value).toEqual({ formula: 'B4*C4', result: 60 })
    expect(ws.getCell('C4').numFmt).toContain('#,##0.00')
    expect(ws.getCell('A5').value).toBe('Total')
    expect(ws.getCell('D5').value).toEqual({ formula: 'SUM(D2:D4)', result: 102 })
    expect(res.changed.find((c) => c.cell === 'B2')).toMatchObject({ before: '10', after: '20' })
    const reread = readSheets(await loadWorkbook(Buffer.from(await wb.xlsx.writeBuffer())), { sheet: 'Costs', range: 'D5:D5' })
    expect(reread[0].cells[0]).toMatchObject({ addr: 'D5', value: 102, formula: '=SUM(D2:D4)' })
  })

  test('CSV import infers types; column statistics', async () => {
    const rows = parseCsv('Date,Customer,Amount,Share,Zip\n2026-01-02,"Acme, Inc.",$1200.00,10%,02139\n2026-01-03,Bolt,"$3,400.50",25%,10001\n2026-01-09,Acme,$75.25,5%,94105\n')
    expect(rows[1][1]).toBe('Acme, Inc.')
    const spec = sheetFromCsv('Orders', rows, { totals: true })
    expect(spec.columns!.map((c) => c.type)).toEqual(['date', 'text', 'currency', 'percent', 'text'])
    const wb = await loadWorkbook((await buildXlsx([spec])).buffer)
    const ws = wb.getWorksheet('Orders')!
    expect(ws.getCell('C3').value).toBe(3400.5)
    expect(ws.getCell('D3').value).toBe(0.25)
    expect(ws.getCell('E2').value).toBe('02139')
    const st = columnStats(readSheets(wb)[0])
    expect(st.rows).toBe(3)
    const amount = st.columns.find((c) => c.header === 'Amount')!
    expect(amount).toMatchObject({ type: 'currency', sum: 4675.75, min: 75.25, max: 3400.5, count: 3 })
    expect(st.columns.find((c) => c.header === 'Date')).toMatchObject({ type: 'date', min: '2026-01-02', max: '2026-01-09' })
    expect(st.columns.find((c) => c.header === 'Customer')!.top![0]).toEqual({ value: 'Acme, Inc.', count: 1 })
  })
})

describe('PowerPoint decks', () => {
  test('round trip: 16:9, layouts, native charts, notes, slide numbers, no overflow', async () => {
    const long = Array.from({ length: 14 }, (_, i) => `Point ${i + 1} explains one detail of the rollout plan that the whole team needs to know about`)
    const r = await buildPptx([
      { title: 'Q3 Review', subtitle: 'Acme · Nov 2026', layout: 'title' },
      { title: 'Revenue grew 24%', chart: { type: 'column', categories: ['Q1', 'Q2', 'Q3'], series: [{ name: '2025', values: [10, 12, 14] }, { name: '2026', values: [12, 15, 18] }], number_format: '$#,##0' }, bullets: ['Enterprise led growth'], notes: 'Mention the two big deals.' },
      { title: 'Mix', chart: { type: 'pie', categories: ['A', 'B', 'C'], series: [{ name: 'Share', values: [50, 30, 20] }] } },
      { title: 'Trend', chart: { type: 'line', categories: ['Jan', 'Feb'], series: [{ name: 'Users', values: [100, 140] }] } },
      { title: 'Rollout plan', bullets: long },
      { title: 'Before and after', layout: 'two_column', left_title: 'Before', right_title: 'After', bullets: ['Manual'], right: ['Automated'] },
      { title: 'Regions', table: [['Region', 'Revenue'], ...Array.from({ length: 28 }, (_, i) => [`Region ${i + 1}`, 1000 * i])] },
      { title: 'Key numbers', stats: [{ value: '$4.2M', label: 'ARR' }, { value: '118%', label: 'NRR' }] },
      { title: 'Simplicity is the ultimate sophistication', subtitle: 'Leonardo da Vinci', layout: 'quote' },
      { title: 'Thank you', subtitle: 'sam@acme.com', layout: 'closing' }
    ], { accent: '#2563EB', theme: 'dark' })
    expect(r.warnings.join(' ')).toMatch(/continued on/)
    const deck = await inspectPptx(r.buffer)
    expect(deck.width / deck.height).toBeCloseTo(16 / 9, 2)
    expect(deck.slides.length).toBe(r.slides)
    expect(deck.slides.length).toBeGreaterThan(10)
    expect(deck.slides.flatMap((s) => s.charts.map((c) => c.type))).toEqual(['column', 'pie', 'line'])
    expect(deck.slides[1].charts[0]).toMatchObject({ series: 2, points: 3 })
    expect(deck.slides[1].notes).toBe('Mention the two big deals.')
    expect(deck.slides[0].slideNumber).toBe(false)
    expect(deck.slides.slice(1).every((s) => s.slideNumber)).toBe(true)
    expect(deck.slides[0].background).toBeTruthy()
    const rollout = deck.slides.filter((s) => s.title?.startsWith('Rollout plan'))
    expect(rollout.length).toBeGreaterThan(1)
    expect(rollout.slice(1).every((s) => /\(cont\.\)$/.test(s.title!))).toBe(true)
    const regions = deck.slides.filter((s) => s.title?.startsWith('Regions'))
    expect(regions.length).toBeGreaterThan(1)
    expect(regions.every((s) => s.tables[0].rows[0].join() === 'Region,Revenue')).toBe(true)
    expect(regions.reduce((n, s) => n + s.tables[0].rows.length - 1, 0)).toBe(28)
    expect(deck.slides.flatMap((s) => s.shapes).filter((sh) => sh.fill > 1.05 && !/slide number/i.test(sh.name))).toEqual([])
    const review = await reviewDocument({ data: r.buffer, name: 'deck.pptx' })
    expect(review.checks.filter((c) => c.status === 'fail')).toEqual([])
  })

  test('a very long bullet is shortened on the slide and kept whole in the notes', () => {
    const big = `${'This sentence is part of a very long point. '.repeat(8)}End.`
    const [s] = planSlides([{ title: 'One', bullets: [big, 'Short'] }])
    expect(s.bullets![0].length).toBeLessThan(150)
    expect(s.notes).toContain(big.trim())
  })
})

describe('review_document', () => {
  test('catches seeded problems in Word with locations', async () => {
    const md = `# Plan

## Intro
We will recieve the files soon. The plan is TBD and [insert client name] approves it.

### Deep detail
Body.

#### Too deep
x

## Empty

## Repeat
This paragraph repeats itself word for word in two places of the document.

This paragraph repeats itself word for word in two places of the document.

## Numbers
| Region | Revenue |
|---|---|
| North | 1,250 |
| South | 900 |

## More
${'This section adds enough plain words to make the document long. '.repeat(70)}
`
    const r = await reviewDocument({ data: (await buildDocx(md, { toc: false })).buffer, name: 'plan.docx' }, { source: { rows: [['Region', 'Revenue'], ['North', 1200], ['South', 900]] } })
    const fails = r.checks.filter((c) => c.status === 'fail').map((c) => c.message)
    expect(r.pass).toBe(false)
    expect(fails.some((m) => /Long document .* without a table of contents/.test(m))).toBe(true)
    expect(fails.some((m) => /Empty section: "Empty"/.test(m))).toBe(true)
    expect(fails.some((m) => /Placeholder "TBD"/.test(m))).toBe(true)
    expect(fails.some((m) => /Placeholder "\[insert client name\]"/.test(m))).toBe(true)
    expect(fails.some((m) => /Duplicated text/.test(m))).toBe(true)
    expect(fails.some((m) => /"recieve" → "receive"/.test(m))).toBe(true)
    expect(fails.some((m) => /North \/ Revenue is 1,250 but the source says 1200/.test(m))).toBe(true)
    expect(fails.some((m) => /South/.test(m))).toBe(false)
    expect(formatReview(r)).toMatch(/^Review of plan\.docx \(Word, .*\): FAIL/)
  })

  test('heading jumps', async () => {
    const r = await reviewDocument({ data: (await buildDocx('# A\n\n## B\ntext\n\n#### D\ntext')).buffer, name: 'x.docx' })
    expect(r.checks.find((c) => /Heading jumps from H2 to H4/.test(c.message))?.status).toBe('fail')
  })

  test('catches #DIV/0!, totals that skip rows and numbers stored as text in Excel', async () => {
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Data')
    ws.addRows([['Item', 'Amount', 'Ratio'], ['a', 10, { formula: 'B2/0' }], ['b', 20, null], ['c', 30, null], ['d', '40', null], ['e', 5, null], ['Total', { formula: 'SUM(B2:B4)' }, null]])
    const r = await reviewDocument({ data: Buffer.from(await wb.xlsx.writeBuffer()), name: 'data.xlsx' })
    const fails = r.checks.filter((c) => c.status === 'fail')
    expect(fails.find((c) => /#DIV\/0!/.test(c.message))?.where).toBe('Data!C2')
    expect(fails.find((c) => /skips 1 row/.test(c.message))?.where).toBe('Data!B7')
    expect(r.checks.some((c) => c.status === 'warn' && /stored as text/.test(c.message))).toBe(true)
  })

  test('catches overflowing slide text in decks made elsewhere', async () => {
    const PptxGenJS = (await import('pptxgenjs')).default
    const p = new PptxGenJS()
    p.layout = 'LAYOUT_WIDE'
    const s = p.addSlide()
    s.addText('Crowded', { x: 0.5, y: 0.3, w: 12, h: 0.8, fontSize: 32, bold: true })
    s.addText('word '.repeat(220), { x: 0.5, y: 1.4, w: 6, h: 2, fontSize: 20 })
    p.addSlide()
    const r = await reviewDocument({ data: (await p.write({ outputType: 'nodebuffer' })) as Buffer, name: 'x.pptx' })
    const fails = r.checks.filter((c) => c.status === 'fail')
    expect(fails.find((c) => /overflows/.test(c.message))?.where).toBe('slide 1')
    expect(fails.find((c) => /Empty slide/.test(c.message))?.where).toBe('slide 2')
  })
})
