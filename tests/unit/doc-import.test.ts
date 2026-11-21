import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { htmlToMarkdown, importFile, isEditable, saveFormat } from '../../src/main/docspace/import'
import { normalizeContent, normalizeStyle } from '../../src/main/docspace/store'
import { merge3 } from '../../src/main/docspace/merge'
import { createDocument } from '../../src/main/docs/create'

const dir = (): string => mkdtempSync(join(tmpdir(), 'doc-import-'))

test('a Word file the agent made opens as editable blocks: headings, lists and tables survive', async () => {
  const d = dir()
  const path = join(d, 'Quarterly report.docx')
  await createDocument(path, { path, title: 'Quarterly report', markdown: '# Results\n\nRevenue grew **12%**.\n\n- North up\n- South flat\n\n| Region | Revenue |\n| --- | --- |\n| North | 120 |\n| South | 80 |' })
  const r = await importFile(path)
  expect(r.type).toBe('doc')
  const types = r.content.blocks.map((b) => b.type)
  expect(types).toContain('h1')
  expect(types).toContain('bullet')
  expect(types).toContain('table')
  const table = r.content.blocks.find((b) => b.type === 'table')!
  expect(table.rows?.[1]).toEqual(['North', '120'])
  expect(r.content.blocks.find((b) => b.type === 'p' && b.text?.includes('12%'))?.text).toContain('**12%**')
})

test('CSV opens as a sheet (quoted commas kept), Markdown as blocks, and files save back in their own format', async () => {
  const d = dir()
  const csv = join(d, 'budget.csv')
  writeFileSync(csv, 'Item,Cost\n"Rent, office",1200\nPower,90\n')
  const s = await importFile(csv)
  expect(s.type).toBe('sheet')
  expect(s.content.sheet?.cells).toMatchObject({ A1: 'Item', A2: 'Rent, office', B2: '1200', A3: 'Power' })
  const md = join(d, 'notes.md')
  writeFileSync(md, '# Plan\n\n1. Draft\n2. Review\n')
  expect((await importFile(md)).content.blocks.map((b) => b.type)).toEqual(['h1', 'numbered', 'numbered'])
  expect(saveFormat('/x/a.docx')).toBe('docx')
  expect(saveFormat('/x/a.pptx')).toBe('docx')
  expect(saveFormat('/x/a.txt')).toBe('md')
  expect(saveFormat('/x/a.xlsx')).toBe('xlsx')
  expect(isEditable('/x/a.key')).toBe(false)
  expect(htmlToMarkdown('<h2>Hi</h2><p>One &amp; <b>two</b></p><ul><li>a</li></ul>')).toBe('## Hi\n\nOne & **two**\n\n- a')
})

test('the document style (font, size, theme) is kept through saves and merges, and unknown values are dropped', () => {
  expect(normalizeStyle({ font: 'Georgia', size: 12, theme: 'classic' })).toEqual({ font: 'Georgia', size: 12, theme: 'classic' })
  expect(normalizeStyle({ font: 'Comic Sans', size: 40, theme: 'neon' })).toBeUndefined()
  const c = normalizeContent({ title: 'T', blocks: [{ id: 'b001', type: 'p', text: 'x' }], style: { font: 'Palatino' } }, 'doc')
  expect(c.style).toEqual({ font: 'Palatino' })
  const base = { title: 'T', blocks: [{ id: 'b001', type: 'p' as const, text: 'x' }] }
  const theirs = { ...base, blocks: [{ id: 'b001', type: 'p' as const, text: 'x (bot edit)' }] }
  const mine = { ...base, style: { font: 'Georgia' } }
  const merged = merge3(base, theirs, mine)
  expect(merged.style).toEqual({ font: 'Georgia' })
  expect(merged.blocks[0].text).toBe('x (bot edit)')
})

test('the chosen font reaches the exported Word file', async () => {
  const { exportDoc } = await import('../../src/main/docspace/export')
  const { execFileSync } = await import('node:child_process')
  const d = dir()
  const snap = { id: 'd1', threadId: 't', spaceId: null, title: 'Styled', type: 'doc', version: 1, updatedAt: 0, author: 'user', content: { title: 'Styled', blocks: [{ id: 'b001', type: 'p', text: 'Hello there' }], style: { font: 'Georgia', size: 12 } } } as never
  const path = await exportDoc(snap, 'docx', d)
  const xml = execFileSync('/usr/bin/unzip', ['-p', path, 'word/document.xml', 'word/styles.xml']).toString()
  expect(xml).toContain('Georgia')
})
