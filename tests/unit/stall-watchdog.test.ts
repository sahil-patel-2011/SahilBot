import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { Agent, STALL_PREFIX } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import type { ToolDef } from '../../src/main/agent/types'
import { Db } from '../../src/main/db'
import type { ChatEvent, ModelInfo, Settings } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// The stall watchdog (report RL-13: "sat 3+ min on Reading …/Downloads with no message"): a run quiet for the
// stall time says so in plain words, once per stall period, never while waiting on the user.
process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'
process.env.FOREMAN_STALL_MS = '600'

const model = { id: 'm', provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: 'M', vision: false, tier: 2, requiredGB: 1, maxFittingWindow: 131072, fits: true } as ModelInfo
let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close(); delete process.env.FOREMAN_STALL_MS })

test('a step that hangs gets a plain "still on it" note, and the run still finishes', async () => {
  const slow: ToolDef<{ q: string }> = {
    name: 'slow_read', label: 'Read', effect: 'read', description: 'read slowly',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
    async run() { await new Promise((r) => setTimeout(r, 1900)); return { text: 'done reading' } }
  }
  const db = new Db(':memory:')
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), slow)
  const events: ChatEvent[] = []
  const settings = { contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: {}, workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: 'm', hiddenModels: [], shownModels: [], cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [] } as unknown as Settings
  const last = { ok: true, models: [model], budgetGB: 32, totalGB: 64, providers: [] }
  const agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => [model], list: async () => last, advisor: () => undefined } as never,
    spaces: { getPrompt: () => '' } as never, memory: { block: () => '' } as never,
    emit: (e) => events.push(e), secretValues: () => [], fitWindow: (_m, w) => w, counter: () => ({ count: async (t: string) => estimate(t) })
  })
  llm.script.push({ toolCalls: [{ name: 'slow_read', arguments: '{"q":"Downloads"}' }], delay: 0 }, { content: 'Read it.', delay: 0 })
  const t = db.createThread(db.createSpace('Bot', '#000').id, 'auto', 'm')
  expect(await (await agent.send({ threadId: t.id, text: 'Read my Downloads folder' })).done).toBe('finished')
  const notes = events.filter((e) => e.type === 'tool_progress' && e.callId === 'watchdog') as Array<{ text: string }>
  expect(notes.length).toBeGreaterThanOrEqual(1)
  expect(notes.length).toBeLessThanOrEqual(3)
  expect(notes[0].text.startsWith(STALL_PREFIX)).toBe(true)
  // It names what is stuck and offers Retry / Skip for that step (report EHA-01).
  expect(notes[0].text).toMatch(/^Still on it: this step is taking longer than usual \(\d+ min\)\. Retry it, skip it, or keep waiting\.$/)
  expect((notes[0] as { stuck?: boolean }).stuck).toBe(true)
})
