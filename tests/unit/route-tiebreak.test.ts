import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { Attachment } from '@shared/types'
import { TASK_CATEGORIES, classifyTask, type TaskCategory } from '../../src/main/llm/task-classifier'
import { TIEBREAK_SCHEMA, TiebreakCache, mergeTiebreak, parseTiebreak, tiebreak, tiebreakAllowed, tiebreakPrompt, type TiebreakAsk } from '../../src/main/llm/route-tiebreak'

// The tie-breaker, with fakes only (no paid calls): gating, the strict schema, the timeout, the per-message
// cache, the upward merge, and what it would do on the eval set with simulated answerers.

const unsure = classifyTask('the thing from yesterday, can you look at it again')
const gate = { cloudKey: true, model: 'claude-haiku-5-5', spendLimitUsd: 20, budgetLeftUsd: 12 }
const reply = (o: object): string => JSON.stringify(o)

describe('when it may ask', () => {
  test('only unsure decisions, with a cloud key, a model, a spend limit and budget left', () => {
    expect(unsure.confident).toBe(false)
    expect(tiebreakAllowed(unsure, gate)).toBe(true)
    expect(tiebreakAllowed(classifyTask('Fix the TypeError in src/app.ts'), gate)).toBe(false)
    expect(tiebreakAllowed(unsure, { ...gate, cloudKey: false })).toBe(false)
    expect(tiebreakAllowed(unsure, { ...gate, model: undefined })).toBe(false)
    expect(tiebreakAllowed(unsure, { ...gate, spendLimitUsd: 0 })).toBe(false)
    expect(tiebreakAllowed(unsure, { ...gate, spendLimitUsd: undefined })).toBe(false)
    expect(tiebreakAllowed(unsure, { ...gate, budgetLeftUsd: 0 })).toBe(false)
  })
})

describe('the answer', () => {
  test('the prompt is tiny and the schema strict', () => {
    const p = tiebreakPrompt('x'.repeat(5000))
    expect(p.system.length).toBeLessThan(700)
    expect(p.user.length).toBe(2000)
    expect(TIEBREAK_SCHEMA.additionalProperties).toBe(false)
    expect(TIEBREAK_SCHEMA.properties.category.enum).toEqual(TASK_CATEGORIES)
  })
  test('only exactly the schema parses', () => {
    expect(parseTiebreak(reply({ category: 'coding', kind: 'agent', difficulty: 2 }))).toEqual({ category: 'coding', kind: 'agent', difficulty: 2 })
    expect(parseTiebreak('Sure! {"category":"math","kind":"chat","difficulty":1}')).toEqual({ category: 'math', kind: 'chat', difficulty: 1 })
    expect(parseTiebreak(reply({ category: 'cooking', kind: 'agent', difficulty: 2 }))).toBeUndefined()
    expect(parseTiebreak(reply({ category: 'coding', kind: 'maybe', difficulty: 2 }))).toBeUndefined()
    expect(parseTiebreak(reply({ category: 'coding', kind: 'agent', difficulty: 5 }))).toBeUndefined()
    expect(parseTiebreak(reply({ category: 'coding', kind: 'agent', difficulty: 2, effort: 'max' }))).toBeUndefined()
    expect(parseTiebreak('no json here')).toBeUndefined()
  })
  test('merging leans up: the higher difficulty, agent if either says so', () => {
    const m = mergeTiebreak(unsure, { category: 'research', kind: 'chat', difficulty: 3 })
    expect(m.category).toBe('research')
    expect(m.difficulty).toBe(3)
    expect(m.effort).toBe('xhigh')
    const chat = classifyTask('hmm interesting thought about the ocean')
    expect(mergeTiebreak({ ...chat, kind: 'agent' }, { category: 'chat', kind: 'chat', difficulty: 0 })).toMatchObject({ kind: 'agent', difficulty: chat.difficulty })
  })
})

describe('time and cost', () => {
  test('a slow model times out at 1.5 s and the rules decide', async () => {
    const slow: TiebreakAsk = ({ signal }) => new Promise((res, rej) => { const t = setTimeout(() => res(reply({ category: 'coding', kind: 'agent', difficulty: 3 })), 5000); signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')) }) })
    const r = await tiebreak({ messageId: 'm1', text: 'x', decision: unsure, gate, ask: slow, cache: new TiebreakCache(), timeoutMs: 60 })
    expect(r.asked).toBe(true)
    expect(r.decision).toBe(unsure)
    expect(r.ms).toBeLessThan(1000)
  })
  test('one call per message: the answer (or its absence) is cached', async () => {
    let calls = 0
    const ask: TiebreakAsk = async () => { calls++; return reply({ category: 'agent-tools', kind: 'agent', difficulty: 2 }) }
    const cache = new TiebreakCache()
    const a = await tiebreak({ messageId: 'm2', text: 'x', decision: unsure, gate, ask, cache })
    const b = await tiebreak({ messageId: 'm2', text: 'x', decision: unsure, gate, ask, cache })
    expect(calls).toBe(1)
    expect(a.decision.category).toBe('agent-tools')
    expect(b.decision.category).toBe('agent-tools')
    expect(b.asked).toBe(false)
    let bad = 0
    const garbage: TiebreakAsk = async () => { bad++; return 'I think it is coding' }
    await tiebreak({ messageId: 'm3', text: 'x', decision: unsure, gate, ask: garbage, cache })
    await tiebreak({ messageId: 'm3', text: 'x', decision: unsure, gate, ask: garbage, cache })
    expect(bad).toBe(1)
  })
  test('errors never surface', async () => {
    const boom: TiebreakAsk = async () => { throw new Error('429 rate limited') }
    expect((await tiebreak({ messageId: 'm4', text: 'x', decision: unsure, gate, ask: boom, cache: new TiebreakCache() })).decision).toBe(unsure)
  })
  test('nothing is asked when it is not allowed', async () => {
    let calls = 0
    const ask: TiebreakAsk = async () => { calls++; return '' }
    await tiebreak({ messageId: 'm5', text: 'x', decision: unsure, gate: { ...gate, spendLimitUsd: 0 }, ask, cache: new TiebreakCache() })
    expect(calls).toBe(0)
  })
})

// What it would do on the eval set, with simulated answerers: an oracle (always the label) bounds the gain; a
// realistic one is right 80% of the time. The rules were tuned on these items, so this measures the downside.
describe('measured on the eval set (simulated answers)', () => {
  interface Item { id: string; text: string; category: TaskCategory; ctx?: { files?: Array<{ name: string; tokens?: number }>; images?: number; voice?: boolean; codeProject?: boolean; prev?: { category: TaskCategory; difficulty: 0 | 1 | 2 | 3; kind: 'chat' | 'agent' }; flags?: Record<string, boolean>; bot?: { role: string }; routine?: boolean; group?: boolean; helper?: boolean; folders?: number; openPlan?: boolean } }
  const items = (JSON.parse(readFileSync(join(__dirname, '../fixtures/routing-eval.json'), 'utf8')) as { items: Item[] }).items
  const decide = (it: Item) => {
    const c = it.ctx ?? {}
    const attachments: Attachment[] = (c.files ?? []).map((x) => ({ kind: 'file' as const, path: `/tmp/${x.name}`, name: x.name }))
    return classifyTask(it.text, { attachments, images: c.images, voice: c.voice, codeProject: c.codeProject, previousCategory: c.prev?.category, previousTier: c.prev?.difficulty, previousKind: c.prev?.kind, role: c.bot?.role, unattended: c.routine, group: c.group, helper: c.helper, folders: c.folders, openPlan: c.openPlan, inputTokens: (c.files ?? []).reduce((n, x) => n + (x.tokens ?? 0), 0), ...c.flags })
  }
  test('report: how many it would ask, and the accuracy change', () => {
    let asked = 0, before = 0, oracle = 0, noisy = 0, i = 0
    for (const it of items) {
      const d = decide(it)
      const ok = d.category === it.category
      if (ok) before++
      if (!tiebreakAllowed(d, gate)) { if (ok) { oracle++; noisy++ } continue }
      asked++
      oracle++
      // Right 4 times in 5 (deterministic), otherwise a wrong category.
      const right = i++ % 5 !== 4
      if (right) noisy++
    }
    const pct = (k: number): number => Math.round((k / items.length) * 1000) / 10
    console.log(`[tiebreak] would ask on ${asked}/${items.length} (${pct(asked)}%) · category before ${pct(before)}% · oracle ${pct(oracle)}% · 80%-right model ${pct(noisy)}%`)
    expect(asked).toBeGreaterThan(0)
    // On the tuned set it can't clearly help (the rules already get the unsure ones right): it stays unwired.
    expect(oracle - before).toBeLessThanOrEqual(asked)
  })
})
