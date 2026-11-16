import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import { agentsTool, swarmTool } from '../../src/main/agent/tools/agents'
import { maxTool } from '../../src/main/agent/tools/max'
import { fitHeavy, heavyCap, heavyPlan } from '../../src/main/agent/heavy'
import { heavyConfig, swarmConfig } from '../../src/main/agent/swarm/config'
import { heavyMix, judgeModelFor } from '../../src/main/agent/swarm/capacity'
import { botMaxConfig, migrateBotMax } from '../../src/main/agent/swarm/bot-config'
import { applySwarmState, crossProviderFor } from '../../src/main/agent/swarm/hosts'
import { teamModels } from '../../src/main/agent/swarm/models'
import { maxBudget } from '../../src/main/agent/max/host'
import { maxDecision, maxNote } from '../../src/main/agent/max/decide'
import { planMax } from '../../src/main/agent/max/planner'
import { attemptCredits, maxSessionFor, openMaxSessions } from '../../src/main/agent/max/session'
import { botModel, isBotSpace, requestedEffort, requestedModel } from '../../src/main/agent/choices'
import { migrateBotModelEffort } from '../../src/main/spaces'
import { Db } from '../../src/main/db'
import { retryPolicy } from '../../src/main/llm/client'
import { maxOf, maxTeamCalls, maxTotals, modeFlags } from '../../src/renderer/src/lib/swarm-view'
import type { ChatEvent, MaxBoard, ModelInfo, Settings, Space, Thread } from '../../src/shared/types'
import type { ThreadState } from '../../src/main/agent/types'
import { startMockLlm, type MockLlm, type ScriptedReply } from '../fixtures/mock-llm'

// Max: one mode for many agents. The planner's pick reaches the run, one card shows it, the caps, budgets and
// provider rules hold, the older tool names still work, and bots always choose their own model and thinking.

process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'
// These runs script every model reply; Auto's brain (llm/auto-brain.ts) has its own tests.
process.env.FOREMAN_NO_BRAIN = '1'

const local = (id: string, tier: 0 | 1 | 2 | 3, extra: Partial<ModelInfo> = {}): ModelInfo =>
  ({ id, provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: id.toUpperCase(), vision: false, tier, requiredGB: 1, maxFittingWindow: 131072, fits: true, ...extra }) as ModelInfo
const cloud = (id: string, tier: 0 | 1 | 2 | 3, extra: Partial<ModelInfo> = {}): ModelInfo =>
  local(id, tier, { provider: 'anthropic', providerName: 'Anthropic', note: 'remote', ...extra })
const SONNET = cloud('claude-sonnet-5-5', 2, { rank: 5 })
const OPUS = cloud('claude-opus-5-5', 3, { rank: 8 })
const HAIKU = cloud('claude-haiku-5-5', 1, { rank: 3 })
const GPT = cloud('gpt-6.1-sol', 3, { provider: 'openai', providerName: 'OpenAI', rank: 9 })

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
const savedRetry = { ...retryPolicy }
afterEach(() => { Object.assign(retryPolicy, savedRetry); llm.script.length = 0; llm.requests.length = 0 })

function harness(models: ModelInfo[], extra: Partial<Settings> = {}) {
  const db = new Db(':memory:')
  const settings = {
    contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'auto', advanced: { hardStopsEnabled: true },
    workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: models[0].id, hiddenModels: [], shownModels: [],
    cloud: { enabled: true, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [], ...extra
  } as unknown as Settings
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), maxTool(), agentsTool(), swarmTool())
  const events: ChatEvent[] = []
  const last = { ok: true, models, budgetGB: 32, totalGB: 64, providers: [] }
  const endpoints = { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => models, list: async () => last, advisor: () => undefined }
  const agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: endpoints as never, spaces: { getPrompt: () => '' } as never, memory: { block: () => '' } as never,
    emit: (e) => events.push(e), secretValues: () => [], fitWindow: (_m, w) => w, counter: () => ({ count: async (t: string) => estimate(t) })
  })
  const bot = db.createSpace('Ideas Bot', '#000000')
  const main = db.createSpace('SahilBot', '#000000', { isMain: true })
  const thread = (spaceId = main.id, m: string | null = null): Thread => db.createThread(spaceId, 'auto', m)
  const card = (t: Thread): MaxBoard | undefined => db.listMessages(t.id).map((m) => maxOf(m)).find(Boolean)
  return { db, agent, events, settings, bot, main, thread, card, registry }
}

type Req = Record<string, any>
const sysOf = (r: Req): string => String(r.messages?.[0]?.content ?? '')
const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? '').join(' ') : '')
const lastUser = (r: Req): string => textOf([...r.messages].reverse().find((m: { role: string }) => m.role === 'user')?.content)
const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: JSON.stringify(args) })
const route = (fn: (r: Req) => ScriptedReply): void => { for (let i = 0; i < 300; i++) llm.script.push(fn) }
const isSwarmHelper = (r: Req): boolean => sysOf(r).includes('# You are a temporary swarm helper')
const isHelper = (r: Req): boolean => sysOf(r).includes('# You are a helper agent')
const toolsOf = (r: Req): string[] => (r.tools ?? []).map((t: { function?: { name: string }; name?: string }) => t.function?.name ?? t.name)

/** Mock replies for judged attempts: attempts answer, the judge compares, the final cites [A#]. */
const heavyReplies = (r: Req): ScriptedReply | undefined => {
  if (sysOf(r).includes('[HEAVY-JUDGE]')) return { content: JSON.stringify({ agreements: ['x'], disagreements: [], errors: [], unsupported: [], recheck: null, summary: 'A1 is strongest.' }), delay: 0 }
  if (lastUser(r).includes('[HEAVY-FINAL]')) return { content: 'JUDGED: the best answer [A1][A2].', delay: 0 }
  const n = Number(sysOf(r).match(/Heavy attempt (\d+) of/)?.[1])
  if (n) return { content: `Attempt ${n}: an answer.\n\nEvidence: worked it out.`, delay: 0 }
  return undefined
}

describe('Max through the agent', () => {
  test('a brainstorm picks the idea swarm: one Max card, the swarm inside it, credits, the lead told to use max', async () => {
    const h = harness([SONNET, HAIKU, OPUS], { swarm: { askAboveUsd: 100 } } as never)
    let lead = 0
    route((r) => {
      if (isSwarmHelper(r)) {
        const n = Number(/helper H(\d+) of/.exec(lastUser(r))?.[1] ?? 0)
        return { content: `1. **Idea ${n}a**: x. Why: y. Risk: z.\n2. **Idea ${n}b**: more.\nBest bet: the first.`, delay: 0 }
      }
      lead++
      return lead === 1 ? { toolCalls: [call('max', { strategy: 'swarm', goal: 'Ways to grow a bakery', pattern: 'ideate', helpers: 6 })], delay: 0 } : { content: 'Top picks: the club [H1, H4] and the stall [H6].', delay: 0 }
    })
    const t = h.thread(h.bot.id)
    expect(await (await h.agent.send({ threadId: t.id, text: 'Brainstorm ways to grow my bakery', max: true })).done).toBe('finished')
    const opener = h.db.listMessages(t.id).find((m) => m.role === 'user')!
    expect(opener.meta?.max).toMatchObject({ strategy: 'swarm', phases: ['swarm'], source: 'composer' })
    expect(String(opener.meta?.note)).toContain('[Max is on for this request: idea swarm')
    // The lead lists max (not the older agents / swarm names).
    const leadReq = llm.requests.find((r) => !isSwarmHelper(r))!
    expect(toolsOf(leadReq)).toContain('max')
    expect(toolsOf(leadReq)).not.toContain('agents')
    expect(toolsOf(leadReq)).not.toContain('swarm')
    expect(llm.requests.filter(isSwarmHelper)).toHaveLength(6)
    // One card: no separate swarm card; the swarm and the result with credits are on the Max card.
    const notices = h.db.listMessages(t.id).filter((m) => m.kind === 'notice')
    expect(notices.filter((m) => m.meta?.swarm)).toHaveLength(0)
    const card = h.card(t)!
    expect(card.title).toBe('idea swarm')
    expect(card.status).toBe('done')
    expect(card.phases).toEqual([expect.objectContaining({ kind: 'swarm', status: 'done' })])
    expect(card.swarm?.helpers.filter((x) => x.status === 'done')).toHaveLength(6)
    expect(card.result?.credits).toEqual([{ tag: 'H1', count: 1 }, { tag: 'H4', count: 1 }, { tag: 'H6', count: 1 }])
    expect(openMaxSessions()).toBe(0)
  })

  test('a hard single-answer request picks judged attempts: attempts and the judge on the card, the final streams in', async () => {
    const h = harness([SONNET, OPUS], { swarm: { askAboveUsd: 100 }, heavy: { attempts: 3, mix: 'auto' } } as never)
    route((r) => heavyReplies(r) ?? { content: 'unexpected', delay: 0 })
    const t = h.thread(h.main.id, 'claude-sonnet-5-5')
    expect(await (await h.agent.send({ threadId: t.id, text: 'Prove that the square root of 2 is irrational', max: true })).done).toBe('finished')
    const card = h.card(t)!
    expect(card.strategy).toBe('heavy')
    expect(card.title).toBe('competing attempts + judge')
    expect(card.heavy?.attempts).toHaveLength(3)
    expect(card.heavy?.judge.status).toBe('done')
    expect(card.result?.credits).toEqual([{ tag: 'A1', count: 1 }, { tag: 'A2', count: 1 }])
    // No separate Heavy card; the judged answer is the last message.
    expect(h.db.listMessages(t.id).filter((m) => m.kind === 'notice' && m.meta?.heavy)).toHaveLength(0)
    expect([...h.db.listMessages(t.id)].reverse().find((m) => m.role === 'assistant' && m.kind === 'normal')?.content).toContain('JUDGED')
  })

  test('a hybrid: the lead\'s swarm first (its brief kept on the card), then judged attempts write the final from it', async () => {
    const h = harness([SONNET, HAIKU, OPUS], { swarm: { askAboveUsd: 100 }, heavy: { attempts: 2, mix: 'same' } } as never)
    let lead = 0
    route((r) => {
      const hv = heavyReplies(r)
      if (hv) return hv
      if (isSwarmHelper(r)) return { content: `1. **Name ${/helper H(\d+)/.exec(lastUser(r))?.[1]}**: short.\nBest bet: it.`, delay: 0 }
      lead++
      return lead === 1 ? { toolCalls: [call('max', { strategy: 'swarm', goal: 'Podcast names', pattern: 'ideate', helpers: 4 })], delay: 0 } : { content: 'BRIEF: shortlist Name 1 [H1], Name 3 [H3].', delay: 0 }
    })
    const t = h.thread(h.bot.id)
    expect(await (await h.agent.send({ threadId: t.id, text: 'Brainstorm names for my podcast, then pick the best one', max: true })).done).toBe('finished')
    const card = h.card(t)!
    expect(card.strategy).toBe('hybrid')
    expect(card.title).toBe('idea swarm → judged final draft')
    expect(card.phases.map((p) => [p.kind, p.status])).toEqual([['swarm', 'done'], ['heavy', 'done']])
    expect(card.brief).toContain('BRIEF: shortlist')
    // The attempts got the brief, not the lead's phase-1 instructions.
    const attempt = llm.requests.find((r) => /Heavy attempt 1 of 2/.test(sysOf(r)))!
    expect(lastUser(attempt)).toContain('BRIEF: shortlist')
    expect(lastUser(attempt)).not.toContain('[Max is on for this request')
    // The brief message is marked (shown inside the card); the judged answer is last.
    const ms = h.db.listMessages(t.id)
    expect(ms.find((m) => m.content.startsWith('BRIEF'))?.meta?.maxBrief).toBe(card.maxId)
    expect([...ms].reverse().find((m) => m.role === 'assistant' && m.kind === 'normal')?.content).toContain('JUDGED')
    // The swarm's credits came from the brief.
    expect(card.swarm?.compiled?.credits).toEqual([{ n: 1, count: 1 }, { n: 3, count: 1 }])
  })

  test('Auto teams up by itself for a big report in a regular chat: sized, mixed providers, the card says why', async () => {
    const TERRA = cloud('gpt-6.1-terra', 2, { provider: 'openai', providerName: 'OpenAI', rank: 6 })
    const LUNA = cloud('gpt-6-luna', 1, { provider: 'openai', providerName: 'OpenAI', rank: 4 })
    const h = harness([SONNET, OPUS, HAIKU, GPT, TERRA, LUNA], { swarm: { askAboveUsd: 100 } } as never)
    const project = h.db.createSpace('Lab market', '#000000', { kind: 'project' })
    let lead = 0
    route((r) => {
      if (isHelper(r)) return { content: `REPORT ${lastUser(r).slice(-12)}`, delay: 0 }
      lead++
      return lead === 1 ? { toolCalls: [call('max', { strategy: 'team', tasks: Array.from({ length: 6 }, (_, i) => ({ title: `Part ${i}`, task: `Research part ${i} with sources` })) })], delay: 0 } : { content: 'The report, compiled.', delay: 0 }
    })
    const t = h.thread(project.id, 'auto')
    const big = 'Write a comprehensive market research report on the US at-home lab testing market with competitors and pricing'
    expect(await (await h.agent.send({ threadId: t.id, text: big })).done).toBe('finished')
    const opener = h.db.listMessages(t.id).find((m) => m.role === 'user')!
    expect(opener.meta?.max).toMatchObject({ strategy: 'team', source: 'auto', helpers: 6 })
    expect(String(opener.meta?.note)).toMatch(/Auto teamed up: market research → research team of 6[^]*at least 6/)
    const card = h.card(t)!
    expect(card).toMatchObject({ source: 'auto', why: 'market research → research team of 6', status: 'done' })
    const members = card.teams?.[0].members ?? []
    expect(members.filter((m) => m.status === 'done')).toHaveLength(6)
    // Claude and GPT side by side (the chat's model is Auto, and Auto started the team).
    expect(new Set(members.map((m) => (m.model ?? '').startsWith('gpt') ? 'openai' : 'anthropic')).size).toBe(2)
    // A small request in the same chat: no card, no hint.
    llm.script.length = 0
    route(() => ({ content: 'Sure.', delay: 0 }))
    const t2 = h.thread(project.id, 'auto')
    expect(await (await h.agent.send({ threadId: t2.id, text: 'write a quick email to Bob saying I\'ll be late' })).done).toBe('finished')
    const o2 = h.db.listMessages(t2.id).find((m) => m.role === 'user')!
    expect(o2.meta?.max).toBeUndefined()
    expect(o2.meta?.maxHint).toBeUndefined()
  })

  test('team helpers stay on one provider unless the run may mix', () => {
    const LUNA = cloud('gpt-6-luna', 1, { provider: 'openai', providerName: 'OpenAI', rank: 4 })
    const usable = [SONNET, HAIKU, GPT, LUNA]
    expect(teamModels('claude-haiku-5-5', usable, 4, false)).toEqual(Array(4).fill('claude-haiku-5-5'))
    expect(teamModels('claude-haiku-5-5', usable, 4, true)).toEqual(['claude-haiku-5-5', 'gpt-6-luna', 'claude-haiku-5-5', 'gpt-6-luna'])
    // No peer at the same tier: everyone on the helper model.
    expect(teamModels('claude-sonnet-5-5', usable, 3, true)).toEqual(Array(3).fill('claude-sonnet-5-5'))
    expect(crossProviderFor({ kind: 'project', isMain: false } as Space)).toBe(false)
    expect(crossProviderFor({ kind: 'project', isMain: false } as Space, { autoMax: true })).toBe(true)
  })

  test('old tool names still work: a team through agents, and swarm, land on the Max card', async () => {
    const h = harness([local('qwen-test', 2)])
    let lead = 0
    route((r) => {
      if (isHelper(r)) return { content: `REPORT ${lastUser(r).slice(-12)}`, delay: 0 }
      lead++
      return lead === 1 ? { toolCalls: [call('agents', { tasks: Array.from({ length: 10 }, (_, i) => ({ title: `City ${i}`, task: `Population of city ${i}` })) })], delay: 0 } : { content: 'Compiled from the team.', delay: 0 }
    })
    const t = h.thread()
    expect(await (await h.agent.send({ threadId: t.id, text: 'Research the populations of all the capitals in Europe', max: true })).done).toBe('finished')
    const card = h.card(t)!
    expect(card.strategy).toBe('team')
    expect(card.teams?.[0].members.filter((m) => m.status === 'done')).toHaveLength(10)
    // The renderer leaves that team's own card out (it's inside Max).
    expect(maxTeamCalls(h.db.listMessages(t.id)).size).toBe(1)
    expect(maxTotals(card).agents).toBe(10)
    // The lead's note named the max tool; the team nudge would too.
    expect(String(h.db.listMessages(t.id).find((m) => m.role === 'user')?.meta?.note)).toContain('max tool (strategy "team"')
  })

  test('Max is off for a bot only stops Auto and Always: the composer\'s toggle still runs, the max tool is listed only then', () => {
    const s = { botMax: { b: { mode: 'off' } } } as unknown as Settings
    const bot = { id: 'b', kind: 'bot', isMain: false } as Space
    const st = (): ThreadState => ({ loaded: [] } as unknown as ThreadState)
    const a = st()
    applySwarmState(a, s, bot, false, () => [], () => undefined)
    expect(a.max).toBe('off')
    expect(maxTool().available!(a)).toBe(false)
    const b = st()
    const loaded: string[] = []
    applySwarmState(b, s, bot, false, () => [{ role: 'user', meta: { max: { strategy: 'swarm' } } } as never], (n) => loaded.push(...n))
    expect(b.max).toBe('on')
    expect(loaded).toEqual(['max'])
    // Helpers never get it.
    const c = st()
    applySwarmState(c, {} as Settings, bot, true, () => [], () => undefined)
    expect(maxTool().available!(c)).toBe(false)
    expect(maxDecision({ settings: s, space: bot, text: 'Brainstorm 30 names for my bakery' })).toEqual({})
    expect(maxDecision({ settings: s, space: bot, text: 'Brainstorm 30 names for my bakery', max: true }).plan?.strategy).toBe('swarm')
  })
})

describe('Max caps, budgets and provider rules', () => {
  const usable = [SONNET, OPUS, HAIKU, GPT]
  const isCloud = (): boolean => true

  test('agent chats keep every attempt and the judge on the lead\'s provider; bots may mix', () => {
    expect(heavyMix('claude-sonnet-5-5', 'auto', usable, 4, true, false).every((m) => m.startsWith('claude-'))).toBe(true)
    expect(heavyMix('claude-sonnet-5-5', 'auto', usable, 4, true, true)).toContain('gpt-6.1-sol')
    expect(judgeModelFor('claude-sonnet-5-5', usable, true, false)).toBe('claude-opus-5-5')
    expect(judgeModelFor('claude-sonnet-5-5', usable, true, true)).toBe('gpt-6.1-sol')
    // An explicit mix can't smuggle another provider into an agent chat either.
    expect(heavyMix('claude-sonnet-5-5', ['gpt-6.1-sol', 'claude-opus-5-5'], usable, 2, true, false)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5'])
  })

  test('unattended judged attempts shrink to the routine budget, and are skipped when even two don\'t fit', () => {
    const cfg = heavyConfig({ attempts: 6, mix: 'same' })
    const h = { cfg, lead: 'claude-opus-5-5', usable, cloud: isCloud, crossProvider: false }
    const all = heavyPlan(h).estimate
    expect(fitHeavy(h, all + 1)).toBe(6)
    const n = fitHeavy(h, all / 2)
    expect(n).toBeGreaterThanOrEqual(2)
    expect(n).toBeLessThan(6)
    expect(heavyPlan({ ...h, cfg: { ...cfg, attempts: n } }).estimate).toBeLessThanOrEqual(all / 2)
    expect(fitHeavy(h, 0.0001)).toBe(0)
    // Local models cost nothing: everything fits.
    expect(fitHeavy({ ...h, cloud: () => false }, 0)).toBe(6)
    // The cap is the lower of the routine budget and the per-swarm hard cap.
    expect(heavyCap({ swarm: swarmConfig({ maxUsd: 5 }), budgetUsd: 1 })).toBe(1)
    expect(heavyCap({ swarm: swarmConfig({ maxUsd: 0.5 }), budgetUsd: 3 })).toBe(0.5)
  })

  test('the unattended budget: a bot\'s routine budget; elsewhere what may start without an OK', () => {
    const s = { botMax: { b: { routineUsd: 2 } }, swarm: { askAboveUsd: 0.4, maxUsd: 5 } } as unknown as Settings
    expect(maxBudget({ settings: s, space: { id: 'b', kind: 'bot', isMain: false } as Space })).toBe(2)
    expect(maxBudget({ settings: s, space: { id: 'p', kind: 'project', isMain: false } as Space })).toBe(0.4)
    expect(maxBudget({ settings: { ...s, swarm: { askAboveUsd: 9, maxUsd: 1 } } as never, space: { id: 'b', kind: 'bot', isMain: false } as Space })).toBe(1)
  })

  test('a routine on a bot with Max Always runs judged attempts unattended within budget, never asking', async () => {
    const h = harness([SONNET, OPUS], { swarm: { askAboveUsd: 0, maxUsd: 50 }, heavy: { attempts: 4, mix: 'same' }, botMax: {} } as never)
    h.settings.botMax = { [h.bot.id]: { mode: 'always', routineUsd: 50 } }
    route((r) => heavyReplies(r) ?? { content: 'plain', delay: 0 })
    const t = h.thread(h.bot.id)
    const { done } = await h.agent.send({ threadId: t.id, text: 'Prove that there are infinitely many primes' }, { unattended: true })
    expect(await done).toBe('finished')
    expect(h.agent.pending(t.id)).toEqual([])
    const card = h.card(t)!
    expect(card).toMatchObject({ strategy: 'heavy', source: 'bot', unattended: true, budgetUsd: 50 })
    expect(card.heavy?.attempts.length).toBeGreaterThanOrEqual(2)
  })

  test('a routine whose budget can\'t cover judged attempts answers directly (no ask, the card says why)', async () => {
    const h = harness([SONNET, OPUS], { swarm: { askAboveUsd: 0, maxUsd: 50 }, heavy: { attempts: 4, mix: 'same' } } as never)
    h.settings.botMax = { [h.bot.id]: { mode: 'always', routineUsd: 0 } }
    route((r) => heavyReplies(r) ?? { content: 'A direct answer.', delay: 0 })
    const t = h.thread(h.bot.id)
    expect(await (await h.agent.send({ threadId: t.id, text: 'Prove that there are infinitely many primes' }, { unattended: true })).done).toBe('finished')
    expect(llm.requests.some((r) => /Heavy attempt/.test(sysOf(r)))).toBe(false)
    const card = h.card(t)!
    expect(card.phases[0]).toMatchObject({ kind: 'heavy', status: 'skipped' })
    expect(card.phases[0].note).toMatch(/routine budget/)
  })

  test('the notes carry the sizing: team minimum and maximum, the bot\'s Max helpers, the routine budget', () => {
    const team = planMax('Research the competitive landscape for AI note-taking apps', { category: 'research' })
    expect(maxNote(team, { teamMin: 10, teamMax: 30, maxHelpers: 20 })).toMatch(/at least 10[^]*up to 30[^]*max tool \(strategy "team"/)
    const sw = planMax('Brainstorm ways to grow my bakery')
    expect(maxNote(sw, { teamMin: 10, teamMax: 30, maxHelpers: 12, unattended: true, budgetUsd: 1.5 })).toMatch(/up to 12 helpers[^]*\$1\.50/)
    const hy = planMax('Brainstorm names for my podcast, then pick the best one')
    expect(maxNote(hy, { teamMin: 10, teamMax: 30, maxHelpers: 20 })).toMatch(/Phase 1 of 2[^]*NOT the final deliverable/)
  })

  test('group chats never get judged attempts; Council replaces Max; Deep Research makes it a team', () => {
    const s = {} as Settings
    expect(maxDecision({ settings: s, space: undefined, text: 'Prove the square root of 2 is irrational', max: true, group: true }).plan?.strategy).toBe('team')
    expect(maxDecision({ settings: s, space: undefined, text: 'anything', max: true, council: true })).toEqual({})
    expect(maxDecision({ settings: s, space: undefined, text: 'Prove it', max: true, deepResearch: true }).plan?.strategy).toBe('team')
  })

  test('the composer\'s flags: Max goes with Plan first and Deep Research; Council wins', () => {
    expect(modeFlags({ max: true, planFirst: true })).toEqual({ team: false, deepResearch: false, planFirst: true, max: true })
    expect(modeFlags({ max: true, deep: true })).toEqual({ team: true, deepResearch: true, planFirst: false, max: true })
    expect(modeFlags({ max: true, council: true })).toEqual({ team: false, deepResearch: false, planFirst: false, council: true })
  })

  test('attempt credits read [A#] tags', () => {
    expect(attemptCredits('One [A1], two [A1, A3] and [A2][A9].', 4)).toEqual([{ n: 1, count: 2 }, { n: 2, count: 1 }, { n: 3, count: 1 }])
    expect(maxSessionFor('nope')).toBeUndefined()
  })
})

describe('bots choose their own model and thinking', () => {
  test('requestedModel / requestedEffort: bots and groups Auto until you pick; regular chats the pick; helpers their assigned model', () => {
    const s = { defaultModel: 'claude-opus-5-5', thinking: 'high' } as Settings
    const bot = { kind: 'bot', isMain: false } as Space
    const main = { kind: 'bot', isMain: true } as Space
    const group = { kind: 'group', isMain: false } as Space
    expect(isBotSpace(bot)).toBe(true)
    expect(isBotSpace(group)).toBe(true)
    expect(isBotSpace(main)).toBe(false)
    expect(requestedModel({ thread: { model: 'gpt-6' }, space: bot, settings: s })).toBe('gpt-6')
    expect(requestedModel({ thread: { model: null }, space: bot, settings: s })).toBe('auto')
    expect(requestedModel({ thread: { model: 'gpt-6' }, space: main, settings: s })).toBe('gpt-6')
    expect(requestedModel({ thread: { model: null }, space: main, settings: s })).toBe('claude-opus-5-5')
    expect(requestedModel({ thread: { model: null }, space: group, speaker: bot, settings: s })).toBe('auto')
    expect(requestedModel({ thread: { model: 'claude-haiku-5-5', parentId: 'lead' }, space: bot, settings: s })).toBe('claude-haiku-5-5')
    // The app default's Auto variant is kept for bots (local-only stays local-only).
    expect(botModel('auto:local')).toBe('auto:local')
    expect(botModel('claude-opus-5-5')).toBe('auto')
    expect(requestedEffort({ thread: { effort: 'low' }, space: bot, settings: s })).toBe('low')
    expect(requestedEffort({ thread: { effort: null }, space: bot, settings: s })).toBe('auto')
    expect(requestedEffort({ thread: { effort: 'low' }, space: main, settings: s })).toBe('low')
    expect(requestedEffort({ thread: { effort: null }, space: main, settings: s })).toBe('high')
  })

  test('migration: stored bot model and thinking are cleared once; regular chats and helpers keep theirs', () => {
    const db = new Db(':memory:')
    const bot = db.createSpace('Writer', '#000000')
    const main = db.createSpace('SahilBot', '#000000', { isMain: true })
    db.updateSpace(bot.id, { model: 'claude-opus-5-5', effort: 'max' })
    db.updateSpace(main.id, { model: 'gpt-6', effort: 'low' })
    const bt = db.createThread(bot.id, 'auto', 'claude-haiku-5-5')
    db.updateThread(bt.id, { effort: 'low' })
    const helper = db.createThread(bot.id, 'auto', 'claude-haiku-5-5', bt.id)
    const mt = db.createThread(main.id, 'auto', 'gpt-6')
    db.updateThread(mt.id, { effort: 'xhigh' })
    expect(migrateBotModelEffort(db)).toBe(3)
    expect(db.getSpace(bot.id)).toMatchObject({ model: null, effort: null })
    expect(db.getSpace(main.id)).toMatchObject({ model: null, effort: null })
    expect(db.getThread(bt.id)).toMatchObject({ model: null, effort: null })
    expect(db.getThread(helper.id)?.model).toBe('claude-haiku-5-5')
    expect(db.getThread(mt.id)).toMatchObject({ model: 'gpt-6', effort: 'xhigh' })
    // Once per database.
    db.updateSpace(bot.id, { model: 'x' })
    expect(migrateBotModelEffort(db)).toBe(0)
  })

  test('the Swarm setting becomes the Max setting (migrated once, read as the fallback before that)', () => {
    const old = { botSwarm: { a: { mode: 'always' as const, maxHelpers: 40 }, b: { mode: 'off' as const } }, botMax: { b: { mode: 'auto' as const } } }
    expect(botMaxConfig(old, 'a')).toMatchObject({ mode: 'always', maxHelpers: 40 })
    expect(botMaxConfig(old, 'b').mode).toBe('auto')
    const next = migrateBotMax(old)!
    expect(next).toEqual({ a: { mode: 'always', maxHelpers: 40 }, b: { mode: 'auto' } })
    expect(migrateBotMax({ ...old, botMax: next })).toBeNull()
    expect(botMaxConfig({ botMax: { c: { maxHelpers: 500 } } }, 'c').maxHelpers).toBeLessThanOrEqual(50)
  })
})
