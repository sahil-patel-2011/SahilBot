import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { Agent, promisesAction } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import type { ToolDef } from '../../src/main/agent/types'
import { Db } from '../../src/main/db'
import type { ModelInfo, Settings } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// A schedule call's own result is the check, and it backs "I'll send you …": no hidden nudge, no double-check pass,
// one reply (SCA-01, SCA-02, SCC-03).
delete process.env.FOREMAN_NO_VERIFY
process.env.FOREMAN_NO_AUTOTITLE = '1'

const model: ModelInfo = { id: 'model-a', provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: 'A', vision: false, tier: 2, requiredGB: 1, maxFittingWindow: 131072, fits: true } as ModelInfo

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
afterEach(() => { llm.script.length = 0; llm.requests.length = 0 })

const schedule: ToolDef<{ action: string }> = {
  name: 'schedule', label: 'Schedule', effect: 'write_local', description: 'schedule a routine',
  parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false },
  async run() { return { text: 'Scheduled "Atlanta weather" (Weekdays at 7:30 AM ET), id s1. Next run: Monday 7:30 AM ET.' } }
}

function harness() {
  const db = new Db(':memory:')
  const settings = {
    contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true },
    workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: model.id, hiddenModels: [], shownModels: [],
    cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: []
  } as unknown as Settings
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), schedule)
  const last = { ok: true, models: [model], budgetGB: 32, totalGB: 64, providers: [] }
  const endpoints = { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => [model], list: async () => last, advisor: () => undefined }
  const agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: endpoints as never,
    spaces: { getPrompt: () => '' } as never,
    memory: { block: () => '' } as never,
    emit: () => {},
    secretValues: () => [],
    fitWindow: (_m, w) => w,
    counter: () => ({ count: async (t: string) => estimate(t) })
  })
  const space = db.createSpace('Alpha', '#000000')
  return { db, agent, thread: () => db.createThread(space.id, 'auto', model.id) }
}

const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: JSON.stringify(args) })

describe('a routine confirmation', () => {
  test('a recurring or timed promise is a schedule, not undone work', () => {
    expect(promisesAction("Done! I'll send you the Atlanta weather every weekday at 7:30 AM ET.")).toBe(false)
    expect(promisesAction("Got it — I'll send you a reminder to stretch in 3 minutes (3:05 PM).")).toBe(false)
    expect(promisesAction("Moved. From now on I'll send it at 7:00 AM ET on weekdays.")).toBe(false)
    expect(promisesAction("Got it. I'll deploy it to Vercel and send you the URL.")).toBe(true)
  })

  test('after schedule create, "I\'ll send you …" gets no nudge and no double-check: one reply', async () => {
    const h = harness()
    llm.script.push(
      { toolCalls: [call('schedule', { action: 'create' })], delay: 0 },
      { content: "Got it. I'll send you the Atlanta weather then.", delay: 0 },
      { content: 'EXTRA STEP', delay: 0 }
    )
    const t = h.thread()
    expect(await (await h.agent.send({ threadId: t.id, text: 'Send me the Atlanta weather every weekday at 7:30 AM' })).done).toBe('finished')
    const ms = h.db.listMessages(t.id)
    const hidden = ms.filter((m) => m.role === 'user' && m.meta?.hidden).map((m) => m.content).join('\n')
    expect(hidden).not.toMatch(/made no tool call/)
    expect(hidden).not.toMatch(/Confirm each change/)
    expect(ms.some((m) => m.content === 'EXTRA STEP')).toBe(false)
    expect(ms.filter((m) => m.role === 'assistant' && m.content.includes('Atlanta weather'))).toHaveLength(1)
  })
})
