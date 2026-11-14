// Clipboard and text input for computer use. Typing key by key is slow and mangles anything outside
// plain ASCII on many layouts (emoji, CJK, accents), and newlines become Return presses; pasting puts
// the exact text in at once. So long or non-ASCII text is pasted: SahilBot saves the user's clipboard
// (every item and type, images and files included), puts the text on it marked transient (clipboard
// managers skip it), presses cmd+v, waits until the text has landed, and puts the user's clipboard
// back, unless the user copied something new in the meantime. Everything here but the JXA source is
// pure, so the restore logic is tested with a fake clipboard.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** What a save() kept, to give back to restore(). */
export interface SavedClipboard {
  /** The pasteboard's change count when saved. */
  changeCount: number
  /** Items saved (0 = the clipboard was empty). */
  items: number
  bytes: number
  /** Where the saved data sits (a private temp folder, removed by discard()). */
  dir?: string
  /** A password manager's concealed item: never written anywhere; restore() just clears the clipboard. */
  concealed?: boolean
  /** Too big to keep in full: only text-like types were kept. */
  partial?: boolean
}

export interface ClipboardRead {
  text?: string
  changeCount: number
  /** Marked concealed by a password manager (org.nspasteboard.ConcealedType): never shown to the model. */
  concealed: boolean
  types: string[]
}

/** The clipboard as computer use needs it (the real one runs JXA; tests pass a fake). */
export interface ClipboardIO {
  save(): Promise<SavedClipboard>
  /** Puts plain text on the clipboard and returns the change count afterwards. transient: clipboard managers skip it. */
  writeText(text: string, o?: { transient?: boolean }): Promise<number>
  changeCount(): Promise<number>
  restore(saved: SavedClipboard): Promise<void>
  read(): Promise<ClipboardRead>
  /** Frees what save() kept (temp files). */
  discard?(saved: SavedClipboard): void
}

export type RestoreOutcome = 'restored' | 'kept-new-copy' | 'cleared-concealed' | 'unchanged' | 'failed'

export interface TempClipboardResult<T> {
  result: T
  restore: RestoreOutcome
  error?: string
}

/**
 * Puts text on the clipboard for the length of `use` (which pastes it), then gives the user's clipboard
 * back. The clipboard is restored even when `use` throws. If the change count moved after SahilBot's
 * write (the user, or the app, copied something new), the new contents stay: restoring would throw away
 * what the user just copied.
 */
export async function withTemporaryClipboard<T>(clip: ClipboardIO, text: string, use: () => Promise<T>): Promise<TempClipboardResult<T>> {
  const saved = await clip.save()
  let ours: number | undefined
  let result: T | undefined
  let failure: unknown
  try {
    ours = await clip.writeText(text, { transient: true })
    result = await use()
  } catch (e) {
    failure = e
  }
  let restore: RestoreOutcome = 'unchanged'
  let error: string | undefined
  try {
    const now = await clip.changeCount()
    const touched = ours !== undefined || now !== saved.changeCount
    if (!touched) restore = 'unchanged'
    else if (ours !== undefined && now !== ours) restore = 'kept-new-copy'
    else {
      await clip.restore(saved)
      restore = saved.concealed ? 'cleared-concealed' : 'restored'
    }
  } catch (e) {
    restore = 'failed'
    error = (e as Error).message
  } finally {
    try { clip.discard?.(saved) } catch { /* temp files only */ }
  }
  if (failure !== undefined) throw failure
  return { result: result as T, restore, error }
}

/** One line for the model about what happened to the user's clipboard. */
export function describeRestore(r: RestoreOutcome, error?: string): string {
  switch (r) {
    case 'restored': return 'The user\'s clipboard was put back.'
    case 'unchanged': return ''
    case 'kept-new-copy': return 'Something new was copied meanwhile, so the clipboard was left as it is.'
    case 'cleared-concealed': return 'The clipboard held a password manager\'s hidden item, which SahilBot never keeps; the clipboard is now empty.'
    case 'failed': return `Couldn't put the user's clipboard back${error ? ` (${error.slice(0, 120)})` : ''}.`
  }
}

// ------------------------------------------------------------------------------------------ type or paste

export type InputMethod = 'type' | 'paste'

/** Longest text that is still typed key by key (when it is plain ASCII). */
export const TYPE_MAX = 40

/**
 * Typing or pasting. Short plain ASCII is typed (it works everywhere, including fields that block paste
 * or react to each key, like autocomplete). Anything long, with newlines or tabs (typed, they'd press
 * Return or move focus), or outside printable ASCII (emoji, CJK, accents, smart quotes) is pasted.
 */
export function chooseInputMethod(text: string, method: 'auto' | InputMethod = 'auto'): { method: InputMethod; why: string } {
  if (method === 'type') return { method: 'type', why: 'asked to type key by key' }
  if (method === 'paste') return { method: 'paste', why: 'asked to paste' }
  if (/[\n\r\t]/.test(text)) return { method: 'paste', why: 'it has line breaks or tabs' }
  if (/[^\x20-\x7e]/.test(text)) return { method: 'paste', why: 'it has characters outside plain ASCII' }
  if (Array.from(text).length > TYPE_MAX) return { method: 'paste', why: `it is longer than ${TYPE_MAX} characters` }
  return { method: 'type', why: 'short plain text' }
}

// ------------------------------------------------------------------------------------------ did it land?

const norm = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/[   ]/g, ' ').replace(/[​﻿]/g, '')

/**
 * Whether text typed or pasted into a field shows up in its value. 'unknown' when the app doesn't expose
 * the value (web content, custom-drawn editors), so the model should look instead. Single-line fields
 * often turn pasted line breaks into spaces or keep only the first line; each line arriving in order
 * counts as landed.
 */
export function textLanded(before: string | undefined, after: string | undefined, text: string): 'yes' | 'no' | 'unknown' {
  if (after === undefined) return 'unknown'
  if (!text) return 'yes'
  const a = norm(after)
  const t = norm(text)
  if (a.includes(t)) return before !== undefined && norm(before).includes(t) && norm(before) === a ? 'no' : 'yes'
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length > 1) {
    let from = 0
    for (const l of lines) {
      const i = a.indexOf(l, from)
      if (i < 0) return 'no'
      from = i + l.length
    }
    return 'yes'
  }
  // Fields that reformat (phone numbers, credit-card-style grouping) or autocorrect: compare letters and digits.
  const bare = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
  return bare(t).length >= 4 && bare(a).includes(bare(t)) ? 'yes' : 'no'
}

// ------------------------------------------------------------------------------------------ JXA

/**
 * The general pasteboard through AppKit. ops:
 * - count → { count }
 * - read → { text?, count, concealed, types }
 * - write { text | file, transient } → { count }  (file: UTF-8 text in a file, for very long text)
 * - save { dir, maxBytes } → { count, items, bytes, concealed?, partial?, manifest }: every item's data
 *   per type into files in dir (a private temp folder); a concealed item is not written anywhere.
 * - restore { dir, manifest } → { count }: the saved items back (an empty manifest clears the clipboard).
 */
export const CLIP = `(a) => {
  const pb = $.NSPasteboard.generalPasteboard
  const count = () => Number(pb.changeCount)
  const typesOf = (item) => { const t = item.types; const out = []; for (let j = 0; j < Number(t.count); j++) out.push(ObjC.unwrap(t.objectAtIndex(j))); return out }
  const items = () => { const arr = pb.pasteboardItems; const out = []; if (!arr) return out; for (let i = 0; i < Number(arr.count); i++) out.push(arr.objectAtIndex(i)); return out }
  const allTypes = () => { const s = []; for (const it of items()) for (const t of typesOf(it)) if (s.indexOf(t) < 0) s.push(t); return s }
  const CONCEALED = 'org.nspasteboard.ConcealedType'
  if (a.op === 'count') return { count: count() }
  if (a.op === 'read') {
    const types = allTypes()
    const s = pb.stringForType('public.utf8-plain-text')
    const text = s && !s.isNil() ? ObjC.unwrap(s) : undefined
    const concealed = types.indexOf(CONCEALED) >= 0
    return { text: concealed ? undefined : text, count: count(), concealed: concealed, types: types.slice(0, 30) }
  }
  if (a.op === 'write') {
    let s = null
    if (a.file) s = $.NSString.stringWithContentsOfFileEncodingError(a.file, $.NSUTF8StringEncoding, null)
    else s = $(String(a.text))
    if (!s || s.isNil()) return { error: 'could not read the text to paste' }
    const item = $.NSPasteboardItem.alloc.init
    item.setStringForType(s, 'public.utf8-plain-text')
    if (a.transient) { item.setDataForType($.NSData.data, 'org.nspasteboard.TransientType'); item.setDataForType($.NSData.data, 'org.nspasteboard.AutoGeneratedType') }
    pb.clearContents
    const ok = pb.writeObjects($.NSArray.arrayWithObject(item))
    return ok ? { count: count() } : { error: 'the clipboard refused the text' }
  }
  if (a.op === 'save') {
    const its = items()
    const out = { count: count(), items: its.length, bytes: 0, manifest: [] }
    if (its.some((it) => typesOf(it).indexOf(CONCEALED) >= 0)) { out.concealed = true; out.items = 0; return out }
    const TEXTY = /^(public\\.(utf8-plain-text|utf16-plain-text|rtf|html|url|file-url)|com\\.apple\\.flat-rtfd|NSStringPboardType)$/
    let total = 0
    for (let i = 0; i < its.length; i++) for (const t of typesOf(its[i])) { const d = its[i].dataForType(t); if (d && !d.isNil()) total += Number(d.length) }
    const partial = total > a.maxBytes
    const fm = $.NSFileManager.defaultManager
    for (let i = 0; i < its.length; i++) {
      const entry = []
      const types = typesOf(its[i])
      for (let j = 0; j < types.length; j++) {
        const t = types[j]
        if (partial && !TEXTY.test(t)) continue
        const d = its[i].dataForType(t)
        if (!d || d.isNil()) continue
        const file = a.dir + '/' + i + '-' + j + '.bin'
        if (!fm.createFileAtPathContentsAttributes(file, d, $({ NSFilePosixPermissions: 384 }))) continue
        out.bytes += Number(d.length)
        entry.push({ type: t, file: file })
      }
      out.manifest.push(entry)
    }
    if (partial) out.partial = true
    return out
  }
  if (a.op === 'restore') {
    const arr = $.NSMutableArray.alloc.init
    for (const entry of a.manifest || []) {
      if (!entry.length) continue
      const it = $.NSPasteboardItem.alloc.init
      for (const e of entry) { const d = $.NSData.dataWithContentsOfFile(e.file); if (d && !d.isNil()) it.setDataForType(d, e.type) }
      arr.addObject(it)
    }
    pb.clearContents
    if (Number(arr.count)) pb.writeObjects(arr)
    return { count: count() }
  }
  return { error: 'unknown op' }
}`

/** Runs a JXA function source with JSON input and returns its JSON output (computer.ts's runner). */
export type JxaRunner = (fn: string, input: unknown, timeoutMs: number) => Promise<unknown>

/** Text longer than this goes to the pasteboard through a temp file instead of the command line. */
const ARGV_MAX = 150_000
/** Saved clipboards bigger than this keep only their text-like types. */
const SAVE_MAX = 64 * 1024 * 1024

/** The real clipboard, through the CLIP script. Saved data lives in a private temp folder until discarded. */
export function jxaClipboard(run: JxaRunner): ClipboardIO {
  type Reply = { count?: number; error?: string }
  const call = async <T extends Reply>(input: Record<string, unknown>, timeout = 15_000): Promise<T> => {
    const r = (await run(CLIP, input, timeout)) as T
    if (!r || r.error) throw new Error(r?.error ?? 'The clipboard didn\'t answer.')
    return r
  }
  const manifests = new WeakMap<SavedClipboard, unknown>()
  return {
    async save() {
      const dir = mkdtempSync(join(tmpdir(), 'sb-clip-'))
      try {
        const r = await call<Reply & { items: number; bytes: number; concealed?: boolean; partial?: boolean; manifest: unknown }>({ op: 'save', dir, maxBytes: SAVE_MAX }, 30_000)
        const saved: SavedClipboard = { changeCount: r.count ?? 0, items: r.items, bytes: r.bytes, dir, concealed: r.concealed, partial: r.partial }
        manifests.set(saved, r.manifest)
        return saved
      } catch (e) {
        rmSync(dir, { recursive: true, force: true })
        throw e
      }
    },
    async writeText(text, o) {
      if (Buffer.byteLength(text) <= ARGV_MAX) return (await call({ op: 'write', text, transient: !!o?.transient })).count ?? 0
      const dir = mkdtempSync(join(tmpdir(), 'sb-paste-'))
      try {
        const file = join(dir, 'text.txt')
        writeFileSync(file, text, { mode: 0o600 })
        return (await call({ op: 'write', file, transient: !!o?.transient }, 30_000)).count ?? 0
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    async changeCount() {
      return (await call({ op: 'count' })).count ?? 0
    },
    async restore(saved) {
      await call({ op: 'restore', manifest: saved.concealed ? [] : manifests.get(saved) ?? [] }, 30_000)
    },
    async read() {
      const r = await call<Reply & { text?: string; concealed: boolean; types: string[] }>({ op: 'read' })
      return { text: r.text, changeCount: r.count ?? 0, concealed: !!r.concealed, types: r.types ?? [] }
    },
    discard(saved) {
      if (saved.dir) rmSync(saved.dir, { recursive: true, force: true })
    }
  }
}
