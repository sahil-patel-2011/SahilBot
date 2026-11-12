import { shell } from 'electron'
import { appendFileSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createDocument, type DocSpec } from '../../docs/create'
import { IMAGE_EXT, mimeFor, RICH_EXT, richText } from '../../docs/read'
import type { ToolContext, ToolDef } from '../types'

const MAX_READ_BYTES = 2_000_000
const MAX_IMAGE_BYTES = 8_000_000

const real = (p: string): string => (existsSync(p) ? realpathSync(p) : resolve(p))

/** True when `p` is `root` or inside it (a root may also be a single attached file). */
function within(root: string, p: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)
}

/** Resolves `p` inside `root`, refusing `..` escapes and symlinks that point outside. */
export function insideRoot(root: string, p: string): string {
  const rootReal = real(root)
  const full = resolve(rootReal, p.replace(/^~[\\/]/, ''))
  if (!within(rootReal, full)) throw new Error(`"${p}" is outside the workspace folder.`)
  let probe = full
  while (!existsSync(probe)) probe = dirname(probe)
  if (!within(rootReal, realpathSync(probe))) throw new Error(`"${p}" resolves outside the workspace folder.`)
  return full
}

/**
 * Where a path may point: relative paths live in the workspace; absolute (or ~/) paths
 * must be inside a file or folder the user attached to this thread.
 */
export function resolvePath(p: string, workspace: string, roots: string[] = []): string {
  const expanded = p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
  if (!isAbsolute(expanded)) return insideRoot(workspace, expanded)
  const full = resolve(expanded)
  let probe = full
  while (!existsSync(probe)) probe = dirname(probe)
  // Compare real paths (macOS: /var -> /private/var, /tmp -> /private/tmp), including not-yet-created tails.
  const fullReal = join(realpathSync(probe), relative(probe, full))
  const allowed = [workspace, ...roots].map(real)
  if (!allowed.some((r) => within(r, fullReal))) {
    throw new Error(`"${p}" is outside the workspace and the folders the user attached. Ask the user to attach it with the + button.`)
  }
  return full
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

function backup(workspace: string, full: string): void {
  const dest = join(workspace, '.foreman', 'backups', `${Date.now()}-${full.replace(/[\\/:]/g, '__').slice(-180)}`)
  mkdirSync(dirname(dest), { recursive: true })
  if (lstatSync(full).isDirectory()) cpSync(full, dest, { recursive: true })
  else copyFileSync(full, dest)
}

const roots = (ctx: ToolContext): string[] => ctx.state.roots ?? []

export function fileTools(getWorkspace: () => string, docsDir: string): ToolDef[] {
  const fileRead: ToolDef<{ path: string; start?: number; end?: number }> = {
    name: 'file_read',
    label: 'Read file',
    core: true,
    effect: 'read',
    description: 'Read a file or list a folder. Works for text, code, PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx) and images (you see the image). Relative paths are in the workspace; absolute paths work inside files and folders the user attached. "docs/<page>.md" is your manual.',
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
      const full = isDoc ? insideRoot(docsDir, path.replace(/^docs[\\/]?/, '') || '.') : resolvePath(path, workspace, roots(ctx))
      if (!existsSync(full)) throw new Error(`No such file or folder: ${path}`)
      const base = isAbsolute(path) ? dirname(full) : isDoc ? docsDir : workspace
      if (lstatSync(full).isDirectory()) return { text: listing(full, base), display: `listed ${basename(full)}` }
      const size = statSync(full).size
      const ext = extname(full).toLowerCase()
      if (IMAGE_EXT.has(ext)) {
        if (size > MAX_IMAGE_BYTES) throw new Error(`${basename(full)} is too large to view (${humanSize(size)}).`)
        return { text: `Image ${basename(full)} (${humanSize(size)}) is attached below.`, images: [`data:${mimeFor(full)};base64,${readFileSync(full).toString('base64')}`], display: basename(full) }
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
    description: 'Write a text file (Markdown, code, CSV, HTML…). Relative paths go in the workspace; absolute paths work inside attached folders. mode: "create" fails if it exists, "overwrite" replaces it (a backup is kept), "append" adds to the end. For .docx/.pptx/.xlsx/.pdf use create_document.',
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
      const full = resolvePath(path, workspace, roots(ctx))
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
  const targetExists = (a: Manage, roots: string[]): boolean => {
    try {
      return !!a.to && existsSync(resolvePath(a.to, getWorkspace(), roots))
    } catch {
      return true
    }
  }
  const fileManage: ToolDef<Manage> = {
    name: 'file_manage',
    label: 'Files',
    core: true,
    effect: (a, c) => (a.op === 'delete' || ((a.op === 'move' || a.op === 'copy') && targetExists(a, c.roots)) ? 'destructive' : 'write_local'),
    // The user asked that deleting always needs their OK, even in Bypass.
    hardStop: (a) => (a.op === 'delete' ? `deleting ${a.path} (it goes to the Trash)` : null),
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
      const full = resolvePath(a.path, workspace, roots(ctx))
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
      const dest = resolvePath(a.to!, workspace, roots(ctx))
      const finalDest = existsSync(dest) && lstatSync(dest).isDirectory() ? join(dest, basename(full)) : dest
      if (existsSync(finalDest)) backup(workspace, finalDest)
      mkdirSync(dirname(finalDest), { recursive: true })
      if (a.op === 'move') renameSync(full, finalDest)
      else cpSync(full, finalDest, { recursive: true })
      return { text: `${a.op === 'move' ? 'Moved' : 'Copied'} ${full} → ${finalDest}.`, display: `${a.op === 'move' ? 'moved' : 'copied'} ${basename(full)}`, path: finalDest }
    }
  }

  const createDoc: ToolDef<DocSpec> = {
    name: 'create_document',
    label: 'Document',
    core: true,
    effect: (a, c) => { const p = safe(() => resolvePath(a.path, getWorkspace(), c.roots)); return p === undefined || existsSync(p) ? 'destructive' : 'write_local' },
    description: `Create (or rebuild) a formatted document from data:
- .docx / .pdf: give "markdown" (headings, lists, tables, bold, links).
- .pptx: give "slides": [{title, subtitle?, bullets?, table?, layout?: title|bullets|two_column|section|quote, right?, notes?}]. First slide is usually layout "title".
- .xlsx: give "sheets": [{name, rows: [[...]], header?: true}]. Strings starting with "=" are formulas.
Optional "accent" color like "#2563EB". To edit an existing document, read it, then create it again at the same path (a backup is kept).`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', pattern: '\\.(docx|pdf|pptx|xlsx)$' },
        title: { type: 'string' },
        markdown: { type: 'string' },
        slides: {
          type: 'array', minItems: 1, maxItems: 60,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' }, subtitle: { type: 'string' }, notes: { type: 'string' },
              bullets: { type: 'array', items: { type: 'string' } }, right: { type: 'array', items: { type: 'string' } },
              table: { type: 'array', items: { type: 'array', items: { type: ['string', 'number'] } } },
              layout: { type: 'string', enum: ['title', 'bullets', 'two_column', 'section', 'quote'] }
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
              rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } },
              header: { type: 'boolean' },
              widths: { type: 'array', items: { type: 'number' } }
            },
            required: ['name', 'rows'],
            additionalProperties: false
          }
        },
        accent: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' }
      },
      required: ['path'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { path: { pattern: '\\.(docx|pdf)$' } } }, then: { required: ['markdown'] } },
        { if: { properties: { path: { pattern: '\\.pptx$' } } }, then: { required: ['slides'] } },
        { if: { properties: { path: { pattern: '\\.xlsx$' } } }, then: { required: ['sheets'] } }
      ]
    },
    async run(spec, ctx) {
      const workspace = getWorkspace()
      const full = resolvePath(spec.path, workspace, roots(ctx))
      const existed = existsSync(full)
      if (existed) backup(workspace, full)
      const r = await createDocument(full, spec)
      const what = spec.slides ? `${spec.slides.length} slides` : spec.sheets ? `${spec.sheets.length} sheet${spec.sheets.length > 1 ? 's' : ''}` : humanSize(r.bytes)
      return { text: `${existed ? 'Rebuilt' : 'Created'} ${r.kind} ${full} (${what}). The user can open it from the chat.`, display: `${existed ? 'rebuilt' : 'created'} ${basename(full)}`, path: full }
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
