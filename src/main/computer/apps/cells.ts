// Spreadsheet cell addresses, shared by Numbers and Excel: "A1" ↔ (row, column), and the list of single
// cell writes for a write action (so every write is one address and one value, checked here, never a
// range string built inside a script).

export function colToNum(col: string): number {
  let n = 0
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

export function numToCol(n: number): string {
  let s = ''
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26) }
  return s
}

/** "B3" → { row: 3, col: 2 }. Throws on anything else ("$B$3" is accepted). */
export function parseCell(addr: string): { row: number; col: number } {
  const m = String(addr).trim().replace(/\$/g, '').match(/^([A-Za-z]{1,3})(\d{1,7})$/)
  if (!m) throw new Error(`"${addr}" isn't a cell address like A1 or C12.`)
  const row = Number(m[2]), col = colToNum(m[1])
  if (row < 1 || col < 1 || col > 16384) throw new Error(`"${addr}" is outside the sheet.`)
  return { row, col }
}

export const cellName = (row: number, col: number): string => `${numToCol(col)}${row}`

/** "A1:C3", "A1" or "B:B"-style is not supported: a block of cells. */
export function parseRange(r: string): { from: { row: number; col: number }; to: { row: number; col: number } } {
  const [a, b] = String(r).split(':')
  const from = parseCell(a)
  const to = b ? parseCell(b) : from
  return { from: { row: Math.min(from.row, to.row), col: Math.min(from.col, to.col) }, to: { row: Math.max(from.row, to.row), col: Math.max(from.col, to.col) } }
}

export type CellValue = string | number | boolean | null

/** Most cells one write action may change. */
export const MAX_WRITES = 2000

/**
 * The cells a write changes: either `cells` ({ "A1": "Name", "B2": 42 }) or `start` plus `values` (rows
 * of values, written right and down from start). Empty strings clear a cell; null skips it.
 */
export function cellWrites(a: { cells?: unknown; start?: unknown; values?: unknown }): Array<{ cell: string; value: CellValue }> {
  const out: Array<{ cell: string; value: CellValue }> = []
  const val = (v: unknown): CellValue => (v === null || v === undefined ? null : typeof v === 'number' || typeof v === 'boolean' ? v : String(v))
  if (a.cells && typeof a.cells === 'object' && !Array.isArray(a.cells)) {
    for (const [k, v] of Object.entries(a.cells as Record<string, unknown>)) { const p = parseCell(k); const x = val(v); if (x !== null) out.push({ cell: cellName(p.row, p.col), value: x }) }
  } else if (a.values !== undefined) {
    if (!Array.isArray(a.values)) throw new Error('values is a list of rows, e.g. [["Name", "Total"], ["Ann", 3]].')
    const s = parseCell(String(a.start ?? 'A1'))
    ;(a.values as unknown[]).forEach((row, r) => {
      const cells = Array.isArray(row) ? row : [row]
      cells.forEach((v, c) => { const x = val(v); if (x !== null) out.push({ cell: cellName(s.row + r, s.col + c), value: x }) })
    })
  } else throw new Error('Give cells ({"A1": "x"}) or start and values ([["a", "b"], [1, 2]]).')
  if (!out.length) throw new Error('Nothing to write.')
  if (out.length > MAX_WRITES) throw new Error(`That's ${out.length} cells; write at most ${MAX_WRITES} at a time.`)
  return out
}

/** Rows of values as a tab-separated table for the model, with the top-left address. */
export function formatTable(rows: unknown[][], start = 'A1'): string {
  const s = parseCell(start)
  const width = Math.max(0, ...rows.map((r) => r.length))
  const header = ['', ...Array.from({ length: width }, (_, i) => numToCol(s.col + i))].join('\t')
  const body = rows.map((r, i) => [String(s.row + i), ...r.map((v) => (v === null || v === undefined ? '' : String(v).replace(/[\t\r\n]+/g, ' ')))].join('\t'))
  return [header, ...body].join('\n')
}
