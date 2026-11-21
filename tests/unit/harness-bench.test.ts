import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import type { ToolDef } from '../../src/main/agent/types'
import { Db } from '../../src/main/db'
import type { ChatEvent, ModelInfo, Settings } from '../../src/shared/types'
import { startMockLlm, lastToolOutput, type MockLlm } from '../fixtures/mock-llm'

// Harness benchmark: the same scripted model (it behaves the way real models slip: announcing instead of
// acting, asking permission mid-task, polling a job in a tight loop, stopping at a sign-in wall) runs four
// tasks through the agent harness. A simulated user steps in only when the run stops unfinished or a card
// still waits after 3 seconds; every step-in counts against the harness. Scores:
//   autonomy  share of tasks finished with no step-in at all
//   index     per task: 100 finished alone, 50 finished after step-ins, 0 not finished; times step
//             efficiency (the fewest model steps the task needs / the steps used), averaged
// Run: HARNESS_BENCH=1 npx vitest run tests/unit/harness-bench.test.ts (writes HARNESS_BENCH_OUT, a JSON file).

process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'

// Real mode (HARNESS_BENCH_REAL=1 with ANTHROPIC_API_KEY): Claude Sonnet 5.5 does the same tasks itself, no script.
// A hard cap on requests (HARNESS_BENCH_MAX_REQUESTS, default 60 per run) keeps the spend bounded.
const REAL = process.env.HARNESS_BENCH_REAL === '1' && !!process.env.ANTHROPIC_API_KEY
const MAX_REQUESTS = Number(process.env.HARNESS_BENCH_MAX_REQUESTS) || 60
const model: ModelInfo = REAL
  ? { id: 'claude-sonnet-5-5', provider: 'anthropic', providerName: 'Anthropic', enabled: true, installed: true, label: 'Claude Sonnet 5.5', vision: true, tier: 2, requiredGB: 0, note: 'remote', contextTokens: 1_000_000, maxFittingWindow: 1_000_000, fits: true, tools: true, price: { input: 2, output: 10 } } as ModelInfo
  : { id: 'bench-model', provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: 'Bench', vision: false, tier: 3, requiredGB: 1, maxFittingWindow: 131072, fits: true, tools: true } as ModelInfo
let realRequests = 0
let realTokens = { input: 0, output: 0 }
if (REAL) {
  process.env.FOREMAN_NO_BRAIN = '1'
  const real = globalThis.fetch
  // Counts requests to Anthropic (and stops past the cap) and reads token usage from the streamed events.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (!url.includes('api.anthropic.com')) return real(input as never, init)
    if (++realRequests > MAX_REQUESTS) throw new Error('Benchmark request cap reached')
    const res = await real(input as never, init)
    if (!res.body) return res
    const [a, b] = res.body.tee()
    void (async () => {
      const text = await new Response(b).text()
      for (const m of text.matchAll(/"input_tokens":(\d+)/g)) realTokens.input += Number(m[1])
      for (const m of text.matchAll(/"cache_read_input_tokens":(\d+)/g)) realTokens.input += Number(m[1]) * 0.1
      const outs = [...text.matchAll(/"output_tokens":(\d+)/g)].map((m) => Number(m[1]))
      if (outs.length) realTokens.output += Math.max(...outs)
    })().catch(() => undefined)
    return new Response(a, { status: res.status, statusText: res.statusText, headers: res.headers })
  }) as typeof fetch
}

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })

const tool = (name: string, run: ToolDef['run']): ToolDef => ({
  name, label: name, effect: 'read', description: `${name} (benchmark tool)`,
  parameters: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: true }, run
})

interface Scenario {
  name: string
  prompt: string
  /** Fewest model steps a perfect run takes. */
  optimal: number
  tools: (s: { done: boolean }) => ToolDef[]
  /** The scripted model: a reply from the request so far. */
  policy: (req: Record<string, any>, s: Record<string, number>) => { content?: string; toolCalls?: Array<{ name: string; arguments: string }> }
}

/** Anything new from the harness or the user since the task was given (wording-blind: the bench never keys on nudge text). */
const userTurns = (req: Record<string, any>): number => req.messages.filter((m: any) => m.role === 'user').length
const called = (req: Record<string, any>, name: string): number => req.messages.filter((m: any) => m.role === 'assistant').flatMap((m: any) => m.tool_calls ?? []).filter((c: any) => c.function?.name === name).length
const call = (name: string, args: Record<string, unknown> = {}) => ({ toolCalls: [{ name, arguments: JSON.stringify(args) }] })

const SCENARIOS: Scenario[] = [
  {
    name: 'Says it, doesn\'t do it (announces publishing, no tool call)',
    prompt: 'Publish the clicks post and send me the live link.',
    optimal: 2,
    tools: (s) => [tool('publish_post', async () => { s.done = true; return { text: 'Published at https://blog.example/clicks' } })],
    policy: (req) => {
      if (called(req, 'publish_post')) return { content: 'It\'s live: https://blog.example/clicks' }
      // First the slip; any further message (a harness nudge or the user saying go) makes it act.
      if (userTurns(req) > 1) return call('publish_post', { q: 'clicks' })
      return { content: 'Publishing the clicks post now. I\'ll send you the live link once it\'s up.' }
    }
  },
  {
    name: 'Asks permission mid-task ("Want me to…?")',
    prompt: 'Research the three cheapest flights to Lisbon and save them to a note.',
    optimal: 3,
    tools: (s) => [tool('search_flights', async () => ({ text: 'TAP $412, Iberia $430, United $455' })), tool('save_note', async () => { s.done = true; return { text: 'Saved note "Lisbon flights"' } })],
    policy: (req) => {
      if (called(req, 'save_note')) return { content: 'Saved the three cheapest flights to the note "Lisbon flights".' }
      if (!called(req, 'search_flights')) return call('search_flights', { q: 'Lisbon' })
      if (userTurns(req) > 1) return call('save_note', { q: 'Lisbon flights' })
      return { content: 'I found TAP $412, Iberia $430 and United $455. Want me to save these to a note?' }
    }
  },
  {
    name: 'Polling loop (a job status that changes every check)',
    prompt: 'Deploy the site and tell me when it\'s live.',
    optimal: 5,
    tools: (s) => {
      let polls = 0
      let slept = false
      return [
        tool('deploy', async () => ({ text: 'Deploy started (job 7).' })),
        tool('job_status', async () => { polls++; const live = slept || polls >= 14; if (live) s.done = true; return { text: live ? 'job 7: live at https://site.example' : `job 7: building (${polls * 7}%) at ${new Date().toISOString()}` } }),
        tool('sleep', async () => { slept = true; return { text: 'waited 30 seconds' } })
      ]
    },
    policy: (req) => {
      if (!called(req, 'deploy')) return call('deploy')
      const out = lastToolOutput(req)
      if (/live at/.test(out)) return { content: 'The site is live at https://site.example.' }
      // Any note the harness attaches to a result (whatever it says) makes it wait once instead of polling.
      if (/\[From the app\]/.test(out)) return call('sleep', { q: '30' })
      return call('job_status', { q: '7' })
    }
  },
  {
    name: 'Sign-in wall (the user signs in on the page a moment later)',
    prompt: 'Open my analytics dashboard and tell me this week\'s visitors.',
    optimal: 2,
    tools: (s) => [tool('open_dashboard', async (_a, ctx) => {
      const signedInAt = Date.now() + 1000
      const signedIn = async (): Promise<boolean> => Date.now() >= signedInAt
      // The harness's own way to wait for the user, when it has one; otherwise it can only ask.
      const answer = ctx.waitForUser ? await ctx.waitForUser('Please sign in to the dashboard.', signedIn, { everyMs: 1000, timeoutMs: 20_000 }) : await ctx.askUser('Please sign in to the dashboard, then press Done.', ['Done'])
      if (!/done/i.test(answer) || !(await signedIn())) return { text: 'Still not signed in.' }
      s.done = true
      return { text: 'Dashboard: 12,480 visitors this week.' }
    })],
    policy: (req) => (called(req, 'open_dashboard') ? { content: 'You had 12,480 visitors this week.' } : call('open_dashboard'))
  }
]

async function runScenario(sc: Scenario): Promise<{ name: string; finished: boolean; stepIns: number; steps: number; score: number }> {
  const db = new Db(':memory:')
  const settings = {
    contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true },
    workspaceDir: mkdtempSync(join(tmpdir(), 'bench-ws-')), userName: 'Sam', defaultModel: model.id, hiddenModels: [], shownModels: [],
    cloud: { enabled: REAL, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: []
  } as unknown as Settings
  const state = { done: false }
  const before = realRequests
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'bench-res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), ...sc.tools(state))
  const events: ChatEvent[] = []
  const last = { ok: true, models: [model], budgetGB: 32, totalGB: 64, providers: [] }
  let stepIns = 0
  let agent!: Agent
  const space = db.createSpace('Bench', '#000000')
  const thread = db.createThread(space.id, 'auto', model.id)
  agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: { last, for: () => (REAL ? { provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: process.env.ANTHROPIC_API_KEY } : { provider: 'custom', baseUrl: llm.url }), usable: () => [model], list: async () => last, advisor: () => undefined } as never,
    spaces: { getPrompt: () => '' } as never,
    memory: { block: () => '' } as never,
    emit: (e: ChatEvent) => {
      events.push(e)
      // A card still waiting after 3 seconds: the user has to answer it (a step-in).
      if (e.type === 'pending') setTimeout(() => { if (agent.pending(thread.id).some((p) => p.id === e.request.id)) { stepIns++; agent.respond(thread.id, e.request.id, 'Done') } }, 3000)
    },
    secretValues: () => [],
    fitWindow: (_m: string, w: number) => w,
    counter: () => ({ count: async (t: string) => estimate(t) })
  } as never)
  const flags: Record<string, number> = {}
  llm.script.length = 0
  llm.requests.length = 0
  for (let i = 0; i < 60; i++) llm.script.push((req) => sc.policy(req, flags))
  await (await agent.send({ threadId: thread.id, text: sc.prompt })).done
  // Stopped unfinished: the user has to say "go ahead" (up to twice).
  for (let i = 0; i < 2 && !state.done; i++) { stepIns++; await (await agent.send({ threadId: thread.id, text: 'Yes, go ahead and do it.' })).done }
  const steps = REAL ? realRequests - before : llm.requests.length
  const base = state.done ? (stepIns === 0 ? 100 : 50) : 0
  const score = Math.round(base * Math.min(1, sc.optimal / Math.max(1, steps)))
  return { name: sc.name, finished: state.done, stepIns, steps, score }
}

describe.skipIf(!process.env.HARNESS_BENCH)('harness benchmark', () => {
  test('autonomy and step efficiency across the scenarios', async () => {
    const rows = []
    for (const sc of SCENARIOS) rows.push(await runScenario(sc))
    const index = Math.round(rows.reduce((a, r) => a + r.score, 0) / rows.length)
    const autonomy = Math.round((rows.filter((r) => r.finished && r.stepIns === 0).length / rows.length) * 100)
    const report = { model: model.id, index, autonomy, stepIns: rows.reduce((a, r) => a + r.stepIns, 0), steps: rows.reduce((a, r) => a + r.steps, 0), ...(REAL ? { tokens: realTokens, estUsd: Math.round(((realTokens.input * 2 + realTokens.output * 10) / 1e6) * 100) / 100 } : {}), rows }
    if (process.env.HARNESS_BENCH_OUT) writeFileSync(process.env.HARNESS_BENCH_OUT, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    expect(rows.length).toBe(SCENARIOS.length)
  }, 240_000)
})
