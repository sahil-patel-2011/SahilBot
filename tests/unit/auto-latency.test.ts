import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import { Db } from '../../src/main/db'
import { isQuickModel, skipBrain, type BrainAnswer } from '../../src/main/llm/auto-brain'
import { autoRoute } from '../../src/main/llm/auto-route'
import { classifyTask, quickAsk, type TaskCategory } from '../../src/main/llm/task-classifier'
import { modelHealth } from '../../src/main/llm/model-health'
import type { ModelInfo, Settings, Thread } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import EVAL from '../fixtures/routing-eval.json'

// Auto's brain read (a fast cheap model, 1.1-2.2 s live on Luna) runs at the same time as the run's own preparation
// (memories, the vault, the world section, skill hints), so a message waits for the longer of the two, not both.
// Requests the rules read with confidence as small talk, or as obviously quick asks that already land on a quick
// model, skip the read altogether.

const cloud = (id: string, tier: 0 | 1 | 2 | 3, input: number, output: number): ModelInfo => ({ id, provider: 'custom', providerName: 'Cloud', enabled: true, installed: true, label: id, vision: true, tools: true, tier, requiredGB: 0, maxFittingWindow: 131072, contextTokens: 1_000_000, fits: true, note: 'remote', price: { input, output } }) as ModelInfo
const LUNA = cloud('gpt-6-luna', 0, 0.1, 0.5)
const HAIKU = cloud('claude-haiku-5-5', 1, 1, 5)
const TERRA = cloud('gpt-6.1-terra', 1, 1, 5)
const SONNET = cloud('claude-sonnet-5-5', 2, 2, 10)
const OPUS = cloud('claude-opus-5-5', 3, 4, 20)
const SOL = cloud('gpt-6.2-sol', 2, 2, 10)
const ASTRA = cloud('gpt-6.2-astra', 3, 8, 40)
const ALL = [LUNA, HAIKU, TERRA, SONNET, OPUS, SOL, ASTRA]

const answer = (p: Partial<BrainAnswer> = {}): BrainAnswer => ({ category: 'coding', kind: 'agent', difficulty: 2, effort: 'high', study: false, image: false, model: SONNET.id, team: 'solo', needs: ['coding'], fanout: 0, why: 'routine fix', ...p })

process.env.FOREMAN_NO_AUTOTITLE = '1'
let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
afterEach(() => { llm.script.length = 0; llm.requests.length = 0; modelHealth.clear(); delete process.env.FOREMAN_NO_VERIFY; delete process.env.FOREMAN_NO_OVERLAP })

const busy = (ms: number): void => { const end = Date.now() + ms; while (Date.now() < end) { /* the prep's own work, on the main thread */ } }

/** The real agent loop on the mock server; `prepMs`: how long the run's memory recall takes (sync work, like the real one). */
function harness(models: ModelInfo[], o: { prepMs?: number; contextWindow?: (model?: string) => number; url?: string } = {}) {
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
  const endpoints = { last, for: () => ({ provider: 'custom', baseUrl: o.url ?? llm.url }), usable: () => models, list: async () => last, advisor: () => undefined, budgetLeft: () => 150 }
  const prep = { calls: 0, endedAt: 0 }
  const memory = {
    block: (q: { query?: string } | number) => {
      if (typeof q === 'number') return ''
      prep.calls++
      busy(o.prepMs ?? 0)
      prep.endedAt = Date.now()
      return 'The user is Sam; Sam lives in Boston.'
    }
  }
  const agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: endpoints as never, spaces: { getPrompt: () => '' } as never, memory: memory as never,
    emit: () => undefined, secretValues: () => [], fitWindow: (_m, w) => w,
    counter: () => ({ count: async (t: string) => estimate(t) }),
    ...(o.contextWindow ? { contextWindow: o.contextWindow } : {})
  })
  const space = db.createSpace('SahilBot', '#000000', { isMain: true })
  const thread = (): Thread => db.createThread(space.id, 'auto', null)
  return { db, agent, thread, prep, settings }
}

// A model server on its own thread (like a real remote API: the run's busy preparation on the main thread can't
// hold it up). The brain's request is answered after `brainMs`; the work request at once. Arrival times come back.
const SERVER = `
const { parentPort } = require('node:worker_threads')
const http = require('node:http')
let brainMs = 0, brainReply = ''
parentPort.on('message', (m) => { brainMs = m.brainMs; brainReply = m.brainReply })
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const at = Date.now()
    if (req.url !== '/v1/chat/completions') { res.statusCode = 404; return res.end('no') }
    const json = JSON.parse(body)
    const brain = JSON.stringify(json.messages?.[0]?.content ?? '').includes('You are Auto, the router')
    parentPort.postMessage({ at, model: json.model, brain, text: JSON.stringify(json.messages) })
    const send = (content) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + '\\n\\n')
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\\n\\n')
      res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } }) + '\\n\\n')
      res.end('data: [DONE]\\n\\n')
    }
    if (brain) setTimeout(() => send(brainReply), brainMs)
    else send('Fixed.')
  })
})
server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }))
`
let remote: { url: string; worker: Worker; seen: Array<{ at: number; model: string; brain: boolean; text: string }> }
beforeAll(async () => {
  const worker = new Worker(SERVER, { eval: true })
  const seen: typeof remote.seen = []
  const port = await new Promise<number>((ok) => worker.on('message', (m) => { if (m.port) ok(m.port); else seen.push(m) }))
  remote = { url: `http://127.0.0.1:${port}/v1`, worker, seen }
})
afterAll(async () => { await remote?.worker.terminate() })

/**
 * One message on Auto against the server thread: the brain answers after `brainMs`, then the model it chose gets the
 * request. The time from send to that first work request, and when the brain's request reached the server.
 */
async function timeToFirstRequest(h: ReturnType<typeof harness>, text: string, brainMs: number, read: BrainAnswer = answer()): Promise<{ ttfr: number; brainAt: number; t0: number; models: string[]; work: string }> {
  remote.seen.length = 0
  remote.worker.postMessage({ brainMs, brainReply: JSON.stringify(read) })
  await new Promise((r) => setTimeout(r, 20))
  const t0 = Date.now()
  const done = (await h.agent.send({ threadId: h.thread().id, text } as never)).done
  expect(await done).toBe('finished')
  await expect.poll(() => remote.seen.length).toBeGreaterThanOrEqual(2)
  const brain = remote.seen.find((x) => x.brain)!
  const work = remote.seen.find((x) => !x.brain)!
  return { ttfr: work.at - t0, brainAt: brain.at - t0, t0, models: remote.seen.map((x) => x.model), work: work.text }
}

describe('the brain read overlaps the run\'s preparation', () => {
  const BRAIN = 600
  const PREP = 500
  const TEXT = 'Fix the off-by-one bug in the pager component'

  test('time to the first request is about max(brain, prep), not their sum', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    // Before: the read, then the preparation (FOREMAN_NO_OVERLAP turns the overlap off, as the app ran before).
    process.env.FOREMAN_NO_OVERLAP = '1'
    const before = await timeToFirstRequest(harness(ALL, { prepMs: PREP, contextWindow: () => 1_000_000, url: remote.url }), TEXT, BRAIN)
    delete process.env.FOREMAN_NO_OVERLAP
    const h = harness(ALL, { prepMs: PREP, contextWindow: () => 1_000_000, url: remote.url })
    const after = await timeToFirstRequest(h, TEXT, BRAIN)
    console.log(`[auto-latency] brain ${BRAIN} ms, prep ${PREP} ms: time to first request before ${before.ttfr} ms, after ${after.ttfr} ms`)
    expect(before.models).toEqual([LUNA.id, SONNET.id])
    expect(after.models).toEqual([LUNA.id, SONNET.id])
    expect(before.ttfr).toBeGreaterThanOrEqual(BRAIN + PREP - 30)
    // About the longer of the two (plus the harness's own overhead), far below the sum.
    expect(after.ttfr).toBeLessThan(Math.max(BRAIN, PREP) + 0.6 * Math.min(BRAIN, PREP))
    expect(after.ttfr).toBeLessThan(before.ttfr - 0.6 * Math.min(BRAIN, PREP))
    // The brain's request was on the wire before the preparation finished: they really ran at the same time.
    expect(after.brainAt).toBeLessThan(h.prep.endedAt - after.t0)
    // Prepared once (while the brain read), not again at the first step; and it reached the model.
    expect(h.prep.calls).toBe(1)
    expect(after.work).toContain('Sam lives in Boston')
  })

  test('a slower preparation than the read: the read hides inside it', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness(ALL, { prepMs: 900, contextWindow: () => 1_000_000, url: remote.url })
    const r = await timeToFirstRequest(h, TEXT, 300)
    console.log(`[auto-latency] brain 300 ms, prep 900 ms: time to first request ${r.ttfr} ms (sum 1200)`)
    expect(r.ttfr).toBeLessThan(900 + 0.6 * 300)
    expect(h.prep.calls).toBe(1)
  })

  test('when the picked model sizes the context differently, it is prepared again for that model (never a wrong size)', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    // The rules pick Sonnet, the brain Opus, and Opus sizes the context differently: the warm-up is not reused.
    const h = harness(ALL, { prepMs: 50, contextWindow: (m) => (m === OPUS.id ? 1_000_000 : 400_000), url: remote.url })
    const r = await timeToFirstRequest(h, TEXT, 100, answer({ model: OPUS.id, difficulty: 3, effort: 'xhigh' }))
    expect(r.models).toEqual([LUNA.id, OPUS.id])
    expect(h.prep.calls).toBe(2)
    expect(r.work).toContain('Sam lives in Boston')
  })

  test('every hard limit and the fallback stay: a broken read still answers on the rules\' pick, with the context', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness(ALL, { prepMs: 100, contextWindow: () => 1_000_000 })
    llm.script.push({ content: 'not json at all', delay: 200 }, { content: 'Hello.', delay: 0 })
    expect(await (await h.agent.send({ threadId: h.thread().id, text: TEXT } as never)).done).toBe('finished')
    expect(llm.requests).toHaveLength(2)
    expect(ALL.map((m) => m.id)).toContain(llm.requests[1].model)
    expect(JSON.stringify(llm.requests[1].messages)).toContain('Sam lives in Boston')
  })
})

// ---------------------------------------------------------------------------------------------------
// Skipping the read.

const route = (text: string, preference: 'balanced' | 'best' | 'cheapest' = 'balanced') => {
  const task = classifyTask(text)
  return { task, pick: ALL.find((m) => m.id === autoRoute({ requested: 'auto', usable: ALL, task, preference }).model)! }
}

describe('small talk and obviously quick asks skip the read', () => {
  test('small talk the rules read with confidence skips it, at any length the rule reads', () => {
    for (const t of ['thanks!', 'hi', 'good morning!', 'thank you so much', 'thanks so much, that was really helpful!', 'ok great, thanks a lot!', 'tell me a joke about penguins', 'how are you today?']) {
      const d = classifyTask(t)
      expect(d.rule, t).toBe(d.rule === 'empty' ? 'empty' : 'small-talk')
      expect(skipBrain(t, d, 0), t).toBe(true)
    }
    // Not small talk: a request that opens with a greeting, or thanks followed by more work.
    for (const t of ['hi, can you refactor the auth module', 'thanks, now add dark mode and a settings page', 'hey whats the best laptop for programming under $1500 that also runs games']) {
      expect(skipBrain(t, classifyTask(t), 0), t).toBe(false)
    }
  })

  test('the quick asks: a sum, a conversion, a translation of a sentence, a typo fix', () => {
    const quick: Array<[string, string]> = [
      ['what is 17*23', 'sum'], ["what's 15% of 240?", 'sum'], ['2+2', 'sum'], ['calculate 1234 * 5678', 'sum'], ['how much is 12.5 divided by 4', 'sum'],
      ['convert 5 miles to km', 'conversion'], ['72 f in c', 'conversion'], ['How many cups are in a quart?', 'conversion'], ['how many seconds in a day', 'conversion'], ['100 kg to lbs', 'conversion'],
      ["translate 'where is the train station' into Spanish", 'translation'], ['Translate good morning into Japanese', 'translation'], ['how do you say good night in French', 'translation'], ['Translate to German: I will be late tomorrow.', 'translation'],
      ['fix the typos: teh cat sat on teh mat', 'typo-fix'], ['correct the grammar: me and him goes to school', 'typo-fix'], ['fix the spelling in this sentence: I recieved you\'re mesage', 'typo-fix']
    ]
    for (const [t, kind] of quick) {
      expect(quickAsk(t), t).toBe(kind)
      const d = classifyTask(t)
      expect(d.signals.quick, t).toBe(kind)
      expect(d.difficulty, t).toBeLessThanOrEqual(1)
      expect(d.kind, t).toBe('chat')
      // On Balanced the rules route it to a quick model, so the read is skipped.
      const { pick } = route(t)
      expect(isQuickModel(pick), `${t} → ${pick.id}`).toBe(true)
      expect(skipBrain(t, d, 0, { quickPick: true }), t).toBe(true)
      // Something attached, or a pick that isn't quick (Best result lifts it a tier): the brain reads it.
      expect(skipBrain(t, d, 1, { quickPick: true }), t).toBe(false)
      expect(skipBrain(t, d, 0, { quickPick: isQuickModel(route(t, 'best').pick) }), t).toBe(false)
    }
  })

  test('nothing hard is misread as quick', () => {
    const hard = [
      'solve x^2 + 3x - 4 = 0', 'prove that sqrt 2 is irrational', "What's 2+2? Think as hard as you possibly can.", 'what is 2x+3 when x is 4',
      'Translate this whole manual into Spanish', 'translate this document to French', 'translate the app into french', 'translate it into German', 'Translate this Python function to Rust:\n```python\ndef add(a, b):\n    return a + b\n```',
      'translate my website into Spanish', 'translate the readme to japanese', 'translate the following into Italian',
      'convert my spreadsheet to csv', 'Convert this Word doc to a nicely formatted PDF', 'Convert the class components in src/legacy to hooks', 'convert 100 usd to eur and email it to my accountant',
      'fix the typo in src/app.ts', 'fix the typo in my code', 'fix the typos in my essay', 'fix the typos: `const x = 1;`', 'fix the grammar in the README.md',
      'calculate my taxes for this year', 'calculate the integral of x^2 from 0 to 3', 'compute the eigenvalues of [[1,2],[3,4]]',
      'how many days until christmas', 'Fix the TypeError in src/app.ts where user is undefined', 'what is 17*23 and then email the result to my boss'
    ]
    for (const t of hard) {
      expect(quickAsk(t), t).toBeUndefined()
      expect(classifyTask(t).signals.quick, t).toBeUndefined()
    }
    // Long material is not "a sentence": a paragraph to translate or proofread gets a real read.
    const para = 'We met at the station at noon. Then we walked to the museum, had lunch by the river and talked about the trip for hours. Afterwards everyone went home tired but happy.'
    expect(quickAsk(`translate to French: ${para}`)).toBeUndefined()
    expect(quickAsk(`fix the typos: ${para} ${para}`)).toBeUndefined()
  })

  test('on the labelled eval set, every request read as quick is labelled light (difficulty 0-1, a chat)', () => {
    const items = (EVAL as unknown as { items: Array<{ id: string; text: string; category: TaskCategory; kind: string; difficulty: number }> }).items
    const hits = items.filter((it) => quickAsk(it.text))
    expect(hits.length).toBeGreaterThanOrEqual(3)
    for (const it of hits) {
      expect(it.difficulty, `${it.id}: ${it.text}`).toBeLessThanOrEqual(1)
      expect(it.kind, `${it.id}: ${it.text}`).toBe('chat')
    }
  })

  test('in the loop: a quick ask goes straight to a quick model, with no read', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness(ALL)
    llm.script.push({ content: '8 km.', delay: 0 })
    const t = h.thread()
    expect(await (await h.agent.send({ threadId: t.id, text: 'convert 5 miles to km' } as never)).done).toBe('finished')
    expect(llm.requests.map((r) => r.model)).toEqual([LUNA.id])
    const reply = h.db.listMessages(t.id).find((m) => m.role === 'assistant')!
    expect(String((reply.meta?.routed as { why: string }).why)).toMatch(/quick conversion · no read needed/)
    expect(String((reply.meta?.routed as { explain: string }).explain)).toMatch(/^Why this model: .*no read needed \(the rules\).* · cost: quick$/)
  })

  test('in the loop: small talk goes straight to a quick model; a real task still gets the read', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness(ALL)
    llm.script.push({ content: 'Anytime!', delay: 0 })
    await (await h.agent.send({ threadId: h.thread().id, text: 'thanks so much, that was really helpful!' } as never)).done
    expect(llm.requests.map((r) => r.model)).toEqual([LUNA.id])
    llm.requests.length = 0
    llm.script.push({ content: JSON.stringify(answer()), delay: 0 }, { content: 'Fixed.', delay: 0 })
    await (await h.agent.send({ threadId: h.thread().id, text: 'Fix the off-by-one bug in the pager component' } as never)).done
    expect(llm.requests.map((r) => r.model)).toEqual([LUNA.id, SONNET.id])
  })
})
