import type ExcelJSNs from 'exceljs'
import { addr, colName, colNum, Engine, fromSerial, functionsIn, parseAddr, parseRange, portableFormula, toSerial, Unsupported, XLError, type Book, type Value } from './formula'

// Excel workbooks: typed columns (text, number, integer, currency, percent, date, datetime, boolean)
// with number formats, real formulas (computed here so every reader sees results, and recomputed by
// Excel on open), totals rows, freeze panes, autofilter, conditional formatting, column widths, data
// validation lists, banding and a summary sheet. Plus reading workbooks back (values and formulas),
// editing cells and ranges in place, column statistics and CSV import.
//
// Public API (also used by the live document editor for export):
//   renderXlsx(sheets: SheetSpec[], options?: WorkbookOptions): Promise<Buffer>
//   buildXlsx(sheets, options) → { buffer, warnings, errors }

type Workbook = ExcelJSNs.Workbook
type Worksheet = ExcelJSNs.Worksheet

export type CellInput = string | number | boolean | null

export type ColumnType = 'text' | 'number' | 'integer' | 'currency' | 'percent' | 'date' | 'datetime' | 'boolean'

export interface ColumnSpec {
  header?: string
  type?: ColumnType
  /** Excel number format, e.g. '#,##0.0', '"€"#,##0.00', 'mmm d, yyyy'. Overrides the type's format. */
  format?: string
  width?: number
  /** Totals row function for this column (default: sum for number/currency/integer, none otherwise). */
  total?: 'sum' | 'average' | 'count' | 'min' | 'max' | 'none'
  /** Allowed values: a dropdown list (data validation). */
  options?: string[]
  /** Numeric limits (data validation). */
  min?: number
  max?: number
  /** A formula for every data row; {r} is the row number, e.g. "=C{r}*D{r}". */
  formula?: string
  align?: 'left' | 'center' | 'right'
}

export interface ConditionalRule {
  /** Header name or column letter; or give range. */
  column?: string
  range?: string
  type: 'greater_than' | 'less_than' | 'between' | 'equal' | 'not_equal' | 'negative' | 'text_contains' | 'duplicates' | 'blank' | 'top' | 'bottom' | 'data_bar' | 'color_scale' | 'formula'
  value?: number | string
  value2?: number
  /** top/bottom: how many. */
  count?: number
  /** 'red' | 'green' | 'yellow' | 'blue' | '#RRGGBB' */
  color?: string
  /** type 'formula': an Excel formula that is TRUE for highlighted cells, relative to the first cell (e.g. "=$E2<TODAY()"). */
  formula?: string
}

export interface SheetSpec {
  name: string
  rows: CellInput[][]
  /** First row is a header (default true). */
  header?: boolean
  widths?: number[]
  /** Typed columns, in order (headers come from here when rows don't start with a header). */
  columns?: ColumnSpec[]
  /** A totals row under the data: true, or the label text (default "Total"). */
  totals?: boolean | string
  /** Freeze the header row and/or first columns (default: header row frozen). false for none. */
  freeze?: { rows?: number; cols?: number } | false
  /** Filter buttons on the header row (default true with a header and 2+ data rows). */
  autofilter?: boolean
  conditional?: ConditionalRule[]
  /** Alternate row shading (default true). */
  banded?: boolean
  tab_color?: string
}

export interface SummaryItem {
  label: string
  /** A formula like "=SUM(Sales!D2:D40)" or a value. */
  value: string | number
  format?: string
}

export interface WorkbookOptions {
  accent?: string
  /** A Summary sheet first: true (totals and averages of every numeric column) or your own items. */
  summary?: boolean | { title?: string; items?: SummaryItem[] }
  /** Currency symbol for currency columns (default "$"). */
  currency?: string
  title?: string
  author?: string
}

const hex = (c: string | undefined, d: string): string => (/^#?[0-9a-f]{6}$/i.test(c ?? '') ? c!.replace('#', '').toUpperCase() : d)
const sheetRef = (name: string): string => (/^[A-Za-z_][\w.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`)
const safeSheetName = (n: string, used: Set<string>): string => {
  let base = n.replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Sheet'
  let name = base
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)} ${i}`
  used.add(name.toLowerCase())
  return name
}

export function formatFor(type: ColumnType | undefined, currency = '$', sample: number[] = []): string | undefined {
  switch (type) {
    case 'currency': return `"${currency}"#,##0.00;[Red]-"${currency}"#,##0.00`
    case 'percent': return '0.0%'
    case 'integer': return '#,##0'
    case 'number': return sample.some((x) => !Number.isInteger(x)) ? '#,##0.00' : '#,##0'
    case 'date': return 'yyyy-mm-dd'
    case 'datetime': return 'yyyy-mm-dd hh:mm'
    default: return undefined
  }
}

// ------------------------------------------------------------------ value parsing

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 }

/** Parses dates like 2026-11-14, 11/14/2026, 14 Nov 2026, Nov 14, 2026 (UTC midnight). */
export function parseDate(s: string): Date | undefined {
  const t = s.trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(t)
  if (m) return valid(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)))
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t)
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return valid(Date.UTC(y, +m[1] - 1, +m[2])) }
  m = /^(\d{1,2})[ -]([A-Za-z]{3,9})\.?[ -,]*(\d{4})$/.exec(t)
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] !== undefined) return valid(Date.UTC(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]))
  m = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(t)
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()] !== undefined) return valid(Date.UTC(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]))
  return undefined
}
const valid = (ms: number): Date | undefined => (Number.isFinite(ms) ? new Date(ms) : undefined)

/** "$1,234.50", "(45.00)", "12%", "1,200" → number. */
export function parseNumber(s: string): { n: number; kind: 'currency' | 'percent' | 'number' } | undefined {
  const t = s.trim()
  if (!t) return undefined
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t.replace(/^[$€£¥]\s*/, ''))
  const core = t.replace(/^\(|\)$/g, '').replace(/^-/, '').trim()
  const cur = /^([$€£¥]|USD|EUR|GBP)\s*-?([\d,]*\.?\d+)$/.exec(core) ?? /^-?([\d,]*\.?\d+)\s*([$€£¥]|USD|EUR|GBP)$/.exec(core)
  if (cur) {
    const num = Number((cur[2] && /\d/.test(cur[2]) ? cur[2] : cur[1]).replace(/,/g, ''))
    return Number.isFinite(num) ? { n: neg ? -Math.abs(num) : num, kind: 'currency' } : undefined
  }
  const pct = /^-?([\d,]*\.?\d+)\s*%$/.exec(core)
  if (pct) { const n = Number(pct[1].replace(/,/g, '')) / 100; return { n: neg ? -n : n, kind: 'percent' } }
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(core) || /^\d*\.?\d+(e[+-]?\d+)?$/i.test(core)) {
    if (/^0\d+$/.test(core)) return undefined // zip codes, IDs with leading zeros stay text
    const n = Number(core.replace(/,/g, ''))
    return Number.isFinite(n) ? { n: neg ? -n : n, kind: 'number' } : undefined
  }
  return undefined
}

/** Guesses a column's type from its values (90% of non-empty values must agree). */
export function inferType(values: CellInput[]): ColumnType {
  const vs = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
  if (!vs.length) return 'text'
  const count = (f: (v: CellInput) => boolean) => vs.filter(f).length / vs.length
  if (count((v) => typeof v === 'boolean' || /^(true|false|yes|no)$/i.test(String(v))) >= 0.95) return 'boolean'
  if (count((v) => typeof v === 'string' && parseNumber(v)?.kind === 'currency') >= 0.6 && count((v) => typeof v === 'number' || parseNumber(String(v)) !== undefined) >= 0.9) return 'currency'
  if (count((v) => typeof v === 'string' && parseNumber(v)?.kind === 'percent') >= 0.9) return 'percent'
  if (count((v) => typeof v === 'number' || parseNumber(String(v))?.kind === 'number') >= 0.9) {
    const nums = vs.map((v) => (typeof v === 'number' ? v : parseNumber(String(v))?.n ?? 0))
    return nums.every((n) => Number.isInteger(n)) ? 'integer' : 'number'
  }
  if (count((v) => typeof v === 'string' && !!parseDate(v)) >= 0.9) return vs.some((v) => /\d:\d{2}/.test(String(v))) ? 'datetime' : 'date'
  return 'text'
}

/** Converts an input value to what goes in the cell for a column type. */
function coerce(v: CellInput, type: ColumnType | undefined): ExcelJSNs.CellValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' && v.startsWith('=') && v.length > 1) return { formula: portableFormula(v) } as ExcelJSNs.CellFormulaValue
  if (typeof v !== 'string') return v
  const t = v.trim()
  switch (type) {
    case 'number': case 'integer': case 'currency': case 'percent': {
      const p = parseNumber(t)
      return p ? p.n : v
    }
    case 'date': case 'datetime': return parseDate(t) ?? v
    case 'boolean': return /^(true|yes|y|1)$/i.test(t) ? true : /^(false|no|n|0)$/i.test(t) ? false : v
    default: return v
  }
}

// ------------------------------------------------------------------ formulas on an ExcelJS workbook

function rawValue(v: ExcelJSNs.CellValue): Value {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return toSerial(v)
  if (typeof v === 'object') {
    const o = v as { formula?: string; sharedFormula?: string; result?: unknown; richText?: Array<{ text: string }>; text?: string; error?: string; hyperlink?: string }
    if (o.error) return new XLError(o.error as XLError['code'])
    if (o.richText) return o.richText.map((t) => t.text).join('')
    if (o.text !== undefined) return String(o.text)
    if ('result' in o) return rawValue(o.result as ExcelJSNs.CellValue)
    return null
  }
  return v as Value
}

export function bookOf(wb: Workbook): Book {
  const byName = new Map(wb.worksheets.map((w) => [w.name.toLowerCase(), w]))
  return {
    sheet: (n) => byName.get(n.toLowerCase())?.name,
    size: (n) => { const ws = byName.get(n.toLowerCase()); return { rows: ws?.actualRowCount ? ws.rowCount : 0, cols: ws?.columnCount ?? 0 } },
    cell: (n, r, c) => {
      const ws = byName.get(n.toLowerCase())
      if (!ws || r > ws.rowCount) return undefined
      const cell = ws.findCell(r, c)
      if (!cell) return undefined
      const f = cell.formula
      if (f) return { formula: f }
      return { value: rawValue(cell.value) }
    }
  }
}

export interface FormulaIssue { sheet: string; cell: string; formula: string; problem: string }

/**
 * Computes every formula's result and stores it with the formula (so Quick Look, previews and readers
 * see numbers), and returns formulas that give errors or use functions the checker doesn't know.
 */
export function computeWorkbook(wb: Workbook, now = new Date()): { errors: FormulaIssue[]; unverified: FormulaIssue[]; formulas: number } {
  const engine = new Engine(bookOf(wb), now)
  const errors: FormulaIssue[] = [], unverified: FormulaIssue[] = []
  let formulas = 0
  for (const ws of wb.worksheets) {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const f = cell.formula
        if (!f) return
        formulas++
        try {
          const v = engine.cellValue(ws.name, Number(cell.row), Number(cell.col))
          const where = { sheet: ws.name, cell: cell.address, formula: `=${f}` }
          if (v instanceof XLError) {
            errors.push({ ...where, problem: v.code === '#CIRC!' ? `circular reference${v.why ? ` (${v.why})` : ''}` : `${v.code}${v.why ? ` (${v.why})` : ''}` })
            if (!cell.value || typeof cell.value !== 'object' || !('sharedFormula' in cell.value)) cell.value = { formula: f, result: { error: v.code === '#CIRC!' ? '#REF!' : v.code } } as ExcelJSNs.CellFormulaValue
          } else if (!(cell.value && typeof cell.value === 'object' && 'sharedFormula' in cell.value)) {
            cell.value = { formula: f, result: v === null ? 0 : v } as ExcelJSNs.CellFormulaValue
          }
        } catch (e) {
          if (e instanceof Unsupported) unverified.push({ sheet: ws.name, cell: cell.address, formula: `=${f}`, problem: e.message })
          else throw e
        }
      })
    })
  }
  return { errors, unverified, formulas }
}

// ------------------------------------------------------------------ build

const FILL = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } })
const COLORS: Record<string, { font: string; fill: string }> = {
  red: { font: 'FF9C0006', fill: 'FFFFC7CE' },
  green: { font: 'FF006100', fill: 'FFC6EFCE' },
  yellow: { font: 'FF9C5700', fill: 'FFFFEB9C' },
  blue: { font: 'FF1E3A8A', fill: 'FFDBEAFE' }
}
const ruleColor = (c: string | undefined, d: string) => {
  if (c && /^#?[0-9a-f]{6}$/i.test(c)) { const h = c.replace('#', '').toUpperCase(); return { font: 'FF1A1A1A', fill: `FF${h}` } }
  return COLORS[(c ?? d).toLowerCase()] ?? COLORS[d]
}

export async function renderXlsx(sheets: SheetSpec[], options: WorkbookOptions = {}): Promise<Buffer> {
  return (await buildXlsx(sheets, options)).buffer
}

export async function newWorkbook(): Promise<Workbook> {
  const ExcelJS = (await import('exceljs')).default
  return new ExcelJS.Workbook()
}

interface Built { name: string; ws: Worksheet; first: number; last: number; cols: Array<{ header: string; type: ColumnType; format?: string; letter: string }> }

export async function buildXlsx(sheets: SheetSpec[], o: WorkbookOptions = {}): Promise<{ buffer: Buffer; warnings: string[]; errors: FormulaIssue[]; unverified: FormulaIssue[] }> {
  const wb = await newWorkbook()
  wb.creator = o.author ?? 'SahilBot'
  wb.title = o.title ?? ''
  wb.created = new Date()
  wb.calcProperties.fullCalcOnLoad = true
  const accent = hex(o.accent, '1F4E79')
  const warnings: string[] = []
  const used = new Set<string>()
  const wantSummary = !!o.summary
  if (wantSummary) used.add('summary')
  const built: Built[] = []
  const summaryWs = wantSummary ? wb.addWorksheet('Summary', { properties: { tabColor: { argb: `FF${accent}` } } }) : undefined

  for (const s of sheets) {
    const name = safeSheetName(s.name, used)
    if (name !== s.name) warnings.push(`Sheet "${s.name}" was renamed "${name}" (Excel allows 31 characters and no : \\ / ? * [ ]).`)
    const ws = wb.addWorksheet(name, s.tab_color ? { properties: { tabColor: { argb: `FF${hex(s.tab_color, accent)}` } } } : undefined)
    const header = s.header ?? true
    let rows = s.rows.map((r) => [...r])
    const specCols = s.columns ?? []
    // Headers from columns when the rows don't carry them.
    if (specCols.length && specCols.some((c) => c.header) && header) {
      const firstRow = rows[0]?.map((v) => String(v ?? '').trim().toLowerCase()) ?? []
      const hdrs = specCols.map((c) => c.header ?? '')
      const already = hdrs.every((h, i) => !h || firstRow[i] === h.trim().toLowerCase())
      if (!already) rows = [hdrs, ...rows]
    }
    const width = Math.max(specCols.length, ...rows.map((r) => r.length), 0)
    const dataRows = header ? rows.slice(1) : rows
    const cols = Array.from({ length: width }, (_, c) => {
      const spec = specCols[c] ?? {}
      const vals = dataRows.map((r) => r[c] ?? null).filter((v) => !(typeof v === 'string' && v.startsWith('=')))
      const type: ColumnType = spec.type ?? (spec.formula ? 'number' : inferType(vals))
      const nums = vals.map((v) => (typeof v === 'number' ? v : typeof v === 'string' ? parseNumber(v)?.n : undefined)).filter((x): x is number => x !== undefined)
      return { header: header ? String(rows[0]?.[c] ?? '') : '', type, format: spec.format ?? formatFor(type, o.currency, nums), letter: colName(c + 1), spec }
    })
    // Header row
    if (header && rows.length) {
      const r = ws.addRow(cols.map((c) => c.header))
      r.font = { bold: true, color: { argb: 'FFFFFFFF' } }
      r.alignment = { vertical: 'middle', wrapText: true }
      r.height = 22
      r.eachCell((cell) => { cell.fill = FILL(`FF${accent}`); cell.border = { bottom: { style: 'thin', color: { argb: `FF${accent}` } } } })
    }
    const first = header ? 2 : 1
    dataRows.forEach((r, i) => {
      const rowNo = first + i
      const values = cols.map((c, k) => {
        const v = r[k] ?? null
        if ((v === null || v === '') && c.spec.formula) return { formula: portableFormula(c.spec.formula.replace(/\{r\}/g, String(rowNo))) } as ExcelJSNs.CellFormulaValue
        return coerce(v, c.type)
      })
      const row = ws.addRow(values)
      cols.forEach((c, k) => {
        const cell = row.getCell(k + 1)
        if (c.format) cell.numFmt = c.format
        if (c.spec.align) cell.alignment = { horizontal: c.spec.align }
        if (typeof cell.value === 'string' && ['number', 'integer', 'currency', 'percent'].includes(c.type) && cell.value.trim()) warnings.push(`${name}!${cell.address}: "${cell.value}" is text in a ${c.type} column.`)
      })
      if ((s.banded ?? true) && i % 2 === 1) row.eachCell({ includeEmpty: true }, (cell) => { cell.fill = FILL('FFF5F7FA') })
    })
    const last = first + dataRows.length - 1
    // Totals row
    if (s.totals && dataRows.length) {
      const label = typeof s.totals === 'string' ? s.totals : 'Total'
      // Plain functions (=SUM(E2:E13)): what a person clicking the Total cell expects to see.
      const fn: Record<string, string> = { sum: 'SUM', average: 'AVERAGE', count: 'COUNT', min: 'MIN', max: 'MAX' }
      const vals = cols.map((c, k) => {
        const t = c.spec.total ?? (['number', 'integer', 'currency'].includes(c.type) ? 'sum' : 'none')
        if (k === 0 && t === 'none') return label
        if (t === 'none') return null
        return { formula: `${fn[t]}(${c.letter}${first}:${c.letter}${last})` } as ExcelJSNs.CellFormulaValue
      })
      if (vals[0] === null) vals[0] = label
      const tr = ws.addRow(vals)
      tr.font = { bold: true }
      tr.eachCell({ includeEmpty: true }, (cell) => { cell.border = { top: { style: 'thin', color: { argb: 'FF1A1A1A' } }, bottom: { style: 'double', color: { argb: 'FF1A1A1A' } } } })
      cols.forEach((c, k) => { if (c.format && k > 0) tr.getCell(k + 1).numFmt = c.format })
    }
    // Widths
    cols.forEach((c, k) => {
      const given = c.spec.width ?? s.widths?.[k]
      if (given) { ws.getColumn(k + 1).width = given; return }
      const shown = rows.map((r) => {
        const v = r[k]
        if (v === null || v === undefined) return 0
        if (typeof v === 'string' && v.startsWith('=')) return 12
        if (typeof v === 'number') return c.type === 'currency' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }).length + 4 : String(v).length + 2
        return String(v).length
      })
      ws.getColumn(k + 1).width = Math.min(60, Math.max(c.type === 'date' ? 12 : 8, Math.max(...shown, c.header.length + 2) + 2))
    })
    // Freeze, filter
    if (s.freeze !== false) {
      const fr = s.freeze === undefined ? { rows: header ? 1 : 0, cols: 0 } : s.freeze
      if ((fr.rows ?? 0) || (fr.cols ?? 0)) ws.views = [{ state: 'frozen', ySplit: fr.rows ?? 0, xSplit: fr.cols ?? 0 }]
    }
    if (header && width && (s.autofilter ?? dataRows.length >= 2)) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, last), column: width } }
    // Data validation
    cols.forEach((c, k) => {
      const sp = c.spec
      if (!sp.options?.length && sp.min === undefined && sp.max === undefined) return
      const end = Math.max(last, first) + 200
      const dvs = (ws as unknown as { dataValidations: { add(address: string, v: ExcelJSNs.DataValidation): void } }).dataValidations
      // One range per column (registered by address, so the empty rows below the data don't join the used range).
      for (const cell of [{ set dataValidation(v: ExcelJSNs.DataValidation) { dvs.add(`${addr(first, k + 1)}:${addr(end, k + 1)}`, v) } }]) {
        if (sp.options?.length) {
          const list = sp.options.map((x) => x.replace(/"/g, "'")).join(',')
          if (list.length > 250) { warnings.push(`${name} column ${c.letter}: the dropdown list is too long for Excel (255 characters); validation skipped.`); return }
          cell.dataValidation = { type: 'list', allowBlank: true, formulae: [`"${list}"`], showErrorMessage: true, errorTitle: 'Not in the list', error: `Choose one of: ${sp.options.join(', ')}` }
        } else {
          cell.dataValidation = { type: 'decimal', operator: sp.min !== undefined && sp.max !== undefined ? 'between' : sp.min !== undefined ? 'greaterThanOrEqual' : 'lessThanOrEqual', allowBlank: true, formulae: sp.min !== undefined && sp.max !== undefined ? [sp.min, sp.max] : [sp.min ?? sp.max], showErrorMessage: true, error: `Enter a number${sp.min !== undefined ? ` ≥ ${sp.min}` : ''}${sp.max !== undefined ? ` ≤ ${sp.max}` : ''}.` }
        }
      }
      // Rows that already break the rule.
      if (sp.options?.length) {
        const ok = new Set(sp.options.map((x) => x.toLowerCase()))
        dataRows.forEach((r, i) => { const v = r[k]; if (v !== null && v !== undefined && String(v).trim() && !ok.has(String(v).toLowerCase())) warnings.push(`${name}!${c.letter}${first + i}: "${v}" is not one of the allowed values.`) })
      }
    })
    // Conditional formatting
    for (const rule of s.conditional ?? []) {
      let ref = rule.range
      if (!ref && rule.column) {
        const k = cols.findIndex((c) => c.header.trim().toLowerCase() === rule.column!.trim().toLowerCase())
        const letter = k >= 0 ? cols[k].letter : /^[A-Za-z]{1,3}$/.test(rule.column) ? rule.column.toUpperCase() : undefined
        if (!letter) { warnings.push(`${name}: conditional format column "${rule.column}" not found.`); continue }
        ref = `${letter}${first}:${letter}${Math.max(first, last)}`
      }
      if (!ref) { warnings.push(`${name}: a conditional format needs a column or range.`); continue }
      const tl = ref.split(':')[0].replace(/\$/g, '')
      const col = ruleColor(rule.color, rule.type === 'negative' || rule.type === 'less_than' || rule.type === 'duplicates' || rule.type === 'blank' ? 'red' : rule.type === 'greater_than' || rule.type === 'top' ? 'green' : 'yellow')
      const style = { font: { color: { argb: col.font } }, fill: { type: 'pattern' as const, pattern: 'solid' as const, bgColor: { argb: col.fill } } }
      const q = (v: unknown) => (typeof v === 'number' ? String(v) : `"${String(v ?? '').replace(/"/g, '""')}"`)
      let r: ExcelJSNs.ConditionalFormattingRule | undefined
      switch (rule.type) {
        case 'greater_than': r = { type: 'cellIs', operator: 'greaterThan', formulae: [q(rule.value)], style, priority: 1 }; break
        case 'less_than': r = { type: 'cellIs', operator: 'lessThan', formulae: [q(rule.value)], style, priority: 1 }; break
        case 'between': r = { type: 'cellIs', operator: 'between', formulae: [q(rule.value), q(rule.value2)], style, priority: 1 }; break
        case 'equal': r = { type: 'cellIs', operator: 'equal', formulae: [q(rule.value)], style, priority: 1 }; break
        case 'not_equal': r = { type: 'expression', formulae: [`${tl}<>${q(rule.value)}`], style, priority: 1 }; break
        case 'negative': r = { type: 'cellIs', operator: 'lessThan', formulae: ['0'], style, priority: 1 }; break
        case 'text_contains': r = { type: 'containsText', operator: 'containsText', text: String(rule.value ?? ''), style, priority: 1 }; break
        case 'blank': r = { type: 'expression', formulae: [`LEN(TRIM(${tl}))=0`], style, priority: 1 }; break
        case 'duplicates': {
          const rg = parseRange(ref)!
          r = { type: 'expression', formulae: [`COUNTIF($${colName(rg.c1)}$${rg.r1}:$${colName(rg.c2)}$${rg.r2},${tl})>1`], style, priority: 1 }
          break
        }
        case 'top': case 'bottom': r = { type: 'top10', rank: rule.count ?? 3, percent: false, bottom: rule.type === 'bottom', style, priority: 1 }; break
        case 'data_bar': r = { type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: `FF${hex(rule.color, accent)}` }, gradient: false, priority: 1 } as unknown as ExcelJSNs.ConditionalFormattingRule; break
        case 'color_scale': r = { type: 'colorScale', cfvo: [{ type: 'min' }, { type: 'percentile', value: 50 }, { type: 'max' }], color: [{ argb: 'FFF8696B' }, { argb: 'FFFFEB84' }, { argb: 'FF63BE7B' }], priority: 1 }; break
        case 'formula': if (rule.formula) r = { type: 'expression', formulae: [rule.formula.replace(/^=/, '')], style, priority: 1 }; break
      }
      if (r) ws.addConditionalFormatting({ ref, rules: [r] })
    }
    ws.pageSetup = { orientation: width > 7 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: header ? '1:1' : undefined } as ExcelJSNs.PageSetup
    built.push({ name, ws, first, last, cols })
  }

  // Summary sheet
  if (summaryWs) {
    const custom = typeof o.summary === 'object' ? o.summary : undefined
    summaryWs.getCell('A1').value = custom?.title ?? o.title ?? 'Summary'
    summaryWs.getCell('A1').font = { bold: true, size: 16, color: { argb: `FF${accent}` } }
    summaryWs.getCell('A2').value = `Generated ${new Date().toISOString().slice(0, 10)}`
    summaryWs.getCell('A2').font = { italic: true, color: { argb: 'FF6B7280' } }
    const head = summaryWs.getRow(4)
    head.values = custom?.items?.length ? ['Item', 'Value'] : ['Sheet', 'Measure', 'Value']
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    head.eachCell((c) => { c.fill = FILL(`FF${accent}`) })
    let r = 5
    if (custom?.items?.length) {
      for (const it of custom.items) {
        summaryWs.getCell(r, 1).value = it.label
        summaryWs.getCell(r, 2).value = typeof it.value === 'string' && it.value.startsWith('=') ? { formula: portableFormula(it.value) } as ExcelJSNs.CellFormulaValue : it.value
        if (it.format) summaryWs.getCell(r, 2).numFmt = it.format
        r++
      }
      summaryWs.getColumn(1).width = 34
      summaryWs.getColumn(2).width = 18
    } else {
      for (const b of built) {
        if (b.last < b.first) continue
        summaryWs.getCell(r, 1).value = b.name
        summaryWs.getCell(r, 2).value = 'Rows'
        summaryWs.getCell(r, 3).value = { formula: `ROWS(${sheetRef(b.name)}!A${b.first}:A${b.last})` } as ExcelJSNs.CellFormulaValue
        r++
        for (const c of b.cols) {
          if (!['number', 'integer', 'currency', 'percent'].includes(c.type)) continue
          const rng = `${sheetRef(b.name)}!${c.letter}${b.first}:${c.letter}${b.last}`
          const measures: Array<[string, string]> = c.type === 'percent' ? [['Average', `AVERAGE(${rng})`]] : [['Total', `SUM(${rng})`], ['Average', `AVERAGE(${rng})`], ['Min', `MIN(${rng})`], ['Max', `MAX(${rng})`]]
          for (const [m, f] of measures) {
            summaryWs.getCell(r, 1).value = b.name
            summaryWs.getCell(r, 2).value = `${m} of ${c.header || c.letter}`
            summaryWs.getCell(r, 3).value = { formula: f } as ExcelJSNs.CellFormulaValue
            if (c.format) summaryWs.getCell(r, 3).numFmt = c.format
            r++
          }
        }
      }
      summaryWs.getColumn(1).width = 22
      summaryWs.getColumn(2).width = 34
      summaryWs.getColumn(3).width = 18
    }
    summaryWs.views = [{ state: 'frozen', ySplit: 4 }]
  }

  const { errors, unverified } = computeWorkbook(wb)
  for (const e of errors) warnings.push(`${e.sheet}!${e.cell} ${e.formula} gives ${e.problem}.`)
  const buffer = Buffer.from(await wb.xlsx.writeBuffer())
  return { buffer, warnings, errors, unverified }
}

// ------------------------------------------------------------------ read

export interface CellInfo {
  addr: string
  row: number
  col: number
  value: Value
  formula?: string
  format?: string
  /** 'date' when the value is a date (shown as ISO). */
  kind: 'empty' | 'number' | 'text' | 'boolean' | 'date' | 'error' | 'formula'
}

export interface SheetRead {
  name: string
  rows: number
  cols: number
  /** Used range like A1:F40. */
  dims: string
  frozen?: { rows: number; cols: number }
  autoFilter?: string
  conditionalFormats: number
  validations: number
  merged: string[]
  cells: CellInfo[]
}

export async function loadWorkbook(data: Buffer): Promise<Workbook> {
  const wb = await newWorkbook()
  await wb.xlsx.load(data as unknown as ArrayBuffer)
  return wb
}

export const isDateFmt = (f: string | undefined): boolean => {
  if (!f || /^general$/i.test(f)) return false
  const bare = f.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '')
  return /[ymd]/i.test(bare) && !/[#0?]/.test(bare.split(';')[0].replace(/[hms]+/gi, ''))
}

/** Moves the relative row references of a formula down by `d` rows (for filling a formula into a new row). */
export function shiftRows(f: string, d: number): string {
  return f.split(/("(?:[^"]|"")*")/).map((part, i) => (i % 2 ? part : part.replace(/(^|[^A-Za-z0-9_.$!'])(\$?[A-Z]{1,3})(\$?)(\d+)(?![\d(A-Za-z_])/g, (m, pre, col, abs, row) => (abs ? m : `${pre}${col}${Number(row) + d}`)))).join('')
}

/** Reads sheets (optionally one sheet and a range) with values, formulas and formats. */
export function readSheets(wb: Workbook, o: { sheet?: string; range?: string; maxCells?: number } = {}): SheetRead[] {
  const out: SheetRead[] = []
  const engine = new Engine(bookOf(wb))
  const max = o.maxCells ?? 5000
  let budget = max
  const want = o.sheet ? wb.worksheets.filter((w) => w.name.toLowerCase() === o.sheet!.toLowerCase()) : wb.worksheets
  if (o.sheet && !want.length) throw new Error(`No sheet "${o.sheet}". Sheets: ${wb.worksheets.map((w) => w.name).join(', ')}`)
  for (const ws of want) {
    const bounds = o.range ? parseRange(o.range) : undefined
    if (o.range && !bounds) throw new Error(`"${o.range}" is not a range like A1:D20.`)
    const cells: CellInfo[] = []
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      if (bounds && (r < bounds.r1 || r > bounds.r2)) return
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        if (bounds && (c < bounds.c1 || c > bounds.c2)) return
        if (budget-- <= 0) return
        const f = cell.formula
        let value: Value
        if (f) {
          const cached = rawValue(cell.value)
          try { value = engine.cellValue(ws.name, r, c) } catch { value = cached }
          if (value === null && cached !== null) value = cached
        } else value = rawValue(cell.value)
        const fmt = cell.numFmt || undefined
        const isDate = cell.value instanceof Date || (typeof value === 'number' && isDateFmt(fmt))
        const kind: CellInfo['kind'] = f ? 'formula' : value === null ? 'empty' : value instanceof XLError ? 'error' : isDate ? 'date' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'text'
        cells.push({ addr: cell.address, row: r, col: c, value, ...(f ? { formula: `=${f}` } : {}), ...(fmt && fmt !== 'General' ? { format: fmt } : {}), kind })
      })
    })
    const view = ws.views?.find((v) => v.state === 'frozen') as { xSplit?: number; ySplit?: number } | undefined
    const af = ws.autoFilter as unknown
    const cfs = (ws as unknown as { conditionalFormattings?: unknown[] }).conditionalFormattings ?? []
    const dv = (ws as unknown as { dataValidations?: { model?: Record<string, unknown> } }).dataValidations?.model ?? {}
    out.push({
      name: ws.name,
      rows: ws.actualRowCount,
      cols: ws.actualColumnCount,
      dims: ws.dimensions ? String((ws.dimensions as unknown as { range?: string }).range ?? ws.dimensions) : '',
      ...(view ? { frozen: { rows: view.ySplit ?? 0, cols: view.xSplit ?? 0 } } : {}),
      ...(af ? { autoFilter: typeof af === 'string' ? af : JSON.stringify(af) } : {}),
      conditionalFormats: cfs.length,
      validations: new Set(Object.keys(dv).filter((k) => dv[k]).map((k) => k.replace(/\d+/g, ''))).size,
      merged: ((ws as unknown as { model?: { merges?: string[] } }).model?.merges ?? []),
      cells
    })
  }
  return out
}

export function showValue(v: Value, fmt?: string): string {
  if (v === null) return ''
  if (v instanceof XLError) return v.code === '#CIRC!' ? '#REF! (circular)' : v.code
  if (typeof v === 'number') {
    if (isDateFmt(fmt)) { const d = fromSerial(v); return /h/i.test(fmt ?? '') ? d.toISOString().slice(0, 16).replace('T', ' ') : d.toISOString().slice(0, 10) }
    if (fmt?.includes('%')) return `${Number((v * 100).toFixed(4))}%`
    return String(Number.isInteger(v) ? v : Number(v.toPrecision(12)))
  }
  return String(v)
}

/** A readable dump: one line per row, cells as A1=value (formula). */
export function formatSheets(sheets: SheetRead[], maxChars = 60_000): string {
  const out: string[] = []
  for (const s of sheets) {
    const meta = [`${s.rows} rows × ${s.cols} columns`, s.dims && `used ${s.dims}`, s.frozen && `frozen ${s.frozen.rows} row(s)/${s.frozen.cols} col(s)`, s.autoFilter && 'filter on', s.conditionalFormats && `${s.conditionalFormats} conditional format(s)`, s.validations && `${s.validations} validation(s)`, s.merged.length && `merged ${s.merged.slice(0, 5).join(' ')}`].filter(Boolean).join(', ')
    out.push(`--- Sheet "${s.name}" (${meta}) ---`)
    const byRow = new Map<number, CellInfo[]>()
    for (const c of s.cells) (byRow.get(c.row) ?? byRow.set(c.row, []).get(c.row)!).push(c)
    for (const [r, cs] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
      out.push(`${r}: ${cs.map((c) => `${c.addr}=${JSON.stringify(showValue(c.value, c.format))}${c.formula ? ` (${c.formula})` : ''}`).join(' | ')}`)
    }
  }
  const t = out.join('\n')
  return t.length > maxChars ? `${t.slice(0, maxChars)}\n[… cut; read a smaller range]` : t
}

// ------------------------------------------------------------------ edit in place

export interface CellEdit {
  sheet?: string
  /** One cell like "B2" (or "Sheet!B2"), or the top-left cell of `values`. */
  cell?: string
  value?: CellInput
  /** A block of values starting at `cell`. */
  values?: CellInput[][]
  /** Rows added after the data (before a totals row, whose formulas grow to include them). */
  append?: CellInput[][]
  /** Number format for the written cells, e.g. '$#,##0.00'. */
  format?: string
  /** Create the sheet if it doesn't exist. */
  create_sheet?: boolean
}

export interface EditResult {
  changed: Array<{ sheet: string; cell: string; before: string; after: string }>
  errors: FormulaIssue[]
  unverified: FormulaIssue[]
}

/** Applies edits to a workbook (styles kept), then recomputes every formula's stored result. */
export function editWorkbook(wb: Workbook, edits: CellEdit[]): EditResult {
  const changed: EditResult['changed'] = []
  const engine0 = new Engine(bookOf(wb))
  const show = (ws: Worksheet, r: number, c: number): string => {
    const cell = ws.findCell(r, c)
    if (!cell) return ''
    let v: Value
    try { v = cell.formula ? engine0.cellValue(ws.name, r, c) : rawValue(cell.value) } catch { v = rawValue(cell.value) }
    return `${showValue(v, cell.numFmt)}${cell.formula ? ` (=${cell.formula})` : ''}`
  }
  const sheetFor = (e: CellEdit, ref?: string): { ws: Worksheet; ref?: string } => {
    let name = e.sheet, at = ref
    const m = ref ? /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(ref) : null
    if (m) { name = (m[1] ?? m[2]).replace(/''/g, "'"); at = m[3] }
    let ws = name ? wb.worksheets.find((w) => w.name.toLowerCase() === name!.toLowerCase()) : wb.worksheets[0]
    if (!ws && name && e.create_sheet) ws = wb.addWorksheet(name.slice(0, 31))
    if (!ws) throw new Error(`No sheet "${name}". Sheets: ${wb.worksheets.map((w) => w.name).join(', ')} (create_sheet: true makes a new one).`)
    return { ws, ref: at }
  }
  const put = (ws: Worksheet, r: number, c: number, v: CellInput, fmt?: string): void => {
    const before = show(ws, r, c)
    const cell = ws.getCell(r, c)
    const type: ColumnType | undefined = cell.numFmt?.includes('%') ? 'percent' : isDateFmt(cell.numFmt) ? 'date' : cell.numFmt && /[#0]/.test(cell.numFmt) ? 'number' : undefined
    cell.value = coerce(v, typeof v === 'string' && !v.startsWith('=') ? type ?? (parseNumber(v) ? 'number' : parseDate(v) ? 'date' : undefined) : undefined)
    if (fmt) cell.numFmt = fmt
    else if (cell.value instanceof Date && !isDateFmt(cell.numFmt)) cell.numFmt = 'yyyy-mm-dd'
    changed.push({ sheet: ws.name, cell: addr(r, c), before, after: '' })
  }
  for (const e of edits) {
    if (e.append?.length) {
      const { ws } = sheetFor(e)
      // The last row with content; a totals row (SUM/SUBTOTAL formulas) stays at the bottom.
      let lastRow = ws.actualRowCount ? ws.rowCount : 0
      while (lastRow > 0 && !ws.getRow(lastRow).hasValues) lastRow--
      const lastR = ws.getRow(lastRow)
      const formulas: string[] = []
      lastR.eachCell((c) => { if (c.formula) formulas.push(c.formula) })
      const isTotals = formulas.length > 0 && formulas.every((f) => /^(SUM|SUBTOTAL|AVERAGE|COUNT|COUNTA|MIN|MAX)\(/i.test(f))
      const at = isTotals ? lastRow : lastRow + 1
      const template = ws.getRow(Math.max(1, at - 1))
      if (isTotals) ws.spliceRows(at, 0, ...e.append.map(() => [] as ExcelJSNs.CellValue[]))
      e.append.forEach((vals, i) => {
        const rn = at + i
        vals.forEach((v, k) => {
          const tc = template.getCell(k + 1)
          if ((v === null || v === undefined || v === '') && tc.formula) {
            // A computed column: carry the formula down from the row above.
            ws.getCell(rn, k + 1).value = { formula: shiftRows(tc.formula, rn - Number(template.number)) } as ExcelJSNs.CellFormulaValue
            changed.push({ sheet: ws.name, cell: addr(rn, k + 1), before: '', after: '' })
          } else put(ws, rn, k + 1, v, e.format)
          const nc = ws.getCell(rn, k + 1)
          if (!e.format && tc.numFmt) nc.numFmt = tc.numFmt
          if (tc.font) nc.font = tc.font
          if (tc.border) nc.border = tc.border
          if (tc.alignment) nc.alignment = tc.alignment
        })
      })
      if (isTotals) {
        const n = e.append.length
        const totalRow = ws.getRow(at + n)
        totalRow.eachCell((c) => {
          const f = c.formula
          if (!f) return
          c.value = { formula: f.replace(/(\$?[A-Z]{1,3}\$?)(\d+):(\$?[A-Z]{1,3}\$?)(\d+)/g, (m0, a, r1, b, r2) => (Number(r2) === at - 1 ? `${a}${r1}:${b}${Number(r2) + n}` : m0)) } as ExcelJSNs.CellFormulaValue
        })
      }
      const af = ws.autoFilter as { from?: { row: number; column: number }; to?: { row: number; column: number } } | string | undefined
      if (af && typeof af === 'object' && af.to && af.to.row >= at - 1) ws.autoFilter = { from: af.from!, to: { row: af.to.row + e.append.length, column: af.to.column } }
      continue
    }
    const { ws, ref } = sheetFor(e, e.cell)
    if (!ref) throw new Error('Each edit needs a cell (like "B2"), or append rows.')
    const p = parseAddr(ref)
    if (!p) throw new Error(`"${ref}" is not a cell like B2.`)
    if (e.values?.length) e.values.forEach((row, i) => row.forEach((v, k) => put(ws, p.row + i, p.col + k, v, e.format)))
    else if (e.value !== undefined) put(ws, p.row, p.col, e.value, e.format)
    else if (e.format) { ws.getCell(p.row, p.col).numFmt = e.format; changed.push({ sheet: ws.name, cell: addr(p.row, p.col), before: show(ws, p.row, p.col), after: '' }) }
    else throw new Error(`Edit of ${ref} has no value, values or format.`)
  }
  for (const ws of wb.worksheets) compactValidations(ws)
  const { errors, unverified } = computeWorkbook(wb)
  const engine = new Engine(bookOf(wb))
  for (const ch of changed) {
    const ws = wb.getWorksheet(ch.sheet)!
    const p = parseAddr(ch.cell)!
    const cell = ws.findCell(p.row, p.col)
    let v: Value = null
    try { v = cell?.formula ? engine.cellValue(ws.name, p.row, p.col) : rawValue(cell?.value ?? null) } catch { v = rawValue(cell?.value ?? null) }
    ch.after = `${showValue(v, cell?.numFmt)}${cell?.formula ? ` (=${cell.formula})` : ''}`
  }
  return { changed, errors, unverified }
}

/**
 * Re-groups per-cell data validations (how ExcelJS reads them) into column ranges, so writing the file
 * doesn't produce overlapping ranges (ExcelJS sorts addresses as text: B10 before B2).
 */
function compactValidations(ws: Worksheet): void {
  const dv = (ws as unknown as { dataValidations?: { model: Record<string, unknown> } }).dataValidations
  if (!dv?.model) return
  const cells: Array<{ col: number; row: number; key: string; json: string; v: unknown }> = []
  const keep: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(dv.model)) {
    if (!v) continue
    const p = parseAddr(k)
    if (p) cells.push({ ...p, key: k, json: JSON.stringify(v), v })
    else keep[k] = v
  }
  cells.sort((a, b) => a.col - b.col || a.row - b.row)
  for (let i = 0; i < cells.length;) {
    let j = i
    while (j + 1 < cells.length && cells[j + 1].col === cells[i].col && cells[j + 1].row === cells[j].row + 1 && cells[j + 1].json === cells[i].json) j++
    keep[j > i ? `${addr(cells[i].row, cells[i].col)}:${addr(cells[j].row, cells[j].col)}` : cells[i].key] = cells[i].v
    i = j + 1
  }
  dv.model = keep
}

// ------------------------------------------------------------------ statistics

export interface ColumnStats {
  column: string
  header: string
  type: ColumnType
  count: number
  blanks: number
  unique: number
  sum?: number
  mean?: number
  median?: number
  min?: number | string
  max?: number | string
  stdev?: number
  top?: Array<{ value: string; count: number }>
  outliers?: number
}

/** Per-column statistics of a sheet (header row detected). */
export function columnStats(sheet: SheetRead): { headerRow: number; rows: number; columns: ColumnStats[] } {
  const grid = new Map<number, Map<number, CellInfo>>()
  for (const c of sheet.cells) (grid.get(c.row) ?? grid.set(c.row, new Map()).get(c.row)!).set(c.col, c)
  const rowNums = [...grid.keys()].sort((a, b) => a - b)
  if (!rowNums.length) return { headerRow: 0, rows: 0, columns: [] }
  const firstRow = grid.get(rowNums[0])!
  const headerLike = [...firstRow.values()].every((c) => c.kind === 'text') && rowNums.length > 1
  const headerRow = headerLike ? rowNums[0] : 0
  const dataRows = rowNums.filter((r) => r !== headerRow)
  // A totals row at the bottom (SUM/SUBTOTAL formulas) is not data.
  const lastCells = [...(grid.get(dataRows[dataRows.length - 1]) ?? new Map()).values()]
  if (lastCells.some((c) => c.formula && /^=(SUM|SUBTOTAL)\(/i.test(c.formula))) dataRows.pop()
  const colsN = Math.max(...sheet.cells.map((c) => c.col))
  const columns: ColumnStats[] = []
  for (let c = 1; c <= colsN; c++) {
    const header = headerRow ? String(firstRow.get(c)?.value ?? '') : ''
    const vals = dataRows.map((r) => grid.get(r)?.get(c))
    const present = vals.filter((v): v is CellInfo => !!v && v.value !== null && v.value !== '')
    const nums = present.map((v) => v.value).filter((v): v is number => typeof v === 'number')
    const dates = present.filter((v) => v.kind === 'date' || (v.kind === 'formula' && isDateFmt(v.format)))
    const type: ColumnType = dates.length >= present.length * 0.9 && present.length ? 'date' : nums.length >= present.length * 0.9 && present.length ? (present.some((v) => v.format?.includes('%')) ? 'percent' : present.some((v) => /[$€£¥]/.test(v.format ?? '')) ? 'currency' : nums.every(Number.isInteger) ? 'integer' : 'number') : 'text'
    const st: ColumnStats = { column: colName(c), header, type, count: present.length, blanks: vals.length - present.length, unique: new Set(present.map((v) => showValue(v.value, v.format))).size }
    if (type === 'date') {
      const ds = dates.map((v) => v.value as number).filter((x) => typeof x === 'number').sort((a, b) => a - b)
      if (ds.length) { st.min = showValue(ds[0], 'yyyy-mm-dd'); st.max = showValue(ds[ds.length - 1], 'yyyy-mm-dd') }
    } else if (type !== 'text' && nums.length) {
      const sorted = [...nums].sort((a, b) => a - b)
      const sum = nums.reduce((a, b) => a + b, 0)
      const mean = sum / nums.length
      const m = Math.floor(sorted.length / 2)
      const sd = nums.length > 1 ? Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / (nums.length - 1)) : 0
      const q1 = sorted[Math.floor(sorted.length * 0.25)], q3 = sorted[Math.floor(sorted.length * 0.75)]
      const iqr = q3 - q1
      Object.assign(st, { sum: round(sum), mean: round(mean), median: sorted.length % 2 ? sorted[m] : round((sorted[m - 1] + sorted[m]) / 2), min: sorted[0], max: sorted[sorted.length - 1], stdev: round(sd), outliers: iqr > 0 ? nums.filter((x) => x < q1 - 1.5 * iqr || x > q3 + 1.5 * iqr).length : 0 })
    } else {
      const freq = new Map<string, number>()
      for (const v of present) { const k = showValue(v.value, v.format); freq.set(k, (freq.get(k) ?? 0) + 1) }
      st.top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value: value.slice(0, 60), count }))
    }
    columns.push(st)
  }
  return { headerRow, rows: dataRows.length, columns }
}

const round = (x: number): number => Number(x.toPrecision(10))

// ------------------------------------------------------------------ CSV

/** RFC 4180 CSV (also ; and tab separated: the delimiter is detected). */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^\uFEFF/, '')
  const sample = src.split(/\r?\n/).slice(0, 5).join('\n')
  const counts = [',', ';', '\t', '|'].map((c) => [c, sample.split(c).length - 1] as const).sort((a, b) => b[1] - a[1])
  const d = delimiter ?? (counts[0][1] ? counts[0][0] : ',')
  const rows: string[][] = []
  let row: string[] = [], field = '', q = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (q) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') q = false
      else field += ch
      continue
    }
    if (ch === '"' && field === '') { q = true; continue }
    if (ch === d) { row.push(field); field = ''; continue }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
      continue
    }
    field += ch
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

/** A typed sheet from CSV rows (first row is the header). */
export function sheetFromCsv(name: string, rows: string[][], o: { totals?: boolean } = {}): SheetSpec {
  const [head, ...data] = rows
  const n = Math.max(head?.length ?? 0, ...data.map((r) => r.length))
  const columns: ColumnSpec[] = Array.from({ length: n }, (_, c) => ({ header: head?.[c] ?? colName(c + 1), type: inferType(data.map((r) => r[c] ?? null)) }))
  return { name, rows: [columns.map((c) => c.header ?? ''), ...data], columns, totals: o.totals }
}

export function toCsv(rows: Array<Array<Value>>): string {
  return rows.map((r) => r.map((v) => {
    const s = v instanceof XLError ? v.code : v === null ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }).join(',')).join('\n') + '\n'
}

/** Values of a sheet as a grid (formulas evaluated), for CSV export and comparisons. */
export function sheetGrid(s: SheetRead): Value[][] {
  if (!s.cells.length) return []
  const rows = Math.max(...s.cells.map((c) => c.row)), cols = Math.max(...s.cells.map((c) => c.col))
  const g: Value[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => null as Value))
  for (const c of s.cells) g[c.row - 1][c.col - 1] = c.kind === 'date' && typeof c.value === 'number' ? showValue(c.value, c.format || 'yyyy-mm-dd') : c.value
  return g
}

export { colNum, functionsIn }
