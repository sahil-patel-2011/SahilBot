import { describe, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ModelInfo, SpendingMode } from '@shared/types'
import { Db, USAGE_COLUMNS, ensureUsageColumns } from '../../src/main/db'
import { Budget, NONE_MESSAGE, budgetLeftFor, cost, month, spendingMode } from '../../src/main/llm/budget'
import { NONE_ROUTE_MESSAGE, payPerUse, routeTask, spendingPrefs } from '../../src/main/llm/routing-table'
import { classifyTask } from '../../src/main/llm/task-classifier'
import { dayKey, monthStart, providerOf, rowTokens, usageDashboard, usageDetailCsv, usageGlance, weekStart } from '../../src/main/usage'

// The monthly spending limit (amount / unlimited / none) in the budget check and in Auto's routing, the usage
// table's idempotent migration, and the dashboard's aggregation (days, weeks, months, lifetime, per model).

const DAY = 86_400_000
const isCloud = (m: string): boolean => /^(claude-|gpt-|grok-|chatgpt-plan\/)/.test(m)

function setup(mode: SpendingMode = 'amount', cap = 10): { db: Db; budget: Budget; bot: string; thread: string } {
  const db = new Db(':memory:')
  const budget = new Budget(db, () => cap, () => mode)
  const bot = db.createSpace('Writer', '#7C5CFF').id
  const thread = db.createThread(bot, 'auto', null).id
  return { db, budget, bot, thread }
}

describe('the monthly limit', () => {
  test('saved settings migrate: a positive cap is an amount, $0 is None; an explicit mode wins', () => {
    expect(spendingMode({ cloudBudgetUsd: 200 })).toBe('amount')
    expect(spendingMode({ cloudBudgetUsd: 0 })).toBe('none')
    expect(spendingMode({ cloudBudgetUsd: 200, spendingMode: 'unlimited' })).toBe('unlimited')
    expect(spendingMode({ cloudBudgetUsd: 0, spendingMode: 'amount' })).toBe('amount')
    expect(spendingMode({ cloudBudgetUsd: 50, spendingMode: 'bogus' as SpendingMode })).toBe('amount')
  })
  test('amount: a request that could pass the cap is refused; under it, it goes', () => {
    const { budget } = setup('amount', 1)
    expect(() => budget.check('claude-opus-5-5', 10_000, 1000)).not.toThrow()
    budget.record('api.anthropic.com', 'claude-opus-5-5', 200_000, 0)
    expect(() => budget.check('claude-opus-5-5', 10_000, 32_000)).toThrow(/budget reached.*\$0\.80 of your \$1\.00/i)
    expect(budget.left()).toBeCloseTo(0.2, 9)
  })
  test('unlimited: never refused, spend still recorded and summarized', () => {
    const { budget } = setup('unlimited', 1)
    budget.record('api.anthropic.com', 'claude-opus-5-5', 1_000_000, 1_000_000)
    expect(() => budget.check('claude-opus-5-5', 1_000_000, 128_000)).not.toThrow()
    expect(budget.summary()).toMatchObject({ mode: 'unlimited', spent: 24, requests: 1 })
    expect(budget.left()).toBe(Infinity)
  })
  test('none: every pay-per-use request is refused with a clear reason; the ChatGPT plan still runs', () => {
    const { budget } = setup('none', 200)
    for (const m of ['claude-haiku-5-5', 'gpt-6-luna', 'grok-4.7']) expect(() => budget.check(m, 10, 10)).toThrow(NONE_MESSAGE)
    expect(() => budget.check('chatgpt-plan/gpt-6.1-sol', 100_000, 100_000)).not.toThrow()
    expect(budget.left()).toBe(0)
    expect(budgetLeftFor('none', 200, 0)).toBe(0)
  })
})

describe('Auto under the None limit', () => {
  const m = (id: string, provider: ModelInfo['provider'], o: Partial<ModelInfo> = {}): ModelInfo => ({ id, provider, providerName: provider, enabled: true, installed: true, tier: 2, rank: 1, vision: true, tools: true, requiredGB: 0, maxFittingWindow: 131072, fits: true, note: 'remote', contextTokens: 1_000_000, label: id, ...o })
  const paid = [m('claude-sonnet-5-5', 'anthropic'), m('claude-opus-5-5', 'anthropic', { tier: 3 }), m('gpt-6.1-sol', 'openai'), m('grok-4.7', 'xai')]
  const plan = m('chatgpt-plan/gpt-6.1-sol', 'chatgpt')
  const local = m('qwen3.8:27b', 'ollama', { note: undefined, requiredGB: 18 })
  const task = classifyTask('Refactor the auth module and fix the failing tests in this repo', { codeProject: true })
  const route = (models: ModelInfo[], mode: 'amount' | 'unlimited' | 'none'): string | undefined => {
    const prev = spendingPrefs.mode
    spendingPrefs.mode = mode
    try { return routeTask(models, task, { preferCloud: true, fableForHardest: false })?.model.id } finally { spendingPrefs.mode = prev }
  }
  test('amount and unlimited route by the table as before', () => {
    expect(route([...paid, plan], 'amount')).toBe('claude-opus-5-5')
    expect(route([...paid, plan], 'unlimited')).toBe('claude-opus-5-5')
  })
  test('none: only the ChatGPT plan and local models', () => {
    expect(route([...paid, plan], 'none')).toBe('chatgpt-plan/gpt-6.1-sol')
    expect(route([...paid, local], 'none')).toBe('qwen3.8:27b')
    expect(payPerUse(plan)).toBe(false)
    expect(payPerUse(paid[3])).toBe(true)
  })
  test('none with nothing else available says why', () => {
    expect(() => route(paid, 'none')).toThrow(NONE_ROUTE_MESSAGE)
    expect(() => route([], 'none')).toThrow(/pay-per-use API spending is turned off/)
  })
})

describe('the usage table migration', () => {
  test('adds the detail columns to an old table, keeps its rows, and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-usage-'))
    const file = join(dir, 'old.db')
    // A database from before the detail columns: the old usage table with a row in it.
    const old = new DatabaseSync(file)
    old.exec(`CREATE TABLE usage (id INTEGER PRIMARY KEY AUTOINCREMENT, month TEXT NOT NULL, host TEXT NOT NULL, model TEXT NOT NULL,
      input INTEGER NOT NULL, output INTEGER NOT NULL, usd REAL NOT NULL, at INTEGER NOT NULL)`)
    old.prepare('INSERT INTO usage(month, host, model, input, output, usd, at) VALUES(?,?,?,?,?,?,?)').run('2026-01', 'api.anthropic.com', 'claude-opus-5-5', 1000, 100, 0.006, Date.UTC(2026, 0, 5))
    ensureUsageColumns(old)
    ensureUsageColumns(old)
    const cols = (old.prepare('PRAGMA table_info(usage)').all() as Array<{ name: string }>).map((c) => c.name)
    for (const [c] of USAGE_COLUMNS) expect(cols).toContain(c)
    expect((old.prepare('SELECT COUNT(*) AS n, MIN(cached) AS c FROM usage').get() as { n: number; c: number })).toEqual({ n: 1, c: 0 })
    old.close()
    // Opening it as the app does (numbered migrations, then the column check) twice works.
    const a = new Db(file)
    expect((a.sql.prepare('PRAGMA table_info(usage)').all() as Array<{ name: string }>).map((c) => c.name)).toContain('space_id')
    a.sql.close()
    const b = new Db(file)
    expect((b.sql.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number }).n).toBe(1)
    b.sql.close()
  })
  test('a legacy row counts its billing-equivalent input; a new row the providers\' own split', () => {
    expect(rowTokens({ input: 500, output: 50, prompt: null, cached: 0, cacheWrite: 0, outTokens: null, reasoning: 0 })).toEqual({ input: 500, cached: 0, cacheWrite: 0, output: 50, reasoning: 0 })
    expect(rowTokens({ input: 150, output: 300, prompt: 10_000, cached: 9000, cacheWrite: 500, outTokens: 300, reasoning: 120 })).toEqual({ input: 500, cached: 9000, cacheWrite: 500, output: 300, reasoning: 120 })
  })
})

describe('the dashboard', () => {
  const NOW = new Date(2026, 10, 15, 12).getTime() // Sun Nov 15 2026, noon local

  function seeded(): ReturnType<typeof setup> {
    const s = setup('amount', 50)
    const { budget, bot, db, thread } = s
    // This week (Mon Nov 9 onward), this month, an older month and last year.
    budget.record('api.anthropic.com', 'claude-opus-5-5', 20_000, 2000, bot, { provider: 'anthropic', prompt: 100_000, cached: 90_000, cacheWrite: 0, output: 2000, reasoning: 0 }, NOW - 1 * DAY)
    budget.record('api.openai.com', 'gpt-6.1-sol', 5000, 4000, null, { provider: 'openai', prompt: 5000, cached: 0, output: 4000, reasoning: 3000, tier: 'fast' }, NOW - 2 * DAY)
    budget.record('api.x.ai', 'grok-4.7', 3000, 1000, bot, { provider: 'xai', prompt: 3000, cached: 0, output: 1000 }, NOW - 10 * DAY)
    budget.record('api.anthropic.com', 'claude-haiku-5-5', 1000, 1000, bot, {}, new Date(2026, 9, 20).getTime())
    budget.record('api.anthropic.com', 'claude-sonnet-5-5', 1_000_000, 100_000, null, {}, new Date(2025, 5, 1).getTime())
    // Local replies in a chat (counted from messages).
    const m = db.insertMessage({ threadId: thread, role: 'assistant', content: 'local', kind: 'normal', status: 'done', model: 'qwen3.8:27b', meta: { promptTokens: 800, completionTokens: 200 } })
    db.sql.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(NOW - 3 * DAY, m.id)
    return s
  }

  test('weeks start Monday; months and days in local time', () => {
    expect(new Date(weekStart(NOW)).getDay()).toBe(1)
    expect(dayKey(weekStart(NOW))).toBe('2026-11-09')
    expect(dayKey(monthStart(NOW))).toBe('2026-11-01')
  })

  test('month against the limit, week, lifetime across months, days and weeks', () => {
    const { db, budget } = seeded()
    const b = budget.summary()
    const thisMonth = month(new Date(NOW))
    const spent = (db.sql.prepare('SELECT SUM(usd) AS s FROM usage WHERE month = ?').get(thisMonth) as { s: number }).s
    const d = usageDashboard(db, { now: NOW, month: thisMonth, spent, monthRequests: 3, cap: b.cap, mode: b.mode, spaces: db.listSpaces(), isCloud })
    const opus = cost('claude-opus-5-5', 20_000, 2000)
    const sol = cost('gpt-6.1-sol', 5000, 4000)
    const grok = cost('grok-4.7', 3000, 1000)
    expect(d.limit).toMatchObject({ mode: 'amount', cap: 50 })
    expect(d.monthTotals.usd).toBeCloseTo(opus + sol + grok, 9)
    expect(d.monthTotals.requests).toBe(4) // three cloud + one local
    // This week: Mon Nov 9 to now (opus, sol, the local reply); grok on Nov 5 is last week.
    expect(d.week.usd).toBeCloseTo(opus + sol, 9)
    expect(d.week.requests).toBe(3)
    // Lifetime keeps every month, last year included.
    const all = opus + sol + grok + cost('claude-haiku-5-5', 1000, 1000) + cost('claude-sonnet-5-5', 1_000_000, 100_000)
    expect(d.lifetime.usd).toBeCloseTo(all, 9)
    expect(d.lifetime.requests).toBe(5)
    expect(d.lifetime.cached).toBe(90_000)
    expect(d.lifetime.reasoning).toBe(3000)
    expect(d.lifetime.local).toEqual({ requests: 1, input: 800, output: 200 })
    expect(d.lifetime.since).toBe(new Date(2025, 5, 1).getTime())
    // 30 days and 12 weeks, oldest first, every slot present.
    expect(d.days).toHaveLength(30)
    expect(d.days.at(-1)!.day).toBe('2026-11-15')
    expect(d.days.find((x) => x.day === '2026-11-14')).toMatchObject({ cloudTokens: 100_000 + 2000, localTokens: 0, requests: 1 })
    expect(d.days.find((x) => x.day === '2026-11-12')).toMatchObject({ localTokens: 1000 })
    expect(d.weeks).toHaveLength(12)
    expect(d.weeks.at(-1)!.start).toBe('2026-11-09')
    expect(d.weeks.at(-1)!.usd).toBeCloseTo(opus + sol, 9)
    expect(d.weeks.at(-2)!.usd).toBeCloseTo(grok, 9)
  })

  test('per model and per provider: input, cached, output, reasoning, requests, cost and share; per bot', () => {
    const { db, budget, bot } = seeded()
    const b = budget.summary()
    const thisMonth = month(new Date(NOW))
    const d = usageDashboard(db, { now: NOW, month: thisMonth, spent: 0, monthRequests: 0, cap: b.cap, mode: b.mode, spaces: db.listSpaces(), isCloud })
    const opus = d.byModel.find((x) => x.model === 'claude-opus-5-5')!
    expect(opus).toMatchObject({ provider: 'anthropic', where: 'cloud', requests: 1, input: 10_000, cached: 90_000, output: 2000, reasoning: 0 })
    const sol = d.byModel.find((x) => x.model === 'gpt-6.1-sol')!
    expect(sol).toMatchObject({ input: 5000, output: 4000, reasoning: 3000, fastRequests: 1 })
    expect(d.byModel.find((x) => x.model === 'qwen3.8:27b')).toMatchObject({ where: 'local', provider: 'local', usd: 0, input: 800, output: 200 })
    expect(d.byModel.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 9)
    expect(d.byModel[0].usd).toBeGreaterThanOrEqual(d.byModel[1].usd)
    expect(d.byProvider.map((p) => p.provider).sort()).toEqual(['anthropic', 'local', 'openai', 'xai'])
    expect(d.byProvider.find((p) => p.provider === 'xai')).toMatchObject({ name: 'xAI', requests: 1 })
    const writer = d.byBot.find((x) => x.spaceId === bot)!
    expect(writer.usd).toBeCloseTo(cost('claude-opus-5-5', 20_000, 2000) + cost('grok-4.7', 3000, 1000), 9)
    expect(writer.requests).toBe(3) // opus, grok, the local reply
    expect(d.byBot.find((x) => x.spaceId === null)).toMatchObject({ name: 'Not from a bot', requests: 1 })
    const g = usageGlance(d)
    expect(g.days).toHaveLength(7)
    expect(g.lifetimeUsd).toBeCloseTo(d.lifetime.usd, 9)
  })

  test('CSV: every request with its token detail; providers named', () => {
    const { db } = seeded()
    const csv = usageDetailCsv(db, (id) => (id ? 'Writer' : ''))
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('date,time,bot,provider,model,input_tokens,cached_input_tokens,cache_write_tokens,output_tokens,reasoning_tokens,tier,web_calls,usd')
    expect(lines).toHaveLength(6)
    expect(lines.find((l) => l.includes('gpt-6.1-sol'))).toMatch(/,OpenAI,gpt-6\.1-sol,5000,0,0,4000,3000,fast,0,/)
    expect(lines.find((l) => l.includes('claude-opus-5-5'))).toMatch(/,Writer,Anthropic,claude-opus-5-5,10000,90000,0,2000,0,standard,/)
    expect(providerOf('grok-4.7', 'api.x.ai')).toBe('xai')
    expect(providerOf('chatgpt-plan/gpt-6.1-sol', 'chatgpt-plan')).toBe('chatgpt')
  })
})
