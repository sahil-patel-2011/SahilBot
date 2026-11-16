import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import { memoryTool, quotedFact } from '../../src/main/agent/tools/memory'
import { autoMemoryOn, chatPrompt, compactPrompt, harnessPrompt, memoryGuidance, setAutoMemory } from '../../src/main/agent/prompt'
import { Db } from '../../src/main/db'
import { MemoryStore } from '../../src/main/memory'
import type { ChatEvent, ModelInfo, Settings } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Automatic memory: the agent saves durable things the user says without being asked, then says so in a few
// words inline. No confirmation card in Auto. Off ("Remember things automatically" in Settings → Memory): it
// saves only when asked.

process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
afterEach(() => { llm.script.length = 0; llm.requests.length = 0; setAutoMemory(true) })

const opts = { userName: 'Sam', workspaceDir: '/tmp', spacePrompt: '', spaceName: 'SahilBot' }
const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: JSON.stringify(args) })

describe('prompt and tool guidance', () => {
  test('every prompt tells the agent to save durable facts on its own, then note it inline; never secrets', () => {
    expect(autoMemoryOn()).toBe(true)
    for (const p of [harnessPrompt(opts), chatPrompt(opts as never), compactPrompt(opts as never)]) {
      expect(p).toMatch(/Save automatically, without being asked/)
      expect(p).toMatch(/preference.*decision.*person.*place.*routine.*goal/s)
      expect(p).toMatch(/Noted: you prefer metric units/)
      expect(p).toMatch(/no confirmation/i)
      expect(p).toMatch(/Never (save passwords|secrets)/)
      expect(p).toMatch(/quoted facts with their source/)
    }
    const tool = memoryTool(new MemoryStore(new Db(':memory:')), new Db(':memory:'))
    expect(tool.description).toMatch(/call it on your own, without being asked/)
    expect(tool.description).toMatch(/short inline note \("Noted: …"\)/)
  })

  test('"Remember things automatically" off: save only when asked', () => {
    setAutoMemory(false)
    for (const form of ['full', 'chat', 'compact'] as const) {
      const g = memoryGuidance(form)
      expect(g).toMatch(/only when (they ask|the user asks)/)
      expect(g).not.toMatch(/Save automatically/)
    }
  })

  test('wording from outside content is kept only as a quoted fact', () => {
    expect(quotedFact('The user banks with Acme Credit.')).toBe('Per outside content (a web page, email or another app): “The user banks with Acme Credit.”')
    expect(quotedFact('Per the Acme invoice email: due Friday')).toBe('Per the Acme invoice email: due Friday')
  })

  test('a sensitive category the user turned off is refused, with what to tell them', async () => {
    const db = new Db(':memory:')
    const mem = new MemoryStore(db)
    const t = db.createThread(db.listSpaces()[0]?.id ?? db.createSpace('Main', '#000').id, 'auto', null)
    const tool = memoryTool(mem, db, undefined, undefined, () => ({ about: () => '', screenMemory: (x: string) => (/diabetes/.test(x) ? { ok: false, why: 'health', label: 'health' } : { ok: true }) }))
    await expect(tool.run({ action: 'save', fact: 'Has type 2 diabetes.', category: 'profile' }, { threadId: t.id } as never)).rejects.toThrow(/turned off remembering health details/)
    const r = await tool.run({ action: 'save', fact: 'Prefers metric units.', category: 'preference' }, { threadId: t.id } as never)
    expect(r.text).toMatch(/Noted: Prefers metric units\./)
    expect(mem.list().map((m) => m.content)).toEqual(['Prefers metric units.'])
  })
})

describe('a scripted run', () => {
  const model = { id: 'model-a', provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: 'A', vision: false, tier: 2, requiredGB: 1, maxFittingWindow: 131072, fits: true } as ModelInfo

  function harness() {
    const db = new Db(':memory:')
    const memory = new MemoryStore(db)
    const settings = {
      contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true },
      workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: model.id, hiddenModels: [], shownModels: [],
      cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: []
    } as unknown as Settings
    const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
    const registry = new ToolRegistry()
    registry.register(...coreTools(results), memoryTool(memory, db))
    const events: ChatEvent[] = []
    const last = { ok: true, models: [model], budgetGB: 32, totalGB: 64, providers: [] }
    const agent = new Agent({
      db, results, registry, docsDir: tmpdir(),
      settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
      endpoints: { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => [model], list: async () => last, advisor: () => undefined } as never,
      spaces: { getPrompt: () => '' } as never,
      memory,
      emit: (e) => { events.push(e) },
      secretValues: () => [],
      fitWindow: (_m, w) => w,
      counter: () => ({ count: async (t: string) => estimate(t) })
    })
    const space = db.createSpace('Alpha', '#000000')
    return { db, agent, events, memory, thread: () => db.createThread(space.id, 'auto', model.id) }
  }

  test('the user states a preference: memory(save) runs with no card, and the reply notes it inline', async () => {
    const h = harness()
    const t = h.thread()
    llm.script.push(
      { toolCalls: [call('memory', { action: 'save', fact: 'Prefers metric units.', category: 'preference' })], delay: 0 },
      { content: 'Noted: you prefer metric units. 5 miles is about 8 km.', delay: 0 }
    )
    await (await h.agent.send({ threadId: t.id, text: 'I prefer metric units. How far is 5 miles?' })).done
    // Saved, as a shared preference about the user.
    expect(h.memory.list()).toEqual([expect.objectContaining({ content: 'Prefers metric units.', category: 'preference', spaceId: null })])
    // No approval card (Auto mode): saving a memory is a local write.
    expect(h.events.filter((e) => e.type === 'pending')).toEqual([])
    // The model was told to save on its own, and the tool result asked for the short inline note.
    const first = llm.requests[0]
    expect(String(first.messages[0].content)).toMatch(/Save automatically, without being asked/)
    const toolMsg = llm.requests[1].messages.find((m: { role: string }) => m.role === 'tool')
    expect(String(toolMsg?.content)).toMatch(/Tell the user in a few words inline, e.g. "Noted: Prefers metric units\."/)
    // The reply carries the note.
    const reply = h.db.listMessages(t.id).filter((m) => m.role === 'assistant').at(-1)
    expect(reply?.content).toMatch(/^Noted: you prefer metric units\./)
  }, 30_000)
})
