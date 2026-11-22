import { describe, expect, test } from 'vitest'
import { Db } from '../../src/main/db'
import { Scheduler, describeSchedule, nextCron, nextRun } from '../../src/main/scheduler'

const at = (s: string) => new Date(s)

describe('schedule math', () => {
  test('cron: weekdays at 9, every 15 minutes, day lists', () => {
    expect(nextCron('0 9 * * 1-5', at('2026-11-13T17:00:00')).toString()).toBe(at('2026-11-16T09:00:00').toString()) // Fri 5pm -> Mon 9am
    expect(nextCron('*/15 * * * *', at('2026-11-12T10:07:00')).getMinutes()).toBe(15)
    expect(nextCron('30 8 1,15 * *', at('2026-11-02T00:00:00')).getDate()).toBe(15)
    expect(() => nextCron('61 * * * *', new Date())).toThrow()
  })
  test('daily, weekly, every, once', () => {
    expect(nextRun({ type: 'daily', time: '09:00' }, at('2026-11-12T10:00:00'))!.toString()).toBe(at('2026-11-13T09:00:00').toString())
    expect(nextRun({ type: 'weekly', days: ['mon', 'thu'], time: '08:30' }, at('2026-11-12T09:00:00'))!.toString()).toBe(at('2026-11-16T08:30:00').toString())
    expect(nextRun({ type: 'every', minutes: 30 }, at('2026-11-12T09:00:00'))!.toString()).toBe(at('2026-11-12T09:30:00').toString())
    expect(nextRun({ type: 'once', at: '2026-11-12T08:00:00' }, at('2026-11-12T09:00:00'))).toBeNull()
    expect(describeSchedule({ type: 'every', minutes: 120 })).toBe('every 2 hours')
  })
})

describe('scheduler', () => {
  test('runs due tasks once, coalesces missed runs, advances, and turns one-offs off', async () => {
    const db = new Db(':memory:')
    const space = db.createSpace('Foreman', '#000', { isMain: true })
    let now = at('2026-11-12T08:00:00')
    const ran: string[] = []
    const s = new Scheduler(db, async (t) => { ran.push(t.title); return 'done' }, () => undefined, () => now)
    s.create({ title: 'daily', prompt: 'x', schedule: { type: 'daily', time: '09:00' }, spaceId: space.id })
    s.create({ title: 'once', prompt: 'y', schedule: { type: 'once', at: '2026-11-12T09:30:00' }, spaceId: space.id })
    await s.tick()
    expect(ran).toEqual([])
    // The Mac slept for two days: each task runs once, not once per missed slot.
    now = at('2026-11-14T12:00:00')
    await s.tick()
    expect(ran.sort()).toEqual(['daily', 'once'])
    await s.tick()
    expect(ran).toHaveLength(2)
    const [daily, once] = ['daily', 'once'].map((n) => s.list().find((t) => t.title === n)!)
    expect(new Date(daily.nextRun!).toString()).toBe(at('2026-11-15T09:00:00').toString())
    expect(once.enabled).toBe(false)
    expect(daily.lastStatus).toBe('done')
  })
  test('rejects past one-offs and empty instructions', () => {
    const db = new Db(':memory:')
    const space = db.createSpace('F', '#000', { isMain: true })
    const s = new Scheduler(db, async () => 'done', () => undefined, () => at('2026-11-12T08:00:00'))
    expect(() => s.create({ title: 't', prompt: 'x', schedule: { type: 'once', at: '2026-11-01T00:00:00' }, spaceId: space.id })).toThrow(/passed/)
    expect(() => s.create({ title: 't', prompt: ' ', schedule: { type: 'daily', time: '09:00' }, spaceId: space.id })).toThrow(/instructions/)
  })
})

describe('on time, and the list tells the truth (Grok Bot ran a reminder 7 minutes late and dropped it from Upcoming)', () => {
  test('a reminder in 3 minutes runs on the first check after it is due (checks every 20 s), not before', async () => {
    const db = new Db(':memory:')
    const space = db.createSpace('Main', '#000', { isMain: true })
    let now = at('2026-11-22T06:16:10')
    const ran: Array<{ title: string; at: number }> = []
    const s = new Scheduler(db, async (t) => { ran.push({ title: t.title, at: now.getTime() }); return 'done' }, () => undefined, () => now)
    s.create({ title: 'Schedule test reminder', prompt: 'Say "Schedule test fired"', schedule: { type: 'once', at: '2026-11-22T06:19:00' }, spaceId: space.id })
    // Every 20 s, like the app: nothing before 6:19, it runs on the 6:19:10 check, and only once.
    for (let t = now.getTime(); t <= at('2026-11-22T06:21:00').getTime(); t += 20_000) { now = new Date(t); await s.tick() }
    expect(ran).toHaveLength(1)
    const lateBy = ran[0].at - at('2026-11-22T06:19:00').getTime()
    expect(lateBy).toBeGreaterThanOrEqual(0)
    expect(lateBy).toBeLessThanOrEqual(20_000)
  })

  test('the routine row says what is happening: schedule, starting, running, done, paused', async () => {
    const { routineStatus } = await import('../../src/renderer/src/routines')
    const once = { schedule: { type: 'once', at: '2026-11-22T06:19:00' } as const, enabled: true, lastStatus: null }
    const due = at('2026-11-22T06:19:00').getTime()
    expect(routineStatus({ ...once, nextRun: due, lastRun: null }, false, due - 60_000)).toMatch(/^Once · /)
    expect(routineStatus({ ...once, nextRun: due, lastRun: null }, false, due + 5_000)).toBe('Starting now…')
    expect(routineStatus({ ...once, nextRun: null, lastRun: due }, true)).toBe('Running…')
    expect(routineStatus({ ...once, enabled: false, nextRun: null, lastRun: due + 10_000 }, false)).toMatch(/^Done · ran /)
    expect(routineStatus({ schedule: { type: 'daily', time: '09:00' }, enabled: false, nextRun: due, lastRun: null, lastStatus: null }, false)).toBe('Paused')
  })
})

describe('the New routine form', () => {
  test('what it describes becomes a schedule; the past or no days is not a routine', async () => {
    const { formSchedule, titleFrom } = await import('../../src/renderer/src/routines')
    const now = at('2026-11-22T06:00:00')
    expect(formSchedule({ repeat: 'daily', date: '', time: '09:05', days: [] }, now)).toEqual({ type: 'daily', time: '09:05' })
    expect(formSchedule({ repeat: 'weekdays', date: '', time: '09:10', days: [] }, now)).toEqual({ type: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '09:10' })
    expect(formSchedule({ repeat: 'weekly', date: '', time: '09:10', days: ['mon', 'sat'] }, now)).toEqual({ type: 'weekly', days: ['mon', 'sat'], time: '09:10' })
    expect(formSchedule({ repeat: 'weekly', date: '', time: '09:10', days: [] }, now)).toBeNull()
    expect(formSchedule({ repeat: 'once', date: '2026-11-22', time: '06:19', days: [] }, now)).toEqual({ type: 'once', at: '2026-11-22T06:19:00' })
    expect(formSchedule({ repeat: 'once', date: '2026-11-21', time: '06:19', days: [] }, now)).toBeNull()
    expect(titleFrom('Send me a short science fact.')).toBe('Send me a short science fact')
    expect(titleFrom('x '.repeat(60)).length).toBeLessThanOrEqual(49)
  })
})

describe('changing a routine by chat', () => {
  test('update moves it to 9:10 and adds Saturday, keeping the same routine (and its history)', async () => {
    const { scheduleTool } = await import('../../src/main/agent/tools/schedule')
    const { emptyState } = await import('../../src/main/agent/types')
    const db = new Db(':memory:')
    const space = db.createSpace('Main', '#000', { isMain: true })
    const t = db.createThread(space.id, 'auto', null)
    const now = at('2026-11-22T06:16:00')
    const s = new Scheduler(db, async () => 'done', () => undefined, () => now)
    const tool = scheduleTool(s, db)
    const ctx = { threadId: t.id, state: emptyState() } as never
    await tool.run({ action: 'create', title: 'Weekday science fact', prompt: 'Send a science fact', when: { type: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '09:05' } }, ctx)
    const id = s.list()[0].id
    const out = await tool.run({ action: 'update', id, when: { type: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], time: '09:10' } }, ctx)
    expect(out.text).toMatch(/Updated "Weekday science fact"/)
    expect(s.list()).toHaveLength(1)
    expect(s.list()[0]).toMatchObject({ id, schedule: { type: 'weekly', time: '09:10' } })
    expect((s.list()[0].schedule as { days: string[] }).days).toContain('sat')
    await expect(tool.run({ action: 'update', id }, ctx)).rejects.toThrow(/at least one/)
  })
})
