import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import type { ToolDef } from '../../src/main/agent/types'
import { Db } from '../../src/main/db'
import { retryPolicy } from '../../src/main/llm/client'
import { escalateEffort, supportedEffort } from '../../src/main/llm/auto-effort'
import { chosenWindow, providerMaxPrompt } from '../../src/main/llm/context-window'
import { classifyTask } from '../../src/main/llm/task-classifier'
import { classifyTask as classifyKind } from '../../src/main/agent/intent'
import { fallbackNotice, mayEscalateEffort, mayReplaceForInvalidCalls, unavailableReason } from '../../src/main/agent/choices'
import { fastTierFor } from '../../src/main/llm/fast-mode'
import { modelHealth } from '../../src/main/llm/model-health'
import { modeFlags } from '../../src/renderer/src/lib/swarm-view'
import { contextChoices, savedChoice, withChoice } from '../../src/shared/context-choices'
import type { Effort, EffortChoice, ModelInfo, Settings, Thread } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// "What the user selects is what happens": every manual choice reaches the request exactly, and the only
// changes the app makes are fallbacks when the chosen model can't be used, said in the chat.

process.env.FOREMAN_NO_AUTOTITLE = '1'
process.env.FOREMAN_NO_VERIFY = '1'

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
const savedRetry = { ...retryPolicy }
afterEach(() => { Object.assign(retryPolicy, savedRetry); llm.script.length = 0; llm.requests.length = 0; modelHealth.clear() })

const model = (id: string, tier: 0 | 1 | 2 | 3, fit = 131072): ModelInfo => ({ id, provider: 'custom', providerName: 'Custom', enabled: true, installed: true, label: id.toUpperCase(), vision: false, tools: true, tier, requiredGB: 1, maxFittingWindow: fit, fits: true }) as ModelInfo

/** The real Agent on the mock server; every model step's (model, window, effort) is recorded. */
function harness(models: ModelInfo[], o: { settings?: Partial<Settings>; tools?: ToolDef[] } = {}) {
  const db = new Db(':memory:')
  const settings = {
    contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'auto', advanced: { hardStopsEnabled: true },
    workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: models[0].id, hiddenModels: [], shownModels: [],
    cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [], ...o.settings
  } as unknown as Settings
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), ...(o.tools ?? []))
  const last = { ok: true, models, budgetGB: 32, totalGB: 64, providers: [] }
  const endpoints = { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => models, list: async () => last, advisor: () => undefined }
  const agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: endpoints as never, spaces: { getPrompt: () => '' } as never, memory: { block: () => '' } as never,
    emit: () => undefined, secretValues: () => [], fitWindow: (_m, w) => w,
    counter: () => ({ count: async (t: string) => estimate(t) })
  })
  const steps: Array<{ model: string; window: number; effort?: Effort }> = []
  const a = agent as unknown as { stream: (...args: unknown[]) => Promise<unknown> }
  const stream = a.stream.bind(agent)
  a.stream = (...args: unknown[]) => { steps.push({ model: args[1] as string, window: args[4] as number, effort: args[8] as Effort | undefined }); return stream(...args) }
  // SahilBot's own chats: a regular chat, where the composer's picks are used exactly. Bots choose by themselves.
  const space = db.createSpace('SahilBot', '#000000', { isMain: true })
  const bot = db.createSpace('Alpha', '#000000')
  const thread = (m: string | null = models[0].id, spaceId = space.id, mode: Thread['permissionMode'] = 'auto'): Thread => db.createThread(spaceId, mode, m)
  const run = async (t: Thread, text: string, flags?: Record<string, unknown>) => (await agent.send({ threadId: t.id, text, ...flags } as never)).done
  const notices = (t: Thread): string[] => db.listMessages(t.id).filter((m) => m.kind === 'notice').map((m) => m.content)
  return { db, agent, settings, space, bot, thread, run, steps, notices }
}
const call = (name: string, args: Record<string, unknown> = {}) => ({ name, arguments: JSON.stringify(args) })
const failing = (name: string): ToolDef => ({ name, label: name, group: 'Test', effect: 'read', description: 'A tool that fails', parameters: { type: 'object', properties: {} }, async run() { throw new Error('disk on fire') } }) as ToolDef

describe('model', () => {
  test('a model picked by name is used for every step, whatever the request looks like', async () => {
    const h = harness([model('model-a', 1), model('model-b', 2), model('model-c', 3)])
    llm.script.push({ content: 'done', delay: 0 }, { content: 'hi', delay: 0 })
    const t = h.thread('model-a')
    expect(await h.run(t, 'Refactor the whole codebase to a plugin architecture, end to end, production-ready')).toBe('finished')
    expect(await h.run(t, 'hi')).toBe('finished')
    expect(new Set(llm.requests.map((r) => r.model))).toEqual(new Set(['model-a']))
    expect(h.notices(t)).toEqual([])
  })

  test('a picked model is never swapped for making invalid tool calls (only Auto\'s picks are)', async () => {
    const h = harness([model('model-a', 1), model('model-b', 3)])
    llm.script.push(
      { toolCalls: [call('no_such_tool')], delay: 0 }, { toolCalls: [call('no_such_tool')], delay: 0 },
      { toolCalls: [call('no_such_tool')], delay: 0 }, { toolCalls: [call('no_such_tool')], delay: 0 }, { content: 'ok', delay: 0 }
    )
    const t = h.thread('model-a')
    await h.run(t, 'do the thing')
    expect(new Set(llm.requests.map((r) => r.model))).toEqual(new Set(['model-a']))
    expect(h.notices(t).some((n) => /Switched to/.test(n))).toBe(false)
    expect(mayReplaceForInvalidCalls({ manual: true, local: true })).toBe(false)
    expect(mayReplaceForInvalidCalls({ manual: false, local: true })).toBe(true)
  })

  test('only when the chosen model errors does another answer, and the chat says which and why', async () => {
    const h = harness([model('model-a', 1), model('model-b', 2)])
    llm.script.push({ status: 400 }, { content: 'From B.', delay: 0 })
    const t = h.thread('model-a')
    expect(await h.run(t, 'hello')).toBe('finished')
    expect(llm.requests.map((r) => r.model)).toEqual(['model-a', 'model-b'])
    expect(h.notices(t)[0]).toMatch(/^MODEL-A failed: .*; used MODEL-B for the rest of this task\.$/)
  })

  test('out of credit (402): never retried, the next model answers with one note, and later Auto requests skip it', async () => {
    const h = harness([model('model-a', 1), { ...model('model-b', 2), provider: 'ollama' } as ModelInfo])
    llm.script.push({ status: 402 }, { content: 'From B.', delay: 0 }, { content: 'Still B.', delay: 0 })
    const t = h.thread('auto')
    expect(await h.run(t, 'hello')).toBe('finished')
    expect(await h.run(t, 'hello again')).toBe('finished')
    expect(llm.requests.map((r) => r.model)).toEqual(['model-a', 'model-b', 'model-b'])
    expect(h.notices(t)).toEqual(['MODEL-A is unavailable (out of API credit); used MODEL-B for the rest of this task.'])
  })

  test('a model picked by name that fails is said so every time, and still tried first (what you pick is what happens)', async () => {
    const h = harness([model('model-a', 1), { ...model('model-b', 2), provider: 'ollama' } as ModelInfo])
    llm.script.push({ status: 402 }, { content: 'From B.', delay: 0 }, { status: 402 }, { content: 'B again.', delay: 0 })
    const t = h.thread('model-a')
    expect(await h.run(t, 'hello')).toBe('finished')
    expect(await h.run(t, 'hello again')).toBe('finished')
    expect(llm.requests.map((r) => r.model)).toEqual(['model-a', 'model-b', 'model-a', 'model-b'])
    expect(h.notices(t).filter((n) => /^MODEL-A is unavailable \(out of API credit\); used MODEL-B/.test(n))).toHaveLength(2)
  })

  test('the notice names the reason in words', () => {
    expect(fallbackNotice('Claude Opus 5.5', 'Claude Sonnet 5.5', new Error('429 Too Many Requests'))).toBe('Claude Opus 5.5 is unavailable (rate limited); used Claude Sonnet 5.5 for this reply.')
    expect(fallbackNotice('Claude Opus 5.5', 'Claude Sonnet 5.5', new Error('529 overloaded_error'), { rest: true })).toBe('Claude Opus 5.5 is unavailable (overloaded); used Claude Sonnet 5.5 for the rest of this task.')
    expect(unavailableReason('401 invalid x-api-key')).toBe('its API key was refused')
    expect(unavailableReason('404 model_not_found')).toBe('not available on this account')
    expect(unavailableReason('Over the cloud budget for this month')).toBe('over the monthly spending limit')
    expect(unavailableReason(new Error('fetch failed'))).toBe('not responding')
  })

  test('a bot chooses by itself: its chats always route as Auto, whatever an older install stored or the chat picked', async () => {
    const h = harness([model('model-a', 1), model('model-b', 2), model('model-c', 3)])
    // Values an older install could have stored on the bot and on its chat.
    const bot = h.db.updateSpace(h.bot.id, { model: 'model-a', effort: 'low' })
    llm.script.push({ content: 'one', delay: 0 }, { content: 'two', delay: 0 })
    await h.run(h.thread(null, bot.id), 'Refactor the whole codebase, end to end, with tests')
    const t = h.thread('model-a', bot.id)
    h.db.updateThread(t.id, { effort: 'low' })
    await h.run(t, 'Refactor the whole codebase, end to end, with tests')
    // Auto routes a hard coding task up (not the stored model-a), at Auto's own level (not the stored Low).
    expect(llm.requests.map((r) => r.model).every((m) => m !== 'model-a')).toBe(true)
    expect(h.steps.every((s) => s.effort !== 'low')).toBe(true)
  })

  test('regular chats keep the pick exactly (the stored bot values never leak into SahilBot\'s own chats)', async () => {
    const h = harness([model('model-a', 1), model('model-b', 2)])
    h.db.updateSpace(h.space.id, { model: 'model-b' })
    llm.script.push({ content: 'one', delay: 0 }, { content: 'two', delay: 0 })
    await h.run(h.thread('model-a'), 'hi')
    await h.run(h.thread(null), 'hi')
    // The chat's pick, then the app default (model-a): the space's old override is ignored.
    expect(llm.requests.map((r) => r.model)).toEqual(['model-a', 'model-a'])
  })
})

describe('effort', () => {
  test('a level picked for the chat is sent exactly on every step: hard requests, small talk, failures', async () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const h = harness([model('model-a', 2)], { tools: [failing('flaky')] })
      llm.script.push({ toolCalls: [call('flaky')], delay: 0 }, { toolCalls: [call('flaky')], delay: 0 }, { toolCalls: [call('flaky')], delay: 0 }, { content: 'ok', delay: 0 })
      const t = h.thread('model-a')
      h.db.updateThread(t.id, { effort: level })
      await h.run(t, 'Prove the Riemann hypothesis, thoroughly, step by step')
      expect(new Set(h.steps.map((s) => s.effort)), level).toEqual(new Set([level]))
      expect(h.notices(t).some((n) => /Thinking raised/.test(n))).toBe(false)
      llm.script.length = 0; llm.requests.length = 0
    }
  })

  test('a regular chat uses its own level, else the app default; a bot always thinks on Auto', async () => {
    const h = harness([model('model-a', 2)], { settings: { thinking: 'medium' } })
    llm.script.push({ content: 'a', delay: 0 })
    const t = h.thread('model-a')
    h.db.updateThread(t.id, { effort: 'xhigh' })
    await h.run(t, 'hi')
    expect(h.steps.map((s) => s.effort)).toEqual(['xhigh'])
    llm.script.push({ content: 'b', delay: 0 })
    await h.run(h.thread('model-a'), 'Refactor the whole codebase, end to end')
    expect(h.steps.at(-1)?.effort).toBe('medium')
    // The bot: a stored level and the app's Medium are both ignored; Auto decides (a refactor is at least High).
    h.db.updateSpace(h.bot.id, { effort: 'low' })
    llm.script.push({ content: 'c', delay: 0 })
    await h.run(h.thread('model-a', h.bot.id), 'Refactor the whole codebase, end to end')
    expect(['high', 'xhigh', 'max']).toContain(h.steps.at(-1)?.effort)
  })

  test('Auto follows the request, and rises once (with a note) when the run keeps failing', async () => {
    const h = harness([model('model-a', 2)], { tools: [failing('flaky')] })
    llm.script.push({ content: 'hey!', delay: 0 })
    const t = h.thread('model-a')
    await h.run(t, 'hi')
    expect(h.steps.at(-1)?.effort).toBe('low')
    h.steps.length = 0
    llm.script.push({ toolCalls: [call('flaky')], delay: 0 }, { toolCalls: [call('flaky')], delay: 0 }, { toolCalls: [call('flaky')], delay: 0 }, { toolCalls: [call('flaky')], delay: 0 }, { content: 'ok', delay: 0 })
    await h.run(t, 'Fix the TypeError in src/app.ts where user is undefined')
    expect(h.steps[0].effort).toBe('high')
    expect(h.steps.at(-1)?.effort).toBe('xhigh')
    const raised = h.notices(t).filter((n) => /^Thinking raised to Extra for the rest of this task: \d+ steps failed\.$/.test(n))
    expect(raised).toHaveLength(1)
  })

  test('escalation: once, only on Auto, up to Extra, within what the model accepts', () => {
    expect(escalateEffort({ choice: 'auto', current: 'high', bumped: false, failures: 3, planSteps: 0 })?.level).toBe('xhigh')
    expect(escalateEffort({ choice: 'auto', current: 'medium', bumped: false, failures: 0, planSteps: 9 })?.note).toMatch(/the plan grew to 9 steps/)
    expect(escalateEffort({ choice: 'auto', current: 'high', bumped: true, failures: 9, planSteps: 0 })).toBeUndefined()
    expect(escalateEffort({ choice: 'high', current: 'high', bumped: false, failures: 9, planSteps: 20 })).toBeUndefined()
    expect(escalateEffort({ choice: 'auto', current: 'xhigh', bumped: false, failures: 9, planSteps: 0 })).toBeUndefined()
    expect(escalateEffort({ choice: 'auto', current: 'high', bumped: false, failures: 1, planSteps: 8 })).toBeUndefined()
    // Sonnet 4.6 takes no Extra: High → Extra changes nothing there, so nothing happens and nothing is said.
    expect(escalateEffort({ choice: 'auto', current: 'high', bumped: false, failures: 3, planSteps: 0, model: 'claude-sonnet-4-6' })).toBeUndefined()
    expect(escalateEffort({ choice: 'auto', current: 'high', bumped: false, failures: 3, planSteps: 0, model: 'claude-opus-5-5' })?.level).toBe('xhigh')
    expect(supportedEffort('claude-sonnet-4-6', 'xhigh')).toBe('high')
    expect(supportedEffort('gpt-5.5', 'max')).toBe('xhigh')
    expect(supportedEffort('qwen3.8:27b', 'high')).toBeUndefined()
    for (const c of ['low', 'medium', 'high', 'xhigh', 'max'] as EffortChoice[]) expect(mayEscalateEffort(c)).toBe(false)
    expect(mayEscalateEffort('auto')).toBe(true)
  })
})

describe('context window', () => {
  test('a local model\'s chosen window is used exactly (within what fits this Mac), ignoring the global setting', async () => {
    const h = harness([model('model-a', 2, 65536)], { settings: { modelContext: { 'model-a': 16384 } } })
    llm.script.push({ content: 'ok', delay: 0 })
    await h.run(h.thread('model-a'), 'hi')
    expect(h.steps.map((s) => s.window)).toEqual([16384])
    const big = harness([model('model-a', 2, 65536)], { settings: { modelContext: { 'model-a': 131072 } } })
    llm.script.push({ content: 'ok', delay: 0 })
    await big.run(big.thread('model-a'), 'hi')
    // 128K was picked but only 64K fits this Mac with this model: clamped to what fits, never more.
    expect(big.steps.map((s) => s.window)).toEqual([65536])
  })

  test('Default follows the strategy; a cloud pick is exact up to the provider maximum', () => {
    expect(chosenWindow({}, 'claude-opus-5-5')).toBeUndefined()
    expect(chosenWindow({ modelContext: { 'claude-opus-5-5': 256_000 } }, 'claude-opus-5-5')).toBe(256_000)
    expect(chosenWindow({ modelContext: { 'claude-opus-5-5': 1_000_000 } }, 'claude-opus-5-5')).toBe(providerMaxPrompt('claude-opus-5-5'))
    expect(providerMaxPrompt('claude-opus-5-5')).toBe(936_000)
    expect(chosenWindow({ modelContext: { 'gpt-6.1-sol': 1_000_000 } }, 'gpt-6.1-sol')).toBe(922_000)
    expect(chosenWindow({ modelContext: { 'gpt-5.4-mini': 400_000 } }, 'gpt-5.4-mini')).toBe(272_000)
    expect(chosenWindow({ modelContext: { 'grok-4.7': 500_000 } }, 'grok-4.7')).toBe(providerMaxPrompt('grok-4.7'))
    expect(chosenWindow({ modelContext: { 'x': -5 } }, 'x')).toBeUndefined()
  })

  test('the Models page offers only what the provider offers, Default first', () => {
    const tok = (m: Partial<ModelInfo>) => contextChoices({ id: 'm', provider: 'anthropic', note: 'remote', maxFittingWindow: 0, ...m } as ModelInfo).map((c) => c.tokens)
    expect(tok({ contextTokens: 1_000_000 })).toEqual([0, 128_000, 256_000, 512_000, 1_000_000])
    expect(tok({ contextTokens: 200_000 })).toEqual([0, 128_000, 200_000])
    expect(tok({ provider: 'xai', contextTokens: 500_000 })).toEqual([0, 128_000, 256_000, 500_000])
    const gpt = contextChoices({ id: 'gpt-6.1-sol', provider: 'openai', note: 'remote', contextTokens: 1_050_000, maxFittingWindow: 0 } as ModelInfo)
    expect(gpt.map((c) => c.label)).toEqual(['Default (follow strategy)', '128K', '256K', '512K', '1.05M (full window)'])
    expect(gpt.filter((c) => c.note === 'higher price tier').map((c) => c.tokens)).toEqual([512_000, 1_050_000])
    const mini = contextChoices({ id: 'gpt-5.4-mini', provider: 'openai', note: 'remote', contextTokens: 400_000, maxFittingWindow: 0 } as ModelInfo)
    expect(mini.map((c) => c.tokens)).toEqual([0, 128_000, 256_000, 400_000])
    expect(mini.some((c) => c.note)).toBe(false)
    const local = contextChoices({ id: 'qwen', provider: 'ollama', contextTokens: undefined, maxFittingWindow: 32768 } as ModelInfo)
    expect(local.map((c) => c.label)).toEqual(['Default (follow strategy)', '16K', '32K (most that fits this Mac)'])
    expect(contextChoices({ id: 'x', provider: 'openrouter', note: 'remote', maxFittingWindow: 0 } as ModelInfo)).toHaveLength(1)
    expect(withChoice({ a: 1 }, 'b', 128_000)).toEqual({ a: 1, b: 128_000 })
    expect(withChoice({ a: 1, b: 2 }, 'b', 0)).toEqual({ a: 1 })
    expect(savedChoice({ b: 0 }, 'b')).toBe(0)
  })
})

describe('mode toggles, permission mode, fast mode', () => {
  test('Plan first, Team, Heavy, Council and Deep Research reach the request as chosen, and always run the full agent', () => {
    expect(modeFlags({ planFirst: true })).toEqual({ team: false, deepResearch: false, planFirst: true })
    expect(modeFlags({ team: true })).toEqual({ team: true, deepResearch: false, planFirst: false })
    expect(modeFlags({ deep: true })).toEqual({ team: true, deepResearch: true, planFirst: false })
    expect(modeFlags({ heavy: true })).toMatchObject({ heavy: true })
    expect(modeFlags({ council: true })).toMatchObject({ council: true })
    for (const flag of ['planFirst', 'team', 'deepResearch', 'heavy', 'council']) {
      expect(classifyKind('hi', { flags: { [flag]: true } }).kind, flag).toBe('agent')
      expect(classifyTask('hi', { [flag]: true }).kind, flag).toBe('agent')
    }
    expect(classifyTask('hi', { heavy: true }).effort).toBe('max')
    expect(classifyTask('Should we raise prices?', { council: true }).effort).toBe('xhigh')
  })

  test('Plan first loads the plan tool and its note on the run', async () => {
    const h = harness([model('model-a', 2)])
    llm.script.push({ content: 'Here is my plan.', delay: 0 })
    await h.run(h.thread('model-a'), 'Reorganize the docs folder', { planFirst: true })
    const names = (llm.requests[0].tools ?? []).map((x: { function: { name: string } }) => x.function.name)
    // The full agent (its plan tool list), never the lean chat path.
    expect(names).toContain('todo')
    expect(JSON.stringify(llm.requests[0].messages)).toContain('Plan first is on')
  })

  test('the chat\'s permission mode is left as chosen by a run', async () => {
    for (const mode of ['ask', 'auto', 'autonomous'] as const) {
      const h = harness([model('model-a', 2)])
      llm.script.push({ content: 'ok', delay: 0 })
      const t = h.thread('model-a', undefined, mode)
      await h.run(t, 'hi')
      expect(h.db.getThread(t.id)?.permissionMode).toBe(mode)
      llm.script.length = 0
    }
  })

  test('fast mode: a per-model choice is honored exactly; Auto\'s own rule applies only to Auto\'s picks', () => {
    const on = { fastMode: { providers: { anthropic: false, openai: false, xai: false }, models: { 'claude-opus-5-5': 'on' }, auto: 'speed' } } as unknown as Settings
    const off = { fastMode: { providers: { anthropic: true, openai: false, xai: false }, models: { 'claude-opus-5-5': 'off' }, auto: 'allowed' } } as unknown as Settings
    expect(fastTierFor('claude-opus-5-5', on)).toBe('fast')
    expect(fastTierFor('claude-opus-5-5', on, { auto: false, speedSensitive: false })).toBe('fast')
    expect(fastTierFor('claude-opus-5-5', off, { auto: true, speedSensitive: true })).toBeUndefined()
    expect(fastTierFor('claude-opus-5-5', on, { auto: true, speedSensitive: false })).toBeUndefined()
  })
})
