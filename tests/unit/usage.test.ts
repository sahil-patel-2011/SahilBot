import { describe, expect, test } from 'vitest'
import { Db } from '../../src/main/db'
import { Budget } from '../../src/main/llm/budget'
import { aggregateUsage, csvCell, dayKey, usageCsv, usageRows, usageScope, windowStart } from '../../src/main/usage'

const isCloud = (m: string): boolean => m.startsWith('claude-')

function setup(): { db: Db; budget: Budget; bot: string; main: string; thread: string } {
  const db = new Db(':memory:')
  const budget = new Budget(db, () => 10)
  const main = db.createSpace('SahilBot', '#1F1F1F', { isMain: true, shape: 'mascot' }).id
  const bot = db.createSpace('Writer', '#7C5CFF').id
  const thread = db.createThread(bot, 'auto', null).id
  return { db, budget, bot, main, thread }
}

describe('usage', () => {
  test('cloud requests are recorded against their bot; local replies are counted from chats', () => {
    const { db, budget, bot, thread } = setup()
    budget.record('api.anthropic.com', 'claude-opus-5-5', 100_000, 10_000, bot) // $0.60
    budget.record('api.anthropic.com', 'claude-haiku-5-5', 1000, 1000, null)
    db.insertMessage({ threadId: thread, role: 'assistant', content: 'hi', kind: 'normal', status: 'done', model: 'qwen3.5:9b', meta: { promptTokens: 500, completionTokens: 40 } })
    db.insertMessage({ threadId: thread, role: 'assistant', content: 'yo', kind: 'normal', status: 'done', model: 'qwen3.5:9b' })
    // A cloud reply is in the chat too, but it's already in the usage table: not counted twice.
    db.insertMessage({ threadId: thread, role: 'assistant', content: 'c', kind: 'normal', status: 'done', model: 'claude-opus-5-5' })
    db.insertMessage({ threadId: thread, role: 'user', content: 'q', kind: 'normal', status: 'done' })

    const now = Date.now()
    const rows = usageRows(db, windowStart(now, 30), isCloud)
    expect(rows).toHaveLength(3)
    expect(rows.find((r) => r.where === 'local')).toMatchObject({ spaceId: bot, model: 'qwen3.5:9b', requests: 2, input: 500, output: 40, usd: 0, day: dayKey(now) })

    const b = budget.summary()
    const r = aggregateUsage(rows, db.listSpaces(), { now, days: 30, month: b.month, spent: b.spent, cap: b.cap, monthRequests: b.requests })
    expect(r.spent).toBeCloseTo(0.6006, 6)
    expect(r.cap).toBe(10)
    expect(r.totals).toMatchObject({ cloudRequests: 2, localRequests: 2, input: 101_500, output: 11_040 })
    expect(r.byDay).toHaveLength(30)
    expect(r.byDay.at(-1)).toMatchObject({ day: dayKey(now), cloudRequests: 2, localRequests: 2 })
    expect(r.byDay[0].day).toBe(dayKey(windowStart(now, 30)))
    expect(r.byModel[0]).toMatchObject({ model: 'claude-opus-5-5', where: 'cloud', requests: 1 })
    expect(r.byModel.map((m) => m.where).sort()).toEqual(['cloud', 'cloud', 'local'])
    const writer = r.byBot.find((x) => x.spaceId === bot)!
    expect(writer).toMatchObject({ name: 'Writer', color: '#7C5CFF', cloudRequests: 1, localRequests: 2 })
    expect(r.byBot.find((x) => x.spaceId === null)).toMatchObject({ name: 'Not from a bot', cloudRequests: 1 })
  })

  test('old rows outside the window are left out; a deleted bot is grouped', () => {
    const { db, budget, bot } = setup()
    budget.record('h', 'claude-opus-5-5', 10, 10, bot)
    db.sql.prepare('UPDATE usage SET at = ?').run(Date.now() - 40 * 86_400_000)
    budget.record('h', 'claude-opus-5-5', 10, 10, 'gone')
    const rows = usageRows(db, windowStart(Date.now(), 30), isCloud)
    expect(rows).toHaveLength(1)
    const r = aggregateUsage(rows, db.listSpaces(), { now: Date.now(), days: 30, month: '', spent: 0, cap: 0, monthRequests: 0 })
    expect(r.byBot).toEqual([expect.objectContaining({ spaceId: null, name: 'Deleted bots' })])
  })

  test('CSV: one line per day, bot and model; formulas defused', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell(1.5)).toBe('1.5')
    const csv = usageCsv([{ day: '2026-11-13', spaceId: 'b', model: 'claude-opus-5-5', where: 'cloud', requests: 2, input: 10, output: 5, usd: 0.0012345678 }], () => '+Bot')
    expect(csv).toBe("date,bot,model,where,requests,input_tokens,output_tokens,usd\n2026-11-13,'+Bot,claude-opus-5-5,cloud,2,10,5,0.001235\n")
  })

  test('concurrent scopes keep their own bot', async () => {
    const seen: Array<string | null | undefined> = []
    const run = (id: string) => usageScope.run({ spaceId: `space-of-${id}`, threadId: id }, async () => {
      await new Promise((r) => setTimeout(r, 1))
      seen.push(usageScope.getStore()?.spaceId)
    })
    await Promise.all([run('a'), run('b')])
    expect(seen.sort()).toEqual(['space-of-a', 'space-of-b'])
    expect(usageScope.getStore()).toBeUndefined()
  })

  test('the migration adds the bot column to an existing usage table', () => {
    const db = new Db(':memory:')
    const cols = (db.sql.prepare('PRAGMA table_info(usage)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('space_id')
  })
})
