import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import type { ToolDef } from '../../src/main/agent/types'
import { Db } from '../../src/main/db'
import { MemoryStore } from '../../src/main/memory'
import { ContextEngine } from '../../src/main/context-engine/service'
import { clearContextPins } from '../../src/main/llm/client'
import type { ModelInfo, Settings, Thread } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// The context engine inside a real run: the unified section rides in the pinned <context> block, the
// prefix stays append-only across turns, and with the engine off the old sections come back.

process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
afterEach(() => { llm.script.length = 0; llm.requests.length = 0; clearContextPins() })

const tool = (name: string): ToolDef<{ q?: string }> => ({
  name, core: true, label: name, effect: 'read', description: `${name} tool`,
  parameters: { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false },
  async run() { return { text: 'ok' } }
})

function harness() {
  const db = new Db(':memory:')
  const models = [{ id: 'model-a', provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: 'model-a', vision: false, tier: 2, requiredGB: 4, maxFittingWindow: 131072, fits: true } as ModelInfo]
  const settings = {
    contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true },
    workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: 'model-a', hiddenModels: [], shownModels: [],
    cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [], localKeepAlive: '45m'
  } as unknown as Settings
  const memory = new MemoryStore(db)
  const engine = new ContextEngine({ db, memory })
  const registry = new ToolRegistry()
  registry.register(...coreTools(new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))), tool('web_search'), tool('fetch_page'), tool('memory'))
  const last = { ok: true, models, budgetGB: 32, totalGB: 64, providers: [] }
  const agent = new Agent({
    db, results: new ResultStore(mkdtempSync(join(tmpdir(), 'res-'))), registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => models, list: async () => last, advisor: () => undefined } as never,
    spaces: { getPrompt: () => 'Be helpful.' } as never,
    memory,
    emit: () => undefined,
    secretValues: () => [],
    fitWindow: (_m, w) => w,
    counter: () => ({ count: async (t: string) => estimate(t) }),
    vaultContext: () => ({ title: '## From your knowledge vault', lines: ['- [[Priya Patel]] (person): sister', '- [[Q4 plan]] (project): ship it'] }),
    worldContext: (o) => engine.context({ threadId: o.threadId, spaceId: o.spaceId, query: o.query, window: 32_768, local: o.local, memories: o.memories, vault: o.vault, openerId: o.openerId })
  })
  const space = db.createSpace('Main', '#000000', { isMain: true })
  const thread = (): Thread => db.createThread(space.id, 'auto', 'model-a')
  const run = async (t: Thread, text: string) => (await agent.send({ threadId: t.id, text })).done
  const userText = (req: Record<string, any>): string => { const m = [...req.messages].reverse().find((x: any) => x.role === 'user'); return typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }
  return { db, engine, memory, agent, thread, run, userText }
}

describe('the context engine in a run', () => {
  test('a chat about Priya → learning → a new chat about her gets her card in one unified section', async () => {
    const h = harness()
    llm.script.push({ content: 'Noted.', delay: 0 })
    const t1 = h.thread()
    expect(await h.run(t1, "My sister Priya Patel's birthday is March 3 and she loves peonies.")).toBe('finished')
    await h.engine.learn({ check() {}, now: () => Date.now() })
    llm.script.push({ content: 'March 3.', delay: 0 }, { content: 'Peonies.', delay: 0 })
    const t2 = h.thread()
    expect(await h.run(t2, "When is Priya's birthday?")).toBe('finished')
    const first = llm.requests.at(-1)!
    const block = h.userText(first)
    expect(block).toContain('## About the user and their world')
    expect(block).toMatch(/- Priya Patel \(person · your sister\): birthday March 3 \[you/)
    expect(block).not.toContain('## From your knowledge vault')
    expect(block).not.toContain('- [[Priya Patel]] (person): sister')
    expect(block).toContain('[[Q4 plan]]')
    // The next turn only appends: earlier messages are byte-identical, the card isn't sent again.
    expect(await h.run(t2, 'And what does she like?')).toBe('finished')
    const second = llm.requests.at(-1)!
    expect(second.messages.slice(0, first.messages.length)).toEqual(first.messages)
    expect(h.userText(second)).not.toMatch(/Priya Patel \(person/)
  })

  test('engine off: the old memory and vault sections', async () => {
    const h = harness()
    h.engine.setSettings({ enabled: false })
    h.memory.save('Likes green tea.', 'preference')
    llm.script.push({ content: 'Tea.', delay: 0 })
    await h.run(h.thread(), 'What do I drink?')
    const block = h.userText(llm.requests.at(-1)!)
    expect(block).toContain('## What you remember')
    expect(block).toContain('## From your knowledge vault')
    expect(block).not.toContain('About the user and their world')
  })
})
