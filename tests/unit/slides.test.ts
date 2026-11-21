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
