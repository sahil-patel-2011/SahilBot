import type { DatabaseSync } from 'node:sqlite'
import type { ActivityTimelineItem } from '@shared/types'
import { labelOf, type CleanSample } from './rules'

// Local only, in its own tables (never in settings, memories or any export): raw samples for at most
// two hours, rolled into a compact session timeline ("10:05–10:40 Onshape — Intake v3 Part Studio")
// kept for the user's retention (1–72 h, default 24).

export const RAW_KEEP_MS = 2 * 60 * 60_000
/** Two samples this far apart (or closer) with the same label are one session; a longer gap starts a new one. */
export const SESSION_GAP_MS = 150_000
/** A single look counts as this long (the sampling interval). */
export const SAMPLE_SPAN_MS = 60_000

export interface StoredSample extends CleanSample {
  at: number
}

export interface Session {
  start: number
  end: number
  label: string
  app: string
  /** Samples rolled into it. */
  count: number
}

/**
 * Samples (oldest first) → sessions: consecutive samples with the same label, no gap longer than
 * SESSION_GAP_MS. Each session ends where its last sample does.
 */
export function rollup(samples: StoredSample[], gapMs = SESSION_GAP_MS): Session[] {
  const out: Session[] = []
  for (const s of [...samples].sort((a, b) => a.at - b.at)) {
    const label = labelOf(s)
    const last = out[out.length - 1]
    if (last && last.label === label && s.at - last.end <= gapMs) { last.end = s.at; last.count++ } else out.push({ start: s.at, end: s.at, label, app: s.app, count: 1 })
  }
  return out
}

interface Db { sql: DatabaseSync }

export class ActivityStore {
  constructor(private db: Db) {
    db.sql.exec(`CREATE TABLE IF NOT EXISTS activity_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS activity_samples_at ON activity_samples(at);
      CREATE TABLE IF NOT EXISTS activity_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, start INTEGER NOT NULL, end INTEGER NOT NULL,
        label TEXT NOT NULL, app TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS activity_sessions_end ON activity_sessions(end);`)
  }

  /** Keeps one sample and extends (or starts) the session it belongs to. */
  add(s: StoredSample): void {
    this.db.sql.prepare('INSERT INTO activity_samples(at, data) VALUES(?, ?)').run(s.at, JSON.stringify({ ...s, at: undefined }))
    const label = labelOf(s)
    const last = this.db.sql.prepare('SELECT id, end, label FROM activity_sessions ORDER BY end DESC, id DESC LIMIT 1').get() as { id: number; end: number; label: string } | undefined
    if (last && last.label === label && s.at >= last.end && s.at - last.end <= SESSION_GAP_MS) {
      this.db.sql.prepare('UPDATE activity_sessions SET end = ?, count = count + 1 WHERE id = ?').run(s.at, last.id)
    } else {
      this.db.sql.prepare('INSERT INTO activity_sessions(start, end, label, app, count) VALUES(?, ?, ?, ?, 1)').run(s.at, s.at, label, s.app)
    }
  }

  /**
   * Deletes with SQLite's secure_delete on (the freed pages are zeroed, not left in the file), back to
   * the connection's own setting after. Returns how many rows went.
   */
  private secure(fn: () => number): number {
    let prev = 0
    try { prev = Number((this.db.sql.prepare('PRAGMA secure_delete').get() as { secure_delete?: number } | undefined)?.secure_delete ?? 0) } catch { prev = 0 }
    try { this.db.sql.exec('PRAGMA secure_delete = ON') } catch { /* older SQLite: plain delete */ }
    try { return fn() } finally { try { this.db.sql.exec(`PRAGMA secure_delete = ${prev === 1 ? 'ON' : prev === 2 ? 'FAST' : 'OFF'}`) } catch { /* ignore */ } }
  }

  /** The write-ahead log can still hold deleted rows: fold it into the (zeroed) file and truncate it. */
  private checkpoint(mode: 'PASSIVE' | 'TRUNCATE'): void {
    try { this.db.sql.exec(`PRAGMA wal_checkpoint(${mode})`) } catch { /* busy or not WAL: the next checkpoint does it */ }
  }

  /** Raw samples older than two hours and sessions older than the retention go (zeroed on disk). */
  prune(now: number, retentionHours: number): void {
    const keep = Math.max(1, Math.min(72, retentionHours)) * 60 * 60_000
    const gone = this.secure(() =>
      Number(this.db.sql.prepare('DELETE FROM activity_samples WHERE at < ?').run(now - Math.min(RAW_KEEP_MS, keep)).changes) +
      Number(this.db.sql.prepare('DELETE FROM activity_sessions WHERE end < ?').run(now - keep).changes))
    if (gone > 0) this.checkpoint('PASSIVE')
  }

  /** Everything goes now: zeroed in the file and out of the write-ahead log. */
  clear(): void {
    this.secure(() => { this.db.sql.exec('DELETE FROM activity_samples; DELETE FROM activity_sessions;'); return 0 })
    this.checkpoint('TRUNCATE')
  }

  latest(): StoredSample | undefined {
    const r = this.db.sql.prepare('SELECT at, data FROM activity_samples ORDER BY at DESC, id DESC LIMIT 1').get() as { at: number; data: string } | undefined
    return r ? this.parse(r) : undefined
  }

  samples(since = 0): StoredSample[] {
    return (this.db.sql.prepare('SELECT at, data FROM activity_samples WHERE at >= ? ORDER BY at, id').all(since) as Array<{ at: number; data: string }>).map((r) => this.parse(r))
  }

  /** Sessions that ended at or after `since`, newest first. */
  sessions(since = 0, limit = 500): Session[] {
    return (this.db.sql.prepare('SELECT start, end, label, app, count FROM activity_sessions WHERE end >= ? ORDER BY end DESC, id DESC LIMIT ?').all(since, limit) as unknown as Session[])
      .map((r) => ({ start: Number(r.start), end: Number(r.end), label: String(r.label), app: String(r.app), count: Number(r.count) }))
  }

  counts(): { samples: number; sessions: number } {
    const n = (t: string): number => Number((this.db.sql.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n)
    return { samples: n('activity_samples'), sessions: n('activity_sessions') }
  }

  timeline(since: number, now: number): ActivityTimelineItem[] {
    return this.sessions(since).map((s) => ({ start: s.start, end: Math.min(now, s.end + SAMPLE_SPAN_MS), label: s.label }))
  }

  private parse(r: { at: number; data: string }): StoredSample {
    let d: CleanSample
    try { d = JSON.parse(r.data) as CleanSample } catch { d = { app: '', bundleId: '' } }
    return { ...d, at: Number(r.at) }
  }
}
