import { randomUUID } from 'node:crypto'
import type { RoutineRun, Schedule, ScheduledTask } from '@shared/types'
import type { Db } from './db'

// Scheduled tasks: once / daily / weekly / every N minutes / cron. Due tasks run as normal agent
// turns in an unattended mode where anything that would need approval is skipped, not done.
// Missed runs (Mac asleep) are coalesced into one run, never replayed one by one.

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function field(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>()
  for (const part of spec.split(',')) {
    const [range, stepS] = part.split('/')
    const step = Number(stepS ?? 1)
    let [a, b] = range === '*' ? [min, max] : range.split('-').map(Number)
    if (b === undefined) b = stepS ? max : a
    if ([a, b, step].some((n) => Number.isNaN(n)) || a < min || b > max || step < 1) throw new Error(`Bad cron field "${spec}"`)
    for (let v = a; v <= b; v += step) out.add(v)
  }
  return out
}

/** Next time strictly after `from` matching a 5-field cron expression (minute hour dom month dow), local time. */
export function nextCron(expr: string, from: Date): Date {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) throw new Error('Cron needs 5 fields: minute hour day month weekday')
  const [mi, h, dom, mo, dow] = [field(f[0], 0, 59), field(f[1], 0, 23), field(f[2], 1, 31), field(f[3], 1, 12), field(f[4].replace(/7/g, '0'), 0, 6)]
  const d = new Date(from)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const domOk = f[2] === '*' ? true : dom.has(d.getDate())
    const dowOk = f[4] === '*' ? true : dow.has(d.getDay())
    const dayOk = f[2] !== '*' && f[4] !== '*' ? domOk || dowOk : domOk && dowOk
    if (mo.has(d.getMonth() + 1) && dayOk && h.has(d.getHours()) && mi.has(d.getMinutes())) return d
    d.setMinutes(d.getMinutes() + 1)
  }
  throw new Error('Cron never matches')
}

function atTime(base: Date, time: string): Date {
  const [hh, mm] = time.split(':').map(Number)
  const d = new Date(base)
  d.setHours(hh, mm ?? 0, 0, 0)
  return d
}

/** Next run strictly after `from`, or null when a one-off has passed. */
export function nextRun(s: Schedule, from: Date): Date | null {
  switch (s.type) {
    case 'once': {
      const at = new Date(s.at)
      return at > from ? at : null
    }
    case 'every':
      return new Date(from.getTime() + Math.max(1, s.minutes) * 60_000)
    case 'daily': {
      const t = atTime(from, s.time)
      if (t <= from) t.setDate(t.getDate() + 1)
      return t
    }
    case 'weekly': {
      const want = new Set(s.days.map((x) => DAYS.indexOf(x.slice(0, 3).toLowerCase())))
      for (let i = 0; i < 8; i++) {
        const t = atTime(from, s.time)
        t.setDate(t.getDate() + i)
        if (want.has(t.getDay()) && t > from) return t
      }
      return null
    }
    case 'cron':
      return nextCron(s.expr, from)
  }
}

export function describeSchedule(s: Schedule): string {
  switch (s.type) {
    case 'once': return `once on ${new Date(s.at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
    case 'every': return s.minutes % 60 === 0 ? `every ${s.minutes / 60} hour${s.minutes === 60 ? '' : 's'}` : `every ${s.minutes} minutes`
    case 'daily': return `every day at ${s.time}`
    case 'weekly': return `every ${s.days.map((d) => d.slice(0, 3)).join(', ')} at ${s.time}`
    case 'cron': return `cron ${s.expr}`
  }
}

type Row = Record<string, unknown>
const toTask = (r: Row): ScheduledTask => ({
  id: r.id as string,
  title: r.title as string,
  prompt: r.prompt as string,
  schedule: JSON.parse(r.schedule as string) as Schedule,
  spaceId: r.space_id as string,
  threadId: (r.thread_id as string | null) ?? null,
  enabled: r.enabled === 1,
  nextRun: (r.next_run as number | null) ?? null,
  lastRun: (r.last_run as number | null) ?? null,
  lastStatus: (r.last_status as string | null) ?? null,
  createdAt: r.created_at as number
})

/** Runs kept per routine. */
export const RUNS_KEPT = 20

/** A change worth a system line in the bot's chat ("Paused routine · …"). */
export type RoutineEvent = { type: 'created' | 'paused' | 'resumed' | 'deleted' | 'changed' | 'failed'; task: ScheduledTask; reason?: string; threadId?: string | null }

/** What a run reported, as a run-history outcome. */
export function runOutcome(status: string): { status: 'succeeded' | 'failed'; reason: string | null } {
  const s = status.trim()
  if (s === 'done' || s === 'finished' || s === 'ok') return { status: 'succeeded', reason: null }
  if (s === 'stopped') return { status: 'failed', reason: 'Stopped before it finished' }
  const m = /^(error|skipped|failed):\s*(.+)$/is.exec(s)
  if (m) return { status: 'failed', reason: m[2].trim().slice(0, 300) }
  if (s === 'error') return { status: 'failed', reason: 'Something went wrong' }
  return { status: 'failed', reason: s.slice(0, 300) || 'Something went wrong' }
}

/** A run reports a status string ('done', 'error: …', 'skipped: …') and, optionally, the chat it ran in. */
export type RunResult = string | { status: string; threadId?: string | null }

const toRun = (r: Row): RoutineRun => ({
  id: r.id as string,
  taskId: r.task_id as string,
  startedAt: r.started_at as number,
  finishedAt: (r.finished_at as number | null) ?? null,
  status: r.status as RoutineRun['status'],
  reason: (r.reason as string | null) ?? null,
  threadId: (r.thread_id as string | null) ?? null,
  test: r.test === 1
})

export class Scheduler {
  private timer: NodeJS.Timeout | null = null
  private busy = new Set<string>()
  /** Routine changes and failures (main turns these into system lines in the bot's chat). */
  events?: (e: RoutineEvent) => void

  constructor(private db: Db, private run: (task: ScheduledTask, run: { id: string; test: boolean }) => Promise<RunResult>, private changed: () => void, private now = () => new Date()) {
    // Runs cut short by a quit or crash can't still be running.
    this.db.sql.prepare(`UPDATE routine_runs SET status = 'failed', finished_at = COALESCE(finished_at, started_at), reason = 'SahilBot closed before it finished' WHERE status = 'running'`).run()
  }

  private emit(e: RoutineEvent): void {
    try { this.events?.(e) } catch { /* a system line is never worth failing the change */ }
  }

  list(): ScheduledTask[] {
    return (this.db.sql.prepare('SELECT * FROM scheduled_tasks ORDER BY COALESCE(next_run, 9e15)').all() as Row[]).map(toTask)
  }

  get(id: string): ScheduledTask | undefined {
    const r = this.db.sql.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as Row | undefined
    return r ? toTask(r) : undefined
  }

  /** Run history, newest first. */
  runs(taskId: string): RoutineRun[] {
    return (this.db.sql.prepare('SELECT * FROM routine_runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?').all(taskId, RUNS_KEPT) as Row[]).map(toRun)
  }

  isRunning(taskId: string): boolean {
    return this.busy.has(taskId)
  }

  create(t: { title: string; prompt: string; schedule: Schedule; spaceId: string; threadId?: string | null; enabled?: boolean }): ScheduledTask {
    if (!t.prompt.trim()) throw new Error('A scheduled task needs instructions.')
    if (t.prompt.length > 8000) throw new Error('Keep scheduled instructions under 8,000 characters.')
    const next = nextRun(t.schedule, this.now())
    if (!next) throw new Error('That time has already passed.')
    const id = randomUUID().slice(0, 8)
    const on = t.enabled !== false
    this.db.sql.prepare('INSERT INTO scheduled_tasks(id, title, prompt, schedule, space_id, thread_id, enabled, next_run, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, t.title.trim() || 'Scheduled task', t.prompt.trim(), JSON.stringify(t.schedule), t.spaceId, t.threadId ?? null, on ? 1 : 0, on ? next.getTime() : null, Date.now())
    this.changed()
    const task = this.get(id)!
    this.emit({ type: 'created', task })
    return task
  }

  update(id: string, patch: { enabled?: boolean; title?: string; prompt?: string; schedule?: Schedule }): ScheduledTask {
    const cur = this.get(id)
    if (!cur) throw new Error(`No scheduled task ${id}`)
    const n = { ...cur, ...patch }
    if (patch.prompt !== undefined && !n.prompt.trim()) throw new Error('A scheduled task needs instructions.')
    const next = n.enabled ? nextRun(n.schedule, this.now())?.getTime() ?? null : null
    if (n.enabled && next === null) throw new Error('That time has already passed.')
    this.db.sql.prepare('UPDATE scheduled_tasks SET title=?, prompt=?, schedule=?, enabled=?, next_run=? WHERE id=?')
      .run(n.title, n.prompt, JSON.stringify(n.schedule), n.enabled ? 1 : 0, next, id)
    this.changed()
    const task = this.get(id)!
    if (cur.enabled !== task.enabled) this.emit({ type: task.enabled ? 'resumed' : 'paused', task })
    else if (cur.title !== task.title || cur.prompt !== task.prompt || JSON.stringify(cur.schedule) !== JSON.stringify(task.schedule)) this.emit({ type: 'changed', task })
    return task
  }

  remove(id: string): void {
    const cur = this.get(id)
    this.db.sql.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
    this.changed()
    if (cur) this.emit({ type: 'deleted', task: cur })
  }

  setThread(id: string, threadId: string): void {
    this.db.sql.prepare('UPDATE scheduled_tasks SET thread_id = ? WHERE id = ?').run(threadId, id)
  }

  start(intervalMs = 20_000): void {
    void this.tick()
    this.timer = setInterval(() => void this.tick(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /** Runs everything due now. Overdue tasks run once, then advance from now. */
  async tick(): Promise<void> {
    const now = this.now()
    const due = this.list().filter((t) => t.enabled && t.nextRun !== null && t.nextRun <= now.getTime() && !this.busy.has(t.id))
    await Promise.all(due.map((t) => this.fire(t)))
  }

  /** Test: runs a routine now without touching its schedule. Returns the run id at once (null if it's already running). */
  test(id: string): { runId: string; done: Promise<void> } | null {
    const t = this.get(id)
    if (!t || this.busy.has(id)) return null
    return this.begin(t, true)
  }

  async fire(t: ScheduledTask): Promise<void> {
    if (this.busy.has(t.id)) return
    // Advance first (at-most-once), so a crash mid-run can't fire it again.
    const next = nextRun(t.schedule, this.now())
    this.db.sql.prepare('UPDATE scheduled_tasks SET next_run = ?, last_run = ?, enabled = ? WHERE id = ?')
      .run(next?.getTime() ?? null, Date.now(), next ? (t.enabled ? 1 : 0) : 0, t.id)
    await this.begin(t, false).done
  }

  /** Records the run (synchronously, so callers can return at once), then runs it. */
  private begin(t: ScheduledTask, test: boolean): { runId: string; done: Promise<void> } {
    this.busy.add(t.id)
    const runId = randomUUID()
    this.db.sql.prepare('INSERT INTO routine_runs(id, task_id, started_at, status, thread_id, test) VALUES(?,?,?,?,?,?)')
      .run(runId, t.id, Date.now(), 'running', t.threadId, test ? 1 : 0)
    this.prune(t.id)
    this.changed()
    const done = (async () => {
      let result: RunResult
      try {
        result = await this.run(t, { id: runId, test })
      } catch (e) {
        result = `error: ${(e as Error).message}`
      }
      const status = typeof result === 'string' ? result : result.status
      const threadId = (typeof result === 'string' ? null : result.threadId) ?? this.get(t.id)?.threadId ?? t.threadId
      const out = runOutcome(status)
      this.db.sql.prepare('UPDATE routine_runs SET status = ?, reason = ?, finished_at = ?, thread_id = COALESCE(?, thread_id) WHERE id = ?')
        .run(out.status, out.reason, Date.now(), threadId, runId)
      // The task may have been deleted mid-run; then there's nothing left to update.
      this.db.sql.prepare('UPDATE scheduled_tasks SET last_status = ? WHERE id = ?').run(status, t.id)
      this.busy.delete(t.id)
      this.changed()
      if (out.status === 'failed') this.emit({ type: 'failed', task: this.get(t.id) ?? t, reason: out.reason ?? undefined, threadId })
    })()
    return { runId, done }
  }

  /** Keeps the newest RUNS_KEPT runs of a routine. */
  private prune(taskId: string): void {
    this.db.sql.prepare(`DELETE FROM routine_runs WHERE task_id = ? AND id NOT IN (
      SELECT id FROM routine_runs WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?)`).run(taskId, taskId, RUNS_KEPT)
  }
}
