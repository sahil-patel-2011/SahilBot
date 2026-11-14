import type { DocBlock, DocCellValue, DocSheet, DocSnapshot } from '@shared/types'
import { blocksToMarkdown, listNumbers, blockToMarkdown } from './markdown'
import { sectionIds } from './ops'
import { addr, colName, expandRange, isFormula, parseAddr, showValue } from './sheet'

// What the bot sees: compact Markdown with an [id] marker in front of every block, or a sheet as a grid
// of inputs and computed values. Pure.

export interface ReadRange {
  /** First and last block to include (inclusive). */
  from?: string
  to?: string
  /** A heading's section only. */
  section?: string
  /** Sheets: a cell range like "A1:D20". */
  range?: string
}

export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

export function header(d: DocSnapshot, now = Date.now()): string {
  const who = d.lastAuthor === 'user' ? 'the user' : 'you'
  return `Document "${d.title}" (doc ${d.id}, ${d.type === 'sheet' ? 'sheet' : 'document'}, version ${d.version}; last change by ${who} ${ago(d.updatedAt, now)}: ${d.lastSummary})`
}

/** Blocks from..to (or a section), with ids. Throws on unknown ids. */
export function selectBlocks(blocks: DocBlock[], r: ReadRange): DocBlock[] {
  if (r.section) {
    const ids = new Set(sectionIds(blocks, r.section))
    return blocks.filter((b) => ids.has(b.id))
  }
  let a = 0
  let z = blocks.length - 1
  if (r.from) { a = blocks.findIndex((b) => b.id === r.from); if (a === -1) throw new Error(`No block [${r.from}] in this document.`) }
  if (r.to) { z = blocks.findIndex((b) => b.id === r.to); if (z === -1) throw new Error(`No block [${r.to}] in this document.`) }
  return blocks.slice(Math.min(a, z), Math.max(a, z) + 1)
}

/** The doc as Markdown with [id] markers (numbered lists keep their document numbering). */
export function docMarkdownWithIds(blocks: DocBlock[], all: DocBlock[] = blocks): string {
  if (blocks.length === all.length) return blocksToMarkdown(blocks, { ids: true })
  const nums = listNumbers(all)
  return blocks.map((b) => `[${b.id}] ${blockToMarkdown(b, nums.get(b.id) ?? 1)}`).join('\n\n')
}

/** A sheet as a Markdown grid: column letters, row numbers, and "input → value" for formulas. */
export function sheetGrid(s: DocSheet, computed: Record<string, DocCellValue>, range?: string): string {
  let r0 = 0
  let c0 = 0
  let r1 = -1
  let c1 = -1
  if (range) {
    const cells = expandRange(range)
    if (!cells) throw new Error(`"${range}" is not a range like A1:D20.`)
    const p = parseAddr(cells[0])!
    const q = parseAddr(cells[cells.length - 1])!
    ;[r0, c0, r1, c1] = [p.r, p.c, q.r, q.c]
  } else {
    for (const a of Object.keys(s.cells)) {
      const p = parseAddr(a)
      if (p) { r1 = Math.max(r1, p.r); c1 = Math.max(c1, p.c) }
    }
  }
  if (r1 < r0 || c1 < c0) return '(empty sheet)'
  const cols = Array.from({ length: c1 - c0 + 1 }, (_, k) => colName(c0 + k))
  const lines = [`|   | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`]
  for (let r = r0; r <= r1; r++) {
    const row: string[] = []
    for (let c = c0; c <= c1; c++) {
      const a = addr(c, r)
      const raw = s.cells[a] ?? ''
      const v = computed[a]
      const shown = isFormula(raw) ? `${raw} → ${showValue(v)}` : raw
      row.push(shown.replace(/\|/g, '\\|').replace(/\n/g, ' '))
    }
    lines.push(`| ${r + 1} | ${row.join(' | ')} |`)
  }
  return lines.join('\n')
}

/** The full doc_read text. */
export function readView(d: DocSnapshot, r: ReadRange = {}, now = Date.now()): string {
  const head = header(d, now)
  if (d.type === 'sheet') {
    const s = d.content.sheet ?? { rows: 0, cols: 0, cells: {} }
    return `${head}\nRow 1 is ${s.header ? 'a header row' : 'data'}. Cells show their input; formulas show "=formula → value".\n\n${sheetGrid(s, d.computed ?? {}, r.range)}`
  }
  const blocks = selectBlocks(d.content.blocks, r)
  const part = r.from || r.to || r.section ? ` (blocks ${blocks.length} of ${d.content.blocks.length})` : ''
  return `${head}${part}\nEach block starts with its [id]; use these ids and base ${d.version} in doc_edit.\n\n${blocks.length ? docMarkdownWithIds(blocks, d.content.blocks) : '(empty document)'}`
}
