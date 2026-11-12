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
