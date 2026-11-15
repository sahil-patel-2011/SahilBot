import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import type { ConnectorPreset, ModelInfo, Settings, Thread } from '@shared/types'
import { appRegistry } from '../fixtures/app-tools'
import { startFakeServer, type FakeServer } from '../fixtures/fake-oauth-mcp'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import type { ThreadState, ToolDef } from '../../src/main/agent/types'

// One-click connectors from inside a chat: find_tools offers the Connect card, the app's tools register
// mid-run and are listed (and allowed on the lean chat path) on the very next step; a later chat finds them
// directly. Plus the narrow test-only catalog hook the acceptance tests use.

process.env.FOREMAN_NO_AUTOTITLE = '1'
process.env.FOREMAN_NO_VERIFY = '1'

const { Agent } = await import('../../src/main/agent/loop')
const { CHAT_TOOLS, chatAllowed, isConnectorTool } = await import('../../src/main/agent/registry')
const { Connectors, PRESETS, explainAuthError, headlessSignIn, namedIn, testPresets } = await import('../../src/main/connectors')
const { estimate } = await import('../../src/main/agent/context')
const { Db } = await import('../../src/main/db')
const { emptyState } = await import('../../src/main/agent/types')

function memSecrets() {
  const m = new Map<string, string>()
  return { get: (k: string) => m.get(k), set: (k: string, v: string | null) => { if (v === null || v === '') m.delete(k); else m.set(k, v) } }
}
function memDb() {
  const store = new Map<string, unknown>()
  return { getSetting: (k: string) => store.get(k), setSetting: (k: string, v: unknown) => void store.set(k, v) }
}

describe('test-only catalog entries (SAHILBOT_TEST_PRESETS)', () => {
  const env = (presets: unknown, hidden = '1'): NodeJS.ProcessEnv => ({ SAHILBOT_HIDDEN: hidden, SAHILBOT_TEST_PRESETS: JSON.stringify(presets) })
  const ok = { id: 'test-acme', name: 'Acme Tasks', url: 'http://127.0.0.1:4100/mcp' }
  test('honoured only in a hidden run, for loopback http servers, test- ids and one-click auth', () => {
    expect(testPresets(env([ok]))).toEqual([expect.objectContaining({ id: 'test-acme', name: 'Acme Tasks', url: ok.url, auth: 'oauth', category: 'Other' })])
    expect(testPresets(env([ok], ''))).toEqual([])
    expect(testPresets({ SAHILBOT_TEST_PRESETS: JSON.stringify([ok]) })).toEqual([])
    expect(testPresets(env([{ ...ok, url: 'https://mcp.example.com/mcp' }]))).toEqual([])
    expect(testPresets(env([{ ...ok, url: 'http://10.0.0.5/mcp' }]))).toEqual([])
    expect(testPresets(env([{ ...ok, id: 'acme' }]))).toEqual([])
    // Never replaces a real catalog entry, and anything but 'none' is plain one-click OAuth.
    expect(testPresets(env([{ ...ok, id: 'test-x' }]), [{ id: 'test-x' }])).toEqual([])
    expect(testPresets(env([{ ...ok, auth: 'apikey' }]))[0].auth).toBe('oauth')
    expect(testPresets(env([{ ...ok, auth: 'none' }]))[0].auth).toBe('none')
    expect(testPresets({ SAHILBOT_HIDDEN: '1', SAHILBOT_TEST_PRESETS: 'not json' })).toEqual([])
  })
  test('a normal run adds nothing to the catalog', () => {
    expect(PRESETS.filter((p) => p.id.startsWith('test-'))).toEqual([])
  })
})

describe('sign-in errors in plain words', () => {
  test('a sign-in left open in the browser says how to retry', () => {
    expect(explainAuthError('Sign-in timed out after 5 minutes', { name: 'Acme' })).toBe("Sign-in to Acme didn't finish in the browser within 5 minutes. Press Connect to open it again.")
  })
})

describe('naming an app in full', () => {
  test('whole words, any case and punctuation', () => {
    expect(namedIn('check my Google Calendar please', 'Google Calendar')).toBe(true)
    expect(namedIn('acme-tasks list', 'Acme Tasks')).toBe(true)
    expect(namedIn('calendar', 'Google Calendar')).toBe(false)
    expect(namedIn('browser', 'Browserbase')).toBe(false)
    expect(namedIn('notion pages', 'Notion')).toBe(true)
  })
})

describe('registry: tools registered mid-run', () => {
  const state = (): ThreadState => ({ ...emptyState(), toolMode: 'chat' })
  const app = (name: string, effect: ToolDef['effect'] = 'write_external'): ToolDef => ({ name: `acme__${name}`, label: 'Acme', group: 'Acme', connector: true, effect, description: `[Acme] ${name}`, parameters: { type: 'object', properties: {} }, async run() { return { text: 'ok' } } })
  test('a connector tool registered after the run started is found, loads in a chat without escalating, and is listed next', () => {
    const { registry } = appRegistry()
    const st = state()
    expect(registry.listFor(st).map((t) => t.name)).toEqual([...CHAT_TOOLS])
    expect(registry.search('acme', st)).toEqual([])
    registry.register(app('send'), app('list', 'read'))
    const hits = registry.search('acme', st)
    expect(hits.map((h) => [h.name, h.connector])).toEqual([['acme__send', true], ['acme__list', true]])
    expect(registry.load(st, hits.map((h) => h.name))).toEqual(['acme__send', 'acme__list'])
    expect(st.toolMode).toBe('chat')
    expect(registry.escalate(st, ['acme__send'])).toBe(false)
    expect(registry.listFor(st).map((t) => t.name)).toEqual([...CHAT_TOOLS, 'acme__send', 'acme__list'])
  })
  test('an explicitly marked connector tool counts as one even without the "[App]" description', () => {
    const t = { ...app('x'), description: 'Does x' }
    expect(isConnectorTool(t)).toBe(true)
    expect(chatAllowed(t)).toBe(true)
  })
})

// ---------------------------------------------------------------- the real agent, a real Connectors, a fake app

let llm: MockLlm
const servers: FakeServer[] = []
const extra: ConnectorPreset[] = []
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close(); await Promise.all(servers.map((s) => s.close())) })
afterEach(() => {
  llm.script.length = 0; llm.requests.length = 0
  for (const p of extra.splice(0)) PRESETS.splice(PRESETS.indexOf(p), 1)
})

const localModel = (id: string): ModelInfo => ({ id, provider: 'custom', providerName: 'Custom', enabled: true, installed: true, label: id, vision: false, tools: true, tier: 2, requiredGB: 18, maxFittingWindow: 262144, fits: true }) as ModelInfo
const call = (name: string, args: Record<string, unknown> = {}) => ({ name, arguments: JSON.stringify(args) })
const names = (req: Record<string, any>): string[] => (req.tools ?? []).map((t: any) => t.function.name)
const sys = (req: Record<string, any>): string => String(req.messages[0].content)
const lastTool = (r: Record<string, any>): string => String([...r.messages].reverse().find((m: any) => m.role === 'tool')?.content ?? '')

async function harness(o: { description?: string; toolDescription?: string } = {}) {
  const s = await startFakeServer({ name: 'acme', tools: [{ name: 'list_tasks', description: o.toolDescription ?? 'Lists your open tasks', readOnly: true, reply: () => 'Buy milk; File taxes' }] })
  servers.push(s)
  const preset: ConnectorPreset = { id: 'test-acme', name: 'Acme Tasks', url: s.url, auth: 'oauth', color: '#000', category: 'Other', description: o.description ?? 'Your Acme task lists.' }
  PRESETS.push(preset); extra.push(preset)
  const db = new Db(':memory:')
  const model = localModel('local-27b')
  const ws = mkdtempSync(join(tmpdir(), 'ws-'))
  const settings = {
    contextWindow: 131072, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true },
    workspaceDir: ws, userName: 'Sam', defaultModel: model.id, hiddenModels: [], shownModels: [], customRules: [],
    cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, search: { provider: 'none' }
  } as unknown as Settings
  const { registry, results } = appRegistry({ ws })
  const connectors = new Connectors(memDb() as never, memSecrets() as never, registry, () => undefined, { openExternal: (url) => headlessSignIn(url) })
  const last = { ok: true, models: [model], budgetGB: 32, totalGB: 64, providers: [] }
  const agent = new Agent({
    db, results, registry, docsDir: tmpdir(), connectors,
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => [model], list: async () => last, advisor: () => undefined } as never,
    spaces: { getPrompt: () => 'Be helpful.' } as never, memory: { block: () => '' } as never,
    emit: () => undefined, secretValues: () => [], fitWindow: (_m: string, w: number) => w,
    counter: () => ({ count: async (t: string) => estimate(t) })
  } as never)
  const space = db.createSpace('SahilBot', '#000000', { isMain: true })
  const thread = (): Thread => db.createThread(space.id, 'autonomous', model.id)
  /** Waits for the run's next pending card. */
  const pending = async (t: Thread): Promise<{ id: string; kind: string; preset?: ConnectorPreset }> => {
    for (let i = 0; i < 500; i++) { const r = agent.pending(t.id)[0] as never; if (r) return r; await new Promise((ok) => setTimeout(ok, 10)) }
    throw new Error('no pending request')
  }
  return { s, db, agent, registry, connectors, thread, pending }
}

describe('an app still connecting on its own', () => {
  test('settle waits for it instead of a Connect card', async () => {
    const s = await startFakeServer({ mode: 'open', name: 'open' })
    servers.push(s)
    const preset: ConnectorPreset = { id: 'test-open', name: 'Open Notes', url: s.url, auth: 'none', color: '#000', category: 'Other', description: 'Notes.' }
    PRESETS.push(preset); extra.push(preset)
    const { registry } = appRegistry()
    const c = new Connectors(memDb() as never, memSecrets() as never, registry, () => undefined)
    const cfg = c.save({ name: 'Open Notes', kind: 'remote', url: s.url, preset: 'test-open', enabled: true })
    expect(await c.settle('test-open', 50)).toEqual([])
    // As at launch: connectAll starts it in the background, and a chat asks a moment later.
    const pending = c.connect(cfg.id, false)
    await new Promise((r) => setImmediate(r))
    expect(c.statuses()[0].state).toBe('connecting')
    expect(await c.settle('test-open')).toEqual(['open_notes__list_items', 'open_notes__send_item'])
    expect((await pending).state).toBe('connected')
    await c.disconnect(cfg.id)
  })
})

describe('connecting from a chat', () => {
  test('find_tools → Connect card → connect → the app\'s tool is listed and runs on the next step, still a chat; a new chat finds it directly', async () => {
    const h = await harness()
    const TOOL = 'acme_tasks__list_tasks'
    llm.script.push(
      { toolCalls: [call('find_tools', { query: 'acme tasks' })], delay: 0 },
      { toolCalls: [call(TOOL)], delay: 0 },
      { content: 'Buy milk and file taxes.', delay: 0 }
    )
    const t = h.thread()
    const done = (await h.agent.send({ threadId: t.id, text: "What's on my Acme Tasks list?" })).done
    const req = await h.pending(t)
    expect(req.kind).toBe('connect')
    expect(req.preset?.id).toBe('test-acme')
    // The card's one click: connect, then answer.
    expect((await h.connectors.connectPreset('test-acme')).state).toBe('connected')
    h.agent.respond(t.id, req.id, 'connected')
    expect(await done).toBe('finished')
    expect(h.s.log.calls.map((c) => c.name)).toEqual(['list_tasks'])
    expect(llm.requests).toHaveLength(3)
    expect(lastTool(llm.requests[1])).toMatch(/app is connected now[\s\S]*acme_tasks__list_tasks.*loaded now/)
    for (const r of llm.requests) expect(sys(r)).toContain('# Chatting')
    expect(names(llm.requests[1])).toEqual([...CHAT_TOOLS, TOOL])
    expect(lastTool(llm.requests[2])).toContain('Buy milk')
    expect(h.db.getState(t.id).toolMode).toBe('chat')

    // A new chat: found without a card (the agent would wait on a card otherwise).
    llm.requests.length = 0
    llm.script.push(
      { toolCalls: [call('find_tools', { query: 'acme tasks' })], delay: 0 },
      { toolCalls: [call(TOOL)], delay: 0 },
      { content: 'Same two.', delay: 0 }
    )
    const t2 = h.thread()
    expect(await (await h.agent.send({ threadId: t2.id, text: "What's on my Acme Tasks list now?" })).done).toBe('finished')
    expect(h.agent.pending(t2.id)).toEqual([])
    expect(names(llm.requests[1])).toEqual([...CHAT_TOOLS, TOOL])
    expect(h.s.log.calls).toHaveLength(2)
  }, 30_000)

  test('the request picked the app by what it does: after connecting, its tools load even when the words don\'t match them', async () => {
    const h = await harness({ description: 'Household chores and errands.', toolDescription: 'Lists open items' })
    llm.script.push(
      { toolCalls: [call('find_tools', { query: 'chores' })], delay: 0 },
      (r) => ({ content: names(r).includes('acme_tasks__list_tasks') ? 'loaded' : `missing: ${lastTool(r)}`, delay: 0 })
    )
    const t = h.thread()
    const done = (await h.agent.send({ threadId: t.id, text: 'What chores are left?' })).done
    const req = await h.pending(t)
    await h.connectors.connectPreset('test-acme')
    h.agent.respond(t.id, req.id, 'connected')
    await done
    expect(h.db.listMessages(t.id).at(-1)?.content).toBe('loaded')
  }, 30_000)

  test('built-in tools matched too: the card still comes for an app the query names in full, not for a partial word', async () => {
    const h = await harness()
    // Register a built-in-looking tool that matches "tasks".
    h.registry.register({ name: 'task_board', label: 'Tasks', group: 'Tasks', effect: 'read', description: 'Shows the tasks board', parameters: { type: 'object', properties: {} }, async run() { return { text: 'board' } } })
    llm.script.push({ toolCalls: [call('find_tools', { query: 'acme tasks' })], delay: 0 }, { content: 'ok', delay: 0 })
    const t = h.thread()
    const done = (await h.agent.send({ threadId: t.id, text: "What's on my Acme Tasks list?" })).done
    const req = await h.pending(t)
    expect(req.preset?.id).toBe('test-acme')
    h.agent.respond(t.id, req.id, 'skip')
    await done
    // Not now: the built-in matches load instead.
    expect(lastTool(llm.requests[1])).toContain('task_board')

    llm.requests.length = 0
    llm.script.push({ toolCalls: [call('find_tools', { query: 'tasks' })], delay: 0 }, { content: 'ok', delay: 0 })
    const t2 = h.thread()
    expect(await (await h.agent.send({ threadId: t2.id, text: 'Show my tasks board' })).done).toBe('finished')
    expect(lastTool(llm.requests[1])).toContain('task_board')
    expect(h.s.log.registrations).toHaveLength(0)
  }, 30_000)
})
