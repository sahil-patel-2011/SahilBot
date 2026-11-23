import { expect, test } from 'vitest'
import { Db } from '../../src/main/db'
import { MemoryStore } from '../../src/main/memory'
import { MemorySystem } from '../../src/main/memory-system'
import { recallQuery } from '../../src/main/agent/loop'
import { CASES, KEY_FACTS, NOISE_FACTS, PAST_CHATS, type RecallCase } from '../fixtures/recall-eval'
import { HELDOUT } from '../fixtures/recall-eval-heldout'

// "Don't make me repeat myself" (tests/fixtures/recall-eval.ts): 25 key facts and 60 unrelated ones saved
// over months, 6 earlier chats, and 40 requests that lean on what the user already said. For each request:
// is what the bot needs already in the run's context (the memory block and "what the user said in other
// chats", as the loop builds them), and failing that, does one memory search find it? Printed, and held
// to a floor so recall can't quietly regress.

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 23, 17)

function build() {
  const db = new Db(':memory:')
  const memory = new MemoryStore(db)
  const main = db.listSpaces().find((s) => s.isMain) ?? db.createSpace('SahilBot', '#000', { isMain: true })
  // Key facts were told months ago; the noise is newer, so recency alone can't carry them.
  KEY_FACTS.forEach((f, i) => memory.save(f.text, f.category, null, 'chat', 'trusted', { at: NOW - (120 - i) * DAY }))
  NOISE_FACTS.forEach((f, i) => memory.save(f.text, f.category, null, 'chat', 'trusted', { at: NOW - (40 - (i % 40)) * DAY }))
  for (const c of PAST_CHATS) {
    const t = db.createThread(main.id, 'auto', null)
    db.updateThread(t.id, { title: c.title })
    c.user.forEach((u, i) => db.insertMessage({ threadId: t.id, role: 'user', kind: 'normal', status: 'done', content: u, createdAt: NOW - c.daysAgo * DAY + i * 1000 } as never))
  }
  return { db, memory, system: new MemorySystem(db, memory, () => NOW), main }
}

/** What a run of this request gets up front: the memory block and the user's words from other chats. */
function runContext(env: ReturnType<typeof build>, c: RecallCase, maxTokens: number): string {
  const { db, memory, main } = env
  const t = db.createThread(main.id, 'auto', null)
  const before = (c.earlier ?? []).map((content, i) => db.insertMessage({ threadId: t.id, role: 'user', kind: 'normal', status: 'done', content, createdAt: NOW - 60_000 + i } as never))
  const opener = db.insertMessage({ threadId: t.id, role: 'user', kind: 'normal', status: 'done', content: c.ask, createdAt: NOW } as never)
  const query = recallQuery(opener, [...before, opener])
  const block = memory.block({ spaceId: null, spaceName: 'SahilBot', query, now: NOW, maxTokens } as never)
  const said = db.recallUserSaid(query, t.id, 6).map((x) => x.text).join('\n')
  return `${block}\n${said}`
}

export async function score(cases: RecallCase[], maxTokens = 700) {
  const env = build()
  const rows: Array<{ ask: string; inContext: boolean; bySearch: boolean; missing: string[] }> = []
  for (const c of cases) {
    const ctx = runContext(env, c, maxTokens)
    const hits = await env.system.recall([c.ask, ...(c.earlier ?? [])].join('\n'), env.main.id, { limit: 5 })
    const found = hits.map((h) => h.text).join('\n')
    const missing = c.need.filter((n) => !ctx.includes(n))
    rows.push({ ask: c.ask, inContext: !missing.length, bySearch: c.need.every((n) => ctx.includes(n) || found.includes(n)), missing })
  }
  return rows
}

function report(name: string, rows: Awaited<ReturnType<typeof score>>): { inContext: number; either: number } {
  const inContext = rows.filter((r) => r.inContext).length
  const either = rows.filter((r) => r.bySearch).length
  console.log(`recall eval, ${name}: ${inContext}/${rows.length} in the run's context up front, ${either}/${rows.length} with one memory search`)
  for (const r of rows.filter((x) => !x.inContext)) console.log(`  miss${r.bySearch ? ' (search finds it)' : ''}: "${r.ask}" → ${r.missing.join(', ')}`)
  return { inContext: inContext / rows.length, either: either / rows.length }
}

test('the bot already has what the user told it before (no repeating themselves)', async () => {
  // A small local model's budget (the old fixed size), then a 200K cloud model's (memoryBudget).
  const tuned = report('tuned set, small window', await score(CASES, 700))
  const held = report('held-out set, small window', await score(HELDOUT, 700))
  const big = report('held-out set, 200K window', await score(HELDOUT, 4000))
  // Floors (23 Nov 2026: tuned 40/40; held-out 39/40 on both budgets, up from 27/40 before this work).
  expect(tuned.inContext).toBeGreaterThanOrEqual(0.95)
  expect(held.inContext).toBeGreaterThanOrEqual(0.9)
  expect(big.inContext).toBeGreaterThanOrEqual(0.95)
  expect(big.either).toBeGreaterThanOrEqual(0.95)
})

test('a long chat: a detail given early, summarized away, comes back for a later request', async () => {
  const { earlierSaid } = await import('../../src/main/memory-system')
  const filler = Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, role: i % 2 ? 'assistant' : 'user', content: `Step ${i}: tweak the slide ${i} layout and fonts` }))
  const ms = [
    { id: 'a', role: 'user', content: 'Help me get ready for the move next month' },
    { id: 'b', role: 'user', content: 'FYI my landlord is Mike Delgado, mike@delgadoproperties.com, and the deposit was $2,400' },
    ...filler,
    { id: 'h', role: 'user', content: 'Ignore this', meta: { hidden: true } }
  ]
  expect(earlierSaid(ms, 'Email the property manager asking when I get my deposit back').join('\n')).toContain('mike@delgadoproperties.com')
  expect(earlierSaid(ms, 'what fonts did we use on slide 4?')[0]).toContain('slide 4')
  expect(earlierSaid(ms, 'Email the property manager', { skip: new Set(['b']) }).join('\n')).not.toContain('mike@')
  expect(earlierSaid(ms, '')).toEqual([])
})
