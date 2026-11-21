import type { DocCellValue, DocSheet } from '@shared/types'
import { Engine, XLError, type Book } from '../docs/formula'

// A small spreadsheet engine: typed cells (numbers, text, formulas) and formulas with + - * / ^, unary
// minus, parentheses, cell refs (A1, $B$2), ranges (A1:B3) and SUM / AVERAGE / MIN / MAX / COUNT; anything else
// (IF, SUMIF, VLOOKUP, XLOOKUP, text and date functions, comparisons) goes to the full engine in docs/formula.ts.
// Pure: the editor computes values live with the same code the bot's doc_read uses.

export const MAX_ROWS = 1000
export const MAX_COLS = 52
const MAX_RANGE = 20_000

export const ERR = { div0: '#DIV/0!', ref: '#REF!', value: '#VALUE!', name: '#NAME?', cycle: '#CYCLE!', parse: '#ERROR!' } as const

// ---------------------------------------------------------------- addresses

export function colName(c: number): string {
  let s = ''
  let n = c + 1
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
  return s
}

export function colIndex(name: string): number {
  let n = 0
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** "B12" → { c: 1, r: 11 }; null if it isn't an address. */
export function parseAddr(a: string): { c: number; r: number } | null {
  const m = String(a ?? '').trim().toUpperCase().replace(/\$/g, '').match(/^([A-Z]{1,3})(\d{1,6})$/)
  if (!m) return null
  const r = Number(m[2]) - 1
  if (r < 0) return null
  return { c: colIndex(m[1]), r }
}

export const addr = (c: number, r: number): string => `${colName(c)}${r + 1}`

/** "A1:C3" → the addresses in it, row by row (null if it isn't a range). */
export function expandRange(range: string): string[] | null {
  const [a, b] = String(range ?? '').split(':')
  const p = parseAddr(a)
  const q = b === undefined ? p : parseAddr(b)
  if (!p || !q) return null
  const out: string[] = []
  const [r0, r1] = [Math.min(p.r, q.r), Math.max(p.r, q.r)]
  const [c0, c1] = [Math.min(p.c, q.c), Math.max(p.c, q.c)]
  if ((r1 - r0 + 1) * (c1 - c0 + 1) > MAX_RANGE) return null
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(addr(c, r))
  return out
}

// ---------------------------------------------------------------- typed inputs

/** A typed literal: a number ("1,200", "$5", "12%", "-3.5e2") or text. */
export function literal(raw: string): number | string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const pct = /%$/.test(s)
  const t = s.replace(/^\$|,(?=\d{3}(\D|$))/g, '').replace(/%$/, '')
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) {
    const n = Number(t)
    return pct ? n / 100 : n
  }
  return s
}

export const isFormula = (raw: string | undefined): boolean => typeof raw === 'string' && raw.trim().startsWith('=') && raw.trim().length > 1

// ---------------------------------------------------------------- formula parser

type Expr =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'ref'; a: string }
  | { k: 'range'; cells: string[] }
  | { k: 'neg'; e: Expr }
  | { k: 'bin'; op: '+' | '-' | '*' | '/' | '^'; l: Expr; r: Expr }
  | { k: 'fn'; name: string; args: Expr[] }
  | { k: 'err'; e: string }

class ParseError extends Error {
  constructor(public code: string) { super(code) }
}

const FUNCS = new Set(['SUM', 'AVERAGE', 'AVG', 'MIN', 'MAX', 'COUNT'])

export function parseFormula(src: string): Expr {
  const s = src.trim().replace(/^=/, '')
  let i = 0
  const ws = (): void => { while (i < s.length && /\s/.test(s[i])) i++ }
  const peek = (): string => { ws(); return s[i] ?? '' }
  const expr = (): Expr => {
    let l = term()
    for (let ch = peek(); ch === '+' || ch === '-'; ch = peek()) { i++; l = { k: 'bin', op: ch, l, r: term() } }
    return l
  }
  const term = (): Expr => {
    let l = power()
    for (let ch = peek(); ch === '*' || ch === '/'; ch = peek()) { i++; l = { k: 'bin', op: ch, l, r: power() } }
    return l
  }
  const power = (): Expr => {
    const base = unary()
    if (peek() === '^') { i++; return { k: 'bin', op: '^', l: base, r: power() } }
    return base
  }
  const unary = (): Expr => {
    const ch = peek()
    if (ch === '-') { i++; return { k: 'neg', e: unary() } }
    if (ch === '+') { i++; return unary() }
    return primary()
  }
  const primary = (): Expr => {
    const ch = peek()
    if (ch === '(') {
      i++
      const e = expr()
      if (peek() !== ')') throw new ParseError(ERR.parse)
      i++
      return e
    }
    if (ch === '"') {
      const end = s.indexOf('"', i + 1)
      if (end === -1) throw new ParseError(ERR.parse)
      const v = s.slice(i + 1, end)
      i = end + 1
      return { k: 'str', v }
    }
    const num = s.slice(i).match(/^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?/i)
    if (num) {
      i += num[0].length
      const v = Number(num[0].replace(/%$/, ''))
      return { k: 'num', v: num[0].endsWith('%') ? v / 100 : v }
    }
    const word = s.slice(i).match(/^\$?[A-Za-z]{1,10}\$?\d*/)
    if (word) {
      const w = word[0]
      i += w.length
      const up = w.toUpperCase()
      if (peek() === '(') {
        i++
        const args: Expr[] = []
        if (peek() !== ')') {
          for (;;) {
            args.push(arg())
            if (peek() === ',' || peek() === ';') { i++; continue }
            break
          }
        }
        if (peek() !== ')') throw new ParseError(ERR.parse)
        i++
        return FUNCS.has(up) ? { k: 'fn', name: up === 'AVG' ? 'AVERAGE' : up, args } : { k: 'err', e: ERR.name }
      }
      const a = parseAddr(w)
      if (!a) throw new ParseError(/^\$?[A-Z]+$/i.test(w) ? ERR.name : ERR.ref)
      if (peek() === ':') {
        i++
        const m = s.slice(i).match(/^\s*\$?[A-Za-z]{1,3}\$?\d+/)
        if (!m) throw new ParseError(ERR.ref)
        i += m[0].length
        const cells = expandRange(`${w}:${m[0].trim()}`)
        if (!cells) throw new ParseError(ERR.ref)
        return { k: 'range', cells }
      }
      return { k: 'ref', a: addr(a.c, a.r) }
    }
    throw new ParseError(ERR.parse)
  }
  const arg = (): Expr => expr()
  try {
    const e = expr()
    if (peek() !== '') throw new ParseError(ERR.parse)
    return e
  } catch (e) {
    return { k: 'err', e: e instanceof ParseError ? e.code : ERR.parse }
  }
}

/** The cells a formula reads. */
export function formulaRefs(e: Expr, out: Set<string> = new Set()): Set<string> {
  switch (e.k) {
    case 'ref': out.add(e.a); break
    case 'range': e.cells.forEach((c) => out.add(c)); break
    case 'neg': formulaRefs(e.e, out); break
    case 'bin': formulaRefs(e.l, out); formulaRefs(e.r, out); break
    case 'fn': e.args.forEach((x) => formulaRefs(x, out)); break
  }
  return out
}

// ---------------------------------------------------------------- evaluation

class CellError extends Error {
  constructor(public code: string) { super(code) }
}

/**
 * Computes every non-empty cell. Formulas in a reference cycle (and formulas that read them) are "#CYCLE!";
 * other errors propagate to the formulas that read the cell.
 */
/** The sheet's cells as a one-sheet workbook for the full formula engine (docs/formula.ts, 1-based rows and columns). */
function bookOver(cells: Record<string, string>): Book {
  let rows = 0, cols = 0
  for (const k of Object.keys(cells)) { const p = parseAddr(k); if (p) { rows = Math.max(rows, p.r + 1); cols = Math.max(cols, p.c + 1) } }
  return {
    sheet: () => 'Sheet1',
    cell: (_s, row, col) => {
      const raw = cells[addr(col - 1, row - 1)]
      if (raw === undefined || raw === '') return undefined
      return isFormula(raw) ? { formula: raw.trim().slice(1) } : { value: literal(raw) }
    },
    size: () => ({ rows, cols })
  }
}

export function evaluateSheet(cells: Record<string, string>): Record<string, DocCellValue> {
  const parsed = new Map<string, Expr>()
  for (const [a, raw] of Object.entries(cells)) if (isFormula(raw)) parsed.set(a, parseFormula(raw))

  // Cells on a cycle: strongly connected components of the formula graph (Tarjan, iterative-safe sizes).
  const deps = new Map<string, string[]>()
  for (const [a, e] of parsed) deps.set(a, [...formulaRefs(e)].filter((d) => parsed.has(d)))
  const cyclic = new Set<string>()
  let index = 0
  const idx = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const on = new Set<string>()
  const strong = (v: string): void => {
    idx.set(v, index); low.set(v, index); index++
    stack.push(v); on.add(v)
    for (const w of deps.get(v) ?? []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)) } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!))
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = []
      let w: string
      do { w = stack.pop()!; on.delete(w); comp.push(w) } while (w !== v)
      if (comp.length > 1 || (deps.get(v) ?? []).includes(v)) comp.forEach((c) => cyclic.add(c))
    }
  }
  for (const a of parsed.keys()) if (!idx.has(a)) strong(a)

  const memo = new Map<string, DocCellValue>()
  const value = (a: string): DocCellValue => {
    const hit = memo.get(a)
    if (hit) return hit
    const raw = cells[a]
    let out: DocCellValue
    if (!isFormula(raw)) out = { value: literal(raw ?? '') }
    else if (cyclic.has(a)) out = { value: ERR.cycle, error: ERR.cycle }
    else {
      try {
        const v = evalExpr(parsed.get(a)!)
        out = typeof v === 'number' && !Number.isFinite(v) ? { value: ERR.div0, error: ERR.div0 } : { value: v }
      } catch (e) {
        const code = e instanceof CellError ? e.code : ERR.parse
        out = { value: code, error: code }
      }
      // A function or syntax this quick engine doesn't know (IF, SUMIF, VLOOKUP, XLOOKUP, text and date
      // functions, comparisons…): the full spreadsheet engine the Excel exports use works it out.
      if (out.error === ERR.name || out.error === ERR.parse) out = fullEngine(a) ?? out
    }
    memo.set(a, out)
    return out
  }
  let engine: Engine | undefined
  const fullEngine = (a: string): DocCellValue | undefined => {
    const at = parseAddr(a)
    if (!at) return undefined
    engine ??= new Engine(bookOver(cells))
    try {
      const v = engine.cellValue('Sheet1', at.r + 1, at.c + 1)
      if (v instanceof XLError) return { value: v.code, error: v.code }
      if (typeof v === 'boolean') return { value: v ? 'TRUE' : 'FALSE' }
      if (v === null) return { value: '' }
      return typeof v === 'number' && !Number.isFinite(v) ? { value: ERR.div0, error: ERR.div0 } : { value: v }
    } catch { return undefined }
  }
  const scalar = (e: Expr): number | string => {
    if (e.k === 'range') throw new CellError(ERR.value)
    return evalExpr(e)
  }
  const num = (v: number | string): number => {
    if (typeof v === 'number') return v
    if (v === '') return 0
    throw new CellError(ERR.value)
  }
  const refValue = (a: string): number | string => {
    const v = value(a)
    if (v.error) throw new CellError(v.error)
    return v.value
  }
  const evalExpr = (e: Expr): number | string => {
    switch (e.k) {
      case 'num': return e.v
      case 'str': return e.v
      case 'err': throw new CellError(e.e)
      case 'ref': return refValue(e.a)
      case 'range': throw new CellError(ERR.value)
      case 'neg': return -num(scalar(e.e))
      case 'bin': {
        const l = num(scalar(e.l))
        const r = num(scalar(e.r))
        switch (e.op) {
          case '+': return l + r
          case '-': return l - r
          case '*': return l * r
          case '/': if (r === 0) throw new CellError(ERR.div0); return l / r
          case '^': return l ** r
        }
        break
      }
      case 'fn': {
        // Ranges and refs skip text and blanks; literal numbers always count.
        const nums: number[] = []
        for (const x of e.args) {
          if (x.k === 'range' || x.k === 'ref') {
            for (const c of x.k === 'range' ? x.cells : [x.a]) {
              const v = refValue(c)
              if (typeof v === 'number') nums.push(v)
            }
          } else {
            const v = evalExpr(x)
            if (typeof v === 'number') nums.push(v)
            else if (e.name !== 'COUNT') nums.push(num(v))
          }
        }
        switch (e.name) {
          case 'SUM': return nums.reduce((s, n) => s + n, 0)
          case 'AVERAGE': if (!nums.length) throw new CellError(ERR.div0); return nums.reduce((s, n) => s + n, 0) / nums.length
          case 'MIN': return nums.length ? Math.min(...nums) : 0
          case 'MAX': return nums.length ? Math.max(...nums) : 0
          case 'COUNT': return nums.length
        }
      }
    }
    throw new CellError(ERR.parse)
  }

  const out: Record<string, DocCellValue> = {}
  for (const a of Object.keys(cells)) if (cells[a] !== '') out[a] = value(a)
  return out
}

/** A computed value for display: numbers rounded to 10 significant digits. */
export function showValue(v: DocCellValue | undefined): string {
  if (!v) return ''
  if (typeof v.value === 'number') return Number.isInteger(v.value) ? String(v.value) : String(Number(v.value.toPrecision(10)))
  return v.value
}

// ---------------------------------------------------------------- grid helpers

export function emptySheet(rows = 20, cols = 6): DocSheet {
  return { rows, cols, cells: {}, header: true }
}

/** Grows the grid to fit every filled cell (capped). */
export function fitSheet(s: DocSheet): DocSheet {
  let rows = s.rows
  let cols = s.cols
  for (const a of Object.keys(s.cells)) {
    const p = parseAddr(a)
    if (!p) continue
    rows = Math.max(rows, p.r + 1)
    cols = Math.max(cols, p.c + 1)
  }
  return { ...s, rows: Math.min(MAX_ROWS, rows), cols: Math.min(MAX_COLS, cols) }
}

/** Rows of raw inputs (for markdown tables / CSV import) → cells. */
export function sheetFromRows(rows: Array<Array<string | number | null | undefined>>, header = true): DocSheet {
  const cells: Record<string, string> = {}
  rows.forEach((r, ri) => r.forEach((v, ci) => {
    const s = v === null || v === undefined ? '' : String(v)
    if (s !== '' && ri < MAX_ROWS && ci < MAX_COLS) cells[addr(ci, ri)] = s
  }))
  return fitSheet({ rows: Math.max(rows.length, 1), cols: Math.max(1, ...rows.map((r) => r.length)), cells, header })
}

/** The grid as rows of raw inputs (formulas as typed), trimmed to the filled area. */
export function sheetRows(s: DocSheet, computed?: Record<string, DocCellValue>): string[][] {
  let maxR = 0
  let maxC = 0
  for (const a of Object.keys(s.cells)) {
    const p = parseAddr(a)
    if (p && s.cells[a] !== '') { maxR = Math.max(maxR, p.r + 1); maxC = Math.max(maxC, p.c + 1) }
  }
  return Array.from({ length: maxR }, (_, r) => Array.from({ length: maxC }, (_, c) => {
    const a = addr(c, r)
    return computed ? showValue(computed[a]) : s.cells[a] ?? ''
  }))
}

/** Simple CSV parsing (quotes, doubled quotes, commas, newlines in quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++ } else if (ch === '"') q = false
      else cur += ch
    } else if (ch === '"' && !cur) q = true
    else if (ch === ',') { row.push(cur); cur = '' } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cur); rows.push(row); row = []; cur = ''
    } else cur += ch
  }
  if (cur || row.length) { row.push(cur); rows.push(row) }
  return rows
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (/[",\n\r]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n') + '\n'
}
