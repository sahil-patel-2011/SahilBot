import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import { followUpTool, goalTool } from '../../src/main/agent/tools/goals'
import type { ToolDef } from '../../src/main/agent/types'
import { overviewTool } from '../../src/main/checkin'
import { Db } from '../../src/main/db'
import { GoalManager, GOAL_LIMITS, parseEndDate, withGoalsOverview, type GoalDeps } from '../../src/main/goals'
import { nextMarketOpen, parseClock, parseWhen } from '../../src/main/goals/when'
import { Scheduler } from '../../src/main/scheduler'
import type { ChatEvent, Goal, ModelInfo, Settings } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'

const at = (s: string): Date => new Date(s)
const MIN = 60_000

describe('follow-up times', () => {
  const now = at('2026-11-13T10:15:00') // a Friday
  const p = (s: string): string | undefined => parseWhen(s, now)?.toString()
  test('relative times', () => {
    expect(p('in 2h')).toBe(at('2026-11-13T12:15:00').toString())
    expect(p('in 90 minutes')).toBe(at('2026-11-13T11:45:00').toString())
    expect(p('in an hour')).toBe(at('2026-11-13T11:15:00').toString())
    expect(p('in half an hour')).toBe(at('2026-11-13T10:45:00').toString())
    expect(p('in 1h 30m')).toBe(at('2026-11-13T11:45:00').toString())
    expect(p('in 3 days')).toBe(at('2026-11-16T10:15:00').toString())
    expect(p('2 hours from now')).toBe(at('2026-11-13T12:15:00').toString())
    expect(p('in 2 bananas')).toBeUndefined()
  })
  test('days and times of day', () => {
    expect(p('tomorrow 9am')).toBe(at('2026-11-14T09:00:00').toString())
    expect(p('tomorrow at 5:30 pm')).toBe(at('2026-11-14T17:30:00').toString())
    expect(p('tomorrow')).toBe(at('2026-11-14T09:00:00').toString())
    expect(p('tonight')).toBe(at('2026-11-13T20:00:00').toString())
    expect(p('monday 8:30')).toBe(at('2026-11-16T08:30:00').toString())
    expect(p('on friday at 9am')).toBe(at('2026-11-20T09:00:00').toString()) // today's 9am passed
    expect(p('friday 5pm')).toBe(at('2026-11-13T17:00:00').toString())
    expect(p('next friday 5pm')).toBe(at('2026-11-20T17:00:00').toString())
    expect(p('9am')).toBe(at('2026-11-14T09:00:00').toString())
    expect(p('17:00')).toBe(at('2026-11-13T17:00:00').toString())
    expect(p('next week')).toBe(at('2026-11-16T09:00:00').toString())
    expect(p('2026-11-20 14:00')).toBe(at('2026-11-20T14:00:00').toString())
    expect(p('2026-11-01')).toBeUndefined()
    expect(p('whenever')).toBeUndefined()
    expect(parseClock('12am')).toEqual([0, 0])
    expect(parseClock('3')).toBeNull()
  })
  test('market open is a weekday at 9:30 New York time (plus settling time)', () => {
    const open = nextMarketOpen(at('2026-11-14T12:00:00Z')) // a Saturday
    const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: false }).format(open)
    expect(ny).toBe('Mon 09:35')
    expect(parseWhen('when market opens', at('2026-11-14T12:00:00Z'))?.getTime()).toBe(open.getTime())
  })
  test('end dates: a date alone means the end of that day', () => {
    const n = now.getTime()
    expect(parseEndDate('2026-11-21', n)).toBe(at('2026-11-21T23:59:00').getTime())
    expect(parseEndDate('saturday', n)).toBe(at('2026-11-14T23:59:00').getTime())
    expect(parseEndDate('in 2h', n)).toBe(at('2026-11-13T12:15:00').getTime())
    expect(parseEndDate('2026-11-01', n)).toBeNull()
  })
})

/** A manager over an in-memory database with a fake run (no model). */
function rig(o: { run?: GoalDeps['run']; paused?: () => boolean } = {}) {
  const db = new Db(':memory:')
  const bot = db.createSpace('Scout', '#0EA5E9', { kind: 'bot' })
  const thread = db.createThread(bot.id, 'auto', null)
  const clock = { now: at('2026-11-13T10:00:00').getTime() }
  const notes: Array<{ headline: string; body: string }> = []
  const posted: string[] = []
  const runs: Array<{ text: string; note: string; unattended: boolean }> = []
  const goals: GoalManager = new GoalManager({
    db,
    now: () => clock.now,
    run: o.run ?? (async (i) => { runs.push(i); return 'finished' }),
    isRunning: () => false,
    posted: (_t, m) => posted.push(m.content),
    notify: (_g, headline, body) => notes.push({ headline, body }),
    paused: o.paused
  })
  const make = (extra: Partial<Parameters<GoalManager['create']>[0]> = {}): Goal => goals.create({ botId: bot.id, threadId: thread.id, title: 'Scouting DB ready', doneWhen: 'All teams imported and the pick list exports', milestones: ['Import match data', 'Build pick list', 'Export to the tablet'], ...extra })
  return { db, bot, thread, clock, notes, posted, runs, goals, make }
}

describe('goal model and policy', () => {
  test('create validates, uses defaults, and posts a system line', () => {
    const r = rig()
    const g = r.make()
    expect(g).toMatchObject({ status: 'active', maxUsd: 2, maxRunsPerDay: 6, spentUsd: 0, wakes: 0, nextWakeAt: at('2026-11-14T09:00:00').getTime() })
    expect(g.endAt).toBe(r.clock.now + 14 * 86_400_000)
    expect(g.milestones.map((m) => m.status)).toEqual(['pending', 'pending', 'pending'])
    expect(r.posted).toEqual(['Started goal · Scouting DB ready'])
    expect(() => r.make({ milestones: [] })).toThrow(/milestone/)
    expect(() => r.make({ doneWhen: ' ' })).toThrow(/definition of done/)
    expect(() => r.make({ maxUsd: 500 })).toThrow(/at most/)
    expect(() => r.make({ endAt: r.clock.now - 1 })).toThrow(/future/)
    for (let i = 1; i < GOAL_LIMITS.activePerBot; i++) r.make()
    expect(() => r.make()).toThrow(/open goals/)
  })

  test('milestones: done reports in chat and notifies; journal keeps facts; status done reports', () => {
    const r = rig()
    const g = r.make()
    r.goals.setMilestone(g.id, '1', 'in_progress')
    const { goal } = r.goals.setMilestone(g.id, 'import', 'done', '412 matches imported')
    expect(goal.milestones[0].status).toBe('done')
    expect(goal.journal.at(-1)!.text).toBe('Milestone done: Import match data — 412 matches imported')
    expect(r.posted.at(-1)).toBe('Milestone 1/3 · Import match data — Scouting DB ready')
    expect(r.notes.at(-1)).toEqual({ headline: 'Milestone done', body: 'Import match data (1/3) · Scouting DB ready' })
    r.goals.addJournal(g.id, 'Team 254 has the best auto.')
    expect(() => r.goals.setMilestone(g.id, '9', 'done')).toThrow(/No milestone/)
    const done = r.goals.setStatus(g.id, 'done', null, 'bot')
    expect(done.status).toBe('done')
    expect(r.posted.at(-1)).toMatch(/^Goal done · Scouting DB ready — 1\/3 milestones/)
    expect(r.notes.at(-1)!.headline).toBe('Goal done')
    expect(() => r.goals.setMilestone(g.id, '2', 'done')).toThrow(/done/)
  })

  test('follow-ups: at least 15 minutes away, never past the end date, and moved when the day is full', () => {
    const r = rig()
    const g = r.make({ maxRunsPerDay: 1, endAt: at('2026-11-15T23:00:00').getTime() })
    const soon = r.goals.scheduleWake(g.id, 'in 1 minute', 'check')
    expect(soon.at).toBe(r.clock.now + GOAL_LIMITS.minFollowUpMin * MIN)
    expect(soon.adjusted).toMatch(/soonest/)
    expect(() => r.goals.scheduleWake(g.id, 'in 5 days', 'x')).toThrow(/end date/)
    expect(() => r.goals.scheduleWake(g.id, 'someday', 'x')).toThrow(/Couldn't read/)
    // One wake-up today already: today's later slot moves to tomorrow morning.
    r.goals.store.logWake(g.id, r.clock.now)
    const moved = r.goals.scheduleWake(g.id, 'in 3h', 'x')
    expect(moved.at).toBe(at('2026-11-14T09:00:00').getTime())
    expect(r.goals.get(g.id)!.nextWakeNote).toBe('x')
  })

  test('a wake-up runs unattended with a hidden note of the goal, then schedules a fallback check-in', async () => {
    const r = rig()
    const g = r.make()
    r.goals.addJournal(g.id, 'Found the event code 2026casj.')
    r.goals.scheduleWake(g.id, 'in 2h', 'Import the qualification matches.')
    await r.goals.tick()
    expect(r.runs).toHaveLength(0)
    r.clock.now += 2 * 3_600_000
    await r.goals.tick()
    expect(r.runs).toHaveLength(1)
    expect(r.runs[0].unattended).toBe(true)
    expect(r.runs[0].text).toBe('🎯 Goal check-in · Scouting DB ready')
    expect(r.runs[0].note).toMatch(/Goal: Scouting DB ready/)
    expect(r.runs[0].note).toMatch(/1\. \[ \] Import match data/)
    expect(r.runs[0].note).toMatch(/Found the event code 2026casj\./)
    expect(r.runs[0].note).toMatch(/Do now: Import the qualification matches\./)
    const after = r.goals.get(g.id)!
    expect(after.wakes).toBe(1)
    expect(after.stall).toBe(1)
    // No follow-up was set: tomorrow 9:00.
    expect(after.nextWakeAt).toBe(at('2026-11-14T09:00:00').getTime())
    // The goal tools are loaded in its chat.
    expect(r.db.getState(r.thread.id).loaded).toEqual(expect.arrayContaining(['goal', 'follow_up']))
  })

  test('stall detection: no milestone progress in N wake-ups pauses for the user', async () => {
    const r = rig()
    const g = r.make()
    for (let i = 0; i < GOAL_LIMITS.stallWakes; i++) {
      r.goals.store.update(g.id, (x) => { x.nextWakeAt = r.clock.now })
      await r.goals.tick()
      r.clock.now += 3_600_000
    }
    const after = r.goals.get(g.id)!
    expect(after.status).toBe('waiting_user')
    expect(after.statusReason).toMatch(/No milestone progress in 3 check-ins/)
    expect(r.notes.at(-1)!.headline).toBe('needs you')
    expect(r.posted.at(-1)).toMatch(/^Goal needs you · Scouting DB ready/)
    // Progress resets it.
    const r2 = rig({ run: async () => { r2.goals.setMilestone(g2.id, '1', 'done'); return 'finished' } })
    const g2 = r2.make()
    for (let i = 0; i < 2; i++) { r2.goals.store.update(g2.id, (x) => { x.nextWakeAt = r2.clock.now }); await r2.goals.tick() }
    expect(r2.goals.get(g2.id)!.stall).toBe(1)
  })

  test('spend cap: a wake-up stops before a request that could pass it, and the goal is blocked', async () => {
    const holder: { r?: ReturnType<typeof rig> } = {}
    let refused = ''
    const r = rig({
      run: async ({ threadId }) => {
        const goals = holder.r!.goals
        goals.addSpend(threadId, 'claude-opus-5-5', 100_000, 10_000) // $0.60
        goals.checkSpend(threadId, 'claude-opus-5-5', 1000, 4000)
        goals.addSpend(threadId, 'claude-opus-5-5', 100_000, 10_000) // $1.20
        try { goals.checkSpend(threadId, 'claude-opus-5-5', 100_000, 64_000) } catch (e) { refused = (e as Error).message; return 'error' }
        return 'finished'
      }
    })
    holder.r = r
    const g = r.make({ maxUsd: 1.3 })
    r.goals.store.update(g.id, (x) => { x.nextWakeAt = r.clock.now })
    await r.goals.tick()
    expect(refused).toMatch(/^Goal budget reached: "Scouting DB ready" has used \$1\.20 of its \$1\.30 cloud budget/)
    const after = r.goals.get(g.id)!
    expect(after.spentUsd).toBeCloseTo(1.2, 5)
    expect(after.status).toBe('blocked')
    expect(after.statusReason).toMatch(/spend cap: \$1\.20 of \$1\.30/)
    // Resuming needs a higher cap first.
    expect(() => r.goals.patch(g.id, { status: 'active' })).toThrow(/Raise the cap/)
    expect(r.goals.patch(g.id, { maxUsd: 5, status: 'active' }).status).toBe('active')
    // Outside a wake-up the cap isn't enforced (the user is there), but spend still counts while focused.
    r.goals.setFocus(r.thread.id, g.id)
    expect(() => r.goals.checkSpend(r.thread.id, 'claude-opus-5-5', 10_000_000, 64_000)).not.toThrow()
  })

  test('daily run cap, end date and "Pause all routines"', async () => {
    let paused = true
    const r = rig({ paused: () => paused })
    const g = r.make({ maxRunsPerDay: 1, endAt: at('2026-11-14T12:00:00').getTime() })
    r.goals.store.update(g.id, (x) => { x.nextWakeAt = r.clock.now })
    await r.goals.tick()
    expect(r.runs).toHaveLength(0)
    paused = false
    await r.goals.tick()
    expect(r.runs).toHaveLength(1)
    // Same day again: over the cap, moved to tomorrow morning without running.
    r.goals.store.update(g.id, (x) => { x.nextWakeAt = r.clock.now + MIN })
    r.clock.now += 2 * MIN
    await r.goals.tick()
    expect(r.runs).toHaveLength(1)
    expect(r.goals.get(g.id)!.nextWakeAt).toBe(at('2026-11-14T09:00:00').getTime())
    // Past the end date: paused, not run.
    r.clock.now = at('2026-11-14T13:00:00').getTime()
    await r.goals.tick()
    expect(r.runs).toHaveLength(1)
    expect(r.goals.get(g.id)!).toMatchObject({ status: 'paused' })
    expect(r.goals.get(g.id)!.statusReason).toMatch(/end date/)
    expect(() => r.goals.patch(g.id, { status: 'active' })).toThrow(/end date/)
  })

  test('the user can pause, resume and abandon; abandoned goals never wake', async () => {
    const r = rig()
    const g = r.make()
    r.goals.patch(g.id, { status: 'paused' })
    expect(r.posted.at(-1)).toBe('Paused goal · Scouting DB ready')
    const resumed = r.goals.patch(g.id, { status: 'active' })
    // Its first check-in (tomorrow 9:00) is still ahead, so it keeps it.
    expect(resumed.nextWakeAt).toBe(at('2026-11-14T09:00:00').getTime())
    expect(r.posted.at(-1)).toBe('Resumed goal · Scouting DB ready')
    r.goals.patch(g.id, { status: 'abandoned' })
    expect(r.goals.get(g.id)!.nextWakeAt).toBeNull()
    r.clock.now += 10 * MIN
    await r.goals.tick()
    expect(r.runs).toHaveLength(0)
    expect(() => r.goals.patch(g.id, { status: 'done' as never })).toThrow()
    expect(() => r.goals.setStatus(g.id, 'active', null, 'bot', { unattended: true })).toThrow(/wake-up can't/)
  })

  test('a wake-up cut off by a quit gets another slot at the next launch', () => {
    const r = rig()
    const g = r.make()
    // A wake-up marks itself in flight before it runs; a quit leaves the mark.
    r.goals.store.update(g.id, (x) => { x.nextWakeAt = null })
    r.goals.store.setInflight(g.id, true)
    const again = new GoalManager({ db: r.db, now: () => r.clock.now, run: async () => 'finished', isRunning: () => false })
    expect(again.get(g.id)!.nextWakeAt).toBe(r.clock.now + GOAL_LIMITS.busyRetryMin * MIN)
    expect(again.get(g.id)!.nextWakeNote).toMatch(/cut off/)
    expect(again.store.inflight(g.id)).toBe(false)
  })

  test('L7: a goal left without a wake-up on purpose doesn\'t get one at every launch', () => {
    const r = rig()
    const g = r.make()
    r.goals.store.update(g.id, (x) => { x.nextWakeAt = null })
    for (let i = 0; i < 3; i++) {
      const again = new GoalManager({ db: r.db, now: () => r.clock.now, run: async () => 'finished', isRunning: () => false })
      expect(again.get(g.id)!.nextWakeAt).toBeNull()
    }
  })

  test('L7: a completed wake-up clears its in-flight mark', async () => {
    const r = rig()
    const g = r.make()
    let during = false
    const r2 = rig({ run: async () => { during = r2.goals.store.inflight(g2.id); return 'finished' } })
    const g2 = r2.make()
    r2.goals.store.update(g2.id, (x) => { x.nextWakeAt = r2.clock.now })
    await r2.goals.tick()
    expect(during).toBe(true)
    expect(r2.goals.store.inflight(g2.id)).toBe(false)
    expect(r.goals.store.inflight(g.id)).toBe(false)
  })

  test('bots_overview lists goals for the morning check-in', async () => {
    const r = rig()
    const g = r.make()
    r.goals.setMilestone(g.id, '1', 'done', 'imported')
    r.goals.scheduleWake(g.id, 'tomorrow 9am', 'next')
    const tool = withGoalsOverview(overviewTool({ db: r.db, pending: () => [], routines: () => [], now: () => r.clock.now }), r.goals, () => 'Scout')
    const out = await tool.run({}, {} as never)
    expect(out.text).toMatch(/^Goals:\n- Scout: "Scouting DB ready" — 1\/3 milestones; next check-in .*; \$0\.00 of \$2\.00; latest: Milestone done: Import match data — imported/)
  })
})

describe('scheduler wires goal wake-ups', () => {
  test('every tick checks goal wake-ups, except while routines are paused', async () => {
    const db = new Db(':memory:')
    let paused = false
    let calls = 0
    const s = new Scheduler(db, async () => 'done', () => undefined, () => at('2026-11-13T10:00:00'))
    s.paused = () => paused
    s.wakeups = async () => { calls++ }
    await s.tick()
    expect(calls).toBe(1)
    paused = true
    await s.tick()
    expect(calls).toBe(1)
    // A failing wake-up check never breaks routines.
    paused = false
    s.wakeups = async () => { throw new Error('boom') }
    await expect(s.tick()).resolves.toBeUndefined()
  })
})

// ------------------------------------------------------------------ end to end: a real Agent and the mock model

const model = (id: string): ModelInfo =>
  ({ id, provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: id.toUpperCase(), vision: false, tier: 2, requiredGB: 1, maxFittingWindow: 131072, fits: true }) as ModelInfo

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
afterEach(() => { llm.script.length = 0; llm.requests.length = 0 })

const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: JSON.stringify(args) })

function e2e(extra: ToolDef[] = []) {
  const db = new Db(':memory:')
  const models = [model('model-a')]
  const settings = {
    contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true },
    workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: 'model-a', hiddenModels: [], shownModels: [],
    cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: []
  } as unknown as Settings
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  const events: ChatEvent[] = []
  const answers: string[] = []
  const last = { ok: true, models, budgetGB: 32, totalGB: 64, providers: [] }
  const endpoints = { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => models, list: async () => last, advisor: () => undefined }
  const holder: { goals?: GoalManager } = {}
  const agent: Agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: endpoints as never,
    spaces: { getPrompt: () => '' } as never,
    memory: { block: () => '' } as never,
    emit: (e) => {
      events.push(e)
      // The user answers questions (the goal confirmation) from a queue.
      if (e.type === 'pending' && e.request.kind === 'question') setTimeout(() => agent.respond(e.threadId, e.request.id, answers.shift() ?? 'Not now'))
      if (e.type === 'run' && e.status !== 'started') holder.goals?.runEnded(e.threadId)
    },
    secretValues: () => [],
    fitWindow: (_m, w) => w,
    counter: () => ({ count: async (t: string) => estimate(t) }),
    onUnattendedAsk: (t, i) => holder.goals?.onUnattendedAsk(t, i)
  })
  const goals = new GoalManager({
    db,
    run: async ({ threadId, text, note, goalId, unattended }) => (await agent.send({ threadId, text, note, meta: { goalRun: goalId } }, { unattended })).done,
    isRunning: (t) => agent.isRunning(t)
  })
  holder.goals = goals
  registry.register(...coreTools(results), goalTool(db, goals), followUpTool(db, goals), ...extra)
  const bot = db.createSpace('Scout', '#0EA5E9', { kind: 'bot' })
  const thread = db.createThread(bot.id, 'auto', 'model-a')
  return { db, agent, goals, events, answers, bot, thread }
}

describe('goals end to end (Agent + mock model)', () => {
  test('a bot proposes a goal, the user confirms it, it wakes itself up, ticks off a milestone and queues a risky step', async () => {
    const sent: string[] = []
    const email: ToolDef<{ to: string }> = {
      name: 'send_email', label: 'Send email', effect: 'write_external', description: 'Send an email',
      describe: (a) => `Email ${a.to} the pick list`,
      parameters: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'], additionalProperties: false },
      async run(a) { sent.push(a.to); return { text: 'sent' } }
    }
    const h = e2e([email])

    // 1. In chat: the bot proposes the goal; the user confirms it and its budget.
    h.answers.push('Start goal')
    llm.script.push(
      { toolCalls: [call('goal', { action: 'create', title: 'Scouting DB ready by Saturday', done_when: 'All 40 teams imported and the pick list exports', milestones: ['Import match data', 'Build pick list'], max_usd: 1, end_date: 'in 6 days' })], delay: 0 },
      (req) => {
        const id = /Started goal (g\w+)/.exec(JSON.stringify(req.messages))![1]
        return { toolCalls: [call('follow_up', { id, when: 'in 2h', note: 'Import the qualification matches.' })], delay: 0 }
      },
      { content: 'Goal started. I\'ll check back in 2 hours.', delay: 0 }
    )
    expect(await (await h.agent.send({ threadId: h.thread.id, text: 'Get my scouting database ready before Saturday' })).done).toBe('finished')
    const question = h.events.find((e) => e.type === 'pending' && e.request.kind === 'question')
    expect(question && question.type === 'pending' && question.request.question).toMatch(/Start this goal\?[\s\S]*Budget: up to \$1\.00 of cloud model spend/)
    const [g] = h.goals.list()
    expect(g).toMatchObject({ title: 'Scouting DB ready by Saturday', status: 'active', maxUsd: 1, botId: h.bot.id, threadId: h.thread.id })
    expect(g.nextWakeAt).toBeGreaterThan(Date.now() + 100 * MIN)
    expect(g.nextWakeNote).toBe('Import the qualification matches.')

    // 2. The wake-up is due: it runs unattended in the bot's chat with the hidden goal note.
    h.goals.store.update(g.id, (x) => { x.nextWakeAt = Date.now() - 1 })
    llm.script.push(
      { toolCalls: [call('goal', { action: 'milestone', milestone: '1', status: 'done', note: '412 qualification matches imported' }), call('goal', { action: 'journal', note: 'Event code 2026casj; 40 teams.' })], delay: 0 },
      { toolCalls: [call('send_email', { to: 'mentor@example.com' })], delay: 0 },
      { content: 'Imported the match data. Emailing the pick list to your mentor needs your OK.', delay: 0 }
    )
    const before = llm.requests.length
    await h.goals.tick()
    const wakeReq = llm.requests[before]
    const wakeUser = [...wakeReq.messages].reverse().find((m: { role: string }) => m.role === 'user')
    expect(String(wakeUser.content)).toMatch(/Goal wake-up \(from the app, hidden from the user\)/)
    expect(String(wakeUser.content)).toMatch(/Do now: Import the qualification matches\./)
    expect(String(wakeUser.content)).toMatch(/🎯 Goal check-in · Scouting DB ready by Saturday/)

    // The risky step was queued for the user, never done.
    expect(sent).toEqual([])
    const toolMsg = h.db.listMessages(h.thread.id).find((m) => m.role === 'tool' && m.toolName === 'send_email') ?? h.db.listMessages(h.thread.id).find((m) => m.role === 'tool' && /Queued for the user/.test(m.content))
    expect(toolMsg?.content).toMatch(/Queued for the user: "Email mentor@example.com the pick list" needs their approval/)
    const after = h.goals.get(g.id)!
    expect(after.milestones[0].status).toBe('done')
    expect(after.journal.map((e) => e.text)).toEqual(expect.arrayContaining(['Event code 2026casj; 40 teams.', 'Milestone done: Import match data — 412 qualification matches imported']))
    expect(after.status).toBe('waiting_user')
    expect(after.asks.map((a) => a.summary)).toEqual(['Email mentor@example.com the pick list'])
    expect(after.wakes).toBe(1)
    // The chat got the milestone line and the needs-you line.
    const notices = h.db.listMessages(h.thread.id).filter((m) => m.kind === 'notice').map((m) => m.content)
    expect(notices).toEqual(expect.arrayContaining(['Started goal · Scouting DB ready by Saturday', 'Milestone 1/2 · Import match data — Scouting DB ready by Saturday']))
    expect(notices.some((n) => /^Goal needs you · Scouting DB ready by Saturday: 1 action waiting for your OK/.test(n))).toBe(true)
  })

  test('a wake-up cannot start new goals or raise its own budget', async () => {
    const h = e2e()
    h.answers.push('Start goal')
    llm.script.push(
      { toolCalls: [call('goal', { action: 'create', title: 'Track 5 stocks', done_when: 'Four weekly summaries sent', milestones: ['Week 1 summary', 'Week 2 summary'] })], delay: 0 },
      { content: 'Started.', delay: 0 }
    )
    await (await h.agent.send({ threadId: h.thread.id, text: 'track AAPL MSFT NVDA GOOG AMZN weekly' })).done
    const [g] = h.goals.list()
    h.goals.store.update(g.id, (x) => { x.nextWakeAt = Date.now() - 1 })
    llm.script.push(
      { toolCalls: [call('goal', { action: 'update', max_usd: 20 }), call('goal', { action: 'create', title: 'Another', done_when: 'x', milestones: ['a'] })], delay: 0 },
      { content: 'Need more budget.', delay: 0 }
    )
    await h.goals.tick()
    const tools = h.db.listMessages(h.thread.id).filter((m) => m.role === 'tool').map((m) => m.content).join('\n')
    expect(tools).toMatch(/Only the user can raise a goal's budget/)
    expect(tools).toMatch(/Goals can only be started while the user is in the chat/)
    expect(h.goals.list()).toHaveLength(1)
    expect(h.goals.get(g.id)!.maxUsd).toBe(2)
  })
})
