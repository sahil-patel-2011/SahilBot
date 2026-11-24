import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { Message, ModelInfo, Schedule, Settings } from '@shared/types'
import { describeSchedule, nextLabel } from '@shared/when'
import { Agent } from '../../src/main/agent/loop'
import { activeMessages, estimate, ResultStore, toWire } from '../../src/main/agent/context'
import { dayLine } from '../../src/main/agent/prompt'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import { keepRest, placeZone, resolveWhen, scheduleTool } from '../../src/main/agent/tools/schedule'
import { classifyTask } from '../../src/main/agent/intent'
import { emptyState } from '../../src/main/agent/types'
import { Db } from '../../src/main/db'
import { Scheduler } from '../../src/main/scheduler'
import { isPlainReminder, reminderMessage, reminderText, routineAside, routineDelivery } from '../../src/main/triggers'
import { nextRunText } from '../../src/renderer/src/routines'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Grok Bot head-to-head (SCA-01/02/03, SCB-01/02, SCC-01/03): "remind me in 3 minutes to stretch" arrives on time, even
// while the chat is busy, and never breaks the run that is busy; "weekday Atlanta weather at 7:30" reads 7:30 AM ET.

process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'

const setup = () => {
  const db = new Db(':memory:')
  const space = db.createSpace('Helper', '#000')
  const th = db.createThread(space.id, 'auto', null)
  const s = new Scheduler(db, async () => 'done', () => undefined)
  return { db, s, tool: scheduleTool(s, db), ctx: { threadId: th.id } as never }
}

describe('the model knows the time', () => {
  test('the context line has the date, the time of day and the time zone', () => {
    const line = dayLine(new Date('2026-11-24T15:02:00'))
    expect(line).toMatch(/^Today is Tuesday, November 24, 2026\. It is 3:02 PM \S+ \(.+\)\.$/)
    expect(line).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })

  test('"in 3 minutes" is worked out by the app, never guessed', async () => {
    const { s, tool, ctx } = setup()
    const before = Date.now()
    const out = await tool.run({ action: 'create', title: 'Stretch', remind: 'Stretch', when: { type: 'once', in_minutes: 3 } } as never, ctx)
    const t = s.list()[0]
    expect(Math.abs(t.nextRun! - (before + 180_000))).toBeLessThan(1500)
    expect(out.text).toMatch(/in 3 minutes/)
    // at:"in 5 minutes" works too; a one-off with neither is a clear error.
    expect(new Date((resolveWhen({ type: 'once', at: 'in 5 minutes' }, 1_000_000) as { at: string }).at).getTime()).toBe(1_000_000 + 300_000)
    expect(new Date((resolveWhen({ type: 'once', at: 'in 2 hours' }, 0) as { at: string }).at).getTime()).toBe(7_200_000)
    await expect(tool.run({ action: 'create', title: 'X', remind: 'X', when: { type: 'once' } } as never, ctx)).rejects.toThrow(/in_minutes/)
    await expect(tool.run({ action: 'create', title: 'X', when: { type: 'once', in_minutes: 3 } } as never, ctx)).rejects.toThrow(/remind .* or prompt/)
  })
})

describe('plain reminders', () => {
  test('a reminder made with remind is always a plain one, on any clock schedule', async () => {
    const { s, tool, ctx } = setup()
    await tool.run({ action: 'create', title: 'Check the oven', remind: 'Check the oven', when: { type: 'once', in_minutes: 10 } } as never, ctx)
    await tool.run({ action: 'create', title: 'Pills', remind: 'Take your pills', when: { type: 'daily', time: '09:00' } } as never, ctx)
    const a = s.list().find((t) => t.title === 'Check the oven')!
    const b = s.list().find((t) => t.title === 'Pills')!
    expect(a.prompt).toBe('⏰ Reminder: Check the oven')
    expect(isPlainReminder(a)).toBe(true)
    expect(reminderText(a)).toBe('Check the oven')
    expect(isPlainReminder(b)).toBe(true)
    expect(reminderText(b)).toBe('Take your pills')
  })

  test('"snooze it 10 minutes": a one-off that went off comes back on at the new time', async () => {
    const { s, tool, ctx } = setup()
    await tool.run({ action: 'create', title: 'Stretch', remind: 'Stretch', when: { type: 'once', in_minutes: 3 } } as never, ctx)
    const id = s.list()[0].id
    s.update(id, { enabled: false })
    const before = Date.now()
    await tool.run({ action: 'update', id, when: { type: 'once', in_minutes: 10 } } as never, ctx)
    const t = s.get(id)!
    expect(t.enabled).toBe(true)
    expect(Math.abs(t.nextRun! - (before + 600_000))).toBeLessThan(1500)
  })

  test('the usual ways a reminder is worded are plain; work for the bot is not', () => {
    const once = { type: 'once' }
    const plain = (title: string, prompt: string) => isPlainReminder({ schedule: once, title, prompt })
    expect(plain('Stretch', "Tell the user it's time to stretch")).toBe(true)
    expect(plain('Stretch', 'Time to stretch! Stand up for a minute.')).toBe(true)
    expect(plain('Stretch reminder', 'Stand up and stretch.')).toBe(true)
    expect(plain('Stretch', 'Send a stretch reminder')).toBe(true)
    // The reminded thing is the user's job, even when it sounds like work.
    expect(plain('Oven', 'Remind me to check the oven')).toBe(true)
    expect(plain('Mom', 'Remind me to send mom a text')).toBe(true)
    expect(plain('Dentist', 'Remind me to book the dentist')).toBe(true)
    // Work for the bot after the nudge, or instead of it.
    expect(plain('Report', 'Remind me and send Bob the weekly report')).toBe(false)
    expect(plain('Reminder', 'Check my inbox for invoices')).toBe(false)
    expect(plain('Inbox', 'Look up the weather and send it to me')).toBe(false)
    expect(isPlainReminder({ schedule: { type: 'when' }, title: 'Reminder', prompt: '⏰ Reminder: x' })).toBe(false)
    expect(reminderText({ title: 'Stretch', prompt: "Tell the user it's time to stretch" })).toBe("It's time to stretch")
    expect(reminderText({ title: 'Stretch', prompt: 'Send a stretch reminder' })).toBe('Stretch')
  })

  test('a reminder is posted directly, idle or busy; work runs here, or beside a busy chat', () => {
    const r = { id: 'r1', schedule: { type: 'once' }, title: 'Stretch', prompt: '⏰ Reminder: Stretch' }
    const work = { id: 'w1', schedule: { type: 'weekly' }, title: 'Atlanta weather', prompt: 'Send me the Atlanta weather' }
    expect(routineDelivery(r, { busy: false })).toBe('remind')
    expect(routineDelivery(r, { busy: true })).toBe('remind')
    expect(routineDelivery(r, { busy: false, dry: true })).toBe('here')
    expect(routineDelivery(work, { busy: false })).toBe('here')
    expect(routineDelivery(work, { busy: true })).toBe('beside')
    // A chat whose task paused on a question with its plan open: the routine runs beside it and leaves that plan.
    expect(routineDelivery(work, { busy: false, todos: [{ status: 'done' }, { status: 'pending' }] })).toBe('beside')
    expect(routineDelivery(work, { busy: false, todos: [{ status: 'done' }] })).toBe('here')
    expect(reminderMessage(r)).toEqual({ content: '⏰ Reminder: Stretch', meta: { scheduled: 'r1', reminder: true, aside: true } })
  })

  test('a reminder posted while a tool is running leaves that run\'s prompt intact', () => {
    let n = 0
    const msg = (p: Partial<Message>): Message => ({ id: `m${++n}`, threadId: 't', role: 'assistant', content: '', kind: 'normal', status: 'done', createdAt: n, ...p })
    const r = reminderMessage({ id: 'r1', title: 'Stretch', prompt: '⏰ Reminder: Stretch' })
    const ms = [
      msg({ role: 'user', content: 'Email Bob the report' }),
      msg({ toolCalls: [{ id: 'c1', name: 'send_email', arguments: '{}' }] }),
      msg({ content: r.content, meta: r.meta }),
      msg({ role: 'tool', toolCallId: 'c1', toolName: 'send_email', content: 'sent' })
    ]
    const wire = toWire(activeMessages(ms, emptyState()))
    expect(wire.map((w) => w.role)).toEqual(['user', 'assistant', 'tool'])
    expect(wire[2]).toMatchObject({ tool_call_id: 'c1', content: 'sent' })
    expect(JSON.stringify(wire)).not.toContain('[Not run')
    expect(JSON.stringify(wire)).not.toContain('Reminder')
  })

  test('a hidden nudge from the app is not a new turn: the reminder stays out until the user writes again', () => {
    let n = 0
    const msg = (p: Partial<Message>): Message => ({ id: `m${++n}`, threadId: 't', role: 'assistant', content: '', kind: 'normal', status: 'done', createdAt: n, ...p })
    const r = reminderMessage({ id: 'r1', title: 'Stretch', prompt: '⏰ Reminder: Stretch' })
    const ms = [
      msg({ role: 'user', content: 'Make the invoice' }),
      msg({ toolCalls: [{ id: 'c1', name: 'file_write', arguments: '{}' }] }),
      msg({ role: 'tool', toolCallId: 'c1', toolName: 'file_write', content: 'saved' }),
      msg({ content: r.content, meta: r.meta }),
      msg({ role: 'user', content: '[From the app] Check your work.', meta: { hidden: true } })
    ]
    expect(JSON.stringify(toWire(activeMessages(ms, emptyState())))).not.toContain('Stretch')
    ms.push(msg({ role: 'user', content: 'Thanks. What next?' }))
    expect(JSON.stringify(toWire(activeMessages(ms, emptyState())))).toContain('Stretch')
  })
})

describe('a routine that ran beside a busy chat', () => {
  test('its answer keeps its sources, stock card and the files it made', () => {
    const after = [
      { id: 't1', role: 'tool', toolName: 'create_document', meta: { status: 'ok', path: '/u/report.pdf' } },
      { id: 't2', role: 'tool', toolName: 'web_search', meta: { status: 'ok' } },
      { id: 't3', role: 'tool', toolName: 'file_write', meta: { status: 'error', path: '/u/x.txt' } }
    ]
    const r = routineAside({ id: 'w1', title: '⏰ Weekly report' }, 'side1', { content: 'Here is the report.', meta: { sources: [{ title: 'A', url: 'https://a' }], provisional: true } }, after)
    expect(r.content).toBe('Here is the report.')
    expect(r.meta).toEqual({ sources: [{ title: 'A', url: 'https://a' }], madeFiles: [{ key: 't1', path: '/u/report.pdf' }], scheduled: 'w1', routineTitle: 'Weekly report', aside: true, routineRun: 'side1' })
  })

  test('the bot sees it in later turns, never in the run it was posted beside', () => {
    let n = 0
    const msg = (p: Partial<Message>): Message => ({ id: `m${++n}`, threadId: 't', role: 'assistant', content: '', kind: 'normal', status: 'done', createdAt: n, ...p })
    const r = routineAside({ id: 'w1', title: 'Atlanta weather' }, 'side1', { content: 'Atlanta: 54°F, light rain.' }, [])
    const rem = reminderMessage({ id: 'r1', title: 'Stretch', prompt: '⏰ Reminder: Stretch' })
    const ms = [
      msg({ role: 'user', content: 'Email Bob the report' }),
      msg({ toolCalls: [{ id: 'c1', name: 'send_email', arguments: '{}' }] }),
      msg({ content: r.content, meta: r.meta }),
      msg({ role: 'tool', toolCallId: 'c1', toolName: 'send_email', content: 'sent' }),
      msg({ content: 'Sent.' }),
      msg({ content: rem.content, meta: rem.meta })
    ]
    // While that run is still the latest: untouched.
    expect(JSON.stringify(toWire(activeMessages(ms, emptyState())))).not.toContain('Atlanta')
    // A later message: both are in the history, the routine's note after that batch's tool result.
    ms.push(msg({ role: 'user', content: 'What did the weather say this morning?' }))
    const wire = toWire(activeMessages(ms, emptyState()))
    expect(wire.map((w) => w.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant', 'user', 'user'])
    expect(wire[2]).toMatchObject({ tool_call_id: 'c1', content: 'sent' })
    expect(wire[3].content).toBe('[Earlier, routine "Atlanta weather" posted this (its own run\'s answer): Atlanta: 54°F, light rain.]')
    expect(wire[5].content).toBe('[Earlier, a reminder was posted: ⏰ Reminder: Stretch]')
    expect(JSON.stringify(wire)).not.toContain('[Not run')
  })
})

describe('asking about routines is agent work (one reply, no find_tools detour)', () => {
  test.each(["What's scheduled?", 'Cancel it', 'what routines do I have', 'snooze it 10 minutes', 'Move it to 7', 'Delete the weather routine', 'Pause the stretch reminder', 'What reminders do I have?'])('%s', (text) => {
    expect(classifyTask(text).kind).toBe('agent')
    expect(classifyTask(text, { previous: 'agent' }).kind).toBe('agent')
  })
  test('plain questions stay chat', () => {
    expect(classifyTask('What does schedule mean?').kind).toBe('chat')
    expect(classifyTask('What is the capital of France?').kind).toBe('chat')
  })
})

describe('listing and changing routines', () => {
  test('a one-off that went off reads as done, not paused; another bot\'s routines come last, with its name', async () => {
    const { db, s, tool, ctx } = setup()
    const other = db.createSpace('Scout', '#111')
    s.create({ title: 'Scout digest', prompt: 'Summarize', schedule: { type: 'daily', time: '08:00' }, spaceId: other.id })
    await tool.run({ action: 'create', title: 'Stretch', remind: 'Stretch', when: { type: 'once', in_minutes: 3 } } as never, ctx)
    await tool.run({ action: 'create', title: 'Water', remind: 'Water', when: { type: 'daily', time: '10:00' } } as never, ctx)
    const stretch = s.list().find((t) => t.title === 'Stretch')!
    // It goes off (3 minutes later).
    ;(s as unknown as { now: () => Date }).now = () => new Date(stretch.nextRun! + 1000)
    await s.fire(stretch)
    s.update(s.list().find((t) => t.title === 'Water')!.id, { enabled: false })
    const lines = (await tool.run({ action: 'list' } as never, ctx)).text.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.at(-1)).toMatch(/Scout digest \(Scout's\): Every day at 8:00 AM/)
    const st = lines.find((l) => l.includes('Stretch'))!
    expect(st).toMatch(/already went off/)
    expect(st).not.toMatch(/paused/)
    expect(lines.find((l) => l.includes('Water'))).toMatch(/\(paused\)/)
  })

  test('"move it to 7" keeps the days and the zone, whatever the model leaves out', async () => {
    const { s, tool, ctx } = setup()
    const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri']
    await tool.run({ action: 'create', title: 'Atlanta weather', prompt: 'Send me the Atlanta weather', when: { type: 'weekly', days: weekdays, time: '07:30', tz: 'America/New_York' } } as never, ctx)
    const id = s.list()[0].id
    const moved = (await tool.run({ action: 'update', id, when: { type: 'weekly', time: '07:00' } } as never, ctx)).text
    expect(moved).toMatch(/Weekdays at 7:00 AM ET/)
    expect(s.get(id)!.schedule).toEqual({ type: 'weekly', days: weekdays, time: '07:00', tz: 'America/New_York' })
    // Sent as a daily: still weekdays.
    await tool.run({ action: 'update', id, when: { type: 'daily', time: '06:45' } } as never, ctx)
    expect(s.get(id)!.schedule).toEqual({ type: 'weekly', days: weekdays, time: '06:45', tz: 'America/New_York' })
    // "Make it every day" (a daily at the same time): every day.
    await tool.run({ action: 'update', id, when: { type: 'daily', time: '06:45' } } as never, ctx)
    expect(s.get(id)!.schedule).toEqual({ type: 'daily', time: '06:45', tz: 'America/New_York' })
    // A weekly with no days to keep, or no time: a clear error, never a crash.
    expect(() => keepRest({ type: 'weekly', time: '07:00' } as never, { type: 'once', at: '2026-12-01T09:00' })).toThrow(/needs when.days/)
    await expect(tool.run({ action: 'create', title: 'X', prompt: 'x', when: { type: 'weekly', time: '07:00' } } as never, ctx)).rejects.toThrow(/needs when.days/)
    expect(() => s.create({ title: 'X', prompt: 'x', schedule: { type: 'weekly', time: '07:00' } as never, spaceId: '' })).toThrow(/weekly schedule needs days/)
    expect(() => s.update(id, { schedule: { type: 'weekly', days: [], time: '07:00' } })).toThrow(/weekly schedule needs days/)
    expect(keepRest({ type: 'weekly', time: '09:00' } as never, { type: 'daily', time: '08:00' })).toEqual({ type: 'weekly', time: '09:00', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] })
  })
})

describe('a place\'s clock', () => {
  test('routines tied to a place read on that clock everywhere: "7:30 AM ET", never the Mac\'s time', async () => {
    const { s, tool, ctx } = setup()
    const out = await tool.run({ action: 'create', title: 'Atlanta weather', prompt: 'Send me the Atlanta weather', when: { type: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '07:30', tz: 'America/New_York' } } as never, ctx)
    expect(out.text).toMatch(/Weekdays at 7:30 AM ET/)
    expect(out.text).toMatch(/Next run: \w{3}, \w{3} \d+ at 7:30 AM ET/)
    const list = (await tool.run({ action: 'list' } as never, ctx)).text
    expect(list).toMatch(/Weekdays at 7:30 AM ET, next \w{3}, \w{3} \d+ at 7:30 AM ET/)
    const id = s.list()[0].id
    const moved = (await tool.run({ action: 'update', id, when: { type: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '07:00' } } as never, ctx)).text
    expect(moved).toMatch(/Weekdays at 7:00 AM ET/)
    expect(moved).toMatch(/Next run: .* at 7:00 AM ET/)
    const t = s.get(id)!
    expect(nextRunText(t.schedule, t.nextRun!)).toMatch(/at 7:00 AM ET$/)
    expect(nextLabel({ type: 'daily', time: '07:30', tz: 'America/New_York' }, Date.UTC(2026, 10, 25, 12, 30))).toBe('Wed, Nov 25 at 7:30 AM ET')
  })

  test('a place\'s weather routine without a zone gets the place\'s zone; reminders and "my time" never do', async () => {
    const weekday: Schedule = { type: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '07:30' }
    expect(placeZone(weekday, 'Atlanta weather\nSend me the Atlanta weather')).toEqual({ ...weekday, tz: 'America/New_York' })
    expect(placeZone(weekday, 'Weather\nSend me the forecast for Chicago')).toEqual({ ...weekday, tz: 'America/Chicago' })
    expect(placeZone(weekday, 'Call mom\nRemind me to call mom in Chicago')).toEqual(weekday)
    expect(placeZone(weekday, 'Weather\nSend me the Atlanta weather at 7:30 my time')).toEqual(weekday)
    expect(placeZone(weekday, 'Weather\nCompare the Boston and Denver weather')).toEqual(weekday)
    expect(placeZone({ ...weekday, tz: 'Europe/London' }, 'Atlanta weather')).toEqual({ ...weekday, tz: 'Europe/London' })
    expect(placeZone({ type: 'once', at: '2026-12-01T09:00' }, 'Atlanta weather')).toEqual({ type: 'once', at: '2026-12-01T09:00' })
    const { s, tool, ctx } = setup()
    await tool.run({ action: 'create', title: 'Atlanta weather', prompt: 'Send me the Atlanta weather', when: weekday } as never, ctx)
    expect(s.list()[0].schedule).toEqual({ ...weekday, tz: 'America/New_York' })
  })

  test('a one-off "in N minutes" with a place reads on that place\'s clock', () => {
    const at = new Date(Date.UTC(2026, 10, 24, 20, 5)).toISOString()
    expect(describeSchedule({ type: 'once', at, tz: 'America/New_York' })).toBe('Once · Tue, Nov 24 at 3:05 PM ET')
  })
})

describe('setting up a routine never raises a money card', () => {
  let llm: MockLlm
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('"Remind me to pay rent at 6" in Auto: no approval card', async () => {
    const db = new Db(':memory:')
    const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
    const registry = new ToolRegistry()
    const scheduler = new Scheduler(db, async () => 'done', () => undefined)
    registry.register(...coreTools(results), { ...scheduleTool(scheduler, db), core: true })
    const model: ModelInfo = { id: 'm', name: 'm', provider: 'custom', sizeGB: 1, context: 32768, tools: true } as never
    const settings = { contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true }, workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: 'm', hiddenModels: [], shownModels: [], cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [] } as unknown as Settings
    const last = { ok: true, models: [model], budgetGB: 32, totalGB: 64, providers: [] }
    const asked: string[] = []
    const agent: Agent = new Agent({
      db, results, registry, docsDir: tmpdir(),
      settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
      endpoints: { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => [model], list: async () => last, advisor: () => undefined } as never,
      spaces: { getPrompt: () => '' } as never, memory: { block: () => '' } as never,
      emit: (e: { type: string; threadId: string; request?: { id: string } }) => { if (e.type === 'pending' && e.request) { asked.push(JSON.stringify(e.request)); setTimeout(() => agent.respond(e.threadId, e.request!.id, 'deny'), 0) } },
      secretValues: () => [], fitWindow: (_m: string, w: number) => w, counter: () => ({ count: async (t: string) => estimate(t) })
    } as never)
    llm.script.push(
      { toolCalls: [{ name: 'schedule', arguments: JSON.stringify({ action: 'create', title: 'Pay rent', remind: 'Pay rent', when: { type: 'once', in_minutes: 120 } }) }] },
      { content: 'I\'ll remind you to pay rent at 6.' }
    )
    const t = db.createThread(db.createSpace('Home', '#000').id, 'auto', 'm')
    await (await agent.send({ threadId: t.id, text: 'Remind me to pay rent in 2 hours' } as never)).done
    expect(asked).toEqual([])
    expect(scheduler.list().map((x) => x.title)).toEqual(['Pay rent'])
  }, 30_000)
})
