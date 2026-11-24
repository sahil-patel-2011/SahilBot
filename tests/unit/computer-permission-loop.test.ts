import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import { computerTool } from '../../src/main/agent/tools/computer'
import { WINDOWS } from '../../src/main/computer/scripts'
import { Db } from '../../src/main/db'
import type { ChatEvent, ModelInfo, PendingRequest, Settings } from '../../src/shared/types'
import { startMockLlm, lastToolOutput, type MockLlm } from '../fixtures/mock-llm'

// Report DAB-02 ("Calculator by clicking: a one-tap Accessibility setup card the first time, then the task resumes by
// itself"): the card comes from the computer tool itself, not from the model's wording, and once the switch is on the
// same step carries on with nobody typing anything.
process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'

const model = { id: 'm', provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: 'M', vision: false, tier: 2, requiredGB: 1, maxFittingWindow: 131072, fits: true } as ModelInfo
let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })

function setup() {
  const mac = { on: false, prompts: 0 }
  const computer = computerTool({
    enterMini: () => undefined,
    capture: async () => ({ dataUrl: '', width: 1, height: 1 }),
    trusted: (prompt) => { if (prompt) mac.prompts++; return mac.on },
    axPoll: { everyMs: 1000, timeoutMs: 20_000 },
    osa: async (fn) => (fn === WINDOWS ? [] : { app: 'Calculator', pid: 7, windows: [{ index: 0, title: 'Calculator' }], nodes: [{ role: 'AXButton', name: '7', path: [0, 1], depth: 1, win: 0 }] })
  })
  const db = new Db(':memory:')
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), { ...computer, core: true })
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
  const t = db.createThread(db.createSpace('Bot', '#000').id, 'auto', 'm')
  return { mac, agent, events, t }
}

const cards = (events: ChatEvent[]): PendingRequest[] => events.filter((e) => e.type === 'pending').map((e) => (e as { request: PendingRequest }).request)

test('the Accessibility card shows by itself and the step carries on once the switch is on', async () => {
  const { mac, agent, events, t } = setup()
  let seen = ''
  llm.script.push(
    { toolCalls: [{ name: 'computer', arguments: '{"action":"ui","app":"Calculator"}' }] },
    (req) => { seen = lastToolOutput(req); return { content: 'Calculator is open and ready.' } }
  )
  const run = await agent.send({ threadId: t.id, text: 'Work out 245 × 18 by clicking the Calculator buttons' })
  // The card comes up from the tool (nothing in the model's words), with the switch to turn on.
  for (let i = 0; i < 100 && !cards(events).length; i++) await new Promise((r) => setTimeout(r, 20))
  const card = cards(events)[0]
  expect(card).toMatchObject({ kind: 'question', permission: 'accessibility' })
  expect(card.question).toMatch(/carries on by itself/)
  // macOS's own prompt comes just after the card (it adds SahilBot to the list), once.
  await new Promise((r) => setTimeout(r, 20))
  expect(mac.prompts).toBe(1)
  // The user flips the switch in System Settings; nobody types anything in the chat.
  mac.on = true
  expect(await run.done).toBe('finished')
  expect(events.some((e) => e.type === 'resolved' && (e as { id: string }).id === card.id)).toBe(true)
  expect(seen).toMatch(/Act on elements by ref/)
  expect(seen).not.toMatch(/Accessibility permission is off/)
}, 20_000)

test('nobody there (a schedule): no card and no wait, the step says why', async () => {
  const { mac, agent, events, t } = setup()
  let seen = ''
  llm.script.push(
    { toolCalls: [{ name: 'computer', arguments: '{"action":"ui","app":"Calculator"}' }] },
    (req) => { seen = lastToolOutput(req); return { content: 'Accessibility is off, so I left the clicking for you.' } }
  )
  const start = Date.now()
  expect(await (await agent.send({ threadId: t.id, text: 'Check the Calculator' }, { unattended: true })).done).toBe('finished')
  expect(Date.now() - start).toBeLessThan(5000)
  expect(cards(events)).toHaveLength(0)
  expect(seen).toMatch(/Accessibility permission is off/)
  expect(seen).toMatch(/Nobody is here/)
  // Nobody to see macOS's own dialog either.
  expect(mac.prompts).toBe(0)
}, 20_000)
