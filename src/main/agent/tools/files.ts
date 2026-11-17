import { shell } from 'electron'
import { appendFileSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createDocument, type DocSpec } from '../../docs/create'
import { IMAGE_EXT, mimeFor, RICH_EXT, richText } from '../../docs/read'
import type { ToolContext, ToolDef } from '../types'
import { inForbidden, isSecretName } from '../../knowledge/ignore'
import { homeGuarded } from '../../code/proc'
import { heicToJpeg } from '../../attach-process'

const MAX_READ_BYTES = 2_000_000
const MAX_IMAGE_BYTES = 8_000_000

const real = (p: string): string => (existsSync(p) ? realpathSync(p) : resolve(p))

/** `p` with its nearest existing ancestor replaced by that folder's real path (the rest kept as written). */
function canonical(p: string): string {
  let probe = p
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
  try { return join(realpathSync(probe), relative(probe, p)) } catch { return p }
}

/**
 * Documents SahilBot created during this session: rebuilding one of its own files (a backup is kept) is local
 * work, not replacing something of the user's, so Auto doesn't stop to ask (found live: every rebuild of a
 * just-made report asked "Can delete or overwrite · Uses details taken from a web page").
 */
const madeHere = new Set<string>()

/** True when `p` is `root` or inside it (a root may also be a single attached file). */
function within(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** Resolves `p` inside `root`, refusing `..` escapes and symlinks that point outside. */
export function insideRoot(root: string, p: string): string {
  const rootReal = real(root)
  let full = resolve(rootReal, p.replace(/^~[\\/]/, ''))
  // An absolute path through a symlinked prefix (macOS /var → /private/var, /tmp → /private/tmp) names the
  // same place as the real root: compare by the real location of its nearest existing folder.
  if (!within(rootReal, full)) {
    const canon = canonical(full)
    if (!within(rootReal, canon)) throw new Error(`"${p}" is outside the workspace folder.`)
    full = canon
  }
  let probe = full
  while (!existsSync(probe)) probe = dirname(probe)
  if (!within(rootReal, realpathSync(probe))) throw new Error(`"${p}" resolves outside the workspace folder.`)
  return full
}

export interface ResolveOptions {
  /** Where relative paths start: the chat's working folder (default: the workspace). */
  base?: string
  /** The user approved this exact call: a path outside your folders is allowed (never system or secret places). */
  allowOutside?: boolean
}

/** The real path of `full`, including a not-yet-created tail (macOS: /var -> /private/var, /tmp -> /private/tmp). */
function realTail(full: string): string {
  let probe = full
  while (!existsSync(probe)) probe = dirname(probe)
  return join(realpathSync(probe), relative(probe, full))
}

/** Why SahilBot never touches a path outside your folders, even when asked ('' when it may, with your OK). */
export function neverOutside(full: string): string {
  const r = realTail(full)
  if (inForbidden(r) || inForbidden(full)) return 'in a system or private folder SahilBot never reads'
  if (isSecretName(basename(r))) return 'a file that holds secrets'
  return ''
}

/**
 * Where a path may point: relative paths live in the chat's working folder (else the workspace);
 * absolute (or ~/) paths must be inside the workspace or a file or folder the user attached (or the
 * working folder). Outside them only with the user's OK for this call (o.allowOutside).
 */
export function resolvePath(p: string, workspace: string, roots: string[] = [], o: ResolveOptions = {}): string {
  const expanded = p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
  const base = o.base && existsSync(o.base) ? o.base : workspace
  if (!isAbsolute(expanded)) return insideRoot(base, expanded)
  const full = resolve(expanded)
  const fullReal = realTail(full)
  const allowed = [workspace, ...roots, ...(o.base ? [o.base] : [])].map(real)
  // The home folder as a root ("files anywhere"): everything in it except system, private and secret places.
  const home = real(homedir())
  const specific = allowed.filter((r) => r !== home)
  // Shell startup and settings files (.zshrc, .gitconfig…) and launch agents: never under the grant, so they ask.
  const guarded = allowed.includes(home) && !specific.some((r) => within(r, fullReal)) && homeGuarded(fullReal, home)
  if (!guarded && !specific.some((r) => within(r, fullReal)) && allowed.includes(home) && within(home, fullReal)) {
    const never = neverOutside(full)
    if (never) throw new Error(`"${p}" is ${never}.`)
    return full
  }
  if (guarded || !allowed.some((r) => within(r, fullReal))) {
    const never = neverOutside(full)
    if (o.allowOutside && !never) return full
    throw new Error(`"${p}" is outside the workspace and the folders the user attached${never ? `: it's ${never}` : ''}. Ask the user to attach it with the + button${never ? '' : ' (or approve this one step)'}.`)
  }
  return full
}

/** Home folders whose first level is what people mean by "a folder" ("Obsidian Vault" in Documents). */
const HOME_TOPS = new Set(['Documents', 'Desktop', 'Downloads', 'Pictures', 'Music', 'Movies'])

/**
 * The folder an approval for a file outside your folders can open for good ("Always allow in Obsidian Vault"):
 * the first folder inside Documents, Desktop, Downloads… (the vault, the project), else the file's own folder.
 * Never a system or private place, and never the whole home folder.
 */
export function folderToGrant(full: string): string | undefined {
  if (neverOutside(full)) return undefined
  const home = homedir()
  const own = existsSync(full) && statSync(full).isDirectory() ? full : dirname(full)
  const rel = relative(home, own)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return rel ? own : undefined
  const parts = rel.split(sep)
  if (HOME_TOPS.has(parts[0])) return parts.length >= 2 ? join(home, parts[0], parts[1]) : undefined
  return own
}

/** The folder an approval's reason ("reading /…/file.md, outside your folders") can grant, if any. */
export function grantableFolder(reason: string | undefined): string | undefined {
  const m = reason?.match(/(?:reading|writing|copying(?: to)?|moving(?: to)?|creating a folder at) (\/.+?), outside your folders/)
  return m ? folderToGrant(m[1]) : undefined
}

/**
 * The resolved path when `p` points outside the workspace, the attached folders and the working folder
 * (and isn't a place SahilBot never goes): such a call asks first. null when it's inside, or refused anyway.
 */
export function outsidePath(p: string | undefined, workspace: string, roots: string[] = [], folder?: string): string | null {
  if (!p || /^docs([\\/]|$)/.test(p) || /^(r|msg)-[\w-]+$/.test(p)) return null
  try { resolvePath(p, workspace, roots, { base: folder }); return null } catch { /* outside, or refused */ }
  try {
    const full = resolvePath(p, workspace, roots, { base: folder, allowOutside: true })
    return full
  } catch { return null }
}

function listing(dir: string, base: string): string {
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).slice(0, 400)
  if (!entries.length) return '(empty folder)'
  return entries.map((e) => {
    const full = join(dir, e.name)
    const rel = relative(base, full) || e.name
    return e.isDirectory() ? `${rel}/` : `${rel}  (${humanSize(statSync(full).size)})`
  }).join('\n')
}

function humanSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`
}

/** Keeps a copy of a file or folder under <workspace>/.foreman/backups before it is overwritten. */
export function backup(workspace: string, full: string): void {
  const dest = join(workspace, '.foreman', 'backups', `${Date.now()}-${full.replace(/[\\/:]/g, '__').slice(-180)}`)
  mkdirSync(dirname(dest), { recursive: true })
  if (lstatSync(full).isDirectory()) cpSync(full, dest, { recursive: true })
  else copyFileSync(full, dest)
}

const roots = (ctx: ToolContext): string[] => ctx.state.roots ?? []
/** The chat's working folder (relative paths start there). */
const folderOf = (ctx: ToolContext): string | undefined => ctx.state.folder
/** Resolves a tool's path: relative ones in the working folder; outside your folders only once the user approved this call. */
const at = (p: string, workspace: string, ctx: ToolContext): string => resolvePath(p, workspace, roots(ctx), { base: folderOf(ctx), allowOutside: !!ctx.approved })
/** The hard stop for a path outside your folders: it asks first. */
const outsideStop = (verb: string, getWorkspace: () => string) => (p: string | undefined, call?: { roots: string[]; folder?: string }): string | null => {
  const o = outsidePath(p, getWorkspace(), call?.roots ?? [], call?.folder)
  return o ? `${verb} ${o}, outside your folders` : null
}

export function fileTools(getWorkspace: () => string, docsDir: string): ToolDef[] {
  const fileRead: ToolDef<{ path: string; start?: number; end?: number }> = {
    name: 'file_read',
    label: 'Read file',
    core: true,
    effect: 'read',
    // Reading outside the workspace and the attached folders asks the user first.
    hardStop: (a, call) => outsideStop('reading', getWorkspace)(a.path, call),
    description: 'Read a file or list a folder. Works for text, code, PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx) and images (you see the image). Relative paths start in the working folder (else the workspace); absolute paths: attached files and folders (others ask first). "docs/<page>.md" is your manual.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start: { type: 'integer', minimum: 1, description: 'First line to return' },
        end: { type: 'integer', minimum: 1, description: 'Last line to return' }
      },
      required: ['path'],
      additionalProperties: false
    },
    async run({ path, start, end }, ctx) {
      const workspace = getWorkspace()
      mkdirSync(workspace, { recursive: true })
      // A saved tool-result id passed as a path: read the saved result instead of failing.
      const saved = /^(r|msg)-[\w-]+$/.test(path) ? ctx.readResult(path) : undefined
      if (saved !== undefined) {
        const lines = saved.split('\n').slice((start ?? 1) - 1, end ?? undefined).join('\n')
        return { text: lines.length > 20_000 ? `${lines.slice(0, 20_000)}\n[… more: read_result id="${path}" with a later line range]` : lines, display: `read ${path}` }
      }
      const isDoc = /^docs([\\/]|$)/.test(path)
      const full = isDoc ? insideRoot(docsDir, path.replace(/^docs[\\/]?/, '') || '.') : at(path, workspace, ctx)
      if (!existsSync(full)) throw new Error(`No such file or folder: ${path}`)
      const base = isAbsolute(path) ? dirname(full) : isDoc ? docsDir : folderOf(ctx) && existsSync(folderOf(ctx)!) ? folderOf(ctx)! : workspace
      if (lstatSync(full).isDirectory()) return { text: listing(full, base), display: `listed ${basename(full)}` }
      const size = statSync(full).size
      const ext = extname(full).toLowerCase()
      if (IMAGE_EXT.has(ext)) {
        if (size > MAX_IMAGE_BYTES) throw new Error(`${basename(full)} is too large to view (${humanSize(size)}).`)
        // HEIC photos: converted to JPEG (macOS sips) so vision models can see them.
        const shown = ext === '.heic' || ext === '.heif' ? await heicToJpeg(full).catch(() => full) : full
        return { text: `Image ${basename(full)} (${humanSize(size)}) is attached below.`, images: [`data:${shown === full ? mimeFor(full) : 'image/jpeg'};base64,${readFileSync(shown).toString('base64')}`], display: basename(full) }
      }
      let text: string
      if (RICH_EXT.has(ext)) {
        text = await richText(full)
      } else {
        if (size > MAX_READ_BYTES) throw new Error(`${basename(full)} is ${humanSize(size)}; too large to read as text.`)
        const buf = readFileSync(full)
        if (buf.subarray(0, 8000).includes(0)) throw new Error(`${basename(full)} is a binary file this tool can't read.`)
        text = buf.toString('utf8')
      }
      if (start || end) {
        const lines = text.split('\n')
        text = lines.slice((start ?? 1) - 1, end ?? lines.length).join('\n')
      }
      return { text: text || '(empty file)', display: basename(full) }
    }
  }

  const fileWrite: ToolDef<{ path: string; content: string; mode?: 'overwrite' | 'append' | 'create' }> = {
    name: 'file_write',
    label: 'Write file',
    core: true,
    effect: 'write_local',
    // Writes stay inside the workspace, the attached folders and the working folder unless the user approves.
    hardStop: (a, call) => outsideStop('writing', getWorkspace)(a.path, call),
    description: 'Write a text file (Markdown, code, CSV, HTML…). Relative paths: the working folder (else the workspace); absolute: attached folders (others ask first). mode: "create" fails if it exists, "overwrite" replaces it (a backup is kept), "append" adds to the end. For .docx/.pptx/.xlsx/.pdf use create_document.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        mode: { type: 'string', enum: ['overwrite', 'append', 'create'], default: 'overwrite' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    },
    async run({ path, content, mode = 'overwrite' }, ctx) {
      const workspace = getWorkspace()
      mkdirSync(workspace, { recursive: true })
      if (/^docs[\\/]/.test(path)) throw new Error('The docs folder is read-only.')
      if (/\.(docx|pptx|xlsx|pdf)$/i.test(path)) throw new Error('Use create_document for .docx, .pptx, .xlsx and .pdf files.')
      const full = at(path, workspace, ctx)
      const exists = existsSync(full)
      if (exists && lstatSync(full).isDirectory()) throw new Error(`${path} is a folder.`)
      if (mode === 'create' && exists) throw new Error(`${path} already exists. Use mode "overwrite" or "append".`)
      mkdirSync(dirname(full), { recursive: true })
      if (exists && mode === 'overwrite') backup(workspace, full)
      if (mode === 'append') appendFileSync(full, content)
      else writeFileSync(full, content)
      const verb = mode === 'append' ? 'appended to' : exists ? 'updated' : 'created'
      return { text: `${verb} ${full} (${humanSize(Buffer.byteLength(content))}).`, display: `${verb} ${basename(full)}`, path: full }
    }
  }

  type Manage = { op: 'delete' | 'move' | 'copy' | 'mkdir'; path: string; to?: string }
  // A path outside the workspace and attached folders counts as an existing target (ask).
  const targetExists = (a: Manage, roots: string[], folder?: string): boolean => {
    try {
      return !!a.to && existsSync(resolvePath(a.to, getWorkspace(), roots, { base: folder }))
    } catch {
      return true
    }
  }
  const fileManage: ToolDef<Manage> = {
    name: 'file_manage',
    label: 'Files',
    core: true,
    effect: (a, c) => (a.op === 'delete' || ((a.op === 'move' || a.op === 'copy') && targetExists(a, c.roots, c.folder)) ? 'destructive' : 'write_local'),
    // The user asked that deleting always needs their OK, even in Bypass.
    hardStop: (a, call) => (a.op === 'delete' ? `deleting ${a.path} (it goes to the Trash)` : outsideStop(a.op === 'copy' ? 'copying' : a.op === 'mkdir' ? 'creating a folder at' : 'moving', getWorkspace)(a.path, call) ?? outsideStop(a.op === 'copy' ? 'copying to' : 'moving to', getWorkspace)(a.to, call)),
    describe: (a) => (a.op === 'delete' ? `Move ${a.path} to the Trash` : a.op === 'mkdir' ? `Create folder ${a.path}` : `${a.op === 'move' ? 'Move' : 'Copy'} ${a.path} to ${a.to}`),
    description: 'Manage files and folders: delete (moves to the Trash; always asks the user), move/rename, copy, mkdir. Same path rules as file_write.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['delete', 'move', 'copy', 'mkdir'] },
        path: { type: 'string' },
        to: { type: 'string', description: 'Destination for move and copy' }
      },
      required: ['op', 'path'],
      additionalProperties: false,
      allOf: [{ if: { properties: { op: { enum: ['move', 'copy'] } } }, then: { required: ['to'] } }]
    },
    async run(a, ctx) {
      const workspace = getWorkspace()
      const full = at(a.path, workspace, ctx)
      if ([workspace, ...roots(ctx)].map(real).includes(real(full))) throw new Error('That is a whole attached folder or the workspace itself; work on items inside it.')
      if (a.op === 'mkdir') {
        mkdirSync(full, { recursive: true })
        return { text: `Created folder ${full}.`, display: `created ${basename(full)}/` }
      }
      if (!existsSync(full)) throw new Error(`No such file or folder: ${a.path}`)
      if (a.op === 'delete') {
        await shell.trashItem(full)
        return { text: `Moved ${full} to the Trash. The user can restore it from there.`, display: `trashed ${basename(full)}` }
      }
      const dest = at(a.to!, workspace, ctx)
      const finalDest = existsSync(dest) && lstatSync(dest).isDirectory() ? join(dest, basename(full)) : dest
      if (existsSync(finalDest)) backup(workspace, finalDest)
      mkdirSync(dirname(finalDest), { recursive: true })
      if (a.op === 'move') renameSync(full, finalDest)
      else cpSync(full, finalDest, { recursive: true })
      return { text: `${a.op === 'move' ? 'Moved' : 'Copied'} ${full} → ${finalDest}.`, display: `${a.op === 'move' ? 'moved' : 'copied'} ${basename(full)}`, path: finalDest }
    }
  }

  const cellT = { type: ['string', 'number', 'boolean', 'null'] }
  const createDoc: ToolDef<DocSpec> = {
    name: 'create_document',
    label: 'Document',
    core: true,
    effect: (a, c) => { const p = safe(() => resolvePath(a.path, getWorkspace(), c.roots, { base: c.folder })); return p === undefined || (existsSync(p) && !madeHere.has(real(p))) ? 'destructive' : 'write_local' },
    hardStop: (a, call) => outsideStop('writing', getWorkspace)(a.path, call),
    description: `Create (or rebuild) a polished document from data; it is reviewed automatically (fix every FAIL in the review, then present it).
- .docx / .pdf: "markdown" (headings, lists, tables, bold, links, images ![alt](path "Caption"), charts as a \`\`\`chart fenced block of JSON {type: column|bar|line|area|pie|doughnut, title, categories, series: [{name, values}], number_format: "$#,##0"}, [TOC], <!-- pagebreak -->, <!-- landscape --> / <!-- portrait -->, footnotes text[^1] + [^1]: note, "Table: caption" under a table, > [!NOTE] / [!WARNING] callouts). Real Word styles, TOC with page numbers, bookmarks, numbered captions, numbers right-aligned, header rows repeat across pages, "Page X of Y". Options: theme (modern | classic | minimal; same look in PDF, Word, PowerPoint), template (memo | report | letter | meeting_notes | proposal | resume | invoice) with fields {to, from, cc, date, subject, recipient, recipient_address, sender, sender_address, salutation, closing, signature, subtitle, author, organization, prepared_for, prepared_by, attendees, facilitator, location, time, invoice_number, due_date, po_number, terms}, cover, toc (auto for long docs), subtitle, author, header, footer, page_numbers, orientation, page_size (letter|a4|legal), margins (inches: 1 or {top, right, bottom, left}), font_size (pt), fit_pages (e.g. 1: tightens spacing, then type and margins, within readable limits), font, citations [text | {text, url}]. The result reports the page count. Never unzip or hand-edit document XML: rebuild with these options instead.
- .pptx: "slides": [{title, subtitle?, bullets? (indent sub-points with 2 spaces), notes?, layout?}]. Layouts: title, section, bullets, two_column (bullets + right, left_title/right_title), image_text (image path + bullets, image_side), image (+caption), chart (chart: {type: bar|column|line|area|pie|doughnut, categories, series: [{name, values}], number_format: "$#,##0", stacked?} + optional bullets as the takeaway), table (table: [[header…], [row…]]), stats (stats: [{value: "$4.2M", label: "ARR"}]), quote (title = quote, subtitle = who), closing. theme light|dark, slide_numbers (default on), 16:9. Headline titles that state the point; detail in notes. Overlong slides are split/shortened for you.
- .xlsx: "sheets": [{name, rows: [[header…], [row…]], columns?: [{header, type: text|number|integer|currency|percent|date|datetime|boolean, format?, width?, total?: sum|average|count|min|max|none, options?: [dropdown values], min?, max?, formula?: "=C{r}*D{r}"}], totals?: true, freeze?: {rows, cols}, autofilter?, conditional?: [{column, type: greater_than|less_than|between|equal|not_equal|negative|text_contains|duplicates|blank|top|bottom|data_bar|color_scale|formula, value?, value2?, color?: red|green|yellow|blue|#hex, formula?}], banded?}]. Strings starting with "=" are formulas (XLOOKUP is rewritten to INDEX/MATCH so it works everywhere). summary: true adds a Summary sheet with live totals; currency: "$".
Optional "accent" color like "#2563EB" (too-light accents are darkened for text automatically). Decks: background light|dark. To change an existing file: rebuild it at the same path (a backup is kept), or edit cells in place with the office tool (sheet_write).`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', pattern: '\\.(docx|pdf|pptx|xlsx)$' },
        title: { type: 'string' },
        markdown: { type: 'string' },
        blocks: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'] }, description: 'Structured content instead of markdown' },
        template: { type: 'string', enum: ['memo', 'report', 'letter', 'meeting_notes', 'proposal', 'resume', 'invoice'] },
        fields: { type: 'object', additionalProperties: { type: ['string', 'array', 'boolean'] } },
        subtitle: { type: 'string' },
        author: { type: 'string' },
        toc: { type: 'boolean' },
        cover: { type: 'boolean' },
        header: { type: ['string', 'boolean'] },
        footer: { type: ['string', 'boolean'] },
        page_numbers: { type: 'boolean' },
        orientation: { type: 'string', enum: ['portrait', 'landscape'] },
        page_size: { type: 'string', enum: ['letter', 'a4', 'legal'] },
        margins: { anyOf: [{ type: 'number', minimum: 0.4, maximum: 2 }, { type: 'object', properties: { top: { type: 'number' }, right: { type: 'number' }, bottom: { type: 'number' }, left: { type: 'number' } }, additionalProperties: false }] },
        font_size: { type: 'number', minimum: 8, maximum: 16 },
        fit_pages: { type: 'integer', minimum: 1, maximum: 200 },
        lang: { type: 'string' },
        keywords: { type: 'array', items: { type: 'string' } },
        background: { type: 'string', enum: ['light', 'dark'] },
        font: { type: 'string' },
        citations: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { text: { type: 'string' }, url: { type: 'string' } }, required: ['text'] }] } },
        footnotes: { type: 'object', additionalProperties: { type: 'string' } },
        theme: { type: 'string', enum: ['modern', 'classic', 'minimal', 'light', 'dark'] },
        slide_numbers: { type: 'boolean' },
        slides: {
          type: 'array', minItems: 1, maxItems: 80,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' }, subtitle: { type: 'string' }, notes: { type: 'string' },
              bullets: { type: 'array', items: { type: 'string' } }, right: { type: 'array', items: { type: 'string' } },
              left_title: { type: 'string' }, right_title: { type: 'string' },
              table: { type: 'array', items: { type: 'array', items: { type: ['string', 'number'] } } },
              layout: { type: 'string', enum: ['title', 'section', 'bullets', 'two_column', 'image', 'image_text', 'chart', 'table', 'stats', 'quote', 'closing'] },
              image: { type: 'string' }, image_side: { type: 'string', enum: ['left', 'right'] }, caption: { type: 'string' },
              chart: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['bar', 'column', 'line', 'area', 'pie', 'doughnut'] },
                  categories: { type: 'array', items: { type: ['string', 'number'] } },
                  series: { type: 'array', minItems: 1, items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } }, required: ['name', 'values'] } },
                  title: { type: 'string' }, number_format: { type: 'string' }, show_values: { type: 'boolean' }, stacked: { type: 'boolean' }
                },
                required: ['type', 'categories', 'series']
              },
              stats: { type: 'array', maxItems: 4, items: { type: 'object', properties: { value: { type: 'string' }, label: { type: 'string' } }, required: ['value', 'label'] } }
            },
            required: ['title'],
            additionalProperties: false
          }
        },
        sheets: {
          type: 'array', minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              rows: { type: 'array', items: { type: 'array', items: cellT } },
              header: { type: 'boolean' },
              widths: { type: 'array', items: { type: 'number' } },
              columns: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    header: { type: 'string' }, type: { type: 'string', enum: ['text', 'number', 'integer', 'currency', 'percent', 'date', 'datetime', 'boolean'] },
                    format: { type: 'string' }, width: { type: 'number' }, total: { type: 'string', enum: ['sum', 'average', 'count', 'min', 'max', 'none'] },
                    options: { type: 'array', items: { type: 'string' } }, min: { type: 'number' }, max: { type: 'number' }, formula: { type: 'string' }, align: { type: 'string', enum: ['left', 'center', 'right'] }
                  },
                  additionalProperties: false
                }
              },
              totals: { type: ['boolean', 'string'] },
              freeze: { anyOf: [{ type: 'boolean', const: false }, { type: 'object', properties: { rows: { type: 'integer', minimum: 0 }, cols: { type: 'integer', minimum: 0 } }, additionalProperties: false }] },
              autofilter: { type: 'boolean' },
              banded: { type: 'boolean' },
              tab_color: { type: 'string' },
              conditional: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    column: { type: 'string' }, range: { type: 'string' },
                    type: { type: 'string', enum: ['greater_than', 'less_than', 'between', 'equal', 'not_equal', 'negative', 'text_contains', 'duplicates', 'blank', 'top', 'bottom', 'data_bar', 'color_scale', 'formula'] },
                    value: { type: ['number', 'string'] }, value2: { type: 'number' }, count: { type: 'integer' }, color: { type: 'string' }, formula: { type: 'string' }
                  },
                  required: ['type'],
                  additionalProperties: false
                }
              }
            },
            required: ['name', 'rows'],
            additionalProperties: false
          }
        },
        summary: { anyOf: [{ type: 'boolean' }, { type: 'object', properties: { title: { type: 'string' }, items: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: ['string', 'number'] }, format: { type: 'string' } }, required: ['label', 'value'] } } } }] },
        currency: { type: 'string', maxLength: 4 },
        accent: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' }
      },
      required: ['path'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { path: { pattern: '\\.(docx|pdf)$' } } }, then: { anyOf: [{ required: ['markdown'] }, { required: ['blocks'] }] } },
        { if: { properties: { path: { pattern: '\\.pptx$' } } }, then: { required: ['slides'] } },
        { if: { properties: { path: { pattern: '\\.xlsx$' } } }, then: { required: ['sheets'] } }
      ]
    },
    async run(spec, ctx) {
      const workspace = getWorkspace()
      const full = at(spec.path, workspace, ctx)
      const existed = existsSync(full)
      if (existed) backup(workspace, full)
      // Images in documents come from the workspace and the folders the user attached, like every file tool.
      const readImage = (src: string): Buffer => {
        const p = resolvePath(src, workspace, roots(ctx), { base: folderOf(ctx) })
        if (!existsSync(p) || !statSync(p).isFile()) throw new Error(`Image not found: ${src}`)
        if (statSync(p).size > 25_000_000) throw new Error(`Image ${src} is larger than 25 MB.`)
        return readFileSync(p)
      }
      const r = await createDocument(full, spec, { readImage })
      if (!existed) madeHere.add(real(full))
      const what = spec.slides ? `${r.slides ?? spec.slides.length} slides` : spec.sheets ? `${spec.sheets.length} sheet${spec.sheets.length > 1 ? 's' : ''}` : `${r.pages ? `${r.pages} page${r.pages === 1 ? '' : 's'}${/\.docx$/i.test(full) ? ' as Word lays it out' : ''}, ` : ''}${humanSize(r.bytes)}`
      let review = ''
      try {
        const { formatReview, reviewDocument } = await import('../../docs/review')
        // Rendered too (page count, blank pages, overflow, cut-off content); review_document shows the pictures.
        review = `\n\n${formatReview(await reviewDocument(full, { render: true, expectPages: spec.fit_pages }))}\nTo see the pages yourself: review_document(path, pages: "1").`
      } catch (e) {
        review = `\n\n(Automatic review skipped: ${(e as Error).message}. Run review_document.)`
      }
      return {
        text: `${existed ? 'Rebuilt' : 'Created'} ${r.kind} ${full} (${what}). The user can open it from the chat.${r.notes?.length ? `\nLayout: ${r.notes.join(' ')}` : ''}${r.warnings?.length ? `\nGenerator notes:\n${r.warnings.slice(0, 25).map((w) => `- ${w}`).join('\n')}` : ''}${review}`,
        display: `${existed ? 'rebuilt' : 'created'} ${basename(full)}`,
        path: full
      }
    }
  }

  return [fileRead, fileWrite, fileManage, createDoc]
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/** Opens a file the agent produced with the default app (user action from the UI). */
export function openWithDefault(path: string): Promise<string> {
  return shell.openPath(path)
}
