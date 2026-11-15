import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { AttachCategory, Attachment } from '@shared/types'

// What an attached file is, and how it reaches the model. No Electron here (attachments.ts supplies the
// image resizer), so it's unit-testable.
// - Images go to vision models, resized to at most IMAGE_MAX_EDGE px on the long side; HEIC/HEIF photos
//   are converted to JPEG first with macOS's own `sips`.
// - PDFs and Office documents are read by file_read through the existing extractors (docs/read.ts).
// - Text and code are read directly by file_read.
// - Anything else is listed with its type and size, never dumped into the chat.
// - Files over MAX_ATTACH_BYTES are refused with a message (attach the folder they're in instead).

export const MAX_ATTACH_BYTES = 100 * 1024 * 1024
/** Largest image that's decoded for vision (bigger photos are listed as files). */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024
export const IMAGE_MAX_EDGE = 2048

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.heif', '.tif', '.tiff'])
const HEIC = new Set(['.heic', '.heif'])
const PDF = new Set(['.pdf'])
const OFFICE = new Set(['.docx', '.xlsx', '.xlsm', '.pptx'])
/** Office formats SahilBot can't extract (old binary ones, Apple's packages): listed like other binaries. */
const OFFICE_OTHER = new Set(['.doc', '.xls', '.ppt', '.pages', '.numbers', '.key', '.odt', '.ods', '.odp'])
const TEXT = new Set(['.txt', '.md', '.markdown', '.mdx', '.rst', '.csv', '.tsv', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.plist', '.log', '.html', '.htm', '.svg', '.rtf', '.tex', '.org', '.adoc', '.env.example', '.srt', '.vtt', '.ics'])
const CODE = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte', '.astro', '.py', '.pyi', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.swift', '.m', '.mm', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.cs', '.fs', '.php', '.pl', '.pm', '.lua', '.r', '.jl', '.dart', '.ex', '.exs', '.erl', '.hs', '.clj', '.elm', '.zig', '.nim', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.css', '.scss', '.sass', '.less', '.gradle', '.cmake', '.sql', '.graphql', '.gql', '.proto', '.ipynb', '.dockerfile', '.makefile'])

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.heic': 'image/heic', '.heif': 'image/heif', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar', '.dmg': 'application/x-apple-diskimage',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.txt': 'text/plain', '.md': 'text/markdown',
  '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html', '.xml': 'application/xml', '.stl': 'model/stl', '.step': 'model/step'
}

/** Words for a binary's type in the chip and the agent's note. */
const BINARY_NAME: Record<string, string> = {
  '.zip': 'zip archive', '.gz': 'gzip archive', '.tar': 'tar archive', '.7z': '7-Zip archive', '.rar': 'RAR archive', '.dmg': 'disk image', '.pkg': 'installer package',
  '.mp4': 'video', '.mov': 'video', '.m4v': 'video', '.avi': 'video', '.mkv': 'video', '.webm': 'video', '.mp3': 'audio', '.wav': 'audio', '.m4a': 'audio', '.aac': 'audio', '.flac': 'audio',
  '.stl': '3D model', '.step': 'CAD model', '.stp': 'CAD model', '.f3d': 'CAD model', '.sldprt': 'CAD model', '.psd': 'Photoshop file', '.ai': 'Illustrator file', '.sketch': 'Sketch file',
  '.fig': 'Figma file', '.exe': 'Windows program', '.app': 'app', '.sqlite': 'database', '.db': 'database', '.doc': 'old Word document', '.xls': 'old Excel workbook',
  '.ppt': 'old PowerPoint deck', '.pages': 'Pages document', '.numbers': 'Numbers spreadsheet', '.key': 'Keynote deck', '.ttf': 'font', '.otf': 'font', '.woff': 'font', '.woff2': 'font'
}

export function humanSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`
}

export const mimeOf = (path: string): string | undefined => MIME[extname(path).toLowerCase()]

/** True when the start of a file looks like text (no NUL bytes in the first 8 KB). */
export function looksText(path: string): boolean {
  let fd = -1
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(8192)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return !buf.subarray(0, n).includes(0)
  } catch { return false } finally { if (fd >= 0) closeSync(fd) }
}

/** The category of a file by its name, sniffing the content only for names that don't say. */
export function categoryOf(path: string, isDir = false): AttachCategory {
  if (isDir) return 'folder'
  const name = basename(path).toLowerCase()
  const ext = extname(name)
  if (IMAGE.has(ext)) return 'image'
  if (PDF.has(ext)) return 'pdf'
  if (OFFICE.has(ext)) return 'office'
  if (OFFICE_OTHER.has(ext) || BINARY_NAME[ext]) return 'binary'
  if (CODE.has(ext) || /^(makefile|dockerfile|gemfile|rakefile|procfile|justfile)$/.test(name)) return 'code'
  if (TEXT.has(ext) || /^(readme|license|changelog|notes)$/.test(name)) return 'text'
  return looksText(path) ? 'text' : 'binary'
}

export interface ProcessDeps {
  /** HEIC/HEIF → JPEG (default: macOS `sips`). Returns the JPEG's path. */
  heicToJpeg?: (path: string) => Promise<string>
  /** A data: URL of the image, scaled down to fit `maxEdge` (attachments.ts uses Electron's nativeImage). */
  imageDataUrl?: (path: string, maxEdge: number) => Promise<string | null>
  /** Where converted files go (default: a SahilBot folder in the temp dir). */
  tmp?: string
}

export type Processed = { ok: true; attachment: Attachment } | { ok: false; name: string; reason: string }

/** Describes one picked, dropped or pasted path as an attachment (or why it can't be attached). */
export async function processAttachment(path: string, deps: ProcessDeps = {}): Promise<Processed> {
  const name = basename(path)
  let st
  try { st = statSync(path) } catch { return { ok: false, name, reason: 'It no longer exists.' } }
  if (st.isDirectory()) return { ok: true, attachment: { path, name, kind: 'folder', category: 'folder' } }
  if (!st.isFile()) return { ok: false, name, reason: 'Only files and folders can be attached.' }
  if (st.size > MAX_ATTACH_BYTES) {
    return { ok: false, name, reason: `${name} is ${humanSize(st.size)}. Files up to ${humanSize(MAX_ATTACH_BYTES)} can be attached; for a bigger one, attach the folder it's in.` }
  }
  const category = categoryOf(path)
  const ext = extname(path).toLowerCase()
  const base: Attachment = { path, name, kind: 'file', size: st.size, category, ...(mimeOf(path) ? { mime: mimeOf(path) } : {}) }
  if (category === 'binary') return { ok: true, attachment: { ...base, note: `${BINARY_NAME[ext] ?? 'binary file'}, ${humanSize(st.size)}: listed, not read as text` } }
  if (category === 'pdf' || category === 'office') return { ok: true, attachment: { ...base, note: 'its text is extracted when read' } }
  if (category !== 'image') return { ok: true, attachment: base }

  // Images: shown to vision models, scaled down; HEIC converted to JPEG first.
  if (st.size > MAX_IMAGE_BYTES) return { ok: true, attachment: { ...base, kind: 'file', note: `image too large to show (${humanSize(st.size)}): listed only` } }
  let shown = path
  let note: string | undefined
  if (HEIC.has(ext)) {
    try {
      shown = await (deps.heicToJpeg ?? ((p) => heicToJpeg(p, deps.tmp)))(path)
      note = `converted from ${ext.slice(1).toUpperCase()} to JPEG`
    } catch (e) {
      return { ok: true, attachment: { ...base, kind: 'file', note: `couldn't convert this ${ext.slice(1).toUpperCase()} photo (${(e as Error).message}): listed only` } }
    }
  }
  let dataUrl: string | null = null
  try { dataUrl = deps.imageDataUrl ? await deps.imageDataUrl(shown, IMAGE_MAX_EDGE) : null } catch { dataUrl = null }
  if (!dataUrl) return { ok: true, attachment: { ...base, ...(shown !== path ? { path: shown, mime: 'image/jpeg' } : {}), kind: 'file', note: note ?? 'image the viewer couldn\'t decode: listed only' } }
  return { ok: true, attachment: { ...base, path: shown, kind: 'image', dataUrl, ...(shown !== path ? { mime: 'image/jpeg', name: `${basename(path, extname(path))}.jpg` } : {}), ...(note ? { note } : {}) } }
}

/** The temp folder for converted photos, pasted images and screenshots. */
export function attachTmp(dir = join(tmpdir(), 'SahilBot Attachments')): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** HEIC/HEIF → JPEG with macOS `sips` (no download, no dependency). */
export function heicToJpeg(path: string, tmp?: string): Promise<string> {
  const out = join(attachTmp(tmp), `${basename(path, extname(path))}-${Date.now().toString(36)}.jpg`)
  return new Promise((ok, bad) => {
    execFile('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', path, '--out', out], { timeout: 30_000 }, (e) => {
      if (e || !existsSync(out)) bad(new Error(e ? e.message.split('\n')[0] : 'sips made no file'))
      else ok(out)
    })
  })
}

/** The lines telling the agent about attached files and folders (added to the user's message as a note). */
export function attachmentNotes(att: Attachment[]): string[] {
  const out: string[] = []
  const files = att.filter((a) => a.kind !== 'folder')
  const folders = att.filter((a) => a.kind === 'folder')
  const how = (f: Attachment): string => {
    const size = f.size ? `${humanSize(f.size)}` : ''
    const c = f.category ?? (f.kind === 'image' ? 'image' : undefined)
    const parts = [size]
    if (f.kind === 'image') parts.push('image, shown to you')
    else if (c === 'pdf') parts.push('PDF: file_read extracts its text page by page')
    else if (c === 'office') parts.push('Office document: file_read extracts its text')
    else if (c === 'binary') parts.push(`${f.note ?? 'binary file'}; don't read it as text, describe or work with it by name and type (commands, copy, move)`)
    else if (c === 'image') parts.push(f.note ?? 'image, listed only')
    else if (c === 'text' || c === 'code') parts.push(c === 'code' ? 'code: read it with file_read' : 'text: read it with file_read')
    if (f.note && f.kind === 'image') parts.push(f.note)
    return parts.filter(Boolean).join(', ')
  }
  if (files.length) out.push(`[Attached files — use these exact paths; you may edit text files (a backup is kept):\n${files.map((f) => `- ${f.path} (${how(f)})`).join('\n')}]`)
  if (folders.length) out.push(`[Attached folders — you can list, read, create, edit and move files inside them with absolute paths; deleting asks the user. They're added to the knowledge base, so knowledge_search with scope "chat" searches them (indexing may take a moment):\n${folders.map((f) => `- ${f.path}/${f.files !== undefined ? ` (${f.files}${f.truncated ? '+' : ''} indexable files)` : ''}`).join('\n')}]`)
  return out
}

/** screencapture arguments for an interactive region (or window, with Space) screenshot, silent, to `out`. */
export const screencaptureArgs = (out: string): string[] => ['-i', '-x', '-o', out]

/**
 * A region screenshot the user takes (macOS `screencapture -i`: they drag a region or press Esc).
 * Only ever started from the user's click in the composer, never by the agent. null when cancelled.
 */
export async function takeScreenshot(o: { tmp?: string; run?: (bin: string, args: string[]) => Promise<void>; now?: Date } = {}): Promise<string | null> {
  const d = o.now ?? new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const out = join(attachTmp(o.tmp), `Screenshot ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}.png`)
  const run = o.run ?? ((bin, args) => new Promise<void>((ok) => { execFile(bin, args, { timeout: 5 * 60_000 }, () => ok()) }))
  await run('/usr/sbin/screencapture', screencaptureArgs(out))
  return existsSync(out) && statSync(out).size > 0 ? out : null
}

/** A safe file name for pasted or dragged-in data (no folders, no hidden files, a sensible extension). */
export function blobName(name: string, mime: string): string {
  const ext = Object.entries(MIME).find(([, m]) => m === mime)?.[0] ?? (mime.startsWith('image/') ? `.${mime.slice(6).replace(/[^a-z0-9]/g, '')}` : '')
  let n = basename(String(name || '')).replace(/[^\w .()-]+/g, '-').replace(/^[.\s-]+/, '').slice(0, 120)
  if (!n) n = mime.startsWith('image/') ? 'Pasted image' : 'Pasted file'
  if (!extname(n) && ext) n += ext
  return n
}
