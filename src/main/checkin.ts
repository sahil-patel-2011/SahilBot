import type { CheckinSettings, PendingRequest, Schedule, ScheduledTask, Space } from '@shared/types'
import type { ToolDef } from './agent/types'
import type { Db } from './db'
import { runOutcome } from './scheduler'

// The morning check-in (opt-in, off by default): a daily routine on the main bot that looks over the
// day and the user's bots and suggests a few next steps. It reads; it never sends anything on its own.
// bots_overview gives it a summary of every bot's open plans and what is waiting on the user.

export const CHECKIN_TITLE = 'Morning check-in'
export const DEFAULT_CHECKIN_TIME = '08:30'
const SETTING = 'checkin'
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export const CHECKIN_PROMPT = `Give me a short morning check-in. Read only: don't send, post, buy, book, delete or change anything, and don't start work in other bots. If something needs doing, suggest it and ask.

1. Today: if you can read my calendar and reminders (mac_apps calendar_events with days 1, and reminders_list; or a connected calendar app), list today's events with times and anything due today or overdue. If you can't, skip this without asking me to connect anything.
2. My bots: use bots_overview (find it with find_tools if it isn't loaded) for open plans, what is waiting on me (approvals, questions, plans to OK), routines that failed, and unread chats. Summarize: one line per bot at most, no details from inside the chats.
3. Suggest 1–3 next actions, most important first, each one line.

Keep the whole thing under about 150 words, in short sections with bullets. Skip any section with nothing in it. If there is nothing at all, say so in one line.`

interface Stored { taskId: string | null; time: string }

export interface CheckinScheduler {
  get(id: string): ScheduledTask | undefined
  create(t: { title: string; prompt: string; schedule: Schedule; spaceId: string; enabled?: boolean }): ScheduledTask
  update(id: string, patch: { enabled?: boolean; schedule?: Schedule }): ScheduledTask
}

function stored(db: Db): Stored {
  const s = db.getSetting<Partial<Stored>>(SETTING) ?? {}
  return { taskId: typeof s.taskId === 'string' ? s.taskId : null, time: typeof s.time === 'string' && TIME.test(s.time) ? s.time : DEFAULT_CHECKIN_TIME }
}

/** The check-in routine, if it still exists on the main bot. */
function task(db: Db, sched: CheckinScheduler): ScheduledTask | undefined {
  const { taskId } = stored(db)
  const t = taskId ? sched.get(taskId) : undefined
  const main = db.mainSpace()
  return t && main && t.spaceId === main.id ? t : undefined
}

/** On only while its routine exists and is on (pausing or deleting the routine turns it off here too). */
export function getCheckin(db: Db, sched: CheckinScheduler): CheckinSettings {
  const t = task(db, sched)
  const time = t?.schedule.type === 'daily' ? t.schedule.time : stored(db).time
  return { enabled: !!t?.enabled, time }
}

/** Creates, re-times, resumes or pauses the check-in routine. Edits to its instructions are kept. */
export function setCheckin(db: Db, sched: CheckinScheduler, c: CheckinSettings): CheckinSettings {
  const time = String(c?.time ?? '')
  if (!TIME.test(time)) throw new Error('Pick a time like 08:30.')
  const enabled = c.enabled === true
  const main = db.mainSpace()
  if (!main) throw new Error('No main bot.')
  const schedule: Schedule = { type: 'daily', time }
  const cur = task(db, sched)
  let taskId = cur?.id ?? null
  if (cur) {
    const sameTime = cur.schedule.type === 'daily' && cur.schedule.time === time
    if (!sameTime || cur.enabled !== enabled) sched.update(cur.id, { enabled, ...(sameTime ? {} : { schedule }) })
  } else if (enabled) {
    taskId = sched.create({ title: CHECKIN_TITLE, prompt: CHECKIN_PROMPT, schedule, spaceId: main.id, enabled: true }).id
  }
  db.setSetting(SETTING, { taskId, time } satisfies Stored)
  return getCheckin(db, sched)
}

// ------------------------------------------------------------------ bots_overview

const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export interface OverviewDeps {
  db: Db
  /** Open requests per chat (approvals, questions, plans). */
  pending(): PendingRequest[]
  /** Every routine. */
  routines(): ScheduledTask[]
  now?: () => number
}

/** A short, summary-only picture of every bot: open plans, what waits on the user, failed routines, unread chats. */
export function botsOverview(d: OverviewDeps): string {
  const now = d.now?.() ?? Date.now()
  const spaces = d.db.listSpaces()
  const byId = new Map(spaces.map((s) => [s.id, s]))
  const who = (sp: Space | undefined): string => (!sp ? 'A deleted bot' : sp.isMain ? `${sp.name} (main)` : sp.kind === 'project' ? `Project ${sp.name}` : sp.name)
  const threads = d.db.sql.prepare(`
    SELECT t.id, t.title, t.space_id AS spaceId, t.unread, t.updated_at AS at, ts.data
    FROM threads t LEFT JOIN thread_state ts ON ts.thread_id = t.id
    WHERE t.parent_id IS NULL AND t.updated_at >= ? ORDER BY t.updated_at DESC LIMIT 300`).all(now - 14 * 86_400_000) as unknown as Array<{ id: string; title: string; spaceId: string; unread: number; at: number; data: string | null }>
  const title = (id: string): string => threads.find((t) => t.id === id)?.title ?? ''

  const plans: string[] = []
  for (const t of threads) {
    if (!t.data || plans.length >= 15) continue
    let todos: Array<{ text?: unknown; status?: unknown }> = []
    try { todos = (JSON.parse(t.data) as { todos?: typeof todos }).todos ?? [] } catch { continue }
    if (!Array.isArray(todos) || !todos.length) continue
    const open = todos.filter((x) => x && (x.status === 'pending' || x.status === 'in_progress'))
    if (!open.length) continue
    const next = open.find((x) => x.status === 'in_progress') ?? open[0]
    const sp = byId.get(t.spaceId)
    const where = sp && (sp.isMain || sp.kind === 'project') ? ` · "${clip(t.title, 50)}"` : ''
    plans.push(`- ${who(sp)}${where}: ${open.length} of ${todos.length} steps open; next: ${clip(String(next.text ?? ''), 100)}`)
  }

  const waits: string[] = []
  for (const r of d.pending().slice(0, 15)) {
    const sp = byId.get(threads.find((t) => t.id === r.threadId)?.spaceId ?? d.db.getThread(r.threadId)?.spaceId ?? '')
    const what = r.kind === 'approval' ? `approve: ${clip(r.summary ?? r.label ?? r.tool ?? 'an action', 90)}`
      : r.kind === 'plan' ? `OK a plan: ${clip(r.plan?.goal ?? '', 90)}`
        : r.kind === 'connect' ? `connect ${clip(r.preset?.name ?? 'an app', 40)}`
          : `answer: ${clip(r.question ?? r.questions?.[0]?.question ?? 'a question', 90)}`
    waits.push(`- ${who(sp)}${sp && (sp.isMain || sp.kind === 'project') ? ` · "${clip(title(r.threadId) || d.db.getThread(r.threadId)?.title || '', 50)}"` : ''}: ${what}`)
  }

  const failed = d.routines()
    .filter((t) => t.lastRun && now - t.lastRun < 36 * 3_600_000 && t.lastStatus && runOutcome(t.lastStatus).status === 'failed')
    .slice(0, 10)
    .map((t) => `- ${who(byId.get(t.spaceId))}: "${clip(t.title.replace(/^⏰\s*/, ''), 60)}" ${clip(t.lastStatus ?? '', 80)}`)

  const unread = new Map<string, number>()
  for (const t of threads) if (t.unread) unread.set(t.spaceId, (unread.get(t.spaceId) ?? 0) + 1)
  const unreadLines = [...unread].slice(0, 15).map(([id, n]) => `- ${who(byId.get(id))}: ${n} unread chat${n === 1 ? '' : 's'}`)

  const parts: string[] = []
  const add = (h: string, xs: string[]): void => { if (xs.length) parts.push(`${h}\n${xs.join('\n')}`) }
  add('Waiting on the user:', waits)
  add('Open plans (last 14 days):', plans)
  add('Routines that failed recently:', failed)
  add('Unread:', unreadLines)
  return parts.length ? parts.join('\n\n') : 'Nothing open: no plans in progress, nothing waiting on the user, no failed routines, no unread chats.'
}

/** Read-only summary of the user's bots, for the check-in. */
export function overviewTool(d: OverviewDeps): ToolDef<Record<string, never>> {
  return {
    name: 'bots_overview',
    label: 'Bots overview',
    group: 'Bots',
    effect: 'read',
    // Plan steps and request summaries can quote text a bot read on the web.
    untrusted: true,
    description: 'A short summary of all the user\'s bots: open plans (steps left, next step), what is waiting on the user (approvals, questions, plans to OK), routines that failed recently, and unread chats. Summaries only, never chat contents. For check-ins and "what\'s going on with my bots?".',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const text = botsOverview(d)
      return { text, display: text.startsWith('Nothing open') ? 'nothing open' : 'summarized your bots' }
    }
  }
}
