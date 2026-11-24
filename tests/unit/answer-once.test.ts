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

async function run(script: MockLlm['script'], text: string, o: { meta?: Record<string, unknown>; during?: (agent: Agent, threadId: string, db: Db) => Promise<void>; then?: Array<{ script: MockLlm['script']; text: string }>; tools?: ToolDef[] } = {}) {
  const model = { id: 'm', provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: 'M', vision: false, tier: 2, requiredGB: 1, maxFittingWindow: 131072, fits: true } as unknown as ModelInfo
  const saves: string[] = []
  const save: ToolDef = { name: 'save_invoice', label: 'Save', core: true, effect: 'write_local', description: 'Save an invoice file', parameters: { type: 'object', properties: { name: { type: 'string' } } }, run: async (a: { name?: string }) => { saves.push(a.name ?? ''); return { text: `Saved ${a.name}` } } }
  const db = new Db(':memory:')
  const settings = { contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true }, workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: 'm', hiddenModels: [], shownModels: [], cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [] } as unknown as Settings
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), save as ToolDef, ...(o.tools ?? []))
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
  const started = await agent.send({ threadId: t.id, text, ...(o.meta ? { meta: o.meta } : {}) })
  if (o.during) await o.during(agent, t.id, db)
  let status = await started.done
  const before = db.listMessages(t.id).length
  for (const next of o.then ?? []) {
    llm.script.length = 0
    llm.script.push(...next.script)
    status = await (await agent.send({ threadId: t.id, text: next.text })).done
  }
  const all = db.listMessages(t.id)
  const answers = all.filter((m) => m.role === 'assistant' && m.content && !m.toolCalls?.length && !m.meta?.superseded)
  const hidden = all.filter((m) => m.role === 'user' && m.meta?.hidden).map((m) => m.content)
  const requests = llm.requests.length
  const requestLog = [...llm.requests]
  llm.script.length = 0; llm.requests.length = 0
  return { status, answers, hidden, saves, events, requests, all, before, db, threadId: t.id, requestLog }
}

/** The assistant texts the user sees in the chat (shown, not replaced), in order. */
const visible = (all: Message[]): Message[] => all.filter((m) => m.role === 'assistant' && m.kind === 'normal' && m.content && !m.toolCalls?.length && !m.meta?.superseded && !m.meta?.provisional)

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

// ---- Round 2 (RLB-01/02, RLA-05, RLC-08, PCA-04): one reply per message, every way a run can end.

/** Every emit of a message with words was out of sight (it was never on screen). */
const neverShown = (events: Array<{ type: string; message?: Message }>, id: string): boolean =>
  events.filter((e) => e.type === 'message' && e.message?.id === id && e.message.content).every((e) => e.message!.meta?.provisional || e.message!.meta?.superseded)

const withVerify = async <T>(f: () => Promise<T>): Promise<T> => {
  delete process.env.FOREMAN_NO_VERIFY
  try { return await f() } finally { process.env.FOREMAN_NO_VERIFY = '1' }
}

test('a chat reply that opens with "I can\'t…" is held, sent back, and only the real answer shows', async () => {
  const r = await run([
    { content: 'I can\'t access real-time weather data. You could check a weather site.' },
    { content: 'It\'s 61°F and sunny in Atlanta right now.' }
  ], 'What\'s the weather in Atlanta right now?')
  expect(r.status).toBe('finished')
  expect(r.hidden.some((h) => /You said you can't/.test(h))).toBe(true)
  expect(visible(r.all).map((m) => m.content)).toEqual(['It\'s 61°F and sunny in Atlanta right now.'])
  const first = r.all.find((m) => m.role === 'assistant' && m.content.startsWith('I can\'t'))!
  expect(neverShown(r.events, first.id)).toBe(true)
}, 60_000)

test('agent work\'s first reply is held from step 1: a false "Done, I saved it" never shows next to the real one', async () => {
  const r = await run([
    { content: 'Done, I saved budget.xlsx.' },
    { toolCalls: [{ name: 'save_invoice', arguments: JSON.stringify({ name: 'budget.xlsx' }) }] },
    { content: 'Saved budget.xlsx to Downloads.' }
  ], 'Make my budget spreadsheet as budget.xlsx')
  expect(r.saves).toEqual(['budget.xlsx'])
  expect(visible(r.all).map((m) => m.content)).toEqual(['Saved budget.xlsx to Downloads.'])
  const first = r.all.find((m) => m.content === 'Done, I saved budget.xlsx.')!
  expect(neverShown(r.events, first.id)).toBe(true)
}, 60_000)

test('a step\'s opening words show as soon as it calls a tool (only a final reply waits)', async () => {
  const r = await run([
    { content: 'Saving the invoice now.', toolCalls: [{ name: 'save_invoice', arguments: JSON.stringify({ name: 'invoice.pdf' }) }] },
    { content: 'Saved invoice.pdf.' }
  ], 'Make the invoice PDF for Acme')
  const step = r.all.find((m) => m.role === 'assistant' && m.toolCalls?.length)!
  // Shown with its words before the step finished (an emit with content and no provisional flag while streaming).
  expect(r.events.some((e) => e.type === 'message' && e.message?.id === step.id && !e.message.meta?.provisional && e.message.status === 'streaming')).toBe(true)
}, 60_000)

test('a question after a change ends the run: no hidden double-check first', async () => {
  const r = await withVerify(() => run([
    { toolCalls: [{ name: 'save_invoice', arguments: JSON.stringify({ name: 'draft.pdf' }) }] },
    { content: 'Saved a draft. Which date works, Friday or Saturday?' },
    { content: '✓' }
  ], 'Draft the dinner invite'))
  expect(r.status).toBe('finished')
  expect(r.requests).toBe(2)
  expect(r.hidden.some((h) => /double-check/i.test(h))).toBe(false)
  const q = visible(r.all).at(-1)!
  expect(q.content).toBe('Saved a draft. Which date works, Friday or Saturday?')
  expect(q.meta?.provisional).toBeUndefined()
  expect(q.meta?.superseded).toBeFalsy()
}, 60_000)

test('a question for the user is not sent back by the completion checks, nor marked unconfirmed', async () => {
  const r = await run([
    { content: 'Which months should I include, Sep–Dec or the full year?' },
    { content: 'Saved budget.xlsx.' }
  ], 'Make budget.xlsx for my fall classes', { meta: { autoRead: { assessment: { files: ['budget.xlsx'] } } } })
  expect(r.status).toBe('finished')
  expect(r.requests).toBe(1)
  expect(r.hidden.some((h) => /Completion checks are unresolved/.test(h))).toBe(false)
  expect(visible(r.all).map((m) => m.content)).toEqual(['Which months should I include, Sep–Dec or the full year?'])
}, 60_000)

test('"stop" during the double-check: the answer stays, "Stopped." stays, nothing else shows', async () => {
  const r = await withVerify(() => run([
    { toolCalls: [{ name: 'save_invoice', arguments: JSON.stringify({ name: 'invoice.pdf' }) }] },
    { content: 'Saved invoice.pdf to Downloads.' },
    { content: 'Looking at every line of the invoice again to be sure the totals and the address are right before you send it.', delay: 120 }
  ], 'Make the invoice PDF for Acme', {
    during: async (agent, threadId) => {
      for (let i = 0; i < 200 && llm.requests.length < 3; i++) await new Promise((ok) => setTimeout(ok, 25))
      await new Promise((ok) => setTimeout(ok, 150))
      await agent.steer(threadId, 'stop')
    }
  }))
  expect(r.status).toBe('stopped')
  const stopAt = r.all.findIndex((m) => m.role === 'user' && m.content === 'stop')
  const shown = visible(r.all)
  expect(shown.filter((m) => m.content === 'Saved invoice.pdf to Downloads.')).toHaveLength(1)
  expect(shown.filter((m) => m.content === 'Stopped.')).toHaveLength(1)
  expect(shown.filter((m) => r.all.indexOf(m) > stopAt).map((m) => m.content)).toEqual(['Stopped.'])
}, 60_000)

test('a plan left by a stopped task waits: an unrelated question is answered as itself; "Continue." resumes it', async () => {
  const r = await run([
    { toolCalls: [todo('in_progress')] },
    { content: 'Looking at tables for Friday and Saturday evenings near downtown for four people.', delay: 150 }
  ], 'Book us a dinner table this weekend', {
    during: async (agent, threadId) => {
      for (let i = 0; i < 200 && llm.requests.length < 2; i++) await new Promise((ok) => setTimeout(ok, 25))
      await new Promise((ok) => setTimeout(ok, 150))
      await agent.steer(threadId, 'stop')
    },
    then: [{ script: [{ content: 'Paris.' }, { content: 'Back to the table booking.' }], text: 'What\'s the capital of France?' }]
  })
  expect(r.status).toBe('finished')
  const after = r.all.slice(r.before)
  expect(after.some((m) => m.meta?.hidden && /plan still has open items/.test(m.content))).toBe(false)
  expect(visible(after).map((m) => m.content)).toEqual(['Paris.'])
  expect(r.db.getState(r.threadId).lastKind).toBe('chat')
  expect(r.db.getState(r.threadId).planPaused).toBe(true)
  // The stopped task picks up again when asked.
  const { continuesPlan, planLive } = await import('../../src/main/agent/loop')
  expect(continuesPlan({ content: 'Continue.' })).toBe(true)
  expect(continuesPlan({ content: 'What\'s the capital of France?' })).toBe(false)
  const st = r.db.getState(r.threadId)
  expect(planLive(st, { content: 'Continue.' })).toBe(true)
  expect(planLive(st, { content: 'What\'s the capital of France?' })).toBe(false)
}, 60_000)

test('an answer sent back for one more step stands when the next step fails', async () => {
  const r = await run([
    { toolCalls: [todo('in_progress')] },
    { content: 'Friday at 7 works best for a table of four.' },
    { status: 400, errorMessage: 'bad request' },
    { status: 400, errorMessage: 'bad request' },
    { status: 400, errorMessage: 'bad request' }
  ], 'Book us a dinner table this weekend')
  expect(r.status).toBe('error')
  expect(r.hidden.some((h) => /plan still has open items/.test(h))).toBe(true)
  expect(visible(r.all).map((m) => m.content)).toContain('Friday at 7 works best for a table of four.')
}, 60_000)

test('testing the script it wrote is the check: no extra double-check round (PCA-04)', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'code-'))
  const fileWrite: ToolDef = { name: 'file_write', label: 'Write', core: true, effect: 'write_local', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' } } }, run: async (a: { path?: string }) => ({ text: `Wrote ${a.path}`, path: join(ws, a.path ?? 'x.py') }) }
  const shell: ToolDef = { name: 'run_command', label: 'Terminal', core: true, effect: 'write_local', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } }, run: async (a: { command?: string }) => ({ text: `$ ${a.command}\n(exit code 0)\nWould rename 3 photos`, data: { exitCode: 0 } }) }
  const script = (command: string): MockLlm['script'] => [
    { toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path: 'rename_photos.py' }) }] },
    { toolCalls: [{ name: 'run_command', arguments: JSON.stringify({ command }) }] },
    { content: 'Wrote rename_photos.py and tested it on a dry run: it renames 3 photos.' },
    { content: '✓' }
  ]
  const tested = await withVerify(() => run(script('python3 rename_photos.py --dry-run'), 'Write a script that renames my photos by date', { tools: [fileWrite, shell] }))
  expect(tested.hidden.some((h) => /double-check/i.test(h))).toBe(false)
  expect(tested.requests).toBe(3)
  // Writing its output into a file is a change, not a check: the double-check still runs.
  const redirected = await withVerify(() => run(script('python3 rename_photos.py > out.csv'), 'Write a script that renames my photos by date', { tools: [fileWrite, shell] }))
  expect(redirected.requests).toBe(4)
}, 60_000)
