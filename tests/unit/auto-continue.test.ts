import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { Agent, START_BUDGET } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import type { ToolDef } from '../../src/main/agent/types'
import { Db } from '../../src/main/db'
import type { ModelInfo, Settings } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Bots keep working without being told to: a run still making progress when its step budget runs out keeps going
// on its own, instead of stopping to ask the user to say "continue".
process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'
let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })

async function runSteps(harness?: { autoContinue: boolean }) {
  const model = { id: 'm', provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: 'M', vision: false, tier: 2, requiredGB: 1, maxFittingWindow: 131072, fits: true } as unknown as ModelInfo
  let n = 0
  const work: ToolDef = { name: 'fetch_record', label: 'Fetch', core: true, effect: 'read', description: 'Fetch one record', parameters: { type: 'object', properties: { i: { type: 'integer' } } }, run: async () => ({ text: `record ${++n} fetched` }) }
  const db = new Db(':memory:')
  const settings = { contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true }, workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: 'm', hiddenModels: [], shownModels: [], cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [] } as unknown as Settings
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), work)
  const last = { ok: true, models: [model], budgetGB: 32, totalGB: 64, providers: [] }
  const agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => [model], list: async () => last, advisor: () => undefined } as never,
    spaces: { getPrompt: () => '' } as never, memory: { block: () => '' } as never,
    emit: () => undefined, secretValues: () => [], fitWindow: (_m, w) => w, counter: () => ({ count: async (t: string) => estimate(t) }),
    ...(harness ? { harness } : {})
  })
  const steps = START_BUDGET + 16
  for (let i = 1; i <= steps; i++) llm.script.push({ toolCalls: [{ name: 'fetch_record', arguments: JSON.stringify({ i }) }] })
  llm.script.push({ content: `All ${steps} records fetched.` })
  const space = db.createSpace('Alpha', '#000000')
  const t = db.createThread(space.id, 'auto', 'm')
  await (await agent.send({ threadId: t.id, text: `Fetch records 1 to ${steps} one at a time` })).done
  const wrapped = llm.requests.some((r) => JSON.stringify(r.messages).includes('used its step budget'))
  const final = db.listMessages(t.id).filter((m) => m.role === 'assistant' && !m.meta?.superseded).at(-1)?.content ?? ''
  llm.script.length = 0; llm.requests.length = 0
  return { n, steps, wrapped, final }
}

test('steady progress past the starting budget finishes the job without a "say continue" stop', async () => {
  const r = await runSteps()
  expect(r.n).toBe(r.steps)
  expect(r.wrapped).toBe(false)
  expect(r.final).toContain(`All ${r.steps} records fetched`)
}, 120_000)

test('control: with the feature off, the same run stops at its budget and asks to continue', async () => {
  const r = await runSteps({ autoContinue: false })
  expect(r.wrapped).toBe(true)
  expect(r.n).toBeLessThan(r.steps)
}, 120_000)
