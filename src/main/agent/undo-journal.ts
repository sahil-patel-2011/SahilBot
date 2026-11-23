import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// Undo for what a task did to your files. Approvals stop an action before it happens; this takes back one that
// already happened (Grok Bot reviewers: "approvals don't reverse anything"). Before a bot changes a file
// (file_write, file_edit, file_manage move/copy, documents), the original is kept; after, the result's
// fingerprint. Undo puts each file back the way it was and moves files the task created into a holding folder (never
// deleted). A file someone changed since is left alone and reported. Kept on disk, so it survives a restart.
// Commands a bot runs in the terminal aren't covered (their changes aren't known file by file).

export interface UndoEntry { path: string; kind: 'modified' | 'created'; backup?: string; after?: string; at: number }
interface Manifest { threadId: string; key: string; entries: UndoEntry[]; undone?: number }
export interface UndoResult { restored: string[]; removed: string[]; skipped: Array<{ path: string; why: string }> }

let root = join(tmpdir(), 'sahilbot-undo')
/** This chat's current task (the message that started it): changes are grouped by it. */
const current = new Map<string, string>()

export function setUndoRoot(dir: string): void { root = dir }
export function beginRun(threadId: string, key: string): void { current.set(threadId, key) }
export function currentRun(threadId: string): string | undefined { return current.get(threadId) }

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

/** Before a bot writes, replaces or creates `full`: keeps the original (the first time this task touches it). */
export function beforeChange(threadId: string | undefined, full: string): void {
  const key = threadId ? current.get(threadId) : undefined
  if (!threadId || !key) return
  try {
    const m = load(threadId, key)
    if (m.undone || m.entries.some((e) => e.path === full)) return
    const exists = existsSync(full) && lstatSync(full).isFile()
    const entry: UndoEntry = { path: full, kind: exists ? 'modified' : 'created', at: Date.now() }
    if (exists) {
      const d = dirOf(threadId, key)
      mkdirSync(d, { recursive: true })
      entry.backup = join(d, `${m.entries.length}-${safe(basename(full))}.orig`)
      copyFileSync(full, entry.backup)
    }
    m.entries.push(entry)
    save(m)
  } catch { /* undo is best effort: never block the write */ }
}

/** After the write: the result's fingerprint, so undo can tell whether someone changed the file since. */
export function afterChange(threadId: string | undefined, full: string): void {
  const key = threadId ? current.get(threadId) : undefined
  if (!threadId || !key) return
  try {
    const m = load(threadId, key)
    const e = m.entries.find((x) => x.path === full)
    if (!e) return
    e.after = hash(full)
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
    const now = hash(e.path)
    // Changed since the task (by you, or another task): left alone.
    if (e.after && now !== undefined && now !== e.after) { out.skipped.push({ path: e.path, why: 'it was changed after the task' }); continue }
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
