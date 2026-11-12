import { randomUUID } from 'node:crypto'
import type { Schedule, ScheduledTask } from '@shared/types'
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

export class Scheduler {
  private timer: NodeJS.Timeout | null = null
  private busy = new Set<string>()

  constructor(private db: Db, private run: (task: ScheduledTask) => Promise<string>, private changed: () => void, private now = () => new Date()) {}

  list(): ScheduledTask[] {
    return (this.db.sql.prepare('SELECT * FROM scheduled_tasks ORDER BY COALESCE(next_run, 9e15)').all() as Row[]).map(toTask)
  }

  get(id: string): ScheduledTask | undefined {
    const r = this.db.sql.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as Row | undefined
    return r ? toTask(r) : undefined
  }

  create(t: { title: string; prompt: string; schedule: Schedule; spaceId: string }): ScheduledTask {
    if (!t.prompt.trim()) throw new Error('A scheduled task needs instructions.')
    if (t.prompt.length > 8000) throw new Error('Keep scheduled instructions under 8,000 characters.')
    const next = nextRun(t.schedule, this.now())
    if (!next) throw new Error('That time has already passed.')
    const id = randomUUID().slice(0, 8)
    this.db.sql.prepare('INSERT INTO scheduled_tasks(id, title, prompt, schedule, space_id, enabled, next_run, created_at) VALUES(?,?,?,?,?,1,?,?)')
      .run(id, t.title.trim() || 'Scheduled task', t.prompt.trim(), JSON.stringify(t.schedule), t.spaceId, next.getTime(), Date.now())
    this.changed()
    return this.get(id)!
  }

  update(id: string, patch: { enabled?: boolean; title?: string; prompt?: string; schedule?: Schedule }): ScheduledTask {
    const cur = this.get(id)
    if (!cur) throw new Error(`No scheduled task ${id}`)
    const n = { ...cur, ...patch }
    const next = n.enabled ? nextRun(n.schedule, this.now())?.getTime() ?? null : null
    this.db.sql.prepare('UPDATE scheduled_tasks SET title=?, prompt=?, schedule=?, enabled=?, next_run=? WHERE id=?')
      .run(n.title, n.prompt, JSON.stringify(n.schedule), n.enabled ? 1 : 0, next, id)
    this.changed()
    return this.get(id)!
  }

  remove(id: string): void {
    this.db.sql.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
    this.changed()
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

  async fire(t: ScheduledTask): Promise<void> {
    this.busy.add(t.id)
    // Advance first (at-most-once), so a crash mid-run can't fire it again.
    const next = nextRun(t.schedule, this.now())
    this.db.sql.prepare('UPDATE scheduled_tasks SET next_run = ?, last_run = ?, enabled = ? WHERE id = ?')
      .run(next?.getTime() ?? null, Date.now(), next ? (t.enabled ? 1 : 0) : 0, t.id)
    this.changed()
    let status: string
    try {
      status = await this.run(t)
    } catch (e) {
      status = `error: ${(e as Error).message}`
    }
    this.db.sql.prepare('UPDATE scheduled_tasks SET last_status = ? WHERE id = ?').run(status, t.id)
    this.busy.delete(t.id)
    this.changed()
  }
}
