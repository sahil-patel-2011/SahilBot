import type { DocBlock, DocContent } from '@shared/types'
import { markdownToBlocks, stripIdMarkers } from './markdown'
import { addr, expandRange, fitSheet, MAX_COLS, MAX_ROWS, parseAddr } from './sheet'

// doc_edit operations: an atomic batch applied to a copy of the document. Any failing op rejects the
// whole batch with a message that says which op and why. Pure.

export type DocOpName =
  | 'insert' | 'replace' | 'replace_text' | 'delete' | 'move' | 'set_title' | 'set_checked'
  | 'table_add_row' | 'table_add_col' | 'table_delete_row' | 'table_delete_col' | 'table_set_cell'
  | 'set_cells' | 'set_range' | 'clear_range'

export interface DocOp {
  op: DocOpName
  /** The block an op works on (replace, set_checked, table ops; replace_text: limit to this block). */
  id?: string
  /** Blocks to delete or move. */
  ids?: string[]
  /** Where insert/move put blocks: after or before a block, or at the start/end (default end). */
  after?: string
  before?: string
  at?: 'start' | 'end'
  /** New content (insert, replace) as Markdown. */
  markdown?: string
  find?: string
  replace?: string
  /** replace_text: how many matches you expect (all of them are replaced). */
  count?: number
  all?: boolean
  /** delete: a heading's id; the heading and everything under it (up to the next heading of the same or higher level). */
  section?: string
  title?: string
  checked?: boolean
  /** Table ops: 1-based row and column (row 1 is the header row when the table has one). */
  row?: number
  col?: number
  text?: string
  /** table_add_row / table_add_col: the new cells. */
  values?: string[]
  /** set_cells: { "A1": "Total", "B5": "=SUM(B2:B4)" }. */
  cells?: Record<string, string | number | boolean | null>
  /** set_range: top-left cell and rows of values. */
  start?: string
  rows?: Array<Array<string | number | boolean | null>>
  /** clear_range: e.g. "A2:C9". */
  range?: string
}

export class OpError extends Error {}

const MAX_BLOCKS = 5000
const HEAD: Record<string, number> = { h1: 1, h2: 2, h3: 3 }
const TEXT_TYPES = new Set(['h1', 'h2', 'h3', 'p', 'bullet', 'numbered', 'check', 'quote', 'code', 'callout'])

export interface ApplyResult {
  content: DocContent
  /** Ids of blocks this batch inserted (in order). */
  added: string[]
  /** One line per op, for the tool result. */
  notes: string[]
}

const clone = (c: DocContent): DocContent => JSON.parse(JSON.stringify(c)) as DocContent

function countOf(hay: string, needle: string): number {
  if (!needle) return 0
  let n = 0
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++
  return n
}

/** The searchable strings of a block, with setters (text, or table cells). */
function fields(b: DocBlock): Array<{ get: () => string; set: (s: string) => void }> {
  if (b.type === 'table') return (b.rows ?? []).flatMap((r) => r.map((_, k) => ({ get: () => r[k], set: (s: string) => { r[k] = s } })))
  if (TEXT_TYPES.has(b.type)) return [{ get: () => b.text ?? '', set: (s: string) => { b.text = s } }]
  if (b.type === 'image') return [{ get: () => b.alt ?? '', set: (s: string) => { b.alt = s } }]
  return []
}

export function blockMatches(b: DocBlock, find: string): number {
  return fields(b).reduce((n, f) => n + countOf(f.get(), find), 0)
}

/** The ids a heading's section covers: the heading and every block until the next heading of its level or higher. */
export function sectionIds(blocks: DocBlock[], headingId: string): string[] {
  const k = blocks.findIndex((b) => b.id === headingId)
  if (k === -1) throw new OpError(`no block [${headingId}]`)
  const level = HEAD[blocks[k].type]
  if (!level) throw new OpError(`[${headingId}] is not a heading, so it has no section (use "ids" to delete blocks)`)
  const out = [headingId]
  for (let i = k + 1; i < blocks.length; i++) {
    const l = HEAD[blocks[i].type]
    if (l && l <= level) break
    out.push(blocks[i].id)
  }
  return out
}

const cellValue = (v: string | number | boolean | null | undefined): string => (v === null || v === undefined ? '' : String(v))

/** Applies ops in order to a copy of `doc`. Throws OpError("Op 2 (replace): …") on the first failure. */
export function applyOps(doc: DocContent, ops: DocOp[], opts: { type: 'doc' | 'sheet'; rand?: () => number } = { type: 'doc' }): ApplyResult {
  const c = clone(doc)
  const added: string[] = []
  const notes: string[] = []
  if (!Array.isArray(ops) || !ops.length) throw new OpError('Give at least one op.')
  ops.forEach((op, n) => {
    try {
      notes.push(applyOne(c, op, opts, added))
    } catch (e) {
      throw new OpError(`Op ${n + 1} (${op?.op ?? '?'}): ${(e as Error).message}. Nothing was applied.`)
    }
  })
  if (c.blocks.length > MAX_BLOCKS) throw new OpError(`The document would have more than ${MAX_BLOCKS} blocks. Nothing was applied.`)
  return { content: c, added, notes }
}

function applyOne(c: DocContent, op: DocOp, opts: { type: 'doc' | 'sheet'; rand?: () => number }, added: string[]): string {
  const taken = (): Set<string> => new Set(c.blocks.map((b) => b.id))
  const find = (id: string | undefined, what = 'id'): number => {
    if (!id) throw new OpError(`give "${what}"`)
    const k = c.blocks.findIndex((b) => b.id === id)
    if (k === -1) throw new OpError(`no block [${id}] (read the document again with doc_read for current ids)`)
    return k
  }
  const blocksOf = (md: string | undefined): DocBlock[] => {
    if (typeof md !== 'string' || !md.trim()) throw new OpError('give "markdown" with the new content')
    const t = taken()
    const bs = markdownToBlocks(stripIdMarkers(md), { taken: t, rand: opts.rand })
    if (!bs.length) throw new OpError('"markdown" has no content')
    return bs
  }
  const position = (): number => {
    if (op.after) return find(op.after, 'after') + 1
    if (op.before) return find(op.before, 'before')
    return op.at === 'start' ? 0 : c.blocks.length
  }
  const sheetOp = op.op === 'set_cells' || op.op === 'set_range' || op.op === 'clear_range'
  if (opts.type === 'sheet' && !sheetOp && op.op !== 'set_title') throw new OpError('this document is a sheet: use set_cells, set_range or clear_range')
  if (sheetOp && !c.sheet) c.sheet = { rows: 20, cols: 6, cells: {}, header: true }
  if (opts.type === 'doc' && sheetOp) throw new OpError('this document is not a sheet: use block ops (insert, replace, replace_text, table_set_cell…)')
  const table = (): DocBlock => {
    const b = c.blocks[find(op.id)]
    if (b.type !== 'table') throw new OpError(`[${b.id}] is a ${b.type}, not a table`)
    b.rows = b.rows?.length ? b.rows : [['']]
    return b
  }
  const rowIndex = (rows: string[][], allowEnd: boolean): number => {
    const r = op.row
    if (r === undefined) { if (allowEnd) return rows.length; throw new OpError('give "row" (1-based)') }
    if (!Number.isInteger(r) || r < 1 || r > rows.length + (allowEnd ? 1 : 0)) throw new OpError(`row ${r} is outside the table (it has ${rows.length} rows, counted from 1)`)
    return r - 1
  }
  const colIndex = (cols: number, allowEnd: boolean): number => {
    const k = op.col
    if (k === undefined) { if (allowEnd) return cols; throw new OpError('give "col" (1-based)') }
    if (!Number.isInteger(k) || k < 1 || k > cols + (allowEnd ? 1 : 0)) throw new OpError(`column ${k} is outside the table (it has ${cols} columns, counted from 1)`)
    return k - 1
  }

  switch (op.op) {
    case 'insert': {
      const at = position()
      const bs = blocksOf(op.markdown)
      c.blocks.splice(at, 0, ...bs)
      added.push(...bs.map((b) => b.id))
      return `inserted ${bs.map((b) => `[${b.id}]`).join(', ')}`
    }
    case 'replace': {
      const k = find(op.id)
      const old = c.blocks[k]
      const bs = blocksOf(op.markdown)
      bs[0] = { ...bs[0], id: old.id }
      c.blocks.splice(k, 1, ...bs)
      added.push(...bs.slice(1).map((b) => b.id))
      return bs.length > 1 ? `replaced [${old.id}] with ${bs.map((b) => `[${b.id}]`).join(', ')}` : `replaced [${old.id}]`
    }
    case 'replace_text': {
      if (typeof op.find !== 'string' || !op.find) throw new OpError('give "find" (exact text to look for)')
      if (typeof op.replace !== 'string') throw new OpError('give "replace" (use "" to remove the text)')
      const scope = op.id ? [c.blocks[find(op.id)]] : c.blocks
      const total = scope.reduce((s, b) => s + blockMatches(b, op.find!), 0)
      if (!total) throw new OpError(`"${op.find.slice(0, 80)}" was not found${op.id ? ` in [${op.id}]` : ''} (it must match the text exactly, Markdown included)`)
      if (op.count !== undefined && op.count !== total) throw new OpError(`expected ${op.count} match${op.count === 1 ? '' : 'es'} of "${op.find.slice(0, 60)}" but found ${total}`)
      if (op.count === undefined && total > 1 && !op.all) {
        const where = scope.filter((b) => blockMatches(b, op.find!)).map((b) => `[${b.id}]`).slice(0, 12).join(', ')
        throw new OpError(`"${op.find.slice(0, 60)}" appears ${total} times (in ${where}); give "id" to pick a block, "count": ${total} or "all": true to replace them all`)
      }
      for (const b of scope) for (const f of fields(b)) if (f.get().includes(op.find)) f.set(f.get().split(op.find).join(op.replace))
      return `replaced ${total} match${total === 1 ? '' : 'es'} of "${op.find.slice(0, 40)}"`
    }
    case 'delete': {
      const ids = new Set<string>(op.ids ?? [])
      if (op.id) ids.add(op.id)
      if (op.section) sectionIds(c.blocks, op.section).forEach((x) => ids.add(x))
      if (!ids.size) throw new OpError('give "ids" (blocks to delete) or "section" (a heading id)')
      for (const id of ids) find(id)
      c.blocks = c.blocks.filter((b) => !ids.has(b.id))
      return `deleted ${[...ids].map((x) => `[${x}]`).join(', ')}`
    }
    case 'move': {
      const ids = op.ids?.length ? op.ids : op.id ? [op.id] : []
      if (!ids.length) throw new OpError('give "ids" (blocks to move)')
      ids.forEach((x) => find(x))
      const anchor = op.after ?? op.before
      if (anchor && ids.includes(anchor)) throw new OpError(`[${anchor}] is one of the blocks being moved`)
      const set = new Set(ids)
      const moving = c.blocks.filter((b) => set.has(b.id))
      c.blocks = c.blocks.filter((b) => !set.has(b.id))
      const at = position()
      c.blocks.splice(at, 0, ...moving)
      return `moved ${ids.map((x) => `[${x}]`).join(', ')}`
    }
    case 'set_title': {
      const t = String(op.title ?? '').replace(/\s+/g, ' ').trim()
      if (!t) throw new OpError('give "title"')
      c.title = t.slice(0, 200)
      return `title set to "${c.title}"`
    }
    case 'set_checked': {
      const b = c.blocks[find(op.id)]
      if (b.type !== 'check') throw new OpError(`[${b.id}] is a ${b.type}, not a checklist item`)
      b.checked = op.checked !== false
      return `${b.checked ? 'checked' : 'unchecked'} [${b.id}]`
    }
    case 'table_add_row': {
      const b = table()
      const rows = b.rows!
      const cols = Math.max(1, ...rows.map((r) => r.length))
      const at = rowIndex(rows, true)
      const vals = (op.values ?? []).map(String)
      if (vals.length > cols) throw new OpError(`the row has ${vals.length} cells but the table has ${cols} columns (add a column first)`)
      rows.splice(at, 0, Array.from({ length: cols }, (_, k) => vals[k] ?? ''))
      return `added row ${at + 1} to [${b.id}]`
    }
    case 'table_add_col': {
      const b = table()
      const rows = b.rows!
      const cols = Math.max(1, ...rows.map((r) => r.length))
      const at = colIndex(cols, true)
      const vals = (op.values ?? []).map(String)
      if (vals.length > rows.length) throw new OpError(`the column has ${vals.length} cells but the table has ${rows.length} rows`)
      rows.forEach((r, k) => { while (r.length < cols) r.push(''); r.splice(at, 0, vals[k] ?? '') })
      return `added column ${at + 1} to [${b.id}]`
    }
    case 'table_delete_row': {
      const b = table()
      const at = rowIndex(b.rows!, false)
      if (b.rows!.length === 1) throw new OpError('a table needs at least one row (delete the table block instead)')
      b.rows!.splice(at, 1)
      return `deleted row ${at + 1} of [${b.id}]`
    }
    case 'table_delete_col': {
      const b = table()
      const cols = Math.max(1, ...b.rows!.map((r) => r.length))
      const at = colIndex(cols, false)
      if (cols === 1) throw new OpError('a table needs at least one column (delete the table block instead)')
      b.rows!.forEach((r) => r.splice(at, 1))
      return `deleted column ${at + 1} of [${b.id}]`
    }
    case 'table_set_cell': {
      const b = table()
      const rows = b.rows!
      const cols = Math.max(1, ...rows.map((r) => r.length))
      const r = rowIndex(rows, false)
      const k = colIndex(cols, false)
      while (rows[r].length < cols) rows[r].push('')
      rows[r][k] = String(op.text ?? '').replace(/\n/g, ' ')
      return `set [${b.id}] row ${r + 1}, column ${k + 1}`
    }
    case 'set_cells': {
      const s = c.sheet!
      const entries = Object.entries(op.cells ?? {})
      if (!entries.length) throw new OpError('give "cells", e.g. {"A1": "Item", "B4": "=SUM(B1:B3)"}')
      for (const [a, v] of entries) {
        const p = parseAddr(a)
        if (!p || p.r >= MAX_ROWS || p.c >= MAX_COLS) throw new OpError(`"${a}" is not a cell address like B3 (up to ${MAX_ROWS} rows and ${MAX_COLS} columns)`)
        const key = addr(p.c, p.r)
        const val = cellValue(v)
        if (val === '') delete s.cells[key]
        else s.cells[key] = val
      }
      c.sheet = fitSheet(s)
      return `set ${entries.length} cell${entries.length === 1 ? '' : 's'}`
    }
    case 'set_range': {
      const s = c.sheet!
      const p = parseAddr(op.start ?? '')
      if (!p) throw new OpError('give "start", the top-left cell like A1')
      if (!op.rows?.length) throw new OpError('give "rows": [[...], [...]]')
      let n = 0
      op.rows.forEach((row, ri) => (row ?? []).forEach((v, ci) => {
        const r = p.r + ri
        const col = p.c + ci
        if (r >= MAX_ROWS || col >= MAX_COLS) throw new OpError(`the range runs past the sheet's limit (${MAX_ROWS} rows, ${MAX_COLS} columns)`)
        const key = addr(col, r)
        const val = cellValue(v)
        if (val === '') delete s.cells[key]
        else s.cells[key] = val
        n++
      }))
      c.sheet = fitSheet(s)
      return `set ${n} cells from ${addr(p.c, p.r)}`
    }
    case 'clear_range': {
      const cells = expandRange(op.range ?? '')
      if (!cells) throw new OpError('give "range" like "A2:C9"')
      cells.forEach((k) => delete c.sheet!.cells[k])
      return `cleared ${op.range}`
    }
    default:
      throw new OpError(`unknown op "${(op as { op?: string }).op}"`)
  }
}

/**
 * What an op reads or changes, as change keys (block ids, "title", "cell:A1"), judged on the document the
 * bot last saw (`base`) and the current one (`head`). Used to tell whether the user's edits in between touch it.
 */
export function opTargets(op: DocOp, base: DocContent, head: DocContent): string[] {
  const out = new Set<string>()
  const add = (id: string | undefined): void => { if (id) out.add(id) }
  switch (op.op) {
    case 'insert': add(op.after); add(op.before); break
    case 'replace': case 'set_checked':
    case 'table_add_row': case 'table_add_col': case 'table_delete_row': case 'table_delete_col': case 'table_set_cell':
      add(op.id); break
    case 'replace_text': {
      if (op.id) { add(op.id); break }
      if (!op.find) break
      for (const doc of [base, head]) for (const b of doc.blocks) if (blockMatches(b, op.find)) add(b.id)
      break
    }
    case 'delete': {
      (op.ids ?? []).forEach(add)
      add(op.id)
      if (op.section) {
        for (const doc of [base, head]) { try { sectionIds(doc.blocks, op.section).forEach(add) } catch { add(op.section) } }
      }
      break
    }
    case 'move': (op.ids ?? []).forEach(add); add(op.id); add(op.after); add(op.before); break
    case 'set_title': out.add('title'); break
    case 'set_cells': Object.keys(op.cells ?? {}).forEach((a) => { const p = parseAddr(a); if (p) out.add(`cell:${addr(p.c, p.r)}`) }); break
    case 'set_range': {
      const p = parseAddr(op.start ?? '')
      if (p) op.rows?.forEach((row, ri) => row?.forEach((_, ci) => out.add(`cell:${addr(p.c + ci, p.r + ri)}`)))
      break
    }
    case 'clear_range': (expandRange(op.range ?? '') ?? []).forEach((a) => out.add(`cell:${a}`)); break
  }
  return [...out]
}
