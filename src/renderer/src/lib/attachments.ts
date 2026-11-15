import type { AttachCategory, Attachment } from '@shared/types'

// Composer attachments: what was dropped or pasted, sizes for the chips, and the limits the main process
// enforces (attach-process.ts), so the composer can say no before sending anything.

export const MAX_ATTACH_BYTES = 100 * 1024 * 1024

export function humanSize(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return ''
  return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`
}

/** The chip's category (older attachments have none: inferred from kind and name). */
export function categoryFor(a: Pick<Attachment, 'kind' | 'name' | 'category'>): AttachCategory {
  if (a.category) return a.category
  if (a.kind === 'folder') return 'folder'
  if (a.kind === 'image') return 'image'
  const ext = a.name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'pdf') return 'pdf'
  if (['docx', 'xlsx', 'xlsm', 'pptx'].includes(ext)) return 'office'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff'].includes(ext)) return 'image'
  return 'text'
}

/** A short label for the chip under the name: "PDF · 2.1 MB", "Folder · 1,204 files". */
export function chipDetail(a: Attachment): string {
  const c = categoryFor(a)
  const kind = c === 'folder' ? 'Folder' : c === 'pdf' ? 'PDF' : c === 'office' ? (a.name.match(/\.(\w+)$/)?.[1] ?? 'Office').toUpperCase() : c === 'image' ? 'Image' : c === 'code' ? 'Code' : c === 'binary' ? 'File' : 'Text'
  if (c === 'folder') return a.files !== undefined ? `${kind} · ${a.files.toLocaleString()}${a.truncated ? '+' : ''} file${a.files === 1 ? '' : 's'}` : kind
  return [kind, humanSize(a.size)].filter(Boolean).join(' · ')
}

/** Items from a drop or paste: files (with or without a path behind them) and plain links. */
export function fromTransfer(dt: Pick<DataTransfer, 'files' | 'getData' | 'types'> | null): { files: File[]; urls: string[] } {
  if (!dt) return { files: [], urls: [] }
  const files = Array.from(dt.files ?? [])
  let urls: string[] = []
  if (!files.length && Array.from(dt.types ?? []).includes('text/uri-list')) {
    urls = dt.getData('text/uri-list').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && /^https?:\/\//i.test(l)).slice(0, 10)
  }
  return { files, urls }
}

/** Files over the limit, refused before anything is read or sent. */
export function oversize(files: File[]): { ok: File[]; rejected: Array<{ name: string; reason: string }> } {
  const ok: File[] = []
  const rejected: Array<{ name: string; reason: string }> = []
  for (const f of files) {
    if (f.size > MAX_ATTACH_BYTES) rejected.push({ name: f.name || 'Item', reason: `${f.name || 'It'} is ${humanSize(f.size)}. Files up to ${humanSize(MAX_ATTACH_BYTES)} can be attached; for a bigger one, attach the folder it's in.` })
    else ok.push(f)
  }
  return { ok, rejected }
}

/** One line for refused items (a toast). */
export function rejectedText(r: Array<{ name: string; reason: string }>): string {
  if (!r.length) return ''
  if (r.length === 1) return `Couldn't attach ${r[0].name}: ${r[0].reason}`
  return `Couldn't attach ${r.length} items: ${r.slice(0, 3).map((x) => `${x.name} (${x.reason})`).join('; ')}${r.length > 3 ? '…' : ''}`
}

/** Adds new attachments to the list, without duplicates (by path). */
export function mergeAttachments(cur: Attachment[], add: Attachment[]): Attachment[] {
  return [...cur, ...add.filter((x, i) => !cur.some((c) => c.path === x.path) && add.findIndex((y) => y.path === x.path) === i)]
}

/** The last part of a folder path, for the working-folder chip. */
export const folderName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p
