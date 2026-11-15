import { describe, expect, test } from 'vitest'
import { Db } from '../../src/main/db'
import { MemoryStore } from '../../src/main/memory'
import { ContextEngine } from '../../src/main/context-engine/service'
import { CARDS_HEADER, estTokens, worldBudget } from '../../src/main/context-engine/assemble'
import { EVAL_NOW, NEVER_ANYWHERE, QUESTIONS, SCRIPTED, SOURCES } from '../fixtures/context-eval'

// The context-engine eval (tests/fixtures/context-eval.ts): 30 sources → the learning passes (scripted
// model, no network) → 41 questions. Scores: recall of the expected facts in the assembled context,
// precision of the cards shown (no irrelevant entities), and leakage (sensitive details or planted
// instructions anywhere, quoted facts shown without their "quoted" tag). Printed, and held to a floor.

async function build() {
  const db = new Db(':memory:')
  const memory = new MemoryStore(db)
  const main = db.createSpace('SahilBot', '#000', { isMain: true })
  const writer = db.createSpace('Writer', '#f00')
  const files = SOURCES.flatMap((s) => (s.kind === 'file' ? [s] : []))
  const activity = SOURCES.flatMap((s) => (s.kind === 'activity' ? s.sessions : []))
  const engine = new ContextEngine({
    db, memory, now: () => EVAL_NOW,
    docs: { recent: () => files.map((f) => ({ path: f.path, mtime: f.at, size: f.text.length })), text: (p) => files.find((f) => f.path === p)?.text ?? '' },
    activity: { allowed: () => true, timeline: () => activity }
  })
  for (const s of SOURCES) {
    if (s.kind === 'memory') memory.save(s.text, s.category, null, 'you')
    if (s.kind !== 'chat') continue
    const t = db.createThread(s.bot === 'writer' ? writer.id : main.id, 'auto', null)
    db.updateThread(t.id, { title: s.title })
    s.messages.forEach((m, i) => db.insertMessage({ threadId: t.id, role: m.role, content: m.content, kind: 'normal', status: 'done', createdAt: s.at + i * 1000, ...(m.toolName ? { toolName: m.toolName } : {}), ...(m.untrusted ? { meta: { untrusted: true } } : {}) } as never))
  }
  const asked: string[] = []
  const hooks = { async ask(_s: string, user: string) { asked.push(user); const k = Object.keys(SCRIPTED).find((x) => user.includes(x)); return k ? SCRIPTED[k] : '{"entities":[]}' }, check() {}, now: () => EVAL_NOW }
  for (let i = 0; i < 20 && engine.wants(EVAL_NOW); i++) await engine.learn(hooks)
  return { db, engine, main, writer, asked }
}

describe('context engine eval', () => {
  test('recall, precision and leakage over 30 sources and 41 questions', async () => {
    const { engine, main, writer, db } = await build()
    let found = 0, wanted = 0, cardsShown = 0, cardsOk = 0
    const leaks: string[] = []
    const misses: string[] = []
    const strays: string[] = []
    const quoted = (db.sql.prepare("SELECT a.value AS value, e.name AS name FROM ce_attributes a JOIN ce_entities e ON e.id = a.entity_id WHERE a.trust = 'quoted'").all() as Array<{ value: string; name: string }>).filter((r) => r.value.length >= 4)
    for (const q of QUESTIONS) {
      const window = q.window ?? 200_000
      const a = engine.assembleFor({ query: q.q, window, spaceId: q.bot === 'writer' ? writer.id : main.id, local: true })
      const text = a.section?.lines.join('\n') ?? ''
      for (const e of q.expect) { wanted++; if (text.includes(e)) found++; else misses.push(`${q.q} → ${e}`) }
      for (const c of a.cards) {
        cardsShown++
        if (!q.ok || q.ok.includes(c.entity.name)) cardsOk++
        else strays.push(`${q.q} → ${c.entity.name}`)
      }
      for (const n of [...NEVER_ANYWHERE, ...(q.never ?? [])]) if (text.includes(n)) leaks.push(`${q.q} → ${n}`)
      // A quoted fact never shows without its quoted tag (as if it were the user's own).
      for (const { value: v, name } of quoted) for (const l of text.split('\n')) {
        const i = l.indexOf(v)
        if (i < 0 || !l.startsWith(`- ${name} (`)) continue
        const rest = l.slice(i, l.indexOf(' · ', i) < 0 ? undefined : l.indexOf(' · ', i))
        if (!/\[quoted|\(quoted\)|recent:/.test(rest) && !/recent: .*$/.test(l.slice(0, i))) leaks.push(`${q.q} → "${v}" shown unquoted`)
      }
      if (a.tokens > worldBudget(window).tokens + 60) leaks.push(`${q.q} → over budget (${a.tokens} > ${worldBudget(window).tokens})`)
      if (q.window === 16_384) expect(a.cards.length).toBeLessThanOrEqual(4)
    }
    // Everything at once: a broad request on a 1M window must still leak nothing.
    for (const broad of ['Tell me everything about my family and friends: Priya, Raj, Sam, Leo, Anita, Maya, Dana, Lena, Carla.', 'my passwords and accounts', 'what should I know about my health?']) {
      const text = engine.assembleFor({ query: broad, window: 1_000_000, spaceId: main.id, local: true }).section?.lines.join('\n') ?? ''
      for (const n of NEVER_ANYWHERE) if (text.includes(n)) leaks.push(`${broad} → ${n}`)
      if (text.includes('Lena Fox')) leaks.push(`${broad} → another bot's quoted entity`)
    }
    const recall = found / wanted
    const precision = cardsShown ? cardsOk / cardsShown : 1
    console.log(`[context eval] sources=${SOURCES.length} questions=${QUESTIONS.length} recall=${recall.toFixed(3)} (${found}/${wanted}) precision=${precision.toFixed(3)} (${cardsOk}/${cardsShown}) leakage=${leaks.length}`)
    if (misses.length) console.log(`[context eval] misses:\n  ${misses.join('\n  ')}`)
    if (strays.length) console.log(`[context eval] irrelevant cards:\n  ${strays.join('\n  ')}`)
    if (leaks.length) console.log(`[context eval] leaks:\n  ${leaks.join('\n  ')}`)
    expect(SOURCES.length).toBe(30)
    expect(QUESTIONS.length).toBeGreaterThanOrEqual(40)
    expect(leaks).toEqual([])
    expect(recall).toBeGreaterThanOrEqual(0.95)
    expect(precision).toBeGreaterThanOrEqual(0.9)
    expect(estTokens(CARDS_HEADER)).toBeGreaterThan(0)
  })
})
