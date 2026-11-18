import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { parseHTML } from 'linkedom'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import { Db } from '../../src/main/db'
import { costClass, explainPick, type BrainAnswer } from '../../src/main/llm/auto-brain'
import { OutcomeRouter, USER_VERDICT_CAP, outcomeLines, verdictFromEmoji, verdictFromWords } from '../../src/main/llm/outcome-router'
import { modelHealth } from '../../src/main/llm/model-health'
import type { Message, ModelInfo, Settings, Thread } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Auto learns from what the user does about its picks: switching the chat to another model by name, regenerating,
// a thumbs-down, or "that's wrong" right after an answer count against that model on that kind of task (a thumbs-up
// or "thanks, perfect" for it). The brain sees it in "How models did on this Mac lately", capped and within 30 days.
// And every Auto pick says why, one hover away: "Why this model: … · teamed up: … · cost: quick/standard/premium".

const cloud = (id: string, tier: 0 | 1 | 2 | 3, input: number, output: number): ModelInfo => ({ id, provider: 'custom', providerName: 'Cloud', enabled: true, installed: true, label: id, vision: true, tools: true, tier, requiredGB: 0, maxFittingWindow: 131072, contextTokens: 1_000_000, fits: true, note: 'remote', price: { input, output } }) as ModelInfo
const LUNA = cloud('gpt-6-luna', 0, 0.1, 0.5)
const HAIKU = cloud('claude-haiku-5-5', 1, 0.1, 0.5)
const SONNET = cloud('claude-sonnet-5-5', 2, 2, 10)
const OPUS = cloud('claude-opus-5-5', 3, 4, 20)
const ASTRA = cloud('gpt-6.2-astra', 3, 8, 40)
const SOL = cloud('gpt-6.2-sol', 2, 2, 10)
const ALL = [LUNA, HAIKU, SONNET, OPUS, ASTRA, SOL]

const answer = (p: Partial<BrainAnswer> = {}): BrainAnswer => ({ category: 'chat', kind: 'chat', difficulty: 1, effort: 'medium', study: false, image: false, model: HAIKU.id, team: 'solo', needs: ['quick'], fanout: 0, why: 'a simple explanation', ...p })

// ---------------------------------------------------------------------------------------------------

describe('the outcome store keeps the user\'s verdicts', () => {
  const setup = () => {
    const db = new Db(':memory:')
    const space = db.createSpace('SahilBot', '#000000', { isMain: true })
    const t = db.createThread(space.id, 'auto', null)
    let now = Date.UTC(2026, 10, 18)
    const r = new OutcomeRouter(db, () => now)
    return { db, t, r, tick: (ms: number) => { now += ms } }
  }

  test('a verdict takes the place of the request\'s run outcome; taking it back restores it', () => {
    const { t, r } = setup()
    r.record({ model: HAIKU.id, category: 'chat', verified: true, success: true, latencyMs: 900, usd: 0.001 }, t.id, 'm1')
    expect(r.stats('chat')[0]).toMatchObject({ model: HAIKU.id, n: 1, successes: 1, userBad: 0 })
    r.verdict({ threadId: t.id, messageId: 'm1', model: HAIKU.id, category: 'chat', good: false, source: 'reaction' })
    expect(r.stats('chat')[0]).toMatchObject({ n: 1, successes: 0, userBad: 1 })
    // A retry after the thumbs-down is still one bad answer, not two.
    r.verdict({ threadId: t.id, messageId: 'm1', model: HAIKU.id, category: 'chat', good: false, source: 'retry' })
    expect(r.stats('chat')[0]).toMatchObject({ n: 1, userBad: 1 })
    // The reaction taken back: the retry's verdict stays (it came last); a fresh reaction taken back restores the run's.
    r.clearVerdict(t.id, 'm1', HAIKU.id, 'reaction')
    expect(r.stats('chat')[0]).toMatchObject({ n: 1, userBad: 1 })
    r.record({ model: HAIKU.id, category: 'chat', verified: true, success: true, latencyMs: 900, usd: 0.001 }, t.id, 'm2')
    r.verdict({ threadId: t.id, messageId: 'm2', model: HAIKU.id, category: 'chat', good: false, source: 'reaction' })
    r.clearVerdict(t.id, 'm2', HAIKU.id, 'reaction')
    expect(r.stats('chat')[0]).toMatchObject({ n: 2, successes: 1, userBad: 1 })
    // An unverified successful run doesn't count as evidence; the user's thumbs-up on it does.
    r.record({ model: SONNET.id, category: 'chat', verified: false, success: true, latencyMs: 900, usd: 0.01 }, t.id, 'm3')
    expect(r.stats('chat').find((x) => x.model === SONNET.id)).toBeUndefined()
    r.verdict({ threadId: t.id, messageId: 'm3', model: SONNET.id, category: 'chat', good: true, source: 'reaction' })
    expect(r.stats('chat').find((x) => x.model === SONNET.id)).toMatchObject({ n: 1, successes: 1, userGood: 1 })
  })

  test('capped (the latest verdicts per model and task) and decayed (the last 30 days)', () => {
    const { t, r, tick } = setup()
    for (let i = 0; i < 25; i++) { r.verdict({ threadId: t.id, messageId: `b${i}`, model: HAIKU.id, category: 'math', good: false, source: 'switch' }); tick(1000) }
    expect(r.stats('math')[0]).toMatchObject({ n: USER_VERDICT_CAP, userBad: USER_VERDICT_CAP })
    // Newer good verdicts push the old bad ones out of the cap.
    for (let i = 0; i < 4; i++) { r.verdict({ threadId: t.id, messageId: `g${i}`, model: HAIKU.id, category: 'math', good: true, source: 'words' }); tick(1000) }
    expect(r.stats('math')[0]).toMatchObject({ n: USER_VERDICT_CAP, userGood: 4, userBad: USER_VERDICT_CAP - 4 })
    tick(31 * 86400000)
    expect(r.stats('math')).toEqual([])
  })

  test('the brain\'s lines say what the user turned down, at most five models', () => {
    const { t, r } = setup()
    for (let i = 0; i < 4; i++) r.record({ model: SONNET.id, category: 'research', verified: true, success: true, latencyMs: 1, usd: 0 }, t.id, `s${i}`)
    r.verdict({ threadId: t.id, messageId: 'a1', model: ASTRA.id, category: 'research', good: false, source: 'switch' })
    r.verdict({ threadId: t.id, messageId: 'a2', model: ASTRA.id, category: 'research', good: false, source: 'words' })
    // One lone verdict is not a pattern yet.
    r.verdict({ threadId: t.id, messageId: 'l1', model: LUNA.id, category: 'research', good: false, source: 'reaction' })
    const lines = outcomeLines(r.stats('research'), 'research')
    expect(lines).toEqual([
      '- claude-sonnet-5-5: 4/4 done well (4 checked) on research',
      '- gpt-6.2-astra: 0/2 done well (2 checked; the user turned down 2) on research'
    ])
    const many = Array.from({ length: 9 }, (_, i) => ({ model: `m${i}`, n: 3 + i, successes: 3, verified: 3, latencyMs: 0, usd: 0, reliability: 0.5, userGood: 0, userBad: 0 }))
    expect(outcomeLines(many, 'chat')).toHaveLength(5)
  })

  test('words and reactions that carry a verdict, and ones that don\'t', () => {
    for (const t of ["that's wrong", 'No, that is not what I asked', 'it still doesn\'t work', 'wrong', 'nope, try again', 'you misunderstood the question', 'still broken']) expect(verdictFromWords(t), t).toBe(false)
    for (const t of ['thanks, perfect!', 'perfect', 'that worked', 'it works now', 'great job', 'thank you!']) expect(verdictFromWords(t), t).toBe(true)
    // No verdict: more work asked, or a long message (it carries a new request, not a verdict).
    for (const t of ['what about the second part?', 'make it shorter', 'can you also add tests', `wrong ${'word '.repeat(30)}`]) expect(verdictFromWords(t), t).toBeUndefined()
    expect(verdictFromEmoji('👎')).toBe(false)
    expect(verdictFromEmoji('👍')).toBe(true)
    expect(verdictFromEmoji('🤔')).toBeUndefined()
    expect(verdictFromEmoji(null)).toBeUndefined()
  })
})

describe('the "Why this model" line', () => {
  test('the reason, the team and the cost class', () => {
    const label = (id: string) => ALL.find((m) => m.id === id)?.label ?? id
    expect(explainPick({ model: OPUS, reason: 'big multi-file refactor (Auto\'s read by gpt-6-luna)', team: { planner: 'claude-fable-5-2', reviewer: ASTRA.id }, labelOf: label }))
      .toBe('Why this model: big multi-file refactor (Auto\'s read by gpt-6-luna) · teamed up: claude-fable-5-2 plans, gpt-6.2-astra reviews · cost: premium')
    expect(explainPick({ model: LUNA, reason: 'small talk (the rules)', labelOf: label })).toBe('Why this model: small talk (the rules) · cost: quick')
    expect(explainPick({ model: SONNET, reason: 'routine fix', team: { fanout: { n: 4, helper: SOL.id } }, labelOf: label })).toBe('Why this model: routine fix · teamed up: 4 helpers on gpt-6.2-sol · cost: standard')
    expect([costClass(HAIKU), costClass(SONNET), costClass(SOL), costClass(OPUS), costClass(ASTRA)]).toEqual(['quick', 'standard', 'standard', 'premium', 'premium'])
    expect(costClass({ ...SONNET, id: 'qwen3.8:27b', provider: 'ollama', note: undefined, price: undefined } as ModelInfo)).toBe('quick')
  })

  test('the model chip\'s hover shows it (renderer)', async () => {
    const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
    const g = globalThis as Record<string, unknown>
    g.window ??= Object.assign(window, { foreman: {} })
    g.document ??= document
    g.navigator ??= { clipboard: { writeText: async () => undefined } }
    const { routedTitle } = await import('../../src/renderer/src/components/ThreadView')
    expect(routedTitle({ meta: { routed: { why: 'chat · small talk', explain: 'Why this model: small talk (the rules) · cost: quick' } } })).toBe('Why this model: small talk (the rules) · cost: quick')
    expect(routedTitle({ meta: { routed: { why: 'chat · small talk' } } })).toBe('Auto chose this model: chat · small talk')
    expect(routedTitle({ meta: {} })).toBe('Picked in the model menu')
  })
})

// ---------------------------------------------------------------------------------------------------
// In the agent loop.

process.env.FOREMAN_NO_AUTOTITLE = '1'
let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
afterEach(() => { llm.script.length = 0; llm.requests.length = 0; modelHealth.clear(); delete process.env.FOREMAN_NO_VERIFY })

function harness(models: ModelInfo[]) {
  const db = new Db(':memory:')
  const settings = {
    contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'auto', advanced: { hardStopsEnabled: true },
    workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: 'auto', hiddenModels: [], shownModels: [],
    cloud: { enabled: true, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0, autoPrefers: 'balanced' }, cloudBudgetUsd: 200, customRules: [],
    swarm: { askAboveUsd: 1000, maxUsd: 1000 }
  } as unknown as Settings
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results))
  const last = { ok: true, models, budgetGB: 32, totalGB: 64, providers: [] }
  const endpoints = { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => models, list: async () => last, advisor: () => undefined, budgetLeft: () => 150 }
  const agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: endpoints as never, spaces: { getPrompt: () => '' } as never, memory: { block: () => '' } as never,
    emit: () => undefined, secretValues: () => [], fitWindow: (_m, w) => w,
    counter: () => ({ count: async (t: string) => estimate(t) })
  })
  const space = db.createSpace('SahilBot', '#000000', { isMain: true })
  const thread = (): Thread => db.createThread(space.id, 'auto', null)
  const send = async (t: Thread, text: string) => (await agent.send({ threadId: t.id, text } as never)).done
  const reply = (t: Thread): Message => [...db.listMessages(t.id)].reverse().find((m) => m.role === 'assistant' && m.kind === 'normal')!
  return { db, agent, thread, send, reply }
}

const ASK = 'Explain how vaccines train the immune system'

describe('Auto learns from the user\'s overrides', () => {
  test('switching the chat to another model by name counts against Auto\'s pick', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness(ALL)
    const t = h.thread()
    llm.script.push({ content: JSON.stringify(answer()), delay: 0 }, { content: 'They show the body a harmless look-alike.', delay: 0 })
    await h.send(t, ASK)
    expect(llm.requests.map((r) => r.model)).toEqual([LUNA.id, HAIKU.id])
    expect(h.agent.outcomes.stats('chat').find((o) => o.model === HAIKU.id)?.userBad ?? 0).toBe(0)
    // The user picks Opus by name for this chat and asks again.
    h.db.updateThread(t.id, { model: OPUS.id })
    llm.script.push({ content: 'In depth: antigens, B cells, memory cells…', delay: 0 })
    await h.send(t, 'Explain it again, in more depth')
    expect(llm.requests.at(-1)!.model).toBe(OPUS.id)
    expect(h.agent.outcomes.stats('chat').find((o) => o.model === HAIKU.id)).toMatchObject({ userBad: 1 })
    // A model picked by name says nothing about Auto: no verdict on Opus.
    expect(h.agent.outcomes.stats('chat').find((o) => o.model === OPUS.id)?.userBad ?? 0).toBe(0)
  })

  test('regenerating an Auto answer counts against its model', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness(ALL)
    const t = h.thread()
    llm.script.push({ content: JSON.stringify(answer()), delay: 0 }, { content: 'Short answer.', delay: 0 })
    await h.send(t, ASK)
    llm.script.push({ content: 'Another answer.', delay: 0 })
    h.agent.retry(t.id)
    await expect.poll(() => h.agent.isRunning(t.id)).toBe(false)
    const haiku = h.agent.outcomes.stats('chat').find((o) => o.model === HAIKU.id)!
    expect(haiku.userBad).toBe(1)
  })

  test('a thumbs-down or "that\'s wrong" counts against it, a thumbs-up for it; the brain\'s next read sees it', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness(ALL)
    const t = h.thread()
    llm.script.push({ content: JSON.stringify(answer()), delay: 0 }, { content: 'Answer one.', delay: 0 })
    await h.send(t, ASK)
    const first = h.reply(t)
    h.agent.feedback(first.id, '👍')
    expect(h.agent.outcomes.stats('chat').find((o) => o.model === HAIKU.id)).toMatchObject({ userGood: 1, userBad: 0 })
    h.agent.feedback(first.id, '👎')
    expect(h.agent.outcomes.stats('chat').find((o) => o.model === HAIKU.id)).toMatchObject({ userGood: 0, userBad: 1 })
    // The user's next message says the answer was wrong (it isn't a model verdict on the new request).
    const t2 = h.thread()
    llm.script.push({ content: JSON.stringify(answer()), delay: 0 }, { content: 'Answer two.', delay: 0 })
    await h.send(t2, 'Explain how the immune system remembers a virus')
    llm.script.push({ content: 'Sorry, here is the right version.', delay: 0 })
    await h.send(t2, "that's wrong")
    expect(h.agent.outcomes.stats('chat').find((o) => o.model === HAIKU.id)).toMatchObject({ userBad: 2 })
    // The next read's prompt carries it.
    llm.requests.length = 0
    llm.script.push({ content: JSON.stringify(answer()), delay: 0 }, { content: 'Answer three.', delay: 0 })
    await h.send(h.thread(), 'Explain how mRNA vaccines differ from older ones')
    const brainPrompt = String(llm.requests[0].messages[0].content)
    expect(brainPrompt).toContain('How models did on this Mac lately:')
    expect(brainPrompt).toMatch(/- claude-haiku-5-5: \d+\/\d+ done well \(\d+ checked; the user turned down 2\) on chat/)
  })

  test('every Auto answer carries its "Why this model" line: the read, the team, the cost', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness(ALL)
    const t = h.thread()
    llm.script.push(
      { content: JSON.stringify(answer({ category: 'coding', kind: 'agent', difficulty: 2, effort: 'high', model: OPUS.id, team: 'review', reviewer: ASTRA.id, needs: ['coding'], why: 'tricky pager bug' })), delay: 0 },
      { content: 'Draft: fixed it.', delay: 0 },
      { content: 'LGTM', delay: 0 },
      { content: 'Final: fixed it.', delay: 0 }
    )
    await h.send(t, 'Fix the off-by-one bug in the pager component')
    const routed = h.db.listMessages(t.id).find((m) => m.role === 'assistant' && m.meta?.routed)!.meta!.routed as { explain: string; label: string }
    expect(routed.label).toMatch(/^claude-opus-5-5 · coding$/)
    expect(routed.explain).toBe('Why this model: tricky pager bug (Auto\'s read by gpt-6-luna) · teamed up: gpt-6.2-astra reviews · cost: premium')
  })
})
