import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import type { ToolDef } from '../../src/main/agent/types'
import { Learner, QuestionQueue, QuestionStore, createQuestionHost, matchTyped, resumeMessage, type ResumeMessage, type StoredItem } from '../../src/main/agent/questions'
import { Db } from '../../src/main/db'
import type { ChatEvent, ModelInfo, Settings } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'

const H = 3_600_000

/** A queue over a database with a hand-set clock; resumes and notifications are recorded. */
function queueOn(db: Db, o: { held?: () => string | null; failResume?: () => boolean } = {}) {
  const clock = { now: Date.parse('2026-11-15T09:00:00') }
  const store = new QuestionStore(db, () => clock.now)
  const resumed: Array<{ item: StoredItem; msg: ResumeMessage }> = []
  const notified: Array<{ title: string; body: string }> = []
  const notices: string[] = []
  const queue = new QuestionQueue({
    store, now: () => clock.now, learner: new Learner(store, undefined, () => clock.now),
    notify: (_i, n) => notified.push(n),
    resume: (item, msg) => { if (o.failResume?.()) throw new Error('busy'); resumed.push({ item, msg }) },
    held: o.held, notice: (_t, text) => notices.push(text), botName: () => 'Scout', threadExists: (id) => !!db.getThread(id)
  })
  return { clock, store, queue, resumed, notified, notices }
}

function bot(db: Db) {
  const space = db.createSpace('Scout', '#123456')
  const thread = db.createThread(space.id, 'autonomous', null)
  return { space, thread }
}

describe('the question queue: post, answer later, resume', () => {
  test('posting notifies ("<Bot> has a question"); a later answer resumes the bot with it, once', async () => {
    const db = new Db(':memory:')
    const { space, thread } = bot(db)
    const q = queueOn(db)
    const { item } = q.queue.postQuestions({ botId: space.id, threadId: thread.id, questions: [{ question: 'Which format for the weekly report?', options: ['PDF (recommended)', 'Word'] }], deadlineMs: 4 * H })
    expect(q.notified).toEqual([{ title: 'Scout has a question', body: 'Which format for the weekly report?', actions: ['PDF', 'Word'] }])
    expect(item.deadline).toBe(q.clock.now + 4 * H)
    expect(q.queue.inbox().map((x) => x.id)).toEqual([item.id])
    expect(q.resumed).toHaveLength(0)

    q.clock.now += H
    const done = await q.queue.answer(item.id, ['Word'])
    expect(done).toMatchObject({ status: 'answered', answeredBy: 'user', answers: ['Word'], resumed: true })
    expect(q.resumed).toHaveLength(1)
    expect(q.resumed[0].msg).toMatchObject({ hidden: false, unattended: false, text: 'Answer to "Which format for the weekly report?": Word' })
    expect(q.resumed[0].msg.note).toMatch(/Pick up the part of the task that was waiting/)
    // Answering again (or a tick) never resumes twice.
    await q.queue.answer(item.id, ['PDF'])
    await q.queue.tick()
    expect(q.resumed).toHaveLength(1)
    expect(q.queue.inbox()).toHaveLength(0)
  })

  test('one run\'s questions are batched into one card', () => {
    const db = new Db(':memory:')
    const { space, thread } = bot(db)
    const q = queueOn(db)
    const a = q.queue.postQuestions({ botId: space.id, threadId: thread.id, runKey: 'run1', questions: [{ question: 'Weekly or monthly?', options: ['Weekly', 'Monthly'] }], deadlineMs: H })
    const b = q.queue.postQuestions({ botId: space.id, threadId: thread.id, runKey: 'run1', questions: [{ question: 'Which folder?', options: ['Reports', 'Desktop'] }, { question: 'Weekly or monthly?' }], deadlineMs: H })
    expect(b.merged).toBe(true)
    expect(b.item.id).toBe(a.item.id)
    expect(b.item.questions.map((x) => x.question)).toEqual(['Weekly or monthly?', 'Which folder?'])
    expect(q.notified).toHaveLength(1)
    const c = q.queue.postQuestions({ botId: space.id, threadId: thread.id, runKey: 'run2', questions: [{ question: 'Another run?' }], deadlineMs: H })
    expect(c.merged).toBe(false)
    expect(q.queue.inbox()).toHaveLength(2)
  })

  test('the bot is busy when the answer arrives: it is retried on the next tick', async () => {
    const db = new Db(':memory:')
    const { space, thread } = bot(db)
    let fail = true
    const q = queueOn(db, { failResume: () => fail })
    const { item } = q.queue.postQuestions({ botId: space.id, threadId: thread.id, questions: [{ question: 'Go?', options: ['Yes', 'No'] }], deadlineMs: H })
    await q.queue.answer(item.id, ['Yes'])
    expect(q.store.get(item.id)!.resumed).toBe(false)
    fail = false
    await q.queue.tick()
    expect(q.resumed).toHaveLength(1)
    expect(q.store.get(item.id)!.resumed).toBe(true)
  })

  test('over the spending limit: the answer is kept and picked up once it can spend again', async () => {
    const db = new Db(':memory:')
    const { space, thread } = bot(db)
    let held: string | null = 'the monthly spending limit is used up'
    const q = queueOn(db, { held: () => held })
    const { item } = q.queue.postQuestions({ botId: space.id, threadId: thread.id, questions: [{ question: 'Go?', options: ['Yes', 'No'] }], deadlineMs: H })
    await q.queue.answer(item.id, ['Yes'])
    expect(q.resumed).toHaveLength(0)
    expect(q.notices.join('\n')).toMatch(/picks this up once it can spend again/)
    await q.queue.tick()
    expect(q.notices.filter((n) => /spend again/.test(n))).toHaveLength(1)
    held = null
    await q.queue.tick()
    expect(q.resumed).toHaveLength(1)
  })
})

describe('deadlines: the default only when it is safe', () => {
  test('a safe, reversible default goes ahead at the deadline, is stated, and is marked for review', async () => {
    const db = new Db(':memory:')
    const { space, thread } = bot(db)
    const q = queueOn(db)
    const { item } = q.queue.postQuestions({ botId: space.id, threadId: thread.id, questions: [{ question: 'Which format for the report?', options: ['PDF (recommended)', 'Word'] }], deadlineMs: 4 * H })
    q.clock.now += 3 * H
    await q.queue.tick()
    expect(q.resumed).toHaveLength(0)
    q.clock.now += H + 1
    await q.queue.tick()
    const x = q.store.get(item.id)!
    expect(x).toMatchObject({ status: 'defaulted', answeredBy: 'default', answers: ['PDF'], review: true, resumed: true })
    expect(q.resumed[0].msg).toMatchObject({ hidden: true, unattended: true })
    expect(q.resumed[0].msg.text).toMatch(/Nobody answered your question by the deadline/)
    expect(q.resumed[0].msg.text).toContain('→ PDF')
    expect(q.resumed[0].msg.note).toMatch(/say clearly that you assumed this/)
    expect(q.notices.join('\n')).toMatch(/going ahead with "PDF" \(marked for your review/)
    // It shows under review until the user OKs or changes it.
    expect(q.queue.inbox().find((i) => i.id === item.id)).toMatchObject({ review: true, status: 'defaulted' })
    // Changing it tells the bot to update its work.
    await q.queue.answer(item.id, ['Word'])
    expect(q.resumed[1].msg.text).toMatch(/Word \(instead of PDF\)/)
    expect(q.resumed[1].msg.note).toMatch(/Update what you did/)
    expect(q.queue.inbox()).toHaveLength(0)
  })

  test('never auto-picks for a hard stop, a question with no default, or one the bot marked unsafe', async () => {
    const db = new Db(':memory:')
    const { space, thread } = bot(db)
    const q = queueOn(db)
    const post = (question: string, options?: string[], safe?: boolean) => q.queue.postQuestions({ botId: space.id, threadId: thread.id, questions: [{ question, options, ...(safe === false ? { safe } : {}) }], deadlineMs: H }).item
    const money = post('Should I buy the annual plan or the monthly one?', ['Annual (recommended)', 'Monthly'])
    const open = post('What should the project be called?')
    const unsafe = post('Archive the old board?', ['Archive', 'Keep'], false)
    const del = post('Delete the duplicate contacts?', ['Yes', 'No'])
    expect(money.hardStop).toMatch(/money/)
    q.clock.now += 2 * H
    await q.queue.tick()
    expect(q.resumed).toHaveLength(0)
    for (const x of [money, open, unsafe, del]) expect(q.store.get(x.id)).toMatchObject({ status: 'open', expired: true })
    expect(q.notices.filter((n) => /Still waiting for you/.test(n))).toHaveLength(4)
    // They told the user once, not on every tick.
    await q.queue.tick()
    expect(q.notices.filter((n) => /Still waiting for you/.test(n))).toHaveLength(4)
    // The user can still answer later, and the bot resumes.
    await q.queue.answer(money.id, ['Monthly'])
    expect(q.resumed).toHaveLength(1)
  })

  test('approvals never go ahead on their own; an approval grants that exact call once', async () => {
    const db = new Db(':memory:')
    const { space, thread } = bot(db)
    const q = queueOn(db)
    const args = JSON.stringify({ to: 'sam@x.com', subject: 'Hi', body: 'Draft attached' })
    const a = q.queue.postApproval({ botId: space.id, threadId: thread.id, tool: 'gmail__send_email', label: 'Gmail', summary: 'Send email to sam@x.com', reason: 'Acts outside this Mac', args })
    expect(a.deadline).toBeNull()
    expect(q.notified.at(-1)).toMatchObject({ title: 'Scout needs your OK', actions: ['approve', 'deny'] })
    // Posting the same call again doesn't stack another card.
    expect(q.queue.postApproval({ botId: space.id, threadId: thread.id, tool: 'gmail__send_email', label: 'Gmail', args: JSON.stringify({ body: 'Draft attached', subject: 'Hi', to: 'sam@x.com' }) }).id).toBe(a.id)
    q.clock.now += 30 * 24 * H
    await q.queue.tick()
    expect(q.store.get(a.id)!.status).toBe('open')
    expect(q.queue.takeGrant(thread.id, 'gmail__send_email', args)).toBe(false)
    await q.queue.answer(a.id, 'approve')
    expect(q.resumed[0].msg.text).toBe('Approved: Gmail: Send email to sam@x.com')
    expect(q.queue.takeGrant(thread.id, 'gmail__send_email', JSON.stringify({ to: 'other@x.com', subject: 'Hi', body: 'Draft attached' }))).toBe(false)
    expect(q.queue.takeGrant(thread.id, 'gmail__send_email', args)).toBe(true)
    expect(q.queue.takeGrant(thread.id, 'gmail__send_email', args)).toBe(false)
    // A denied one grants nothing and tells the bot to carry on without it.
    const b = q.queue.postApproval({ botId: space.id, threadId: thread.id, tool: 'x__post', label: 'X', summary: 'Post a tweet', args: '{"text":"hi"}' })
    await q.queue.answer(b.id, 'deny')
    expect(q.resumed[1].msg.note).toMatch(/declined/)
    expect(q.queue.takeGrant(thread.id, 'x__post', '{"text":"hi"}')).toBe(false)
  })
})

describe('persistence: the queue survives a restart', () => {
  test('open questions, deadlines and answers the bot was not given yet are all still there', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'qq-')), 'foreman.db')
    let db = new Db(file)
    const { space, thread } = bot(db)
    let q = queueOn(db)
    const one = q.queue.postQuestions({ botId: space.id, threadId: thread.id, questions: [{ question: 'Which tone for replies?', options: ['Friendly', 'Formal'] }], deadlineMs: 4 * H }).item
    const two = q.queue.postQuestions({ botId: space.id, threadId: thread.id, questions: [{ question: 'Which folder for exports?', options: ['Exports', 'Desktop'] }], deadlineMs: 4 * H }).item
    // Answered while the bot couldn't take it (it is "quit" before the handover).
    q.store.update(two.id, (x) => { x.status = 'answered'; x.answers = ['Desktop']; x.answeredBy = 'user'; x.answeredAt = q.clock.now })
    db.sql.close()

    db = new Db(file)
    q = queueOn(db)
    expect(q.queue.inbox().map((x) => x.id)).toEqual([one.id])
    expect(q.store.get(one.id)!.deadline).toBe(one.deadline)
    await q.queue.resumeWaiting()
    expect(q.resumed.map((r) => r.item.id)).toEqual([two.id])
    await q.queue.answer(one.id, ['Formal'])
    expect(q.resumed.map((r) => r.item.id)).toEqual([two.id, one.id])
    db.sql.close()
  })
})

describe('resume messages', () => {
  test('several answers, a default, an approval', () => {
    const base = { id: 'q1', kind: 'question' as const, approval: undefined, deadline: null }
    expect(resumeMessage({ ...base, questions: [{ question: 'A?' }, { question: 'B?' }], answers: ['1', ''], answeredBy: 'user' }).text).toBe('Answers to your questions:\n1. A? → 1\n2. B? → ')
    expect(resumeMessage({ ...base, questions: [{ question: 'A?' }], answers: ['x'], answeredBy: 'default' }).meta).toMatchObject({ questionAnswer: 'q1', questionDefault: 'q1' })
  })
})

// ---------------------------------------------------------------- the agent loop with the queue

const model = (id: string): ModelInfo =>
  ({ id, provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: id, vision: false, tier: 2, requiredGB: 1, maxFittingWindow: 131072, fits: true }) as ModelInfo

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
afterEach(() => { llm.script.length = 0; llm.requests.length = 0 })

function agentHarness(tools: ToolDef[] = [], extra: Partial<Settings> = {}) {
  const db = new Db(':memory:')
  const models = [model('model-a')]
  const settings = {
    contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true },
    workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: 'model-a', hiddenModels: [], shownModels: [],
    cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [], ...extra
  } as unknown as Settings
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), ...tools)
  const events: ChatEvent[] = []
  const last = { ok: true, models, budgetGB: 32, totalGB: 64, providers: [] }
  const endpoints = { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => models, list: async () => last, advisor: () => undefined }
  const store = new QuestionStore(db)
  const learner = new Learner(store)
  const holder: { agent?: Agent } = {}
  const resumes: string[] = []
  const queue = new QuestionQueue({
    store, learner, threadExists: (id) => !!db.getThread(id),
    resume: async (item, msg) => {
      resumes.push(item.id)
      const a = holder.agent!
      const meta = { ...msg.meta, ...(msg.hidden ? { hidden: true } : {}) }
      if (a.isRunning(item.threadId)) { await a.steer(item.threadId, msg.text, { ...meta, note: msg.note }); return }
      await a.send({ threadId: item.threadId, text: msg.text, note: msg.note, meta }, { unattended: msg.unattended })
    }
  })
  const host = createQuestionHost({ db, settings: { get: () => settings }, queue, learner, grace: () => 0 })
  const agent = new Agent({
    db, results, registry, docsDir: tmpdir(), questions: host,
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: endpoints as never, spaces: { getPrompt: () => '' } as never, memory: { block: () => '' } as never,
    emit: (e) => events.push(e), secretValues: () => [], fitWindow: (_m, w) => w, counter: () => ({ count: async (t: string) => estimate(t) })
  })
  holder.agent = agent
  const space = db.createSpace('Scout', '#000000')
  const thread = db.createThread(space.id, 'autonomous', 'model-a')
  const idle = async (): Promise<void> => { for (let i = 0; i < 200 && agent.isRunning(thread.id); i++) await new Promise((r) => setTimeout(r, 20)) }
  return { db, agent, events, queue, store, space, thread, idle, settings, resumes }
}

const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: JSON.stringify(args) })
const log: string[] = []
const work: ToolDef<{ part: string }> = {
  name: 'work', label: 'Work', effect: 'write_local', description: 'do one part of the task',
  parameters: { type: 'object', properties: { part: { type: 'string' } }, required: ['part'], additionalProperties: false },
  async run({ part }) { log.push(part); return { text: `did ${part}` } }
}
const remove: ToolDef<{ id: string }> = {
  name: 'crm_delete', label: 'CRM', effect: 'destructive', description: 'delete a CRM record', describe: ({ id }) => `Delete record ${id}`,
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  async run({ id }) { log.push(`deleted ${id}`); return { text: `deleted ${id}` } }
}

describe('an always-on bot keeps working while a question waits', () => {
  test('the question goes to the queue, other parts get done, the answer resumes and the bot finishes', async () => {
    log.length = 0
    const h = agentHarness([work])
    llm.script.push(
      { toolCalls: [call('work', { part: 'research' })], delay: 0 },
      { toolCalls: [call('ask_user', { question: 'Which format for the report?', options: ['PDF (recommended)', 'Word'], preference: true })], delay: 0 },
      // The ask returned at once: the bot carries on with what doesn't depend on it.
      { toolCalls: [call('work', { part: 'draft sections' })], delay: 0 },
      { content: 'Drafted everything; the export waits on your format choice.', delay: 0 }
    )
    expect(await (await h.agent.send({ threadId: h.thread.id, text: 'Write the quarterly report from my notes' })).done).toBe('finished')
    expect(log).toEqual(['research', 'draft sections'])
    // No blocking card was ever shown.
    expect(h.events.some((e) => e.type === 'pending')).toBe(false)
    const asked = h.db.listMessages(h.thread.id).find((m) => m.role === 'tool' && m.toolName === 'ask_user')!
    expect(asked.content).toMatch(/Posted to the user's Needs-you inbox/)
    expect(asked.content).toMatch(/keep working on every part of the task that doesn't depend on the answer/)
    const [item] = h.queue.inbox()
    expect(item).toMatchObject({ kind: 'question', status: 'open', botName: 'Bot' })

    llm.script.push({ toolCalls: [call('work', { part: 'export Word' })], delay: 0 }, { content: 'Exported as Word. Done.', delay: 0 })
    await h.queue.answer(item.id, ['Word'])
    await h.idle()
    expect(log).toEqual(['research', 'draft sections', 'export Word'])
    const last = llm.requests.at(-2)!
    expect(JSON.stringify(last.messages)).toContain('Answer to \\"Which format for the report?\\": Word')
    expect(h.db.listMessages(h.thread.id).at(-1)!.content).toBe('Exported as Word. Done.')
    expect(h.queue.inbox()).toHaveLength(0)

    // Learned: the same preference is answered from memory next time, without asking.
    llm.script.push({ toolCalls: [call('ask_user', { question: 'Which format for the report?', options: ['PDF', 'Word'] })], delay: 0 }, { content: 'Using Word again.', delay: 0 })
    await (await h.agent.send({ threadId: h.thread.id, text: 'Make next quarter\'s report too' })).done
    const again = h.db.listMessages(h.thread.id).filter((m) => m.role === 'tool' && m.toolName === 'ask_user').at(-1)!
    expect(again.content).toMatch(/Answered from the user's saved preferences/)
    expect(again.content).toContain('→ Word')
    expect(h.queue.inbox()).toHaveLength(0)
  })

  test('the user is watching: the usual card shows and the answer comes straight back', async () => {
    const h = agentHarness([work])
    const host = createQuestionHost({ db: h.db, settings: { get: () => h.settings }, queue: h.queue, learner: new Learner(h.store), grace: () => 60_000 })
    ;(h.agent as unknown as { d: { questions: unknown } }).d.questions = host
    const offEvents = setInterval(() => {
      const p = h.events.find((e) => e.type === 'pending')
      if (p && p.type === 'pending') { clearInterval(offEvents); h.agent.respond(p.threadId, p.request.id, 'Weekly') }
    }, 5)
    // (A task's first question gets one "research first" nudge; then it asks.)
    const ask = call('ask_user', { question: 'Weekly or monthly?', options: ['Weekly', 'Monthly'] })
    llm.script.push({ toolCalls: [ask], delay: 0 }, { toolCalls: [ask], delay: 0 }, { content: 'Weekly it is.', delay: 0 })
    await (await h.agent.send({ threadId: h.thread.id, text: 'Set up my summaries' })).done
    expect(h.db.listMessages(h.thread.id).filter((m) => m.toolName === 'ask_user').at(-1)!.content).toMatch(/User answered:[\s\S]*→ Weekly/)
    expect(h.queue.inbox()).toHaveLength(0)
  })

  test('a hard stop waits in Needs you (the bot carries on); approving it lets that exact call run once', async () => {
    log.length = 0
    const h = agentHarness([work, remove])
    llm.script.push(
      { toolCalls: [call('crm_delete', { id: 'r42' })], delay: 0 },
      { toolCalls: [call('work', { part: 'tidy the rest' })], delay: 0 },
      { content: 'Tidied; deleting r42 waits for your OK.', delay: 0 }
    )
    await (await h.agent.send({ threadId: h.thread.id, text: 'Clean up the CRM' })).done
    expect(log).toEqual(['tidy the rest'])
    const tool = h.db.listMessages(h.thread.id).find((m) => m.role === 'tool' && m.toolName === 'crm_delete')!
    expect(tool.content).toMatch(/Not done yet: this needs the user's OK/)
    const [item] = h.queue.inbox()
    expect(item).toMatchObject({ kind: 'approval', approval: { tool: 'crm_delete', summary: 'Delete record r42' } })

    llm.script.push({ toolCalls: [call('crm_delete', { id: 'r42' })], delay: 0 }, { content: 'Deleted r42.', delay: 0 })
    await h.queue.answer(item.id, 'approve')
    await h.idle()
    expect(log).toEqual(['tidy the rest', 'deleted r42'])
    expect(h.events.some((e) => e.type === 'pending')).toBe(false)
  })

  test('the user\'s "Always ask for…" exception queues even a routine local step', async () => {
    log.length = 0
    const h = agentHarness([work], { botAutonomy: {} } as Partial<Settings>)
    ;(h.settings as Settings).botAutonomy = { [h.space.id]: { alwaysAsk: ['tool:work'] } }
    llm.script.push({ toolCalls: [call('work', { part: 'x' })], delay: 0 }, { content: 'Waiting for your OK.', delay: 0 })
    await (await h.agent.send({ threadId: h.thread.id, text: 'Do x' })).done
    expect(log).toEqual([])
    expect(h.queue.inbox()[0]).toMatchObject({ kind: 'approval', hardStop: expect.stringMatching(/always ask/i) })
  })
})

describe('a reply typed in the chat answers a queued question', () => {
  const post = (h: ReturnType<typeof agentHarness>, question: string, options?: string[]) =>
    h.queue.postQuestions({ botId: h.space.id, threadId: h.thread.id, questions: [{ question, options }], deadlineMs: 4 * H }).item

  test('matching: one open question, an option it names, words it shares, or ambiguous', () => {
    const db = new Db(':memory:')
    const { space, thread } = bot(db)
    const q = queueOn(db)
    const one = q.queue.postQuestions({ botId: space.id, threadId: thread.id, questions: [{ question: 'Which hotel area do you prefer?', options: ['Old town', 'Airport'] }], deadlineMs: H }).item
    expect(matchTyped(q.queue.openFor(thread.id), 'anything at all')).toMatchObject({ kind: 'clear', itemId: one.id, index: 0 })
    const two = q.queue.postQuestions({ botId: space.id, threadId: thread.id, questions: [{ question: 'Weekly or monthly summaries?', options: ['Weekly', 'Monthly'] }, { question: 'Which folder should exports go to?' }], deadlineMs: H }).item
    const open = q.queue.openFor(thread.id)
    expect(matchTyped(open, 'Monthly please')).toMatchObject({ kind: 'clear', itemId: two.id, index: 0 })
    expect(matchTyped(open, 'the airport one')).toMatchObject({ kind: 'clear', itemId: one.id })
    expect(matchTyped(open, 'put the exports in the Reports folder')).toMatchObject({ kind: 'clear', itemId: two.id, index: 1 })
    expect(matchTyped(open, 'sounds good').kind).toBe('ambiguous')
    expect(matchTyped(open, 'weekly, near the airport')).toMatchObject({ kind: 'ambiguous', slots: [expect.anything(), expect.anything()] })
    // A partly answered card keeps its other question open.
    q.queue.answerTyped(two.id, 1, 'Reports')
    expect(q.store.get(two.id)).toMatchObject({ status: 'open', answers: ['', 'Reports'] })
    expect(matchTyped(q.queue.openFor(thread.id), 'Weekly')).toMatchObject({ kind: 'clear', itemId: two.id, index: 0 })
    q.queue.answerTyped(two.id, 0, 'Weekly')
    expect(q.store.get(two.id)).toMatchObject({ status: 'answered', answeredBy: 'user', answers: ['Weekly', 'Reports'], resumed: true })
  })

  test('one open question: the reply closes it, the bot gets it in the same run (no second resume), and a preference is learned', async () => {
    const h = agentHarness([work])
    const item = post(h, 'Which tone do you prefer for client emails?', ['Friendly', 'Formal'])
    llm.script.push({ content: 'Formal it is; drafting now.', delay: 0 })
    await (await h.agent.send({ threadId: h.thread.id, text: 'Formal' })).done
    expect(h.store.get(item.id)).toMatchObject({ status: 'answered', answeredBy: 'user', answers: ['Formal'], resumed: true })
    expect(h.queue.inbox()).toHaveLength(0)
    expect(h.resumes).toHaveLength(0)
    const user = h.db.listMessages(h.thread.id).find((m) => m.role === 'user')!
    expect(String(user.meta?.note)).toContain('This message answers your question "Which tone do you prefer for client emails?"')
    expect(new Learner(h.store).find(h.space.id, { question: 'Which tone do you prefer for client emails?' })?.answer).toBe('Formal')
    // The deadline later finds nothing to do.
    await h.queue.tick()
    expect(h.resumes).toHaveLength(0)
  })

  test('several open and the reply could be either: it asks once, and the pick closes that one', async () => {
    const h = agentHarness([work])
    const a = post(h, 'Which hotel area do you prefer?', ['Old town', 'Airport'])
    const b = post(h, 'Should the summary be weekly or monthly?', ['Weekly', 'Monthly'])
    const confirm = setInterval(() => {
      const p = h.events.find((e) => e.type === 'pending')
      if (p && p.type === 'pending') { clearInterval(confirm); h.agent.respond(p.threadId, p.request.id, 'Should the summary be weekly or monthly?') }
    }, 5)
    llm.script.push({ content: 'Got it.', delay: 0 })
    await (await h.agent.send({ threadId: h.thread.id, text: 'the first option is fine' })).done
    const card = h.events.find((e) => e.type === 'pending')
    expect(card && card.type === 'pending' && card.request.question).toBe('Is this your answer to one of my open questions? Pick it, or say no.')
    expect(card && card.type === 'pending' && card.request.options).toEqual(['Which hotel area do you prefer?', 'Should the summary be weekly or monthly?'])
    expect(h.events.filter((e) => e.type === 'pending')).toHaveLength(1)
    expect(h.store.get(b.id)).toMatchObject({ status: 'answered', answers: ['the first option is fine'] })
    expect(h.store.get(a.id)!.status).toBe('open')
    const user = h.db.listMessages(h.thread.id).find((m) => m.role === 'user')!
    expect(String(user.meta?.note)).toContain('answers your question "Should the summary be weekly or monthly?"')
    // The model saw the note in this same run.
    expect(JSON.stringify(llm.requests.at(-1)!.messages)).toContain('answers your question \\"Should the summary be weekly or monthly?\\"')
  })

  test('"no" to the check leaves the questions open; the message is just a message', async () => {
    const h = agentHarness([work])
    const a = post(h, 'Which hotel area do you prefer?', ['Old town', 'Airport'])
    post(h, 'Should the summary be weekly or monthly?', ['Weekly', 'Monthly'])
    const confirm = setInterval(() => {
      const p = h.events.find((e) => e.type === 'pending')
      if (p && p.type === 'pending') { clearInterval(confirm); h.agent.respond(p.threadId, p.request.id, 'No, neither') }
    }, 5)
    llm.script.push({ content: 'Okay.', delay: 0 })
    await (await h.agent.send({ threadId: h.thread.id, text: 'what is the weather like?' })).done
    expect(h.queue.inbox()).toHaveLength(2)
    expect(h.store.get(a.id)!.status).toBe('open')
  })

  test('a reply sent while the bot is working (steering) closes the question it clearly answers', async () => {
    log.length = 0
    const h = agentHarness([work])
    const item = post(h, 'Which hotel area do you prefer?', ['Old town', 'Airport'])
    llm.script.push(
      { toolCalls: [call('work', { part: 'flights' })], delay: 150 },
      { content: 'Booked the airport hotel shortlist.', delay: 0 }
    )
    const { done } = await h.agent.send({ threadId: h.thread.id, text: 'Keep planning the trip', meta: { fromTest: true } })
    await new Promise((r) => setTimeout(r, 40))
    expect(await h.agent.steer(h.thread.id, 'Airport, please')).toBe('steered')
    await done
    expect(h.store.get(item.id)).toMatchObject({ status: 'answered', answers: ['Airport, please'], resumed: true })
    const steer = h.db.listMessages(h.thread.id).find((m) => m.meta?.steer)!
    expect(String(steer.meta?.note)).toMatch(/while you were working[\s\S]*answers your question "Which hotel area do you prefer\?"/)
    expect(h.resumes).toHaveLength(0)
  })
})

describe('unattended runs of an always-on bot keep Autonomous', () => {
  // Like run_command: a project command when someone is watching, consequential when told "unattended".
  const setup: ToolDef<{ cmd: string }> = {
    name: 'setup', label: 'Setup', effect: 'write_external', description: 'install the project from its lockfile',
    consequential: (_a, c) => (c.unattended ? true : 'project'),
    parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'], additionalProperties: false },
    async run({ cmd }) { log.push(`ran ${cmd}`); return { text: `ran ${cmd}` } }
  }
  test('a routine in an Autonomous bot runs project commands; hard stops still wait in Needs you', async () => {
    log.length = 0
    const h = agentHarness([setup, remove])
    llm.script.push({ toolCalls: [call('setup', { cmd: 'npm ci' })], delay: 0 }, { toolCalls: [call('crm_delete', { id: 'r1' })], delay: 0 }, { content: 'Set up; the delete waits for you.', delay: 0 })
    await (await h.agent.send({ threadId: h.thread.id, text: '⏰ Nightly\n\nSet up and clean up', meta: { scheduled: 'r' } }, { unattended: true })).done
    expect(log).toEqual(['ran npm ci'])
    expect(h.queue.inbox()).toMatchObject([{ kind: 'approval', approval: { tool: 'crm_delete' } }])
  })
  test('the main chat (not an always-on bot) works fully in Auto unattended; in Ask it skips what needs approval', async () => {
    log.length = 0
    const h = agentHarness([setup])
    const main = h.db.createSpace('SahilBot', '#111', { isMain: true })
    const t = h.db.createThread(main.id, 'autonomous', 'model-a')
    llm.script.push({ toolCalls: [call('setup', { cmd: 'npm ci' })], delay: 0 }, { content: 'Set up.', delay: 0 })
    await (await h.agent.send({ threadId: t.id, text: 'Set up', meta: { scheduled: 'r' } }, { unattended: true })).done
    expect(log).toEqual(['ran npm ci'])
    // An Ask chat on a schedule: nobody is there to approve, so the command is skipped.
    log.length = 0
    const askT = h.db.createThread(main.id, 'ask', 'model-a')
    llm.script.push({ toolCalls: [call('setup', { cmd: 'npm ci' })], delay: 0 }, { content: 'Skipped.', delay: 0 })
    await (await h.agent.send({ threadId: askT.id, text: 'Set up', meta: { scheduled: 'r' } }, { unattended: true })).done
    expect(log).toEqual([])
    expect(h.db.listMessages(askT.id).find((m) => m.role === 'tool')!.content).toMatch(/ran on a schedule with nobody to approve it/)
  })
})
