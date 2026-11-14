import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'

// Batch file jobs on a folder: rename (patterns, find/replace, case), sort into subfolders (by type,
// extension, year, month, first letter, size), convert (md/txt→docx/pdf, csv→xlsx, xlsx→csv,
// docx→md/txt/pdf, pptx→md/txt, pdf→txt, images→pdf) and archive. Always two steps: a plan (dry run)
// the user sees, then apply by plan id. Nothing is ever deleted or overwritten: name clashes get " (2)",
// and "removing" means moving into an Archive folder.

export type BatchOp = 'rename' | 'sort' | 'convert' | 'archive'

export interface BatchArgs {
  dir: string
  op: BatchOp
  /** File name glob(s): "*.pdf", "IMG_*", "*.{jpg,png}" (default every file). */
  match?: string
  recursive?: boolean
  // rename
  /** New name template: {name} {ext} {n} {date} {created} {year} {month} {parent}. "{ext}" is added if missing. */
  pattern?: string
  /** Regex (or plain text) to replace in the name, with `replace`. */
  find?: string
  replace?: string
  case?: 'lower' | 'upper' | 'title' | 'kebab' | 'snake'
  /** {n} starts here (default 1); files are numbered in name order, or date order with order: "date". */
  start?: number
  order?: 'name' | 'date'
  // sort
  by?: 'type' | 'extension' | 'year' | 'month' | 'first_letter' | 'size'
  // convert
  to?: 'pdf' | 'docx' | 'xlsx' | 'csv' | 'md' | 'txt'
  /** Move the originals into Archive after converting. */
  archive_originals?: boolean
  // archive
  older_than_days?: number
}

export interface PlanItem {
  kind: 'rename' | 'move' | 'convert' | 'archive'
  from: string
  to: string
  /** Source mtime when planned (apply refuses files changed since). */
  mtime: number
}

export interface Plan {
  id: string
  dir: string
  op: BatchOp
  args: BatchArgs
  items: PlanItem[]
  skipped: Array<{ file: string; why: string }>
  created: number
}

export interface Converters {
  /** Markdown → PDF (the app renders it with Chromium; without it md/docx → pdf is unavailable). */
  markdownToPdf?: (markdown: string, title: string) => Promise<Buffer>
}

const plans = new Map<string, Plan>()
const TTL = 60 * 60 * 1000

export function globRe(glob: string | undefined): RegExp {
  if (!glob || glob === '*') return /^/
  const alts = glob.split(/\s*,\s*/).map((g) => {
    let re = ''
    let depth = 0
    for (const ch of g) {
      if (ch === '*') re += '.*'
      else if (ch === '?') re += '.'
      else if (ch === '{') { re += '('; depth++ }
      else if (ch === '}' && depth) { re += ')'; depth-- }
      else if (ch === ',' && depth) re += '|'
      else re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&')
    }
    return re
  })
  return new RegExp(`^(${alts.join('|')})$`, 'i')
}

const KINDS: Array<[string, RegExp]> = [
  ['PDFs', /^\.pdf$/],
  ['Images', /^\.(png|jpe?g|gif|heic|webp|tiff?|bmp|svg|raw|cr2|nef|dng)$/],
  ['Documents', /^\.(docx?|pages|rtf|odt|txt|md|markdown)$/],
  ['Spreadsheets', /^\.(xlsx?|xlsm|numbers|csv|tsv|ods)$/],
  ['Presentations', /^\.(pptx?|key|odp)$/],
  ['Audio', /^\.(mp3|m4a|wav|aiff?|flac|aac|ogg)$/],
  ['Video', /^\.(mp4|mov|m4v|avi|mkv|webm)$/],
  ['Archives', /^\.(zip|rar|7z|tar|gz|tgz|bz2|dmg|pkg)$/],
  ['Code', /^\.(js|ts|tsx|jsx|py|java|c|cpp|h|swift|go|rs|rb|sh|json|ya?ml|html?|css|sql|xml)$/]
]
export const typeFolder = (ext: string): string => KINDS.find(([, re]) => re.test(ext.toLowerCase()))?.[0] ?? 'Other'

const CONVERSIONS: Record<string, string[]> = {
  '.md': ['docx', 'pdf'], '.markdown': ['docx', 'pdf'], '.txt': ['docx', 'pdf'],
  '.csv': ['xlsx'], '.xlsx': ['csv'], '.docx': ['md', 'txt', 'pdf'], '.pptx': ['md', 'txt'], '.pdf': ['txt'],
  '.png': ['pdf'], '.jpg': ['pdf'], '.jpeg': ['pdf']
}

const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

function listFiles(dir: string, recursive: boolean, skipDirs: Set<string>): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) { if (recursive && !skipDirs.has(e.name)) out.push(...listFiles(full, true, skipDirs)) }
    else if (e.isFile()) out.push(full)
  }
  return out
}

function applyCase(s: string, c: BatchArgs['case']): string {
  switch (c) {
    case 'lower': return s.toLowerCase()
    case 'upper': return s.toUpperCase()
    case 'title': return s.toLowerCase().replace(/(^|[\s_-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase())
    case 'kebab': return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
    case 'snake': return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '')
    default: return s
  }
}

const clean = (name: string): string => name.replace(/[/:\\]/g, '-').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '') || 'untitled'

/** Builds a plan without touching anything. */
export function planBatch(a: BatchArgs): Plan {
  if (!existsSync(a.dir) || !statSync(a.dir).isDirectory()) throw new Error(`${a.dir} is not a folder.`)
  // Archive is never touched again; sorting doesn't re-sort the folders it made.
  const skipDirs = new Set(['Archive', ...(a.op === 'sort' ? [...KINDS.map(([k]) => k), 'Other'] : [])])
  const match = globRe(a.match)
  let files = listFiles(a.dir, !!a.recursive, skipDirs).filter((f) => match.test(basename(f)))
  const skipped: Plan['skipped'] = []
  const items: PlanItem[] = []
  const taken = new Set<string>()
  // A name that's free: not an existing file that stays, and not already a target in this plan.
  const free = (target: string, src: string): string => {
    const ext = extname(target), stem = target.slice(0, target.length - ext.length)
    let t = target
    for (let i = 2; ; i++) {
      const key = t.toLowerCase()
      // Existing files always count as taken (a swap gets " (2)" rather than risking an overwrite).
      const existsOther = existsSync(t) && t.toLowerCase() !== src.toLowerCase()
      if (!taken.has(key) && !existsOther) break
      t = `${stem} (${i})${ext}`
    }
    taken.add(t.toLowerCase())
    return t
  }
  const st = (f: string) => statSync(f)
  if (a.order === 'date') files = files.sort((x, y) => st(x).mtimeMs - st(y).mtimeMs)
  else files = files.sort((x, y) => basename(x).localeCompare(basename(y), undefined, { numeric: true, sensitivity: 'base' }))
  const width = String((a.start ?? 1) + files.length - 1).length
  files.forEach((f, i) => {
    const s = st(f)
    const ext = extname(f), name = basename(f, ext)
    switch (a.op) {
      case 'rename': {
        if (!a.pattern && !a.find && !a.case) throw new Error('rename needs a pattern, find/replace or case.')
        let stem = name
        if (a.find) {
          let re: RegExp
          try { re = new RegExp(a.find, 'g') } catch { re = new RegExp(a.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') }
          stem = stem.replace(re, a.replace ?? '')
        }
        let base = stem, outExt = ext
        if (a.pattern) {
          const t = a.pattern
            .replace(/\{name\}/g, stem).replace(/\{ext\}/g, ext).replace(/\{n\}/g, String((a.start ?? 1) + i).padStart(width, '0'))
            .replace(/\{date\}/g, ymd(s.mtimeMs)).replace(/\{created\}/g, ymd(s.birthtimeMs || s.mtimeMs))
            .replace(/\{year\}/g, ymd(s.mtimeMs).slice(0, 4)).replace(/\{month\}/g, ymd(s.mtimeMs).slice(0, 7)).replace(/\{parent\}/g, basename(dirname(f)))
          if (a.pattern.includes('{ext}')) { outExt = extname(t); base = t.slice(0, t.length - outExt.length) } else base = t
        }
        if (a.case) base = applyCase(base, a.case)
        const target = join(dirname(f), clean(base + outExt))
        if (target === f) { skipped.push({ file: f, why: 'name unchanged' }); return }
        items.push({ kind: 'rename', from: f, to: free(target, f), mtime: s.mtimeMs })
        break
      }
      case 'sort': {
        const by = a.by ?? 'type'
        const folder = by === 'type' ? typeFolder(ext)
          : by === 'extension' ? (ext.slice(1).toUpperCase() || 'No extension')
            : by === 'year' ? ymd(s.mtimeMs).slice(0, 4)
              : by === 'month' ? ymd(s.mtimeMs).slice(0, 7)
                : by === 'first_letter' ? (/^[a-z]/i.test(name) ? name[0].toUpperCase() : '#')
                  : s.size < 1e6 ? 'Small (under 1 MB)' : s.size < 100e6 ? 'Medium (1-100 MB)' : 'Large (over 100 MB)'
        if (basename(dirname(f)) === folder) { skipped.push({ file: f, why: `already in ${folder}` }); return }
        items.push({ kind: 'move', from: f, to: free(join(a.dir, folder, basename(f)), f), mtime: s.mtimeMs })
        break
      }
      case 'convert': {
        if (!a.to) throw new Error('convert needs "to" (pdf, docx, xlsx, csv, md or txt).')
        const can = CONVERSIONS[ext.toLowerCase()] ?? []
        if (!can.includes(a.to)) { skipped.push({ file: f, why: `${ext || 'no extension'} → ${a.to} isn't supported${can.length ? ` (it converts to ${can.join(', ')})` : ''}` }); return }
        items.push({ kind: 'convert', from: f, to: free(join(dirname(f), `${name}.${a.to}`), f), mtime: s.mtimeMs })
        if (a.archive_originals) items.push({ kind: 'archive', from: f, to: free(join(a.dir, 'Archive', basename(f)), f), mtime: s.mtimeMs })
        break
      }
      case 'archive': {
        if (a.older_than_days !== undefined && Date.now() - s.mtimeMs < a.older_than_days * 86400000) return
        if (basename(dirname(f)) === 'Archive') return
        items.push({ kind: 'archive', from: f, to: free(join(a.dir, 'Archive', basename(f)), f), mtime: s.mtimeMs })
        break
      }
    }
  })
  for (const [k, p] of plans) if (Date.now() - p.created > TTL) plans.delete(k)
  const plan: Plan = { id: randomBytes(4).toString('hex'), dir: a.dir, op: a.op, args: a, items, skipped, created: Date.now() }
  plans.set(plan.id, plan)
  return plan
}

export function getPlan(id: string): Plan | undefined {
  const p = plans.get(id)
  return p && Date.now() - p.created <= TTL ? p : undefined
}

export function formatPlan(p: Plan, max = 60): string {
  const rel = (x: string) => relative(p.dir, x) || basename(x)
  const verb: Record<PlanItem['kind'], string> = { rename: 'rename', move: 'move', convert: 'convert', archive: 'archive' }
  const lines = p.items.slice(0, max).map((it) => `${verb[it.kind]}: ${rel(it.from)} → ${rel(it.to)}`)
  const counts = Object.entries(p.items.reduce<Record<string, number>>((m, it) => ((m[it.kind] = (m[it.kind] ?? 0) + 1), m), {})).map(([k, n]) => `${n} ${k}`).join(', ')
  return [
    `Plan ${p.id} (${p.op} in ${p.dir}): ${p.items.length ? counts : 'nothing to do'}${p.skipped.length ? `; ${p.skipped.length} skipped` : ''}. Nothing has changed yet.`,
    ...lines,
    p.items.length > max ? `…and ${p.items.length - max} more` : '',
    ...p.skipped.slice(0, 10).map((s) => `skipped ${rel(s.file)}: ${s.why}`),
    p.items.length ? `Show this plan to the user; after they agree, apply it with plan_id "${p.id}" (valid for 1 hour). Files are never deleted or overwritten.` : ''
  ].filter(Boolean).join('\n')
}

async function convert(from: string, to: string, c: Converters): Promise<void> {
  const ext = extname(from).toLowerCase(), target = extname(to).slice(1)
  const title = basename(from, extname(from))
  let out: Buffer | string
  const mdOf = async (): Promise<string> => {
    if (ext === '.docx') {
      const mammoth = await import('mammoth') as unknown as { convertToMarkdown?: (o: { path: string }) => Promise<{ value: string }>; extractRawText: (o: { path: string }) => Promise<{ value: string }> }
      return (mammoth.convertToMarkdown ? await mammoth.convertToMarkdown({ path: from }) : await mammoth.extractRawText({ path: from })).value
    }
    if (ext === '.pptx') { const { pptxSlides } = await import('./read'); return (await pptxSlides(from)).map((s) => `## Slide ${s.n}\n\n${s.texts.map((t, i) => (i ? `- ${t}` : `**${t}**`)).join('\n')}${s.notes ? `\n\n> Notes: ${s.notes}` : ''}`).join('\n\n') }
    return readFileSync(from, 'utf8')
  }
  switch (target) {
    case 'docx': {
      const { renderDocx } = await import('./docx')
      const text = readFileSync(from, 'utf8')
      out = await renderDocx(ext === '.txt' ? text.split(/\n\s*\n/).map((p) => p.replace(/\n/g, '  \n')).join('\n\n') : text, { title, baseDir: dirname(from) })
      break
    }
    case 'pdf': {
      if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
        const { PDFDocument } = await import('pdf-lib')
        const doc = await PDFDocument.create()
        const bytes = readFileSync(from)
        const img = ext === '.png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
        const page = doc.addPage([img.width, img.height])
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height })
        out = Buffer.from(await doc.save())
        break
      }
      const md = await mdOf()
      if (c.markdownToPdf) out = await c.markdownToPdf(md, title)
      else { const { textToPdf } = await import('./pdf'); out = await textToPdf(md, { title }) }
      break
    }
    case 'xlsx': {
      const { buildXlsx, parseCsv, sheetFromCsv } = await import('./xlsx')
      out = (await buildXlsx([sheetFromCsv(title.slice(0, 31), parseCsv(readFileSync(from, 'utf8')))])).buffer
      break
    }
    case 'csv': {
      const { loadWorkbook, readSheets, sheetGrid, toCsv } = await import('./xlsx')
      const sheets = readSheets(await loadWorkbook(readFileSync(from)), { maxCells: 1_000_000 })
      out = toCsv(sheetGrid(sheets[0]))
      // Every further sheet goes to its own file next to it.
      for (const s of sheets.slice(1)) {
        let p = join(dirname(to), `${basename(to, '.csv')} - ${s.name.replace(/[/:\\]/g, '-')}.csv`)
        for (let i = 2; existsSync(p); i++) p = join(dirname(to), `${basename(to, '.csv')} - ${s.name.replace(/[/:\\]/g, '-')} (${i}).csv`)
        writeFileSync(p, toCsv(sheetGrid(s)))
      }
      break
    }
    case 'md': out = await mdOf(); break
    case 'txt': {
      if (ext === '.pdf') { const { pdfText } = await import('./read'); out = (await pdfText(from)).text }
      else if (ext === '.docx') { const { docxText } = await import('./read'); out = await docxText(from) }
      else out = (await mdOf()).replace(/[*_`#>]/g, '')
      break
    }
    default: throw new Error(`Can't convert to ${target}.`)
  }
  if (existsSync(to)) throw new Error(`${basename(to)} appeared since the plan was made; not overwriting it.`)
  writeFileSync(to, out)
}

export interface ApplyResult { done: PlanItem[]; failed: Array<{ item: PlanItem; error: string }>; log?: string }

/** Applies a plan made by planBatch. Moves go through temporary names, so swaps and case-only renames work. */
export async function applyPlan(p: Plan, c: Converters = {}, logDir?: string): Promise<ApplyResult> {
  const done: PlanItem[] = [], failed: ApplyResult['failed'] = []
  const check = (it: PlanItem): string | null => {
    if (!existsSync(it.from)) return 'the file is gone'
    if (Math.abs(statSync(it.from).mtimeMs - it.mtime) > 1) return 'the file changed since the plan was made'
    return null
  }
  // Conversions first (they read the originals), then moves.
  for (const it of p.items.filter((x) => x.kind === 'convert')) {
    const why = check(it)
    if (why) { failed.push({ item: it, error: why }); continue }
    try { await convert(it.from, it.to, c); done.push(it) } catch (e) { failed.push({ item: it, error: (e as Error).message }) }
  }
  const moves = p.items.filter((x) => x.kind !== 'convert' && !failed.some((f) => f.item.from === x.from))
  const staged: Array<{ it: PlanItem; tmp: string }> = []
  for (const it of moves) {
    const why = check(it)
    if (why) { failed.push({ item: it, error: why }); continue }
    const tmp = join(dirname(it.from), `.sahilbot-batch-${p.id}-${staged.length}${extname(it.from)}`)
    try { renameSync(it.from, tmp); staged.push({ it, tmp }) } catch (e) { failed.push({ item: it, error: (e as Error).message }) }
  }
  for (const { it, tmp } of staged) {
    try {
      if (existsSync(it.to) && it.to.toLowerCase() !== it.from.toLowerCase()) throw new Error(`${basename(it.to)} appeared since the plan was made`)
      mkdirSync(dirname(it.to), { recursive: true })
      renameSync(tmp, it.to)
      done.push(it)
    } catch (e) {
      try { renameSync(tmp, it.from) } catch { /* leave the temp name; reported below */ }
      failed.push({ item: it, error: (e as Error).message })
    }
  }
  plans.delete(p.id)
  let log: string | undefined
  if (logDir && done.length) {
    mkdirSync(logDir, { recursive: true })
    log = join(logDir, `batch-${new Date().toISOString().replace(/[:.]/g, '-')}-${p.id}.json`)
    writeFileSync(log, JSON.stringify({ id: p.id, op: p.op, dir: p.dir, done: done.map(({ kind, from, to }) => ({ kind, from, to })), failed: failed.map((f) => ({ ...f.item, error: f.error })) }, null, 2))
  }
  return { done, failed, log }
}
