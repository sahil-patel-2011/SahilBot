import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { ToolEffect } from '@shared/types'
import { applyPlan, formatPlan, getPlan, planBatch, type BatchArgs } from '../../docs/batch'
import { renderDocx } from '../../docs/docx'
import { extractFromTranscript, meetingMarkdown, normalizeActions, type ActionItem, type MeetingInput } from '../../docs/meetings'
import { pdfExtract, pdfFields, pdfFill, pdfInfo, pdfMerge, pdfPageNumbers, pdfRotate, pdfSplit, pdfStamp, type Position } from '../../docs/pdf'
import { docxText, IMAGE_EXT, pdfText } from '../../docs/read'
import { parseReceipt, receiptsSheets, type Receipt } from '../../docs/receipts'
import { formatReview, reviewDocument } from '../../docs/review'
import { buildXlsx, columnStats, editWorkbook, formatSheets, loadWorkbook, parseCsv, readSheets, sheetFromCsv, type CellEdit } from '../../docs/xlsx'
import type { ToolContext, ToolDef } from '../types'
import { backup, resolvePath } from './files'

// The office tool (found with find_tools("office" / "excel" / "pdf")): spreadsheets read, edited in
// place (with a backup) and summarized; CSV to typed Excel; PDF forms listed and filled, PDFs merged,
// split, extracted, rotated, stamped and numbered; batch jobs on a folder (rename, sort, convert, archive:
// a dry-run plan first, applied only by its plan id, never deleting); receipts to an expense sheet; and
// transcripts to structured meeting notes. Plus review_document, the self-review every document gets.

export type OfficeArgs = {
  action: 'sheet_read' | 'sheet_write' | 'sheet_summarize' | 'csv_to_xlsx' | 'pdf_info' | 'pdf_fields' | 'pdf_fill' | 'pdf_merge' | 'pdf_split' | 'pdf_extract' | 'pdf_rotate' | 'pdf_stamp' | 'pdf_page_numbers' | 'batch' | 'receipts_to_sheet' | 'meeting_notes'
  path?: string
  paths?: string[]
  out?: string
  sheet?: string
  range?: string
  edits?: CellEdit[]
  totals?: boolean
  values?: Record<string, string | number | boolean | string[]>
  flatten?: boolean
  ranges?: string[]
  each?: boolean
  pages?: string
  degrees?: number
  text?: string
  position?: Position
  format?: string
  size?: number
  opacity?: number
  color?: string
  // batch
  dir?: string
  op?: BatchArgs['op']
  match?: string
  recursive?: boolean
  pattern?: string
  find?: string
  replace?: string
  case?: BatchArgs['case']
  start?: number
  order?: BatchArgs['order']
  by?: BatchArgs['by']
  to?: BatchArgs['to']
  archive_originals?: boolean
  older_than_days?: number
  plan_id?: string
  // receipts
  rows?: Array<Partial<Receipt> & { file: string }>
  // meetings
  transcript?: string
  meeting?: MeetingInput
}

type Ctx = Pick<ToolContext, 'state' | 'workspaceDir'>

const READS = new Set(['sheet_read', 'sheet_summarize', 'pdf_info', 'pdf_fields'])

/** Values that look like personal details (filling them into a form asks the user first). */
export function personalValues(values: Record<string, unknown> | undefined): string[] {
  if (!values) return []
  const KEY = /\b(name|first|last|surname|dob|birth|ssn|social|passport|license|licence|address|street|city|zip|postal|phone|mobile|email|e-mail|tax ?id|tin|ein|itin|account|routing|iban|swift|card|insurance|policy|member ?id|patient|medical|diagnosis|salary|income|signature|nationality|citizenship|gender|sex|marital)\b/i
  const VAL = /\b\d{3}-\d{2}-\d{4}\b|[\w.+-]+@[\w-]+\.[\w.-]+|\+?\d[\d\s().-]{8,}\d|\b(19|20)\d\d-\d\d-\d\d\b|\b\d{1,2}\/\d{1,2}\/(19|20)?\d\d\b/
  return Object.entries(values).filter(([k, v]) => KEY.test(k.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')) || VAL.test(String(v))).map(([k]) => k)
}

export function officeEffect(a: OfficeArgs): ToolEffect {
  if (READS.has(a.action)) return 'read'
  if (a.action === 'batch') return a.plan_id ? 'destructive' : 'read'
  return 'write_local'
}

/** A free file name next to `want` ("name (2).ext" when taken). */
function freeName(want: string): string {
  if (!existsSync(want)) return want
  const ext = extname(want), stem = want.slice(0, want.length - ext.length)
  for (let i = 2; ; i++) { const p = `${stem} (${i})${ext}`; if (!existsSync(p)) return p }
}

/** Parts of a workbook ExcelJS would drop if it rewrote the file. */
async function lossyParts(data: Buffer): Promise<string[]> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(data)
  const names = Object.keys(zip.files)
  const out: string[] = []
  if (names.some((n) => /^xl\/charts\//.test(n))) out.push('charts')
  if (names.some((n) => /^xl\/pivot(Tables|Cache)\//.test(n))) out.push('pivot tables')
  if (names.some((n) => /vbaProject\.bin$/.test(n))) out.push('macros')
  if (names.some((n) => /^xl\/slicers?\//.test(n))) out.push('slicers')
  return out
}

const sameTask = (a: string, b: string): boolean => {
  const w = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
  const x = w(a), y = w(b)
  const inter = [...x].filter((t) => y.has(t)).length
  return inter / Math.max(1, Math.min(x.size, y.size)) >= 0.5
}

export interface OfficeDeps {
  getWorkspace: () => string
  /** Markdown → PDF through the app's renderer (Chromium); without it a plain text PDF is made. */
  markdownToPdf?: (markdown: string, title: string) => Promise<Buffer>
  /**
   * receipts_to_sheet: reads a receipt image or scanned PDF with Claude vision (read_document_image);
   * null when no Anthropic key / cloud is off. Paid and budget-checked; at most 25 per call.
   */
  visionReceipt?: (file: string, signal: AbortSignal) => Promise<Omit<Receipt, 'file' | 'status'> | null>
}

export function officeTool(o: OfficeDeps): ToolDef<OfficeArgs> {
  const resolve = (p: string, ctx: Ctx) => resolvePath(p, ctx.workspaceDir || o.getWorkspace(), ctx.state.roots ?? [])
  const fileIn = (p: string | undefined, ctx: Ctx, exts?: RegExp): string => {
    if (!p) throw new Error('This action needs "path".')
    const full = resolve(p, ctx)
    if (!existsSync(full)) throw new Error(`No such file: ${p}`)
    if (lstatSync(full).isDirectory()) throw new Error(`${p} is a folder.`)
    if (exts && !exts.test(full)) throw new Error(`${basename(full)} isn't the right kind of file for this action.`)
    return full
  }
  const outPath = (want: string | undefined, fallback: string, ctx: Ctx, ext: string): string => {
    const p = want ? resolve(want, ctx) : fallback
    const fixed = extname(p).toLowerCase() === ext ? p : `${p}${ext}`
    mkdirSync(dirname(fixed), { recursive: true })
    return freeName(fixed)
  }
  const review = async (path: string): Promise<string> => {
    try { return `\n\n${formatReview(await reviewDocument(path))}` } catch (e) { return `\n\n(review skipped: ${(e as Error).message})` }
  }

  return {
    name: 'office',
    label: 'Office',
    group: 'Office',
    effect: (a) => officeEffect(a),
    hardStop: (a) => {
      if (a.action !== 'pdf_fill') return null
      const p = personalValues(a.values)
      return p.length ? `filling personal details (${p.slice(0, 5).join(', ')}) into the PDF form ${a.path ?? ''}` : null
    },
    describe: (a) => {
      switch (a.action) {
        case 'sheet_write': return `Edit ${a.path} in place (${a.edits?.length ?? 0} change${a.edits?.length === 1 ? '' : 's'}; a backup is kept)`
        case 'pdf_fill': return `Fill ${Object.keys(a.values ?? {}).length} field(s) in ${a.path}${a.flatten ? ' and flatten it' : ''} → a new PDF`
        case 'batch': {
          const p = a.plan_id ? getPlan(a.plan_id) : undefined
          return a.plan_id ? `Apply batch plan ${a.plan_id}${p ? `: ${p.items.length} file change(s) (${p.op}) in ${p.dir}; nothing is deleted` : ''}` : `Preview a batch ${a.op} in ${a.dir}`
        }
        default: return `Office ${a.action.replace(/_/g, ' ')}${a.path ? ` ${a.path}` : a.dir ? ` ${a.dir}` : ''}`
      }
    },
    description: `Excel, PDF and file-batch work (Word, PowerPoint and new files: create_document). Paths: workspace-relative, or inside folders the user attached.
- sheet_read(path, sheet?, range?: "A1:F40"): values AND formulas (computed), formats, frozen panes, filters.
- sheet_write(path, edits: [{sheet?, cell: "B2", value} | {cell: "A5", values: [[...]]} | {sheet, append: [[...]]} | {cell, format: "$#,##0.00"}]): edits in place, keeps styles, a backup is kept. "=..." is a formula; appended rows go above a totals row (whose SUM grows) and computed columns carry down. Results are recomputed and errors (#DIV/0!, #REF!) reported.
- sheet_summarize(path, sheet?): per-column type, count, blanks, unique, sum/mean/median/min/max/stdev/outliers, top values, date range.
- csv_to_xlsx(path, out?, totals?): typed columns (dates, currency, percent), header, filter, frozen header.
- pdf_info / pdf_fields(path): pages; form fields with types, options, current values, required.
- pdf_fill(path, values: {field: value}, flatten?, out?): writes a NEW filled PDF (checkboxes true/false; radio/dropdown by option). Never invent personal details: use what the user gave; personal fields ask first.
- pdf_merge(paths[], out) · pdf_split(path, ranges?: ["1-3","4-"] | each: true) · pdf_extract(path, pages: "2,5-7") · pdf_rotate(path, degrees, pages?) · pdf_stamp(path, text, position?: top-left|top-center|top-right|center|bottom-*|diagonal, pages?, size?, color?, opacity?) · pdf_page_numbers(path, format?: "Page {n} of {total}", position?, start?). All write new files.
- batch(dir, op: rename|sort|convert|archive, match?: "*.pdf", recursive?, …): returns a PLAN (dry run). rename: pattern "{date} {name}{ext}" ({n} {created} {year} {month} {parent}), find/replace, case. sort: by type|extension|year|month|first_letter|size. convert: to pdf|docx|xlsx|csv|md|txt, archive_originals?. archive: older_than_days?. Show the plan, then batch(plan_id) to apply (asks the user). Never deletes or overwrites.
- receipts_to_sheet(paths[] or dir, out?, rows?): text PDFs → vendor, date, subtotal, tax, tip, total, category; uncertain rows marked "check"; image receipts: view them with file_read and pass what you read as rows [{file, vendor, date, total, tax…}].
- meeting_notes(transcript or path (.txt/.vtt/.srt/.docx/.pdf), meeting?: {title, date, attendees, summary, decisions, actions: [{task, owner, due}], topics, questions, next_meeting}, out?: .docx|.md|.pdf): structured notes; due dates resolved from the meeting date; lists items you may have missed.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['sheet_read', 'sheet_write', 'sheet_summarize', 'csv_to_xlsx', 'pdf_info', 'pdf_fields', 'pdf_fill', 'pdf_merge', 'pdf_split', 'pdf_extract', 'pdf_rotate', 'pdf_stamp', 'pdf_page_numbers', 'batch', 'receipts_to_sheet', 'meeting_notes'] },
        path: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' }, maxItems: 200 },
        out: { type: 'string', description: 'Output file (default: next to the input, never overwriting)' },
        sheet: { type: 'string' },
        range: { type: 'string', description: 'A1-style range, e.g. "A1:F40"' },
        edits: {
          type: 'array', minItems: 1, maxItems: 500,
          items: {
            type: 'object',
            properties: {
              sheet: { type: 'string' }, cell: { type: 'string' },
              value: { type: ['string', 'number', 'boolean', 'null'] },
              values: { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } },
              append: { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } },
              format: { type: 'string' }, create_sheet: { type: 'boolean' }
            },
            additionalProperties: false
          }
        },
        totals: { type: 'boolean' },
        values: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'array'] } },
        flatten: { type: 'boolean' },
        ranges: { type: 'array', items: { type: 'string' } },
        each: { type: 'boolean' },
        pages: { type: 'string', description: 'Pages like "1-3,5,8-" or "last"' },
        degrees: { type: 'integer', enum: [90, 180, 270, -90] },
        text: { type: 'string' },
        position: { type: 'string', enum: ['top-left', 'top-center', 'top-right', 'center', 'bottom-left', 'bottom-center', 'bottom-right', 'diagonal'] },
        format: { type: 'string' },
        size: { type: 'number', minimum: 4, maximum: 200 },
        opacity: { type: 'number', minimum: 0.05, maximum: 1 },
        color: { type: 'string', pattern: '^#?[0-9A-Fa-f]{6}$' },
        dir: { type: 'string' },
        op: { type: 'string', enum: ['rename', 'sort', 'convert', 'archive'] },
        match: { type: 'string' },
        recursive: { type: 'boolean' },
        pattern: { type: 'string' },
        find: { type: 'string' },
        replace: { type: 'string' },
        case: { type: 'string', enum: ['lower', 'upper', 'title', 'kebab', 'snake'] },
        start: { type: 'integer' },
        order: { type: 'string', enum: ['name', 'date'] },
        by: { type: 'string', enum: ['type', 'extension', 'year', 'month', 'first_letter', 'size'] },
        to: { type: 'string', enum: ['pdf', 'docx', 'xlsx', 'csv', 'md', 'txt'] },
        archive_originals: { type: 'boolean' },
        older_than_days: { type: 'number', minimum: 0 },
        plan_id: { type: 'string' },
        rows: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } },
        transcript: { type: 'string' },
        meeting: { type: 'object' }
      },
      required: ['action'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { action: { enum: ['sheet_read', 'sheet_write', 'sheet_summarize', 'csv_to_xlsx', 'pdf_info', 'pdf_fields', 'pdf_fill', 'pdf_split', 'pdf_extract', 'pdf_rotate', 'pdf_stamp', 'pdf_page_numbers'] } } }, then: { required: ['path'] } },
        { if: { properties: { action: { const: 'sheet_write' } } }, then: { required: ['edits'] } },
        { if: { properties: { action: { const: 'pdf_fill' } } }, then: { required: ['values'] } },
        { if: { properties: { action: { const: 'pdf_merge' } } }, then: { required: ['paths'] } },
        { if: { properties: { action: { const: 'pdf_extract' } } }, then: { required: ['pages'] } },
        { if: { properties: { action: { const: 'pdf_rotate' } } }, then: { required: ['degrees'] } },
        { if: { properties: { action: { const: 'pdf_stamp' } } }, then: { required: ['text'] } }
      ]
    },
    async run(a, ctx) {
      switch (a.action) {
        // ---------------------------------------------------------------- spreadsheets
        case 'sheet_read': {
          const full = fileIn(a.path, ctx, /\.(xlsx|xlsm)$/i)
          const sheets = readSheets(await loadWorkbook(readFileSync(full)), { sheet: a.sheet, range: a.range, maxCells: 6000 })
          return { text: `${basename(full)}\n${formatSheets(sheets)}`, display: `read ${basename(full)}` }
        }
        case 'sheet_summarize': {
          const full = fileIn(a.path, ctx, /\.(xlsx|xlsm|csv)$/i)
          let sheets
          if (/\.csv$/i.test(full)) {
            const spec = sheetFromCsv(basename(full, '.csv').slice(0, 31), parseCsv(readFileSync(full, 'utf8')))
            sheets = readSheets(await loadWorkbook((await buildXlsx([spec])).buffer), { maxCells: 500_000 })
          } else sheets = readSheets(await loadWorkbook(readFileSync(full)), { sheet: a.sheet, maxCells: 500_000 })
          const out: string[] = []
          for (const s of sheets) {
            const st = columnStats(s)
            out.push(`--- ${s.name}: ${st.rows} data rows${st.headerRow ? ` (header in row ${st.headerRow})` : ' (no header row)'} ---`)
            for (const c of st.columns) {
              const nums = c.sum !== undefined ? `, sum ${c.sum}, mean ${c.mean}, median ${c.median}, min ${c.min}, max ${c.max}, stdev ${c.stdev}${c.outliers ? `, ${c.outliers} outlier(s)` : ''}` : c.min !== undefined ? `, from ${c.min} to ${c.max}` : ''
              const top = c.top?.length ? `, top: ${c.top.map((t) => `${t.value} (${t.count})`).join(', ')}` : ''
              out.push(`${c.column} ${c.header ? `"${c.header}" ` : ''}[${c.type}]: ${c.count} values, ${c.blanks} blank, ${c.unique} unique${nums}${top}`)
            }
          }
          return { text: out.join('\n'), display: `summarized ${basename(full)}` }
        }
        case 'sheet_write': {
          const full = fileIn(a.path, ctx, /\.(xlsx|xlsm)$/i)
          const data = readFileSync(full)
          const lossy = await lossyParts(data)
          if (lossy.length && !a.out) throw new Error(`${basename(full)} has ${lossy.join(', ')}, which this editor would drop. Edit it with the app tool in Microsoft Excel (app_help {app: "Microsoft Excel"}), or pass "out" to write an edited copy without them.`)
          const wb = await loadWorkbook(data)
          const r = editWorkbook(wb, a.edits ?? [])
          const target = a.out ? outPath(a.out, full, ctx, extname(full).toLowerCase()) : full
          if (target === full) backup(ctx.workspaceDir || o.getWorkspace(), full)
          writeFileSync(target, Buffer.from(await wb.xlsx.writeBuffer()))
          const lines = r.changed.slice(0, 60).map((c) => `${c.sheet}!${c.cell}: ${c.before || '(empty)'} → ${c.after || '(empty)'}`)
          const errs = r.errors.map((e) => `${e.sheet}!${e.cell} ${e.formula} gives ${e.problem}`)
          return {
            text: `${target === full ? 'Updated' : 'Wrote'} ${target} (${r.changed.length} cell${r.changed.length === 1 ? '' : 's'}${target === full ? '; the original is backed up' : ''}).\n${lines.join('\n')}${r.changed.length > 60 ? `\n…and ${r.changed.length - 60} more` : ''}${errs.length ? `\nFORMULA ERRORS (fix them):\n${errs.join('\n')}` : ''}${r.unverified.length ? `\n${r.unverified.length} formula(s) use functions not checked here; Excel computes them on open.` : ''}`,
            display: `edited ${basename(target)}`,
            path: target
          }
        }
        case 'csv_to_xlsx': {
          const full = fileIn(a.path, ctx, /\.(csv|tsv|txt)$/i)
          const rows = parseCsv(readFileSync(full, 'utf8'))
          if (!rows.length) throw new Error(`${basename(full)} is empty.`)
          const spec = sheetFromCsv(basename(full).replace(/\.\w+$/, '').slice(0, 31), rows, { totals: a.totals })
          const r = await buildXlsx([spec])
          const target = outPath(a.out, full.replace(/\.\w+$/, '.xlsx'), ctx, '.xlsx')
          writeFileSync(target, r.buffer)
          const types = spec.columns!.map((c) => `${c.header} (${c.type})`).join(', ')
          return { text: `Created ${target}: ${rows.length - 1} rows; columns ${types}.${r.warnings.length ? `\nNotes:\n${r.warnings.slice(0, 20).join('\n')}` : ''}${await review(target)}`, display: `created ${basename(target)}`, path: target }
        }
        // ---------------------------------------------------------------- PDF
        case 'pdf_info': {
          const full = fileIn(a.path, ctx, /\.pdf$/i)
          const i = await pdfInfo(readFileSync(full))
          const sizes = [...new Set(i.sizes.map((s) => `${s.w}×${s.h} pt${s.rotation ? ` rotated ${s.rotation}°` : ''}`))].join(', ')
          return { text: `${basename(full)}: ${i.pages} page(s), ${sizes}${i.title ? `, title "${i.title}"` : ''}${i.author ? `, author ${i.author}` : ''}${i.encrypted ? ', encrypted' : ''}${i.fields ? `, ${i.fields} form field(s) (pdf_fields lists them)` : ', no form fields'}.`, display: basename(full) }
        }
        case 'pdf_fields': {
          const full = fileIn(a.path, ctx, /\.pdf$/i)
          const fields = await pdfFields(readFileSync(full))
          if (!fields.length) return { text: `${basename(full)} has no fillable form fields. To fill a flat PDF, read it (file_read) and use pdf_stamp for text, or ask the user.`, display: basename(full) }
          const lines = fields.map((f) => `- "${f.name}" ${f.type}${f.required ? ' REQUIRED' : ''}${f.readOnly ? ' read-only' : ''}${f.page ? ` p${f.page}` : ''}${f.options?.length ? ` options: ${f.options.join(' | ')}` : ''}${f.maxLength ? ` max ${f.maxLength} chars` : ''}: ${f.value === null || f.value === '' ? '(empty)' : JSON.stringify(f.value)}`)
          return { text: `${fields.length} form field(s) in ${basename(full)}:\n${lines.join('\n')}`, display: `${fields.length} fields` }
        }
        case 'pdf_fill': {
          const full = fileIn(a.path, ctx, /\.pdf$/i)
          const r = await pdfFill(readFileSync(full), a.values ?? {}, { flatten: a.flatten })
          if (!r.filled.length) throw new Error(`No fields were filled.${r.unknown.length ? ` Unknown field names: ${r.unknown.map((u) => `"${u.name}"${u.suggestions.length ? ` (did you mean ${u.suggestions.map((x) => `"${x}"`).join(', ')}?)` : ''}`).join('; ')}.` : ''} Use pdf_fields for the exact names.`)
          const target = outPath(a.out, full.replace(/\.pdf$/i, ' (filled).pdf'), ctx, '.pdf')
          writeFileSync(target, r.buffer)
          return {
            text: [`Filled ${r.filled.length} field(s) → ${target}${a.flatten ? ' (flattened: no longer editable)' : ''}. The original is unchanged.`,
              r.unknown.length ? `Not in the form: ${r.unknown.map((u) => `"${u.name}"${u.suggestions.length ? ` (closest: ${u.suggestions.join(', ')})` : ''}`).join('; ')}` : '',
              r.problems.length ? `Problems: ${r.problems.join(' ')}` : '',
              r.missingRequired.length ? `Required fields still empty: ${r.missingRequired.join(', ')}` : ''].filter(Boolean).join('\n'),
            display: `filled ${basename(target)}`,
            path: target
          }
        }
        case 'pdf_merge': {
          const files = (a.paths ?? []).map((p) => fileIn(p, ctx, /\.pdf$/i))
          if (files.length < 2) throw new Error('pdf_merge needs at least two PDFs in "paths".')
          const r = await pdfMerge(files.map((f) => readFileSync(f)))
          const target = outPath(a.out, join(dirname(files[0]), 'Merged.pdf'), ctx, '.pdf')
          writeFileSync(target, r.buffer)
          return { text: `Merged ${files.length} PDFs (${r.pages} pages) → ${target}`, display: `merged ${files.length} PDFs`, path: target }
        }
        case 'pdf_split': {
          const full = fileIn(a.path, ctx, /\.pdf$/i)
          const parts = await pdfSplit(readFileSync(full), { ranges: a.ranges, each: a.each ?? !a.ranges?.length })
          const dir = a.out ? resolve(a.out, ctx) : dirname(full)
          mkdirSync(dir, { recursive: true })
          if (existsSync(dir) && !statSync(dir).isDirectory()) throw new Error('For pdf_split, "out" is a folder.')
          const stem = basename(full, extname(full))
          const written = parts.map((p) => {
            const label = p.pages.length === 1 ? `p${p.pages[0]}` : `p${p.pages[0]}-${p.pages[p.pages.length - 1]}`
            const t = freeName(join(dir, `${stem} ${label}.pdf`))
            writeFileSync(t, p.buffer)
            return t
          })
          return { text: `Split into ${written.length} file(s):\n${written.join('\n')}`, display: `split into ${written.length}`, path: written[0] }
        }
        case 'pdf_extract': {
          const full = fileIn(a.path, ctx, /\.pdf$/i)
          const r = await pdfExtract(readFileSync(full), a.pages!)
          const target = outPath(a.out, full.replace(/\.pdf$/i, ` (pages ${a.pages!.replace(/[^\d,-]/g, '')}).pdf`), ctx, '.pdf')
          writeFileSync(target, r.buffer)
          return { text: `Extracted page(s) ${r.pages.join(', ')} → ${target}`, display: `extracted ${r.pages.length} page(s)`, path: target }
        }
        case 'pdf_rotate': {
          const full = fileIn(a.path, ctx, /\.pdf$/i)
          const r = await pdfRotate(readFileSync(full), a.degrees!, a.pages)
          const target = outPath(a.out, full.replace(/\.pdf$/i, ' (rotated).pdf'), ctx, '.pdf')
          writeFileSync(target, r.buffer)
          return { text: `Rotated page(s) ${r.rotated.join(', ')} by ${a.degrees}° → ${target}`, display: `rotated ${r.rotated.length} page(s)`, path: target }
        }
        case 'pdf_stamp':
        case 'pdf_page_numbers': {
          const full = fileIn(a.path, ctx, /\.pdf$/i)
          const data = readFileSync(full)
          const r = a.action === 'pdf_stamp'
            ? await pdfStamp(data, { text: a.text!, pages: a.pages, position: a.position, size: a.size, color: a.color, opacity: a.opacity })
            : await pdfPageNumbers(data, { format: a.format ?? a.text, position: a.position, start: a.start, pages: a.pages, size: a.size })
          const target = outPath(a.out, full.replace(/\.pdf$/i, a.action === 'pdf_stamp' ? ' (stamped).pdf' : ' (numbered).pdf'), ctx, '.pdf')
          writeFileSync(target, r.buffer)
          return { text: `${a.action === 'pdf_stamp' ? `Stamped "${a.text}" on` : 'Numbered'} ${r.stamped.length} page(s) → ${target}`, display: basename(target), path: target }
        }
        // ---------------------------------------------------------------- batch
        case 'batch': {
          if (a.plan_id) {
            const plan = getPlan(a.plan_id)
            if (!plan) throw new Error(`No batch plan "${a.plan_id}" (plans last an hour). Run the dry run again.`)
            // The plan's folder must still be one this chat may change.
            resolve(plan.dir, ctx)
            const r = await applyPlan(plan, { markdownToPdf: o.markdownToPdf }, join(ctx.workspaceDir || o.getWorkspace(), '.foreman', 'batches'))
            const lines = r.done.slice(0, 40).map((it) => `${it.kind}: ${basename(it.from)} → ${it.to.replace(plan.dir + '/', '')}`)
            return {
              text: `Applied plan ${plan.id}: ${r.done.length} done${r.failed.length ? `, ${r.failed.length} failed` : ''}.\n${lines.join('\n')}${r.done.length > 40 ? `\n…and ${r.done.length - 40} more` : ''}${r.failed.length ? `\nFailed:\n${r.failed.map((f) => `${basename(f.item.from)}: ${f.error}`).join('\n')}` : ''}${r.log ? `\nA log of every change (to undo by hand) is at ${r.log}.` : ''}`,
              display: `${plan.op}: ${r.done.length} file(s)`
            }
          }
          if (!a.dir || !a.op) throw new Error('batch needs "dir" and "op" for a dry run, or "plan_id" to apply one.')
          const dir = resolve(a.dir, ctx)
          const plan = planBatch({ dir, op: a.op, match: a.match, recursive: a.recursive, pattern: a.pattern, find: a.find, replace: a.replace, case: a.case, start: a.start, order: a.order, by: a.by, to: a.to, archive_originals: a.archive_originals, older_than_days: a.older_than_days })
          return { text: formatPlan(plan), display: `plan: ${plan.items.length} change(s)` }
        }
        // ---------------------------------------------------------------- receipts
        case 'receipts_to_sheet': {
          let files: string[] = []
          if (a.paths?.length) files = a.paths.map((p) => fileIn(p, ctx))
          else if (a.dir) {
            const d = resolve(a.dir, ctx)
            const { readdirSync } = await import('node:fs')
            files = readdirSync(d).filter((f) => !f.startsWith('.') && /\.(pdf|png|jpe?g|heic|webp|txt)$/i.test(f)).map((f) => join(d, f)).sort()
          } else if (a.path) files = [fileIn(a.path, ctx)]
          if (!files.length && !a.rows?.length) throw new Error('receipts_to_sheet needs "paths", "dir" or rows.')
          const given = new Map((a.rows ?? []).map((r) => [basename(r.file).toLowerCase(), r]))
          const receipts: Receipt[] = []
          // No text layer: Claude vision reads it when available (o.visionReceipt), else the model looks itself.
          let visionLeft = 25
          const byVision = async (f: string): Promise<Receipt | null> => {
            if (!o.visionReceipt || visionLeft <= 0) return null
            visionLeft--
            try { const r = await o.visionReceipt(f, ctx.signal); return r ? { ...r, file: basename(f), status: r.total === undefined || !r.vendor ? 'check' : 'ok' } : null } catch { return null }
          }
          for (const f of files) {
            const g = given.get(basename(f).toLowerCase())
            if (g) { receipts.push({ status: 'ok', ...g, file: basename(f) } as Receipt); continue }
            const ext = extname(f).toLowerCase()
            if (IMAGE_EXT.has(ext)) { const v = await byVision(f); receipts.push(v ?? { file: basename(f), status: 'needs vision', notes: ['image: view it with file_read and pass the values as rows'] }); continue }
            try {
              const text = ext === '.pdf' ? (await pdfText(f)).text : readFileSync(f, 'utf8')
              if (!text.replace(/--- Page \d+ ---/g, '').trim()) { const v = await byVision(f); receipts.push(v ?? { file: basename(f), status: 'needs vision', notes: ['scanned PDF without text: view it and pass the values as rows'] }); continue }
              receipts.push(parseReceipt(text, basename(f)))
            } catch (e) {
              receipts.push({ file: basename(f), status: 'check', notes: [`couldn't read: ${(e as Error).message}`] })
            }
          }
          for (const r of a.rows ?? []) if (!files.some((f) => basename(f).toLowerCase() === basename(r.file).toLowerCase())) receipts.push({ status: 'ok', ...r, file: basename(r.file) } as Receipt)
          const built = await buildXlsx(receiptsSheets(receipts), { title: 'Expenses', summary: false })
          const base = a.dir ? resolve(a.dir, ctx) : files[0] ? dirname(files[0]) : ctx.workspaceDir || o.getWorkspace()
          const target = outPath(a.out, join(base, 'Receipts.xlsx'), ctx, '.xlsx')
          writeFileSync(target, built.buffer)
          const total = receipts.reduce((s, r) => s + (r.total ?? 0), 0)
          const lines = receipts.map((r) => `${r.file}: ${r.vendor ?? '?'} · ${r.date ?? '?'} · ${r.total !== undefined ? r.total.toFixed(2) : '?'} ${r.currency ?? ''}${r.category ? ` · ${r.category}` : ''}${r.status !== 'ok' ? ` · ${r.status.toUpperCase()}${r.notes?.length ? ` (${r.notes.join('; ')})` : ''}` : ''}`)
          const look = receipts.filter((r) => r.status === 'needs vision').map((r) => r.file)
          return {
            text: `Wrote ${target}: ${receipts.length} receipt(s), total ${total.toFixed(2)} (mixed currencies are not converted).\n${lines.join('\n')}${look.length ? `\nLook at these yourself (file_read shows the image), then call receipts_to_sheet again with rows for them: ${look.join(', ')}` : ''}${await review(target)}`,
            display: `${receipts.length} receipts`,
            path: target
          }
        }
        // ---------------------------------------------------------------- meetings
        case 'meeting_notes': {
          let raw = a.transcript ?? ''
          let src: string | undefined
          if (!raw && a.path) {
            src = fileIn(a.path, ctx)
            const ext = extname(src).toLowerCase()
            raw = ext === '.docx' ? await docxText(src) : ext === '.pdf' ? (await pdfText(src)).text.replace(/--- Page \d+ ---/g, '') : readFileSync(src, 'utf8')
          }
          const m: MeetingInput = { ...(a.meeting ?? {}) }
          if (!raw.trim() && !m.summary && !m.actions?.length && !m.decisions?.length) throw new Error('meeting_notes needs a transcript, a path, or the meeting content (summary, decisions, actions).')
          const found = raw.trim() ? extractFromTranscript(raw, m.date) : { speakers: [], decisions: [], actions: [], questions: [] }
          const given = !!m.actions?.length
          m.decisions = m.decisions?.length ? m.decisions : found.decisions
          m.questions = m.questions?.length ? m.questions : found.questions
          m.attendees = m.attendees?.length ? m.attendees : found.speakers
          const norm = normalizeActions(given ? m.actions! : found.actions, m.date)
          m.actions = norm.actions
          const missed: ActionItem[] = given ? found.actions.filter((x) => !m.actions!.some((y) => sameTask(x.task, y.task))) : []
          const title = m.title?.trim() || (m.date ? `Meeting notes ${m.date}` : 'Meeting notes')
          const body = meetingMarkdown(m)
          const want = a.out ?? `${title.replace(/[/:\\]/g, '-')}.docx`
          const ext = (extname(want).toLowerCase() || '.docx') as '.docx' | '.md' | '.pdf'
          if (!['.docx', '.md', '.pdf'].includes(ext)) throw new Error('meeting_notes writes .docx, .md or .pdf.')
          const target = outPath(want, '', ctx, ext)
          const fields = { date: m.date, time: m.time, location: m.location, facilitator: m.facilitator, attendees: m.attendees, absent: m.absent }
          if (ext === '.docx') writeFileSync(target, await renderDocx(body, { template: 'meeting_notes', fields, title }))
          else {
            const details = [['Date', m.date], ['Time', m.time], ['Location', m.location], ['Facilitator', m.facilitator], ['Attendees', m.attendees?.join(', ')], ['Absent', m.absent?.join(', ')]].filter(([, v]) => v).map(([k, v]) => `**${k}:** ${v}`).join('  \n')
            const md = `# ${title}\n\n${details ? `${details}\n\n` : ''}${body}`
            if (ext === '.md') writeFileSync(target, md)
            else {
              const { textToPdf } = await import('../../docs/pdf')
              writeFileSync(target, o.markdownToPdf ? await o.markdownToPdf(md, title) : await textToPdf(md, { title }))
            }
          }
          const acts = m.actions.map((x, i) => `${i + 1}. ${x.task} — ${x.owner ?? 'Unassigned'}${x.due_date ? `, due ${x.due_date}` : x.due ? `, due ${x.due}` : ''}`)
          return {
            text: [
              `Wrote ${target}${src ? ` from ${basename(src)}` : ''}: ${m.decisions.length} decision(s), ${m.actions.length} action item(s), ${m.questions.length} open question(s)${m.attendees.length ? `; attendees ${m.attendees.join(', ')}` : ''}.`,
              acts.length ? `Actions:\n${acts.join('\n')}` : '',
              norm.warnings.length ? `Check: ${norm.warnings.join(' ')}` : '',
              missed.length ? `Possibly missed (found in the transcript, not in your list; add them if real):\n${missed.slice(0, 10).map((x) => `- ${x.task}${x.owner ? ` (${x.owner})` : ''}${x.due ? `, ${x.due}` : ''}`).join('\n')}` : '',
              !given && raw.trim() ? 'These items came from pattern matching: read the transcript and pass meeting.summary, decisions and actions yourself for the best notes.' : '',
              ext !== '.md' ? (await review(target)).trim() : ''
            ].filter(Boolean).join('\n'),
            display: `notes: ${m.actions.length} actions`,
            path: target
          }
        }
      }
    }
  }
}

/** review_document: the self-review every generated document gets before it's presented. */
export function reviewDocumentTool(o: { getWorkspace: () => string }): ToolDef<{ path: string; source?: string; require_toc?: boolean; render?: boolean; pages?: string; expect_pages?: number }> {
  return {
    name: 'review_document',
    label: 'Review document',
    core: true,
    group: 'Office',
    effect: 'read',
    description: 'Check a finished .docx, .xlsx, .pptx or .pdf before presenting it: structure (heading order, a TOC when long, no empty sections/slides), formatting (consistent styles, slide text that overflows, #REF!/#DIV/0!, formulas that compute, totals that miss rows), content (placeholders like TBD/Lorem/[insert…], duplicated paragraphs, numbers that differ from source: a CSV/XLSX of the true figures) and common typos. It also renders the pages (no Office needed: PDF exactly, Word/PowerPoint/Excel through macOS Quick Look), reports the real page count, and checks them: blank pages, content cut off at the page edge, slide text overflowing its box, low-contrast text, a nearly empty last page, more pages than expect_pages. You get a picture of all pages (and the pages you name in "pages", e.g. "1" or "2-3") to look at yourself. Fix every FAIL by rebuilding with create_document options (fit_pages, margins, font_size, theme…), never by editing the file\'s XML, and review again (at most 2 rounds).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', pattern: '\\.(docx|xlsx|xlsm|pptx|pdf)$' },
        source: { type: 'string', description: 'CSV or XLSX whose numbers the document must match (first column labels, first row headers)' },
        require_toc: { type: 'boolean' },
        render: { type: 'boolean', description: 'Render and check the pages (default true)' },
        pages: { type: 'string', description: 'Pages to see full size, e.g. "1" or "1-2" (max 4); all pages always come as one overview picture' },
        expect_pages: { type: 'integer', minimum: 1, description: 'Most pages it should have (FAIL if more)' }
      },
      required: ['path'],
      additionalProperties: false
    },
    async run({ path, source, require_toc, render, pages, expect_pages }, ctx) {
      const ws = ctx.workspaceDir || o.getWorkspace()
      const full = resolvePath(path, ws, ctx.state.roots ?? [])
      if (!existsSync(full)) throw new Error(`No such file: ${path}`)
      let src
      if (source) {
        const s = resolvePath(source, ws, ctx.state.roots ?? [])
        if (!existsSync(s)) throw new Error(`No such source file: ${source}`)
        src = { data: readFileSync(s), name: s }
      }
      const r = await reviewDocument(full, { source: src, requireToc: require_toc, render: render !== false, expectPages: expect_pages })
      // The overview picture of every page, plus any pages asked for full size.
      const images: string[] = []
      const dataUrl = (p: string) => `data:${/\.jpe?g$/i.test(p) ? 'image/jpeg' : 'image/png'};base64,${readFileSync(p).toString('base64')}`
      if (r.rendered) {
        try {
          if (r.rendered.sheet && existsSync(r.rendered.sheet)) images.push(dataUrl(r.rendered.sheet))
          else if (r.rendered.images[0]) images.push(dataUrl(r.rendered.images[0]))
          if (pages) {
            const { parsePages } = await import('../../docs/pdf')
            const want = new Set(parsePages(pages, r.rendered.pages).slice(0, 4).map((i) => i + 1))
            r.rendered.images.forEach((p, i) => { if (want.has(i + 1) && existsSync(p)) images.push(dataUrl(p)) })
          }
        } catch { /* text review still stands */ }
      }
      const look = images.length ? `\nAttached: ${pages ? `an overview of all pages and page ${pages} full size` : 'an overview of all pages (ask for pages: "2" to see one full size)'}. Look at them: alignment, spacing, anything cut off or awkward.` : ''
      return { text: formatReview(r) + look, data: { passed: r.pass, path: full }, verification: { passed: r.pass, criterion: `Document review: ${full}`, detail: formatReview(r).slice(0, 4000) }, display: `${r.pass ? 'passed' : 'failed'} review: ${basename(full)}`, ...(images.length ? { images } : {}) }
    }
  }
}

