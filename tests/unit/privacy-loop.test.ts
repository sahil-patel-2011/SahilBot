import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import { Db } from '../../src/main/db'
import type { ChatEvent, ModelInfo, Settings } from '../../src/shared/types'
import type { PrivacySpan } from '../../src/shared/privacy'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { notPersonalKey } from '../../src/main/privacy/gate'

// The Privacy Gate inside the agent loop, with a stand-in PII-Tracer: protect automatically, details remembered
// as not personal across chats, the numbers Settings shows, and the card when it should ask.

process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'
process.env.FOREMAN_NO_BRAIN = '1'
process.env.FOREMAN_FORCE_PAID = '1'

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close(); delete process.env.FOREMAN_FORCE_PAID })

const model: ModelInfo = { id: 'cloud-model', provider: 'openai', providerName: 'OpenAI', enabled: true, installed: true, label: 'Cloud', vision: false, tier: 3, requiredGB: 0, note: 'remote', contextTokens: 200_000, maxFittingWindow: 200_000, fits: true, tools: true } as ModelInfo

function harness(gate: { mode: 'ask' | 'auto'; notPersonal?: string[]; names: string[] }) {
  const db = new Db(':memory:')
  const settings = { contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true }, workspaceDir: mkdtempSync(join(tmpdir(), 'pg-ws-')), userName: 'Sam', defaultModel: model.id, hiddenModels: [], shownModels: [], cloud: { enabled: true, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [] } as unknown as Settings
  const registry = new ToolRegistry()
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'pg-res-')))
  registry.register(...coreTools(results))
  const counts: Record<string, number> = {}
  const remembered: string[] = []
  const events: ChatEvent[] = []
  const last = { ok: true, models: [model], budgetGB: 32, totalGB: 64, providers: [] }
  const agent: Agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: { last, for: () => ({ provider: 'openai', baseUrl: llm.url }), usable: () => [model], list: async () => last, advisor: () => undefined } as never,
    spaces: { getPrompt: () => '' } as never,
    memory: { block: () => '' } as never,
    emit: (e: ChatEvent) => { events.push(e) },
    secretValues: () => [],
    fitWindow: (_m: string, w: number) => w,
    counter: () => ({ count: async (t: string) => estimate(t) }),
    privacy: {
      active: () => true,
      detect: async (text: string) => ({ spans: gate.names.flatMap((n) => { const i = text.indexOf(n); return i >= 0 ? [{ start: i, end: i + n.length, label: 'private_person', score: 0.97, text: n } as PrivacySpan] : [] }) }),
      mode: () => gate.mode,
      notPersonal: () => new Set((gate.notPersonal ?? []).map((v) => notPersonalKey('private_person', v))),
      rememberNotPersonal: (values: string[]) => { remembered.push(...values) },
      count: (what: string, n = 1) => { counts[what] = (counts[what] ?? 0) + n }
    }
  } as never)
  const space = db.createSpace('Main', '#000')
  return { db, agent, events, counts, remembered, thread: () => db.createThread(space.id, 'auto', model.id) }
}

test('protect automatically: the cloud model sees a stand-in, nothing pauses, and a note says so', async () => {
  const h = harness({ mode: 'auto', names: ['Jordan Ellis'] })
  const t = h.thread()
  llm.script.length = 0; llm.requests.length = 0
  llm.script.push({ content: 'Drafted the email to [PERSON_1] about the launch.' })
  await (await h.agent.send({ threadId: t.id, text: 'Draft an email to Jordan Ellis about the launch.' })).done
  const sent = JSON.stringify(llm.requests[0].messages)
  expect(sent).toContain('[PERSON_1]')
  expect(sent).not.toContain('Jordan Ellis')
  expect(h.events.some((e) => e.type === 'pending')).toBe(false)
  const notes = h.db.listMessages(t.id).filter((m) => m.kind === 'notice').map((m) => m.content).join('\n')
  expect(notes).toMatch(/protected automatically/)
  // The reply shown here has the real name back.
  expect(h.db.listMessages(t.id).filter((m) => m.role === 'assistant' && m.kind !== 'notice').at(-1)?.content).toContain('Jordan Ellis')
  expect(h.counts).toMatchObject({ requests: 1, protected: 1 })
})

test('a detail the user said is not personal (in any chat) is shared without asking', async () => {
  const h = harness({ mode: 'ask', notPersonal: ['Acme Corp'], names: ['Acme Corp'] })
  const t = h.thread()
  llm.script.length = 0; llm.requests.length = 0
  llm.script.push({ content: 'Acme Corp is on track.' })
  await (await h.agent.send({ threadId: t.id, text: 'Summarize where Acme Corp is with the rollout.' })).done
  expect(JSON.stringify(llm.requests[0].messages)).toContain('Acme Corp')
  expect(h.events.some((e) => e.type === 'pending')).toBe(false)
})

test('ask mode pauses on a card; unticking a detail remembers it for every chat', async () => {
  const h = harness({ mode: 'ask', names: ['Riverside Clinic'] })
  const t = h.thread()
  llm.script.length = 0; llm.requests.length = 0
  llm.script.push({ content: 'Booked a reminder for Riverside Clinic.' })
  const run = await h.agent.send({ threadId: t.id, text: 'Remind me about my Riverside Clinic appointment.' })
  for (let i = 0; i < 50 && !h.events.some((e) => e.type === 'pending'); i++) await new Promise((r) => setTimeout(r, 20))
  const card = h.events.find((e) => e.type === 'pending') as Extract<ChatEvent, { type: 'pending' }>
  expect(card.request.kind).toBe('privacy')
  const item = card.request.privacy!.items[0]
  h.agent.respond(t.id, card.request.id, JSON.stringify({ action: 'split', notPersonal: [item.id], remember: false }))
  await run.done
  expect(h.remembered).toEqual([notPersonalKey('private_person', 'Riverside Clinic')])
  expect(JSON.stringify(llm.requests[0].messages)).toContain('Riverside Clinic')
  expect(h.counts.asked).toBe(1)
})

test('a bare one-word name is never remembered as not personal (it could be anyone next time)', async () => {
  const h = harness({ mode: 'ask', names: ['Jordan'] })
  const t = h.thread()
  llm.script.length = 0; llm.requests.length = 0
  llm.script.push({ content: 'Noted.' })
  const run = await h.agent.send({ threadId: t.id, text: 'Jordan said the launch moved.' })
  for (let i = 0; i < 50 && !h.events.some((e) => e.type === 'pending'); i++) await new Promise((r) => setTimeout(r, 20))
  const card = h.events.find((e) => e.type === 'pending') as Extract<ChatEvent, { type: 'pending' }>
  h.agent.respond(t.id, card.request.id, JSON.stringify({ action: 'split', notPersonal: [card.request.privacy!.items[0].id], remember: false }))
  await run.done
  expect(h.remembered).toEqual([])
  // Shared in this chat (the user said so), just not remembered for others.
  expect(JSON.stringify(llm.requests[0].messages)).toContain('Jordan said')
})
