import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import type { DocBlock, DocContent } from '@shared/types'
import { blocksToMarkdown, markdownToBlocks, stripIdMarkers } from '../../src/main/docspace/markdown'
import { escapeInline, inlinePlain, inlineToHtml } from '../../src/main/docspace/inline'
import { applyOps, opTargets, sectionIds } from '../../src/main/docspace/ops'
import { evaluateSheet, expandRange, literal, showValue } from '../../src/main/docspace/sheet'
import { diffContent, diffView, summarize, wordDiff } from '../../src/main/docspace/diff'
import { merge3 } from '../../src/main/docspace/merge'
import { DocConflictError, DocStore, normalizeContent } from '../../src/main/docspace/store'
import { exportDoc, exportHtml, exportMarkdown, type CreateDocumentFn } from '../../src/main/docspace/export'
import { readView } from '../../src/main/docspace/view'
import { docTools, sheetFromMarkdown } from '../../src/main/agent/tools/docspace'
import { emptyState, type ToolContext } from '../../src/main/agent/types'

const strip = (bs: DocBlock[]): Array<Omit<DocBlock, 'id'>> => bs.map(({ id: _id, ...rest }) => rest)
const ids = (bs: DocBlock[]): string[] => bs.map((b) => b.id)

const SAMPLE = `# Trip plan

A **long** weekend in *Paris*, with \`code\` and a [link](https://example.com).

## Packing

- Passport
- Chargers
   - USB-C cable
- [ ] Book hotel
- [x] Buy tickets

1. Fly out
2. Check in

> A quote
> on two lines

> [!WARNING]
> Watch the weather

\`\`\`js
const x = 1
\`\`\`

| Day | City |
| --- | --- |
| 1 | Paris |
| 2 | Lyon \\| Annecy |

---

![Map](/tmp/map.png)

Line one\\
line two`

describe('markdown ⇄ blocks', () => {
  test('parses every block type with nesting, checklists, callouts and tables', () => {
    const bs = markdownToBlocks(SAMPLE)
    expect(bs.map((b) => b.type)).toEqual(['h1', 'p', 'h2', 'bullet', 'bullet', 'bullet', 'check', 'check', 'numbered', 'numbered', 'quote', 'callout', 'code', 'table', 'divider', 'image', 'p'])
    expect(bs[5]).toMatchObject({ text: 'USB-C cable', indent: 1 })
    expect(bs[6]).toMatchObject({ checked: false, text: 'Book hotel' })
    expect(bs[7]).toMatchObject({ checked: true })
    expect(bs[10].text).toBe('A quote\non two lines')
    expect(bs[11]).toMatchObject({ tone: 'warn', text: 'Watch the weather' })
    expect(bs[12]).toMatchObject({ lang: 'js', text: 'const x = 1' })
    expect(bs[13].rows).toEqual([['Day', 'City'], ['1', 'Paris'], ['2', 'Lyon | Annecy']])
    expect(bs[15]).toMatchObject({ src: '/tmp/map.png', alt: 'Map' })
    expect(bs[16].text).toBe('Line one\nline two')
    expect(new Set(ids(bs)).size).toBe(bs.length)
  })

  test('round trips: blocks → markdown → blocks is lossless', () => {
    const bs = markdownToBlocks(SAMPLE)
    const again = markdownToBlocks(blocksToMarkdown(bs))
    expect(strip(again)).toEqual(strip(bs))
    // Text that looks like block syntax is escaped and survives.
    const tricky: DocBlock[] = [
      { id: 'b001', type: 'p', text: '1. not a list' },
      { id: 'b002', type: 'p', text: '# not a heading\n- nor a bullet' },
      { id: 'b003', type: 'bullet', text: 'item\n- still the item', indent: 2 },
      { id: 'b004', type: 'p', text: '---' },
      { id: 'b005', type: 'numbered', text: 'one' },
      { id: 'b006', type: 'p', text: 'C:\\\\path' }
    ]
    expect(strip(markdownToBlocks(blocksToMarkdown(tricky)))).toEqual(strip(tricky))
  })

  test('[id] markers: written for doc_read, kept with keepIds, stripped from model input', () => {
    const bs = markdownToBlocks('# A\n\nB')
    const md = blocksToMarkdown(bs, { ids: true })
    expect(md).toBe(`[${bs[0].id}] # A\n\n[${bs[1].id}] B`)
    expect(ids(markdownToBlocks(md, { keepIds: true }))).toEqual(ids(bs))
    expect(stripIdMarkers(md)).toBe('# A\n\nB')
  })

  test('inline markdown renders safely', () => {
    expect(inlineToHtml('**b** *i* `c<>` ~~s~~ [x](https://a.b)')).toBe('<strong>b</strong> <em>i</em> <code>c&lt;&gt;</code> <s>s</s> <a href="https://a.b">x</a>')
    expect(inlineToHtml('[bad](javascript:alert(1))')).toBe('bad')
    expect(inlineToHtml('<img src=x onerror=1>')).toBe('&lt;img src=x onerror=1&gt;')
    expect(inlineToHtml('snake_case_name and 5 * 3')).toBe('snake_case_name and 5 * 3')
    expect(inlinePlain(escapeInline('a*b*_c_'))).toBe('a*b*_c_')
  })
})

const doc = (md: string): DocContent => ({ title: 'T', blocks: markdownToBlocks(md) })

describe('doc_edit ops', () => {
  const base = doc('# Plan\n\nIntro text\n\n## Day 1\n\nParis\n\nLouvre\n\n## Day 2\n\nLyon\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- [ ] pack')
  const [h1, intro, d1, paris, louvre, d2, lyon, table, check] = ids(base.blocks)

  test('insert after / at start / at end, replace keeps the id', () => {
    const r = applyOps(base, [
      { op: 'insert', after: intro, markdown: 'New para\n\nSecond new' },
      { op: 'insert', at: 'start', markdown: 'Top' },
      { op: 'insert', markdown: 'Bottom' },
      { op: 'replace', id: paris, markdown: '**Paris** and Versailles' }
    ])
    const t = r.content.blocks.map((b) => b.text)
    expect(t[0]).toBe('Top')
    expect(t.slice(2, 5)).toEqual(['Intro text', 'New para', 'Second new'])
    expect(t[t.length - 1]).toBe('Bottom')
    expect(r.content.blocks.find((b) => b.id === paris)?.text).toBe('**Paris** and Versailles')
    expect(r.added).toHaveLength(4)
    expect(base.blocks).toHaveLength(9) // the input is untouched
  })

  test('replace_text: exact match, count check, block scope, all', () => {
    const d = doc('apple pie\n\napple tart\n\npear')
    expect(() => applyOps(d, [{ op: 'replace_text', find: 'apple', replace: 'plum' }])).toThrow(/appears 2 times/)
    expect(() => applyOps(d, [{ op: 'replace_text', find: 'apple', replace: 'plum', count: 3 }])).toThrow(/expected 3 matches .* found 2/)
    expect(() => applyOps(d, [{ op: 'replace_text', find: 'kiwi', replace: 'x' }])).toThrow(/not found/)
    expect(applyOps(d, [{ op: 'replace_text', find: 'apple', replace: 'plum', count: 2 }]).content.blocks.map((b) => b.text)).toEqual(['plum pie', 'plum tart', 'pear'])
    expect(applyOps(d, [{ op: 'replace_text', find: 'apple', replace: 'plum', id: d.blocks[1].id }]).content.blocks[1].text).toBe('plum tart')
    expect(applyOps(d, [{ op: 'replace_text', find: 'apple', replace: '', all: true }]).content.blocks[0].text).toBe(' pie')
  })

  test('delete blocks and whole sections', () => {
    expect(sectionIds(base.blocks, d1)).toEqual([d1, paris, louvre])
    expect(sectionIds(base.blocks, h1)).toEqual(ids(base.blocks))
    const r = applyOps(base, [{ op: 'delete', section: d1 }, { op: 'delete', ids: [intro] }])
    expect(ids(r.content.blocks)).toEqual([h1, d2, lyon, table, check])
    expect(() => applyOps(base, [{ op: 'delete', section: paris }])).toThrow(/not a heading/)
  })

  test('move, set_title, set_checked', () => {
    const r = applyOps(base, [{ op: 'move', ids: [lyon], after: d1 }, { op: 'set_title', title: '  New   title ' }, { op: 'set_checked', id: check, checked: true }])
    expect(ids(r.content.blocks).slice(2, 5)).toEqual([d1, lyon, paris])
    expect(r.content.title).toBe('New title')
    expect(r.content.blocks.find((b) => b.id === check)?.checked).toBe(true)
    expect(() => applyOps(base, [{ op: 'move', ids: [lyon], after: lyon }])).toThrow(/being moved/)
  })

  test('table ops', () => {
    const r = applyOps(base, [
      { op: 'table_add_row', id: table, values: ['3', '4'] },
      { op: 'table_add_col', id: table, col: 2, values: ['Mid', 'x', 'y'] },
      { op: 'table_set_cell', id: table, row: 2, col: 3, text: 'two' },
      { op: 'table_delete_row', id: table, row: 3 }
    ])
    expect(r.content.blocks.find((b) => b.id === table)?.rows).toEqual([['A', 'Mid', 'B'], ['1', 'x', 'two']])
    expect(() => applyOps(base, [{ op: 'table_set_cell', id: table, row: 9, col: 1, text: '' }])).toThrow(/outside the table/)
    expect(() => applyOps(base, [{ op: 'table_add_row', id: paris }])).toThrow(/not a table/)
  })

  test('a batch is atomic: one bad op applies nothing and names the op', () => {
    expect(() => applyOps(base, [{ op: 'replace', id: paris, markdown: 'ok' }, { op: 'replace', id: 'bzzz', markdown: 'x' }])).toThrow(/^Op 2 \(replace\): no block \[bzzz\].*Nothing was applied/)
    expect(base.blocks.find((b) => b.id === paris)?.text).toBe('Paris')
  })

  test('sheet ops only on sheets, block ops only on documents', () => {
    expect(() => applyOps(base, [{ op: 'set_cells', cells: { A1: 1 } }])).toThrow(/not a sheet/)
    const sheet: DocContent = { title: 'S', blocks: [], sheet: { rows: 2, cols: 2, cells: {} } }
    expect(() => applyOps(sheet, [{ op: 'insert', markdown: 'x' }], { type: 'sheet' })).toThrow(/is a sheet/)
    const r = applyOps(sheet, [{ op: 'set_range', start: 'B2', rows: [[1, 2], [3, '=B2+C2']] }, { op: 'set_cells', cells: { A1: 'Total', b2: 10 } }, { op: 'clear_range', range: 'C3:C3' }], { type: 'sheet' })
    expect(r.content.sheet?.cells).toEqual({ A1: 'Total', B2: '10', C2: '2', B3: '3' })
    expect(r.content.sheet?.rows).toBe(3)
    expect(opTargets({ op: 'set_range', start: 'A1', rows: [[1, 2]] }, sheet, sheet)).toEqual(['cell:A1', 'cell:B1'])
  })
})

describe('sheet formulas', () => {
  test('arithmetic, refs, ranges and functions', () => {
    const v = evaluateSheet({
      A1: '10', A2: '20', A3: '30', A4: 'text', A5: '',
      B1: '=A1+A2*2', B2: '=(A1+A2)*2', B3: '=-A1^2', B4: '=SUM(A1:A5)', B5: '=AVERAGE(A1:A3)',
      B6: '=MIN(A1:A3, 5)', B7: '=max(A1:A3)', B8: '=COUNT(A1:A5)', B9: '=$A$1/4', B10: '=SUM(A1, 2.5, B9)', B11: '=12%*100'
    })
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => v[`B${n}`].value)).toEqual([50, 60, 100, 60, 20, 5, 30, 3, 2.5, 15, 12])
    expect(literal('1,200')).toBe(1200)
    expect(literal('$5')).toBe(5)
    expect(literal('12%')).toBe(0.12)
    expect(literal('hello')).toBe('hello')
    expect(showValue({ value: 0.1 + 0.2 })).toBe('0.3')
    expect(expandRange('A1:B2')).toEqual(['A1', 'B1', 'A2', 'B2'])
  })

  test('errors: divide by zero, bad refs, unknown functions, text in arithmetic, and they propagate', () => {
    const v = evaluateSheet({ A1: '0', A2: 'x', B1: '=5/A1', B2: '=A2+1', B3: '=FOO(1)', B4: '=1+', B5: '=B1*2', B6: '=AVERAGE(A2:A2)', B7: '=SUM(B1:B2)' })
    expect(v.B1.error).toBe('#DIV/0!')
    expect(v.B2.error).toBe('#VALUE!')
    expect(v.B3.error).toBe('#NAME?')
    expect(v.B4.error).toBe('#ERROR!')
    expect(v.B5.error).toBe('#DIV/0!')
    expect(v.B6.error).toBe('#DIV/0!')
    expect(v.B7.error).toBe('#DIV/0!')
  })

  test('cycles are #CYCLE!, including self references and cells that read them; others still compute', () => {
    const v = evaluateSheet({ A1: '=B1+1', B1: '=C1', C1: '=A1', D1: '=D1', E1: '=A1*2', F1: '=2+3' })
    for (const a of ['A1', 'B1', 'C1', 'D1', 'E1']) expect(v[a].error).toBe('#CYCLE!')
    expect(v.F1.value).toBe(5)
  })

  test('markdown tables and CSV become sheets', () => {
    const s = sheetFromMarkdown('| Item | Cost |\n| --- | --- |\n| Hotel | 300 |\n| Food | 150 |\n| Total | =SUM(B2:B3) |')
    expect(s.cells).toMatchObject({ A1: 'Item', B4: '=SUM(B2:B3)' })
    expect(evaluateSheet(s.cells).B4.value).toBe(450)
    expect(sheetFromMarkdown('a,b\n1,"2,5"').cells).toEqual({ A1: 'a', B1: 'b', A2: '1', B2: '2,5' })
  })
})

describe('diff and merge', () => {
  test('diffContent and summaries', () => {
    const a = doc('One\n\nTwo\n\nThree')
    const b: DocContent = { ...a, title: 'New', blocks: [a.blocks[2], { ...a.blocks[0], text: 'One!' }, { id: 'bnew', type: 'p', text: 'Four' }] }
    const d = diffContent(a, b)
    expect(d).toMatchObject({ added: ['bnew'], removed: [a.blocks[1].id], changed: [a.blocks[0].id], title: true })
    expect(summarize(a, b, d)).toBe('Renamed to "New", edited "One!", added "Four", removed "Two"')
    expect(wordDiff('the quick fox', 'the slow fox')).toEqual([{ t: 'same', s: 'the ' }, { t: 'add', s: 'slow' }, { t: 'del', s: 'quick' }, { t: 'same', s: ' fox' }])
    const view = diffView(a, b, 1, 2)
    expect(view.rows.map((r) => r.status)).toEqual(['same', 'changed', 'removed', 'added'])
    expect(view.rows.find((r) => r.status === 'removed')?.block.text).toBe('Two')
    expect(view.title).toEqual({ before: 'T', after: 'New' })
  })

  test('merge3: both sides keep their changes; mine wins where both changed one block', () => {
    const base = doc('A\n\nB\n\nC')
    const [a, b, c] = base.blocks
    const theirs: DocContent = { ...base, blocks: [{ ...a, text: 'A (bot)' }, b, { ...c, text: 'C (bot)' }, { id: 'bbot', type: 'p', text: 'bot added' }] }
    const mine: DocContent = { ...base, title: 'Mine', blocks: [a, { ...b, text: 'B (me)' }, { ...c, text: 'C (me)' }] }
    const m = merge3(base, theirs, mine)
    expect(m.blocks.map((x) => x.text)).toEqual(['A (bot)', 'B (me)', 'C (me)', 'bot added'])
    expect(m.title).toBe('Mine')
    // A block I deleted stays deleted unless they changed it.
    const m2 = merge3(base, { ...base, blocks: [a, b, { ...c, text: 'C!' }] }, { ...base, blocks: [a] })
    expect(m2.blocks.map((x) => x.text)).toEqual(['A', 'C!'])
  })
})

function store(): DocStore {
  const sql = new DatabaseSync(':memory:')
  sql.exec('PRAGMA foreign_keys = ON')
  let t = 1_000_000
  return new DocStore(sql, () => (t += 1000))
}

describe('DocStore: versions, conflicts, restore', () => {
  test('every change is a version with author and summary; restore makes a new version', () => {
    const s = store()
    const events: string[] = []
    s.onChange((e) => events.push(`${e.author}:${e.version}`))
    const d = s.create({ threadId: 't1', title: 'Notes', content: { blocks: markdownToBlocks('# Notes\n\nFirst') }, author: 'bot' })
    expect(d.version).toBe(1)
    const r1 = s.editBot(d.id, 1, [{ op: 'insert', markdown: 'Second' }])
    expect(r1.snapshot.version).toBe(2)
    const user = { ...r1.snapshot.content, blocks: r1.snapshot.content.blocks.map((b) => (b.text === 'First' ? { ...b, text: 'First (edited)' } : b)) }
    const u = s.saveUser(d.id, 2, user)
    expect(u.version).toBe(3)
    expect(u.lastAuthor).toBe('user')
    expect(u.lastSummary).toBe('Edited "First (edited)"')
    const vs = s.versions(d.id)
    expect(vs.map((v) => [v.n, v.author])).toEqual([[3, 'user'], [2, 'bot'], [1, 'bot']])
    const back = s.restore(d.id, 1)
    expect(back.version).toBe(4)
    expect(back.content.blocks.map((b) => b.text)).toEqual(['Notes', 'First'])
    expect(back.lastSummary).toBe('Restored version 1')
    expect(s.diff(d.id, 1, 3).rows.map((r) => r.status)).toEqual(['same', 'changed', 'added'])
    expect(events).toEqual(['bot:1', 'bot:2', 'user:3', 'user:4'])
    // Saving the same content stores nothing.
    expect(s.saveUser(d.id, 4, back.content).version).toBe(4)
  })

  test('user saves close together fold into one version, unless the bot has seen it', () => {
    const s = store()
    const d = s.create({ threadId: 't', title: 'X', content: { blocks: markdownToBlocks('a\n\nb') }, author: 'bot' })
    const edit = (snap: typeof d, text: string): DocContent => ({ ...snap.content, blocks: [{ ...snap.content.blocks[0], text }, snap.content.blocks[1]] })
    const v2 = s.saveUser(d.id, 1, edit(d, 'a1'))
    const v2b = s.saveUser(d.id, 2, edit(v2, 'a12'))
    expect(v2b.version).toBe(2)
    expect(s.versions(d.id)).toHaveLength(2)
    s.markSeen(d.id, 2)
    expect(s.saveUser(d.id, 2, edit(v2b, 'a123')).version).toBe(3)
  })

  test('a stale bot edit that touches what the user changed is a conflict; untouched parts rebase', () => {
    const s = store()
    const d = s.create({ threadId: 't', title: 'Trip', content: { blocks: markdownToBlocks('# Trip\n\nDay 1: Paris\n\nDay 2: Lyon') }, author: 'bot' })
    const [, p1, p2] = d.content.blocks
    const user = s.saveUser(d.id, 1, { ...d.content, blocks: d.content.blocks.map((b) => (b.id === p1.id ? { ...b, text: 'Day 1: Paris and Versailles' } : b)) })
    expect(user.version).toBe(2)
    // Stale base, same block: conflict, nothing applied, message names the change.
    let err: Error | undefined
    try { s.editBot(d.id, 1, [{ op: 'replace', id: p1.id, markdown: 'Day 1: Paris (Louvre)' }]) } catch (e) { err = e as Error }
    expect(err).toBeInstanceOf(DocConflictError)
    expect(err!.message).toMatch(/the user changed this document after version 1 \(it is now version 2\)/)
    expect(err!.message).toContain(`[${p1.id}] was changed by the user and now reads: "Day 1: Paris and Versailles"`)
    expect(err!.message).toMatch(/doc_read .* base 2/)
    expect(s.get(d.id).version).toBe(2)
    // A doc-wide replace_text that would hit the changed block conflicts too.
    expect(() => s.editBot(d.id, 1, [{ op: 'replace_text', find: 'Paris', replace: 'PARIS' }])).toThrow(DocConflictError)
    // Stale base, other block: applied on top of the user's change.
    const r = s.editBot(d.id, 1, [{ op: 'replace', id: p2.id, markdown: 'Day 2: Lyon and Annecy' }])
    expect(r.rebasedOver).toBe(1)
    expect(r.snapshot.content.blocks.map((b) => b.text)).toEqual(['Trip', 'Day 1: Paris and Versailles', 'Day 2: Lyon and Annecy'])
    // A block the user deleted.
    const del = s.saveUser(d.id, 3, { ...r.snapshot.content, blocks: r.snapshot.content.blocks.filter((b) => b.id !== p2.id) })
    expect(() => s.editBot(d.id, 3, [{ op: 'insert', after: p2.id, markdown: 'x' }])).toThrow(new RegExp(`\\[${p2.id}\\] was deleted by the user`))
    // Fresh base works.
    expect(s.editBot(d.id, del.version, [{ op: 'insert', markdown: 'Day 3' }]).snapshot.version).toBe(del.version + 1)
    expect(() => s.editBot(d.id, 99, [{ op: 'insert', markdown: 'x' }])).toThrow(/"base" must be/)
  })

  test('user saves on a stale base merge with the bot edit made meanwhile', () => {
    const s = store()
    const d = s.create({ threadId: 't', title: 'M', content: { blocks: markdownToBlocks('one\n\ntwo') }, author: 'bot' })
    s.editBot(d.id, 1, [{ op: 'insert', markdown: 'three (bot)' }])
    const mine = { ...d.content, blocks: [{ ...d.content.blocks[0], text: 'one (me)' }, d.content.blocks[1]] }
    const merged = s.saveUser(d.id, 1, mine)
    expect(merged.content.blocks.map((b) => b.text)).toEqual(['one (me)', 'two', 'three (bot)'])
  })

  test('sheets: cell conflicts and computed values', () => {
    const s = store()
    const d = s.create({ threadId: 't', title: 'Budget', type: 'sheet', content: { blocks: [], sheet: sheetFromMarkdown('| Item | Cost |\n| --- | --- |\n| Hotel | 300 |\n| Total | =SUM(B2:B2) |') }, author: 'bot' })
    expect(d.computed?.B3.value).toBe(300)
    s.saveUser(d.id, 1, { ...d.content, sheet: { ...d.content.sheet!, cells: { ...d.content.sheet!.cells, B2: '350' } } })
    expect(() => s.editBot(d.id, 1, [{ op: 'set_cells', cells: { B2: 400 } }])).toThrow(/cell B2 \(changed by the user\) is now "350"/)
    const r = s.editBot(d.id, 1, [{ op: 'set_cells', cells: { A4: 'Food', B4: 150, B3: '=B2+B4' } }])
    expect(r.snapshot.computed?.B3.value).toBe(500)
    expect(readView(r.snapshot)).toContain('| 3 | Total | =B2+B4 → 500 |')
  })

  test('normalizeContent drops unknown types and fixes ids', () => {
    const c = normalizeContent({ title: ' x ', blocks: [{ id: 'b001', type: 'p', text: 'a' }, { id: 'b001', type: 'h1', text: 'b' }, { type: 'evil', text: 'c' }, { id: '<x>', type: 'callout', text: 'd', tone: 'nope' }] }, 'doc')
    expect(c.title).toBe('x')
    expect(c.blocks.map((b) => b.type)).toEqual(['p', 'h1', 'callout'])
    expect(new Set(c.blocks.map((b) => b.id)).size).toBe(3)
    expect(c.blocks[2].tone).toBe('info')
  })
})

describe('export bridge', () => {
  test('docx/pdf go through the document generators; md/html/csv are written here; xlsx keeps formulas', async () => {
    const s = store()
    const dir = mkdtempSync(join(tmpdir(), 'docspace-export-'))
    const create = vi.fn<CreateDocumentFn>(async (path) => { writeFileSync(path, 'fake') })
    const d = s.create({ threadId: 't', title: 'Trip plan', content: { blocks: markdownToBlocks('# Trip plan\n\nHello **there** <b>x</b>\n\n> [!TIP]\n> Bring snacks') }, author: 'bot' })
    const docx = await exportDoc(d, 'docx', dir, { create })
    expect(docx).toBe(join(dir, 'trip-plan.docx'))
    expect(create).toHaveBeenCalledWith(docx, expect.objectContaining({ title: 'Trip plan', markdown: expect.stringContaining('Hello **there**') }), expect.objectContaining({ readImage: expect.any(Function) }))
    expect(create.mock.calls[0][1].markdown).toContain('> **Tip:** Bring snacks')
    expect(create.mock.calls[0][1].markdown?.startsWith('# Trip plan')).toBe(true)
    expect(await exportDoc(d, 'docx', dir, { create })).toBe(join(dir, 'trip-plan-2.docx'))
    await exportDoc(d, 'pdf', dir, { create })
    const md = await exportDoc(d, 'md', dir)
    expect(readFileSync(md, 'utf8')).toBe(exportMarkdown(d))
    const html = readFileSync(await exportDoc(d, 'html', dir), 'utf8')
    expect(html).toContain('<strong>there</strong> &lt;b&gt;x&lt;/b&gt;')
    expect(html).toContain('<aside class="callout tip">')
    expect(html).not.toMatch(/<script/i)
    await expect(exportDoc(d, 'xlsx', dir)).rejects.toThrow(/exports to docx, pdf, md, html/)

    const sh = s.create({ threadId: 't', title: 'Budget', type: 'sheet', content: { blocks: [], sheet: sheetFromMarkdown('| Item | Cost |\n| --- | --- |\n| Hotel | 300 |\n| Total | =SUM(B2:B2) |') }, author: 'bot' })
    const csv = await exportDoc(sh, 'csv', dir)
    expect(readFileSync(csv, 'utf8')).toBe('Item,Cost\nHotel,300\nTotal,300\n')
    await exportDoc(sh, 'xlsx', dir, { create })
    const spec = create.mock.calls[create.mock.calls.length - 1][1]
    expect(spec.sheets?.[0].rows).toEqual([['Item', 'Cost'], ['Hotel', 300], ['Total', '=SUM(B2:B2)']])
    expect(exportHtml(sh)).toContain('<td>300</td>')
    expect(existsSync(join(dir, 'budget.xlsx'))).toBe(true)
  })
})

describe('doc tools', () => {
  const ctx = (threadId: string): ToolContext => ({
    threadId, signal: new AbortController().signal, workspaceDir: '', docsDir: '', askUser: async () => '', state: emptyState(),
    loadTools: () => [], searchTools: () => [], readResult: () => undefined
  })

  test('create → read → edit (conflict after a user edit) → re-read → edit → export', async () => {
    const s = store()
    const ws = mkdtempSync(join(tmpdir(), 'docspace-ws-'))
    const create = vi.fn<CreateDocumentFn>(async (path) => { writeFileSync(path, 'docx bytes') })
    const [docCreate, docRead, docEdit, docExport] = docTools({ store: s, workspace: () => ws, spaceOf: () => 'space1', create })
    const c = ctx('thread1')
    const made = await docCreate.run({ title: 'Trip plan', markdown: '# Trip plan\n\nDay 1: Paris\n\n- Pack bags' }, c)
    expect(made.meta?.doc).toMatchObject({ title: 'Trip plan', version: 1 })
    const id = (made.meta!.doc as { id: string }).id
    const para = s.get(id).content.blocks[0]
    expect(s.get(id).content.blocks.map((b) => b.type)).toEqual(['p', 'bullet']) // the "# Trip plan" heading is the title
    expect(made.text).toContain(`[${para.id}] Day 1: Paris`)
    expect(s.libraryItems('space1')[0]).toMatchObject({ docId: id, title: 'Trip plan' })

    s.saveUser(id, 1, { ...s.get(id).content, blocks: s.get(id).content.blocks.map((b) => (b.id === para.id ? { ...b, text: 'Day 1: Paris and Lyon' } : b)) })
    await expect(docEdit.run({ base: 1, ops: [{ op: 'replace', id: para.id, markdown: 'Day 1: Paris (Louvre)' }] }, c)).rejects.toThrow(/the user changed this document/)
    const read = await docRead.run({}, c)
    expect(read.text).toContain('version 2')
    expect(read.text).toContain('last change by the user')
    expect(read.text).toContain(`[${para.id}] Day 1: Paris and Lyon`)
    const ed = await docEdit.run({ base: 2, ops: [{ op: 'replace_text', id: para.id, find: 'Lyon', replace: 'Lyon (Louvre first)' }] }, c)
    expect(ed.text).toMatch(/now version 3: use base 3 next/)
    expect(s.get(id).content.blocks[0].text).toBe('Day 1: Paris and Lyon (Louvre first)')
    const ex = await docExport.run({ format: 'docx' }, c)
    expect(ex.path).toBe(join(ws, 'exports', 'trip-plan.docx'))
    expect(readFileSync(ex.path!, 'utf8')).toBe('docx bytes')

    // A helper agent's call works on its root chat's documents.
    const helper = ctx('child')
    helper.state.rootId = 'thread1'
    expect((await docRead.run({}, helper)).text).toContain('Trip plan')
    await expect(docRead.run({}, ctx('empty'))).rejects.toThrow(/no document yet/)
  })
})

// FFB-01 (save where asked): "make a PDF report and save it to my Downloads" lands in ~/Downloads, never in the
// workspace's exports folder, and never over a file that is already there.
test('doc_export saves where the user asked ("to"): a folder or a full path; a taken name gets " (2)"', async () => {
  const home = mkdtempSync(join(tmpdir(), 'docspace-home-'))
  const was = process.env.HOME
  process.env.HOME = home
  try {
    const ws = join(home, 'SahilBot')
    const s = store()
    const create = vi.fn<CreateDocumentFn>(async (path) => { writeFileSync(path, 'pdf bytes') })
    const [docCreate, , , docExport] = docTools({ store: s, workspace: () => ws, create })
    const c: ToolContext = { threadId: 'thread-to', signal: new AbortController().signal, workspaceDir: ws, docsDir: '', askUser: async () => '', state: { ...emptyState(), roots: [home] }, loadTools: () => [], searchTools: () => [], readResult: () => undefined }
    await docCreate.run({ title: 'Q3 Report', markdown: 'Numbers' }, c)
    const a = await docExport.run({ format: 'pdf', to: '~/Downloads' }, c)
    expect(a.path).toBe(join(home, 'Downloads', 'q3-report.pdf'))
    writeFileSync(join(home, 'Downloads', 'Report.pdf'), 'the user\'s report')
    const b = await docExport.run({ format: 'pdf', to: '~/Downloads/Report.pdf' }, c)
    expect(b.path).toBe(join(home, 'Downloads', 'Report (2).pdf'))
    expect(readFileSync(join(home, 'Downloads', 'Report.pdf'), 'utf8')).toBe('the user\'s report')
    expect(existsSync(join(ws, 'exports'))).toBe(false)
    // Outside the home folder: a hard stop (asks first), like file_write.
    expect(docExport.hardStop!({ format: 'pdf', to: mkdtempSync(join(tmpdir(), 'docspace-elsewhere-')) }, { roots: [home] })).toMatch(/outside your folders/)
    expect(docExport.hardStop!({ format: 'pdf', to: '~/Desktop' }, { roots: [home] })).toBeNull()
  } finally {
    process.env.HOME = was
  }
})
