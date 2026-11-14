// A small spreadsheet formula engine: enough of Excel (arithmetic, comparisons, references and ranges
// across sheets, and ~80 common functions) to compute the results we store with every formula we write,
// and to check workbooks for #DIV/0!, #REF!, #NAME? and friends before anyone opens them.
// Unsupported functions raise Unsupported so callers can say "not verified" instead of guessing.

export type ErrorCode = '#DIV/0!' | '#N/A' | '#NAME?' | '#NULL!' | '#NUM!' | '#REF!' | '#VALUE!' | '#CIRC!'

export class XLError {
  constructor(public code: ErrorCode, public why?: string) {}
  toString(): string { return this.code }
}

export class Unsupported extends Error {}

export type Scalar = number | string | boolean | null
export type Value = Scalar | XLError
type Grid = Value[][]
type V = Value | Grid

export interface Book {
  /** The sheet's real name (case-insensitive lookup), or undefined. */
  sheet(name: string): string | undefined
  /** A cell's stored value (dates as serial numbers) or its formula (without "="). */
  cell(sheet: string, row: number, col: number): { value?: Value; formula?: string } | undefined
  /** Last used row and column, for whole-column references like A:A. */
  size(sheet: string): { rows: number; cols: number }
}

// ------------------------------------------------------------------ addresses

export function colNum(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

export function colName(n: number): string {
  let s = ''
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s
  return s
}

export function addr(row: number, col: number): string {
  return `${colName(col)}${row}`
}

/** "B12" → { row: 12, col: 2 } */
export function parseAddr(a: string): { row: number; col: number } | undefined {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(a.trim())
  return m ? { row: Number(m[2]), col: colNum(m[1]) } : undefined
}

/** "A1:C5" (or a single cell) → bounds. */
export function parseRange(r: string): { r1: number; c1: number; r2: number; c2: number } | undefined {
  const [a, b] = r.split(':')
  const p = parseAddr(a), q = b ? parseAddr(b) : p
  if (!p || !q) return undefined
  return { r1: Math.min(p.row, q.row), c1: Math.min(p.col, q.col), r2: Math.max(p.row, q.row), c2: Math.max(p.col, q.col) }
}

// ------------------------------------------------------------------ dates

const EPOCH = Date.UTC(1899, 11, 30)
export const toSerial = (d: Date): number => (d.getTime() - EPOCH) / 86400000
export const fromSerial = (n: number): Date => new Date(EPOCH + Math.round(n * 86400000))

// ------------------------------------------------------------------ tokens

type Tok =
  | { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'bool'; v: boolean } | { t: 'err'; v: ErrorCode }
  | { t: 'ref'; sheet?: string; a: string } | { t: 'range'; sheet?: string; a: string; b: string } | { t: 'cols'; sheet?: string; a: string; b: string }
  | { t: 'func'; v: string } | { t: 'name'; v: string } | { t: 'op'; v: string } | { t: '(' } | { t: ')' } | { t: ',' }

const ERRS = ['#DIV/0!', '#N/A', '#NAME?', '#NULL!', '#NUM!', '#REF!', '#VALUE!']

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const s = src.replace(/^=/, '')
  const CELL = /^\$?[A-Za-z]{1,3}\$?\d+/
  while (i < s.length) {
    const ch = s[i]
    if (/\s/.test(ch)) { i++; continue }
    if (ch === '"') {
      let j = i + 1, v = ''
      while (j < s.length) {
        if (s[j] === '"' && s[j + 1] === '"') { v += '"'; j += 2; continue }
        if (s[j] === '"') break
        v += s[j++]
      }
      out.push({ t: 'str', v }); i = j + 1; continue
    }
    if (ch === '#') {
      const e = ERRS.find((x) => s.slice(i, i + x.length).toUpperCase() === x)
      if (!e) throw new Unsupported(`Unknown error literal at "${s.slice(i, i + 8)}"`)
      out.push({ t: 'err', v: e as ErrorCode }); i += e.length; continue
    }
    if (ch === '@') { i++; continue }
    const rest = s.slice(i)
    // Sheet-qualified reference: 'My Sheet'!A1 or Data!A1:B3
    const sq = /^(?:'((?:[^']|'')+)'|([A-Za-z_\u00C0-\uFFFF][\w.\u00C0-\uFFFF]*))!/.exec(rest)
    if (sq) {
      const sheet = (sq[1] ?? sq[2]).replace(/''/g, "'")
      const after = rest.slice(sq[0].length)
      const rg = /^(\$?[A-Za-z]{1,3}\$?\d+):(\$?[A-Za-z]{1,3}\$?\d+)/.exec(after)
      const cl = /^(\$?[A-Za-z]{1,3}):(\$?[A-Za-z]{1,3})(?![\w(])/.exec(after)
      const c = CELL.exec(after)
      if (rg) { out.push({ t: 'range', sheet, a: rg[1], b: rg[2] }); i += sq[0].length + rg[0].length; continue }
      if (cl) { out.push({ t: 'cols', sheet, a: cl[1], b: cl[2] }); i += sq[0].length + cl[0].length; continue }
      if (c) { out.push({ t: 'ref', sheet, a: c[0] }); i += sq[0].length + c[0].length; continue }
      throw new Unsupported(`Can't read reference "${rest.slice(0, 20)}"`)
    }
    const rg = /^(\$?[A-Za-z]{1,3}\$?\d+):(\$?[A-Za-z]{1,3}\$?\d+)/.exec(rest)
    if (rg) { out.push({ t: 'range', a: rg[1], b: rg[2] }); i += rg[0].length; continue }
    const cl = /^(\$?[A-Za-z]{1,3}):(\$?[A-Za-z]{1,3})(?![\w(])/.exec(rest)
    if (cl && !/^\d/.test(rest)) { out.push({ t: 'cols', a: cl[1], b: cl[2] }); i += cl[0].length; continue }
    const fn = /^(?:_xlfn\.|_xlws\.)?([A-Za-z_][\w.]*)\s*\(/.exec(rest)
    if (fn) { out.push({ t: 'func', v: fn[1].toUpperCase() }); i += fn[0].length; out.push({ t: '(' }); continue }
    const c = CELL.exec(rest)
    if (c && !/^[\w]/.test(rest.slice(c[0].length))) { out.push({ t: 'ref', a: c[0] }); i += c[0].length; continue }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest)
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue }
    const word = /^[A-Za-z_][\w.]*/.exec(rest)
    if (word) {
      const w = word[0].toUpperCase()
      out.push(w === 'TRUE' || w === 'FALSE' ? { t: 'bool', v: w === 'TRUE' } : { t: 'name', v: word[0] })
      i += word[0].length
      continue
    }
    const two = s.slice(i, i + 2)
    if (two === '<=' || two === '>=' || two === '<>') { out.push({ t: 'op', v: two }); i += 2; continue }
    if ('+-*/^&=<>%'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue }
    if (ch === '(') { out.push({ t: '(' }); i++; continue }
    if (ch === ')') { out.push({ t: ')' }); i++; continue }
    if (ch === ',' || ch === ';') { out.push({ t: ',' }); i++; continue }
    throw new Unsupported(`Unexpected "${ch}" in formula`)
  }
  return out
}

// ------------------------------------------------------------------ parse

type Node =
  | { k: 'lit'; v: Value }
  | { k: 'ref'; sheet?: string; row: number; col: number }
  | { k: 'range'; sheet?: string; r1: number; c1: number; r2: number; c2: number; wholeCols?: boolean }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'un'; op: string; x: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'pct'; x: Node }
  | { k: 'name'; v: string }

function parse(tokens: Tok[]): Node {
  let i = 0
  const peek = () => tokens[i]
  const isOp = (v: string) => { const t = peek(); return t?.t === 'op' && t.v === v }
  const cmp = (): Node => {
    let a = concat()
    while (peek()?.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes((peek() as { v: string }).v)) { const op = (tokens[i++] as { v: string }).v; a = { k: 'bin', op, a, b: concat() } }
    return a
  }
  const concat = (): Node => { let a = add(); while (isOp('&')) { i++; a = { k: 'bin', op: '&', a, b: add() } } return a }
  const add = (): Node => { let a = mul(); while (isOp('+') || isOp('-')) { const op = (tokens[i++] as { v: string }).v; a = { k: 'bin', op, a, b: mul() } } return a }
  const mul = (): Node => { let a = pow(); while (isOp('*') || isOp('/')) { const op = (tokens[i++] as { v: string }).v; a = { k: 'bin', op, a, b: pow() } } return a }
  const pow = (): Node => { let a = unary(); while (isOp('^')) { i++; a = { k: 'bin', op: '^', a, b: unary() } } return a }
  const unary = (): Node => {
    if (isOp('-')) { i++; return { k: 'un', op: '-', x: unary() } }
    if (isOp('+')) { i++; return unary() }
    let x = atom()
    while (isOp('%')) { i++; x = { k: 'pct', x } }
    return x
  }
  const atom = (): Node => {
    const t = tokens[i++]
    if (!t) throw new Unsupported('Formula ends early')
    switch (t.t) {
      case 'num': return { k: 'lit', v: t.v }
      case 'str': return { k: 'lit', v: t.v }
      case 'bool': return { k: 'lit', v: t.v }
      case 'err': return { k: 'lit', v: new XLError(t.v) }
      case 'ref': { const p = parseAddr(t.a)!; return { k: 'ref', sheet: t.sheet, row: p.row, col: p.col } }
      case 'range': { const r = parseRange(`${t.a}:${t.b}`)!; return { k: 'range', sheet: t.sheet, ...r } }
      case 'cols': { const a = colNum(t.a.replace(/\$/g, '')), b = colNum(t.b.replace(/\$/g, '')); return { k: 'range', sheet: t.sheet, r1: 1, c1: Math.min(a, b), r2: 0, c2: Math.max(a, b), wholeCols: true } }
      case 'name': return { k: 'name', v: t.v }
      case 'func': {
        i++ // (
        const args: Node[] = []
        if (peek()?.t === ')') { i++; return { k: 'call', name: t.v, args } }
        for (;;) {
          if (peek()?.t === ',' || peek()?.t === ')') args.push({ k: 'lit', v: null })
          else args.push(cmp())
          const n = tokens[i++]
          if (n?.t === ')') break
          if (n?.t !== ',') throw new Unsupported(`Expected , or ) in ${t.v}()`)
        }
        return { k: 'call', name: t.v, args }
      }
      case '(': { const x = cmp(); if (tokens[i++]?.t !== ')') throw new Unsupported('Missing )'); return x }
      default: throw new Unsupported(`Unexpected token in formula`)
    }
  }
  const n = cmp()
  if (i < tokens.length) throw new Unsupported('Unexpected text after the formula')
  return n
}

const parsed = new Map<string, Node>()
export function parseFormula(f: string): Node {
  let n = parsed.get(f)
  if (!n) {
    n = parse(tokenize(f))
    if (parsed.size > 5000) parsed.clear()
    parsed.set(f, n)
  }
  return n
}

/** Function names a formula calls (upper case, without _xlfn.). */
export function functionsIn(f: string): string[] {
  try { return [...new Set(tokenize(f).filter((t) => t.t === 'func').map((t) => (t as { v: string }).v))] } catch { return [] }
}

// ------------------------------------------------------------------ evaluate

class Raise { constructor(public e: XLError) {} }
const isErr = (v: unknown): v is XLError => v instanceof XLError
const isGrid = (v: V): v is Grid => Array.isArray(v)

export class Engine {
  private memo = new Map<string, Value>()
  private stack = new Set<string>()
  /** Functions the engine doesn't know, met while evaluating. */
  unsupported = new Set<string>()
  constructor(private book: Book, private now: Date = new Date()) {}

  /** The value of a cell (evaluating its formula). */
  cellValue(sheet: string, row: number, col: number): Value {
    const key = `${sheet.toLowerCase()}!${row},${col}`
    if (this.memo.has(key)) return this.memo.get(key)!
    const c = this.book.cell(sheet, row, col)
    if (!c) return null
    if (!c.formula) return c.value ?? null
    if (this.stack.has(key)) return new XLError('#CIRC!', `circular reference at ${sheet}!${addr(row, col)}`)
    this.stack.add(key)
    let v: Value
    try {
      v = this.evalFormula(c.formula, sheet)
    } finally {
      this.stack.delete(key)
    }
    this.memo.set(key, v)
    return v
  }

  /** Evaluates a formula (with or without "=") as if it were in `sheet`. Throws Unsupported. */
  evalFormula(f: string, sheet: string): Value {
    const n = parseFormula(f)
    try {
      const v = this.ev(n, sheet)
      if (isGrid(v)) return v[0]?.[0] ?? null
      return v
    } catch (e) {
      if (e instanceof Raise) return e.e
      throw e
    }
  }

  private sheetOf(name: string | undefined, here: string): string {
    if (!name) return here
    const s = this.book.sheet(name)
    if (!s) throw new Raise(new XLError('#REF!', `no sheet named "${name}"`))
    return s
  }

  private ev(n: Node, sheet: string): V {
    switch (n.k) {
      case 'lit': return n.v
      case 'name': {
        throw new Raise(new XLError('#NAME?', `unknown name "${n.v}"`))
      }
      case 'ref': return this.cellValue(this.sheetOf(n.sheet, sheet), n.row, n.col)
      case 'range': {
        const s = this.sheetOf(n.sheet, sheet)
        const r2 = n.wholeCols ? this.book.size(s).rows : n.r2
        const g: Grid = []
        for (let r = n.r1; r <= Math.max(n.r1, r2); r++) {
          const row: Value[] = []
          for (let c = n.c1; c <= n.c2; c++) row.push(this.cellValue(s, r, c))
          g.push(row)
        }
        return g
      }
      case 'un': return -this.num(this.ev(n.x, sheet))
      case 'pct': return this.num(this.ev(n.x, sheet)) / 100
      case 'bin': {
        const a = this.scalar(this.ev(n.a, sheet)), b = this.scalar(this.ev(n.b, sheet))
        if (isErr(a)) throw new Raise(a)
        if (isErr(b)) throw new Raise(b)
        switch (n.op) {
          case '+': return this.num(a) + this.num(b)
          case '-': return this.num(a) - this.num(b)
          case '*': return this.num(a) * this.num(b)
          case '/': { const d = this.num(b); if (d === 0) throw new Raise(new XLError('#DIV/0!')); return this.num(a) / d }
          case '^': return Math.pow(this.num(a), this.num(b))
          case '&': return this.str(a) + this.str(b)
          default: return compare(a, b, n.op)
        }
      }
      case 'call': return this.call(n.name, n.args, sheet)
    }
  }

  private scalar(v: V): Value {
    if (!isGrid(v)) return v
    return v.length === 1 && v[0].length === 1 ? v[0][0] : (v[0]?.[0] ?? null)
  }

  num(v: V): number {
    const s = this.scalar(v)
    if (isErr(s)) throw new Raise(s)
    if (s === null || s === '') return 0
    if (typeof s === 'number') return s
    if (typeof s === 'boolean') return s ? 1 : 0
    const t = s.trim().replace(/,/g, '')
    const pct = t.endsWith('%')
    const x = Number(t.replace(/^\$/, '').replace(/%$/, ''))
    if (!t || !Number.isFinite(x)) throw new Raise(new XLError('#VALUE!', `"${s}" is not a number`))
    return pct ? x / 100 : x
  }

  str(v: V): string {
    const s = this.scalar(v)
    if (isErr(s)) throw new Raise(s)
    if (s === null) return ''
    if (typeof s === 'boolean') return s ? 'TRUE' : 'FALSE'
    if (typeof s === 'number') return String(Number.isInteger(s) ? s : Number(s.toPrecision(15)))
    return s
  }

  bool(v: V): boolean {
    const s = this.scalar(v)
    if (isErr(s)) throw new Raise(s)
    if (typeof s === 'boolean') return s
    if (typeof s === 'number') return s !== 0
    if (s === null || s === '') return false
    if (/^true$/i.test(s)) return true
    if (/^false$/i.test(s)) return false
    throw new Raise(new XLError('#VALUE!'))
  }

  /** Every value in the arguments, ranges flattened. `numbersOnly`: from ranges, keep numbers (Excel's rule). */
  private values(args: Node[], sheet: string): Array<{ v: Value; fromRange: boolean }> {
    const out: Array<{ v: Value; fromRange: boolean }> = []
    for (const a of args) {
      const v = this.ev(a, sheet)
      if (isGrid(v)) for (const row of v) for (const x of row) out.push({ v: x, fromRange: true })
      else out.push({ v, fromRange: false })
    }
    return out
  }

  private nums(args: Node[], sheet: string): number[] {
    const out: number[] = []
    for (const { v, fromRange } of this.values(args, sheet)) {
      if (isErr(v)) throw new Raise(v)
      if (fromRange) { if (typeof v === 'number') out.push(v) }
      else out.push(this.num(v))
    }
    return out
  }

  private grid(n: Node, sheet: string): Grid {
    const v = this.ev(n, sheet)
    return isGrid(v) ? v : [[v]]
  }

  private call(name: string, args: Node[], sheet: string): V {
    const A = (i: number): V => (args[i] ? this.ev(args[i], sheet) : null)
    const N = (i: number, d?: number): number => (args[i] === undefined || (args[i].k === 'lit' && (args[i] as { v: Value }).v === null && d !== undefined) ? d ?? 0 : this.num(A(i)))
    const S = (i: number): string => this.str(A(i))
    const need = (min: number, max = Infinity) => { if (args.length < min || args.length > max) throw new Raise(new XLError('#VALUE!', `${name} takes ${min}${max === Infinity ? '+' : max === min ? '' : `-${max}`} arguments`)) }
    const round = (x: number, d: number, mode: 'n' | 'u' | 'd') => {
      const f = Math.pow(10, d)
      const y = Math.abs(x) * f
      const r = mode === 'n' ? Math.round(Number(y.toPrecision(15))) : mode === 'u' ? Math.ceil(Number(y.toPrecision(15))) : Math.floor(Number(y.toPrecision(15)))
      return (Math.sign(x) * r) / f
    }
    switch (name) {
      case 'SUM': return this.nums(args, sheet).reduce((a, b) => a + b, 0)
      case 'PRODUCT': return this.nums(args, sheet).reduce((a, b) => a * b, 1)
      case 'AVERAGE': { const x = this.nums(args, sheet); if (!x.length) throw new Raise(new XLError('#DIV/0!')); return x.reduce((a, b) => a + b, 0) / x.length }
      case 'MIN': { const x = this.nums(args, sheet); return x.length ? Math.min(...x) : 0 }
      case 'MAX': { const x = this.nums(args, sheet); return x.length ? Math.max(...x) : 0 }
      case 'MEDIAN': { const x = this.nums(args, sheet).sort((a, b) => a - b); if (!x.length) throw new Raise(new XLError('#NUM!')); const m = Math.floor(x.length / 2); return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2 }
      case 'STDEV': case 'STDEV.S': case 'STDEV.P': case 'VAR': case 'VAR.S': case 'VAR.P': {
        const x = this.nums(args, sheet)
        const pop = name.endsWith('.P')
        if (x.length < (pop ? 1 : 2)) throw new Raise(new XLError('#DIV/0!'))
        const mean = x.reduce((a, b) => a + b, 0) / x.length
        const v = x.reduce((a, b) => a + (b - mean) ** 2, 0) / (x.length - (pop ? 0 : 1))
        return name.startsWith('VAR') ? v : Math.sqrt(v)
      }
      case 'LARGE': case 'SMALL': { const x = this.nums([args[0]], sheet).sort((a, b) => (name === 'LARGE' ? b - a : a - b)); const k = N(1); if (k < 1 || k > x.length) throw new Raise(new XLError('#NUM!')); return x[k - 1] }
      case 'COUNT': return this.values(args, sheet).filter(({ v, fromRange }) => typeof v === 'number' || (!fromRange && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))).length
      case 'COUNTA': return this.values(args, sheet).filter(({ v }) => v !== null && v !== '').length
      case 'COUNTBLANK': return this.values(args, sheet).filter(({ v }) => v === null || v === '').length
      case 'SUBTOTAL': {
        const fnum = N(0) % 100
        const map: Record<number, string> = { 1: 'AVERAGE', 2: 'COUNT', 3: 'COUNTA', 4: 'MAX', 5: 'MIN', 6: 'PRODUCT', 7: 'STDEV', 8: 'STDEV.P', 9: 'SUM', 10: 'VAR', 11: 'VAR.P' }
        if (!map[fnum]) throw new Raise(new XLError('#VALUE!'))
        return this.call(map[fnum], args.slice(1), sheet)
      }
      case 'ROUND': need(1, 2); return round(N(0), N(1, 0), 'n')
      case 'ROUNDUP': need(1, 2); return round(N(0), N(1, 0), 'u')
      case 'ROUNDDOWN': case 'TRUNC': return round(N(0), N(1, 0), 'd')
      case 'INT': return Math.floor(N(0))
      case 'ABS': return Math.abs(N(0))
      case 'SIGN': return Math.sign(N(0))
      case 'MOD': { const d = N(1); if (d === 0) throw new Raise(new XLError('#DIV/0!')); const a = N(0); return a - d * Math.floor(a / d) }
      case 'POWER': return Math.pow(N(0), N(1))
      case 'SQRT': { const x = N(0); if (x < 0) throw new Raise(new XLError('#NUM!')); return Math.sqrt(x) }
      case 'EXP': return Math.exp(N(0))
      case 'LN': { const x = N(0); if (x <= 0) throw new Raise(new XLError('#NUM!')); return Math.log(x) }
      case 'LOG10': return Math.log10(N(0))
      case 'PI': return Math.PI
      case 'CEILING': case 'CEILING.MATH': { const s = N(1, 1) || 1; return Math.ceil(N(0) / s) * s }
      case 'FLOOR': case 'FLOOR.MATH': { const s = N(1, 1) || 1; return Math.floor(N(0) / s) * s }
      case 'IF': { need(2, 3); return this.bool(A(0)) ? A(1) : args[2] ? A(2) : false }
      case 'IFS': {
        for (let k = 0; k + 1 < args.length; k += 2) if (this.bool(A(k))) return A(k + 1)
        throw new Raise(new XLError('#N/A'))
      }
      case 'IFERROR': case 'IFNA': {
        try {
          const v = this.ev(args[0], sheet)
          const s = isGrid(v) ? v[0]?.[0] : v
          if (isErr(s) && (name === 'IFERROR' || s.code === '#N/A')) return A(1)
          return v
        } catch (e) {
          if (e instanceof Raise && (name === 'IFERROR' || e.e.code === '#N/A')) return A(1)
          throw e
        }
      }
      case 'AND': return this.values(args, sheet).filter(({ v }) => v !== null && v !== '').every(({ v }) => this.bool(v))
      case 'OR': return this.values(args, sheet).filter(({ v }) => v !== null && v !== '').some(({ v }) => this.bool(v))
      case 'XOR': return this.values(args, sheet).filter(({ v }) => this.bool(v)).length % 2 === 1
      case 'NOT': return !this.bool(A(0))
      case 'TRUE': return true
      case 'FALSE': return false
      case 'NA': throw new Raise(new XLError('#N/A'))
      case 'ISBLANK': { const v = this.scalar(A(0)); return v === null }
      case 'ISNUMBER': return typeof this.scalar(A(0)) === 'number'
      case 'ISTEXT': return typeof this.scalar(A(0)) === 'string'
      case 'ISERROR': try { return isErr(this.scalar(A(0))) } catch (e) { if (e instanceof Raise) return true; throw e }
      case 'ISNA': try { const v = this.scalar(A(0)); return isErr(v) && v.code === '#N/A' } catch (e) { if (e instanceof Raise) return e.e.code === '#N/A'; throw e }
      case 'N': { const v = this.scalar(A(0)); return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : 0 }
      case 'ROWS': case 'COLUMNS': {
        const n = args[0]
        if (n?.k === 'range') return name === 'ROWS' ? (n.wholeCols ? this.book.size(this.sheetOf(n.sheet, sheet)).rows : n.r2 - n.r1 + 1) : n.c2 - n.c1 + 1
        if (n?.k === 'ref') return 1
        const g = this.grid(n, sheet)
        return name === 'ROWS' ? g.length : g[0]?.length ?? 0
      }
      case 'CHOOSE': { const k = Math.floor(N(0)); if (k < 1 || k >= args.length) throw new Raise(new XLError('#VALUE!')); return A(k) }
      case 'SUMIF': case 'COUNTIF': case 'AVERAGEIF': {
        const range = this.grid(args[0], sheet).flat()
        const crit = this.scalar(A(1))
        const sumR = name !== 'COUNTIF' && args[2] ? this.grid(args[2], sheet).flat() : range
        const hits = range.map((v, k) => (matches(v, crit) ? k : -1)).filter((k) => k >= 0)
        if (name === 'COUNTIF') return hits.length
        const vals = hits.map((k) => sumR[k]).filter((v): v is number => typeof v === 'number')
        if (name === 'SUMIF') return vals.reduce((a, b) => a + b, 0)
        if (!vals.length) throw new Raise(new XLError('#DIV/0!'))
        return vals.reduce((a, b) => a + b, 0) / vals.length
      }
      case 'SUMIFS': case 'COUNTIFS': case 'AVERAGEIFS': case 'MAXIFS': case 'MINIFS': {
        const start = name === 'COUNTIFS' ? 0 : 1
        const target = name === 'COUNTIFS' ? undefined : this.grid(args[0], sheet).flat()
        const pairs: Array<[Value[], Value]> = []
        for (let k = start; k + 1 < args.length; k += 2) pairs.push([this.grid(args[k], sheet).flat(), this.scalar(A(k + 1))])
        const len = pairs[0]?.[0].length ?? 0
        const hits: number[] = []
        for (let k = 0; k < len; k++) if (pairs.every(([r, c]) => matches(r[k], c))) hits.push(k)
        if (name === 'COUNTIFS') return hits.length
        const vals = hits.map((k) => target![k]).filter((v): v is number => typeof v === 'number')
        if (name === 'SUMIFS') return vals.reduce((a, b) => a + b, 0)
        if (name === 'MAXIFS') return vals.length ? Math.max(...vals) : 0
        if (name === 'MINIFS') return vals.length ? Math.min(...vals) : 0
        if (!vals.length) throw new Raise(new XLError('#DIV/0!'))
        return vals.reduce((a, b) => a + b, 0) / vals.length
      }
      case 'SUMPRODUCT': {
        const gs = args.map((a) => this.grid(a, sheet).flat())
        const len = gs[0]?.length ?? 0
        if (gs.some((g) => g.length !== len)) throw new Raise(new XLError('#VALUE!'))
        let t = 0
        for (let k = 0; k < len; k++) t += gs.reduce((p, g) => p * (typeof g[k] === 'number' ? (g[k] as number) : typeof g[k] === 'boolean' ? Number(g[k]) : 0), 1)
        return t
      }
      case 'VLOOKUP': case 'HLOOKUP': {
        need(3, 4)
        const key = this.scalar(A(0))
        let g = this.grid(args[1], sheet)
        if (name === 'HLOOKUP') g = g[0].map((_, c) => g.map((r) => r[c]))
        const idx = Math.floor(N(2))
        const approx = args[3] ? this.bool(A(3)) : true
        if (idx < 1 || idx > (g[0]?.length ?? 0)) throw new Raise(new XLError('#REF!'))
        const col = g.map((r) => r[0])
        const k = approx ? approxIndex(col, key) : col.findIndex((v) => equal(v, key))
        if (k < 0) throw new Raise(new XLError('#N/A'))
        return g[k][idx - 1]
      }
      case 'MATCH': {
        const key = this.scalar(A(0))
        const list = this.grid(args[1], sheet).flat()
        const type = args[2] ? N(2) : 1
        const k = type === 0 ? list.findIndex((v) => matches(v, typeof key === 'string' && /[*?]/.test(key) ? key : key, true)) : type === 1 ? approxIndex(list, key) : approxIndexDesc(list, key)
        if (k < 0) throw new Raise(new XLError('#N/A'))
        return k + 1
      }
      case 'INDEX': {
        const g = this.grid(args[0], sheet)
        let r = Math.floor(N(1, 0)), c = Math.floor(N(2, 0))
        if (g.length === 1 && args.length === 2) { c = r; r = 1 }
        if (!r && !c) throw new Raise(new XLError('#VALUE!'))
        r ||= 1; c ||= 1
        if (r < 1 || r > g.length || c < 1 || c > (g[0]?.length ?? 0)) throw new Raise(new XLError('#REF!'))
        return g[r - 1][c - 1]
      }
      case 'XLOOKUP': {
        need(3, 6)
        const key = this.scalar(A(0))
        const look = this.grid(args[1], sheet)
        const ret = this.grid(args[2], sheet)
        const vertical = look.length > 1 || (look[0]?.length ?? 0) === 1
        const list = vertical ? look.map((r) => r[0]) : look[0]
        const k = list.findIndex((v) => equal(v, key))
        if (k < 0) {
          if (args[3] && !(args[3].k === 'lit' && (args[3] as { v: Value }).v === null)) return A(3)
          throw new Raise(new XLError('#N/A'))
        }
        return vertical ? ret[k]?.[0] ?? null : ret[0]?.[k] ?? null
      }
      case 'CONCAT': case 'CONCATENATE': return this.values(args, sheet).map(({ v }) => this.str(v)).join('')
      case 'TEXTJOIN': {
        const delim = S(0), skip = this.bool(A(1))
        return this.values(args.slice(2), sheet).map(({ v }) => this.str(v)).filter((x) => !skip || x !== '').join(delim)
      }
      case 'LEN': return S(0).length
      case 'LEFT': return S(0).slice(0, N(1, 1))
      case 'RIGHT': { const s = S(0), n = N(1, 1); return n ? s.slice(-n) : '' }
      case 'MID': return S(0).substr(Math.max(0, N(1) - 1), N(2))
      case 'UPPER': return S(0).toUpperCase()
      case 'LOWER': return S(0).toLowerCase()
      case 'PROPER': return S(0).toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase())
      case 'TRIM': return S(0).trim().replace(/ +/g, ' ')
      case 'SUBSTITUTE': return S(0).split(S(1)).join(S(2))
      case 'REPT': return S(0).repeat(Math.max(0, N(1)))
      case 'FIND': case 'SEARCH': {
        const hay = name === 'SEARCH' ? S(1).toLowerCase() : S(1), needle = name === 'SEARCH' ? S(0).toLowerCase() : S(0)
        const k = hay.indexOf(needle, Math.max(0, N(2, 1) - 1))
        if (k < 0) throw new Raise(new XLError('#VALUE!'))
        return k + 1
      }
      case 'VALUE': return this.num(S(0))
      case 'TEXT': return textFormat(this.scalar(A(0)), S(1))
      case 'EXACT': return S(0) === S(1)
      case 'DATE': return toSerial(new Date(Date.UTC(N(0), N(1) - 1, N(2))))
      case 'YEAR': return fromSerial(N(0)).getUTCFullYear()
      case 'MONTH': return fromSerial(N(0)).getUTCMonth() + 1
      case 'DAY': return fromSerial(N(0)).getUTCDate()
      case 'WEEKDAY': return fromSerial(N(0)).getUTCDay() + 1
      case 'TODAY': return Math.floor(toSerial(new Date(Date.UTC(this.now.getFullYear(), this.now.getMonth(), this.now.getDate()))))
      case 'NOW': return toSerial(this.now)
      case 'DAYS': return Math.floor(N(0)) - Math.floor(N(1))
      case 'EDATE': case 'EOMONTH': {
        const d = fromSerial(N(0)), m = N(1)
        const t = name === 'EDATE' ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m, d.getUTCDate())) : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m + 1, 0))
        return Math.floor(toSerial(t))
      }
      default:
        this.unsupported.add(name)
        throw new Unsupported(`${name}() is not supported by the checker`)
    }
  }
}

function compare(a: Value, b: Value, op: string): boolean {
  const norm = (v: Value) => (v === null ? '' : v)
  let x: Value = norm(a), y: Value = norm(b)
  // Excel: numbers < text < booleans; blank equals 0 or "".
  if (x === '' && typeof y === 'number') x = 0
  if (y === '' && typeof x === 'number') y = 0
  const rank = (v: Value) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2)
  let c: number
  if (rank(x) !== rank(y)) c = rank(x) - rank(y)
  else if (typeof x === 'string') c = x.toLowerCase().localeCompare((y as string).toLowerCase())
  else c = Number(x) - Number(y)
  switch (op) {
    case '=': return c === 0
    case '<>': return c !== 0
    case '<': return c < 0
    case '>': return c > 0
    case '<=': return c <= 0
    default: return c >= 0
  }
}

function equal(a: Value, b: Value): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.trim().toLowerCase() === b.trim().toLowerCase()
  if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '' && Number(b) === a) return true
  if (typeof b === 'number' && typeof a === 'string' && a.trim() !== '' && Number(a) === b) return true
  return a === b
}

function approxIndex(list: Value[], key: Value): number {
  let k = -1
  for (let i = 0; i < list.length; i++) {
    const v = list[i]
    if (v === null || isErr(v)) continue
    if (typeof v !== typeof key) continue
    if (compare(v, key, '<=')) k = i
    else break
  }
  return k
}

function approxIndexDesc(list: Value[], key: Value): number {
  let k = -1
  for (let i = 0; i < list.length; i++) {
    const v = list[i]
    if (v === null || isErr(v)) continue
    if (compare(v, key, '>=')) k = i
    else break
  }
  return k
}

/** Excel criteria: 5, ">5", "<>x", "=a", "a*b?" (wildcards). */
function matches(v: Value, crit: Value, exactOnly = false): boolean {
  if (isErr(v) || isErr(crit)) return false
  if (typeof crit === 'number' || typeof crit === 'boolean') return equal(v, crit)
  if (crit === null) return v === null || v === ''
  const m = exactOnly ? null : /^(<=|>=|<>|=|<|>)(.*)$/.exec(crit)
  const op = m?.[1] ?? '='
  const rhsRaw = m ? m[2] : crit
  const rhsNum = rhsRaw.trim() !== '' && Number.isFinite(Number(rhsRaw)) ? Number(rhsRaw) : undefined
  if (rhsNum !== undefined && typeof v === 'number') return compare(v, rhsNum, op)
  if (op === '=' || op === '<>') {
    let eq: boolean
    if (rhsRaw === '') eq = v === null || v === ''
    else if (/[*?]/.test(rhsRaw)) {
      const re = new RegExp(`^${rhsRaw.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/~\*/g, '\u0001').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\u0001/g, '\\*')}$`, 'i')
      eq = v !== null && re.test(String(v))
    } else eq = equal(v, rhsNum ?? rhsRaw)
    return op === '=' ? eq : !eq
  }
  if (typeof v !== 'string' || rhsNum !== undefined) return false
  return compare(v, rhsRaw, op)
}

/** TEXT(value, format) for the common formats. */
export function textFormat(v: Value, fmt: string): string {
  if (isErr(v)) throw new Raise(v)
  if (typeof v !== 'number') return v === null ? '' : String(v)
  const f = fmt.trim()
  if (/[ymd]/i.test(f) && !/[#0]/.test(f)) {
    const d = fromSerial(v)
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    return f.replace(/yyyy|yy|mmmm|mmm|mm|m|dd|d/gi, (t) => {
      switch (t.toLowerCase()) {
        case 'yyyy': return String(d.getUTCFullYear())
        case 'yy': return String(d.getUTCFullYear()).slice(-2)
        case 'mmmm': return d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
        case 'mmm': return MON[d.getUTCMonth()]
        case 'mm': return String(d.getUTCMonth() + 1).padStart(2, '0')
        case 'm': return String(d.getUTCMonth() + 1)
        case 'dd': return String(d.getUTCDate()).padStart(2, '0')
        default: return String(d.getUTCDate())
      }
    })
  }
  const pct = f.includes('%')
  const x = pct ? v * 100 : v
  const dec = (/\.(0+)/.exec(f)?.[1].length) ?? 0
  const grouped = f.includes(',')
  const body = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: grouped })
  const prefix = (/^[^#0]*/.exec(f)?.[0] ?? '').replace(/"/g, '')
  return `${x < 0 ? '-' : ''}${prefix}${body}${pct ? '%' : ''}`
}

// ------------------------------------------------------------------ rewriting

/** Splits a function's argument text at top-level commas. */
function splitArgs(s: string): string[] {
  const out: string[] = []
  let depth = 0, cur = '', q = false
  for (const ch of s) {
    if (ch === '"') q = !q
    if (!q && ch === '(') depth++
    if (!q && ch === ')') depth--
    if (!q && depth === 0 && ch === ',') { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out.map((x) => x.trim())
}

/**
 * Rewrites functions older Excel, Numbers, LibreOffice and Google Sheets imports may not have into
 * equivalents that work everywhere: XLOOKUP(key, keys, values[, if_not_found]) becomes
 * IFERROR(INDEX(values, MATCH(key, keys, 0)), if_not_found).
 */
export function portableFormula(f: string): string {
  let s = f.replace(/^=/, '')
  for (let guard = 0; guard < 20; guard++) {
    const m = /(?:_xlfn\.)?XLOOKUP\s*\(/i.exec(s)
    if (!m) break
    // Find the matching parenthesis.
    let depth = 0, end = -1, q = false
    for (let i = m.index + m[0].length - 1; i < s.length; i++) {
      if (s[i] === '"') q = !q
      if (q) continue
      if (s[i] === '(') depth++
      else if (s[i] === ')') { depth--; if (depth === 0) { end = i; break } }
    }
    if (end < 0) break
    const args = splitArgs(s.slice(m.index + m[0].length, end))
    if (args.length < 3 || args.length > 4) break
    const [key, keys, vals, nf] = args
    const repl = `IFERROR(INDEX(${vals},MATCH(${key},${keys},0)),${nf && nf.length ? nf : 'NA()'})`
    s = s.slice(0, m.index) + repl + s.slice(end + 1)
  }
  return s
}
