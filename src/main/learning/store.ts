import { randomUUID } from 'node:crypto'
import type { LearnedKind } from '@shared/types'
import type { Db } from '../db'
import type { Memory, MemoryProvenance } from '../memory'
import { dayKey } from '../usage'
import { rejectKey } from './extract'

// The learning log: every memory, skill and lesson learned while idle, and every memory merged or
// retired, with what Undo needs to put things back. Its table is made here (not a numbered migration)
// so it never collides with other features adding migrations; the shape is append-only. Rows go with
// what they're about: deleting a chat or a bot deletes its rows (triggers), and forgetting a memory
// deletes the rows that hold its words (purgeMemory). Things the user undid are kept only as hashes.

/** What Undo does for an entry. */
export type UndoPlan =
  | { op: 'remove-memory'; id: string; content: string }
  | { op: 'restore-memory'; memory: Pick<Memory, 'id' | 'category' | 'content' | 'spaceId' | 'source' | 'createdAt' | 'updatedAt'> & { provenance?: MemoryProvenance }; revert?: { id: string; from: string; to: string } }
  | { op: 'remove-skill'; name: string }
  | { op: 'restore-skill'; name: string; prev: { description: string; body: string; source: 'learned' | 'you' } }
  /** Waiting for the user's OK (Approve saves it, Dismiss drops it): a rule learned from a chat with outside content. */
  | { op: 'pending-memory'; content: string; kind: string; spaceId: string | null }
  /** A learned skill saved as `untrusted: true` (kept out of the skill index) until the user approves it. */
  | { op: 'pending-skill'; name: string }

export const isPending = (u?: UndoPlan): boolean => u?.op === 'pending-memory' || u?.op === 'pending-skill'

export interface LogEntry {
  id: string
  at: number
  kind: LearnedKind
  title: string
  detail?: string
  threadId?: string | null
  spaceId?: string | null
  untrusted: boolean
  origin?: string
  undo?: UndoPlan
  undoneAt?: number | null
}

/** Progress between passes, so an interrupted pass picks up where it stopped. */
export interface LearningState {
  /** Per chat: the newest message time already read for memories. */
  threads: Record<string, number>
  /** Runs (their opening message ids) already looked at for skills and lessons. */
  runs: string[]
  lastRunAt?: number
  lastSummary?: string
  lastConsolidateAt?: number
  /** Memory count and newest update at the last consolidation: unchanged → skip. */
  consolidateSig?: string
  /** Cloud dollars spent on learning, by local day. */
  spend: Record<string, number>
  /** Memories the user undid, dismissed or forgot: never learned again. Hashes (rejectKey), never the words. */
  rejected: string[]
  /** Skills the user undid. */
  rejectedSkills: string[]
  /** Memories the user put back after tidying: never retired again. */
  kept: string[]
}

const STATE_KEY = 'learning:state'
type Row = Record<string, unknown>

export class LearningStore {
  constructor(private db: Db) {
    db.sql.exec(`CREATE TABLE IF NOT EXISTS learning_log (
      id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT,
      thread_id TEXT, space_id TEXT, untrusted INTEGER NOT NULL DEFAULT 0, origin TEXT, undo TEXT, undone_at INTEGER);
      CREATE INDEX IF NOT EXISTS learning_log_at ON learning_log(at DESC);
      CREATE TRIGGER IF NOT EXISTS learning_log_forget_thread AFTER DELETE ON threads BEGIN
        DELETE FROM learning_log WHERE thread_id = OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS learning_log_forget_space AFTER DELETE ON spaces BEGIN
        DELETE FROM learning_log WHERE space_id = OLD.id OR (thread_id IS NOT NULL AND thread_id NOT IN (SELECT id FROM threads)); END;`)
    // Older logs kept the words of what was undone: only their hashes from now on.
    const raw = db.getSetting<Partial<LearningState>>(STATE_KEY)
    if (raw?.rejected?.some((r) => typeof r === 'string' && !r.startsWith('h:'))) this.patch({})
  }

  /** The user forgot this memory: rows that hold its words go (its learned entry, tidying that touched it). */
  purgeMemory(id: string): number {
    return Number(this.db.sql.prepare(`DELETE FROM learning_log WHERE undo IS NOT NULL AND (
      (json_extract(undo, '$.op') = 'remove-memory' AND json_extract(undo, '$.id') = ?)
      OR json_extract(undo, '$.memory.id') = ? OR json_extract(undo, '$.revert.id') = ?)`).run(id, id, id).changes)
  }

  /** A chat or bot is gone (the triggers do this too; kept for callers that delete outside SQL). */
  purgeThread(threadId: string): void {
    this.db.sql.prepare('DELETE FROM learning_log WHERE thread_id = ?').run(threadId)
  }

  purgeSpace(spaceId: string): void {
    this.db.sql.prepare('DELETE FROM learning_log WHERE space_id = ?').run(spaceId)
  }

  /** Replaces an entry's plan (an approved item gets its Undo) and, optionally, its title and detail. */
  setUndo(id: string, undo: UndoPlan | null, patch: { title?: string; detail?: string } = {}): void {
    const cur = this.get(id)
    if (!cur) return
    this.db.sql.prepare('UPDATE learning_log SET undo = ?, title = ?, detail = ? WHERE id = ?')
      .run(undo ? JSON.stringify(undo) : null, (patch.title ?? cur.title).slice(0, 400), (patch.detail ?? cur.detail)?.slice(0, 2000) ?? null, id)
  }

  add(e: Omit<LogEntry, 'id' | 'at'> & { at?: number }): LogEntry {
    const entry: LogEntry = { ...e, id: randomUUID(), at: e.at ?? Date.now() }
    this.db.sql.prepare('INSERT INTO learning_log(id, at, kind, title, detail, thread_id, space_id, untrusted, origin, undo, undone_at) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)')
      .run(entry.id, entry.at, entry.kind, entry.title.slice(0, 400), entry.detail?.slice(0, 2000) ?? null, entry.threadId ?? null, entry.spaceId ?? null, entry.untrusted ? 1 : 0, entry.origin ?? null, entry.undo ? JSON.stringify(entry.undo) : null)
    // The log keeps the last 1000 entries.
    this.db.sql.prepare('DELETE FROM learning_log WHERE id IN (SELECT id FROM learning_log ORDER BY at DESC LIMIT -1 OFFSET 1000)').run()
    return entry
  }

  list(limit = 200): LogEntry[] {
    return (this.db.sql.prepare('SELECT * FROM learning_log ORDER BY at DESC LIMIT ?').all(Math.max(1, Math.min(1000, limit))) as Row[]).map(toEntry)
  }

  get(id: string): LogEntry | undefined {
    const r = this.db.sql.prepare('SELECT * FROM learning_log WHERE id = ?').get(id) as Row | undefined
    return r ? toEntry(r) : undefined
  }

  markUndone(id: string): void {
    this.db.sql.prepare('UPDATE learning_log SET undone_at = ? WHERE id = ?').run(Date.now(), id)
  }

  state(): LearningState {
    const s = this.db.getSetting<Partial<LearningState>>(STATE_KEY) ?? {}
    const rejected = (s.rejected ?? []).filter((r): r is string => typeof r === 'string').map((r) => (r.startsWith('h:') ? r : rejectKey(r)))
    return { threads: s.threads ?? {}, runs: s.runs ?? [], spend: s.spend ?? {}, rejected, rejectedSkills: s.rejectedSkills ?? [], kept: s.kept ?? [], ...pick(s) }
  }

  patch(p: Partial<LearningState>): LearningState {
    const next = { ...this.state(), ...p }
    next.rejected = [...new Set(next.rejected.map((r) => (r.startsWith('h:') ? r : rejectKey(r))))]
    // Bounded: old chats and runs fall off.
    next.runs = next.runs.slice(-800)
    next.rejected = next.rejected.slice(-300)
    next.rejectedSkills = next.rejectedSkills.slice(-100)
    next.kept = next.kept.slice(-500)
    const keys = Object.keys(next.threads)
    if (keys.length > 600) for (const k of keys.sort((a, b) => next.threads[a] - next.threads[b]).slice(0, keys.length - 600)) delete next.threads[k]
    const days = Object.keys(next.spend).sort()
    for (const d of days.slice(0, Math.max(0, days.length - 14))) delete next.spend[d]
    this.db.setSetting(STATE_KEY, next)
    return next
  }

  spentToday(now = Date.now()): number {
    return this.state().spend[dayKey(now)] ?? 0
  }

  addSpend(usd: number, now = Date.now()): void {
    if (!(usd > 0)) return
    const st = this.state()
    const d = dayKey(now)
    this.patch({ spend: { ...st.spend, [d]: (st.spend[d] ?? 0) + usd } })
  }
}

function pick(s: Partial<LearningState>): Partial<LearningState> {
  const out: Partial<LearningState> = {}
  if (s.lastRunAt !== undefined) out.lastRunAt = s.lastRunAt
  if (s.lastSummary !== undefined) out.lastSummary = s.lastSummary
  if (s.lastConsolidateAt !== undefined) out.lastConsolidateAt = s.lastConsolidateAt
  if (s.consolidateSig !== undefined) out.consolidateSig = s.consolidateSig
  return out
}

function toEntry(r: Row): LogEntry {
  let undo: UndoPlan | undefined
  try { undo = r.undo ? (JSON.parse(r.undo as string) as UndoPlan) : undefined } catch { undo = undefined }
  return {
    id: r.id as string, at: r.at as number, kind: r.kind as LearnedKind, title: r.title as string, detail: (r.detail as string | null) ?? undefined,
    threadId: (r.thread_id as string | null) ?? null, spaceId: (r.space_id as string | null) ?? null, untrusted: !!r.untrusted,
    origin: (r.origin as string | null) ?? undefined, undo, undoneAt: (r.undone_at as number | null) ?? null
  }
}
