import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ChatEvent, ModelInfo, Settings, Thread } from '../../src/shared/types'
import { effectiveClaudeText, startFakeAnthropic, startFakeOpenAI, type ClaudeRecord, type FakeAnthropic, type FakeOpenAI } from '../fixtures/fake-providers'

// Endurance: the real agent loop (loop.ts → context.ts → client.ts → anthropic.ts / the chat-completions
// path) driven through long scripted tasks against fake providers on 127.0.0.1. No paid calls, no real keys,
// no network: a fetch guard below refuses any host that isn't this machine.
//
// What a long task must survive, measured on every request the fake servers receive:
// - the window: no request past the context strategy's window (Claude) or the server's limit (local);
// - compaction at the right time: Claude asks for server-side compaction at compactionTrigger(window), and
//   history before a compaction block is never resent; local models summarize before they overflow;
// - the prompt cache: the previous request is a prefix of the next (append-only), so cached prefix reads
//   dominate the bill and preserved thinking is never dropped;
// - tool_use / tool_result pairs are never orphaned, also after a stop and a restart from the database;
// - needles: the user's goal (verbatim), their constraints, the plan and its statuses, decisions, file paths
//   and the facts the next step needs are still in the request at the end, however lossy the summaries.

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error(`endurance tests never reach the network (blocked ${url.host})`)
  return realFetch(input, init)
}) as typeof fetch

process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'

let claude: FakeAnthropic
beforeAll(async () => {
  claude = await startFakeAnthropic()
  // The SDK reads its base URL from here: every Claude request goes to the fake.
  process.env.ANTHROPIC_BASE_URL = claude.url
})
afterAll(async () => { await claude?.close() })

const { Agent, HARD_CAP } = await import('../../src/main/agent/loop')
const { ResultStore } = await import('../../src/main/agent/context')
const { ToolRegistry } = await import('../../src/main/agent/registry')
const { coreTools } = await import('../../src/main/agent/tools/core')
const { Db } = await import('../../src/main/db')
const { ANTHROPIC_URL } = await import('../../src/main/llm/providers')
const { spendHooks } = await import('../../src/main/llm/client')
const { cost } = await import('../../src/main/llm/budget')
const { claudeWindow, compactionTrigger } = await import('../../src/main/llm/claude-models')
import type { ToolDef } from '../../src/main/agent/types'
import type { ContextStrategy } from '../../src/main/llm/claude-models'

// ---------------------------------------------------------------------------------------------------
// The task: audit contracts. Needles are planted in the first steps and must survive to the end.
// ---------------------------------------------------------------------------------------------------

const GOAL = 'Audit every vendor contract in /data/contracts and write the findings to /data/out/report.md. Constraints: never email anyone; use metric units only; stay under a $350 budget. The project codename is HERON-7.'
const STEER = 'One more rule: do not touch anything in /data/legal.'
const FACT = 'Primary vendor id is VX-4471 (renewal date 2027-03-14).'
const DECISION = 'Decision: findings table uses CSV with semicolons.'
const NEEDLES = ['never email anyone', 'use metric units only', '$350 budget', 'HERON-7', '/data/legal', 'VX-4471', 'CSV with semicolons', '/data/out/part-']

/** Deterministic filler text of about `tokens` tokens (at the fake's 3.2 chars per token). */
function filler(label: string, tokens: number): string {
  const lines: string[] = []
  let chars = 0
  for (let i = 1; chars < tokens * 3.2; i++) {
    const line = `${label} line ${i}: clause ${(i * 7919) % 1000} sets the term at ${(i * 31) % 97} months and the fee at ${(i * 13) % 500} EUR.`
    lines.push(line)
    chars += line.length + 1
  }
  return lines.join('\n')
}

const readBig: ToolDef<{ path: string }> = {
  name: 'read_contract', label: 'Read contract', core: true, effect: 'read', description: 'Read a contract file in full.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  async run({ path }) {
    const k = Number(path.match(/(\d+)/)?.[1] ?? 1)
    // 20-60K tokens, and the first one carries a fact the end of the task needs.
    return { text: `${k === 4 ? `${FACT}\n` : ''}${filler(path, 20_000 + ((k * 7) % 5) * 10_000)}` }
  }
}
const fetchWeb: ToolDef<{ url: string }> = {
  name: 'vendor_page', label: 'Vendor page', core: true, effect: 'read', untrusted: true, description: 'Read a vendor web page.',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
  async run({ url }) { return { text: filler(url, 20_000) } }
}
const written: string[] = []
const writeOut: ToolDef<{ path: string; text: string }> = {
  name: 'write_part', label: 'Write part', core: true, effect: 'write_local', description: 'Write a section of the report.',
  parameters: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'], additionalProperties: false },
  async run({ path }) { written.push(path); return { text: `Wrote ${path}`, path } }
}

const PLAN = Array.from({ length: 12 }, (_, i) => `Audit contract batch ${i + 1}`)
const todo = (done: number, notes?: string) => ({
  name: 'todo',
  input: { items: PLAN.map((text, i) => ({ text, status: i < done ? 'done' : i === done ? 'in_progress' : 'pending' })), ...(notes !== undefined ? { notes } : {}) }
})

/** The scripted model: one action per step, a plan update every 10 steps, all done at the end. */
function action(n: number, total: number): { name: string; input: Record<string, unknown> } | undefined {
  if (n === 1) return todo(0)
  if (n >= total) return undefined
  if (n === total - 1) return todo(PLAN.length, `${DECISION} Files so far: /data/out/part-3.md and later parts.`)
  if (n === 5) return todo(0, `${DECISION} ${FACT}`)
  if (n % 10 === 0) return todo(Math.min(PLAN.length - 1, Math.floor((n / total) * PLAN.length)), `${DECISION} ${FACT} Files: /data/out/part-3.md onward.`)
  if (n % 3 === 1) return { name: 'read_contract', input: { path: `/data/contracts/c${n}.txt` } }
  if (n % 3 === 2) return { name: 'vendor_page', input: { url: `https://vendors.example/p${n}` } }
  return { name: 'write_part', input: { path: `/data/out/part-${n}.md`, text: `Findings for batch ${n}: all fees in EUR, lengths in metres.` } }
}

// ---------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------

const claudeModel: ModelInfo = { id: 'claude-opus-5-5', provider: 'anthropic', providerName: 'Anthropic', enabled: true, installed: true, label: 'Claude Opus 5.5', vision: true, tools: true, tier: 3, requiredGB: 0, maxFittingWindow: 131072, fits: true, note: 'remote', contextTokens: 1_000_000 } as ModelInfo
const localModel: ModelInfo = { id: 'local-27b', provider: 'custom', providerName: 'Custom', enabled: true, installed: true, label: 'Local 27B', vision: false, tools: true, tier: 2, requiredGB: 18, maxFittingWindow: 262144, fits: true } as ModelInfo

function harness(o: { model: ModelInfo; baseUrl: string; strategy?: ContextStrategy; contextWindow?: number; db?: InstanceType<typeof Db>; dirs?: { ws: string; res: string } }) {
  const db = o.db ?? new Db(':memory:')
  const dirs = o.dirs ?? { ws: mkdtempSync(join(tmpdir(), 'ws-')), res: mkdtempSync(join(tmpdir(), 'res-')) }
  const settings = {
    contextWindow: o.contextWindow ?? 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'high', advanced: { hardStopsEnabled: true },
    workspaceDir: dirs.ws, userName: 'Sam', defaultModel: o.model.id, hiddenModels: [], shownModels: [], customRules: [],
    cloud: { enabled: true, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0, contextStrategy: o.strategy ?? 'balanced', nativeTools: true },
    keys: o.model.provider === 'anthropic' ? { anthropic: true } : {}, search: { provider: 'none' }
  } as unknown as Settings
  const results = new ResultStore(dirs.res)
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), readBig, fetchWeb, writeOut)
  const events: ChatEvent[] = []
  const last = { ok: true, models: [o.model], budgetGB: 32, totalGB: 64, providers: [] }
  const ep = o.model.provider === 'anthropic' ? { provider: 'anthropic', baseUrl: ANTHROPIC_URL, apiKey: 'sk-ant-api-endurance-fake' } : { provider: 'custom', baseUrl: o.baseUrl }
  const endpoints = { last, for: () => ep, usable: () => [o.model], list: async () => last, advisor: () => undefined }
  // eslint-disable-next-line prefer-const
  let agent: InstanceType<typeof Agent>
  agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: endpoints as never, spaces: { getPrompt: () => '' } as never, memory: { block: () => '' } as never,
    emit: (e) => {
      events.push(e)
      // Approvals are answered like a user who allows the task's own actions.
      if (e.type === 'pending') setTimeout(() => agent.respond(e.threadId, e.request.id, 'allow'), 0)
    },
    // No counter override: the app's own ServerTokenCounter (the fakes have no /tokenize, like LM Studio and the cloud).
    secretValues: () => [], fitWindow: (_m, w) => w
  })
  const space = db.listSpaces()[0] ?? db.createSpace('Auditor', '#000000', { isMain: true })
  const thread = (): Thread => db.createThread(space.id, 'autonomous', o.model.id)
  return { db, dirs, agent, events, settings, thread, run: async (t: Thread, text: string) => (await agent.send({ threadId: t.id, text })).done }
}

/** The Claude model: steps through the task; plants the steer at step 3. */
function scriptClaude(total: number, h: { agent: InstanceType<typeof Agent> }, threadId: () => string, offset = 0) {
  claude.respond = (body, { n }) => {
    const k = n - offset
    if (k === 3) void h.agent.steer(threadId(), STEER)
    // Step 8 reads the middle of an offloaded result (read_result isn't in the initial tool list).
    const saved = k === 8 ? JSON.stringify(body.messages.at(-1)).match(/id=\\"(r-[\w-]+)\\"/)?.[1] : undefined
    const a = saved ? { name: 'read_result', input: { id: saved, start: 40, end: 60 } } : action(k, total)
    return a ? { thinking: `Step ${k}: next is ${a.name}.`, tools: [a] } : { thinking: 'Wrapping up.', text: 'Audit finished: the report is in /data/out/report.md.' }
  }
}

interface Stats { requests: number; maxTokens: number; compactions: number; appendBreaks: number; divergedTools: number; divergedSystem: number; divergedMessages: number; droppedThinking: number; cacheShare: number; usd: number; orphans: number; ignoredAfter: number }
function stats(rs: ClaudeRecord[], usd: number): Stats {
  const main = rs.filter((r) => !r.isSummary)
  const totalIn = main.reduce((x, r) => x + r.cacheRead + r.cacheWrite + r.input, 0)
  // A compaction legitimately restarts the prefix: the request right after one isn't counted as a break.
  const breaks = main.filter((r, i) => !r.appendOnly && !main[i - 1]?.compacted)
  return {
    requests: main.length,
    maxTokens: Math.max(...main.map((r) => r.tokens)),
    compactions: main.filter((r) => r.compacted).length,
    appendBreaks: breaks.length,
    divergedTools: breaks.filter((r) => r.diverged === 'tools').length,
    divergedSystem: breaks.filter((r) => r.diverged === 'system').length,
    divergedMessages: breaks.filter((r) => r.diverged === 'messages').length,
    droppedThinking: main.reduce((x, r) => x + r.droppedThinking, 0),
    cacheShare: totalIn ? main.reduce((x, r) => x + r.cacheRead, 0) / totalIn : 0,
    usd,
    orphans: main.reduce((x, r) => x + r.orphans.length, 0),
    // The "(continue)" opener the API needs before a compaction turn is all that may precede it.
    ignoredAfter: main.filter((r, i) => i > 0 && main.slice(0, i).some((p) => p.compacted) && r.ignored > 16).length
  }
}

let spent = 0
spendHooks.after = (req, input, output, served) => { spent += cost(served, input, output) }

// ---------------------------------------------------------------------------------------------------
// 1. Claude, server-side compaction, across context strategies
// ---------------------------------------------------------------------------------------------------

describe('Claude: long runs with server-side compaction', () => {
  const cases: Array<{ strategy: ContextStrategy; steps: number }> = [
    { strategy: 'economy', steps: 320 },
    { strategy: 'balanced', steps: 140 },
    { strategy: 'max', steps: 90 }
  ]
  for (const c of cases) {
    test(`${c.strategy}: ${c.steps} steps stay in the window, compact at the trigger, keep the cache and the needles`, async () => {
      claude.reset()
      written.length = 0
      spent = 0
      const h = harness({ model: claudeModel, baseUrl: ANTHROPIC_URL, strategy: c.strategy })
      const t = h.thread()
      scriptClaude(c.steps, h, () => t.id)
      expect(await h.run(t, GOAL)).toBe('finished')
      const window = claudeWindow(claudeModel.id, c.strategy)
      const s = stats(claude.records, spent)
      console.log(`[endurance] claude ${c.strategy}`, JSON.stringify(s))
      // Every step reached the model, none past the window, compaction asked for at the right threshold.
      expect(s.requests).toBeGreaterThanOrEqual(c.steps)
      expect(s.maxTokens).toBeLessThanOrEqual(window)
      for (const r of claude.records.filter((x) => !x.isSummary)) expect(r.trigger).toBe(compactionTrigger(window))
      expect(s.compactions).toBeGreaterThanOrEqual(1)
      // Nothing before a compaction block is resent, and no call loses its result.
      expect(s.ignoredAfter).toBe(0)
      expect(s.orphans).toBe(0)
      // The cache: append-only between compactions, so thinking is never dropped and reads dominate.
      expect(s.appendBreaks).toBe(0)
      expect(s.droppedThinking).toBe(0)
      expect(s.cacheShare).toBeGreaterThan(0.8)
      // The needles: the goal verbatim, the constraints, the steer, the plan, decisions and paths.
      const text = effectiveClaudeText(claude.last!)
      expect(text).toContain(GOAL)
      for (const n of NEEDLES) expect(text, n).toContain(n)
      expect(text).toMatch(/\[x\] Audit contract batch 12/)
    }, 120_000)
  }
})

// ---------------------------------------------------------------------------------------------------
// 2. Chat-completions servers (local and custom), client-side compaction
// ---------------------------------------------------------------------------------------------------

/** The scripted chat-completions model (same task, same needles). */
function scriptChat(server: FakeOpenAI, total: number, h: { agent: InstanceType<typeof Agent> }, threadId: () => string) {
  server.respond = (body, { n }) => {
    if (n === 3) void h.agent.steer(threadId(), STEER)
    const lastTool = [...body.messages].reverse().find((m: { role: string }) => m.role === 'tool')
    const saved = n === 8 ? String(lastTool?.content ?? '').match(/id="(r-[\w-]+)"/)?.[1] : undefined
    const a = saved ? { name: 'read_result', input: { id: saved, start: 40, end: 60 } } : action(n, total)
    return a ? { toolCalls: [{ name: a.name, arguments: a.input }] } : { content: 'Audit finished: the report is in /data/out/report.md.' }
  }
}

describe('chat-completions models: client-side compaction', () => {
  const cases = [
    { name: 'local 32K', window: 32768, steps: 300 },
    { name: 'custom 128K', window: 131072, steps: 200 }
  ]
  for (const c of cases) {
    test(`${c.name}: ${c.steps} steps never overflow, summarize in time, and the model still gets the goal, constraints, plan, decisions and paths`, async () => {
      const server = await startFakeOpenAI(c.window)
      const transcripts: string[] = []
      server.onRequest = (body) => { if (String(body.messages[0]?.content).startsWith('You are compressing')) transcripts.push(String(body.messages[1]?.content)) }
      try {
        written.length = 0
        const h = harness({ model: localModel, baseUrl: server.url, contextWindow: c.window })
        const t = h.thread()
        scriptChat(server, c.steps, h, () => t.id)
        expect(await h.run(t, GOAL)).toBe('finished')
        const main = server.records.filter((r) => !r.isSummary)
        const breaks = main.filter((r, i) => i > 0 && !r.appendOnly).length
        const markers = h.db.listMessages(t.id).filter((m) => m.kind === 'compacted').length
        console.log(`[endurance] ${c.name}`, JSON.stringify({ requests: main.length, maxTokens: Math.max(...main.map((r) => r.tokens)), summaries: server.summaries.length, markers, prefixBreaks: breaks, overflow: server.records.filter((r) => r.overflow).length }))
        expect(main.length).toBeGreaterThanOrEqual(c.steps)
        // Never past the server's limit (prompt + the reply's room), summaries included.
        expect(server.records.filter((r) => r.overflow)).toEqual([])
        expect(server.summaries.length).toBeGreaterThanOrEqual(1)
        expect(markers).toBe(server.summaries.length)
        // Summaries don't run every step (hysteresis): far fewer of them than steps.
        expect(server.summaries.length).toBeLessThan(c.steps / 8)
        // The summarizer saw the goal and the early constraints (the transcript keeps its head).
        expect(transcripts[0]).toContain('never email anyone')
        // The model, after all those (lossy) summaries, still has everything it needs.
        const text = JSON.stringify(server.last!.messages)
        expect(text).toContain(JSON.stringify(GOAL).slice(1, -1))
        for (const n of NEEDLES) expect(text, n).toContain(n)
        expect(text).toMatch(/\[x\] Audit contract batch 12/)
        // Every tool call in the last request has its result right after it, and the history starts with a user turn.
        const msgs = server.last!.messages as Array<{ role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>
        expect(msgs[1].role).toBe('user')
        msgs.forEach((m, i) => {
          for (const tc of m.tool_calls ?? []) expect(msgs.slice(i + 1).find((x) => x.role !== 'tool' || x.tool_call_id === tc.id)?.tool_call_id, tc.id).toBe(tc.id)
        })
      } finally {
        await server.close()
      }
    }, 120_000)
  }
})

// ---------------------------------------------------------------------------------------------------
// 4. Stop mid-task, restart from the database, Continue
// ---------------------------------------------------------------------------------------------------

describe('resume a long Claude task after a stop and a restart', () => {
  test('stopped at step 150 and continued by a fresh Agent: no lost plan, no orphaned calls, no repeated compaction', async () => {
    claude.reset()
    const total = 200
    const h = harness({ model: claudeModel, baseUrl: ANTHROPIC_URL, strategy: 'balanced' })
    const t = h.thread()
    scriptClaude(total, h, () => t.id)
    claude.onRequest = (_b, n) => { if (n === 150) h.agent.stop(t.id) }
    expect(await h.run(t, GOAL)).toBe('stopped')
    claude.onRequest = undefined
    const before = claude.records.filter((r) => !r.isSummary).length
    const plan = h.db.getState(t.id).todos
    expect(plan.length).toBe(PLAN.length)
    // "Restart the app": a new Agent on the same database and result store.
    const h2 = harness({ model: claudeModel, baseUrl: ANTHROPIC_URL, strategy: 'balanced', db: h.db, dirs: h.dirs })
    scriptClaude(total, h2, () => t.id)
    expect(await h2.run(t, 'Continue.')).toBe('finished')
    const after = claude.records.filter((r) => !r.isSummary).slice(before)
    const s = stats(claude.records, 0)
    console.log('[endurance] resume', JSON.stringify({ before, after: after.length, ...s }))
    expect(s.orphans).toBe(0)
    expect(s.ignoredAfter).toBe(0)
    expect(s.droppedThinking).toBe(0)
    // The first request after the restart extends the last one sent before the stop (nothing rebuilt differently).
    expect(after[0].appendOnly).toBe(true)
    // No client-side summary on top of the server's, no compaction without a reason.
    expect(h.db.listMessages(t.id).filter((m) => m.kind === 'compacted')).toEqual([])
    for (const r of claude.records.filter((x) => x.compacted)) expect(r.tokens).toBeGreaterThan(r.trigger!)
    expect(h.db.listMessages(t.id).some((m) => m.status === 'streaming')).toBe(false)
    const text = effectiveClaudeText(claude.last!)
    for (const n of NEEDLES) expect(text, n).toContain(n)
    expect(h.db.getState(t.id).todos.every((x) => x.status === 'done')).toBe(true)
  }, 120_000)
})

// ---------------------------------------------------------------------------------------------------
// 5. Cost and speed sanity
// ---------------------------------------------------------------------------------------------------

describe('cost of a long Claude run', () => {
  test('cache reads carry almost all input after the first steps; the progress chip\'s estimate tracks the bill; a past team doesn\'t keep the 1-hour cache', async () => {
    claude.reset()
    spent = 0
    const h = harness({ model: claudeModel, baseUrl: ANTHROPIC_URL, strategy: 'balanced' })
    h.settings.thinking = 'medium'
    const t = h.thread()
    // A team ran in this chat earlier: its 1-hour TTL must not stick to later runs.
    ;(h.agent as unknown as { teamUsed: Map<string, number> }).teamUsed.set(t.id, 4)
    scriptClaude(120, h, () => t.id)
    const started = Date.now()
    expect(await h.run(t, GOAL)).toBe('finished')
    const ms = Date.now() - started
    const main = claude.records.filter((r) => !r.isSummary)
    const warm = main.slice(3)
    const share = warm.reduce((x, r) => x + r.cacheRead, 0) / warm.reduce((x, r) => x + r.cacheRead + r.cacheWrite + r.input, 0)
    const estimated = h.events.filter((e) => e.type === 'progress' && (e as { cost?: { usd: number } }).cost).reduce((x, e) => x + (e as unknown as { cost: { usd: number } }).cost.usd, 0)
    const misses = warm.filter((r) => r.cacheRead < 0.5 * r.tokens && !main[main.indexOf(r) - 1]?.compacted).length
    console.log('[endurance] cost', JSON.stringify({ steps: main.length, usd: spent, perStep: spent / main.length, estimatedUsd: estimated, cacheShare: share, misses, ms, ttl: [...new Set(main.map((r) => r.ttl ?? '5m'))] }))
    expect(share).toBeGreaterThan(0.9)
    expect(misses).toBe(0)
    expect(estimated / spent).toBeGreaterThan(0.5)
    expect(estimated / spent).toBeLessThan(2)
    expect(main.every((r) => r.ttl === undefined)).toBe(true)
    // The harness overhead per step (app + fake server) stays small.
    expect(ms / main.length).toBeLessThan(100)
    expect(HARD_CAP).toBeGreaterThanOrEqual(300)
  }, 120_000)
})
