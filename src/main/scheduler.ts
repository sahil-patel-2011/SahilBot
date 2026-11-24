import { randomUUID } from 'node:crypto'
import type { RoutineRun, Schedule, ScheduledTask } from '@shared/types'
import type { Db } from './db'
import { describeSchedule, hasOffset } from '@shared/when'
import { pickItems, triggerNote, TRIGGER_BATCH, TRIGGER_DAILY_MAX, TRIGGER_TEST_NOTE, type TriggerItem } from './triggers'

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

/** A usable IANA time zone name. */
export function validTz(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

/** The wall-clock time in `tz` at instant `d`, as a Date whose local fields read that time. */
function wallIn(d: Date, tz: string): Date {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]))
  return new Date(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second), d.getMilliseconds())
}

/** The instant whose wall-clock time in `tz` is `wall`'s local fields (inverse of wallIn). */
function fromWall(wall: Date, tz: string): Date {
  let t = wall.getTime()
  for (let i = 0; i < 3; i++) t += wall.getTime() - wallIn(new Date(t), tz).getTime()
  return new Date(t)
}

/** Next run strictly after `from`, or null when a one-off has passed. */
export function nextRun(s: Schedule, from: Date): Date | null {
  // A place's own clock: work it out on that clock, then turn it back into a real moment.
  // (A one-off with its own offset, "…Z" or "…-05:00", is already a real moment.)
  if ('tz' in s && validTz(s.tz) && !(s.type === 'once' && hasOffset(s.at))) {
    const { tz, ...rest } = s
    const at = nextRun(rest as Schedule, wallIn(from, tz))
    return at && fromWall(at, tz)
  }
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
      const want = new Set((Array.isArray(s.days) ? s.days : []).map((x) => DAYS.indexOf(x.slice(0, 3).toLowerCase())))
      for (let i = 0; i < 8; i++) {
        const t = atTime(from, s.time)
        t.setDate(t.getDate() + i)
        if (want.has(t.getDay()) && t > from) return t
      }
      return null
    }
    case 'cron':
      return nextCron(s.expr, from)
    case 'when':
      // Runs when something arrives (onItems), never on the clock.
      return null
  }
}

/** A clock schedule missing what it runs on (a weekly with no days, a daily with no time) is a clear error, never a crash. */
function checkSchedule(s: Schedule): void {
  const x = s as Partial<{ days: unknown; time: unknown }>
  if (s.type === 'weekly' && !(Array.isArray(x.days) && x.days.some((d) => typeof d === 'string' && DAYS.includes(d.slice(0, 3).toLowerCase())))) throw new Error('A weekly schedule needs days (["mon","wed"]).')
  if ((s.type === 'daily' || s.type === 'weekly') && !(typeof x.time === 'string' && /^\d{1,2}(:\d{2})?/.test(x.time))) throw new Error('A daily or weekly schedule needs a time ("07:00").')
}

// One wording everywhere (routines screens, the schedule tool's replies, the chat's routine lines): "Weekdays at 7:30 AM ET".
export { describeSchedule }

const QUEUE_KEY = 'triggerQueue'

/** A calendar event without its version: "abc:1732000000000" and "abc:1732000500000" are one event. */
export function eventKey(x: Pick<TriggerItem, 'source' | 'id'>): string {
  return `${x.source}:${x.id.replace(/:\d{9,}$/, '')}`
}

/** What a routine run is: a test, a late catch-up, a dry run, or set off by new items (`event`). */
export interface RunInfo {
  id: string
  test: boolean
  late?: number
  dry?: boolean
  /** The items that set off a "when …" routine: the fenced note the bot reads and the raw text (for the taint check). */
  event?: { note: string; untrusted: string[]; count: number }
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

/**
 * A change worth a system line in the bot's chat ("Paused routine · …"). 'late': a missed run is running
 * now ("Ran late: was due at …"); 'missed': a missed run was skipped (older than the catch-up window).
 * dueAt is when the missed run was due (the latest missed slot).
 */
export type RoutineEvent = { type: 'created' | 'paused' | 'resumed' | 'deleted' | 'changed' | 'failed' | 'late' | 'missed'; task: ScheduledTask; reason?: string; threadId?: string | null; dueAt?: number }

/** A run due less than this long ago is on time, not "missed" (the scheduler ticks every 20 seconds). */
export const LATE_GRACE_MS = 2 * 60_000

/**
 * The latest slot of a recurring schedule that fell due at or before `now`, starting from `firstDue`
 * (its stored next run). A daily 9:00 routine missed for three days was last due today at 9:00.
 */
export function lastDue(s: Schedule, firstDue: number, now: number): number {
  if (firstDue >= now || s.type === 'once') return firstDue
  if (s.type === 'every') {
    const step = Math.max(1, s.minutes) * 60_000
    return firstDue + Math.floor((now - firstDue) / step) * step
  }
  let d = firstDue
  // Bounded: an every-minute cron missed for a week stops early at an older slot, which is still "late".
  for (let i = 0; i < 2000; i++) {
    let n: Date | null
    try { n = nextRun(s, new Date(d)) } catch { break }
    if (!n || n.getTime() > now) break
    d = n.getTime()
  }
  return d
}

/**
 * What to do with a routine that is due now.
 * - 'run': on time (or delayed only because it was still busy while the scheduler kept ticking).
 * - 'late': missed while SahilBot was closed, the Mac slept or routines were paused, and due within the
 *   catch-up window: run it once now and say it ran late.
 * - 'skip': missed and older than the window (or catch-up is off, catchUpHours 0): don't run it.
 * catchUpHours null = no window (every missed routine runs once).
 * lastTickAt = when the scheduler last checked (null on the first check after launch).
 */
export function catchUp(o: { dueAt: number; now: number; lastTickAt: number | null; catchUpHours: number | null }): 'run' | 'late' | 'skip' {
  // The scheduler was checking when it fell due: it only waited for its previous run to finish.
  if (o.lastTickAt !== null && o.lastTickAt >= o.dueAt) return 'run'
  const late = o.now - o.dueAt
  if (late <= LATE_GRACE_MS) return 'run'
  if (o.catchUpHours === null) return 'late'
  if (o.catchUpHours <= 0) return 'skip'
  return late <= o.catchUpHours * 3_600_000 ? 'late' : 'skip'
}

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
  /** Catch-up window for missed runs, in hours (0 = never catch up; null = no window). Main wires it to Settings. */
  catchUpHours: () => number | null = () => null
  /** "Pause all routines": nothing fires while true; missed runs follow the catch-up rules on resume. */
  paused: () => boolean = () => false
  /** Bot placement can pause this machine's copy of a routine without changing its schedule. */
  available: (spaceId: string) => boolean = () => true
  /** When the scheduler last checked for due routines (null until the first check after launch). */
  private lastTickAt: number | null = null
  /**
   * Goal wake-ups (goals/manager.ts): one-time wake-ups checked on every tick, alongside routines, and
   * never while "Pause all routines" is on. Main wires it to GoalManager.tick.
   */
  wakeups?: () => Promise<void>

  /** `late` (on a run) = when a missed run was due; it is running late now. */
  constructor(private db: Db, private run: (task: ScheduledTask, run: RunInfo) => Promise<RunResult>, private changed: () => void, private now = () => new Date()) {
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
    checkSchedule(t.schedule)
    const next = nextRun(t.schedule, this.now())
    if (!next && t.schedule.type !== 'when') throw new Error('That time has already passed.')
    const id = randomUUID().slice(0, 8)
    const on = t.enabled !== false
    this.db.sql.prepare('INSERT INTO scheduled_tasks(id, title, prompt, schedule, space_id, thread_id, enabled, next_run, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, t.title.trim() || 'Scheduled task', t.prompt.trim(), JSON.stringify(t.schedule), t.spaceId, t.threadId ?? null, on ? 1 : 0, on && next ? next.getTime() : null, Date.now())
    this.changed()
    const task = this.get(id)!
    if (task.schedule.type === 'when') this.arm(id)
    this.emit({ type: 'created', task })
    return task
  }

  update(id: string, patch: { enabled?: boolean; title?: string; prompt?: string; schedule?: Schedule }): ScheduledTask {
    const cur = this.get(id)
    if (!cur) throw new Error(`No scheduled task ${id}`)
    const n = { ...cur, ...patch }
    if (patch.prompt !== undefined && !n.prompt.trim()) throw new Error('A scheduled task needs instructions.')
    if (patch.schedule) checkSchedule(patch.schedule)
    const next = n.enabled ? nextRun(n.schedule, this.now())?.getTime() ?? null : null
    if (n.enabled && next === null && n.schedule.type !== 'when') throw new Error('That time has already passed.')
    this.db.sql.prepare('UPDATE scheduled_tasks SET title=?, prompt=?, schedule=?, enabled=?, next_run=? WHERE id=?')
      .run(n.title, n.prompt, JSON.stringify(n.schedule), n.enabled ? 1 : 0, next, id)
    this.changed()
    const task = this.get(id)!
    if (task.schedule.type === 'when' && (cur.schedule.type !== 'when' || (!cur.enabled && task.enabled))) this.arm(id)
    if (!task.enabled) this.unqueue(id)
    if (cur.enabled !== task.enabled) this.emit({ type: task.enabled ? 'resumed' : 'paused', task })
    else if (cur.title !== task.title || cur.prompt !== task.prompt || JSON.stringify(cur.schedule) !== JSON.stringify(task.schedule)) this.emit({ type: 'changed', task })
    return task
  }

  remove(id: string): void {
    const cur = this.get(id)
    this.db.sql.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
    this.unqueue(id)
    this.changed()
    if (cur) this.emit({ type: 'deleted', task: cur })
  }

  setThread(id: string, threadId: string): void {
    this.db.sql.prepare('UPDATE scheduled_tasks SET thread_id = ? WHERE id = ?').run(threadId, id)
  }

  start(intervalMs = 20_000): void {
    void this.tick()
    // Matches saved before a quit run now (their routines' bots and the pause state permitting).
    if (this.waiting.size) setTimeout(() => this.drainAll(), 0)
    this.timer = setInterval(() => void this.tick(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /**
   * Runs everything due now. Overdue tasks run once, then advance from now. A run missed while SahilBot
   * was closed or the Mac slept runs once if it was due within the catch-up window ("Ran late"), and is
   * skipped otherwise; a skipped one-off is turned off. Never more than one run per routine per check.
   */
  async tick(): Promise<void> {
    // Paused: nothing fires and the last check time stays put, so resuming applies the catch-up rules.
    if (this.paused()) return
    const now = this.now()
    const lastTickAt = this.lastTickAt
    this.lastTickAt = now.getTime()
    const due = this.list().filter((t) => t.enabled && t.nextRun !== null && t.nextRun <= now.getTime() && !this.busy.has(t.id) && this.available(t.spaceId))
    const window = this.catchUpHours()
    // Goal wake-ups run beside routines; a failure there never affects them.
    const goals = this.wakeups ? this.wakeups().catch(() => undefined) : Promise.resolve()
    await Promise.all([goals, ...due.map((t) => {
      const dueAt = lastDue(t.schedule, t.nextRun!, now.getTime())
      const plan = catchUp({ dueAt, now: now.getTime(), lastTickAt, catchUpHours: window })
      if (plan === 'skip') { this.skip(t, dueAt); return Promise.resolve() }
      return this.fire(t, plan === 'late' ? dueAt : undefined)
    })])
  }

  /** A missed run older than the catch-up window: advance without running (a one-off turns off). */
  private skip(t: ScheduledTask, dueAt: number): void {
    const next = nextRun(t.schedule, this.now())
    const when = new Date(dueAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    this.db.sql.prepare('UPDATE scheduled_tasks SET next_run = ?, enabled = ?, last_status = ? WHERE id = ?')
      .run(next?.getTime() ?? null, next ? 1 : 0, `skipped: missed while SahilBot was closed (due ${when})`, t.id)
    this.changed()
    this.emit({ type: 'missed', task: this.get(t.id) ?? t, dueAt })
  }

  /** Test: runs a routine now without touching its schedule. Returns the run id at once (null if it's already running). */
  /** A test run now. `dry`: a dry run (reads for real; anything that would change something is only listed). */
  test(id: string, o: { dry?: boolean } = {}): { runId: string; done: Promise<void> } | null {
    const t = this.get(id)
    if (!t || this.busy.has(id) || !this.available(t.spaceId)) return null
    return this.begin(t, true, undefined, o.dry, t.schedule.type === 'when' ? { note: TRIGGER_TEST_NOTE, untrusted: [], count: 0 } : undefined)
  }

  /** `late` = when a missed run was due (it runs now, once, and says so). */
  async fire(t: ScheduledTask, late?: number): Promise<void> {
    if (!this.available(t.spaceId)) return
    if (this.busy.has(t.id)) return
    // Advance first (at-most-once), so a crash mid-run can't fire it again.
    const next = nextRun(t.schedule, this.now())
    this.db.sql.prepare('UPDATE scheduled_tasks SET next_run = ?, last_run = ?, enabled = ? WHERE id = ?')
      .run(next?.getTime() ?? null, Date.now(), next ? (t.enabled ? 1 : 0) : 0, t.id)
    if (late !== undefined) this.emit({ type: 'late', task: t, dueAt: late })
    await this.begin(t, false, late).done
  }

  /**
   * New items from a read of mail, messages or the calendar: each "when …" routine that one of them matches runs once,
   * with the matching items (up to TRIGGER_BATCH) handed to it as outside content. `me`: the user's own addresses
   * (their own mail never sets a routine off). Returns the routines started.
   */
  onItems(items: TriggerItem[], me: string[] = []): string[] {
    if (!items.length) return []
    const started: string[] = []
    for (const t of this.list()) {
      if (!t.enabled || t.schedule.type !== 'when') continue
      // Only what arrived after the routine was set up (a first read or a backfill of older mail sets nothing off).
      // An item without a time counts as arriving now.
      const armed = this.armedAt(t)
      // A calendar event is new once: an edit or an RSVP gives it a new id and time (sources.ts calendarItems), but
      // it isn't an arrival. It counts from when it was created, and each event sets a routine off only once.
      const seen = this.seenEvents(t.id)
      const fresh = items.filter((x) => x.kind !== 'calendar' || !seen.has(eventKey(x)))
        .filter((x) => ((x.kind === 'calendar' ? x.created : undefined) || x.at || Date.now()) >= armed)
      const hit = pickItems(t.schedule, fresh, me)
      if (!hit.items.length) continue
      this.markSeen(t.id, hit.items)
      // Busy, paused, or its bot is away: kept for its next run, not dropped.
      if (this.busy.has(t.id) || this.paused() || !this.available(t.spaceId)) { this.queue(t.id, hit.items, hit.more); continue }
      if (this.startEvent(t, hit.items, hit.more)) started.push(t.id)
    }
    return started
  }

  /** The calendar events that already set this routine off (newest kept). */
  private seenEvents(id: string): Set<string> {
    return new Set(this.db.getSetting<string[]>(`triggerSeen:${id}`) ?? [])
  }

  private markSeen(id: string, items: TriggerItem[]): void {
    const keys = items.filter((x) => x.kind === 'calendar').map(eventKey)
    if (!keys.length) return
    const all = [...this.seenEvents(id)].filter((k) => !keys.includes(k))
    this.db.setSetting(`triggerSeen:${id}`, [...all, ...keys].slice(-1000))
  }

  /**
   * Matches that came in while a "when" routine was busy or paused, for its next run (newest kept). Saved too, so a
   * quit or restart doesn't lose them (the items were read once and won't be handed over again).
   */
  private waitingMap?: Map<string, { items: TriggerItem[]; more: number }>
  private get waiting(): Map<string, { items: TriggerItem[]; more: number }> {
    if (!this.waitingMap) {
      const saved = this.db.getSetting<Record<string, { items: TriggerItem[]; more: number }>>(QUEUE_KEY) ?? {}
      this.waitingMap = new Map(Object.entries(saved).filter(([, w]) => Array.isArray(w?.items)))
    }
    return this.waitingMap
  }
  private saveWaiting(): void {
    this.db.setSetting(QUEUE_KEY, Object.fromEntries(this.waiting))
  }
  private queue(id: string, items: TriggerItem[], more: number): void {
    const cur = this.waiting.get(id) ?? { items: [], more: 0 }
    const all = [...cur.items, ...items.filter((x) => !cur.items.some((y) => y.source === x.source && y.id === x.id))]
    this.waiting.set(id, { items: all.slice(-TRIGGER_BATCH), more: cur.more + more + Math.max(0, all.length - TRIGGER_BATCH) })
    this.saveWaiting()
  }
  private unqueue(id: string): void {
    if (this.waiting.delete(id)) this.saveWaiting()
  }

  /** When a "when" routine was set up, switched to "when" or turned back on: older items never set it off. */
  private armedAt(t: ScheduledTask): number {
    return this.db.getSetting<number>(`triggerArmed:${t.id}`) ?? t.createdAt
  }

  private arm(id: string): void {
    this.db.setSetting(`triggerArmed:${id}`, Date.now())
  }

  private startEvent(t: ScheduledTask, items: TriggerItem[], more: number): boolean {
    const today = new Date(this.now()); today.setHours(0, 0, 0, 0)
    const ran = (this.db.sql.prepare('SELECT COUNT(*) AS n FROM routine_runs WHERE task_id = ? AND test = 0 AND started_at >= ?').get(t.id, today.getTime()) as { n: number }).n
    if (ran >= TRIGGER_DAILY_MAX) {
      this.db.sql.prepare('UPDATE scheduled_tasks SET last_status = ? WHERE id = ?').run(`skipped: ran ${TRIGGER_DAILY_MAX} times today already`, t.id)
      return false
    }
    this.db.sql.prepare('UPDATE scheduled_tasks SET last_run = ? WHERE id = ?').run(Date.now(), t.id)
    void this.begin(t, false, undefined, false, { note: triggerNote(items, more), untrusted: items.map((x) => `${x.title}\n${x.from ?? ''}\n${x.text}`), count: items.length + more })
    return true
  }

  /** A "when" routine finished: matches that came in meanwhile run now (one run for all of them). */
  private drain(id: string): void {
    const w = this.waiting.get(id)
    const t = this.get(id)
    // A routine that's gone (or no longer "when"): its queue goes too.
    if (w && (!t || t.schedule.type !== 'when')) { this.unqueue(id); return }
    if (!w || !t || !t.enabled || this.busy.has(id) || this.paused() || !this.available(t.spaceId)) return
    this.unqueue(id)
    this.startEvent(t, w.items, w.more)
  }

  /** Runs queued matches whose routine can run now (routines resumed, a bot came back). */
  drainAll(): void {
    for (const id of [...this.waiting.keys()]) this.drain(id)
  }

  /** Records the run (synchronously, so callers can return at once), then runs it. */
  private begin(t: ScheduledTask, test: boolean, late?: number, dry?: boolean, event?: RunInfo['event']): { runId: string; done: Promise<void> } {
    this.busy.add(t.id)
    const runId = randomUUID()
    this.db.sql.prepare('INSERT INTO routine_runs(id, task_id, started_at, status, thread_id, test) VALUES(?,?,?,?,?,?)')
      .run(runId, t.id, Date.now(), 'running', t.threadId, test ? 1 : 0)
    this.prune(t.id)
    this.changed()
    const done = (async () => {
      let result: RunResult
      try {
        result = await this.run(t, { id: runId, test, ...(late !== undefined ? { late } : {}), ...(dry ? { dry: true } : {}), ...(event ? { event } : {}) })
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
      if (this.waiting.has(t.id)) setTimeout(() => this.drain(t.id), 0)
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
