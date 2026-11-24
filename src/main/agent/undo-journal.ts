import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// Undo for what a task did to your files. Approvals stop an action before it happens; this takes back one that
// already happened (Grok Bot reviewers: "approvals don't reverse anything"). Before a bot changes a file
// (file_write, file_edit, file_manage move/copy, documents), the original is kept; after, the result's
// fingerprint. Undo puts each file back the way it was and moves files the task created into a holding folder (never
// deleted). A file someone changed since is left alone and reported. Kept on disk, so it survives a restart, for 30
// days. A file or folder the bot deletes (file_manage delete, to the Trash) is copied first, so Undo brings it back.
// Commands a bot runs in the terminal aren't covered (their changes aren't known file by file); deleting or replacing
// your files with rm, >, cp or mv is refused for that reason (tools/shell.ts), so those go through the file tools.

/** 'moved': a folder moved from `from` to `path` (undo moves it back). */
export interface UndoEntry { path: string; kind: 'modified' | 'created' | 'moved'; backup?: string; after?: string; at: number; dir?: boolean; from?: string }
interface Manifest { threadId: string; key: string; entries: UndoEntry[]; undone?: number }
export interface UndoResult { restored: string[]; removed: string[]; skipped: Array<{ path: string; why: string }> }

let root = join(tmpdir(), 'sahilbot-undo')
/** This chat's current task (the message that started it): changes are grouped by it. */
const current = new Map<string, string>()
/** When this chat's current task started. */
const started = new Map<string, number>()

/** How long a task's undo copies are kept. */
const KEEP_MS = 30 * 24 * 3600_000
/** A file the task deleted: its fingerprint "after" the change. */
const GONE = 'gone'

export function setUndoRoot(dir: string): void {
  root = dir
  prune()
}

/** Removes undo copies of tasks older than 30 days (at start-up). */
export function prune(now = Date.now()): void {
  try {
    for (const t of readdirSync(root)) {
      const td = join(root, t)
      for (const k of readdirSync(td)) {
        const kd = join(td, k)
        try { if (now - statSync(join(kd, 'manifest.json')).mtimeMs > KEEP_MS) rmSync(kd, { recursive: true, force: true }) } catch { /* not a task folder */ }
      }
    }
  } catch { /* nothing kept yet */ }
}
export function beginRun(threadId: string, key: string): void { current.set(threadId, key); started.set(threadId, Date.now()) }
export function currentRun(threadId: string): string | undefined { return current.get(threadId) }
/** When this chat's current task started (undefined when none has in this session). */
export function runStart(threadId: string | undefined): number | undefined { return threadId ? started.get(threadId) : undefined }

const safe = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
const dirOf = (threadId: string, key: string): string => join(root, safe(threadId), safe(key))
const hash = (p: string): string | undefined => { try { return createHash('sha256').update(readFileSync(p)).digest('hex') } catch { return undefined } }

function load(threadId: string, key: string): Manifest {
  try { return JSON.parse(readFileSync(join(dirOf(threadId, key), 'manifest.json'), 'utf8')) as Manifest } catch { return { threadId, key, entries: [] } }
}
function save(m: Manifest): void {
  const d = dirOf(m.threadId, m.key)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'manifest.json'), JSON.stringify(m))
}

/** Folders bigger than this aren't copied before a delete (they stay in the Trash). */
const MAX_DIR_FILES = 5000
const MAX_DIR_BYTES = 500_000_000

/** A folder too big to copy before a delete (Undo can't bring it back; the Trash still can). */
export const tooBigToKeep = (full: string): boolean => { try { return lstatSync(full).isDirectory() && !smallFolder(full) } catch { return false } }

function smallFolder(dir: string): boolean {
  let files = 0
  let bytes = 0
  const walk = (d: string): boolean => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) { if (!walk(p)) return false; continue }
      files++
      try { bytes += lstatSync(p).size } catch { /* gone */ }
      if (files > MAX_DIR_FILES || bytes > MAX_DIR_BYTES) return false
    }
    return true
  }
  try { return walk(dir) } catch { return false }
}

/**
 * Before a bot writes, replaces, creates or deletes `full`: keeps the original (the first time this task touches it).
 * `o.folder`: a folder about to be deleted is copied too (when it isn't huge). `o.newFolder`: a folder about to be
 * made there (a copy): Undo takes the whole folder away.
 */
export function beforeChange(threadId: string | undefined, full: string, o: { folder?: boolean; newFolder?: boolean } = {}): void {
  const key = threadId ? current.get(threadId) : undefined
  if (!threadId || !key) return
  try {
    const m = load(threadId, key)
    if (m.undone || m.entries.some((e) => e.path === full)) return
    const isDir = !!o.folder && existsSync(full) && lstatSync(full).isDirectory()
    if (isDir && !smallFolder(full)) return
    const exists = isDir || (existsSync(full) && lstatSync(full).isFile())
    const entry: UndoEntry = { path: full, kind: exists ? 'modified' : 'created', at: Date.now(), ...(isDir || (o.newFolder && !exists) ? { dir: true } : {}) }
    if (exists) {
      const d = dirOf(threadId, key)
      mkdirSync(d, { recursive: true })
      entry.backup = join(d, `${m.entries.length}-${safe(basename(full))}.orig`)
      if (isDir) cpSync(full, entry.backup, { recursive: true })
      else copyFileSync(full, entry.backup)
    }
    m.entries.push(entry)
    save(m)
  } catch { /* undo is best effort: never block the write */ }
}

/** A folder this task moved (or renamed) from `from` to `to`: Undo moves it back. */
export function noteMoved(threadId: string | undefined, from: string, to: string): void {
  const key = threadId ? current.get(threadId) : undefined
  if (!threadId || !key) return
  try {
    const m = load(threadId, key)
    if (m.undone) return
    m.entries.push({ path: to, from, kind: 'moved', at: Date.now(), dir: true })
    save(m)
  } catch { /* best effort */ }
}

/** After the write: the result's fingerprint, so undo can tell whether someone changed the file since. */
export function afterChange(threadId: string | undefined, full: string): void {
  const key = threadId ? current.get(threadId) : undefined
  if (!threadId || !key) return
  try {
    const m = load(threadId, key)
    const e = m.entries.find((x) => x.path === full)
    if (!e) return
    e.after = existsSync(full) ? (e.dir ? undefined : hash(full)) : GONE
    save(m)
  } catch { /* best effort */ }
}

/** What a task changed: its files, or undefined when it changed nothing undoable (or was already undone). */
export function changesOf(threadId: string, key: string): { files: string[]; undone: boolean } | undefined {
  const m = load(threadId, key)
  if (!m.entries.length) return undefined
  return { files: m.entries.map((e) => e.path), undone: !!m.undone }
}

/** Takes back a task's file changes, newest first. */
export function undoRun(threadId: string, key: string): UndoResult {
  const m = load(threadId, key)
  const out: UndoResult = { restored: [], removed: [], skipped: [] }
  if (m.undone) return out
  const hold = join(dirOf(threadId, key), 'removed')
  for (const e of [...m.entries].reverse()) {
    // A moved folder: back where it was, unless it's gone from the new place or something new took the old one.
    if (e.kind === 'moved' && e.from) {
      if (!existsSync(e.path)) { out.skipped.push({ path: e.path, why: 'it was moved or removed after the task' }); continue }
      if (existsSync(e.from)) { out.skipped.push({ path: e.path, why: `something new is at ${basename(e.from)} now` }); continue }
      try {
        mkdirSync(dirname(e.from), { recursive: true })
        renameSync(e.path, e.from)
        out.restored.push(e.from)
      } catch (err) { out.skipped.push({ path: e.path, why: (err as Error).message }) }
      continue
    }
    const now = hash(e.path)
    // A deleted file or folder: back from the copy kept before the delete, unless something new is there now.
    if (e.after === GONE) {
      if (existsSync(e.path)) { out.skipped.push({ path: e.path, why: 'something new is there now' }); continue }
      try {
        if (!e.backup) continue
        mkdirSync(dirname(e.path), { recursive: true })
        if (e.dir) cpSync(e.backup, e.path, { recursive: true })
        else copyFileSync(e.backup, e.path)
        out.restored.push(e.path)
      } catch (err) { out.skipped.push({ path: e.path, why: (err as Error).message }) }
      continue
    }
    // Changed since the task (by you, or another task): left alone.
    if (e.after && now !== undefined && now !== e.after) { out.skipped.push({ path: e.path, why: 'it was changed after the task' }); continue }
    // A folder the task made (a copy): taken away whole, into the holding folder.
    if (e.dir && e.kind === 'created') {
      if (!existsSync(e.path)) continue
      try {
        mkdirSync(hold, { recursive: true })
        renameSync(e.path, join(hold, `${Date.now()}-${basename(e.path)}`))
        out.removed.push(e.path)
      } catch (err) { out.skipped.push({ path: e.path, why: (err as Error).message }) }
      continue
    }
    if (e.dir) continue
    try {
      if (e.kind === 'modified' && e.backup) {
        mkdirSync(dirname(e.path), { recursive: true })
        copyFileSync(e.backup, e.path)
        out.restored.push(e.path)
      } else if (e.kind === 'created') {
        if (now === undefined) continue
        mkdirSync(hold, { recursive: true })
        renameSync(e.path, join(hold, `${Date.now()}-${basename(e.path)}`))
        out.removed.push(e.path)
      }
    } catch (err) { out.skipped.push({ path: e.path, why: (err as Error).message }) }
  }
  m.undone = Date.now()
  save(m)
  return out
}

/**
 * True when a task in this chat created `full` (and wasn't undone) and it is still exactly what this chat last wrote
 * there: the chat's own file, so rebuilding it replaces nothing of the user's, even after a restart. Once someone
 * else changes it (the user, another app, another bot), it is theirs (FFA-02: "even to restore" a file).
 */
export function createdInThread(threadId: string, full: string): boolean {
  let created = false
  let newest: UndoEntry | undefined
  try {
    const td = join(root, safe(threadId))
    for (const k of readdirSync(td)) {
      try {
        const m = JSON.parse(readFileSync(join(td, k, 'manifest.json'), 'utf8')) as Manifest
        if (m.undone) continue
        for (const e of m.entries) {
          if (e.path !== full || e.dir) continue
          if (e.kind === 'created') created = true
          if (!newest || e.at >= newest.at) newest = e
        }
      } catch { /* not a task folder */ }
    }
  } catch { /* nothing kept for this chat */ }
  return created && !!newest?.after && newest.after !== GONE && newest.after === hash(full)
}

/** The latest task in this chat (before the one running now) that changed files and isn't undone yet. */
export function lastUndoable(threadId: string, keys: string[]): string | undefined {
  const now = current.get(threadId)
  for (const k of [...keys].reverse()) {
    if (k === now) continue
    const c = changesOf(threadId, k)
    if (c && !c.undone) return k
  }
  return undefined
}

/** A short, plain summary of an undo for the chat. */
export function undoSummary(r: UndoResult): string {
  const name = (p: string): string => basename(p)
  const parts: string[] = []
  if (r.restored.length) parts.push(`put back ${r.restored.map(name).join(', ')}`)
  if (r.removed.length) parts.push(`removed ${r.removed.map(name).join(', ')} (kept in a holding folder, not deleted)`)
  const head = parts.length ? `Undone: ${parts.join('; ')}.` : 'Nothing to undo.'
  return r.skipped.length ? `${head} Left alone: ${r.skipped.map((s) => `${name(s.path)} (${s.why})`).join(', ')}.` : head
}
