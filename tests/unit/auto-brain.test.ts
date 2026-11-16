import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import { Db } from '../../src/main/db'
import { acceptBrainModel, applyBrain, askBrain, BrainCache, brainModel, parseBrain, skipBrain, teamFor, type BrainAnswer } from '../../src/main/llm/auto-brain'
import { classifyTask } from '../../src/main/llm/task-classifier'
import { modelHealth } from '../../src/main/llm/model-health'
import type { ModelInfo, Settings, Thread } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Auto's brain: a cheap fast model reads the whole request and decides the task, effort, model and teamwork;
// the rules stay the fallback and the hard limits always apply.

const cloud = (id: string, tier: 0 | 1 | 2 | 3, input: number, output: number): ModelInfo => ({ id, provider: 'custom', providerName: 'Cloud', enabled: true, installed: true, label: id, vision: true, tools: true, tier, requiredGB: 0, maxFittingWindow: 131072, contextTokens: 1_000_000, fits: true, note: 'remote', price: { input, output } }) as ModelInfo
const LUNA = cloud('gpt-6-luna', 0, 0.1, 0.5)
const HAIKU = cloud('claude-haiku-5-5', 1, 0.1, 0.5)
const SONNET = cloud('claude-sonnet-5-5', 2, 2, 10)
const OPUS = cloud('claude-opus-5-5', 3, 4, 20)
const FABLE = cloud('claude-fable-5-2', 3, 8, 40)
const ASTRA = cloud('gpt-6-astra', 3, 10, 50)
const ALL = [LUNA, HAIKU, SONNET, OPUS, FABLE, ASTRA]

const answer = (p: Partial<BrainAnswer> = {}): BrainAnswer => ({ category: 'coding', kind: 'agent', difficulty: 3, effort: 'xhigh', study: false, image: false, model: OPUS.id, team: 'solo', needs: [], fanout: 0, why: '', ...p })

describe('the brain\'s decision', () => {
  test('the fastest cheap model reads the request', () => {
    expect(brainModel(ALL)?.id).toBe('gpt-6-luna')
    expect(brainModel([HAIKU, OPUS])?.id).toBe('claude-haiku-5-5')
    expect(brainModel([OPUS])).toBeUndefined()
  })

  test('only answers inside the schema, naming models it was offered, are used', () => {
    const ok = JSON.stringify({ category: 'math', kind: 'chat', difficulty: 1, effort: 'medium', study: true, image: false, model: 'claude-haiku-5-5', team: 'solo', why: 'quick homework check' })
    expect(parseBrain(`Here: ${ok}`, ALL)).toMatchObject({ category: 'math', model: 'claude-haiku-5-5', study: true })
    expect(parseBrain(ok.replace('claude-haiku-5-5', 'gpt-9-ultra'), ALL)).toBeUndefined()
    expect(parseBrain(ok.replace('"medium"', '"turbo"'), ALL)).toBeUndefined()
    expect(parseBrain('not json', ALL)).toBeUndefined()
  })

  test('its read replaces the rules\' within their floors', () => {
    const rules = classifyTask('Balance this chemical equation for my homework: H2 + O2 -> H2O')
    const d = applyBrain(rules, answer({ category: 'math', kind: 'chat', difficulty: 1, effort: 'medium', study: true, model: HAIKU.id }), 'GPT-6 Luna')
    expect(d).toMatchObject({ category: 'math', difficulty: 1, effort: 'medium', confident: true })
    expect(d.signals.study).toBe(true)
    expect(d.why).toMatch(/read by GPT-6 Luna/)
    // Coding is never light work; agent work never becomes a chat.
    const code = applyBrain(classifyTask('Fix the failing test in src/app.ts'), answer({ category: 'coding', kind: 'chat', difficulty: 0 }), 'Luna')
    expect(code.difficulty).toBe(2)
    expect(code.kind).toBe('agent')
  })

  test('the rules\' school signal, stakes and coding floor survive the brain\'s read', () => {
    const school = classifyTask('Help me study for my chem quiz on stoichiometry')
    expect(applyBrain(school, answer({ category: 'chat', kind: 'chat', difficulty: 1, study: false }), 'Luna').signals.study).toBe(true)
    const health = classifyTask('I found a new mole on my arm, should I be worried?')
    expect(applyBrain(health, answer({ category: 'chat', kind: 'chat', difficulty: 1, study: true }), 'Luna').signals.stakes).toBe(true)
    const code = classifyTask('Fix the failing test in src/app.ts')
    expect(code.category).toBe('coding')
    expect(applyBrain(code, answer({ category: 'chat', kind: 'chat', difficulty: 0 }), 'Luna').difficulty).toBe(2)
  })

  test('its model is used only within the hard limits', () => {
    const l = { allowed: ALL, tablePick: SONNET, preference: 'balanced' as const, difficulty: 2 as const, fableOn: false }
    expect(acceptBrainModel(OPUS.id, l)?.id).toBe(OPUS.id)
    // Not offered under the hard rules (no key, no images, too small a window…): ignored.
    expect(acceptBrainModel(OPUS.id, { ...l, allowed: [SONNET, LUNA] })).toBeUndefined()
    // Premium only with the Fable setting.
    expect(acceptBrainModel(FABLE.id, l)).toBeUndefined()
    expect(acceptBrainModel(FABLE.id, { ...l, fableOn: true })?.id).toBe(FABLE.id)
    // A light request never goes to a model costing over 4x the table's pick.
    expect(acceptBrainModel(ASTRA.id, { ...l, tablePick: LUNA, difficulty: 1 })).toBeUndefined()
    // Cheapest never pays more than the table's pick.
    expect(acceptBrainModel(OPUS.id, { ...l, preference: 'cheapest' })).toBeUndefined()
  })

  test('teams only for real agent work, never on a tight budget', () => {
    const l = { allowed: ALL, difficulty: 3 as const, kind: 'agent' as const, fableOn: false }
    expect(teamFor(answer({ team: 'plan+review', planner: FABLE.id, reviewer: ASTRA.id }), OPUS, l)).toEqual({ planner: FABLE, reviewer: ASTRA })
    expect(teamFor(answer({ team: 'plan', planner: FABLE.id }), OPUS, { ...l, difficulty: 2 })).toEqual({})
    expect(teamFor(answer({ team: 'plan', planner: LUNA.id }), OPUS, l)).toEqual({})
    expect(teamFor(answer({ team: 'review', reviewer: ASTRA.id }), OPUS, { ...l, budgetTight: true })).toEqual({})
    expect(teamFor(answer({ team: 'review', reviewer: OPUS.id }), OPUS, l)).toEqual({})
    expect(teamFor(answer({ team: 'plan', planner: FABLE.id }), OPUS, { ...l, kind: 'chat' })).toEqual({})
  })

  test('a slow or failing brain never holds the request up', async () => {
    const input = { text: 'Plan my week', history: [], attachments: [], images: 0, preference: 'balanced' as const, models: ALL, rules: classifyTask('Plan my week') }
    const slow = await askBrain({ messageId: 'a', input, model: LUNA.id, cache: new BrainCache(), timeoutMs: 50, ask: () => new Promise((r) => setTimeout(() => r('{}'), 500)) })
    expect(slow.answer).toBeUndefined()
    expect(slow.ms).toBeLessThan(400)
    const broken = await askBrain({ messageId: 'b', input, model: LUNA.id, cache: new BrainCache(), ask: async () => { throw new Error('down') } })
    expect(broken.answer).toBeUndefined()
    expect(skipBrain('thanks!', classifyTask('thanks!'), 0)).toBe(true)
    expect(skipBrain('Help me study for my chem quiz', classifyTask('Help me study for my chem quiz'), 0)).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------
// End to end: the real agent loop on the mock server.

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
    // Teams start without a cost card here (the card has its own tests).
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
  const run = async (t: Thread, text: string) => (await agent.send({ threadId: t.id, text } as never)).done
  return { db, agent, thread, run }
}

describe('the brain in the agent loop', () => {
  test('Auto local never sends the request or history to a cloud routing model', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const local = { ...LUNA, id: 'qwen3.8:27b', provider: 'ollama', providerName: 'Local', note: undefined, price: undefined, tier: 2 } as ModelInfo
    const h = harness([...ALL, local])
    const t = h.thread()
    h.db.updateThread(t.id, { model: 'auto:local' })
    llm.script.push({ content: 'Local answer.', delay: 0 })
    expect(await h.run(t, 'Explain this private project architecture and suggest improvements')).toBe('finished')
    expect(llm.requests.map((r) => r.model)).toEqual([local.id])
  })
  test('Luna reads the request, Fable plans, Opus does the work with the plan and the whole conversation', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness(ALL)
    const t = h.thread()
    llm.script.push(
      { content: JSON.stringify(answer({ team: 'plan', planner: FABLE.id, why: 'big multi-file refactor' })), delay: 0 },
      { content: 'Done means: the app uses plugins.\nSteps:\n1. Map the modules.\n2. Extract the plugin API.\nWatch out: keep the public API.', delay: 0 },
      { content: 'Refactor finished.', delay: 0 }
    )
    expect(await h.run(t, 'Refactor the whole app to a plugin architecture, end to end, with tests')).toBe('finished')
    expect(llm.requests.map((r) => r.model)).toEqual(['gpt-6-luna', 'claude-fable-5-2', 'claude-opus-5-5'])
    const exec = JSON.stringify(llm.requests[2].messages)
    expect(exec).toContain('Plan from claude-fable-5-2')
    expect(exec).toContain('Extract the plugin API')
    expect(exec).toContain('Refactor the whole app to a plugin architecture')
    expect(JSON.stringify(llm.requests[0].messages)).toContain('Refactor the whole app to a plugin architecture')
  })

  test('school work goes where the brain sends it, at the effort it chose', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness(ALL)
    const t = h.thread()
    llm.script.push(
      { content: JSON.stringify(answer({ category: 'math', kind: 'chat', difficulty: 1, effort: 'medium', study: true, model: HAIKU.id })), delay: 0 },
      { content: 'Divide by the molar mass.', delay: 0 }
    )
    await h.run(t, 'How do I turn grams into moles for my chem homework?')
    expect(llm.requests.map((r) => r.model)).toEqual(['gpt-6-luna', 'claude-haiku-5-5'])
  })

  test('a broken brain answer falls back to the rules', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness(ALL)
    llm.script.push({ content: 'I think you should use a big model!', delay: 0 }, { content: 'Hello.', delay: 0 })
    expect(await h.run(h.thread(), 'Explain how vaccines train the immune system')).toBe('finished')
    // The rules' pick answers (a chat explanation on Balanced: a mid model, not the brain's call twice).
    expect(llm.requests).toHaveLength(2)
    expect(ALL.map((m) => m.id)).toContain(llm.requests[1].model)
    expect(JSON.stringify(llm.requests[1].messages)).toContain('Explain how vaccines train the immune system')
  })

  test('a reviewer from another provider checks the draft before the user sees it', async () => {
    const h = harness(ALL)
    const t = h.thread()
    llm.script.push(
      { content: JSON.stringify(answer({ difficulty: 2, effort: 'high', team: 'review', reviewer: ASTRA.id })), delay: 0 },
      { content: 'Draft: changed nothing.', delay: 0 },
      { content: '- The draft claims a fix but no file was changed. Make the change.', delay: 0 },
      { content: 'Final: fixed it.', delay: 0 }
    )
    await h.run(t, 'Fix the off-by-one bug in the pager component')
    expect(llm.requests.map((r) => r.model).slice(0, 3)).toEqual(['gpt-6-luna', 'claude-opus-5-5', 'gpt-6-astra'])
    expect(JSON.stringify(llm.requests[3].messages)).toContain('A second model (gpt-6-astra) reviewed your draft')
  })
})

describe('fan-out', () => {
  test('a big job that splits gets parallel helpers on the model the brain chose', () => {
    const l = { allowed: ALL, difficulty: 3 as const, kind: 'agent' as const, fableOn: false }
    expect(teamFor(answer({ fanout: 5, helper: SONNET.id }), OPUS, l)).toEqual({ fanout: { n: 5, helper: SONNET } })
    // Never a premium or tiny model for helpers: the lead's own model then.
    expect(teamFor(answer({ fanout: 3, helper: FABLE.id }), OPUS, l)).toEqual({ fanout: { n: 3, helper: OPUS } })
    expect(teamFor(answer({ fanout: 3, helper: LUNA.id }), OPUS, l)).toEqual({ fanout: { n: 3, helper: OPUS } })
    expect(teamFor(answer({ fanout: 3, helper: SONNET.id }), OPUS, { ...l, budgetTight: true })).toEqual({})
    expect(parseBrain(JSON.stringify({ ...answer(), fanout: 40, helper: SONNET.id }), ALL)?.fanout).toBe(8)
  })

  test('in the loop: the lead is told to split the work across helpers', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness(ALL)
    const t = h.thread()
    llm.script.push(
      { content: JSON.stringify(answer({ fanout: 4, helper: SONNET.id, why: 'a whole game with several systems' })), delay: 0 },
      { content: 'Game built.', delay: 0 }
    )
    await h.run(t, 'Make me a complete Roblox tycoon game with a shop, saving, rounds and UI')
    expect(llm.requests[1].model).toBe('claude-opus-5-5')
    expect(JSON.stringify(llm.requests[1].messages)).toMatch(/send about 4 helpers in one agents call/)
  })
})

describe('reasoning together', () => {
  test('debate only for hard thinking, with two models to sit, never on a tight budget', () => {
    const l = { allowed: ALL, difficulty: 3 as const, kind: 'chat' as const, fableOn: false }
    expect(teamFor(answer({ team: 'debate' }), OPUS, l)).toEqual({ debate: true })
    expect(teamFor(answer({ team: 'debate' }), OPUS, { ...l, difficulty: 1 })).toEqual({})
    expect(teamFor(answer({ team: 'debate' }), OPUS, { ...l, allowed: [OPUS] })).toEqual({})
    expect(teamFor(answer({ team: 'debate' }), OPUS, { ...l, budgetTight: true })).toEqual({})
  })

  test('in the app: the brain asks for a debate and a Council of models reasons it out', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness(ALL)
    const t = h.thread()
    llm.script.push({ content: JSON.stringify(answer({ category: 'chat', kind: 'chat', difficulty: 3, effort: 'high', team: 'debate', why: 'a real trade-off' })), delay: 0 })
    const done = h.run(t, 'Should my startup build on Postgres or DynamoDB for the next 3 years? Think through the trade-offs.')
    // The council's members from two providers take part (this fixture can't script a whole council: stop it there).
    await expect.poll(() => new Set(llm.requests.slice(1).map((r) => r.model)).size, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
    h.agent.stop(t.id)
    await done
    expect(llm.requests[0].model).toBe('gpt-6-luna')
    expect(new Set(llm.requests.slice(1).map((r) => r.model))).toEqual(new Set(['gpt-6-astra', 'claude-opus-5-5']))
    expect(h.db.listMessages(t.id).some((m) => m.kind === 'notice' && /reasoning this out together/.test(m.content))).toBe(true)
    expect(llm.requests.filter((r) => JSON.stringify(r.messages).includes('You are Auto, the router')).length).toBe(1)
  }, 30_000)
})

describe('pairs at every level', () => {
  test('Luna with Haiku for light work, Opus with Astra for hard work; never small talk or a tight budget', () => {
    const l = { allowed: ALL, kind: 'chat' as const, fableOn: false }
    expect(teamFor(answer({ team: 'pair', partner: LUNA.id }), HAIKU, { ...l, difficulty: 1 })).toEqual({ partner: LUNA })
    expect(teamFor(answer({ team: 'pair', partner: ASTRA.id }), OPUS, { ...l, difficulty: 3 })).toEqual({ partner: ASTRA })
    expect(teamFor(answer({ team: 'pair', partner: LUNA.id }), OPUS, { ...l, difficulty: 3 })).toEqual({})
    expect(teamFor(answer({ team: 'pair', partner: LUNA.id }), HAIKU, { ...l, difficulty: 0 })).toEqual({})
    expect(teamFor(answer({ team: 'pair', partner: LUNA.id }), HAIKU, { ...l, difficulty: 1, budgetTight: true })).toEqual({})
    expect(teamFor(answer({ team: 'pair', partner: FABLE.id }), OPUS, { ...l, difficulty: 3 })).toEqual({})
  })

  test('needs steer the decision: seeing images is a hard rule, making images or using the screen is agent work', () => {
    const d = applyBrain(classifyTask('what do you think of this?'), answer({ category: 'vision', kind: 'chat', difficulty: 1, effort: 'medium', needs: ['see-images'] }), 'Luna')
    expect(d.needsVision).toBe(true)
    expect(applyBrain(classifyTask('a cozy cabin logo'), answer({ category: 'writing', kind: 'chat', difficulty: 1, needs: ['make-images'] }), 'Luna').kind).toBe('agent')
    expect(parseBrain(JSON.stringify({ ...answer(), needs: ['coding', 'telepathy'] }), ALL)?.needs).toEqual(['coding'])
  })

  test('in the loop: the partner\'s take reaches the main model, which writes the answer', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness(ALL)
    const t = h.thread()
    llm.script.push(
      { content: JSON.stringify(answer({ category: 'writing', kind: 'chat', difficulty: 1, effort: 'medium', model: HAIKU.id, team: 'pair', partner: LUNA.id, needs: ['ideas'] })), delay: 0 },
      { content: 'Names: Ember & Oak, Hearthside, The Rolling Pin.', delay: 0 },
      { content: 'Here are my favorites: Hearthside, Ember & Oak.', delay: 0 }
    )
    await h.run(t, 'Give me name ideas for a cozy neighborhood bakery')
    expect(llm.requests.map((r) => r.model)).toEqual(['gpt-6-luna', 'gpt-6-luna', 'claude-haiku-5-5'])
    expect(JSON.stringify(llm.requests[2].messages)).toContain('gpt-6-luna worked on this request with you')
    expect(JSON.stringify(llm.requests[2].messages)).toContain('Hearthside')
  })
})
