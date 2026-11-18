import { AsyncLocalStorage } from 'node:async_hooks'
import type { Space, UsageReport, UsageRow } from '@shared/types'
import type { Db } from './db'

// Settings → Usage: cloud spend (the usage table, one row per paid request) and local requests (the
// replies local models wrote into chats, with the token counts the model server reported).
// Cloud rows are tagged with the bot whose run made them: every agent run carries its bot in
// `usageScope`, which the spend hook reads when it records a request.

/** The bot (and chat) a model request is made for, carried through the whole run. */
export const usageScope = new AsyncLocalStorage<{ spaceId: string | null; threadId: string | null }>()

/**
 * Background jobs that aren't a bot's run record their requests under a reserved tag in the bot column, so
 * Settings → Usage shows them on their own line: the brain's syncs (src/main/brain) are "Brain sync".
 */
export const BRAIN_USAGE_SCOPE = 'job:brain'
const JOB_NAMES: Record<string, string> = { [BRAIN_USAGE_SCOPE]: 'Brain sync' }
/** A usage row's line name for a job tag, or undefined for a bot (or none). */
export const jobName = (spaceId: string | null | undefined): string | undefined => (spaceId ? JOB_NAMES[spaceId] : undefined)

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
    const job = jobName(r.spaceId)
    const key = r.spaceId && sp ? r.spaceId : job ? r.spaceId! : r.spaceId ? 'deleted' : 'none'
    const b = byBot.get(key) ?? {
      spaceId: sp ? sp.id : null,
      name: sp ? sp.name : job ?? (r.spaceId ? 'Deleted bots' : 'Not from a bot'),
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

// ---------------------------------------------------------------------------------------------------
// The usage dashboard (Settings → Usage, and the compact card in the profile menu and ⌘K "Usage").
// Cloud figures come from the usage table (one row per paid request, kept forever, so lifetime totals span
// every month); its detail columns (db.ts ensureUsageColumns) hold the providers' own counts. Rows from before
// those columns existed fall back to the billing-equivalent input / output. Local figures come from the model
// replies saved in chats. Weeks start on Monday, local time. Spending limits are monthly; the weekly figures
// are statistics only.
// ---------------------------------------------------------------------------------------------------

export const PROVIDER_NAMES: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', xai: 'xAI', openrouter: 'OpenRouter', chatgpt: 'ChatGPT plan', local: 'Local models', other: 'Other' }

/** Which provider served a request: the recorded one, else the host, else the model's name. */
export function providerOf(model: string, host?: string | null, recorded?: string | null): string {
  if (recorded) return recorded
  const h = (host ?? '').toLowerCase()
  if (/anthropic\.com$/.test(h)) return 'anthropic'
  if (/(^|\.)openai\.com$/.test(h)) return 'openai'
  if (/(^|\.)x\.ai$/.test(h)) return 'xai'
  if (/openrouter\.ai$/.test(h)) return 'openrouter'
  if (/chatgpt-plan|codex/.test(h) || /^chatgpt-plan\//.test(model)) return 'chatgpt'
  if (/^claude-/i.test(model)) return 'anthropic'
  if (/^(gpt-|o\d|chatgpt-)/i.test(model)) return 'openai'
  if (/^grok-/i.test(model)) return 'xai'
  if (/^[\w-]+\/[^/]+$/.test(model)) return 'openrouter'
  return 'other'
}

/** Local midnight of the Monday that starts the week containing `t`. */
export function weekStart(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.getTime()
}

/** Local midnight of the first day of the month containing `t`. */
export function monthStart(t: number): number {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

interface CloudRow { model: string; host: string; provider: string | null; spaceId: string | null; at: number; month: string; input: number; output: number; usd: number; prompt: number | null; cached: number | null; cacheWrite: number | null; outTokens: number | null; reasoning: number | null; tier: string | null; webCalls: number | null }

/** A usage row as the provider counted it: uncached input, cache reads, cache writes, billed output, reasoning. */
export function rowTokens(r: Pick<CloudRow, 'input' | 'output' | 'prompt' | 'cached' | 'cacheWrite' | 'outTokens' | 'reasoning'>): { input: number; cached: number; cacheWrite: number; output: number; reasoning: number } {
  const cached = Math.max(0, r.cached ?? 0)
  const cacheWrite = Math.max(0, r.cacheWrite ?? 0)
  const input = r.prompt !== null && r.prompt !== undefined ? Math.max(0, r.prompt - cached - cacheWrite) : Math.max(0, r.input)
  return { input, cached, cacheWrite, output: Math.max(0, r.outTokens ?? r.output), reasoning: Math.max(0, r.reasoning ?? 0) }
}

const COLS = `model, host, provider, space_id AS spaceId, at, month, input, output, usd, prompt, cached, cache_write AS cacheWrite, out_tokens AS outTokens, reasoning, tier, web_calls AS webCalls`

function cloudRows(db: Db, since: number): CloudRow[] {
  return db.sql.prepare(`SELECT ${COLS} FROM usage WHERE at >= ? ORDER BY at`).all(since) as unknown as CloudRow[]
}

interface LocalRow { model: string; spaceId: string | null; at: number; input: number; output: number }

function localRows(db: Db, since: number, isCloud: (model: string) => boolean): LocalRow[] {
  const rows = db.sql.prepare(`
    SELECT json_extract(m.data, '$.model') AS model, t.space_id AS spaceId, m.created_at AS at,
      COALESCE(json_extract(m.data, '$.meta.promptTokens'), 0) AS input, COALESCE(json_extract(m.data, '$.meta.completionTokens'), 0) AS output
    FROM messages m JOIN threads t ON t.id = m.thread_id
    WHERE m.role = 'assistant' AND m.created_at >= ? AND json_extract(m.data, '$.model') IS NOT NULL`).all(since) as unknown as LocalRow[]
  const memo = new Map<string, boolean>()
  const cloud = (m: string): boolean => {
    if (!memo.has(m)) { let c = true; try { c = isCloud(m) } catch { /* unknown: skip */ } memo.set(m, c) }
    return memo.get(m)!
  }
  return rows.filter((r) => typeof r.model === 'string' && r.model && !cloud(r.model)).map((r) => ({ ...r, input: Number(r.input) || 0, output: Number(r.output) || 0 }))
}

const zero = (): import('@shared/types').UsageTokens => ({ requests: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, usd: 0 })

export interface DashboardOptions {
  now: number
  /** The budget's month key (YYYY-MM) and this month's cloud spend / requests (Budget.summary). */
  month: string
  spent: number
  monthRequests: number
  cap: number
  mode: import('@shared/types').SpendingMode
  spaces: Array<Pick<Space, 'id' | 'name' | 'color'>>
  isCloud: (model: string) => boolean
}

export function usageDashboard(db: Db, o: DashboardOptions): import('@shared/types').UsageDashboard {
  const DAYS = 30
  const WEEKS = 12
  const dayStart = windowStart(o.now, DAYS)
  const firstWeek = weekStart(o.now) - (WEEKS - 1) * 7 * DAY
  const mStart = monthStart(o.now)
  const wStart = weekStart(o.now)
  // Enough history for every chart and this month (the month can start before the 12-week window? never: 12 weeks > 1 month).
  const since = Math.min(dayStart, firstWeek, mStart, wStart)
  const cloud = cloudRows(db, since)
  const local = localRows(db, since, o.isCloud)

  const days = new Map<string, import('@shared/types').UsageDashboard['days'][number]>()
  for (let i = 0; i < DAYS; i++) { const day = dayKey(dayStart + i * DAY + DAY / 2); days.set(day, { day, tokens: 0, cloudTokens: 0, localTokens: 0, usd: 0, requests: 0 }) }
  const weeks: import('@shared/types').UsageDashboard['weeks'] = []
  for (let i = 0; i < WEEKS; i++) weeks.push({ start: dayKey(weekStart(firstWeek + i * 7 * DAY + DAY / 2)), tokens: 0, cloudTokens: 0, localTokens: 0, usd: 0, requests: 0 })
  const weekOf = (t: number): number => {
    const k = dayKey(weekStart(t))
    return weeks.findIndex((w) => w.start === k)
  }

  const byModel = new Map<string, import('@shared/types').UsageDashboard['byModel'][number]>()
  const byProvider = new Map<string, import('@shared/types').UsageDashboard['byProvider'][number]>()
  const byBot = new Map<string, import('@shared/types').UsageDashboard['byBot'][number]>()
  const week = { start: wStart, usd: 0, requests: 0, tokens: 0 }
  const monthTotals = { usd: 0, requests: 0, tokens: 0 }
  const bot = (spaceId: string | null): import('@shared/types').UsageDashboard['byBot'][number] => {
    const sp = spaceId ? o.spaces.find((x) => x.id === spaceId) : undefined
    const job = jobName(spaceId)
    const key = sp ? sp.id : job ? spaceId! : spaceId ? 'deleted' : 'none'
    let b = byBot.get(key)
    if (!b) { b = { spaceId: sp?.id ?? null, name: sp ? sp.name : job ?? (spaceId ? 'Deleted bots' : 'Not from a bot'), color: sp?.color ?? null, requests: 0, tokens: 0, usd: 0, share: 0 }; byBot.set(key, b) }
    return b
  }
  const add = (t: import('@shared/types').UsageTokens, x: { input: number; cached: number; cacheWrite: number; output: number; reasoning: number }, usd: number): void => {
    t.requests++; t.input += x.input; t.cached += x.cached; t.cacheWrite += x.cacheWrite; t.output += x.output; t.reasoning += x.reasoning; t.usd += usd
  }

  for (const r of cloud) {
    const x = rowTokens(r)
    const tokens = x.input + x.cached + x.cacheWrite + x.output
    const d = days.get(dayKey(r.at))
    if (d) { d.tokens += tokens; d.cloudTokens += tokens; d.usd += r.usd; d.requests++ }
    const w = weekOf(r.at)
    if (w >= 0) { weeks[w].tokens += tokens; weeks[w].cloudTokens += tokens; weeks[w].usd += r.usd; weeks[w].requests++ }
    if (r.at >= wStart) { week.usd += r.usd; week.requests++; week.tokens += tokens }
    // This month = the budget's month (what the limit counts).
    if (r.month !== o.month) continue
    monthTotals.usd += r.usd; monthTotals.requests++; monthTotals.tokens += tokens
    const provider = providerOf(r.model, r.host, r.provider)
    const m = byModel.get(`cloud:${r.model}`) ?? { ...zero(), model: r.model, provider, where: 'cloud' as const, fastRequests: 0, webCalls: 0, share: 0 }
    add(m, x, r.usd)
    if (r.tier === 'fast' || r.tier === 'ultrafast') m.fastRequests++
    m.webCalls += r.webCalls ?? 0
    byModel.set(`cloud:${r.model}`, m)
    const p = byProvider.get(provider) ?? { ...zero(), provider, name: PROVIDER_NAMES[provider] ?? provider, where: 'cloud' as const, share: 0 }
    add(p, x, r.usd)
    byProvider.set(provider, p)
    const b = bot(r.spaceId)
    b.requests++; b.tokens += tokens; b.usd += r.usd
  }
  for (const r of local) {
    const x = { input: r.input, cached: 0, cacheWrite: 0, output: r.output, reasoning: 0 }
    const tokens = r.input + r.output
    const d = days.get(dayKey(r.at))
    if (d) { d.tokens += tokens; d.localTokens += tokens; d.requests++ }
    const w = weekOf(r.at)
    if (w >= 0) { weeks[w].tokens += tokens; weeks[w].localTokens += tokens; weeks[w].requests++ }
    if (r.at >= wStart) { week.requests++; week.tokens += tokens }
    if (r.at < mStart) continue
    monthTotals.requests++; monthTotals.tokens += tokens
    const m = byModel.get(`local:${r.model}`) ?? { ...zero(), model: r.model, provider: 'local', where: 'local' as const, fastRequests: 0, webCalls: 0, share: 0 }
    add(m, x, 0)
    byModel.set(`local:${r.model}`, m)
    const p = byProvider.get('local') ?? { ...zero(), provider: 'local', name: PROVIDER_NAMES.local, where: 'local' as const, share: 0 }
    add(p, x, 0)
    byProvider.set('local', p)
    const b = bot(r.spaceId)
    b.requests++; b.tokens += tokens
  }

  // Share: of this month's spend when there is any, else of its tokens.
  const tok = (t: import('@shared/types').UsageTokens): number => t.input + t.cached + t.cacheWrite + t.output
  const share = (usd: number, tokens: number): number => (monthTotals.usd > 0 ? usd / monthTotals.usd : monthTotals.tokens > 0 ? tokens / monthTotals.tokens : 0)
  for (const m of byModel.values()) m.share = share(m.usd, tok(m))
  for (const p of byProvider.values()) p.share = share(p.usd, tok(p))
  for (const b of byBot.values()) b.share = share(b.usd, b.tokens)
  const rank = (a: { usd: number }, b: { usd: number }, ta: number, tb: number): number => b.usd - a.usd || tb - ta

  // Lifetime: every recorded request (all months), plus local replies still in chats.
  const lt = db.sql.prepare(`SELECT COUNT(*) AS requests, COALESCE(SUM(usd), 0) AS usd, MIN(at) AS since,
      COALESCE(SUM(cached), 0) AS cached, COALESCE(SUM(cache_write), 0) AS cacheWrite, COALESCE(SUM(reasoning), 0) AS reasoning,
      COALESCE(SUM(COALESCE(out_tokens, output)), 0) AS output,
      COALESCE(SUM(CASE WHEN prompt IS NULL THEN input ELSE MAX(0, prompt - COALESCE(cached, 0) - COALESCE(cache_write, 0)) END), 0) AS input
    FROM usage`).get() as { requests: number; usd: number; since: number | null; cached: number; cacheWrite: number; reasoning: number; output: number; input: number }
  const ll = localRows(db, 0, o.isCloud)
  const localLife = { requests: ll.length, input: ll.reduce((s, r) => s + r.input, 0), output: ll.reduce((s, r) => s + r.output, 0) }
  const firstLocal = ll.length ? Math.min(...ll.map((r) => r.at)) : null
  const sinceAll = [lt.since, firstLocal].filter((x): x is number => typeof x === 'number')

  return {
    now: o.now,
    month: o.month,
    limit: { mode: o.mode, cap: o.cap, spent: o.spent, requests: o.monthRequests },
    week,
    monthTotals,
    lifetime: { requests: lt.requests, usd: lt.usd, input: lt.input, cached: lt.cached, cacheWrite: lt.cacheWrite, output: lt.output, reasoning: lt.reasoning, since: sinceAll.length ? Math.min(...sinceAll) : null, local: localLife },
    days: [...days.values()],
    weeks,
    byModel: [...byModel.values()].sort((a, b) => rank(a, b, tok(a), tok(b))),
    byProvider: [...byProvider.values()].sort((a, b) => rank(a, b, tok(a), tok(b))),
    byBot: [...byBot.values()].sort((a, b) => rank(a, b, a.tokens, b.tokens))
  }
}

/** The compact card: this month against the limit, this week, lifetime, and the last 7 days of tokens. */
export function usageGlance(d: import('@shared/types').UsageDashboard): import('@shared/types').UsageGlance {
  return { month: d.month, mode: d.limit.mode, cap: d.limit.cap, spent: d.limit.spent, weekUsd: d.week.usd, lifetimeUsd: d.lifetime.usd, days: d.days.slice(-7).map((x) => x.tokens) }
}

/** Every cloud request ever recorded, one line each, with the providers' token detail (Settings → Usage → Export CSV). */
export function usageDetailCsv(db: Db, spaceName: (id: string | null) => string): string {
  const head = ['date', 'time', 'bot', 'provider', 'model', 'input_tokens', 'cached_input_tokens', 'cache_write_tokens', 'output_tokens', 'reasoning_tokens', 'tier', 'web_calls', 'usd']
  const rows = db.sql.prepare(`SELECT ${COLS} FROM usage ORDER BY at`).all() as unknown as CloudRow[]
  const lines = rows.map((r) => {
    const x = rowTokens(r)
    const d = new Date(r.at)
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    return [dayKey(r.at), time, jobName(r.spaceId) ?? spaceName(r.spaceId ?? null), PROVIDER_NAMES[providerOf(r.model, r.host, r.provider)] ?? 'Other', r.model, x.input, x.cached, x.cacheWrite, x.output, x.reasoning, r.tier ?? 'standard', r.webCalls ?? 0, Math.round(r.usd * 1e6) / 1e6].map(csvCell).join(',')
  })
  return [head.join(','), ...lines].join('\n') + '\n'
}
