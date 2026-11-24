import type { Goal, NeedsYouItem, RoutineRun, ScheduledTask, Space } from '@shared/types'
import type { Db } from '../db'

// The daily digest of an always-on bot: what it did, what's pending, and what needs the user. Built from
// the database (no model call, so it costs nothing), posted in the bot's chat and sent as a notification
// (Mac and paired devices) at the time set in Bot details. Nothing happened and nothing waits: no digest.

export interface DigestData {
  botName: string
  since: number
  now: number
  /** Finished replies (one line each), newest last. */
  did: Array<{ at: number; text: string }>
  routines: Array<{ title: string; status: RoutineRun['status']; at: number; reason?: string | null }>
  goals: Array<Pick<Goal, 'title' | 'status' | 'statusReason' | 'milestones' | 'nextWakeAt' | 'spentUsd' | 'maxUsd' | 'asks' | 'updatedAt'>>
  pending: NeedsYouItem[]
  review: NeedsYouItem[]
  next: Array<{ title: string; at: number }>
  spend?: { botUsd: number; monthUsd: number; capUsd: number | null; over: boolean }
}

export interface Digest { title: string; body: string; text: string; empty: boolean }

const t = (ms: number): string => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
const usd = (n: number): string => `$${(Math.round(n * 100) / 100).toFixed(2)}`
const line = (s: string, n = 140): string => { const x = s.replace(/[#*_`>]+/g, '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x }
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`

/** The digest text (Markdown for the chat) and a one-line notification body. */
export function buildDigest(d: DigestData): Digest {
  const activeGoals = d.goals.filter((g) => g.status === 'active' || g.status === 'waiting_user' || g.status === 'blocked')
  const finished = d.goals.filter((g) => g.status === 'done' && g.updatedAt >= d.since)
  const failed = d.routines.filter((r) => r.status === 'failed')
  const empty = !d.did.length && !d.routines.length && !d.pending.length && !d.review.length && !finished.length && !d.goals.some((g) => g.updatedAt >= d.since)
  // Posted in the bot's own chat, under its name: the heading doesn't repeat it (the notification's title does).
  const out: string[] = [`**Daily digest** (since ${t(d.since)})`]
  const done = [
    ...d.did.slice(-8).map((x) => `- ${line(x.text)}`),
    ...d.routines.filter((r) => r.status === 'succeeded').slice(0, 6).map((r) => `- Routine "${line(r.title, 60)}" ran (${t(r.at)})`),
    ...finished.map((g) => `- Finished goal "${line(g.title, 80)}"`)
  ]
  out.push('', '**What I did**', ...(done.length ? done : ['- Nothing new since the last digest.']))
  if (failed.length) out.push('', '**Problems**', ...failed.slice(0, 5).map((r) => `- Routine "${line(r.title, 60)}" failed${r.reason ? `: ${line(r.reason, 100)}` : ''}`))
  const waiting = d.pending.map((p) => p.kind === 'approval'
    ? `- Needs your OK: ${line(p.approval?.summary ?? p.approval?.label ?? 'an action', 120)}${p.hardStop ? ` (${line(p.hardStop, 60)})` : ''}`
    : `- Question: ${line(p.questions?.[0]?.question ?? 'a question', 120)}${(p.questions?.length ?? 0) > 1 ? ` (+${(p.questions?.length ?? 1) - 1} more)` : ''}${p.expired ? ' (past its deadline, waiting for you)' : p.deadline ? ` (goes with the default ${t(p.deadline)})` : ''}`)
  const goalAsks = d.goals.flatMap((g) => g.asks.map((a) => `- Goal "${line(g.title, 60)}" needs your OK: ${line(a.summary ?? a.label, 100)}`))
  if (waiting.length || goalAsks.length) out.push('', `**Needs you** (${waiting.length + goalAsks.length})`, ...waiting, ...goalAsks)
  if (d.review.length) {
    out.push('', '**For your review** (I went ahead with my default when nobody answered)')
    for (const r of d.review) (r.questions ?? []).forEach((q, i) => out.push(`- "${line(q.question, 100)}" → ${line(r.answers?.[i] ?? '', 60)}`))
  }
  if (activeGoals.length) {
    out.push('', '**Goals**')
    for (const g of activeGoals.slice(0, 8)) {
      const n = g.milestones.length, ok = g.milestones.filter((m) => m.status === 'done' || m.status === 'skipped').length
      out.push(`- ${line(g.title, 80)}: ${n ? `${ok}/${n} milestones` : g.status}${g.nextWakeAt && g.status === 'active' ? `, next check-in ${t(g.nextWakeAt)}` : ''}${g.status === 'blocked' || g.status === 'waiting_user' ? ` (${g.statusReason ? line(g.statusReason, 60) : 'waiting for you'})` : ''} · ${usd(g.spentUsd)} of ${usd(g.maxUsd)}`)
    }
  }
  if (d.next.length) out.push('', '**Next up**', ...d.next.slice(0, 6).map((x) => `- ${line(x.title, 80)} · ${t(x.at)}`))
  if (d.spend && (d.spend.botUsd > 0 || d.spend.over)) {
    out.push('', d.spend.over
      ? `**Spending:** the monthly limit is used up (${usd(d.spend.monthUsd)}${d.spend.capUsd !== null ? ` of ${usd(d.spend.capUsd)}` : ''}), so paid work is paused until you raise it or next month.`
      : `**Spending:** ${usd(d.spend.botUsd)} by this bot since the last digest · ${usd(d.spend.monthUsd)} this month${d.spend.capUsd !== null ? ` of ${usd(d.spend.capUsd)}` : ''}.`)
  }
  const needs = waiting.length + goalAsks.length
  const body = [done.length ? `Did ${plural(done.length, 'thing')}` : 'Quiet day', needs ? `${needs} need${needs === 1 ? 's' : ''} you` : '', d.review.length ? `${d.review.length} to review` : '', failed.length ? `${plural(failed.length, 'problem')}` : '']
    .filter(Boolean).join(' · ')
  return { title: `${d.botName}: daily digest`, body, text: out.join('\n'), empty }
}

/** The local time today when the digest is due ("18:00"). */
export function digestSlot(time: string, now: number): number {
  const [h, m] = time.split(':').map(Number)
  const d = new Date(now)
  d.setHours(Number.isFinite(h) ? h : 18, Number.isFinite(m) ? m : 0, 0, 0)
  return d.getTime()
}

/** Due when today's slot has passed and the last digest was before it (one per day; a missed one isn't replayed). */
export function digestDue(cfg: { enabled: boolean; time: string }, lastAt: number | null, now: number): boolean {
  if (!cfg.enabled) return false
  const slot = digestSlot(cfg.time, now)
  if (now < slot) return false
  // More than 12 hours late (the Mac was off all evening): skip to tomorrow's.
  if (now - slot > 12 * 3_600_000) return false
  return lastAt === null || lastAt < slot
}

export interface DigestDeps {
  db: Db
  bots(): Space[]
  config(botId: string): { enabled: boolean; time: string }
  goals(botId: string): Goal[]
  routines(botId: string): ScheduledTask[]
  runs(taskId: string): RoutineRun[]
  pending(botId: string): NeedsYouItem[]
  review(botId: string): NeedsYouItem[]
  /** This month's spend, the cap (null = no fixed amount) and whether paid work is stopped. */
  budget(): { monthUsd: number; capUsd: number | null; over: boolean }
  deliver(bot: Space, digest: Digest): void
  /** The bot is working right now: its digest waits for the next check (it never interrupts a run). */
  busy?(botId: string): boolean
  now?: () => number
}

const LAST_KEY = 'digestLast'

export class DigestRunner {
  constructor(private d: DigestDeps) {}

  private last(): Record<string, number> {
    return this.d.db.getSetting<Record<string, number>>(LAST_KEY) ?? {}
  }

  /** What one bot's digest would say now (also used by tests and "send now"). */
  collect(bot: Space, since: number, now: number): DigestData {
    const threads = this.d.db.listThreads(bot.id).filter((x) => !x.parentId).map((x) => x.id)
    const did: DigestData['did'] = []
    for (const id of threads) {
      for (const m of this.d.db.listMessages(id)) {
        if (m.createdAt < since || m.createdAt > now || m.role !== 'assistant' || m.kind !== 'normal' || m.status !== 'done' || !m.content.trim() || m.meta?.digest) continue
        did.push({ at: m.createdAt, text: m.content.split('\n').find((l) => l.trim()) ?? m.content })
      }
    }
    did.sort((a, b) => a.at - b.at)
    const tasks = this.d.routines(bot.id)
    const routines = tasks.flatMap((task) => this.d.runs(task.id).filter((r) => r.startedAt >= since && r.status !== 'running').map((r) => ({ title: task.title.replace(/^⏰\s*/, ''), status: r.status, at: r.startedAt, reason: r.reason })))
    const goals = this.d.goals(bot.id)
    const horizon = now + 24 * 3_600_000
    const next = [
      ...tasks.filter((x) => x.enabled && x.nextRun && x.nextRun <= horizon).map((x) => ({ title: `Routine: ${x.title.replace(/^⏰\s*/, '')}`, at: x.nextRun! })),
      ...goals.filter((g) => g.status === 'active' && g.nextWakeAt && g.nextWakeAt <= horizon).map((g) => ({ title: `Goal check-in: ${g.title}`, at: g.nextWakeAt! }))
    ].sort((a, b) => a.at - b.at)
    const row = this.d.db.sql.prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM usage WHERE space_id = ? AND at >= ?').get(bot.id, since) as { usd?: number } | undefined
    const b = this.d.budget()
    return {
      botName: bot.name, since, now, did, routines, goals, next,
      pending: this.d.pending(bot.id), review: this.d.review(bot.id).filter((r) => (r.answeredAt ?? 0) >= since || r.review),
      spend: { botUsd: Number(row?.usd ?? 0), monthUsd: b.monthUsd, capUsd: b.capUsd, over: b.over }
    }
  }

  /** Delivers every digest that is due. Returns how many went out. */
  tick(): number {
    const now = (this.d.now ?? Date.now)()
    const last = this.last()
    let sent = 0
    for (const bot of this.d.bots()) {
      const cfg = this.d.config(bot.id)
      if (!digestDue(cfg, last[bot.id] ?? null, now) || this.d.busy?.(bot.id)) continue
      const since = last[bot.id] ?? now - 24 * 3_600_000
      last[bot.id] = now
      const digest = buildDigest(this.collect(bot, since, now))
      if (digest.empty) continue
      try { this.d.deliver(bot, digest); sent++ } catch { /* best effort */ }
    }
    this.d.db.setSetting(LAST_KEY, last)
    return sent
  }
}
