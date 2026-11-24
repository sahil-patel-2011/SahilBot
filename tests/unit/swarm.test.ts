import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import { agentsTool } from '../../src/main/agent/tools/agents'
import { heavyPlan, parseVerdict } from '../../src/main/agent/heavy'
import { heavyConfig, swarmConfig } from '../../src/main/agent/swarm/config'
import { heavyMix, helperModelFor, judgeModelFor, swarmCapacity } from '../../src/main/agent/swarm/capacity'
import { SwarmLedger, estimateFor, swarmScope, swarmSpend } from '../../src/main/agent/swarm/ledger'
import { AdaptiveLimit, runPool, swarmTiming } from '../../src/main/agent/swarm/pool'
import { Db } from '../../src/main/db'
import { retryPolicy } from '../../src/main/llm/client'
import { groupMembers, heavyOf, modeFlags, teamTotals } from '../../src/renderer/src/lib/swarm-view'
import type { ChatEvent, HeavyBoard, ModelInfo, Settings, TeamMember, Thread } from '../../src/shared/types'
import { startMockLlm, type MockLlm, type ScriptedReply } from '../fixtures/mock-llm'

process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'

const local = (id: string, tier: 0 | 1 | 2 | 3, extra: Partial<ModelInfo> = {}): ModelInfo =>
  ({ id, provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: id.toUpperCase(), vision: false, tier, requiredGB: 1, maxFittingWindow: 131072, fits: true, ...extra }) as ModelInfo
const cloud = (id: string, tier: 0 | 1 | 2 | 3, extra: Partial<ModelInfo> = {}): ModelInfo =>
  local(id, tier, { provider: 'anthropic', providerName: 'Anthropic', note: 'remote', ...extra })

const SONNET = cloud('claude-sonnet-5-5', 2, { rank: 5 })
const OPUS = cloud('claude-opus-5-5', 3, { rank: 8 })
const HAIKU = cloud('claude-haiku-5-5', 1, { rank: 3 })
const GPT = cloud('gpt-6', 2, { provider: 'openai', providerName: 'OpenAI', rank: 4 })

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
const savedRetry = { ...retryPolicy }
const savedTiming = { ...swarmTiming }
afterEach(() => { Object.assign(retryPolicy, savedRetry); Object.assign(swarmTiming, savedTiming); llm.script.length = 0; llm.requests.length = 0 })

/** A real Agent over an in-memory database and the mock model server (cloud models are served by the mock too). */
function harness(models: ModelInfo[], extra: Partial<Settings> = {}) {
  const db = new Db(':memory:')
  const settings = {
    contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true },
    workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: models[0].id, hiddenModels: [], shownModels: [],
    cloud: { enabled: true, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [], ...extra
  } as unknown as Settings
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), agentsTool())
  const events: ChatEvent[] = []
  const last = { ok: true, models, budgetGB: 32, totalGB: 64, providers: [] }
  const endpoints = { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => models, list: async () => last, advisor: () => undefined }
  const agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: endpoints as never,
    spaces: { getPrompt: () => '' } as never,
    memory: { block: () => '' } as never,
    emit: (e) => events.push(e),
    secretValues: () => [],
    fitWindow: (_m, w) => w,
    counter: () => ({ count: async (t: string) => estimate(t) })
  })
  const space = db.createSpace('Alpha', '#000000')
  // SahilBot's own chats keep a picked model exactly; bots (Alpha) always route as Auto.
  const main = db.createSpace('SahilBot', '#000000', { isMain: true })
  const thread = (m: string | null = models[0].id, spaceId = space.id): Thread => db.createThread(spaceId, 'auto', m)
  const teams = (): TeamMember[][] => events.filter((e): e is Extract<ChatEvent, { type: 'team' }> => e.type === 'team').map((e) => e.members)
  return { db, agent, events, settings, space, main, thread, teams }
}

type Req = Record<string, any>
const sysOf = (r: Req): string => String(r.messages?.[0]?.content ?? '')
const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? '').join(' ') : '')
const lastUser = (r: Req): string => textOf([...r.messages].reverse().find((m: { role: string }) => m.role === 'user')?.content)
const isHelper = (r: Req): boolean => sysOf(r).includes('# You are a helper agent')
const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: JSON.stringify(args) })
/** Answers every request with `fn` (requests from parallel helpers come in any order). */
const route = (fn: (r: Req) => ScriptedReply): void => { for (let i = 0; i < 200; i++) llm.script.push(fn) }
const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Part ${i + 1}`, task: `Research part ${i + 1} (task-${i + 1}).` }))

/** Waits for the next approval card in a chat and answers it. */
async function answerNext(agent: Agent, threadId: string, answer: 'once' | 'deny') {
  for (let i = 0; i < 400; i++) {
    const [req] = agent.pending(threadId)
    if (req) { agent.respond(threadId, req.id, answer); return req }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('no approval request came')
}

/** The lead sends one agents call with `list`, then answers with the reports. */
function leadAndHelpers(list: Array<{ title: string; task: string }>, helper: (r: Req) => ScriptedReply) {
  let leadTurns = 0
  route((r) => {
    if (isHelper(r)) return helper(r)
    leadTurns++
    return leadTurns === 1 ? { toolCalls: [call('agents', { tasks: list })], delay: 0 } : { content: 'Here is the compiled answer.', delay: 0 }
  })
}

const toolResult = (h: ReturnType<typeof harness>, t: Thread) => h.db.listMessages(t.id).find((m) => m.role === 'tool' && m.toolName === 'agents')

// ------------------------------------------------------------------------------------------------

describe('swarm capacity by model kind', () => {
  test('local models stay RAM-bound; cloud models use the swarm settings (clamped)', () => {
    const cfg = swarmConfig({})
    expect(cfg).toEqual({ maxAgents: 30, maxParallel: 8, askAboveUsd: 1, maxUsd: 5, helperModel: 'auto' })
    const c = swarmCapacity(SONNET, cfg)
    expect(c).toMatchObject({ cloud: true, maxAgents: 30, parallel: 8 })
    expect(swarmCapacity(SONNET, swarmConfig({ maxAgents: 500, maxParallel: 0 }))).toMatchObject({ maxAgents: 100, parallel: 1 })
    const l = swarmCapacity(local('qwen-test', 2), swarmConfig({ maxAgents: 100, maxParallel: 32 }))
    expect(l.cloud).toBe(false)
    expect(l.maxAgents).toBeLessThanOrEqual(30)
    expect(l.parallel).toBeLessThanOrEqual(6)
    expect(heavyConfig({ attempts: 20 }).attempts).toBe(8)
    expect(heavyConfig({ attempts: 1, mix: [] })).toEqual({ attempts: 2, mix: 'auto' })
  })

  test('a cloud team may go past the old 30 when the setting allows it', async () => {
    const h = harness([SONNET], { swarm: { maxAgents: 40, askAboveUsd: 100, helperModel: 'same', maxUsd: 100 } } as never)
    leadAndHelpers(tasks(35), (r) => ({ content: `Report for ${lastUser(r).match(/task-\d+/)?.[0]}.`, delay: 0 }))
    const t = h.thread()
    expect(await (await h.agent.send({ threadId: t.id, text: 'go wide' })).done).toBe('finished')
    expect(toolResult(h, t)?.meta?.display).toBe('35 of 35 helpers finished')
  })
})

describe('helper model selection', () => {
  const usable = [OPUS, SONNET, HAIKU, GPT, cloud('gpt-6-mini', 1, { provider: 'openai', rank: 2 })]
  test('auto: one tier below the lead on the cloud; same/explicit; local keeps its model', () => {
    expect(helperModelFor('claude-opus-5-5', 'auto', usable, true)).toBe('claude-sonnet-5-5')
    expect(helperModelFor('claude-sonnet-5-5', 'auto', usable, true)).toBe('claude-haiku-5-5')
    expect(helperModelFor('claude-haiku-5-5', 'auto', usable, true)).toBe('claude-haiku-5-5')
    expect(helperModelFor('gpt-6', 'auto', usable, true)).toBe('gpt-6-mini')
    expect(helperModelFor('claude-opus-5-5', 'same', usable, true)).toBe('claude-opus-5-5')
    expect(helperModelFor('claude-opus-5-5', 'gpt-6', usable, true)).toBe('gpt-6')
    expect(helperModelFor('claude-opus-5-5', 'not-a-model', usable, true)).toBe('claude-opus-5-5')
    expect(helperModelFor('qwen-test', 'auto', usable, false)).toBe('qwen-test')
    // Nothing one tier down: the lead's own model.
    expect(helperModelFor('claude-opus-5-5', 'auto', [OPUS], true)).toBe('claude-opus-5-5')
  })

  test('an Opus lead\'s helpers run on Sonnet through the real agent', async () => {
    const h = harness([OPUS, SONNET, HAIKU], { swarm: { askAboveUsd: 100 } } as never)
    leadAndHelpers(tasks(3), () => ({ content: 'A report.', delay: 0 }))
    const t = h.thread()
    expect(await (await h.agent.send({ threadId: t.id, text: 'research' })).done).toBe('finished')
    const helperModels = new Set(llm.requests.filter(isHelper).map((r) => r.model))
    expect([...helperModels]).toEqual(['claude-sonnet-5-5'])
    expect(llm.requests.filter((r) => !isHelper(r)).every((r) => r.model === 'claude-opus-5-5')).toBe(true)
    expect(h.teams().at(-1)?.every((m) => m.model === 'claude-sonnet-5-5')).toBe(true)
  })
})

describe('adaptive parallelism on rate limits', () => {
  test('runPool: a 429 halves the parallelism, pauses, and re-queues that member', async () => {
    swarmTiming.backoffMs = 5
    const limit = new AdaptiveLimit(4)
    let active = 0
    const peaks: number[] = []
    const runs = new Map<number, number>()
    await runPool(8, { limit }, async (i) => {
      active++
      peaks.push(active)
      runs.set(i, (runs.get(i) ?? 0) + 1)
      await new Promise((r) => setTimeout(r, 15))
      active--
      // Members 0 and 1 hit a rate limit on their first try.
      if (i < 2 && runs.get(i) === 1) { limit.rateLimited(); return 'retry' }
      limit.succeeded()
    })
    expect(peaks[0]).toBe(1)
    expect(Math.max(...peaks)).toBe(4)
    expect(limit.hits).toBe(2)
    expect(limit.low).toBe(1)
    expect(runs.get(0)).toBe(2)
    expect(runs.get(1)).toBe(2)
    expect([...runs.keys()].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    // Steady successes ease it back up.
    expect(limit.limit).toBeGreaterThan(1)
  })

  test('a helper that gets 429 from the provider is retried with fewer at once, and every helper finishes', async () => {
    retryPolicy.retries = 0
    swarmTiming.backoffMs = 5
    const h = harness([SONNET], { swarm: { maxParallel: 4, askAboveUsd: 100, helperModel: 'same' } } as never)
    let limited = false
    leadAndHelpers(tasks(4), (r) => {
      if (lastUser(r).includes('task-2') && !limited) { limited = true; return { status: 429 } }
      return { content: `Report for ${lastUser(r).match(/task-\d+/)?.[0]}.`, delay: 5 }
    })
    const t = h.thread()
    expect(await (await h.agent.send({ threadId: t.id, text: 'research' })).done).toBe('finished')
    expect(limited).toBe(true)
    const details = h.teams().flat().map((m) => m.detail ?? '')
    expect(details.some((d) => /Rate limited: retrying, 2 at a time/.test(d))).toBe(true)
    const final = h.teams().at(-1)!
    expect(final.map((m) => m.status)).toEqual(['done', 'done', 'done', 'done'])
    expect(toolResult(h, t)?.content).toContain('Report for task-2.')
  })
})

describe('swarm budget', () => {
  test('estimate: tasks × typical tokens × the model\'s price; local models cost nothing', () => {
    expect(estimateFor('claude-sonnet-5-5', true)).toBeCloseTo(0.06, 6)
    expect(estimateFor('claude-sonnet-5-5', true) * 40).toBeCloseTo(2.4, 6)
    expect(estimateFor('qwen-test', false)).toBe(0)
  })

  test('under the threshold it just runs; over it the user gets a cost card, and a no stops it before anything starts', async () => {
    const h = harness([SONNET], { swarm: { helperModel: 'same' } } as never)
    leadAndHelpers(tasks(20), () => ({ content: 'A report.', delay: 0 }))
    const t = h.thread()
    const done = (await h.agent.send({ threadId: t.id, text: 'research a lot' })).done
    const req = await answerNext(h.agent, t.id, 'deny')
    expect(req.summary).toBe('Run 20 helpers on CLAUDE-SONNET-5-5 · est. $1.20 · cap $5.00')
    expect(req.spend).toMatchObject({ kind: 'team', count: 20, estimateUsd: expect.closeTo(1.2, 6), capUsd: 5 })
    expect(await done).toBe('finished')
    expect(llm.requests.filter(isHelper)).toHaveLength(0)
    expect(toolResult(h, t)?.content).toMatch(/declined this team/)

    llm.script.length = 0
    llm.requests.length = 0
    leadAndHelpers(tasks(10), () => ({ content: 'A report.', delay: 0 }))
    const t2 = h.thread()
    expect(await (await h.agent.send({ threadId: t2.id, text: 'research some' })).done).toBe('finished')
    expect(h.agent.pending(t2.id)).toHaveLength(0)
    expect(llm.requests.filter(isHelper)).toHaveLength(10)
  })

  test('approved: the team runs; a helper can\'t start a costly team of its own without someone to ask', async () => {
    const h = harness([SONNET], { swarm: { helperModel: 'same' } } as never)
    leadAndHelpers(tasks(20), () => ({ content: 'A report.', delay: 0 }))
    const t = h.thread()
    const done = (await h.agent.send({ threadId: t.id, text: 'research a lot' })).done
    await answerNext(h.agent, t.id, 'once')
    expect(await done).toBe('finished')
    expect(llm.requests.filter(isHelper)).toHaveLength(20)
  })

  test('the hard cap: no helper starts past it, and the lead gets partial results', async () => {
    const h = harness([SONNET], { swarm: { maxUsd: 0.2, maxParallel: 1, askAboveUsd: 100, helperModel: 'same' } } as never)
    // Each helper reply reports 50k prompt + 5k output tokens on Sonnet 5.5: $0.15.
    leadAndHelpers(tasks(4), () => ({ content: 'A costly report.', delay: 0, usage: { prompt: 50_000, completion: 5_000 } }))
    const t = h.thread()
    expect(await (await h.agent.send({ threadId: t.id, text: 'research' })).done).toBe('finished')
    expect(llm.requests.filter(isHelper)).toHaveLength(1)
    const r = toolResult(h, t)!
    expect(r.meta?.display).toBe('1 of 4 helpers finished · stopped at the budget cap (3 not run)')
    expect(r.content).toContain('A costly report.')
    expect(r.content).toMatch(/3 of 4 helpers never started, so these results are partial/)
    const final = h.teams().at(-1)!
    expect(final[0]).toMatchObject({ status: 'done', usd: expect.closeTo(0.15, 6), tokens: 55_000 })
    expect(final.slice(1).every((m) => m.status === 'stopped' && /cap/.test(m.detail ?? ''))).toBe(true)
  })

  test('a helper stopped by the team cap mid-task still reports what it found (one tool-free wrap-up)', async () => {
    const h = harness([SONNET], { swarm: { maxUsd: 100, maxParallel: 1, askAboveUsd: 100, helperModel: 'same' } } as never)
    let helperTurns = 0
    let leadTurns = 0
    route((r) => {
      // The wrap-up: no tools, the findings in the prompt.
      if (/team's spending cap stopped you/.test(sysOf(r))) return { content: 'Freed costs $99/month (getfreed.ai/pricing, 2026). BAA: not confirmed.', delay: 0 }
      if (!isHelper(r)) return ++leadTurns === 1 ? { toolCalls: [call('agents', { tasks: tasks(1) })], delay: 0 } : { content: 'Here is the compiled answer.', delay: 0 }
      helperTurns++
      return helperTurns === 1
        ? { toolCalls: [call('notes', { action: 'add', section: 'State', text: 'Freed: $99/month per clinician (getfreed.ai/pricing)' })], delay: 0 }
        : { status: 400, errorMessage: 'Swarm cloud budget reached: this team has used $5.00 of its $5.00 cap, and this request could cost about $0.10. Nothing was sent. Finish with what you have.', delay: 0 }
    })
    const t = h.thread()
    expect(await (await h.agent.send({ threadId: t.id, text: 'research' })).done).toBe('finished')
    const wrap = llm.requests.find((r) => /team's spending cap stopped you/.test(sysOf(r)))
    expect(wrap).toBeDefined()
    expect(wrap!.tools ?? []).toHaveLength(0)
    expect(lastUser(wrap!)).toMatch(/Research part 1/)
    expect(lastUser(wrap!)).toMatch(/Freed: \$99\/month/)
    const r = toolResult(h, t)!
    expect(r.content).toContain('Freed costs $99/month')
    expect(r.content).toMatch(/reached the team's spending cap/)
  })

  test('ledger: requests reserve and settle like goal spend; one that could pass the cap is refused', () => {
    const l = new SwarmLedger(0.1)
    expect(l.canLaunch(0.5)).toBe(true) // the first always starts
    l.start('a', 0.05)
    expect(l.canLaunch(0.06)).toBe(false)
    expect(l.canLaunch(0.04)).toBe(true)
    swarmScope.run({ ledger: l, memberId: 'a' }, () => {
      swarmSpend.before('claude-sonnet-5-5', 10_000, 1000) // $0.03 reserved
      expect(() => swarmSpend.before('claude-sonnet-5-5', 40_000, 1000)).toThrow(/Swarm cloud budget reached/)
      swarmSpend.after('claude-sonnet-5-5', 10_000, 1000)
    })
    expect(l.member('a')).toBeCloseTo(0.03, 6)
    expect(l.hit).toBe(true)
  })
})

describe('cancel one helper and Stop remaining', () => {
  test('a cancelled helper stops; the others finish and the lead carries on', async () => {
    const h = harness([SONNET], { swarm: { askAboveUsd: 100, helperModel: 'same' } } as never)
    leadAndHelpers(tasks(3), (r) => (lastUser(r).includes('task-2')
      ? { content: Array.from({ length: 200 }, (_, i) => `word${i} `).join(''), delay: 20 }
      : { content: 'Quick report.', delay: 0 }))
    const t = h.thread()
    const done = (await h.agent.send({ threadId: t.id, text: 'research' })).done
    let id = ''
    for (let i = 0; i < 300 && !id; i++) {
      id = h.teams().flat().find((m) => m.title === 'Part 2' && m.status === 'working')?.id ?? ''
      if (!id) await new Promise((r) => setTimeout(r, 10))
    }
    await new Promise((r) => setTimeout(r, 60))
    expect(h.agent.cancelHelper(id)).toBe(true)
    expect(await done).toBe('finished')
    const final = h.teams().at(-1)!
    expect(final.map((m) => m.status)).toEqual(['done', 'stopped', 'done'])
    expect(h.db.listMessages(t.id).at(-1)?.content).toBe('Here is the compiled answer.')
  })

  test('Stop remaining: queued helpers never start and working ones stop', async () => {
    const h = harness([SONNET], { swarm: { askAboveUsd: 100, helperModel: 'same', maxParallel: 1 } } as never)
    leadAndHelpers(tasks(4), () => ({ content: Array.from({ length: 100 }, (_, i) => `w${i} `).join(''), delay: 10 }))
    const t = h.thread()
    const done = (await h.agent.send({ threadId: t.id, text: 'research' })).done
    let callId = ''
    for (let i = 0; i < 300 && !callId; i++) {
      const ev = h.events.find((e): e is Extract<ChatEvent, { type: 'team' }> => e.type === 'team' && e.members.some((m) => m.status === 'working'))
      callId = ev?.callId ?? ''
      if (!callId) await new Promise((r) => setTimeout(r, 10))
    }
    expect(h.agent.stopRemaining(callId)).toBe(4)
    expect(await done).toBe('finished')
    expect(h.teams().at(-1)!.every((m) => m.status === 'stopped')).toBe(true)
    expect(llm.requests.filter(isHelper)).toHaveLength(1)
  })
})

// ------------------------------------------------------------------------------------------------

/** Mock replies for Heavy, scripted by system prompt markers. */
function heavyRouter(o: { recheck?: boolean; answers?: Record<number, string> } = {}) {
  const seen = { judge: 0, final: 0, recheck: 0, attempts: new Map<number, number>() }
  route((r) => {
    const sys = sysOf(r)
    const user = lastUser(r)
    if (sys.includes('[HEAVY-JUDGE]')) {
      seen.judge++
      return { delay: 0, content: JSON.stringify({
        agreements: ['The answer is a two-digit number'],
        disagreements: [{ point: '41 or 42', attempts: [1, 2] }],
        errors: [{ attempt: 2, issue: 'Off by one' }],
        unsupported: [{ attempt: 3, claim: 'It was 42 in 1999' }],
        recheck: o.recheck === false ? null : { attempt: 2, question: 'Is it 41 or 42?' },
        summary: 'Attempts 1 and 3 agree.'
      }) }
    }
    if (user.includes('[HEAVY-FINAL]')) { seen.final++; return { content: 'The answer is 42 [A1][A3].', delay: 0 } }
    const n = Number(sys.match(/Heavy attempt (\d+) of/)?.[1])
    if (n) {
      if (user.includes('[From the judge]')) { seen.recheck++; return { content: 'Rechecked: it is 42 after all.', delay: 0 } }
      seen.attempts.set(n, (seen.attempts.get(n) ?? 0) + 1)
      return { content: o.answers?.[n] ?? `Attempt ${n} says ${n === 2 ? 41 : 42}.\n\nEvidence: worked it out.`, delay: 0 }
    }
    return { content: 'Plain answer.', delay: 0 }
  })
  return seen
}

const heavyCard = (h: ReturnType<typeof harness>, t: Thread): HeavyBoard | undefined =>
  h.db.listMessages(t.id).map((m) => heavyOf(m)?.board).find(Boolean)

describe('Heavy mode', () => {
  test('N attempts on a model mix, a judge compares them, re-checks the contested point once, and writes the final answer', async () => {
    const h = harness([SONNET, OPUS, GPT], { swarm: { askAboveUsd: 100 }, heavy: { attempts: 3, mix: 'auto' } } as never)
    const seen = heavyRouter()
    const t = h.thread('claude-sonnet-5-5', h.main.id)
    expect(await (await h.agent.send({ threadId: t.id, text: 'What is the answer?', heavy: true })).done).toBe('finished')
    // 2 x the lead's... with 3 attempts: the lead's, the strongest, another provider's.
    const attemptModels = llm.requests.filter((r) => /Heavy attempt \d+ of 3/.test(sysOf(r)) && !lastUser(r).includes('[From the judge]')).map((r) => [Number(sysOf(r).match(/Heavy attempt (\d+)/)![1]), r.model]).sort()
    expect(attemptModels).toEqual([[1, 'claude-sonnet-5-5'], [2, 'claude-opus-5-5'], [3, 'gpt-6']])
    // A non-Claude attempt gets its own temperature (attempt 3: 1.0).
    expect(llm.requests.find((r) => /Heavy attempt 3 of 3/.test(sysOf(r)))?.temperature).toBe(1)
    expect(seen.judge).toBe(1)
    expect(seen.recheck).toBe(1)
    expect(seen.final).toBe(1)
    const judgeReq = llm.requests.find((r) => sysOf(r).includes('[HEAVY-JUDGE]'))!
    expect(judgeReq.model).toBe('claude-opus-5-5')
    expect(lastUser(judgeReq)).toContain('Attempt 2 says 41.')
    const finalReq = llm.requests.find((r) => lastUser(r).includes('[HEAVY-FINAL]'))!
    expect(finalReq.model).toBe('claude-opus-5-5')
    expect(lastUser(finalReq)).toContain('Re-check asked of attempt 2: Is it 41 or 42?')
    expect(lastUser(finalReq)).toContain('Rechecked: it is 42 after all.')
    expect(finalReq.tools ?? []).toEqual([])
    const ms = h.db.listMessages(t.id)
    const answer = ms.filter((m) => m.role === 'assistant' && m.kind === 'normal').at(-1)!
    expect(answer.content).toBe('The answer is 42 [A1][A3].')
    expect(answer.model).toBe('claude-opus-5-5')
    const board = heavyCard(h, t)!
    expect(board.attempts.map((a) => a.status)).toEqual(['done', 'done', 'done'])
    expect(board.attempts[1].rechecked).toBe(true)
    expect(board.judge.status).toBe('done')
    expect(board.judge.verdict).toMatchObject({ disagreements: [{ point: '41 or 42', attempts: [1, 2] }], recheck: { attempt: 2, answer: 'Rechecked: it is 42 after all.' } })
    expect(board.attempts[0].answer).toContain('Attempt 1 says 42.')
    // The attempts' work stays out of the chat: only the card (a notice) and the final answer are added.
    expect(ms.filter((m) => m.role === 'assistant').map((m) => m.kind)).toEqual(['notice', 'normal'])
  })

  test('no recheck when the judge doesn\'t ask for one; same-model mix with spread temperatures on a local model, no cost card', async () => {
    const h = harness([local('qwen-test', 2)], { heavy: { attempts: 2 }, swarm: { askAboveUsd: 0 } } as never)
    const seen = heavyRouter({ recheck: false })
    const t = h.thread()
    expect(await (await h.agent.send({ threadId: t.id, text: 'Hard question', heavy: true })).done).toBe('finished')
    expect(h.agent.pending(t.id)).toHaveLength(0)
    expect(seen.recheck).toBe(0)
    expect(seen.attempts.size).toBe(2)
    const temps = llm.requests.filter((r) => /Heavy attempt/.test(sysOf(r))).map((r) => r.temperature).sort()
    expect(new Set(temps).size).toBe(2)
    expect(llm.requests.every((r) => r.model === 'qwen-test')).toBe(true)
    expect(heavyPlan({ cfg: heavyConfig({ attempts: 4 }), lead: 'qwen-test', usable: [local('qwen-test', 2)], cloud: () => false })).toEqual({ models: Array(4).fill('qwen-test'), judge: 'qwen-test', estimate: 0 })
  })

  test('above the threshold it asks first; a no ends it before anything is spent', async () => {
    const h = harness([SONNET, OPUS], { heavy: { attempts: 3, mix: 'same' }, swarm: { askAboveUsd: 0.05 } } as never)
    heavyRouter()
    const t = h.thread('claude-sonnet-5-5', h.main.id)
    const done = (await h.agent.send({ threadId: t.id, text: 'Q?', heavy: true })).done
    const req = await answerNext(h.agent, t.id, 'deny')
    expect(req.summary).toMatch(/^Run Heavy: 3 attempts \(3× CLAUDE-SONNET-5-5\) \+ judge CLAUDE-OPUS-5-5 · est\. \$\d+\.\d\d · cap \$5\.00$/)
    expect(req.spend?.kind).toBe('heavy')
    expect(await done).toBe('stopped')
    expect(llm.requests).toHaveLength(0)
    expect(h.db.listMessages(t.id).some((m) => m.kind === 'notice' && /Heavy run cancelled/.test(m.content))).toBe(true)
  })

  test('unattended runs can\'t start Heavy', async () => {
    const h = harness([SONNET])
    const t = h.thread()
    await expect(h.agent.send({ threadId: t.id, text: 'Q?', heavy: true }, { unattended: true })).rejects.toThrow(/can't run unattended/)
    expect(h.db.listMessages(t.id)).toHaveLength(0)
    expect(llm.requests).toHaveLength(0)
  })

  test('Heavy replaces Team, Deep Research and Plan first for the message (no notes for them)', async () => {
    const h = harness([local('qwen-test', 2)], { heavy: { attempts: 2 } } as never)
    heavyRouter({ recheck: false })
    const t = h.thread()
    expect(await (await h.agent.send({ threadId: t.id, text: 'Q?', heavy: true, team: true, deepResearch: true, planFirst: true })).done).toBe('finished')
    const user = h.db.listMessages(t.id).find((m) => m.role === 'user')!
    expect(user.meta).toMatchObject({ heavy: true })
    expect(user.meta?.team).toBeUndefined()
    expect(String(user.meta?.note ?? '')).not.toMatch(/Team of Experts|Deep Research|Plan first/)
  })

  test('parseVerdict: lenient JSON, attempt numbers kept in range', () => {
    const v = parseVerdict('Here:\n```json\n{"agreements":["a"],"disagreements":[{"point":"p","attempts":[1,9]}],"errors":[{"attempt":7,"issue":"x"}],"unsupported":[],"recheck":{"attempt":2,"question":"q?"}}\n```', 3)
    expect(v).toMatchObject({ agreements: ['a'], disagreements: [{ point: 'p', attempts: [1] }], errors: [], recheck: { attempt: 2, question: 'q?' } })
    expect(parseVerdict('not json at all', 3)).toMatchObject({ agreements: [], summary: 'not json at all' })
  })

  test('model mix and judge on the cloud: 2× the lead, 1× the strongest, 1× another provider', () => {
    const usable = [SONNET, OPUS, GPT, cloud('claude-fable-5-1', 3, { rank: 99 })]
    expect(heavyMix('claude-sonnet-5-5', 'auto', usable, 4, true)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'gpt-6'])
    expect(judgeModelFor('claude-sonnet-5-5', usable, true)).toBe('claude-opus-5-5')
    expect(heavyMix('claude-sonnet-5-5', ['claude-opus-5-5', 'nope'], usable, 3, true)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5'])
    expect(heavyMix('claude-sonnet-5-5', 'auto', [SONNET], 2, true)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5'])
  })
})

describe('UI plumbing', () => {
  test('the composer\'s mode flags: Heavy replaces the others; Deep Research brings the team', () => {
    expect(modeFlags({ heavy: true, team: true, deep: true, planFirst: true })).toEqual({ team: false, deepResearch: false, planFirst: false, heavy: true })
    expect(modeFlags({ deep: true })).toEqual({ team: true, deepResearch: true, planFirst: false })
    expect(modeFlags({ team: true, planFirst: true })).toEqual({ team: true, deepResearch: false, planFirst: true })
  })

  test('team board groups by status (busiest first) with totals; a Heavy card is read off its notice', () => {
    const m = (id: string, status: TeamMember['status'], usd?: number, tokens?: number): TeamMember => ({ id, title: id, status, depth: 1, usd, tokens })
    const groups = groupMembers([m('a', 'done', 0.1, 100), m('b', 'working', 0.05, 50), m('c', 'queued'), m('d', 'done')])
    expect(groups.map((g) => [g.status, g.members.length])).toEqual([['working', 1], ['queued', 1], ['done', 2]])
    expect(teamTotals([m('a', 'done', 0.1, 100), m('b', 'working', 0.05, 50)])).toEqual({ usd: expect.closeTo(0.15, 9), tokens: 150 })
    const board: HeavyBoard = { attempts: [], judge: { model: 'x', status: 'waiting' } }
    expect(heavyOf({ kind: 'notice', meta: { heavy: board, heavyId: 'heavy-1' } })).toEqual({ board, id: 'heavy-1' })
    expect(heavyOf({ kind: 'normal', meta: { heavy: board } })).toBeUndefined()
  })
})

// EHA-01 (round 3): a helper that hangs is a stall of the lead's chat. The team card is sent only when something
// changed, so an unchanged board no longer counts as a sign of life and the watchdog can say what is stuck.
describe('a hung helper', () => {
  test('the lead chat gets the stall note while its helper says nothing', async () => {
    process.env.FOREMAN_STALL_MS = '2000'
    try {
      const h = harness([SONNET], { swarm: { askAboveUsd: 100 } } as never)
      leadAndHelpers(tasks(1), () => ({ reasoning: 'thinking about it slowly ', content: 'A report.', delay: 1600 }))
      const t = h.thread()
      expect(await (await h.agent.send({ threadId: t.id, text: 'research' })).done).toBe('finished')
      const notes = h.events.filter((e) => e.type === 'tool_progress' && e.threadId === t.id && e.callId === 'watchdog')
      expect(notes.length).toBeGreaterThan(0)
      expect(notes.some((e) => (e as { stuck?: boolean }).stuck)).toBe(true)
    } finally { delete process.env.FOREMAN_STALL_MS }
  }, 30_000)
})
