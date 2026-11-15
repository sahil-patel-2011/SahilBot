import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import type { ModelInfo, Settings, Thread } from '../../src/shared/types'
import { appRegistry } from '../fixtures/app-tools'
import { startFakeOpenAI } from '../fixtures/fake-providers'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// The chat path: simple messages answer with a lean prompt and the chat tools (web search, pages, memory,
// connected apps, find_tools), no plan, nudges or self-check; real work still runs the full agent, and a chat
// that turns into work escalates from the next step. Plus small windows: a slim prompt and tool set so a local
// 16-32K model keeps its tool results instead of compacting every step.

process.env.FOREMAN_NO_AUTOTITLE = '1'
// The self-check pass is ON here: the chat path must skip it on its own.
delete process.env.FOREMAN_NO_VERIFY

const { Agent } = await import('../../src/main/agent/loop')
const { classifyTask } = await import('../../src/main/agent/intent')
const { CHAT_TOOLS, FIXED_SHARE, chooseProfile, compactWire, shortText } = await import('../../src/main/agent/registry')
const { chatPrompt, compactPrompt, harnessPrompt } = await import('../../src/main/agent/prompt')
const { OUTPUT_RESERVE, estimate, upperEstimate } = await import('../../src/main/agent/context')
const { Db } = await import('../../src/main/db')
const { SkillStore } = await import('../../src/main/skills')
const { RuleStore } = await import('../../src/main/rules')
const { clearContextPins } = await import('../../src/main/llm/client')
import type { ToolDef, ThreadState } from '../../src/main/agent/types'

const kind = (text: string, ctx = {}): string => classifyTask(text, ctx).kind

describe('chat or agent', () => {
  test('conversation, questions, advice, short writing and live facts are chats', () => {
    for (const t of [
      'hi', 'thanks!', 'hello again', 'What is the capital of France?', 'When did Qwen 3.8 come out?', "What's the weather in Boston tomorrow?",
      'Explain how vaccines work', 'Write a haiku about autumn', 'Give me 5 name ideas for a coffee shop', 'How do I make a pivot table in Excel?',
      'Summarize https://example.com/post', 'What do you remember about me?', 'Remember that my sister lives in Austin',
      "What's the difference between a class and a struct?", 'Translate good morning into Japanese', 'What do recent studies say about creatine?',
      'Compare the populations of Paris and Tokyo', 'What incidents are open in PagerDuty?'
    ]) expect(kind(t), t).toBe('chat')
  })

  test('files, documents, the browser, the screen, code, email, calendar, routines and several steps are agent work', () => {
    for (const t of [
      'Write a short report about green tea and save it as a PDF document in my files', 'Look up the launch date in my notes and send it to sam@acme.test',
      'Fix the failing unit test in my repo', 'Click Save in Numbers', 'Make me a Q4 dashboard', 'Clean up my inbox', 'Remind me tomorrow at 9 to call mom',
      'Organize my Downloads folder', 'Can you make me a budget spreadsheet?', 'Search for the best CRM tools and then write a comparison report',
      'What is on my calendar today?', 'Draft a memo about the new schedule', 'Every morning at 9, tidy my workspace', 'Log into the Acme portal and send them a quote request',
      'Buy two of the ceramic mugs from the tea shop', 'Open https://shop.test/check', 'read /etc/hosts', 'Summarise the brief into summary.md',
      'Write a comprehensive, in-depth analysis comparing our three vendors', 'Ask the Researcher bot for the boiling point of water', 'Let me show you how I download invoices'
    ]) expect(kind(t), t).toBe('agent')
  })

  test('toggles, attachments, a plan in progress and unattended runs are agent work; follow-ups keep the last kind', () => {
    expect(kind('hi', { flags: { planFirst: true } })).toBe('agent')
    expect(kind('hi', { flags: { team: true } })).toBe('agent')
    expect(kind('hi', { flags: { deepResearch: true } })).toBe('agent')
    expect(kind('hi', { flags: { heavy: true } })).toBe('agent')
    expect(kind('what is this?', { files: 1 })).toBe('agent')
    expect(kind('what is in here?', { folders: 1 })).toBe('agent')
    expect(kind('thanks', { openPlan: true })).toBe('agent')
    expect(kind('hi', { unattended: true })).toBe('agent')
    expect(kind('hi', { helper: true })).toBe('agent')
    expect(kind('yes, do it', { previous: 'agent' })).toBe('agent')
    expect(kind('continue', { previous: 'agent' })).toBe('agent')
    expect(kind('yes', { previous: 'chat' })).toBe('chat')
  })
})

// ---------------------------------------------------------------------------------------------------
// Harness: the real Agent with the app's real tool schemas, skills and rules, on the mock model server.
// ---------------------------------------------------------------------------------------------------

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
afterEach(() => { llm.script.length = 0; llm.requests.length = 0; clearContextPins() })

const localModel = (id: string): ModelInfo => ({ id, provider: 'custom', providerName: 'Custom', enabled: true, installed: true, label: id, vision: false, tools: true, tier: 2, requiredGB: 18, maxFittingWindow: 262144, fits: true }) as ModelInfo
const skills = new SkillStore(mkdtempSync(join(tmpdir(), 'skills-')), join(process.cwd(), 'packs', 'skills'))
const rules = new RuleStore(mkdtempSync(join(tmpdir(), 'rules-')), join(process.cwd(), 'packs', 'rules'))

/** Stand-ins that run (the app's schemas, scripted results). */
const runs = (name: string, text: (args: Record<string, unknown>) => string, extra: Partial<ToolDef> = {}): Partial<ToolDef> => ({ name, ...extra, async run(args: Record<string, unknown>) { return { text: text(args) } } })

function harness(o: { baseUrl?: string; window?: number; extra?: ToolDef[] } = {}) {
  const db = new Db(':memory:')
  const model = localModel('local-27b')
  const ws = mkdtempSync(join(tmpdir(), 'ws-'))
  const settings = {
    contextWindow: o.window ?? 131072, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true },
    workspaceDir: ws, userName: 'Sam', defaultModel: model.id, hiddenModels: [], shownModels: [], customRules: [],
    cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, search: { provider: 'none' }
  } as unknown as Settings
  const { registry, results } = appRegistry({ ws, extra: o.extra })
  // The lookups a chat makes, answering with scripted text (the real schemas stay in the request).
  for (const [name, fn] of [
    ['web_search', (a: Record<string, unknown>) => `Results for ${String(a.query)}: https://example.com/a`],
    ['fetch_page', (a: Record<string, unknown>) => `Page ${String(a.url)}: the launch is on December 1.`],
    ['file_write', (a: Record<string, unknown>) => `Wrote ${String(a.path)}`]
  ] as const) registry.register({ ...registry.get(name)!, ...runs(name, fn) } as ToolDef)
  const last = { ok: true, models: [model], budgetGB: 32, totalGB: 64, providers: [] }
  const endpoints = { last, for: () => ({ provider: 'custom', baseUrl: o.baseUrl ?? llm.url }), usable: () => [model], list: async () => last, advisor: () => undefined }
  const agent = new Agent({
    db, results, registry, docsDir: tmpdir(), skills, rules,
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: endpoints as never, spaces: { getPrompt: () => 'Be helpful.' } as never, memory: { block: () => '- [m1] (preference) Likes green tea' } as never,
    emit: () => undefined, secretValues: () => [], fitWindow: (_m, w) => w,
    counter: () => ({ count: async (t: string) => estimate(t) })
  })
  const space = db.createSpace('SahilBot', '#000000', { isMain: true })
  const thread = (): Thread => db.createThread(space.id, 'autonomous', model.id)
  const run = async (t: Thread, text: string, meta?: Record<string, unknown>) => (await agent.send({ threadId: t.id, text, meta })).done
  return { db, agent, registry, thread, run }
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ name, arguments: JSON.stringify(args) })
const names = (req: Record<string, any>): string[] => (req.tools ?? []).map((t: any) => t.function.name)
const sys = (req: Record<string, any>): string => String(req.messages[0].content)
/** A connected app (MCP): registered the way Connectors registers its tools. */
const notes = (name: string, effect: ToolDef['effect'], text: string, app = 'Notes'): ToolDef => ({
  name: `${app.toLowerCase()}__${name}`, label: app, group: app, effect, untrusted: true, consequential: () => true,
  description: `[${app}] ${name.startsWith('search') ? 'Search the user\'s pages' : 'Send a note to someone'}`,
  parameters: { type: 'object', properties: { query: { type: 'string' }, to: { type: 'string' }, text: { type: 'string' } } },
  async run() { return { text } }
})

describe('the chat path', () => {
  test('a simple chat sends the lean prompt and the chat tools: no plan tools, no work tools, no self-check', async () => {
    const h = harness()
    llm.script.push(
      { toolCalls: [call('web_search', { query: 'qwen 3.8 release' })], delay: 0 },
      { toolCalls: [call('fetch_page', { url: 'https://example.com/a' })], delay: 0 },
      { toolCalls: [call('web_search', { query: 'qwen 3.8 release date' })], delay: 0 },
      { content: 'Qwen 3.8 came out in October [1].\n\nSources:\n[1] Result https://example.com/a', delay: 0 }
    )
    const t = h.thread()
    expect(await h.run(t, 'When did Qwen 3.8 come out?')).toBe('finished')
    // Three lookups and an answer: no hidden double-check (the agent's verify pass would add a fifth request).
    expect(llm.requests).toHaveLength(4)
    const ms = h.db.listMessages(t.id)
    expect(ms.filter((m) => m.meta?.hidden)).toEqual([])
    for (const r of llm.requests) {
      expect(names(r)).toEqual([...CHAT_TOOLS])
      expect(sys(r)).toContain('# Chatting')
      expect(sys(r)).not.toContain('# Be a teammate')
    }
    expect(names(llm.requests[0])).not.toContain('todo')
    // The whole fixed part is a fraction of the agent's.
    const fixed = estimate(sys(llm.requests[0])) + estimate(JSON.stringify(llm.requests[0].tools))
    expect(fixed).toBeLessThan(4000)
    expect(h.db.getState(t.id).toolMode).toBe('chat')
    expect(h.db.getState(t.id).todos).toEqual([])
  })

  test('a chat can find and use a connected app without turning into agent work', async () => {
    const h = harness({ extra: [notes('search_pages', 'read', 'Launch date is Dec 1', 'Notion'), notes('send_note', 'write_external', 'Sent', 'Notion')] })
    llm.script.push(
      { toolCalls: [call('find_tools', { query: 'notion' })], delay: 0 },
      { toolCalls: [call('notion__search_pages', { query: 'launch' })], delay: 0 },
      { content: 'Your notes say the launch is Dec 1.', delay: 0 }
    )
    const t = h.thread()
    expect(await h.run(t, 'When is the launch, according to Notion?')).toBe('finished')
    expect(llm.requests).toHaveLength(3)
    const last = llm.requests.at(-1)!
    expect(names(last)).toEqual([...CHAT_TOOLS, 'notion__search_pages', 'notion__send_note'])
    expect(sys(last)).toContain('# Chatting')
    expect(String(last.messages.at(-1).content)).toContain('Launch date is Dec 1')
    expect(h.db.getState(t.id).toolMode).toBe('chat')
  })

  test('a chat that turns into work escalates from the next step: the full prompt, every tool, and the self-check', async () => {
    const h = harness()
    llm.script.push(
      { toolCalls: [call('web_search', { query: 'green tea benefits' })], delay: 0 },
      { toolCalls: [call('find_tools', { query: 'write a file' })], delay: 0 },
      { toolCalls: [call('file_write', { path: 'tea.md', content: '# Tea' })], delay: 0 },
      { content: 'Saved it to tea.md.', delay: 0 },
      { content: 'I wrote tea.md and checked it.', delay: 0 }
    )
    const t = h.thread()
    expect(await h.run(t, 'Tell me about green tea')).toBe('finished')
    const [a, b, c] = llm.requests
    expect(sys(a)).toContain('# Chatting')
    expect(sys(b)).toContain('# Chatting')
    // find_tools loaded a built-in work tool: from the next step on it's the agent.
    expect(sys(c)).toContain('# Be a teammate')
    expect(names(c)).toContain('todo')
    expect(names(c)).toContain('browser')
    expect(names(c).slice(0, CHAT_TOOLS.length)).toEqual([...CHAT_TOOLS])
    // It changed something, so the agent's double-check ran before the final answer.
    expect(h.db.listMessages(t.id).some((m) => m.meta?.hidden && /double-check/.test(m.content))).toBe(true)
    expect(h.db.getState(t.id).toolMode).toBe('full')
    // Calling a work tool directly (without find_tools) escalates the same way.
    const t2 = h.thread()
    llm.script.push({ toolCalls: [call('file_write', { path: 'x.md', content: 'x' })], delay: 0 }, { content: 'Done.', delay: 0 }, { content: 'Done, checked.', delay: 0 })
    llm.requests.length = 0
    expect(await h.run(t2, 'hey there')).toBe('finished')
    expect(sys(llm.requests[0])).toContain('# Chatting')
    expect(sys(llm.requests[1])).toContain('# Be a teammate')
  })

  test('work requests and toggles run the full agent; a chat after work keeps the agent prompt (the cached prefix) but no agent machinery', async () => {
    const h = harness()
    llm.script.push({ content: 'On it.', delay: 0 }, { content: 'Sure.', delay: 0 }, { content: 'Plan below.', delay: 0 })
    const t = h.thread()
    await h.run(t, 'Write a short report about green tea and save it as a PDF document in my files')
    await h.run(t, 'thanks')
    expect(sys(llm.requests[0])).toContain('# Be a teammate')
    expect(names(llm.requests[0])).toContain('todo')
    expect(sys(llm.requests[1])).toBe(sys(llm.requests[0]))
    expect(JSON.stringify(llm.requests[1].tools)).toBe(JSON.stringify(llm.requests[0].tools))
    // Plan first on a short message: the agent.
    await h.run(h.thread(), 'hi', { planFirst: true })
    expect(names(llm.requests[2])).toContain('propose_plan')
  })
})

// ---------------------------------------------------------------------------------------------------
// Fixed overhead (system prompt + tools) per path and window, with the app's own estimates.
// ---------------------------------------------------------------------------------------------------

describe('small windows', () => {
  const opts = { userName: 'Sam', workspaceDir: '/Users/sam/SahilBot', spacePrompt: 'Be helpful.', spaceName: 'SahilBot', skills: skills.index(), rules: rules.block() }
  const { registry } = appRegistry()
  const fixed = (system: string, state: ThreadState, compact: boolean): number => upperEstimate(system) + upperEstimate(JSON.stringify(registry.wire(registry.listFor(state), { compact })))
  const st = (o: Partial<ThreadState>): ThreadState => ({ loaded: [], alwaysAllow: [], todos: [], ...o })

  test('budgets: the chat path, the full agent (big windows) and the slim agent on 16K and 32K', () => {
    const chat = fixed(chatPrompt(opts), st({ toolMode: 'chat' }), false)
    const full = fixed(harnessPrompt(opts), st({ toolMode: 'full' }), false)
    const small = fixed(compactPrompt(opts), st({ toolMode: 'full', toolProfile: 'small' }), true)
    const tiny = fixed(compactPrompt(opts), st({ toolMode: 'full', toolProfile: 'tiny' }), true)
    console.log('[overhead] tokens (upper estimate)', JSON.stringify({ chat, chatCompact: fixed(chatPrompt(opts), st({ toolMode: 'chat' }), true), fullAgent: full, small, tiny }))
    expect(chat).toBeLessThan(full / 4)
    expect(small).toBeLessThan(full / 2.5)
    // 32K: the slim agent fits its share with room to spare; 16K takes the tiny set (or small, if it fits).
    expect(small).toBeLessThanOrEqual(FIXED_SHARE * (32768 - OUTPUT_RESERVE))
    expect(tiny).toBeLessThanOrEqual(FIXED_SHARE * (16384 - OUTPUT_RESERVE))
    // The profile per window: big windows keep everything, small ones go slim, and it steps down when tools pile up.
    const f = (p: 'small' | 'tiny' | undefined): number => (p ? (p === 'small' ? small : tiny) : full)
    expect(chooseProfile(1_000_000, 1_000_000 - OUTPUT_RESERVE, f)).toBeUndefined()
    expect(chooseProfile(131072, 131072 - OUTPUT_RESERVE, f)).toBeUndefined()
    expect(chooseProfile(32768, 32768 - OUTPUT_RESERVE, f)).toBe('small')
    const p16 = chooseProfile(16384, 16384 - OUTPUT_RESERVE, f)
    expect(f(p16)).toBeLessThanOrEqual(FIXED_SHARE * (16384 - OUTPUT_RESERVE))
    expect(chooseProfile(16384, 16384 - OUTPUT_RESERVE, (p) => (p === 'tiny' ? tiny : 99_999))).toBe('tiny')
    expect(chooseProfile(32768, 32768 - OUTPUT_RESERVE, f, 'tiny')).toBe('tiny')
  })

  test('compact schemas keep every tool and parameter name, type, enum and required list', () => {
    for (const t of registry.all()) {
      const c = compactWire(t).function
      expect(c.name).toBe(t.name)
      expect(c.description.length).toBeLessThanOrEqual(201)
      const props = (t.parameters.properties ?? {}) as Record<string, Record<string, unknown>>
      const cp = (c.parameters.properties ?? {}) as Record<string, Record<string, unknown>>
      expect(Object.keys(cp)).toEqual(Object.keys(props))
      expect(c.parameters.required).toEqual(t.parameters.required)
      for (const [k, p] of Object.entries(props)) {
        if (p.enum) expect(cp[k].enum, `${t.name}.${k}`).toEqual(p.enum)
        if (p.type) expect(cp[k].type, `${t.name}.${k}`).toEqual(p.type)
      }
    }
    expect(shortText('First sentence here. Second one, e.g. this. Third.', 30)).toBe('First sentence here.')
  })

  for (const window of [16384, 32768]) {
    test(`a 12-step local task on a ${window / 1024}K window keeps every earlier tool result (no compaction)`, async () => {
      const server = await startFakeOpenAI(window)
      try {
        const extra = [notes('search_notes', 'read', 'NEEDLE-notes: the launch is Dec 1 (codename KESTREL).'), notes('send_note', 'write_external', 'Sent')]
        const h = harness({ baseUrl: server.url, window, extra })
        // About 450 tokens per result, each with its own needle.
        const body = (k: number): string => `NEEDLE-${k}: fact number ${k} is ${k * 37}.\n${'Supporting detail line about the launch plan and the vendors. '.repeat(22)}`
        h.registry.register({ ...h.registry.get('web_search')!, async run(a: Record<string, unknown>) { return { text: `${body(Number(String(a.query).match(/\d+/)?.[0] ?? 0))}` } } } as ToolDef)
        h.registry.register({ ...h.registry.get('fetch_page')!, async run(a: Record<string, unknown>) { return { text: `${body(Number(String(a.url).match(/\d+/)?.[0] ?? 0))}` } } } as ToolDef)
        const plan = (done: number) => call('todo', { items: ['Find the launch facts', 'Research the vendors', 'Write the brief'].map((text, i) => ({ text, status: i < done ? 'done' : i === done ? 'in_progress' : 'pending' })) })
        const steps = [
          plan(0), call('find_tools', { query: 'notes' }), call('notes__search_notes', { query: 'launch' }),
          ...Array.from({ length: 4 }, (_, i) => call('web_search', { query: `vendor ${i + 1}` })), plan(1),
          ...Array.from({ length: 3 }, (_, i) => call('fetch_page', { url: `https://vendors.example/p${i + 5}` })),
          call('file_write', { path: 'brief.md', content: 'The brief.' }), plan(3)
        ]
        server.respond = (_b, { n }) => (n <= steps.length ? { toolCalls: [{ name: steps[n - 1].name, arguments: JSON.parse(steps[n - 1].arguments) }] } : { content: 'Brief written to brief.md.' })
        const t = h.thread()
        expect(await h.run(t, 'Research our launch and the vendors, then write a brief to brief.md')).toBe('finished')
        const main = server.records.filter((r) => !r.isSummary)
        expect(main.length).toBeGreaterThanOrEqual(steps.length + 1)
        // Never past the window, never summarized, nothing trimmed.
        expect(server.records.filter((r) => r.overflow)).toEqual([])
        expect(server.summaries).toEqual([])
        expect(h.db.listMessages(t.id).filter((m) => m.kind === 'compacted')).toEqual([])
        const text = JSON.stringify(server.last!.messages)
        expect(text).not.toContain('older output trimmed')
        for (const n of ['NEEDLE-notes', 'KESTREL', 'NEEDLE-1', 'NEEDLE-2', 'NEEDLE-3', 'NEEDLE-4', 'NEEDLE-5', 'NEEDLE-6', 'NEEDLE-7']) expect(text, n).toContain(n)
        // The find_tools result and the tools it loaded are still there.
        expect(text).toContain("notes__search_notes: [Notes] Search the user's pages (loaded now)")
        expect(names(server.last!)).toContain('notes__search_notes')
        // The slim agent: compact prompt, fewer tools, and the fixed part within its share.
        const first = main[0]
        void first
        const sysText = sys(server.last!)
        expect(sysText).toContain('Listed now')
        const fixedTokens = upperEstimate(sysText) + upperEstimate(JSON.stringify(server.last!.tools))
        console.log(`[overhead] agent ${window / 1024}K`, JSON.stringify({ fixedTokens, tools: names(server.last!).length, maxRequest: Math.max(...main.map((r) => r.tokens)) }))
        expect(fixedTokens).toBeLessThanOrEqual(FIXED_SHARE * (window - OUTPUT_RESERVE))
      } finally {
        await server.close()
      }
    }, 30_000)
  }
})
