import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { trashItem: async () => undefined }, BrowserWindow: class {} }))

const { applyPlan, formatPlan, planBatch } = await import('../../src/main/docs/batch')
const { extractFromTranscript, resolveDue, baseDate } = await import('../../src/main/docs/meetings')
const { pdfExtract, pdfFields, pdfFill, pdfMerge, pdfPageNumbers, pdfRotate, pdfSplit, pdfStamp, textToPdf, pdfInfo } = await import('../../src/main/docs/pdf')
const { parseReceipt } = await import('../../src/main/docs/receipts')
const { inspectDocx } = await import('../../src/main/docs/inspect')
const { loadWorkbook, readSheets } = await import('../../src/main/docs/xlsx')
const { officeEffect, officeTool, personalValues, reviewDocumentTool } = await import('../../src/main/agent/tools/office')
const { fileTools } = await import('../../src/main/agent/tools/files')

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'office-')))
const ctxFor = (ws: string, roots: string[] = []) => ({ state: { roots, loaded: [], alwaysAllow: [], todos: [] }, workspaceDir: ws, signal: new AbortController().signal }) as never

async function formPdf(): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('Vendor application', { x: 50, y: 740, size: 18, font })
  const form = doc.getForm()
  const name = form.createTextField('company_name')
  name.addToPage(page, { x: 50, y: 680, width: 300, height: 22 })
  name.enableRequired()
  form.createTextField('notes').addToPage(page, { x: 50, y: 640, width: 300, height: 22 })
  form.createCheckBox('agree_terms').addToPage(page, { x: 50, y: 600, width: 14, height: 14 })
  const size = form.createDropdown('company_size')
  size.addOptions(['1-10', '11-50', '51+'])
  size.addToPage(page, { x: 50, y: 560, width: 120, height: 22 })
  const pay = form.createRadioGroup('payment')
  pay.addOptionToPage('ACH', page, { x: 50, y: 520, width: 14, height: 14 })
  pay.addOptionToPage('Check', page, { x: 90, y: 520, width: 14, height: 14 })
  return Buffer.from(await doc.save())
}

async function pagesPdf(n: number): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= n; i++) doc.addPage([612, 792]).drawText(`Body of page ${i}`, { x: 50, y: 700, size: 14, font })
  return Buffer.from(await doc.save())
}

async function pdfWords(buf: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise
  const out: string[] = []
  for (let i = 1; i <= doc.numPages; i++) out.push(((await (await doc.getPage(i)).getTextContent()).items as Array<{ str?: string }>).map((x) => x.str ?? '').join(' '))
  return out.join('\n')
}

describe('PDF forms and pages', () => {
  test('lists fields, fills a generated form, flattens it', async () => {
    const data = await formPdf()
    const fields = await pdfFields(data)
    expect(fields.map((f) => `${f.name}:${f.type}`)).toEqual(['company_name:text', 'notes:text', 'agree_terms:checkbox', 'company_size:dropdown', 'payment:radio'])
    expect(fields[0]).toMatchObject({ required: true, page: 1, value: null })
    expect(fields[3].options).toEqual(['1-10', '11-50', '51+'])

    const r = await pdfFill(data, { 'Company Name': 'Acme Tools', agree_terms: 'yes', company_size: '11-50', payment: 'check', nickname: 'x' })
    expect(r.filled).toEqual(['company_name', 'agree_terms', 'company_size', 'payment'])
    expect(r.unknown.map((u) => u.name)).toEqual(['nickname'])
    expect(r.missingRequired).toEqual([])
    const after = await pdfFields(r.buffer)
    expect(after.find((f) => f.name === 'company_name')?.value).toBe('Acme Tools')
    expect(after.find((f) => f.name === 'agree_terms')?.value).toBe(true)
    expect(after.find((f) => f.name === 'payment')?.value).toBe('Check')

    const flat = await pdfFill(data, { company_name: 'Acme Tools' }, { flatten: true })
    expect(await pdfFields(flat.buffer)).toEqual([])
    expect(await pdfWords(flat.buffer)).toContain('Acme Tools')
  })

  test('merge, split, extract, rotate, stamp and number pages', async () => {
    const a = await pagesPdf(3), b = await pagesPdf(2)
    const merged = await pdfMerge([a, b])
    expect(merged.pages).toBe(5)
    const parts = await pdfSplit(merged.buffer, { ranges: ['1-2', '3-'] })
    expect(parts.map((p) => p.pages)).toEqual([[1, 2], [3, 4, 5]])
    expect((await pdfSplit(a, { each: true })).length).toBe(3)
    const ex = await pdfExtract(merged.buffer, '2,last')
    expect(ex.pages).toEqual([2, 5])
    expect((await pdfInfo(ex.buffer)).pages).toBe(2)
    const rot = await pdfRotate(a, 90, '2')
    expect((await pdfInfo(rot.buffer)).sizes.map((s) => s.rotation)).toEqual([0, 90, 0])
    const stamped = await pdfStamp(a, { text: 'DRAFT', position: 'diagonal' })
    expect(stamped.stamped).toEqual([1, 2, 3])
    const numbered = await pdfPageNumbers(stamped.buffer)
    const text = await pdfWords(numbered.buffer)
    expect(text).toContain('DRAFT')
    expect(text).toContain('Page 2 of 3')
    await expect(pdfExtract(a, '7')).rejects.toThrow(/outside 1-3/)
  })
})

describe('batch file jobs', () => {
  const folder = () => {
    const d = tmp()
    for (const f of ['IMG_0002.jpg', 'IMG_0001.jpg', 'notes.txt', 'Budget.xlsx', 'deck.pptx', 'report.pdf', 'data.csv']) writeFileSync(join(d, f), f.endsWith('.csv') ? 'Name,Amount\nA,$10.00\nB,$5.50\n' : `x-${f}`)
    writeFileSync(join(d, 'Trip 1.jpg'), 'exists')
    return d
  }

  test('rename: a dry run changes nothing; apply follows the plan; clashes get a suffix', async () => {
    const d = folder()
    const before = readdirSync(d).sort()
    const plan = planBatch({ dir: d, op: 'rename', match: '*.jpg', pattern: 'Trip {n}', start: 1 })
    expect(readdirSync(d).sort()).toEqual(before)
    expect(plan.items.map((i) => [i.from.split('/').pop(), i.to.split('/').pop()])).toEqual([['IMG_0001.jpg', 'Trip 1 (2).jpg'], ['IMG_0002.jpg', 'Trip 2.jpg'], ['Trip 1.jpg', 'Trip 3.jpg']])
    expect(formatPlan(plan)).toMatch(/Nothing has changed yet[\s\S]*plan_id/)
    const r = await applyPlan(plan)
    expect(r.failed).toEqual([])
    expect(readdirSync(d).filter((f) => f.endsWith('.jpg')).sort()).toEqual(['Trip 1 (2).jpg', 'Trip 2.jpg', 'Trip 3.jpg'])
    expect(readFileSync(join(d, 'Trip 3.jpg'), 'utf8')).toBe('exists')
    expect(readdirSync(d).length).toBe(before.length)
  })

  test('sort by type, archive instead of delete, convert csv to xlsx, case change', async () => {
    const d = folder()
    const total = readdirSync(d).length
    const sort = planBatch({ dir: d, op: 'sort', by: 'type' })
    await applyPlan(sort)
    expect(readdirSync(join(d, 'Images')).sort()).toEqual(['IMG_0001.jpg', 'IMG_0002.jpg', 'Trip 1.jpg'])
    expect(readdirSync(join(d, 'Spreadsheets')).sort()).toEqual(['Budget.xlsx', 'data.csv'])
    expect(readdirSync(join(d, 'PDFs'))).toEqual(['report.pdf'])

    const sheets = join(d, 'Spreadsheets')
    const conv = planBatch({ dir: sheets, op: 'convert', match: '*.csv', to: 'xlsx', archive_originals: true })
    expect(conv.items.map((i) => i.kind)).toEqual(['convert', 'archive'])
    const r = await applyPlan(conv)
    expect(r.failed).toEqual([])
    expect(existsSync(join(sheets, 'Archive', 'data.csv'))).toBe(true)
    const wb = readSheets(await loadWorkbook(readFileSync(join(sheets, 'data.xlsx'))))
    expect(wb[0].cells.find((c) => c.addr === 'B2')?.value).toBe(10)

    const skip = planBatch({ dir: d, op: 'convert', match: '*.pptx', to: 'xlsx', recursive: true })
    expect(skip.items).toEqual([])
    expect(skip.skipped[0].why).toMatch(/isn't supported/)

    const arch = planBatch({ dir: join(d, 'Documents'), op: 'archive' })
    await applyPlan(arch)
    expect(readdirSync(join(d, 'Documents', 'Archive'))).toEqual(['notes.txt'])

    const lower = planBatch({ dir: join(d, 'Spreadsheets'), op: 'rename', match: 'Budget.xlsx', case: 'lower' })
    await applyPlan(lower)
    expect(readdirSync(join(d, 'Spreadsheets'))).toContain('budget.xlsx')

    const count = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(join(dir, e.name)) : 1), 0)
    expect(count(d)).toBe(total + 1) // the new .xlsx; nothing was deleted
  })

  test('apply refuses files changed since the plan', async () => {
    const d = folder()
    const plan = planBatch({ dir: d, op: 'rename', match: 'notes.txt', pattern: 'Notes final' })
    writeFileSync(join(d, 'notes.txt'), 'changed!')
    const { utimesSync } = await import('node:fs')
    utimesSync(join(d, 'notes.txt'), new Date(), new Date(Date.now() + 5000))
    const r = await applyPlan(plan)
    expect(r.failed[0].error).toMatch(/changed since/)
    expect(existsSync(join(d, 'notes.txt'))).toBe(true)
  })
})

describe('receipts', () => {
  test('parses vendor, date, amounts, category and flags inconsistencies', () => {
    const r = parseReceipt('Blue Bottle Coffee\n123 Market St, San Francisco\nDate: 11/03/2026 08:14\nLatte 5.50\nCroissant 4.25\nSubtotal $9.75\nSales Tax $0.85\nTip $2.00\nTotal $12.60\nVISA ****1234\nReceipt #A-20931', 'coffee.pdf')
    expect(r).toMatchObject({ vendor: 'Blue Bottle Coffee', date: '2026-11-03', subtotal: 9.75, tax: 0.85, tip: 2, total: 12.6, currency: 'USD', number: 'A-20931', category: 'Meals', status: 'ok' })
    const bad = parseReceipt('INVOICE\nAcme Hosting LLC\nInvoice number INV-7781\nNov 1, 2026\nSubtotal 100.00\nTax 8.00\nTotal 120.00', 'host.pdf')
    expect(bad.vendor).toBe('Acme Hosting LLC')
    expect(bad.date).toBe('2026-11-01')
    expect(bad.status).toBe('check')
    expect(bad.notes!.join()).toMatch(/≠ total/)
  })
})

describe('meeting notes', () => {
  test('due dates resolve against the meeting date', () => {
    const base = baseDate('2026-11-11') // a Wednesday
    expect(resolveDue('Friday', base)).toBe('2026-11-13')
    expect(resolveDue('next Friday', base)).toBe('2026-11-20')
    expect(resolveDue('tomorrow', base)).toBe('2026-11-12')
    expect(resolveDue('end of the month', base)).toBe('2026-11-30')
    expect(resolveDue('next week', base)).toBe('2026-11-16')
    expect(resolveDue('11/20', base)).toBe('2026-11-20')
    expect(resolveDue('Jan 5', base)).toBe('2027-01-05')
    expect(resolveDue('soonish', base)).toBeUndefined()
  })

  test('extracts decisions, owners, due dates and questions from a transcript', () => {
    const t = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
<v Priya Shah>We decided to launch on December 1.

2
00:00:05.000 --> 00:00:09.000
<v Marco>I'll send the updated deck by Friday.
Action item: book the venue @Dana
Priya Shah: Marco, can you share the budget sheet?
Dana: Should we invite the press?`
    const x = extractFromTranscript(t, '2026-11-11')
    expect(x.speakers).toEqual(['Priya Shah', 'Marco', 'Dana'])
    expect(x.decisions).toEqual(['We decided to launch on December 1'])
    expect(x.actions).toEqual([
      { task: 'Send the updated deck', owner: 'Marco', due: 'Friday', due_date: '2026-11-13' },
      { task: 'Book the venue', owner: 'Dana' },
      { task: 'Share the budget sheet', owner: 'Marco' }
    ])
    expect(x.questions).toEqual(['Should we invite the press?'])
  })
})

describe('office tool', () => {
  test('effects and personal-data hard stop', () => {
    expect(officeEffect({ action: 'sheet_read', path: 'a.xlsx' })).toBe('read')
    expect(officeEffect({ action: 'batch', dir: 'x', op: 'rename' })).toBe('read')
    expect(officeEffect({ action: 'batch', plan_id: 'abc' })).toBe('destructive')
    expect(officeEffect({ action: 'sheet_write', path: 'a.xlsx' })).toBe('write_local')
    expect(personalValues({ company_size: '11-50', notes: 'ok' })).toEqual([])
    expect(personalValues({ applicant_name: 'Ann Lee', contactEmail: 'a@b.co', x: '123-45-6789' })).toEqual(['applicant_name', 'contactEmail', 'x'])
    const tool = officeTool({ getWorkspace: () => '/tmp' })
    expect(tool.hardStop!({ action: 'pdf_fill', path: 'f.pdf', values: { full_name: 'Ann' } })).toMatch(/personal details \(full_name\)/)
    expect(tool.hardStop!({ action: 'pdf_fill', path: 'f.pdf', values: { company_size: '51+' } })).toBeNull()
  })

  test('sheet_write edits in place with a backup; sheet_read shows values and formulas', async () => {
    const ws = tmp()
    const files = fileTools(() => ws, ws)
    const create = files.find((t) => t.name === 'create_document')!
    const made = await create.run({ path: 'budget.xlsx', sheets: [{ name: 'Budget', columns: [{ header: 'Item' }, { header: 'Cost', type: 'currency' }], rows: [['Rent', 1000], ['Food', 400]], totals: true }] }, ctxFor(ws))
    expect(made.text).toMatch(/Created XLSX .*budget\.xlsx[\s\S]*Review of budget\.xlsx .*: PASS/)
    const office = officeTool({ getWorkspace: () => ws })
    const w = await office.run({ action: 'sheet_write', path: 'budget.xlsx', edits: [{ sheet: 'Budget', append: [['Gym', 50]] }, { cell: 'Budget!B3', value: 450 }] }, ctxFor(ws))
    expect(w.text).toMatch(/Updated .*budget\.xlsx .*backed up[\s\S]*Budget!B3: 400 → 450/)
    expect(readdirSync(join(ws, '.foreman', 'backups')).some((f) => f.endsWith('budget.xlsx'))).toBe(true)
    const r = await office.run({ action: 'sheet_read', path: 'budget.xlsx', range: 'A4:B5' }, ctxFor(ws))
    expect(r.text).toContain('A4="Gym" | B4="50"')
    expect(r.text).toContain('B5="1500" (=SUM(B2:B4))')
    const sum = await office.run({ action: 'sheet_summarize', path: 'budget.xlsx' }, ctxFor(ws))
    expect(sum.text).toMatch(/B "Cost" \[currency\]: 3 values.*sum 1500/)
  })

  test('sheet_write on a sheet of the user\'s they didn\'t ask to change edits "Budget (2).xlsx"; asked, it edits in place', async () => {
    const ws = tmp()
    const create = fileTools(() => ws, ws).find((t) => t.name === 'create_document')!
    // Made outside any chat (the user's own file).
    await create.run({ path: 'Budget.xlsx', sheets: [{ name: 'Budget', rows: [['Item', 'Cost'], ['Rent', 1000]] }] }, ctxFor(ws))
    const before = readFileSync(join(ws, 'Budget.xlsx'))
    let said = 'Make me a summary of my spending'
    const office = officeTool({ getWorkspace: () => ws, userText: () => said })
    const ctx = { ...(ctxFor(ws) as object), threadId: 't-sheet-copy' } as never
    const w = await office.run({ action: 'sheet_write', path: 'Budget.xlsx', edits: [{ cell: 'Budget!B2', value: 1200 }] }, ctx)
    expect(readFileSync(join(ws, 'Budget.xlsx')).equals(before)).toBe(true)
    expect(w.path).toBe(join(ws, 'Budget (2).xlsx'))
    expect(w.text).toMatch(/Budget\.xlsx is the user's.*Budget \(2\)\.xlsx/)
    // A second edit lands on the same copy.
    await office.run({ action: 'sheet_write', path: 'Budget.xlsx', edits: [{ cell: 'Budget!A3', value: 'Food' }] }, ctx)
    const copy = await office.run({ action: 'sheet_read', path: 'Budget (2).xlsx' }, ctx)
    expect(copy.text).toContain('1200')
    expect(copy.text).toContain('Food')
    expect(existsSync(join(ws, 'Budget (3).xlsx'))).toBe(false)
    said = 'Update Budget.xlsx: rent is now 1300'
    const ctx2 = { ...(ctxFor(ws) as object), threadId: 't-sheet-asked' } as never
    const asked = await office.run({ action: 'sheet_write', path: 'Budget.xlsx', edits: [{ cell: 'Budget!B2', value: 1300 }] }, ctx2)
    expect(asked.path).toBe(join(ws, 'Budget.xlsx'))
    expect(readFileSync(join(ws, 'Budget.xlsx')).equals(before)).toBe(false)
  })

  test('csv_to_xlsx, pdf_fill to a new file, batch preview then apply, receipts and meeting notes', async () => {
    const ws = tmp()
    const office = officeTool({ getWorkspace: () => ws })
    writeFileSync(join(ws, 'orders.csv'), 'Date,Amount\n2026-01-01,$5.00\n2026-01-02,$7.25\n')
    const c = await office.run({ action: 'csv_to_xlsx', path: 'orders.csv', totals: true }, ctxFor(ws))
    expect(c.text).toMatch(/2 rows; columns Date \(date\), Amount \(currency\)/)

    writeFileSync(join(ws, 'form.pdf'), await formPdf())
    const f = await office.run({ action: 'pdf_fill', path: 'form.pdf', values: { company_name: 'Acme', company_size: '51+' } }, ctxFor(ws))
    expect(f.path).toBe(join(ws, 'form (filled).pdf'))
    expect((await pdfFields(readFileSync(join(ws, 'form.pdf'))))[0].value).toBeNull()

    mkdirSync(join(ws, 'inbox'))
    writeFileSync(join(ws, 'inbox', 'a.pdf'), await textToPdf('Corner Cafe\nDate: 2026-11-02\nSubtotal $10.00\nTax $1.00\nTotal $11.00'))
    writeFileSync(join(ws, 'inbox', 'b.pdf'), await textToPdf('Uber Technologies\nNov 4, 2026\nTrip fare 22.10\nTotal $24.50'))
    writeFileSync(join(ws, 'inbox', 'c.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'))
    const rc = await office.run({ action: 'receipts_to_sheet', dir: 'inbox', rows: [{ file: 'c.png', vendor: 'Staples', date: '2026-11-05', total: 15 }] }, ctxFor(ws))
    expect(rc.text).toMatch(/3 receipt\(s\), total 50\.50/)
    expect(rc.text).toMatch(/b\.pdf: Uber Technologies · 2026-11-04 · 24\.50 USD · Travel/)
    const sheet = readSheets(await loadWorkbook(readFileSync(rc.path!)))
    expect(sheet.map((s) => s.name)).toEqual(['Receipts', 'By category'])
    expect(sheet[1].cells.find((c) => c.formula?.startsWith('=SUMIF') && c.value === 24.5)).toBeTruthy()

    const plan = await office.run({ action: 'batch', dir: 'inbox', op: 'rename', match: '*.pdf', pattern: 'Receipt {n}' }, ctxFor(ws))
    const id = /plan_id "(\w+)"/.exec(plan.text)![1]
    expect(readdirSync(join(ws, 'inbox')).sort()).toEqual(['Receipts.xlsx', 'a.pdf', 'b.pdf', 'c.png'])
    const applied = await office.run({ action: 'batch', plan_id: id }, ctxFor(ws))
    expect(applied.text).toMatch(/2 done/)
    expect(readdirSync(join(ws, 'inbox')).sort()).toEqual(['Receipt 1.pdf', 'Receipt 2.pdf', 'Receipts.xlsx', 'c.png'])
    await expect(office.run({ action: 'batch', plan_id: id }, ctxFor(ws))).rejects.toThrow(/No batch plan/)

    const m = await office.run({
      action: 'meeting_notes',
      transcript: 'Ann: We agreed to move the launch to March.\nBo: I will update the roadmap by Friday.\nAnn: Cy will email the partners tomorrow.',
      meeting: { title: 'Launch sync', date: '2026-11-11', summary: 'We moved the launch and split the follow-ups.', actions: [{ task: 'Update the roadmap', owner: 'Bo', due: 'Friday' }] }
    }, ctxFor(ws))
    expect(m.text).toMatch(/1 decision\(s\), 1 action item\(s\)/)
    expect(m.text).toMatch(/Update the roadmap — Bo, due 2026-11-13/)
    expect(m.text).toMatch(/Possibly missed[\s\S]*Email the partners \(Cy\), tomorrow/)
    expect(m.text).toMatch(/Review of Launch sync\.docx .*: PASS/)
    const d = await inspectDocx(readFileSync(m.path!))
    expect(d.title).toBe('Launch sync')
    expect(d.headings.map((h) => h.text)).toEqual(['Summary', 'Decisions', 'Action items'])
    expect(d.tables[1].rows[1]).toEqual(['1', 'Update the roadmap', 'Bo', 'Fri, Nov 13, 2026', 'Open'])
  })

  test('review_document tool', async () => {
    const ws = tmp()
    const files = fileTools(() => ws, ws)
    await files.find((t) => t.name === 'create_document')!.run({ path: 'deck.pptx', slides: [{ title: 'Hello', layout: 'title' }, { title: 'Plan', bullets: ['One', 'Two'] }] }, ctxFor(ws))
    const tool = reviewDocumentTool({ getWorkspace: () => ws })
    expect(tool.core).toBe(true)
    expect((await tool.run({ path: 'deck.pptx' }, ctxFor(ws))).text).toMatch(/^Review of deck\.pptx \(PowerPoint, 2 slides.*PASS/)
  })
})
