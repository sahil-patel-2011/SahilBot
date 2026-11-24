import type { PendingRequest, ScheduledTask, Space } from '@shared/types'
import type { ToolDef } from './agent/types'
import type { Db } from './db'
import { runOutcome } from './scheduler'

// The morning check-in is gone: a daily look-over is something you ask a bot for in chat, like any routine.
// removeCheckin deletes the routine an earlier version made (once, at startup), so it never runs again.
// bots_overview (below) stays: a summary of every bot's open plans and what is waiting on the user.

/** The routine's title in earlier versions. */
export const CHECKIN_TITLE = 'Morning check-in'
const SETTING = 'checkin'

export interface CheckinScheduler {
  get(id: string): ScheduledTask | undefined
  remove(id: string): void
}

/**
 * Deletes the morning check-in routine an earlier version created on the main bot, and forgets its setting.
 * Only that routine (by the id it stored, on the main bot): a routine the user made themselves is never touched.
 * Returns whether one was deleted.
 */
export function removeCheckin(db: Db, sched: CheckinScheduler): boolean {
  const s = db.getSetting<{ taskId?: unknown }>(SETTING)
  if (s === undefined || s === null) return false
  const id = typeof s.taskId === 'string' ? s.taskId : null
  const t = id ? sched.get(id) : undefined
  const main = db.mainSpace()
  const mine = !!t && !!main && t.spaceId === main.id
  if (mine) sched.remove(t.id)
  db.deleteSetting(SETTING)
  return mine
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
