import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import { UNVERIFIED_NOTE } from '../../src/main/agent/runtime/verification'
import type { ToolDef } from '../../src/main/agent/types'
import { Db } from '../../src/main/db'
import type { Message, ModelInfo, Settings } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Grok Bot head-to-head (RLB-01/02, RLC-08): check first, post once. A finished task's offer of a next step is not
// taken unasked, a question for the user ends the run, the plan nudge never leaves two answers, and a "done" that
// nothing backs is said plainly.
process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'
let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })

const todo = (status: 'in_progress' | 'pending') => ({ name: 'todo', arguments: JSON.stringify({ items: [{ text: 'Pick the date', status }, { text: 'Book the table', status: 'pending' }] }) })

async function run(script: MockLlm['script'], text: string) {
  const model = { id: 'm', provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: 'M', vision: false, tier: 2, requiredGB: 1, maxFittingWindow: 131072, fits: true } as unknown as ModelInfo
  const saves: string[] = []
  const save: ToolDef = { name: 'save_invoice', label: 'Save', core: true, effect: 'write_local', description: 'Save an invoice file', parameters: { type: 'object', properties: { name: { type: 'string' } } }, run: async (a: { name?: string }) => { saves.push(a.name ?? ''); return { text: `Saved ${a.name}` } } }
  const db = new Db(':memory:')
  const settings = { contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true }, workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: 'm', hiddenModels: [], shownModels: [], cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [] } as unknown as Settings
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), save as ToolDef)
  const last = { ok: true, models: [model], budgetGB: 32, totalGB: 64, providers: [] }
  const events: Array<{ type: string; message?: Message }> = []
  const agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => [model], list: async () => last, advisor: () => undefined } as never,
    spaces: { getPrompt: () => '' } as never, memory: { block: () => '' } as never,
    emit: (e: { type: string; message?: Message }) => { events.push(e.message ? { ...e, message: JSON.parse(JSON.stringify(e.message)) } : e) }, secretValues: () => [], fitWindow: (_m, w) => w, counter: () => ({ count: async (t: string) => estimate(t) })
  })
  llm.script.push(...script)
  const space = db.createSpace('Alpha', '#000000')
  const t = db.createThread(space.id, 'auto', 'm')
  const status = await (await agent.send({ threadId: t.id, text })).done
  const all = db.listMessages(t.id)
  const answers = all.filter((m) => m.role === 'assistant' && m.content && !m.toolCalls?.length && !m.meta?.superseded)
  const hidden = all.filter((m) => m.role === 'user' && m.meta?.hidden).map((m) => m.content)
  const requests = llm.requests.length
  llm.script.length = 0; llm.requests.length = 0
  return { status, answers, hidden, saves, events, requests }
}

test('a finished task that offers one more step ends there: the offer is not taken unasked, the reply stays', async () => {
  const r = await run([
    { toolCalls: [{ name: 'save_invoice', arguments: JSON.stringify({ name: 'invoice.pdf' }) }] },
    { content: 'Saved invoice.pdf to Downloads.\n\nWant me to email this to Sam?' },
    { content: 'Emailing it to Sam now.' }
  ], 'Make the invoice PDF for Acme')
  expect(r.status).toBe('finished')
  expect(r.requests).toBe(2)
  expect(r.hidden.some((h) => /Don't stop to ask permission/.test(h))).toBe(false)
  expect(r.answers.map((m) => m.content)).toEqual(['Saved invoice.pdf to Downloads.\n\nWant me to email this to Sam?'])
  // Written out of sight (it could have been checked or sent back), then posted once, final.
  const final = r.answers[0]
  expect(final.meta?.provisional).toBeUndefined()
  const shown = r.events.filter((e) => e.type === 'message' && e.message?.id === final.id)
  expect(shown.some((e) => e.message?.meta?.superseded)).toBe(false)
}, 60_000)

test('a question for the user ends the run at once, even with plan items open', async () => {
  const r = await run([
    { toolCalls: [todo('in_progress')] },
    { content: 'Which date works, Friday or Saturday?' },
    { content: 'I picked Friday.' }
  ], 'Book us a dinner table this weekend')
  expect(r.status).toBe('finished')
  expect(r.requests).toBe(2)
  expect(r.hidden.some((h) => /plan still has open items/.test(h))).toBe(false)
  expect(r.answers.map((m) => m.content)).toEqual(['Which date works, Friday or Saturday?'])
}, 60_000)

test('the open-plan nudge sends the first answer back: exactly one answer remains', async () => {
  const r = await run([
    { toolCalls: [todo('in_progress')] },
    { toolCalls: [{ name: 'save_invoice', arguments: JSON.stringify({ name: 'budget.xlsx' }) }] },
    { content: 'Saved budget.xlsx.' },
    { content: 'Saved budget.xlsx with the totals.' }
  ], 'Make my budget spreadsheet')
  expect(r.status).toBe('finished')
  expect(r.hidden.some((h) => /plan still has open items/.test(h))).toBe(true)
  expect(r.answers.map((m) => m.content)).toEqual(['Saved budget.xlsx with the totals.'])
  // The one sent back was never shown as an answer: held out of sight, then superseded (kept until the next was written).
  const first = r.events.filter((e) => e.type === 'message' && e.message?.content === 'Saved budget.xlsx.').map((e) => e.message!)
  expect(first.length).toBeGreaterThan(0)
  expect(first.at(-1)?.meta).toMatchObject({ superseded: true })
}, 60_000)

test('a "done" claim nothing backs is nudged once, then said plainly instead of passed on as done', async () => {
  const r = await run([
    { toolCalls: [{ name: 'save_invoice', arguments: JSON.stringify({ name: 'invoice.pdf' }) }] },
    { content: 'I\'ve emailed the invoice to Sam.' },
    { content: 'I\'ve emailed the invoice to Sam.' }
  ], 'Make the invoice and email it to Sam')
  expect(r.hidden.some((h) => /nothing in this task actually did it|Your reply says it is done/.test(h))).toBe(true)
  expect(r.status).toBe('error')
  expect(r.answers).toHaveLength(1)
  expect(r.answers[0].content).toContain(UNVERIFIED_NOTE)
}, 60_000)

test('a claim the run backs is left alone', async () => {
  const r = await run([
    { toolCalls: [{ name: 'save_invoice', arguments: JSON.stringify({ name: 'invoice.pdf' }) }] },
    { content: 'I\'ve saved invoice.pdf to Downloads.' }
  ], 'Make the invoice PDF')
  expect(r.status).toBe('finished')
  expect(r.requests).toBe(2)
  expect(r.answers[0].content).not.toContain(UNVERIFIED_NOTE)
}, 60_000)

test('a quick answer with nothing to check streams live (not held)', async () => {
  const r = await run([{ content: 'Water boils at 100 °C at sea level.' }], 'At what temperature does water boil?')
  expect(r.status).toBe('finished')
  expect(r.answers[0].meta?.provisional).toBeUndefined()
  expect(r.events.filter((e) => e.type === 'message' && e.message?.id === r.answers[0].id).some((e) => e.message?.meta?.provisional)).toBe(false)
}, 60_000)
