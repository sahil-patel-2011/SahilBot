import { randomUUID } from 'node:crypto'
import type { Goal, GoalAsk, GoalJournalEntry, GoalMilestone, GoalStatus } from '@shared/types'
import type { Db } from '../db'

// Goals live in the `goals` table (db.ts migration): plain columns for what the scheduler and the
// Tasks board filter on, JSON for the ordered milestones, the journal, queued asks and the wake log.

/** Journal entries kept per goal (oldest dropped). */
export const JOURNAL_KEPT = 200
/** Wake-up times kept per goal (for the daily run cap). */
const WAKE_LOG_KEPT = 60
export const MAX_MILESTONES = 30

type Row = Record<string, unknown>

const json = <T>(v: unknown, fallback: T): T => {
  try { return (typeof v === 'string' ? JSON.parse(v) : fallback) as T } catch { return fallback }
}

const toGoal = (r: Row): Goal => ({
  id: r.id as string,
  botId: r.space_id as string,
  threadId: (r.thread_id as string | null) ?? null,
  title: r.title as string,
  doneWhen: (r.done_when as string) ?? '',
  milestones: json<GoalMilestone[]>(r.milestones, []),
  journal: json<GoalJournalEntry[]>(r.journal, []),
  status: r.status as GoalStatus,
  statusReason: (r.status_reason as string | null) ?? null,
  nextWakeAt: (r.next_wake as number | null) ?? null,
  nextWakeNote: (r.wake_note as string | null) ?? null,
  ...(r.wake_tainted ? { nextWakeTainted: true } : {}),
  endAt: (r.end_at as number | null) ?? null,
  maxUsd: Number(r.max_usd ?? 0),
  maxRunsPerDay: Number(r.max_runs_per_day ?? 0),
  spentUsd: Number(r.spent_usd ?? 0),
  wakes: Number(r.wakes ?? 0),
  lastWakeAt: (r.last_wake as number | null) ?? null,
  stall: Number(r.stall ?? 0),
  asks: json<GoalAsk[]>(r.asks, []),
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number
})

export interface NewGoal {
  botId: string
  threadId: string | null
  title: string
  doneWhen: string
  milestones: string[]
  maxUsd: number
  maxRunsPerDay: number
  endAt: number | null
}

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export const milestoneId = (): string => `m${randomUUID().slice(0, 6)}`

export class GoalStore {
  constructor(private db: Db, private now: () => number = Date.now) {
    // The migration makes it; this keeps a database from before it (or a test's) working too.
    db.sql.exec(`CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, thread_id TEXT,
      title TEXT NOT NULL, done_when TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', status_reason TEXT,
      milestones TEXT NOT NULL DEFAULT '[]', journal TEXT NOT NULL DEFAULT '[]', asks TEXT NOT NULL DEFAULT '[]',
      wake_log TEXT NOT NULL DEFAULT '[]', next_wake INTEGER, wake_note TEXT, end_at INTEGER,
      max_usd REAL NOT NULL DEFAULT 2, max_runs_per_day INTEGER NOT NULL DEFAULT 6, spent_usd REAL NOT NULL DEFAULT 0,
      wakes INTEGER NOT NULL DEFAULT 0, last_wake INTEGER, stall INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
    // Added later: whether the next wake note came from a tainted run, and a wake-up in flight (a quit or
    // crash during it leaves this set, so the next launch knows it was cut off).
    const cols = new Set((db.sql.prepare('PRAGMA table_info(goals)').all() as Array<{ name: string }>).map((c) => c.name))
    if (!cols.has('wake_tainted')) db.sql.exec('ALTER TABLE goals ADD COLUMN wake_tainted INTEGER NOT NULL DEFAULT 0')
    if (!cols.has('wake_inflight')) db.sql.exec('ALTER TABLE goals ADD COLUMN wake_inflight INTEGER NOT NULL DEFAULT 0')
  }

  list(botId?: string): Goal[] {
    const rows = botId
      ? this.db.sql.prepare('SELECT * FROM goals WHERE space_id = ? ORDER BY created_at DESC').all(botId)
      : this.db.sql.prepare('SELECT * FROM goals ORDER BY created_at DESC').all()
    return (rows as Row[]).map(toGoal)
  }

  get(id: string): Goal | undefined {
    const r = this.db.sql.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Row | undefined
    return r ? toGoal(r) : undefined
  }

  /** Active goals whose wake-up is due. */
  due(now: number): Goal[] {
    return (this.db.sql.prepare(`SELECT * FROM goals WHERE status = 'active' AND next_wake IS NOT NULL AND next_wake <= ? ORDER BY next_wake`).all(now) as Row[]).map(toGoal)
  }

  create(g: NewGoal): Goal {
    const id = `g${randomUUID().slice(0, 7)}`
    const at = this.now()
    const ms: GoalMilestone[] = g.milestones.map((t) => clip(t, 160)).filter(Boolean).slice(0, MAX_MILESTONES).map((title) => ({ id: milestoneId(), title, status: 'pending' }))
    this.db.sql.prepare(`INSERT INTO goals(id, space_id, thread_id, title, done_when, status, milestones, journal, max_usd, max_runs_per_day, end_at, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, g.botId, g.threadId, clip(g.title, 120), g.doneWhen.trim().slice(0, 1000), 'active', JSON.stringify(ms),
      JSON.stringify([{ at, text: 'Goal started.', kind: 'status' } satisfies GoalJournalEntry]), g.maxUsd, g.maxRunsPerDay, g.endAt, at, at)
    return this.get(id)!
  }

  /** Writes the goal back and bumps updated_at. Spend is never written here: only addSpend changes it. */
  save(g: Goal, wakeLog?: number[]): Goal {
    const at = this.now()
    const journal = g.journal.slice(-JOURNAL_KEPT)
    this.db.sql.prepare(`UPDATE goals SET thread_id=?, title=?, done_when=?, status=?, status_reason=?, milestones=?, journal=?, asks=?,
      next_wake=?, wake_note=?, wake_tainted=?, end_at=?, max_usd=?, max_runs_per_day=?, wakes=?, last_wake=?, stall=?, updated_at=? WHERE id=?`)
      .run(g.threadId, g.title, g.doneWhen, g.status, g.statusReason, JSON.stringify(g.milestones), JSON.stringify(journal), JSON.stringify(g.asks),
        g.nextWakeAt, g.nextWakeNote, g.nextWakeNote && g.nextWakeTainted ? 1 : 0, g.endAt, g.maxUsd, g.maxRunsPerDay, g.wakes, g.lastWakeAt, g.stall, at, g.id)
    if (wakeLog) this.db.sql.prepare('UPDATE goals SET wake_log = ? WHERE id = ?').run(JSON.stringify(wakeLog.slice(-WAKE_LOG_KEPT)), g.id)
    return this.get(g.id)!
  }

  /** Read-modify-write of one goal (synchronous, so nothing interleaves). */
  update(id: string, fn: (g: Goal) => void): Goal {
    const g = this.get(id)
    if (!g) throw new Error(`No goal ${id}`)
    fn(g)
    return this.save(g)
  }

  wakeLog(id: string): number[] {
    const r = this.db.sql.prepare('SELECT wake_log FROM goals WHERE id = ?').get(id) as Row | undefined
    return json<number[]>(r?.wake_log, [])
  }

  logWake(id: string, at: number): void {
    const log = [...this.wakeLog(id), at].slice(-WAKE_LOG_KEPT)
    this.db.sql.prepare('UPDATE goals SET wake_log = ? WHERE id = ?').run(JSON.stringify(log), id)
  }

  /** A wake-up is running (set before it starts, cleared when it ends). */
  setInflight(id: string, on: boolean): void {
    this.db.sql.prepare('UPDATE goals SET wake_inflight = ? WHERE id = ?').run(on ? 1 : 0, id)
  }

  inflight(id: string): boolean {
    const r = this.db.sql.prepare('SELECT wake_inflight FROM goals WHERE id = ?').get(id) as Row | undefined
    return !!r?.wake_inflight
  }

  /** Adds spend atomically (requests can finish while the goal is being edited elsewhere). */
  addSpend(id: string, usd: number): void {
    if (!(usd > 0)) return
    this.db.sql.prepare('UPDATE goals SET spent_usd = spent_usd + ? WHERE id = ?').run(usd, id)
  }

  /** `tainted`: written by a run that had read outside content (shown and treated as data at wake-ups). */
  journal(g: Goal, text: string, kind: GoalJournalEntry['kind'] = 'note', tainted = false): void {
    const t = text.replace(/\s+\n/g, '\n').trim().slice(0, 1200)
    if (t) g.journal.push({ at: this.now(), text: t, kind, ...(tainted ? { tainted: true } : {}) })
    if (g.journal.length > JOURNAL_KEPT) g.journal.splice(0, g.journal.length - JOURNAL_KEPT)
  }
}
