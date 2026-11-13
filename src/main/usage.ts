import { AsyncLocalStorage } from 'node:async_hooks'
import type { Space, UsageReport, UsageRow } from '@shared/types'
import type { Db } from './db'

// Settings → Usage: cloud spend (the usage table, one row per paid request) and local requests (the
// replies local models wrote into chats, with the token counts the model server reported).
// Cloud rows are tagged with the bot whose run made them: every agent run carries its bot in
// `usageScope`, which the spend hook reads when it records a request.

/** The bot (and chat) a model request is made for, carried through the whole run. */
export const usageScope = new AsyncLocalStorage<{ spaceId: string | null; threadId: string | null }>()

const DAY = 86_400_000

/** Local midnight `days - 1` days before `now`: the first day of a `days`-long window ending today. */
export function windowStart(now: number, days: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - (days - 1))
  return d.getTime()
}

/** YYYY-MM-DD in local time. */
export function dayKey(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Usage since `since`, one row per day × bot × model. Cloud rows come from the usage table; local rows
 * from model replies in chats whose model `isCloud` says is local (cloud replies are already counted).
 */
export function usageRows(db: Db, since: number, isCloud: (model: string) => boolean): UsageRow[] {
  const rows: UsageRow[] = []
  // Bucket by local day in JS (SQLite's 'localtime' uses the process zone too, but this keeps one rule for both sources).
  const add = (day: string, spaceId: string | null, model: string, where: 'local' | 'cloud', requests: number, input: number, output: number, usd: number): void => {
    const hit = rows.find((r) => r.day === day && r.spaceId === spaceId && r.model === model && r.where === where)
    if (hit) { hit.requests += requests; hit.input += input; hit.output += output; hit.usd += usd } else rows.push({ day, spaceId, model, where, requests, input, output, usd })
  }
  const full = db.sql.prepare(`SELECT model, space_id AS spaceId, at, input, output, usd FROM usage WHERE at >= ?`).all(since) as unknown as Array<{ model: string; spaceId: string | null; at: number; input: number; output: number; usd: number }>
  for (const r of full) add(dayKey(r.at), r.spaceId ?? null, r.model, 'cloud', 1, r.input, r.output, r.usd)
  const local = db.sql.prepare(`
    SELECT json_extract(m.data, '$.model') AS model, t.space_id AS spaceId, m.created_at AS at,
      COALESCE(json_extract(m.data, '$.meta.promptTokens'), 0) AS input, COALESCE(json_extract(m.data, '$.meta.completionTokens'), 0) AS output
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE m.role = 'assistant' AND m.created_at >= ? AND json_extract(m.data, '$.model') IS NOT NULL`).all(since) as unknown as Array<{ model: string; spaceId: string; at: number; input: number; output: number }>
  const cloudModel = new Map<string, boolean>()
  const remote = (m: string): boolean => {
    if (!cloudModel.has(m)) { let c = true; try { c = isCloud(m) } catch { /* unknown: count as cloud, i.e. skip */ } cloudModel.set(m, c) }
    return cloudModel.get(m)!
  }
  for (const r of local) if (typeof r.model === 'string' && r.model && !remote(r.model)) add(dayKey(r.at), r.spaceId, r.model, 'local', 1, Number(r.input) || 0, Number(r.output) || 0, 0)
  return rows.sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model))
}

/** Breakdowns for the Usage page: by model, by bot and by day (every day in the window, empty ones too). */
export function aggregateUsage(rows: UsageRow[], spaces: Array<Pick<Space, 'id' | 'name' | 'color' | 'isMain'>>, o: { now: number; days: number; month: string; spent: number; cap: number; monthRequests: number }): UsageReport {
  const byModel = new Map<string, UsageReport['byModel'][number]>()
  const byBot = new Map<string, UsageReport['byBot'][number]>()
  const byDay = new Map<string, UsageReport['byDay'][number]>()
  const start = windowStart(o.now, o.days)
  for (let i = 0; i < o.days; i++) {
    const day = dayKey(start + i * DAY + DAY / 2)
    byDay.set(day, { day, usd: 0, cloudRequests: 0, localRequests: 0 })
  }
  const totals = { cloudRequests: 0, localRequests: 0, input: 0, output: 0, usd: 0 }
  for (const r of rows) {
    const m = byModel.get(`${r.where}:${r.model}`) ?? { model: r.model, where: r.where, requests: 0, input: 0, output: 0, usd: 0 }
    m.requests += r.requests; m.input += r.input; m.output += r.output; m.usd += r.usd
    byModel.set(`${r.where}:${r.model}`, m)
    const sp = r.spaceId ? spaces.find((s) => s.id === r.spaceId) : undefined
    const key = r.spaceId && sp ? r.spaceId : r.spaceId ? 'deleted' : 'none'
    const b = byBot.get(key) ?? {
      spaceId: sp ? sp.id : null,
      name: sp ? sp.name : r.spaceId ? 'Deleted bots' : 'Not from a bot',
      color: sp?.color ?? null,
      cloudRequests: 0, localRequests: 0, input: 0, output: 0, usd: 0
    }
    if (r.where === 'cloud') b.cloudRequests += r.requests; else b.localRequests += r.requests
    b.input += r.input; b.output += r.output; b.usd += r.usd
    byBot.set(key, b)
    const d = byDay.get(r.day)
    if (d) { d.usd += r.usd; if (r.where === 'cloud') d.cloudRequests += r.requests; else d.localRequests += r.requests }
    if (r.where === 'cloud') totals.cloudRequests += r.requests; else totals.localRequests += r.requests
    totals.input += r.input; totals.output += r.output; totals.usd += r.usd
  }
  const rank = (a: { usd: number; requests?: number; cloudRequests?: number; localRequests?: number }): number => a.usd * 1e6 + (a.requests ?? (a.cloudRequests ?? 0) + (a.localRequests ?? 0))
  return {
    month: o.month, spent: o.spent, cap: o.cap, monthRequests: o.monthRequests, days: o.days,
    byModel: [...byModel.values()].sort((a, b) => rank(b) - rank(a)),
    byBot: [...byBot.values()].sort((a, b) => rank(b) - rank(a)),
    byDay: [...byDay.values()],
    totals
  }
}

/** A spreadsheet cell: quoted when needed; text that a spreadsheet would run as a formula is defused. */
export function csvCell(v: string | number): string {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  let s = v
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The rows behind the Usage page as CSV: one line per day, bot and model. */
export function usageCsv(rows: UsageRow[], spaceName: (id: string | null) => string): string {
  const head = ['date', 'bot', 'model', 'where', 'requests', 'input_tokens', 'output_tokens', 'usd']
  const lines = rows.map((r) => [r.day, spaceName(r.spaceId), r.model, r.where, r.requests, r.input, r.output, Math.round(r.usd * 1e6) / 1e6].map(csvCell).join(','))
  return [head.join(','), ...lines].join('\n') + '\n'
}
