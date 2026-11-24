import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { Agent, RETRY_NOT_RUN, SKIPPED_STEP, STALL_PREFIX, runFailedText, stallNote, stopShown } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import type { ToolDef } from '../../src/main/agent/types'
import { Db } from '../../src/main/db'
import type { ChatEvent, Message, ModelInfo, Settings } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Mid-task control (report MCC-01/02, EHA-01, acceptance "Stop by words"): a typed stop ends the task at once with one
// "Stopped."; "Stop Test 5 now" and "Stop everything" find the chats they mean; the Stop button says "Stopped." once;
// a step that hangs says what is stuck, and Retry / Skip end only that step.
process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'
process.env.FOREMAN_STALL_MS = '500'

const model = { id: 'm', provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: 'M', vision: false, tier: 2, requiredGB: 1, maxFittingWindow: 131072, fits: true } as ModelInfo
let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close(); delete process.env.FOREMAN_STALL_MS })
beforeEach(() => { llm.script.length = 0 })

/** A read that waits until released (or its signal stops it), counting its calls. */
function hanging(name = 'slow_read', ignoreSignal = false): ToolDef<{ q: string }> & { calls: number; quick: boolean } {
  const t = {
    name, label: 'Read', effect: 'read' as const, description: 'read slowly', calls: 0, quick: false,
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
    async run(_a: { q: string }, ctx: { signal: AbortSignal }) {
      t.calls++
      if (t.quick) return { text: 'read it quickly' }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 20_000)
        if (!ignoreSignal) ctx.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('stopped', 'AbortError')) }, { once: true })
      })
      return { text: 'done reading' }
    }
  }
  return t as never
}

function setup(tools: ToolDef[] = [], o: { endpointFor?: () => unknown } = {}) {
  const db = new Db(':memory:')
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), ...tools)
  const events: ChatEvent[] = []
  const settings = { contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: {}, workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: 'm', hiddenModels: [], shownModels: [], cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [] } as unknown as Settings
  const last = { ok: true, models: [model], budgetGB: 32, totalGB: 64, providers: [] }
  let vault = false
  const agent = new Agent({
    db, results, registry, docsDir: tmpdir(), vaultWaiting: () => vault,
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: { last, for: o.endpointFor ?? (() => ({ provider: 'custom', baseUrl: llm.url })), usable: () => [model], list: async () => last, advisor: () => undefined } as never,
    spaces: { getPrompt: () => '' } as never, memory: { block: () => '' } as never,
    emit: (e) => events.push(e), secretValues: () => [], fitWindow: (_m, w) => w, counter: () => ({ count: async (t: string) => estimate(t) })
  })
  const space = db.createSpace('Bot', '#000')
  const thread = (title = 'Chat') => { const t = db.createThread(space.id, 'auto', 'm'); return db.updateThread(t.id, { title }) }
  return { db, agent, events, thread, setVault: (v: boolean) => { vault = v } }
}

const until = async (ok: () => boolean, ms = 8000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)) }
}
const assistantTexts = (db: Db, id: string): string[] => db.listMessages(id).filter((m) => m.role === 'assistant' && m.kind === 'normal' && m.content).map((m) => m.content)

test('a typed "Stop Test 5 now" stops the task at once and says "Stopped." once, with no model call', async () => {
  const slow = hanging()
  const { db, agent, thread } = setup([slow])
  llm.script.push({ toolCalls: [{ name: 'slow_read', arguments: '{"q":"x"}' }], delay: 0 })
  const t = thread('Test 5')
  const { done } = await agent.send({ threadId: t.id, text: 'Test 5: read the Downloads folder' })
  await until(() => slow.calls === 1)
  const asked = llm.requests.length
  const t0 = Date.now()
  expect(await agent.steer(t.id, 'Stop Test 5 now')).toBe('steered')
  expect(await done).toBe('stopped')
  expect(Date.now() - t0).toBeLessThan(10_000)
  expect(llm.requests.length).toBe(asked)
  expect(assistantTexts(db, t.id).filter((c) => /^Stopped/.test(c))).toEqual(['Stopped.'])
  // The stop stays in the chat, marked; Retry would ask for the task again, never the "stop".
  expect(db.listMessages(t.id).find((m) => m.content === 'Stop Test 5 now')?.meta?.stopRequest).toBe(true)
})

test('steering that mentions stopping still steers', async () => {
  const slow = hanging()
  const { agent, thread } = setup([slow])
  llm.script.push({ toolCalls: [{ name: 'slow_read', arguments: '{"q":"x"}' }], delay: 0 }, { content: 'Done.', delay: 0 })
  const t = thread('Trip')
  const { done } = await agent.send({ threadId: t.id, text: 'Plan the trip' })
  await until(() => slow.calls === 1)
  await agent.steer(t.id, 'stop using commas')
  agent.skipStep(t.id)
  expect(await done).toBe('finished')
})

test('"Stop everything" typed in an idle chat stops every running chat and answers there in one line', async () => {
  const a = hanging('read_a'), b = hanging('read_b')
  const { db, agent, thread } = setup([a, b])
  llm.script.push({ toolCalls: [{ name: 'read_a', arguments: '{"q":"x"}' }], delay: 0 }, { toolCalls: [{ name: 'read_b', arguments: '{"q":"y"}' }], delay: 0 })
  const ta = thread('Invoice'), tb = thread('Photo renamer'), idle = thread('Chat')
  const ra = await agent.send({ threadId: ta.id, text: 'Make the invoice' })
  await until(() => a.calls === 1)
  const rb = await agent.send({ threadId: tb.id, text: 'Write the renamer' })
  await until(() => b.calls === 1)
  const asked = llm.requests.length
  await agent.send({ threadId: idle.id, text: 'Stop everything' })
  expect(await ra.done).toBe('stopped')
  expect(await rb.done).toBe('stopped')
  expect(llm.requests.length).toBe(asked)
  expect(assistantTexts(db, idle.id)).toEqual(['Stopped Invoice and Photo renamer.'])
  // A note about other chats: this chat's own last task is not marked stopped (no Retry, no "Stopped after…").
  const note = db.listMessages(idle.id).find((m) => m.role === 'assistant')!
  expect(note.meta?.stopped).toBeUndefined()
  expect(note.meta?.stopNote).toBe(true)
  // Each stopped chat says so too, once.
  expect(assistantTexts(db, ta.id).filter((c) => c === 'Stopped.')).toHaveLength(1)
  expect(assistantTexts(db, tb.id).filter((c) => c === 'Stopped.')).toHaveLength(1)
  // Nothing running: it says so, still without a model call.
  await agent.send({ threadId: idle.id, text: 'stop all tasks' })
  expect(assistantTexts(db, idle.id).at(-1)).toBe('Nothing was running.')
  expect(llm.requests.length).toBe(asked)
})

test('a stop that names another running chat stops that one; an idle "stop" in a quiet chat is just a message', async () => {
  const slow = hanging()
  const { db, agent, thread } = setup([slow])
  llm.script.push({ toolCalls: [{ name: 'slow_read', arguments: '{"q":"x"}' }], delay: 0 })
  const work = thread('Test 5'), other = thread('Chat')
  const r = await agent.send({ threadId: work.id, text: 'Test 5: research printers' })
  await until(() => slow.calls === 1)
  await agent.send({ threadId: other.id, text: 'Stop Test 5 now' })
  expect(await r.done).toBe('stopped')
  expect(assistantTexts(db, other.id)).toEqual(['Stopped Test 5.'])
  // Nothing by that name runs: an ordinary message (the model answers it).
  llm.script.push({ content: 'Nothing to stop here.', delay: 0 })
  await (await agent.send({ threadId: other.id, text: 'cancel the 3pm meeting' })).done
  expect(assistantTexts(db, other.id).at(-1)).toBe('Nothing to stop here.')
})

test('the Stop button in the middle of a step says "Stopped." once when the run ends', async () => {
  const slow = hanging()
  const { db, agent, thread } = setup([slow])
  llm.script.push({ toolCalls: [{ name: 'slow_read', arguments: '{"q":"x"}' }], delay: 0 })
  const t = thread()
  const { done } = await agent.send({ threadId: t.id, text: 'Read it' })
  await until(() => slow.calls === 1)
  agent.stop(t.id, { byUser: true })
  expect(await done).toBe('stopped')
  expect(assistantTexts(db, t.id)).toEqual(['Stopped.'])
  // A stop that isn't the user's (a deleted bot, a voice barge-in) adds nothing.
  llm.script.push({ toolCalls: [{ name: 'slow_read', arguments: '{"q":"y"}' }], delay: 0 })
  const again = await agent.send({ threadId: t.id, text: 'Read it again' })
  await until(() => slow.calls === 2)
  agent.stop(t.id)
  expect(await again.done).toBe('stopped')
  expect(assistantTexts(db, t.id)).toEqual(['Stopped.'])
})

test('a hanging step: the stall note names it, and Skip ends only that step (the task carries on)', async () => {
  const slow = hanging('slow_read', true)
  const { db, agent, events, thread } = setup([slow])
  llm.script.push({ toolCalls: [{ name: 'slow_read', arguments: '{"q":"Downloads"}' }], delay: 0 }, { content: 'I skipped the slow read.', delay: 0 })
  const t = thread()
  const { done } = await agent.send({ threadId: t.id, text: 'Read my Downloads folder' })
  await until(() => events.some((e) => e.type === 'tool_progress' && e.callId === 'watchdog' && !!e.text))
  const note = events.find((e) => e.type === 'tool_progress' && e.callId === 'watchdog' && !!e.text) as Extract<ChatEvent, { type: 'tool_progress' }>
  expect(note.text.startsWith(STALL_PREFIX)).toBe(true)
  expect(note.stuck).toBe(true)
  expect(note.step).toBe('This step')
  expect(note.text).toMatch(/Retry it, skip it/)
  // The tool ignores its signal: Skip lets it go anyway.
  expect(agent.skipStep(t.id)).toBe(true)
  expect(await done).toBe('finished')
  const result = db.listMessages(t.id).find((m) => m.role === 'tool')
  expect(result?.content).toContain(SKIPPED_STEP.slice(0, 40))
  expect(assistantTexts(db, t.id).at(-1)).toBe('I skipped the slow read.')
  expect(agent.skipStep(t.id)).toBe(false)
})

test('Retry runs a hanging read again', async () => {
  const slow = hanging()
  const { db, agent, thread } = setup([slow])
  llm.script.push({ toolCalls: [{ name: 'slow_read', arguments: '{"q":"x"}' }], delay: 0 }, { content: 'Read it.', delay: 0 })
  const t = thread()
  const { done } = await agent.send({ threadId: t.id, text: 'Read it' })
  await until(() => slow.calls === 1)
  slow.quick = true
  expect(agent.retryStep(t.id)).toBe(true)
  expect(await done).toBe('finished')
  expect(slow.calls).toBe(2)
  expect(db.listMessages(t.id).find((m) => m.role === 'tool')?.content).toContain('read it quickly')
})

test('a silent model: the note names it, and Retry asks again', async () => {
  const { db, agent, events, thread } = setup()
  llm.script.push({ content: 'Thinking about it slowly forever', delay: 4000 }, { content: 'Here it is.', delay: 0 })
  const t = thread()
  const { done } = await agent.send({ threadId: t.id, text: 'Write a haiku' })
  await until(() => events.some((e) => e.type === 'tool_progress' && e.callId === 'watchdog' && !!e.text))
  const note = events.find((e) => e.type === 'tool_progress' && e.callId === 'watchdog' && !!e.text) as Extract<ChatEvent, { type: 'tool_progress' }>
  expect(note.step).toBe('Waiting for M to answer')
  expect(agent.retryStep(t.id)).toBe(true)
  expect(await done).toBe('finished')
  expect(assistantTexts(db, t.id).at(-1)).toBe('Here it is.')
  // The frozen half answer goes out of sight: no error bubble above the real answer.
  expect(db.listMessages(t.id).filter((m) => m.role === 'assistant' && m.status === 'error' && !m.meta?.superseded && !m.meta?.provisional)).toEqual([])
})

test('Stop ends the run at once even under a tool that ignores its signal', async () => {
  const slow = hanging('slow_read', true)
  const { db, agent, events, thread } = setup([slow])
  llm.script.push({ toolCalls: [{ name: 'slow_read', arguments: '{"q":"x"}' }], delay: 0 })
  const t = thread()
  const { done } = await agent.send({ threadId: t.id, text: 'Read it' })
  await until(() => slow.calls === 1)
  const t0 = Date.now()
  await agent.steer(t.id, 'stop')
  expect(await done).toBe('stopped')
  expect(Date.now() - t0).toBeLessThan(1000)
  expect(assistantTexts(db, t.id).filter((c) => c === 'Stopped.')).toHaveLength(1)
  // The chat hears it was you (its queued messages then wait for you instead of starting new work).
  expect(events.some((e) => e.type === 'run' && e.status === 'stopped' && e.byUser)).toBe(true)
})

test('Retry on a hung step that may have changed something is not run again, and the model hears why', async () => {
  const slow = { ...hanging('slow_write', true), effect: 'write' as const }
  slow.run = hanging('slow_write', true).run.bind(slow)
  const { db, agent, events, thread } = setup([slow as never])
  llm.script.push({ toolCalls: [{ name: 'slow_write', arguments: '{"q":"x"}' }], delay: 0 }, { content: 'Checked it.', delay: 0 })
  const t = thread()
  const { done } = await agent.send({ threadId: t.id, text: 'Write it' })
  await until(() => events.some((e) => e.type === 'tool_progress' && e.callId === 'watchdog' && !!e.text))
  const note = events.find((e) => e.type === 'tool_progress' && e.callId === 'watchdog' && !!e.text) as Extract<ChatEvent, { type: 'tool_progress' }>
  expect(note.retryable).toBe(false)
  expect(note.text).toMatch(/Skip it, or keep waiting/)
  expect(agent.retryStep(t.id)).toBe(true)
  expect(await done).toBe('finished')
  expect(db.listMessages(t.id).find((m) => m.role === 'tool')?.content).toContain(RETRY_NOT_RUN.slice(0, 40))
})

test('waiting on the vault unlock is not "slow": the note says it waits on you, once', async () => {
  const slow = hanging()
  const { agent, events, thread, setVault } = setup([slow])
  setVault(true)
  llm.script.push({ toolCalls: [{ name: 'slow_read', arguments: '{"q":"x"}' }], delay: 0 })
  const t = thread()
  const { done } = await agent.send({ threadId: t.id, text: 'Log in' })
  await until(() => slow.calls === 1)
  await new Promise((r) => setTimeout(r, 1800))
  agent.stop(t.id, { byUser: true })
  await done
  const notes = events.filter((e) => e.type === 'tool_progress' && e.callId === 'watchdog' && !!e.text) as Array<{ text: string; waitingOnYou?: boolean }>
  expect(notes).toHaveLength(1)
  expect(notes[0].text).toMatch(/unlock your vault/)
  expect(notes[0].waitingOnYou).toBe(true)
})

test('a step waiting on a macOS dialog: the stall note says what to do, not "slow"', async () => {
  const slow = hanging('slow_read', true)
  const inner = slow.run
  slow.run = async (a: { q: string }, ctx: { signal: AbortSignal; progress?: (t: string, o?: { waitingOnYou?: boolean }) => void }) => { ctx.progress?.('macOS may be asking to let SahilBot open your Downloads folder. Look for its dialog and click OK', { waitingOnYou: true }); return inner(a, ctx as never) }
  const { agent, events, thread } = setup([slow])
  llm.script.push({ toolCalls: [{ name: 'slow_read', arguments: '{"q":"x"}' }], delay: 0 })
  const t = thread()
  const { done } = await agent.send({ threadId: t.id, text: 'Read my Downloads' })
  await until(() => events.some((e) => e.type === 'tool_progress' && e.callId === 'watchdog' && !!e.text))
  const note = events.find((e) => e.type === 'tool_progress' && e.callId === 'watchdog' && !!e.text) as Extract<ChatEvent, { type: 'tool_progress' }>
  expect(note.text).toBe(`${STALL_PREFIX} macOS may be asking to let SahilBot open your Downloads folder. Look for its dialog and click OK.`)
  expect(note.waitingOnYou).toBe(true)
  expect(note.stuck).toBe(true)
  agent.stop(t.id, { byUser: true })
  await done
})

test('a run that fails inside the loop posts one plain sentence with Retry, never a raw "Something went wrong"', async () => {
  let calls = 0
  const { db, agent, thread } = setup([], { endpointFor: () => { if (++calls > 1) throw new Error('Auto (cloud) has no model to use: no key'); return { provider: 'custom', baseUrl: llm.url } } })
  const t = thread()
  const { done } = await agent.send({ threadId: t.id, text: 'Plan the trip' })
  expect(await done).toBe('error')
  const notes = db.listMessages(t.id).filter((m) => m.kind === 'notice')
  expect(notes.length).toBeGreaterThan(0)
  for (const n of notes) expect(n.content).not.toMatch(/^Something went wrong/)
  expect(notes.at(-1)?.meta?.runFailed).toBe(true)
  expect(String(notes.at(-1)?.meta?.detail)).toMatch(/no model to use/)
})

test('the stall note and a failed run are plain sentences', () => {
  expect(stallNote('Reading a page', 2)).toBe(`${STALL_PREFIX} reading a page is taking longer than usual (2 min). Retry it, skip it, or keep waiting.`)
  expect(stallNote(undefined, 1)).toMatch(/this step is taking longer/)
  expect(runFailedText(Object.assign(new Error('Model server returned 401: {"error":"bad key"}'), { status: 401 }))).toBe('Couldn\'t finish: the AI service refused its key. Check it in Settings → AI, then press Retry.')
  expect(runFailedText(Object.assign(new Error('Model server returned 500: {json}'), { status: 500 }))).toMatch(/^Couldn't finish: the AI service is having a server error right now\. Press Retry/)
  expect(runFailedText(new Error('weird'))).toBe('Couldn\'t finish this task. Press Retry to try again.')
  const m = (role: Message['role'], o: Partial<Message> = {}): Message => ({ id: Math.random().toString(), threadId: 't', role, content: 'x', kind: 'normal', status: 'done', createdAt: 0, ...o }) as Message
  expect(stopShown([m('user'), m('assistant', { status: 'stopped' })])).toBe(true)
  expect(stopShown([m('user'), m('assistant', { meta: { stopped: true } })])).toBe(true)
  expect(stopShown([m('assistant', { status: 'stopped' }), m('user'), m('tool')])).toBe(false)
})
