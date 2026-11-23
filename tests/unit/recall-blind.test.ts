import { expect, test } from 'vitest'
import { Db } from '../../src/main/db'
import { MemoryStore } from '../../src/main/memory'
import { MemorySystem } from '../../src/main/memory-system'
import { recallQuery } from '../../src/main/agent/loop'
import { BLIND_CASES, BLIND_CHATS, BLIND_KEY, BLIND_NEGATIVE, BLIND_NOISE } from '../fixtures/recall-blind'

// The blind recall eval (tests/fixtures/recall-blind.ts): a person, 30 key facts, 300 unrelated ones, 8 past chats,
// 50 requests and 25 generic ones, all written by another agent that never saw the matching code. Nothing in the
// matching was tuned on it: the first score is the score, and it stays untuned so it keeps measuring honestly.
// 23 Nov 2026, same fixture, code before this work → after: 24/50 → 38/50 up front at 700 tokens (the old fixed
// budget), 24/50 → 40/50 at a 200K model's budget, 34/50 → 43/50 with one memory search; generic requests pulling
// nothing personal 21/25 → 22/25 (700) and 20/25 (2500).

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 23, 17)

function build() {
  const db = new Db(':memory:')
  const memory = new MemoryStore(db)
  const main = db.listSpaces().find((s) => s.isMain) ?? db.createSpace('SahilBot', '#000', { isMain: true })
  BLIND_KEY.forEach((f, i) => memory.save(f.text, f.category, null, 'chat', 'trusted', { at: NOW - (150 - i) * DAY }))
  BLIND_NOISE.forEach((f, i) => memory.save(f.text, f.category, null, 'chat', 'trusted', { at: NOW - (60 - (i % 60)) * DAY }))
  for (const c of BLIND_CHATS) {
    const t = db.createThread(main.id, 'auto', null)
    db.updateThread(t.id, { title: c.title })
    c.user.forEach((u, i) => db.insertMessage({ threadId: t.id, role: 'user', kind: 'normal', status: 'done', content: u, createdAt: NOW - c.daysAgo * DAY + i * 1000 } as never))
  }
  return { db, memory, system: new MemorySystem(db, memory, () => NOW), main }
}

function context(env: ReturnType<typeof build>, ask: string, earlier: string[] = [], maxTokens = 700): { block: string; said: string } {
  const t = env.db.createThread(env.main.id, 'auto', null)
  const before = earlier.map((content, i) => env.db.insertMessage({ threadId: t.id, role: 'user', kind: 'normal', status: 'done', content, createdAt: NOW - 60_000 + i } as never))
  const opener = env.db.insertMessage({ threadId: t.id, role: 'user', kind: 'normal', status: 'done', content: ask, createdAt: NOW } as never)
  const query = recallQuery(opener, [...before, opener])
  return { block: env.memory.block({ spaceId: null, spaceName: 'SahilBot', query, now: NOW, maxTokens } as never), said: env.db.recallUserSaid(query, t.id, 6).map((x) => x.text).join('\n') }
}

async function recall(maxTokens: number) {
  const env = build()
  let up = 0, either = 0
  const misses: string[] = []
  for (const c of BLIND_CASES) {
    const { block, said } = context(env, c.ask, c.earlier, maxTokens)
    const ctx = `${block}\n${said}`
    const found = (await env.system.recall([c.ask, ...(c.earlier ?? [])].join('\n'), env.main.id, { limit: 5 })).map((h) => h.text).join('\n')
    const inCtx = c.need.every((n) => ctx.includes(n))
    if (inCtx) up++
    if (c.need.every((n) => ctx.includes(n) || found.includes(n))) either++
    if (!inCtx) misses.push(`"${c.ask}" → ${c.need.filter((n) => !ctx.includes(n)).join(', ')}`)
  }
  return { up, either, misses }
}

test('blind recall set: what the user told it reaches the run', async () => {
  for (const budget of [700, 2500]) {
    const r = await recall(budget)
    console.log(`blind recall, ${budget} tokens: ${r.up}/${BLIND_CASES.length} in context up front, ${r.either}/${BLIND_CASES.length} with one memory search`)
    for (const m of r.misses) console.log(`  miss: ${m}`)
    expect(r.up / BLIND_CASES.length).toBeGreaterThanOrEqual(budget === 700 ? 0.72 : 0.76)
    expect(r.either / BLIND_CASES.length).toBeGreaterThanOrEqual(0.82)
  }
})

test('blind negatives: generic requests don\'t pull personal details in', async () => {
  const env = build()
  // What a run shows with no request to match (the most important facts), at the same budget: a detail that is only
  // there because of the request's words was pulled in by it.
  for (const budget of [700, 2500]) {
    const baseline = env.memory.block({ spaceId: null, spaceName: 'SahilBot', query: '', now: NOW, maxTokens: budget } as never)
    const bad: string[] = []
    for (const n of BLIND_NEGATIVE) {
      const { block, said } = context(env, n.ask, [], budget)
      const pulled = n.mustNot.filter((x) => (block.includes(x) && !baseline.includes(x)) || said.includes(x))
      if (pulled.length) bad.push(`"${n.ask}" → ${pulled.join(', ')}`)
    }
    console.log(`blind negatives, ${budget} tokens: ${BLIND_NEGATIVE.length - bad.length}/${BLIND_NEGATIVE.length} pull in nothing personal`)
    for (const b of bad) console.log(`  leak: ${b}`)
    expect(bad.length).toBeLessThanOrEqual(5)
  }
})
