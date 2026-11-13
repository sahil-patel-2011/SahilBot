import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { Agent } from '../../src/main/agent/loop'
import { ContextManager, ResultStore, ServerTokenCounter, estimate, pinRunContext, withPinned, type TokenCounter } from '../../src/main/agent/context'
import { contextBlock, contextSections, dayLine, harnessPrompt, seenLines } from '../../src/main/agent/prompt'
import { QUICK_TOOLS, ToolRegistry, chooseToolMode, quickEligible } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import { emptyState, type ToolDef } from '../../src/main/agent/types'
import { Db } from '../../src/main/db'
import { buildBody, clearContextPins, numCtxFor, ollamaBody, ollamaThink, pinContextWindow } from '../../src/main/llm/client'
import { clearTimings, recentTimings } from '../../src/main/llm/timing'
import { Warmup, crowds, warmTarget, warmupAllowed } from '../../src/main/llm/warmup'
import type { Message, ModelInfo, Settings, Thread } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'

const model = (id: string, tier: 0 | 1 | 2 | 3, extra: Partial<ModelInfo> = {}): ModelInfo =>
  ({ id, provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: id, vision: false, tier, requiredGB: 4, maxFittingWindow: 131072, fits: true, ...extra }) as ModelInfo

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
afterEach(() => { llm.script.length = 0; llm.requests.length = 0; clearContextPins() })

const tool = (name: string, core = false): ToolDef<{ q?: string }> => ({
  name, core, label: name, effect: 'read', description: `${name} tool`,
  parameters: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
  async run({ q }) { return { text: `${name} result ${q ?? ''}` } }
})

/** A real Agent over an in-memory database and the mock model server, with a memory store you can add to. */
function harness(extraTools: ToolDef[] = []) {
  const db = new Db(':memory:')
  const models = [model('model-a', 2)]
  const settings = {
    contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true },
    workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: 'model-a', hiddenModels: [], shownModels: [],
    cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [], localKeepAlive: '45m'
  } as unknown as Settings
  const memories: string[] = ['- [m1] (preference) Likes green tea']
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), tool('web_search', true), tool('fetch_page', true), tool('memory', true), tool('clock', true), ...extraTools)
  const last = { ok: true, models, budgetGB: 32, totalGB: 64, providers: [] }
  const endpoints = { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => models, list: async () => last, advisor: () => undefined }
  const agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: endpoints as never,
    spaces: { getPrompt: () => 'Be helpful.' } as never,
    memory: { block: () => memories.join('\n') } as never,
    emit: () => undefined,
    secretValues: () => [],
    fitWindow: (_m, w) => w,
    counter: () => ({ count: async (t: string) => estimate(t) })
  })
  const space = db.createSpace('Main', '#000000', { isMain: true })
  const thread = (): Thread => db.createThread(space.id, 'auto', 'model-a')
  const run = async (t: Thread, text: string, meta?: Record<string, unknown>) => (await agent.send({ threadId: t.id, text, meta })).done
  return { db, agent, registry, memories, thread, run }
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ name, arguments: JSON.stringify(args) })
const toolNames = (req: Record<string, any>): string[] => (req.tools ?? []).map((t: any) => t.function.name)
const text = (m: any): string => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))

describe('prompt prefix stability', () => {
  test('consecutive steps and turns send the same system prompt and tools, and only append messages', async () => {
    const h = harness()
    llm.script.push({ toolCalls: [call('clock')], delay: 0 }, { content: 'Paris.', delay: 0 }, { content: 'Berlin.', delay: 0 })
    const t = h.thread()
    expect(await h.run(t, 'What is the capital of France?')).toBe('finished')
    expect(await h.run(t, 'And what about Germany?')).toBe('finished')
    const [a, b, c] = llm.requests
    expect(llm.requests).toHaveLength(3)
    // Same system prompt and tool list, byte for byte, on every request.
    expect(b.messages[0]).toEqual(a.messages[0])
    expect(c.messages[0]).toEqual(a.messages[0])
    expect(JSON.stringify(b.tools)).toBe(JSON.stringify(a.tools))
    expect(JSON.stringify(c.tools)).toBe(JSON.stringify(a.tools))
    // Each request extends the previous one: earlier messages are unchanged.
    expect(b.messages.slice(0, a.messages.length)).toEqual(a.messages)
    expect(c.messages.slice(0, b.messages.length)).toEqual(b.messages)
    // Volatile context is not in the system prompt: it rides on the user's message.
    expect(text(a.messages[0])).not.toContain('Today is')
    expect(text(a.messages[0])).not.toContain('green tea')
    expect(text(a.messages[1])).toContain(dayLine(new Date()))
    expect(text(a.messages[1])).toContain('Likes green tea')
    expect(text(a.messages[1])).toMatch(/<\/context>\n\nWhat is the capital of France\?$/)
    // The second turn has nothing new to add: no context block at all.
    expect(text(c.messages.at(-1))).toBe('And what about Germany?')
    // Same window and keep-alive on every request.
    expect(llm.requests.map((r) => r.options?.num_ctx)).toEqual([32768, 32768, 32768])
  })

  test('a new memory changes only the tail', async () => {
    const h = harness()
    llm.script.push({ content: 'Noted.', delay: 0 }, { content: 'Sure.', delay: 0 })
    const t = h.thread()
    await h.run(t, 'What should I drink this morning?')
    h.memories.push('- [m2] (location) Lives in Boston')
    await h.run(t, 'What is the weather like there usually?')
    const [a, b] = llm.requests
    expect(b.messages[0]).toEqual(a.messages[0])
    expect(JSON.stringify(b.tools)).toBe(JSON.stringify(a.tools))
    expect(b.messages.slice(0, a.messages.length)).toEqual(a.messages)
    const tail = text(b.messages.at(-1))
    expect(tail).toContain('Lives in Boston')
    expect(tail).not.toContain('green tea')
    expect(tail).not.toContain('Today is')
    // One block per run: the full one, then just the new memory.
    const state = h.db.getState(t.id)
    expect(Object.values(state.pins ?? {}).filter(Boolean)).toHaveLength(2)
  })

  test('the harness prompt has no date and sorts skills so use counts never reorder it', () => {
    const base = { userName: 'Sam', workspaceDir: '/w', spacePrompt: '', spaceName: 'Main' }
    const p1 = harnessPrompt({ ...base, skills: '- zeta: z\n- alpha: a\nBuilt-in skills by topic:\n- Web: x' })
    const p2 = harnessPrompt({ ...base, skills: '- alpha: a\n- zeta: z\nBuilt-in skills by topic:\n- Web: x' })
    expect(p1).toBe(p2)
    expect(p1).not.toMatch(/Today is/)
  })
})

describe('context blocks', () => {
  const sections = (memories: string, date = new Date('2026-11-13T10:00:00')) => contextSections({ date, memories, rules: '- Always ask before sending email' })
  test('first block has the date and memories; later ones only what is new', () => {
    const system = '# Rules (always follow these)\n- Always ask before sending email'
    const first = contextBlock(sections('- [a] (fact) One\nRecent work:\n- [w1] Did X'), seenLines(system))
    expect(first).toContain('Today is Friday, November 13, 2026.')
    expect(first).toContain('- [a] (fact) One')
    expect(first).toContain('Recent work:\n- [w1] Did X')
    expect(first).not.toContain('Rules added')
    const next = contextBlock(sections('- [a] (fact) One\nRecent work:\n- [w2] Did Y\n- [w1] Did X\n(3 more saved; memory(action="search") finds them)'), seenLines(system, first))
    expect(next).toBe('<context from="app">\n## What you remember (ids in brackets; most relevant first)\nRecent work:\n- [w2] Did Y\n(3 more saved; memory(action="search") finds them)\n</context>')
    // A new day and a new rule show up; nothing else repeats.
    const later = contextBlock(contextSections({ date: new Date('2026-11-14T09:00:00'), memories: '- [a] (fact) One', rules: '- Always ask before sending email\n- Reply in French' }), seenLines(system, first, next))
    expect(later).toContain('Today is Saturday, November 14, 2026.')
    expect(later).toContain('## Rules added since this chat started (always follow these)\n- Reply in French')
    expect(later).not.toContain('One')
    expect(contextBlock(sections('- [a] (fact) One'), seenLines(system, first))).toBe('')
  })

  test('pins once per message, applies to that message only, and refreshes after a compaction', () => {
    const state = emptyState()
    const msg = (id: string, role: Message['role'], content: string): Message => ({ id, threadId: 't', role, content, kind: 'normal', status: 'done', createdAt: 1 })
    const ms = [msg('u1', 'user', 'hello'), msg('a1', 'assistant', 'hi')]
    let mem = '- [a] (fact) One'
    const opts = { state, messages: ms, openerId: 'u1', system: 'SYS', sections: () => contextSections({ date: new Date('2026-11-13T10:00:00'), memories: mem }) }
    expect(pinRunContext(opts)).toBe(true)
    mem = '- [a] (fact) One\n- [b] (fact) Two'
    expect(pinRunContext(opts)).toBe(false)
    const out = withPinned(ms, state)
    expect(out[0].content).toMatch(/^<context from="app">[\s\S]*One[\s\S]*<\/context>\n\nhello$/)
    expect(out[0].content).not.toContain('Two')
    expect(out[1]).toBe(ms[1])
    expect(ms[0].content).toBe('hello')
    // Second run: only the new memory.
    const ms2 = [...ms, msg('u2', 'user', 'again')]
    pinRunContext({ ...opts, messages: ms2, openerId: 'u2' })
    expect(state.pins!.u2).toContain('Two')
    expect(state.pins!.u2).not.toContain('One')
    // After a compaction hides the first block, a refresh brings everything back.
    state.compaction = { boundaryId: 'a1', summary: 's' }
    expect(pinRunContext({ ...opts, messages: ms2, openerId: 'u2', refresh: true })).toBe(true)
    expect(state.pins!.u2).toContain('One')
    expect(state.pins!.u2).toContain('Today is')
  })
})

describe('context window (num_ctx) and keep-alive', () => {
  const base = { model: 'qwen3.8:27b', messages: [], maxTokens: 100, sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0, repeat_penalty: 1 } }
  const url = 'http://localhost:11434/v1'
  test('the pinned window is reused: smaller or missing requests never change num_ctx', () => {
    pinContextWindow(url, 'qwen3.8:27b', 32768)
    expect((ollamaBody({ ...base, baseUrl: url, contextWindow: 32768 }).options as any).num_ctx).toBe(32768)
    expect((ollamaBody({ ...base, baseUrl: url, contextWindow: 16384 }).options as any).num_ctx).toBe(32768)
    expect((ollamaBody({ ...base, baseUrl: url }).options as any).num_ctx).toBe(32768)
    expect((buildBody({ ...base, baseUrl: url }).options as any).num_ctx).toBe(32768)
    // Needing more than the pin: the request gets what it needs.
    expect(numCtxFor(url, 'qwen3.8:27b', 65536)).toBe(65536)
    // Another model or server isn't affected.
    expect(numCtxFor(url, 'other', undefined)).toBeUndefined()
    expect(numCtxFor('http://localhost:1234/v1', 'qwen3.8:27b', 8192)).toBe(8192)
  })
  test('Ollama requests keep the model loaded and skip thinking on quick replies', () => {
    // A model nothing pinned (a title model) keeps the server's default; chat models stay loaded.
    expect(ollamaBody({ ...base, baseUrl: url }).keep_alive).toBeUndefined()
    pinContextWindow(url, 'qwen3.8:27b', 32768)
    expect(ollamaBody({ ...base, baseUrl: url }).keep_alive).toBe('30m')
    expect(ollamaBody({ ...base, baseUrl: url, keepAlive: '2h' }).keep_alive).toBe('2h')
    expect(ollamaBody({ ...base, baseUrl: url, keepAlive: '-1' }).keep_alive).toBe(-1)
    expect(ollamaBody({ ...base, baseUrl: url, effort: 'low' }).think).toBe(false)
    expect(ollamaBody({ ...base, baseUrl: url, effort: 'medium' }).think).toBeUndefined()
    expect(ollamaThink('gpt-oss:20b', 'low')).toBe('low')
    expect(ollamaThink('llama3.3:70b', 'low')).toBeUndefined()
    const b = buildBody({ ...base, baseUrl: 'http://localhost:8080/v1', effort: 'low' })
    expect(b.chat_template_kwargs).toEqual({ enable_thinking: false, reasoning_effort: 'low' })
    expect(b.cache_prompt).toBe(true)
    expect(buildBody({ ...base, baseUrl: 'https://api.example.com/v1', effort: 'low' }).chat_template_kwargs).toBeUndefined()
  })
  test('a whole run (tool step included) sends one window and the keep-alive setting', async () => {
    const h = harness()
    llm.script.push({ toolCalls: [call('clock')], delay: 0 }, { content: 'done', delay: 0 })
    await h.run(h.thread(), 'Check the clock and tell me the time please?')
    expect(llm.requests.map((r) => r.options?.num_ctx)).toEqual([32768, 32768])
  })
})

describe('quick-chat fast path', () => {
  test('selection: only small talk on a local model in a chat with nothing more yet', () => {
    const st = emptyState()
    expect(quickEligible({ tier: 0, local: true, state: st })).toBe(true)
    expect(quickEligible({ tier: 1, local: true, state: st })).toBe(false)
    expect(quickEligible({ tier: 0, local: false, state: st })).toBe(false)
    expect(quickEligible({ tier: 0, local: true, state: st, flags: { team: true } })).toBe(false)
    expect(quickEligible({ tier: 0, local: true, state: st, flags: { deepResearch: true } })).toBe(false)
    expect(quickEligible({ tier: 0, local: true, state: st, flags: { planFirst: true } })).toBe(false)
    expect(quickEligible({ tier: 0, local: true, state: st, helper: true })).toBe(false)
    expect(quickEligible({ tier: 0, local: true, state: st, unattended: true })).toBe(false)
    expect(quickEligible({ tier: 0, local: true, state: st, group: true })).toBe(false)
    expect(quickEligible({ tier: 0, local: true, state: { ...st, todos: [{ text: 'x', status: 'pending' }] } })).toBe(false)
    expect(quickEligible({ tier: 0, local: true, state: { ...st, loaded: ['gmail_send'] } })).toBe(false)
    expect(quickEligible({ tier: 0, local: true, state: { ...st, toolMode: 'full' } })).toBe(false)
    // A chat from before tool modes (replies, no mode yet) stays on every tool; a quick chat stays quick.
    expect(quickEligible({ tier: 0, local: true, state: st, newChat: false })).toBe(false)
    expect(quickEligible({ tier: 0, local: true, state: { ...st, toolMode: 'quick' }, newChat: false })).toBe(true)
    // Full is for good.
    const s2 = emptyState()
    chooseToolMode(s2, false)
    expect(chooseToolMode(s2, true)).toBe('full')
  })

  test('the quick list is a prefix of the full list; find_tools or a built-in tool escalates', () => {
    const r = new ToolRegistry()
    r.register(tool('todo', true), tool('browser', true), ...QUICK_TOOLS.map((n) => tool(n, true)), tool('gmail_send'))
    const st = emptyState()
    const full = r.listFor(st).map((t) => t.name)
    expect(full.slice(0, QUICK_TOOLS.length)).toEqual([...QUICK_TOOLS])
    st.toolMode = 'quick'
    expect(r.listFor(st).map((t) => t.name)).toEqual([...QUICK_TOOLS])
    // A built-in tool can be found and loaded from quick mode, which switches to every tool.
    expect(r.search('browser', st)[0].name).toBe('browser')
    expect(r.load(st, ['browser', 'todo'])).toEqual(['browser', 'todo'])
    expect(st.toolMode).toBe('full')
    expect(r.listFor(st).map((t) => t.name)).toEqual(full)
    const st2 = { ...emptyState(), toolMode: 'quick' as const }
    expect(r.escalate(st2, ['web_search'])).toBe(false)
    expect(r.escalate(st2, ['todo'])).toBe(true)
    expect(st2.toolMode).toBe('full')
  })

  test('small talk gets the small tool set and no thinking; a task gets every tool from then on', async () => {
    const h = harness()
    llm.script.push({ content: 'Hey!', delay: 0 }, { content: 'Report done.', delay: 0 }, { content: 'You are welcome.', delay: 0 })
    const t = h.thread()
    await h.run(t, 'hi')
    await h.run(t, 'Write a short report about green tea and save it as a PDF document in my files')
    await h.run(t, 'thanks')
    const [a, b, c] = llm.requests
    expect(toolNames(a)).toEqual([...QUICK_TOOLS])
    expect(toolNames(b).length).toBeGreaterThan(toolNames(a).length)
    expect(toolNames(b).slice(0, toolNames(a).length)).toEqual(toolNames(a))
    // Back to small talk: the full list stays (the cached prefix stays valid).
    expect(toolNames(c)).toEqual(toolNames(b))
    expect(h.db.getState(t.id).toolMode).toBe('full')
  })

  test('team and deep-research requests keep every tool even when short', async () => {
    const h = harness()
    llm.script.push({ content: 'ok', delay: 0 })
    await h.run(h.thread(), 'hi', { team: true })
    expect(toolNames(llm.requests[0])).toContain('todo')
  })
})

describe('token counting stays off the critical path', () => {
  test('far under the limit the prompt is measured from estimates: no tokenizer calls', async () => {
    let calls = 0
    const counter: TokenCounter = { count: async (t) => { calls++; return estimate(t) } }
    const cm = new ContextManager(counter, async () => 'x')
    const msg = (i: number): Message => ({ id: `m${i}`, threadId: 't', role: i % 2 ? 'assistant' : 'user', content: 'word '.repeat(200), kind: 'normal', status: 'done', createdAt: i })
    const r = await cm.prepare({ system: 'S'.repeat(4000), toolsJson: '[]', messages: Array.from({ length: 10 }, (_, i) => msg(i)), state: emptyState(), window: 32768 })
    expect(calls).toBe(0)
    expect(r.used).toBeGreaterThan(1000)
    // Near the limit every piece is counted exactly.
    await cm.prepare({ system: 'S'.repeat(4000), toolsJson: '[]', messages: Array.from({ length: 10 }, (_, i) => msg(i)), state: emptyState(), window: 8192 })
    expect(calls).toBeGreaterThan(10)
  })

  test('server counts are shared by every run on the same model', async () => {
    llm.tokenize = true
    try {
      const big = 'x'.repeat(400)
      const a = new ServerTokenCounter(llm.url, 'shared-model')
      expect(await a.count(big)).toBe(100)
      const b = new ServerTokenCounter(llm.url, 'shared-model')
      expect(b.cached(big)).toBe(100)
      expect(new ServerTokenCounter(llm.url, 'another-model').cached(big)).toBeUndefined()
    } finally {
      llm.tokenize = false
    }
  })

  test('small tool results skip the tokenizer', async () => {
    let calls = 0
    const store = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
    const r = await store.maybeOffload('short result '.repeat(100), 'x1', { count: async (t) => { calls++; return estimate(t) } })
    expect(r.offloaded).toBe(false)
    expect(calls).toBe(0)
  })
})

describe('timings', () => {
  test('each model request records its time to first token', async () => {
    clearTimings()
    const h = harness()
    llm.script.push({ content: 'Hello there', delay: 0 })
    await h.run(h.thread(), 'How are you doing today, friend?')
    const t = recentTimings('llm').at(-1)!
    expect(t.marks.first_token).toBeGreaterThanOrEqual(0)
    expect(t.total).toBeGreaterThanOrEqual(t.marks.first_token)
    expect(t.extra).toMatchObject({ model: 'model-a', ok: true, prompt: 100 })
    expect(recentTimings('step').length).toBeGreaterThan(0)
  })
})

/** A tiny stand-in for Ollama's management API, recording what warm-up asks for. */
async function fakeOllama(loaded: Array<{ name: string; size: number; context_length?: number }> = []) {
  const calls: Array<{ path: string; body: any }> = []
  const server: Server = createServer((req, res) => {
    let s = ''
    req.on('data', (c) => (s += c))
    req.on('end', () => {
      const path = req.url ?? ''
      calls.push({ path, body: s ? JSON.parse(s) : undefined })
      res.setHeader('content-type', 'application/json')
      if (path === '/api/version') return res.end(JSON.stringify({ version: '0.12.0' }))
      if (path === '/api/ps') return res.end(JSON.stringify({ models: loaded }))
      if (path === '/api/generate') return res.end(JSON.stringify({ done: true }))
      if (path === '/api/chat') return res.end(JSON.stringify({ done: true, message: { content: '.' } }))
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  return { url, calls, close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()) }) }
}

describe('local model warm-up', () => {
  const big = model('qwen3.8:27b', 2, { requiredGB: 22, sizeBytes: 18 * 1024 ** 3 })
  const small = model('lfm3:1.7b', 0, { requiredGB: 2, sizeBytes: 1.7 * 1024 ** 3 })
  const tooBig = model('llama3.3:70b', 2, { fits: false, maxFittingWindow: 0, requiredGB: 60 })
  const cloud = model('claude-opus-5-5', 3, { note: 'remote', provider: 'anthropic' })

  test('only in the real app', () => {
    expect(warmupAllowed({ VITEST: 'true' } as never)).toBe(false)
    expect(warmupAllowed({ SAHILBOT_HIDDEN: '1' } as never)).toBe(false)
    expect(warmupAllowed({} as never)).toBe(true)
  })

  test('picks the chosen local model, the last one used, or Auto\'s everyday pick; never one that does not fit', () => {
    const usable = [big, small, tooBig, cloud]
    expect(warmTarget({ usable, defaultModel: 'lfm3:1.7b' })?.id).toBe('lfm3:1.7b')
    expect(warmTarget({ usable, defaultModel: 'llama3.3:70b' })).toBeUndefined()
    expect(warmTarget({ usable, defaultModel: 'claude-opus-5-5' })).toBeUndefined()
    expect(warmTarget({ usable, defaultModel: 'auto', recent: 'lfm3:1.7b' })?.id).toBe('lfm3:1.7b')
    expect(warmTarget({ usable, defaultModel: 'auto', recent: 'claude-opus-5-5' })?.id).toBe('qwen3.8:27b')
    expect(warmTarget({ usable, defaultModel: 'auto', explicit: 'lfm3:1.7b' })?.id).toBe('lfm3:1.7b')
  })

  test('never adds a second large model next to one already loaded', () => {
    const GB = 1024 ** 3
    expect(crowds(big, [], 40)).toBe(false)
    expect(crowds(big, [{ name: 'qwen3.8:27b', sizeBytes: 20 * GB }], 40)).toBe(false)
    expect(crowds(big, [{ name: 'gemma4:26b', sizeBytes: 19 * GB }], 40)).toBe(true)
    expect(crowds(small, [{ name: 'gemma4:26b', sizeBytes: 19 * GB }], 40)).toBe(false)
    expect(crowds(small, [{ name: 'gemma4:26b', sizeBytes: 39 * GB }], 40)).toBe(true)
  })

  test('loads the model at the chat window with keep-alive, then reads the prompt prefix once', async () => {
    const o = await fakeOllama()
    try {
      const last = { models: [big] }
      const w = new Warmup({
        endpoints: { last, list: async () => last, usable: () => [big], for: () => ({ baseUrl: o.url }) },
        settings: { get: () => ({ defaultModel: 'auto', contextWindow: 0, localKeepAlive: '1h' }) },
        fitWindow: () => 65536,
        prefix: () => ({ system: 'SYSTEM', tools: [{ type: 'function', function: { name: 'find_tools', description: 'd', parameters: {} } }] }),
        budgetGB: () => 40
      })
      const r = await w.run()
      expect(r).toMatchObject({ status: 'warmed', model: 'qwen3.8:27b', numCtx: 65536 })
      const gen = o.calls.find((c) => c.path === '/api/generate')!
      expect(gen.body).toEqual({ model: 'qwen3.8:27b', prompt: '', keep_alive: '1h', options: { num_ctx: 65536 } })
      const chat = o.calls.find((c) => c.path === '/api/chat')!
      expect(chat.body).toMatchObject({ model: 'qwen3.8:27b', messages: [{ role: 'system', content: 'SYSTEM' }], keep_alive: '1h', options: { num_ctx: 65536, num_predict: 1 } })
      // Chat requests to that model now use the same window: no reload on the first message.
      expect(numCtxFor(o.url, 'qwen3.8:27b')).toBe(65536)
    } finally {
      await o.close()
    }
  })

  test('skips while a chat runs, and when the model is already loaded right it only reads the prefix if new', async () => {
    const o = await fakeOllama([{ name: 'qwen3.8:27b', size: 18 * 1024 ** 3, context_length: 32768 }])
    try {
      let busy = true
      const last = { models: [big] }
      const w = new Warmup({
        endpoints: { last, list: async () => last, usable: () => [big], for: () => ({ baseUrl: o.url }) },
        settings: { get: () => ({ defaultModel: 'qwen3.8:27b', contextWindow: 32768, localKeepAlive: '30m' }) },
        fitWindow: (_m, win) => win,
        prefix: () => ({ system: 'S', tools: [] }),
        busy: () => busy,
        budgetGB: () => 40
      })
      expect((await w.run()).reason).toBe('a chat is running')
      expect(o.calls).toHaveLength(0)
      busy = false
      expect(await w.run()).toMatchObject({ status: 'warmed', reason: 'already loaded' })
      expect(o.calls.some((c) => c.path === '/api/generate')).toBe(false)
      expect(o.calls.filter((c) => c.path === '/api/chat')).toHaveLength(1)
      await w.run()
      expect(o.calls.filter((c) => c.path === '/api/chat')).toHaveLength(1)
    } finally {
      await o.close()
    }
  })
})
