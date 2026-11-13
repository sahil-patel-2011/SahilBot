import type { InterruptedRun, Message } from '@shared/types'
import type { Db } from './db'

// Work in progress survives a quit, a crash or a sleeping Mac:
// - Every top-level run is written down when it starts and crossed off when it ends. Rows still there at
//   the next launch are runs cut off by SahilBot closing: their chats get a notice with a Continue button.
// - While anything runs, the Mac is kept from idle-sleeping (powerSaveBlocker 'prevent-app-suspension').
// The tables are created here (like the budget guard's), so no numbered migration is needed.

/** The hidden note a resumed run starts with. */
export const RESUME_NOTE = "[You were interrupted by the app closing. Check what's already done (files, steps), then continue the task.]"
/** Added to the user's next message in an interrupted chat (e.g. "continue"). */
export const RESUME_NEXT_NOTE = "[Your previous run in this chat was cut off when SahilBot closed. If the user wants you to go on, check what's already done (files, steps) first, then continue the task; don't start over.]"
export const INTERRUPTED_TEXT = 'SahilBot was closed while working on this.'

/** The minimal powerSaveBlocker surface (Electron's, or a fake in tests). */
export interface Blocker {
  start(type: 'prevent-app-suspension'): number
  stop(id: number): void
}

/** Holds one 'prevent-app-suspension' blocker while wanted; idempotent both ways. */
export class KeepAwake {
  private id: number | null = null
  constructor(private blocker: Blocker) {}
  get on(): boolean { return this.id !== null }
  set(want: boolean): void {
    if (want && this.id === null) {
      try { this.id = this.blocker.start('prevent-app-suspension') } catch { this.id = null }
    } else if (!want && this.id !== null) {
      try { this.blocker.stop(this.id) } catch { /* already gone */ }
      this.id = null
    }
  }
}

/** Whether to hold the Mac awake: the setting is on and something is running. */
export const wantAwake = (setting: boolean | undefined, working: number): boolean => setting !== false && working > 0

type Row = Record<string, unknown>

export class WorkTracker {
  private active = new Map<string, number>()
  private closing = false
  /** Called whenever the set of running chats changes (keep-awake, menu bar icon). */
  onChange?: () => void

  constructor(private db: Db, private now: () => number = Date.now) {
    db.sql.exec(`CREATE TABLE IF NOT EXISTS runs_active (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, started_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS runs_interrupted (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
      notice_id TEXT NOT NULL, started_at INTEGER NOT NULL, at INTEGER NOT NULL);`)
  }

  /** Chats running right now. */
  working(): string[] {
    return [...this.active.keys()]
  }

  /** A run started (top-level chats only; helpers live inside their lead's run). */
  started(threadId: string): void {
    if (!threadId) return
    const at = this.now()
    this.active.set(threadId, at)
    try { this.db.sql.prepare('INSERT INTO runs_active(thread_id, started_at) VALUES(?, ?) ON CONFLICT(thread_id) DO UPDATE SET started_at = excluded.started_at').run(threadId, at) } catch { /* thread gone */ }
    this.onChange?.()
  }

  /** A run ended (finished, stopped by the user, or failed). While quitting the row stays: that run was cut off. */
  ended(threadId: string): void {
    if (!this.active.delete(threadId)) return
    if (!this.closing) {
      try { this.db.sql.prepare('DELETE FROM runs_active WHERE thread_id = ?').run(threadId) } catch { /* database closing */ }
    }
    this.onChange?.()
  }

  /** The app is quitting: runs ending from here on were cut off, not finished. */
  quitting(): void {
    this.closing = true
  }

  /**
   * At launch, before anything runs: every run left from last time was cut off. Each chat (that still
   * exists) gets one notice with a Continue button; returns the notices posted.
   */
  recover(): Array<{ threadId: string; message: Message }> {
    const rows = this.db.sql.prepare('SELECT thread_id, started_at FROM runs_active').all() as Row[]
    this.db.sql.prepare('DELETE FROM runs_active').run()
    const out: Array<{ threadId: string; message: Message }> = []
    for (const r of rows) {
      const threadId = r.thread_id as string
      const thread = this.db.getThread(threadId)
      if (!thread || thread.parentId) continue
      // An older Continue from an earlier interruption is replaced by this one.
      this.clearNotice(threadId)
      const message = this.db.insertMessage({
        threadId, role: 'assistant', content: INTERRUPTED_TEXT, kind: 'notice', status: 'done',
        meta: { interrupted: true, resumable: true, startedAt: r.started_at as number }
      })
      this.db.sql.prepare('INSERT INTO runs_interrupted(thread_id, notice_id, started_at, at) VALUES(?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET notice_id = excluded.notice_id, started_at = excluded.started_at, at = excluded.at')
        .run(threadId, message.id, r.started_at as number, this.now())
      this.db.updateThread(threadId, { unread: true })
      out.push({ threadId, message })
    }
    return out
  }

  /** Chats still offering Continue. */
  interrupted(): InterruptedRun[] {
    return (this.db.sql.prepare('SELECT * FROM runs_interrupted ORDER BY at DESC').all() as Row[])
      .map((r) => ({ threadId: r.thread_id as string, noticeId: r.notice_id as string, startedAt: r.started_at as number, at: r.at as number }))
  }

  isInterrupted(threadId: string): boolean {
    return !!this.db.sql.prepare('SELECT 1 FROM runs_interrupted WHERE thread_id = ?').get(threadId)
  }

  /**
   * The chat moved on (Continue, or the user wrote something): the notice loses its button. Returns the
   * updated notice so main can send it to the window, or null if there was nothing to clear.
   */
  clearNotice(threadId: string): Message | null {
    const r = this.db.sql.prepare('SELECT notice_id FROM runs_interrupted WHERE thread_id = ?').get(threadId) as Row | undefined
    if (!r) return null
    this.db.sql.prepare('DELETE FROM runs_interrupted WHERE thread_id = ?').run(threadId)
    const m = this.db.getMessage(r.notice_id as string)
    if (!m) return null
    m.meta = { ...m.meta, resumable: false }
    this.db.updateMessage(m)
    return m
  }
}
