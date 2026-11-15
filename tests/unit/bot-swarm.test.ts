import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import { agentsTool, swarmTool } from '../../src/main/agent/tools/agents'
import { askBotTool, MAX_ASKS_PER_RUN, botDirectory, planAsk } from '../../src/main/agent/tools/ask-bot'
import {
  BREADTH, THINK_TOOLS, clusterIdeas, compileInput, creditsOf, ideationAngles, libraryAngle, parseIdeas, runBotSwarm, sizeSwarm, sliceItems, swarmFit,
  type BotSwarmHost
} from '../../src/main/agent/swarm/bot-swarm'
import { botSwarmConfig, councilConfig } from '../../src/main/agent/swarm/bot-config'
import { swarmConfig } from '../../src/main/agent/swarm/config'
import { estimateFor } from '../../src/main/agent/swarm/ledger'
import { assignModel, councilMembers, modelForSlot, providerOf, roleSlots, secondOpinionFor } from '../../src/main/agent/swarm/models'
import { parseMerge, runCouncil, type CouncilHost } from '../../src/main/agent/swarm/council'
import { crossProviderFor, swarmNote } from '../../src/main/agent/swarm/hosts'
import { slotsFor } from '../../src/main/llm/routing-table'
import { classifyTask as classifyRoute } from '../../src/main/llm/task-classifier'
import { Db } from '../../src/main/db'
import { askBotOf, councilOf, modeFlags, swarmOf, swarmStats } from '../../src/renderer/src/lib/swarm-view'
import type { ChatEvent, CouncilBoard, ModelInfo, Settings, Space, SwarmBoard, Thread } from '../../src/shared/types'
import type { ToolDef } from '../../src/main/agent/types'
import { startMockLlm, type MockLlm, type ScriptedReply } from '../fixtures/mock-llm'

process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'

const local = (id: string, tier: 0 | 1 | 2 | 3, extra: Partial<ModelInfo> = {}): ModelInfo =>
  ({ id, provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: id.toUpperCase(), vision: false, tier, requiredGB: 1, maxFittingWindow: 131072, fits: true, ...extra }) as ModelInfo
const cloud = (id: string, tier: 0 | 1 | 2 | 3, extra: Partial<ModelInfo> = {}): ModelInfo =>
  local(id, tier, { provider: 'anthropic', providerName: 'Anthropic', note: 'remote', ...extra })
const gpt = (id: string, tier: 0 | 1 | 2 | 3, rank = 4): ModelInfo => cloud(id, tier, { provider: 'openai', providerName: 'OpenAI', rank })

const HAIKU = cloud('claude-haiku-5-5', 1, { rank: 3 })
const SONNET = cloud('claude-sonnet-5-5', 2, { rank: 5 })
const OPUS = cloud('claude-opus-5-5', 3, { rank: 8 })
const LUNA = gpt('gpt-6-luna', 0, 2)
const TERRA = gpt('gpt-6.1-terra', 1, 3)
const SOL = gpt('gpt-6.1-sol', 2, 5)
const ASTRA = gpt('gpt-6-astra', 3, 8)
const GROK = cloud('grok-4.7', 2, { provider: 'xai' as never, providerName: 'xAI', rank: 4 })
const ALL = [HAIKU, SONNET, OPUS, LUNA, TERRA, SOL, ASTRA]

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
afterEach(() => { llm.script.length = 0; llm.requests.length = 0 })

type Req = Record<string, any>
const sysOf = (r: Req): string => String(r.messages?.[0]?.content ?? '')
const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? '').join(' ') : '')
const lastUser = (r: Req): string => textOf([...r.messages].reverse().find((m: { role: string }) => m.role === 'user')?.content)
const allText = (r: Req): string => JSON.stringify(r.messages)
const toolsOf = (r: Req): string[] => (r.tools ?? []).map((t: any) => t.function?.name ?? t.name)
const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: JSON.stringify(args) })
const route = (fn: (r: Req) => ScriptedReply): void => { for (let i = 0; i < 400; i++) llm.script.push(fn) }

/** A real Agent over an in-memory database and the mock model server (cloud models are served by it too). */
function harness(models: ModelInfo[], extra: Partial<Settings> = {}, tools: ToolDef[] = []) {
  const db = new Db(':memory:')
  const settings = {
    contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true },
    workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: models[0].id, hiddenModels: [], shownModels: [],
    cloud: { enabled: true, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [], ...extra
  } as unknown as Settings
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), agentsTool(), swarmTool(), askBotTool({ bots: () => db.listSpaces() }), ...tools)
  const events: ChatEvent[] = []
  const last = { ok: true, models, budgetGB: 32, totalGB: 64, providers: [] }
  const endpoints = { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => models, list: async () => last, advisor: () => undefined }
  const prompts: Record<string, string> = {}
  const agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: endpoints as never,
    spaces: { getPrompt: (id: string) => prompts[id] ?? '' } as never,
    memory: { block: () => '' } as never,
    emit: (e) => events.push(e),
    secretValues: () => [],
    fitWindow: (_m, w) => w,
    counter: () => ({ count: async (t: string) => estimate(t) })
  })
  const space = db.createSpace('Alpha', '#336699')
  const thread = (m: string | null = models[0].id, sp: Space = space): Thread => db.createThread(sp.id, 'auto', m)
  const card = <T,>(t: Thread, key: 'swarm' | 'council' | 'askBot'): T | undefined => db.listMessages(t.id).filter((m) => m.kind === 'notice' && m.meta?.[key]).map((m) => m.meta![key] as T).at(-1)
  return { db, agent, events, settings, space, thread, card, prompts }
}

const isSwarmHelper = (r: Req): boolean => sysOf(r).includes('# You are a temporary swarm helper')

// ------------------------------------------------------------------------------------------------ sizing

describe('sizing heuristics', () => {
  const base = { maxHelpers: 50, capacity: { maxAgents: 50, parallel: 8 }, perHelperUsd: 0, budgetUsd: 5 }
  test('divide: one helper per item; the lead can ask for fewer slices', () => {
    expect(sizeSwarm({ ...base, pattern: 'divide', items: 12 }).count).toBe(12)
    expect(sizeSwarm({ ...base, pattern: 'divide', items: 30, requested: 10 })).toMatchObject({ count: 10, why: '30 items in 10 slices' })
    expect(sliceItems(Array.from({ length: 30 }, (_, i) => i), 10).map((s) => s.length)).toEqual(Array(10).fill(3))
    expect(sliceItems([1, 2, 3, 4, 5], 3)).toEqual([[1, 2], [3, 4], [5]])
  })
  test('ideate: breadth sets the default; never past 50', () => {
    expect(sizeSwarm({ ...base, pattern: 'ideate' }).count).toBe(BREADTH.normal)
    expect(sizeSwarm({ ...base, pattern: 'ideate', breadth: 'wide' }).count).toBe(25)
    expect(sizeSwarm({ ...base, pattern: 'ideate', requested: 80 }).count).toBe(50)
  })
  test('every limit applies, the smallest wins, and the reason says which', () => {
    expect(sizeSwarm({ ...base, pattern: 'ideate', requested: 40, maxHelpers: 20 })).toMatchObject({ count: 20, limitedBy: 'bot' })
    expect(sizeSwarm({ ...base, pattern: 'ideate', requested: 40, capacity: { maxAgents: 6, parallel: 2 } })).toMatchObject({ count: 6, limitedBy: 'capacity' })
    expect(sizeSwarm({ ...base, pattern: 'ideate', requested: 40, rateLimited: true })).toMatchObject({ count: 16, limitedBy: 'rate' })
    const b = sizeSwarm({ ...base, pattern: 'divide', items: 40, perHelperUsd: 0.1, budgetUsd: 1, reserveUsd: 0.2 })
    expect(b).toMatchObject({ count: 8, limitedBy: 'budget' })
    expect(b.why).toMatch(/\$1\.00 covers 8/)
    expect(sizeSwarm({ ...base, pattern: 'ideate', perHelperUsd: 2, budgetUsd: 1 }).count).toBe(0)
  })
  test('Auto spots swarm-worthy requests locally', () => {
    expect(swarmFit('Brainstorm 30 names for my bakery')).toMatchObject({ fit: true, pattern: 'ideate' })
    expect(swarmFit('Compare all 15 CRM vendors on price')).toMatchObject({ fit: true, pattern: 'divide' })
    expect(swarmFit('look these over', { attachments: 9 })).toMatchObject({ fit: true, pattern: 'divide' })
    expect(swarmFit('what time is it in Tokyo?').fit).toBe(false)
  })
})

// ------------------------------------------------------------------------------------------------ divergent briefs

describe('divergent briefs', () => {
  test('50 angles, every one a different persona-and-constraint pair; the lead\'s own come first, deduped', () => {
    const fifty = ideationAngles(50)
    expect(new Set(fifty).size).toBe(50)
    const pairs = Array.from({ length: 50 }, (_, i) => libraryAngle(i)).map((a) => `${a.persona}|${a.constraint}`)
    expect(new Set(pairs).size).toBe(50)
    // The first 25 differ in both the persona and the constraint.
    expect(new Set(Array.from({ length: 25 }, (_, i) => libraryAngle(i).constraint)).size).toBe(25)
    const mine = ideationAngles(4, ['As a nurse', 'as a  NURSE', 'As a pilot'])
    expect(mine.slice(0, 2)).toEqual(['As a nurse', 'As a pilot'])
    expect(mine).toHaveLength(4)
  })
  test('ideas are read from the helpers\' format; duplicates across helpers cluster with every source', () => {
    expect(parseIdeas('1. **Night market pop-up**: sell late.\n2. **Sourdough club**: subscription.\nBest bet: the club')).toEqual(['Night market pop-up', 'Sourdough club'])
    const c = clusterIdeas([{ n: 1, title: 'Sourdough subscription club' }, { n: 4, title: 'A sourdough club subscription' }, { n: 2, title: 'Night market stall' }])
    expect(c).toEqual([{ title: 'Sourdough subscription club', from: [1, 4] }, { title: 'Night market stall', from: [2] }])
    expect(creditsOf('Best: the club [H1, H4]. Also [H2][H4] and [H77].')).toEqual([{ n: 1, count: 1 }, { n: 2, count: 1 }, { n: 4, count: 2 }])
  })
})

// ------------------------------------------------------------------------------------------------ compile

describe('the compile step', () => {
  test('gets every helper\'s result (an even share each, none dropped), the duplicates and the credit rules', () => {
    const helpers = Array.from({ length: 30 }, (_, i) => ({ n: i + 1, title: `T${i + 1}`, angle: `angle ${i + 1}`, status: 'done' as const, model: 'm', report: `REPORT-${i + 1} ${'x'.repeat(5000)}` }))
    const text = compileInput({ swarmId: 'sw1', goal: 'Ideas', pattern: 'ideate', helpers, budgetChars: 30_000, duplicates: [{ title: 'Club', from: [3, 9] }] })
    for (let i = 1; i <= 30; i++) expect(text).toContain(`REPORT-${i} `)
    expect(text.length).toBeLessThan(60_000)
    expect(text).toContain('"Club": H3, H9')
    expect(text).toMatch(/Credit helpers with tags like \[H3\]/)
    expect(text).toMatch(/action "refine", swarm_id "sw1"/)
  })
})

// ------------------------------------------------------------------------------------------------ a fake host

function fakeHost(over: Partial<BotSwarmHost> & { spend?: number } = {}): BotSwarmHost & { approvals: number; boards: SwarmBoard[]; tasks: string[] } {
  const boards: SwarmBoard[] = []
  const tasks: string[] = []
  const h = {
    swarmId: 'swX', threadId: 't1', bot: { id: 'b1', name: 'Alpha' }, cfg: botSwarmConfig({}, 'b1'), swarm: swarmConfig({ askAboveUsd: 100 }),
    lead: 'claude-sonnet-5-5', usable: [HAIKU, SONNET, OPUS], category: 'research' as const, crossProvider: true,
    cloud: () => true, label: (m: string) => m, capacity: () => ({ maxAgents: 50, parallel: 1 }), unattended: false, signal: new AbortController().signal,
    approvals: 0, boards, tasks,
    approve: async () => { h.approvals++; return true },
    publish: (b: SwarmBoard) => { boards.push(b) },
    helper: async (x: { n: number }, o: { task: string; onChild?: (id: string) => void }) => { tasks.push(o.task); o.onChild?.(`c${x.n}`); return { status: 'finished' as const, report: `1. **Idea ${x.n}**: text`, childId: `c${x.n}` } },
    progress: () => ({ usd: over.spend ?? 0, tokens: 10 }),
    cancelled: () => false,
    tickMs: 5,
    ...over
  }
  return h as never
}

describe('spend cap and routine budget', () => {
  test('the hard cap stops new helpers once what they spent leaves no room', async () => {
    const h = fakeHost({ swarm: swarmConfig({ askAboveUsd: 100, maxUsd: 0.5 }), spend: 0.3 })
    const r = await runBotSwarm(h, { goal: 'Ideas for a bakery', pattern: 'ideate', helpers: 5 })
    const last = h.boards.at(-1)!
    expect(last.helpers.filter((x) => x.status === 'done')).toHaveLength(2)
    expect(last.helpers.slice(2).every((x) => x.status === 'stopped' && /cap/.test(x.detail ?? ''))).toBe(true)
    expect(r.text).toMatch(/budget cap: 3 helpers never started/)
  })
  test('unattended (routines): never asks; shrinks to the routine budget, and skips when even one won\'t fit', async () => {
    const per = estimateFor('claude-haiku-5-5', true, { input: 6_000, output: 1_500 })
    const h = fakeHost({ unattended: true, cfg: { mode: 'auto', maxHelpers: 20, routineUsd: per * 3.5 }, swarm: swarmConfig({ askAboveUsd: 0 }) })
    await runBotSwarm(h, { goal: 'Ideas', pattern: 'ideate', helpers: 10 })
    expect(h.approvals).toBe(0)
    expect(h.boards.at(-1)!.helpers).toHaveLength(3)
    expect(h.boards.at(-1)!.capUsd).toBeCloseTo(per * 3.5)
    const none = fakeHost({ unattended: true, cfg: { mode: 'auto', maxHelpers: 20, routineUsd: 0 } })
    expect((await runBotSwarm(none, { goal: 'Ideas', pattern: 'ideate' })).display).toMatch(/skipped/)
    expect(none.boards).toHaveLength(0)
    // Attended above the threshold: the user OKs it (a 'swarm' cost card).
    const ask = fakeHost({ swarm: swarmConfig({ askAboveUsd: 0 }) })
    let spend: unknown
    ask.approve = async (_s, sp) => { spend = sp; return false }
    expect((await runBotSwarm(ask, { goal: 'Ideas', helpers: 4 })).display).toBe('swarm declined')
    expect(spend).toMatchObject({ kind: 'swarm', count: 4 })
  })
  test('per-bot settings are clamped (max 50 helpers, Auto by default)', () => {
    expect(botSwarmConfig(undefined, 'x')).toEqual({ mode: 'auto', maxHelpers: 20, routineUsd: 1 })
    expect(botSwarmConfig({ x: { mode: 'always', maxHelpers: 500, routineUsd: -3 } }, 'x')).toEqual({ mode: 'always', maxHelpers: 50, routineUsd: 0 })
    expect(councilConfig({ members: ['a'], rounds: 9 })).toEqual({ members: 'auto', rounds: 4 })
  })
})

// ------------------------------------------------------------------------------------------------ models

describe('mixed-model assignment', () => {
  const o = { usable: [...ALL, GROK], category: 'research' as const, lead: 'claude-opus-5-5', leadCloud: true, crossProvider: true }
  test('roles follow the routing table\'s row for the category (quality first)', () => {
    for (const role of ['breadth', 'solid', 'hard'] as const) {
      // Breadth stays on the light tier, solid on the standard one; the table orders the candidates.
      const cap = role === 'breadth' ? 1 : role === 'solid' ? 2 : 3
      const first = roleSlots(role, 'coding', false).find((s) => modelForSlot(s, ALL, undefined, undefined, cap))!
      expect(assignModel(role, { ...o, category: 'coding' }).model).toBe(modelForSlot(first, ALL, undefined, undefined, cap)!.id)
    }
    // The hardest coding slices: the table's first choice at the hardest tier.
    expect(roleSlots('hard', 'coding', false)[0]).toBe(slotsFor('coding', 3, 'best', false)[0])
    expect(assignModel('hard', { ...o, category: 'coding' }).model).toBe('claude-opus-5-5')
    expect(['claude-haiku-5-5', 'gpt-6-luna', 'gpt-6.1-terra', 'claude-sonnet-5-5']).toContain(assignModel('breadth', o).model)
  })
  test('bots work across providers: a Claude lead can run a GPT swarm; a reviewer comes from another provider', () => {
    expect(providerOf(assignModel('breadth', { ...o, provider: 'openai' }).model)).toBe('openai')
    expect(providerOf(assignModel('hard', { ...o, provider: 'openai' }).model)).toBe('openai')
    expect(providerOf(assignModel('review', { ...o, authorProvider: 'anthropic' }).model)).toBe('openai')
  })
  test('a normal agent chat stays with its lead\'s provider', () => {
    const chat = { ...o, crossProvider: false }
    for (const role of ['breadth', 'solid', 'hard', 'review'] as const) {
      expect(providerOf(assignModel(role, { ...chat, lead: 'gpt-6.1-sol', provider: 'anthropic' }).model)).toBe('openai')
      expect(providerOf(assignModel(role, { ...chat, lead: 'claude-opus-5-5', provider: 'openai', explicit: 'gpt-6-astra' }).model)).toBe('anthropic')
    }
    // An Opus lead's helpers: Haiku/Sonnet (light and standard tiers), never Opus itself for breadth.
    expect(['claude-haiku-5-5', 'claude-sonnet-5-5']).toContain(assignModel('breadth', { ...chat, lead: 'claude-opus-5-5' }).model)
    expect(assignModel('breadth', { ...chat, lead: 'claude-opus-5-5', usable: [HAIKU, OPUS, SONNET].map((m) => m.id === 'claude-sonnet-5-5' ? { ...m, tier: 2 as const } : m) }).model).not.toBe('claude-opus-5-5')
    expect(assignModel('solid', { ...chat, lead: 'claude-opus-5-5' }).model).toBe('claude-sonnet-5-5')
    expect(['gpt-6-luna', 'gpt-6.1-terra']).toContain(assignModel('breadth', { ...chat, lead: 'gpt-6.1-sol' }).model)
    expect(crossProviderFor({ kind: 'bot', isMain: false })).toBe(true)
    expect(crossProviderFor({ kind: 'bot', isMain: true })).toBe(false)
  })
  test('Grok is a model like the others: honored by name in bots, kept out of single-provider chats', () => {
    expect(assignModel('review', { ...o, explicit: 'grok-4.7' }).model).toBe('grok-4.7')
    expect(assignModel('solid', { ...o, explicit: 'grok-4.7' }).model).toBe('grok-4.7')
    expect(providerOf(assignModel('solid', { ...o, crossProvider: false, explicit: 'grok-4.7' }).model)).toBe('anthropic')
    expect(councilMembers(['grok-4.7', 'claude-opus-5-5'], o.usable).members).toEqual(['claude-opus-5-5', 'grok-4.7'])
    expect(secondOpinionFor(['claude-opus-5-5', 'gpt-6-astra'], o.usable)).toBe('grok-4.7')
  })
  test('local leads and Auto (local) keep everyone on the lead\'s model', () => {
    expect(assignModel('hard', { ...o, lead: 'qwen', leadCloud: false }).model).toBe('qwen')
    expect(assignModel('breadth', { ...o, localOnly: true }).model).toBe('claude-opus-5-5')
  })
  test('council Auto: the best Claude and the best GPT; one provider: its two strongest, said so', () => {
    const auto = councilMembers('auto', ALL).members
    expect(auto).toHaveLength(2)
    expect(auto[0]).toBe('claude-opus-5-5')
    expect(providerOf(auto[1])).toBe('openai')
    // The GPT seat is the routing table's choice for the hardest agent work.
    expect(auto[1]).toBe(roleSlots('hard', 'agent-tools', false).map((sl) => modelForSlot(sl, ALL, 'openai')).find(Boolean)!.id)
    const one = councilMembers('auto', [SONNET, OPUS, HAIKU])
    expect(one.members).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(one.note).toMatch(/Only one cloud provider/)
    expect(councilMembers('auto', [SONNET]).members).toEqual([])
  })
})

// ------------------------------------------------------------------------------------------------ the swarm through the real agent

describe('bot swarm through the agent', () => {
  test('a 10-helper ideation swarm: distinct briefs, read-only helpers on a cheaper model, every result to the compile, credits on the card', async () => {
    const h = harness([SONNET, HAIKU, OPUS], { swarm: { askAboveUsd: 100 } } as never)
    let lead = 0
    route((r) => {
      if (isSwarmHelper(r)) {
        const n = Number(/helper H(\d+) of 10/.exec(lastUser(r))?.[1])
        return { content: `1. **Idea ${n}a**: one. Why: x. Risk: y.\n2. **Idea ${n}b**: two.\nBest bet: ${n}a`, delay: 0 }
      }
      lead++
      return lead === 1
        ? { toolCalls: [call('swarm', { goal: 'Ideas to grow a neighborhood bakery', pattern: 'ideate', helpers: 10 })], delay: 0 }
        : { content: 'Top picks: the club [H1, H4], the stall [H7] and pop-ups [H4].', delay: 0 }
    })
    const t = h.thread('claude-sonnet-5-5')
    expect(await (await h.agent.send({ threadId: t.id, text: 'Brainstorm ways to grow my bakery', swarm: true })).done).toBe('finished')
    const helpers = llm.requests.filter(isSwarmHelper)
    expect(helpers).toHaveLength(10)
    // Distinct angles, the same goal; helpers on Haiku (one tier below the Sonnet lead); read-only tools only.
    const angles = helpers.map((r) => /## Your angle \(helper H\d+ of 10\)\n(.+)/.exec(lastUser(r))![1])
    expect(new Set(angles).size).toBe(10)
    expect(helpers.every((r) => lastUser(r).includes('Ideas to grow a neighborhood bakery'))).toBe(true)
    const breadth = assignModel('breadth', { usable: [SONNET, HAIKU, OPUS], category: classifyRoute('Ideas to grow a neighborhood bakery').category, lead: 'claude-sonnet-5-5', leadCloud: true, crossProvider: true }).model
    expect(['claude-haiku-5-5', 'claude-sonnet-5-5']).toContain(breadth)
    expect(helpers.every((r) => r.model === breadth)).toBe(true)
    for (const r of helpers) expect(toolsOf(r).every((n) => THINK_TOOLS.includes(n))).toBe(true)
    // The lead's compile step saw every helper's result.
    const compile = llm.requests.filter((r) => !isSwarmHelper(r)).at(-1)!
    for (let i = 1; i <= 10; i++) expect(allText(compile)).toContain(`Idea ${i}a`)
    // The card: 10 done, ideas counted, credits from the compiled answer.
    const board = h.card<SwarmBoard>(t, 'swarm')!
    expect(board.phase).toBe('done')
    expect(board.helpers.filter((x) => x.status === 'done')).toHaveLength(10)
    expect(board.ideas).toMatchObject({ total: 20 })
    expect(board.compiled?.credits).toEqual([{ n: 1, count: 1 }, { n: 4, count: 2 }, { n: 7, count: 1 }])
    expect(board.helpers[3].credit).toBe(2)
    expect(board.helpers.every((x) => x.childId)).toBe(true)
    // Temporary helpers never show as chats.
    expect(h.db.listThreads(h.space.id)).toHaveLength(1)
    // The user's message carried the swarm note.
    expect(String(h.db.listMessages(t.id).find((m) => m.role === 'user')?.meta?.note)).toContain('Swarm is on for this request')
  })

  test('helpers can\'t use tools outside their read-only set (refused before anything runs)', async () => {
    const h = harness([local('qwen-test', 2)], {}, [])
    let lead = 0
    route((r) => {
      if (isSwarmHelper(r)) {
        const tried = r.messages.some((m: any) => m.role === 'tool')
        return tried ? { content: '### apples\nFine. Verdict: ok', delay: 0 } : { toolCalls: [call('agents', { tasks: [{ title: 'x', task: 'y' }] })], delay: 0 }
      }
      lead++
      return lead === 1 ? { toolCalls: [call('swarm', { goal: 'Check fruit', pattern: 'divide', items: ['apples', 'pears'] })], delay: 0 } : { content: 'Done [H1][H2].', delay: 0 }
    })
    const t = h.thread()
    expect(await (await h.agent.send({ threadId: t.id, text: 'check the fruit', swarm: true })).done).toBe('finished')
    const kids = h.db.listMessages(t.id).length && h.card<SwarmBoard>(t, 'swarm')!.helpers.map((x) => x.childId!)
    for (const cid of kids as string[]) {
      const tool = h.db.listMessages(cid).find((m) => m.role === 'tool')!
      expect(tool.content).toMatch(/isn't available to you \(a read-only swarm helper\)/)
      expect(h.db.getState(cid).toolAllow).toContain('web_search')
    }
    // Local lead: everyone stays on it.
    expect(llm.requests.filter(isSwarmHelper).every((r) => r.model === 'qwen-test')).toBe(true)
  })

  test('a bot with Swarm off doesn\'t list the tool; Always notes every request; the main chat stays single-provider', () => {
    const s = { botSwarm: { b: { mode: 'off' } } } as unknown as Settings
    const bot = { id: 'b', kind: 'bot', isMain: false } as Space
    expect(swarmNote(s, bot, 'brainstorm 50 ideas', { swarm: true })).toEqual({})
    expect(swarmNote({ botSwarm: { b: { mode: 'always' } } } as never, bot, 'hello', {}).meta).toEqual({ swarm: true })
    expect(swarmNote({} as Settings, bot, 'Brainstorm 30 slogans', {}).meta).toEqual({ swarmHint: true })
    expect(swarmNote({} as Settings, { ...bot, kind: 'group' } as Space, 'Brainstorm 30 slogans', { swarm: true })).toEqual({})
    expect(String(swarmNote({} as Settings, bot, 'x', { swarm: true, unattended: true }).note)).toMatch(/routine budget/)
  })
})

// ------------------------------------------------------------------------------------------------ council

function councilHost(over: Partial<CouncilHost> & { review?: (round: number, by: number, of: number) => string; thinkUsd?: number } = {}) {
  const calls: Array<{ model: string; system: string; user: string }> = []
  const execs: Array<{ member: number; followUp?: string }> = []
  const boards: CouncilBoard[] = []
  let round = 0
  const host: CouncilHost = {
    councilId: 'cX', members: ['claude-opus-5-5', 'gpt-6-astra'], critics: [], rounds: 2, swarm: swarmConfig({ askAboveUsd: 100 }), request: 'Ship the launch plan', context: '',
    cloud: () => true, label: (m) => m, provider: (m) => providerOf(m), signal: new AbortController().signal,
    approve: async () => true,
    publish: (b) => { boards.push(b); round = b.round },
    think: async (model, system, user) => {
      calls.push({ model, system, user })
      const usd = over.thinkUsd ?? 0
      if (system.startsWith('[COUNCIL-PLAN]')) return { text: `PLAN-${model}\n1. Step from ${model}`, usd }
      if (system.startsWith('[COUNCIL-CRITIQUE]')) return { text: `CRITIQUE-${model}`, usd }
      if (system.startsWith('[COUNCIL-MERGE]')) return { text: JSON.stringify({ summary: 'Merged.', steps: [{ text: 'Write copy', owner: 1 }, { text: 'Check numbers', owner: 2 }], disagreements: [{ point: 'Launch day', positions: [{ member: 1, view: 'Monday' }, { member: 2, view: 'Friday' }] }] }), usd }
      if (system.startsWith('[COUNCIL-SIGN]')) return { text: '{"ok": true, "objections": []}', usd }
      if (system.startsWith('[COUNCIL-REVIEW]')) {
        const by = model === 'claude-opus-5-5' ? 0 : 1
        return { text: over.review ? over.review(round, by, 1 - by) : '{"ok": true}', usd }
      }
      return { text: '', usd }
    },
    execute: async (x) => { execs.push({ member: x.member, followUp: x.followUp }); return { status: 'finished', report: `### Step ${x.member + 1}\nDone by ${x.model}${x.followUp ? ' (fixed)' : ''}`, childId: `k${x.member}`, usd: 0 } },
    askUser: async (_q, options) => options[1],
    final: async () => 'finished',
    notice: () => undefined,
    ...over
  }
  return { host, calls, execs, boards }
}

describe('Council', () => {
  test('independent plans, cross-critique, a merged plan, the user settles a disagreement, execution split, review rounds until both sign off', async () => {
    const c = councilHost({ review: (round, by) => (round === 1 && by === 1 ? '{"ok": false, "issues": ["the copy has no price"]}' : '{"ok": true, "issues": []}') })
    expect(await runCouncil(c.host)).toBe('finished')
    const plans = c.calls.filter((x) => x.system.startsWith('[COUNCIL-PLAN]'))
    expect(plans.map((p) => p.model).sort()).toEqual(['claude-opus-5-5', 'gpt-6-astra'])
    // Independent: no plan request saw another plan.
    expect(plans.every((p) => !p.user.includes('PLAN-'))).toBe(true)
    // Cross-critique: each member saw both plans.
    const crit = c.calls.filter((x) => x.system.startsWith('[COUNCIL-CRITIQUE]'))
    expect(crit).toHaveLength(2)
    expect(crit.every((x) => x.user.includes('PLAN-claude-opus-5-5') && x.user.includes('PLAN-gpt-6-astra'))).toBe(true)
    // The chair (the strongest, first) merged, seeing the critiques.
    const merge = c.calls.find((x) => x.system.startsWith('[COUNCIL-MERGE]'))!
    expect(merge.model).toBe('claude-opus-5-5')
    expect(merge.user).toContain('CRITIQUE-gpt-6-astra')
    const b = c.boards.at(-1)!
    expect(b.members.map((m) => [m.plan?.slice(0, 9), m.critique?.slice(0, 9)])).toEqual([['PLAN-clau', 'CRITIQUE-'], ['PLAN-gpt-', 'CRITIQUE-']])
    expect(b.merged?.steps.map((s) => [s.text, s.owner, s.status])).toEqual([['Write copy', 0, 'done'], ['Check numbers', 1, 'done']])
    expect(b.disagreements[0].resolution).toMatch(/gpt-6-astra: Friday/)
    // Round 1: GPT found an issue in Claude's work; Claude fixed it; round 2: both signed off.
    expect(c.execs).toEqual([{ member: 0, followUp: undefined }, { member: 1, followUp: undefined }, { member: 0, followUp: expect.stringContaining('the copy has no price') }])
    expect(b.reviews.map((r) => [r.round, r.by, r.of, r.ok])).toEqual([[1, 1, 0, false], [1, 0, 1, true], [2, 1, 0, true], [2, 0, 1, true]])
    expect(b.stopReason).toBe('Everyone signed off in round 2.')
    expect(b.phase).toBe('done')
  })
  test('stop conditions: the round limit, the budget cap, a declined cost', async () => {
    const stubborn = councilHost({ review: () => '{"ok": false, "issues": ["still wrong"]}' })
    await runCouncil(stubborn.host)
    expect(stubborn.boards.at(-1)!.stopReason).toBe('Stopped at the round limit (2) with open issues.')
    expect(stubborn.execs.filter((e) => e.followUp)).toHaveLength(2)
    const broke = councilHost({ review: () => '{"ok": false, "issues": ["x"]}', thinkUsd: 0.6, rounds: 4, swarm: swarmConfig({ askAboveUsd: 100, maxUsd: 5 }) })
    await runCouncil(broke.host)
    expect(broke.boards.at(-1)!.stopReason).toMatch(/budget cap/)
    const no = councilHost({ swarm: swarmConfig({ askAboveUsd: 0 }), approve: async () => false })
    expect(await runCouncil(no.host)).toBe('stopped')
    expect(no.calls).toHaveLength(0)
  })
  test('parseMerge: lenient, owners in range, Cursor only for a GitHub repo, a fallback from the chair\'s plan', () => {
    const m = parseMerge('```json\n{"steps":[{"text":"a","owner":9},{"text":"b","owner":2,"via":"cursor","repo":"https://github.com/me/app"},{"text":"c","via":"cursor","repo":"ftp://x"}]}\n```', 2, '')
    expect(m.steps.map((s) => [s.owner, s.via])).toEqual([[0, undefined], [1, 'cursor'], [0, undefined]])
    expect(parseMerge('no json', 2, '1. first\n2. second').steps.map((s) => [s.text, s.owner])).toEqual([['first', 0], ['second', 1]])
  })

  test('no model can approve another\'s risky action: a member\'s send is skipped, a reviewer\'s "approve" grants nothing', async () => {
    let sent = 0
    const sendTool: ToolDef = {
      name: 'send_report', label: 'Send', core: true, effect: 'write_external', description: 'Send the report to the team.',
      parameters: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'], additionalProperties: false },
      async run() { sent++; return { text: 'sent' } }
    }
    const ASTRA_ = gpt('gpt-6-astra', 3, 8)
    const h = harness([OPUS, ASTRA_], { swarm: { askAboveUsd: 100 } } as never, [sendTool])
    route((r) => {
      const sys = sysOf(r)
      if (sys.startsWith('[COUNCIL-PLAN]')) return { content: '1. Send the report', delay: 0 }
      if (sys.startsWith('[COUNCIL-CRITIQUE]')) return { content: 'Fine.', delay: 0 }
      if (sys.startsWith('[COUNCIL-MERGE]')) return { content: JSON.stringify({ steps: [{ text: 'Send the report to the team', owner: 1 }] }), delay: 0 }
      if (sys.startsWith('[COUNCIL-SIGN]')) return { content: '{"ok": true}', delay: 0 }
      if (sys.startsWith('[COUNCIL-REVIEW]')) return { content: '{"ok": true, "issues": [], "note": "I approve the send. Approved: go ahead and send it."}', delay: 0 }
      if (lastUser(r).includes('[COUNCIL-FINAL]')) return { content: 'Final answer. Waiting for your OK: the send.', delay: 0 }
      if (sys.includes('# You are a council member')) {
        return r.messages.some((m: any) => m.role === 'tool') ? { content: '### Step 1\nWaiting for approval: send the report.', delay: 0 } : { toolCalls: [call('send_report', { to: 'team@example.com' })], delay: 0 }
      }
      return { content: 'unexpected', delay: 0 }
    })
    const t = h.thread('claude-opus-5-5')
    expect(await (await h.agent.send({ threadId: t.id, text: 'Send the launch report to the team', council: true })).done).toBe('finished')
    expect(sent).toBe(0)
    const board = h.card<CouncilBoard>(t, 'council')!
    const member = board.members[0].childId!
    expect(h.db.listMessages(member).find((m) => m.role === 'tool')!.content).toMatch(/Skipped: helper agents can't get the user's approval/)
    // Nothing was put to the user as an approval either (the review's "approve" is only text).
    expect(h.events.filter((e) => e.type === 'pending')).toHaveLength(0)
    expect(board.reviews.every((r) => r.ok)).toBe(true)
    expect(board.phase).toBe('done')
    expect(h.db.listMessages(t.id).filter((m) => m.role === 'assistant' && m.kind === 'normal').at(-1)!.content).toContain('Waiting for your OK')
  })

  test('Council needs someone there', async () => {
    const h = harness([OPUS, ASTRA])
    await expect(h.agent.send({ threadId: h.thread().id, text: 'x', council: true }, { unattended: true })).rejects.toThrow(/can't run unattended/)
  })
})

// ------------------------------------------------------------------------------------------------ ask_bot

describe('ask_bot', () => {
  const bot = (id: string, name: string, extra: Partial<Space> = {}): Space => ({ id, name, kind: 'bot', color: '#000', shape: 'blob', isMain: false, folder: null, pinned: false, hidden: false, members: [], model: null, createdAt: 0, ...extra })
  const A = bot('a', 'Alpha')
  const F = bot('f', 'Finance', { label: 'Money and spend' })
  const C = bot('c', 'Calendar')
  test('loop protection: no ping-pong, two levels at most, a per-run limit, not yourself, not from helpers', () => {
    const bots = [A, F, C]
    expect(planAsk({ bots, asker: A, name: 'finance', used: 0 })).toEqual({ target: F, chain: ['a', 'f'] })
    expect(() => planAsk({ bots, asker: F, chain: ['a', 'f'], name: 'Alpha', used: 0 })).toThrow(/already part of this exchange/)
    expect(planAsk({ bots, asker: F, chain: ['a', 'f'], name: 'Calendar', used: 0 }).chain).toEqual(['a', 'f', 'c'])
    expect(() => planAsk({ bots: [...bots, bot('d', 'Docs')], asker: C, chain: ['a', 'f', 'c'], name: 'Docs', used: 0 })).toThrow(/2 levels deep/)
    expect(() => planAsk({ bots, asker: A, name: 'Finance', used: MAX_ASKS_PER_RUN })).toThrow(/limit is 6/)
    expect(() => planAsk({ bots, asker: A, name: 'Alpha', used: 0 })).toThrow(/That's you/)
    expect(() => planAsk({ bots, asker: A, name: 'Nobody', used: 0 })).toThrow(/other bots: Finance, Calendar/)
    expect(() => planAsk({ bots, asker: A, name: 'Finance', used: 0, helper: true })).toThrow(/Helper agents/)
  })
  test('the directory says what each bot knows', () => {
    expect(botDirectory([A, F], 'a', (id) => (id === 'f' ? 'You track the budget and all spending. Be exact.' : ''))).toEqual([{ name: 'Finance', knows: 'Money and spend — You track the budget and all spending.' }])
  })

  test('one bot asks another: a hidden read-only answer, relayed and untrusted, its approvals on the asking chat\'s card, an "Asked Finance" card', async () => {
    let saved = 0
    const saveNote: ToolDef = { name: 'save_note', label: 'Save note', core: true, effect: 'write_local', description: 'Save a note.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, async run() { saved++; return { text: 'saved' } } }
    const h = harness([local('qwen-test', 2)], {}, [saveNote])
    const fin = h.db.createSpace('Finance', '#00aa55')
    h.prompts[fin.id] = 'You track spending.'
    const isFinance = (r: Req): boolean => allText(r).includes('Question from the bot \\"Alpha\\"')
    let lead = 0
    route((r) => {
      if (isFinance(r)) {
        const tools = r.messages.filter((m: any) => m.role === 'tool').length
        if (tools === 0) return { toolCalls: [call('save_note', { text: 'q3' })], delay: 0 }
        if (tools === 1) return { toolCalls: [call('ask_bot', { bot: 'Alpha', question: 'what do you need it for?' })], delay: 0 }
        return { content: 'Q3 spend was $12,400.', delay: 0 }
      }
      lead++
      return lead === 1 ? { toolCalls: [call('ask_bot', { bot: 'Finance', question: 'What was our Q3 spend?' })], delay: 0 } : { content: 'Finance says Q3 spend was $12,400.', delay: 0 }
    })
    const t = h.thread()
    const done = (await h.agent.send({ threadId: t.id, text: 'What was our Q3 spend? Ask the Finance bot.' })).done
    // Finance's own approval (a write in Ask mode) shows on Alpha's chat, labeled with Finance; the user says no.
    let req
    for (let i = 0; i < 400 && !req; i++) { req = h.agent.pending(t.id)[0]; if (!req) await new Promise((r) => setTimeout(r, 10)) }
    expect(req?.label).toMatch(/^Finance/)
    h.agent.respond(t.id, req!.id, 'deny')
    expect(await done).toBe('finished')
    expect(saved).toBe(0)
    const v = askBotOf(h.db.listMessages(t.id).find((m) => m.meta?.askBot)!)!
    expect(v).toMatchObject({ bot: 'Finance', status: 'answered', question: 'What was our Q3 spend?' })
    expect(v.answer).toContain('$12,400')
    // Hidden thread in Finance's space; the question is relayed (not the user's words).
    const child = h.db.getThread(v.childId!)!
    expect(child.spaceId).toBe(fin.id)
    expect(child.parentId).toBe(t.id)
    expect(h.db.listThreads(fin.id)).toHaveLength(0)
    expect(h.db.listMessages(child.id)[0].meta).toMatchObject({ handoff: true, askBot: true, from: 'Alpha', mode: 'ask' })
    // Ping-pong back to Alpha was refused.
    expect(h.db.listMessages(child.id).filter((m) => m.role === 'tool').map((m) => m.content).join('\n')).toMatch(/already part of this exchange/)
    // The answer reached Alpha as untrusted tool output.
    const out = h.db.listMessages(t.id).find((m) => m.role === 'tool' && m.toolName === 'ask_bot')!
    expect(out.content).toContain('Finance answered')
    expect(out.meta?.untrusted).toBeTruthy()
  })
})

describe('UI plumbing', () => {
  test('mode flags: Council replaces the others; Swarm rides along', () => {
    expect(modeFlags({ team: true, swarm: true })).toEqual({ team: true, deepResearch: false, planFirst: false, swarm: true })
    expect(modeFlags({ team: true, heavy: true, council: ['a', 'b'] })).toEqual({ team: false, deepResearch: false, planFirst: false, council: ['a', 'b'] })
    expect(modeFlags({ team: true })).toEqual({ team: true, deepResearch: false, planFirst: false })
  })
  test('cards are read off their notices', () => {
    const board = { swarmId: 's', pattern: 'ideate', goal: 'g', phase: 'done', lead: { model: 'm' }, helpers: [{ id: 'a', n: 1, title: 't', angle: 'x', role: 'breadth', model: 'm', status: 'done', ideas: ['i', 'j'] }], compiled: { excerpt: 'e', credits: [{ n: 1, count: 3 }] } } as SwarmBoard
    expect(swarmOf({ kind: 'notice', meta: { swarm: board, swarmId: 's' } })?.id).toBe('s')
    expect(swarmOf({ kind: 'normal', meta: { swarm: board } })).toBeUndefined()
    expect(swarmStats(board)).toMatchObject({ done: 1, total: 1, ideas: 2, top: [{ n: 1, count: 3 }] })
    expect(councilOf({ kind: 'notice', meta: { council: { members: [], councilId: 'c' } } })?.id).toBe('c')
  })
})
