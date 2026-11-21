import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { DocBlock } from '../../src/shared/types'
import { blocksToSlides, slideLayout, slidesToBlocks } from '../../src/shared/slides'
import { exportDoc } from '../../src/main/docspace/export'
import { importFile } from '../../src/main/docspace/import'
import { normalizeContent } from '../../src/main/docspace/store'
import { merge3 } from '../../src/main/docspace/merge'
import { pptxSlides } from '../../src/main/docs/read'

const deck: DocBlock[] = [
  { id: 'h1', type: 'h2', text: 'Q3 review' },
  { id: 'p1', type: 'bullet', text: 'Growth and what is next' },
  { id: 'h2', type: 'h2', text: 'Results' },
  { id: 'p2', type: 'bullet', text: 'Revenue up **12%**' },
  { id: 'p3', type: 'bullet', text: 'North led', indent: 1 },
  { id: 'n1', type: 'quote', text: 'Pause for questions.' },
  { id: 'h3', type: 'h2', text: 'Thank you' }
]

test('a deck is its blocks: headings start slides, lists are points, quotes are notes, and ids survive a round trip', () => {
  const slides = blocksToSlides(deck)
  expect(slides.map((s) => s.title)).toEqual(['Q3 review', 'Results', 'Thank you'])
  expect(slides[1].points.map((p) => [p.id, p.text, p.indent ?? 0])).toEqual([['p2', 'Revenue up **12%**', 0], ['p3', 'North led', 1]])
  expect(slides[1].notes).toBe('Pause for questions.')
  expect(slides.map((s, i) => slideLayout(s, i))).toEqual(['title', 'bullets', 'section'])
  let n = 0
  const back = slidesToBlocks(slides, () => `new${n++}`)
  expect(back).toEqual(deck)
  expect(n).toBe(0)
  // Text before the first heading becomes an untitled first slide, which gets a heading on the way back.
  const loose = blocksToSlides([{ id: 'a', type: 'p', text: 'Just a line' }])
  expect(loose).toHaveLength(1)
  expect(slidesToBlocks(loose, () => 'fresh')[0]).toEqual({ id: 'fresh', type: 'h2', text: '' })
})

test('the deck flag is kept through saves and merges', () => {
  expect(normalizeContent({ title: 'D', blocks: deck, kind: 'slides' }, 'doc').kind).toBe('slides')
  expect(normalizeContent({ title: 'S', blocks: [], kind: 'slides' }, 'sheet').kind).toBeUndefined()
  const base = { title: 'D', blocks: deck, kind: 'slides' as const }
  const theirs = { ...base, blocks: deck.map((b) => (b.id === 'p2' ? { ...b, text: 'Revenue up 13%' } : b)) }
  const mine = { ...base, blocks: deck.map((b) => (b.id === 'h3' ? { ...b, text: 'Questions?' } : b)) }
  const m = merge3(base, theirs, mine)
  expect(m.kind).toBe('slides')
  expect(m.blocks.find((b) => b.id === 'p2')?.text).toBe('Revenue up 13%')
  expect(m.blocks.find((b) => b.id === 'h3')?.text).toBe('Questions?')
})

test('a deck exports to PowerPoint with its slides and notes, and the file opens again as a deck', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slides-'))
  const snap = { id: 'd1', threadId: 't', title: 'Q3 review', type: 'doc', version: 1, createdAt: 0, updatedAt: 0, lastAuthor: 'user', lastSummary: '', content: { title: 'Q3 review', blocks: deck, kind: 'slides', style: { theme: 'classic', font: 'Georgia' } } } as never
  const path = await exportDoc(snap, 'pptx', dir)
  expect(path.endsWith('.pptx')).toBe(true)
  const read = await pptxSlides(path)
  expect(read).toHaveLength(3)
  expect(read[1].texts.join(' ')).toContain('Revenue up 12%')
  expect(read[1].notes).toContain('Pause for questions.')
  const again = await importFile(path)
  expect(again.content.kind).toBe('slides')
  expect(blocksToSlides(again.content.blocks).map((s) => s.title)).toEqual(['Q3 review', 'Results', 'Thank you'])
  // A plain document can't be exported as slides.
  await expect(exportDoc({ ...(snap as object), content: { title: 'x', blocks: deck } } as never, 'pptx', dir)).rejects.toThrow(/not pptx/)
}, 60_000)

test('creating a deck keeps its slides flag and style (the bot\'s doc_create and Artifacts → Slides)', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { DocStore } = await import('../../src/main/docspace/store')
  const store = new DocStore(new DatabaseSync(':memory:'))
  const snap = store.create({ threadId: 't1', title: 'Deck', content: { blocks: deck, kind: 'slides', style: { theme: 'minimal' } }, author: 'bot' })
  expect(store.get(snap.id).content.kind).toBe('slides')
  expect(store.get(snap.id).content.style).toEqual({ theme: 'minimal' })
  expect(store.recent(5).map((d) => [d.id, d.slides])).toEqual([[snap.id, true]])
})

test('kickers, stats and empty points: the title slide reads like a real deck', async () => {
  const { slidePieces, slideHtml } = await import('../../src/shared/slide-render')
  const blocks: DocBlock[] = [
    { id: 'k', type: 'h3', text: 'Assembly guide · Nov 2026' }, { id: 't', type: 'h2', text: 'Ranger' },
    { id: 'a', type: 'bullet', text: 'Assembly Guide' }, { id: 'b', type: 'bullet', text: 'One part per step' },
    { id: 'c', type: 'bullet', text: '**130** Steps' }, { id: 'd', type: 'bullet', text: '**1,192 g** — Printed parts' }, { id: 'e', type: 'bullet', text: '' },
    { id: 'h3a', type: 'h3', text: 'A plain h3 slide' }, { id: 'p', type: 'bullet', text: 'x' }
  ]
  const s = blocksToSlides(blocks)
  expect(s.map((x) => [x.title, x.kicker])).toEqual([['Ranger', 'Assembly guide · Nov 2026'], ['A plain h3 slide', undefined]])
  expect(s[0].points.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  const p = slidePieces(s[0], 0)
  expect([p.layout, p.dark, p.subtitle, p.description, p.stats]).toEqual(['title', true, 'Assembly Guide', ['One part per step'], [{ value: '130', label: 'Steps' }, { value: '1,192 g', label: 'Printed parts' }]])
  const html = slideHtml(s[0], 0, { total: 2, deckTitle: 'Ranger' })
  expect(html).toContain('sl-title dark')
  expect(html).toContain('<b>130</b><span>Steps</span>')
  expect(slideHtml({ ...s[1], title: '<script>x</script>' }, 1, { total: 2, deckTitle: 'R' })).not.toContain('<script>')
  let n = 0
  expect(slidesToBlocks(s, () => `n${n++}`)).toEqual([{ id: 'k', type: 'h3', text: 'Assembly guide · Nov 2026' }, ...blocks.slice(1, 7).map((b) => ({ ...b, type: b.type === 'h3' ? 'h2' : b.type })), { id: 'h3a', type: 'h3', text: 'A plain h3 slide' }, blocks[8]])
})

test('a dashboard: sections, stat tiles with notes, and a chart from a table', async () => {
  const { blocksToDashboard, dashboardHtml, numberOf, chartSvg } = await import('../../src/shared/dashboard')
  const blocks: DocBlock[] = [
    { id: 'a', type: 'h2', text: 'Overview' }, { id: 'b', type: 'bullet', text: '**$4.2M** Revenue · up 12%' }, { id: 'c', type: 'bullet', text: 'Plain point' },
    { id: 'd', type: 'h2', text: 'By month' }, { id: 'e', type: 'table', header: true, rows: [['Month', 'Revenue', 'Costs'], ['Jan', '$310', '220'], ['Feb', '$350', '(10)'], ['Mar', '1.2k', '']] }
  ]
  const d = blocksToDashboard(blocks)
  expect(d[0].tiles).toEqual([{ value: '$4.2M', label: 'Revenue', note: 'up 12%' }])
  expect(d[0].bullets).toEqual(['Plain point'])
  expect([numberOf('$310'), numberOf('(10)'), numberOf('1.2k'), numberOf('12%'), numberOf('n/a')]).toEqual([310, -10, 1200, 12, null])
  const svg = chartSvg(d[1].tables[0], ['#111', '#222'])!
  // Mar's blank Costs cell is a gap, not a zero bar.
  expect(svg.match(/<rect /g)?.length).toBe(5)
  expect([numberOf('+12%'), numberOf('−5'), numberOf('–3.5k')]).toEqual([12, -5, -3500])
  expect(blocksToDashboard([{ id: 'x', type: 'bullet', text: '**9** Wins · up 2 · best month' }])[0].tiles[0].note).toBe('up 2 · best month')
  expect(dashboardHtml('Q3', blocks)).toContain('db-tile')
})

test('editing a slide keeps what the slide model doesn\'t edit: tables, code, a second picture, numbered and check points', () => {
  const blocks: DocBlock[] = [
    { id: 'h', type: 'h1', text: 'Data' }, { id: 'n', type: 'numbered', text: 'First' }, { id: 'c', type: 'check', text: 'Done', checked: true },
    { id: 'i1', type: 'image', src: '/a.png' }, { id: 't', type: 'table', header: true, rows: [['A', 'B'], ['1', '2']] }, { id: 'i2', type: 'image', src: '/b.png' }, { id: 'q', type: 'quote', text: 'notes' }
  ]
  const s = blocksToSlides(blocks)
  expect(s[0].image).toBe('/a.png')
  expect(s[0].extra?.map((b) => b.id)).toEqual(['t', 'i2'])
  let n = 0
  const back = slidesToBlocks([{ ...s[0], title: 'Data v2' }], () => `x${n++}`)
  expect(back.map((b) => [b.id, b.type])).toEqual([['h', 'h1'], ['n', 'numbered'], ['c', 'check'], ['i1', 'image'], ['t', 'table'], ['i2', 'image'], ['q', 'quote']])
  expect(back.find((b) => b.id === 'c')?.checked).toBe(true)
  expect(back[0].text).toBe('Data v2')
})

test('native sheets work out the functions people expect: IF, SUMIF, VLOOKUP, text and comparisons', async () => {
  const { evaluateSheet } = await import('../../src/main/docspace/sheet')
  const v = evaluateSheet({
    A1: 'Item', B1: 'Cost', A2: 'Rent', B2: '1200', A3: 'Power', B3: '90', A4: 'Rent', B4: '300',
    C1: '=SUM(B2:B4)', C2: '=IF(B2>1000,"big","small")', C3: '=SUMIF(A2:A4,"Rent",B2:B4)', C4: '=VLOOKUP("Power",A2:B4,2,FALSE)',
    C5: '=UPPER(A3)&"!"', C6: '=ROUND(AVERAGE(B2:B4)/7,1)', C7: '=NOSUCHFN(1)', C8: '=1/0'
  })
  expect(['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].map((k) => v[k].value)).toEqual([1590, 'big', 1500, 90, 'POWER!', 75.7])
  expect(v.C7.error).toBeTruthy()
  expect(v.C8.error).toBe('#DIV/0!')
})
