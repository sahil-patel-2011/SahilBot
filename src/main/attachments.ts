import { dialog, nativeImage, net, protocol, shell, type BrowserWindow } from 'electron'
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Attachment, AttachResult, FilePreview } from '@shared/types'
import { docxHtml, IMAGE_EXT, mimeFor, pptxSlides, xlsxSheets } from './docs/read'
import { MAX_ATTACH_BYTES, attachTmp, blobName, humanSize, processAttachment, takeScreenshot } from './attach-process'

/** A data: URL of an image scaled to fit `maxEdge` (Electron's nativeImage); small images go as they are. */
export async function imageDataUrl(p: string, maxEdge: number): Promise<string | null> {
  const ext = extname(p).toLowerCase()
  const size = statSync(p).size
  const img = nativeImage.createFromPath(p)
  if (img.isEmpty()) return null
  const { width, height } = img.getSize()
  const scale = Math.min(1, maxEdge / Math.max(width, height, 1))
  // Already small enough: the original bytes (GIFs keep their animation).
  if (scale === 1 && size <= 5_000_000 && ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return `data:${mimeFor(p)};base64,${readFileSync(p).toString('base64')}`
  const out = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : img
  // PNGs (screenshots, diagrams) stay PNG when that's still small; photos become JPEG.
  if (ext === '.png') { const png = out.toPNG(); if (png.length <= 4_000_000) return `data:image/png;base64,${png.toString('base64')}` }
  return `data:image/jpeg;base64,${out.toJPEG(85).toString('base64')}`
}

// Files and folders reach the agent only through a user action: the open dialog or a
// drag-and-drop the preload resolves. Main remembers those paths; the renderer can't invent them.

export const SCHEME = 'foreman-file'
/** Videos the File panel plays (a <video> over foreman-file:). */
const VIDEO_PREVIEW = new Set(['.mp4', '.m4v', '.mov', '.webm'])

export class Attachments {
  private picked = new Set<string>()
  /** Everything previewable this session: the workspace, the docs, and granted roots. */
  private allowed = new Set<string>()

  constructor(private win: () => BrowserWindow | null, private workspace: () => string, docsDir: string) {
    this.allowed.add(docsDir)
  }

  private describe(p: string): Attachment {
    const st = statSync(p)
    const kind = st.isDirectory() ? 'folder' : IMAGE_EXT.has(extname(p).toLowerCase()) ? 'image' : 'file'
    const a: Attachment = { path: p, name: basename(p), kind, size: st.isDirectory() ? undefined : st.size }
    if (kind === 'image' && st.size <= 8_000_000) a.dataUrl = `data:${mimeFor(p)};base64,${readFileSync(p).toString('base64')}`
    return a
  }

  /**
   * Picked or dropped paths, processed (types, size cap, HEIC → JPEG, images scaled for vision). Each
   * one that's accepted is remembered as user-picked; the rest come back with why.
   */
  async add(paths: string[]): Promise<AttachResult> {
    const out: AttachResult = { added: [], rejected: [] }
    for (const raw of paths.filter((p) => typeof p === 'string' && p)) {
      if (!existsSync(raw)) { out.rejected.push({ name: basename(raw), reason: 'It no longer exists.' }); continue }
      const r = await processAttachment(realpathSync(raw), { imageDataUrl })
      if (!r.ok) { out.rejected.push({ name: r.name, reason: r.reason }); continue }
      // A converted photo is a new file: both it and the original count as picked.
      this.picked.add(realpathSync(raw))
      this.picked.add(r.attachment.path)
      out.added.push(r.attachment)
    }
    return out
  }

  /** Pasted or dragged-in data with no file behind it (a screenshot on the clipboard, an image from a web page): saved to a temp file, then added. */
  async addBlob(name: string, mime: string, data: Uint8Array): Promise<AttachResult> {
    const n = blobName(name, mime)
    if (data.byteLength > MAX_ATTACH_BYTES) return { added: [], rejected: [{ name: n, reason: `${n} is ${humanSize(data.byteLength)}. Files up to ${humanSize(MAX_ATTACH_BYTES)} can be attached.` }] }
    const p = join(attachTmp(), `${Date.now().toString(36)}-${n}`)
    writeFileSync(p, Buffer.from(data))
    return this.add([p])
  }

  /** The user's region screenshot (Take screenshot): the window steps aside while they select. */
  async screenshot(): Promise<Attachment | null> {
    const w = this.win()
    const shown = !!w && w.isVisible()
    if (shown) w!.hide()
    try {
      const p = await takeScreenshot()
      return p ? (await this.add([p])).added[0] ?? null : null
    } finally {
      if (shown && w && !w.isDestroyed()) w.show()
    }
  }

  /** The picker's choice, processed like a drop. */
  async pickAll(kind: 'files' | 'folder'): Promise<AttachResult> {
    const w = this.win()
    const opts: Electron.OpenDialogOptions = kind === 'folder'
      ? { title: 'Attach a folder SahilBot can work in', properties: ['openDirectory', 'createDirectory', 'multiSelections'] }
      : { title: 'Attach files', properties: ['openFile', 'multiSelections'] }
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? { added: [], rejected: [] } : this.add(r.filePaths)
  }

  /** True when the user picked or dropped this path (or a folder holding it) in this session. */
  wasPicked(p: string): boolean {
    const real = existsSync(p) ? realpathSync(p) : resolve(p)
    return [...this.picked].some((r) => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep))
  }

  register(paths: string[]): Attachment[] {
    return paths.filter((p) => p && existsSync(p)).map((p) => {
      const r = realpathSync(p)
      this.picked.add(r)
      return this.describe(r)
    })
  }

  async pick(kind: 'files' | 'folder'): Promise<Attachment[]> {
    return (await this.pickAll(kind)).added
  }

  /** Only paths the user picked or dropped are accepted. */
  accept(paths: string[]): string[] {
    const ok = paths.map((p) => (existsSync(p) ? realpathSync(p) : p)).filter((p) => this.picked.has(p))
    ok.forEach((p) => this.allowed.add(p))
    return ok
  }

  allow(p: string): void {
    this.allowed.add(p)
  }

  private isAllowed(p: string): boolean {
    const real = existsSync(p) ? realpathSync(p) : resolve(p)
    const roots = [this.workspace(), ...this.allowed].map((r) => (existsSync(r) ? realpathSync(r) : r))
    return roots.some((r) => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep))
  }

  url(p: string): string {
    return `${SCHEME}://local${pathToFileURL(p).pathname}`
  }

  /**
   * Serves allowed local files to the renderer (images, PDFs in the File panel). Nothing served here can
   * run: every file but a PDF gets INERT_CSP (so an .html/.svg in the workspace is a dead document even if
   * something navigates to it). Pages run only in their own session (agent/tools/pages.ts), never via this.
   */
  registerProtocol(): void {
    protocol.handle(SCHEME, async (req) => {
      let p = ''
      try { p = decodeURIComponent(new URL(req.url).pathname) } catch { /* refused below */ }
      if (!p || !this.isAllowed(p) || !existsSync(p)) return new Response('Not allowed', { status: 403 })
      // A <video> asks for byte ranges (seeking): passed on to the file fetch.
      const range = req.headers.get('range')
      const res = await net.fetch(pathToFileURL(p).toString(), range ? { headers: { range } } : undefined)
      const headers = new Headers(res.headers)
      for (const [k, v] of Object.entries(fileHeaders(p))) headers.set(k, v)
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    })
  }

  async preview(p: string): Promise<FilePreview> {
    const full = resolve(p)
    if (!this.isAllowed(full)) throw new Error('SahilBot can only preview files in the workspace or ones you attached.')
    if (!existsSync(full)) throw new Error('The file no longer exists.')
    const st = statSync(full)
    const base = { path: full, name: basename(full), size: st.size, url: this.url(full) }
    const ext = extname(full).toLowerCase()
    if (st.isDirectory()) return { ...base, kind: 'unsupported', note: 'This is a folder.' }
    if (IMAGE_EXT.has(ext) || ext === '.svg') return { ...base, kind: 'image' }
    if (ext === '.pdf') return { ...base, kind: 'pdf' }
    if (VIDEO_PREVIEW.has(ext)) return { ...base, kind: 'video' }
    if (ext === '.docx') return { ...base, kind: 'html', html: await docxHtml(full) }
    if (ext === '.xlsx' || ext === '.xlsm') return { ...base, kind: 'sheets', sheets: await xlsxSheets(full, 500) }
    if (ext === '.pptx') return { ...base, kind: 'slides', slides: await pptxSlides(full) }
    if (st.size > 2_000_000) return { ...base, kind: 'unsupported', note: 'Too large to preview here.' }
    const buf = readFileSync(full)
    if (buf.subarray(0, 8000).includes(0)) return { ...base, kind: 'unsupported', note: 'Binary file.' }
    const text = buf.toString('utf8')
    if (ext === '.md' || ext === '.markdown') return { ...base, kind: 'markdown', text }
    if (ext === '.csv') return { ...base, kind: 'sheets', sheets: [{ name: base.name, rows: text.split(/\r?\n/).filter(Boolean).slice(0, 500).map((l) => l.split(',')) }] }
    return { ...base, kind: 'text', text }
  }

  open(p: string): Promise<string> {
    if (!this.isAllowed(p)) throw new Error('Not allowed')
    return shell.openPath(p)
  }

  reveal(p: string): void {
    if (this.isAllowed(p)) shell.showItemInFolder(p)
  }
}

/** No script (sandbox without allow-scripts, opaque origin) and no network; inline styles and data: images still show. */
export const INERT_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"

/**
 * Response headers for a file served over foreman-file: in the app session. PDFs keep working in
 * Chromium's viewer (a sandboxed document can't host it) but are always typed as PDF; everything else,
 * whatever its extension or sniffed type, is an inert document when opened as one. (Images, audio and video
 * shown by <img>/<video> ignore a CSP header, so the File panel and thumbnails are unaffected.)
 */
export function fileHeaders(p: string): Record<string, string> {
  const base = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
  if (extname(p).toLowerCase() === '.pdf') return { ...base, 'Content-Type': 'application/pdf' }
  return { ...base, 'Content-Security-Policy': INERT_CSP }
}

export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
}
