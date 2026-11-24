import { expect, test } from 'vitest'
import { Db } from '../../src/main/db'
import { nextRun, Scheduler } from '../../src/main/scheduler'
import { scheduleTool } from '../../src/main/agent/tools/schedule'
import { describeSchedule } from '../../src/renderer/src/routines'

// Grok Bot head-to-head (SCA-03): "Every weekday at 7:30 send me the Atlanta weather" is 7:30 in Atlanta, whatever
// clock the Mac is on, and "move it to 7" keeps it there.
test('a routine tied to a place runs on that place\'s clock', () => {
  const from = new Date('2026-11-24T06:00:00Z') // 1:00 Eastern, Tue
  expect(nextRun({ type: 'daily', time: '07:30', tz: 'America/New_York' }, from)!.toISOString()).toBe('2026-11-24T12:30:00.000Z')
  expect(nextRun({ type: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '07:30', tz: 'America/New_York' }, new Date('2026-11-24T13:00:00Z'))!.toISOString()).toBe('2026-11-25T12:30:00.000Z')
  // Summer time is handled (EDT is UTC-4).
  expect(nextRun({ type: 'daily', time: '07:30', tz: 'America/New_York' }, new Date('2026-07-01T00:00:00Z'))!.toISOString()).toBe('2026-07-01T11:30:00.000Z')
  expect(nextRun({ type: 'once', at: '2026-12-01T09:00', tz: 'America/Los_Angeles' }, from)!.toISOString()).toBe('2026-12-01T17:00:00.000Z')
  // A one-off that already carries its offset, and a bad zone name, are left as they are.
  expect(nextRun({ type: 'once', at: '2026-12-01T09:00:00Z', tz: 'America/Los_Angeles' }, from)!.toISOString()).toBe('2026-12-01T09:00:00.000Z')
  expect(nextRun({ type: 'daily', time: '07:30', tz: 'Mars/Olympus' }, from)).toEqual(nextRun({ type: 'daily', time: '07:30' }, from))
  expect(describeSchedule({ type: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '07:30', tz: 'America/New_York' })).toBe('Weekdays at 7:30 AM ET')
})

test('moving a routine keeps the place\'s time zone', async () => {
  const db = new Db(':memory:')
  const space = db.createSpace('Weather', '#000')
  const th = db.createThread(space.id, 'auto', null)
  const s = new Scheduler(db, async () => 'done', () => undefined)
  const tool = scheduleTool(s, db)
  const ctx = { threadId: th.id } as never
  await tool.run({ action: 'create', title: 'Atlanta weather', prompt: 'Send the Atlanta weather', when: { type: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '07:30', tz: 'America/New_York' } } as never, ctx)
  const id = s.list()[0].id
  await tool.run({ action: 'update', id, when: { type: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '07:00' } } as never, ctx)
  expect(s.get(id)!.schedule).toEqual({ type: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '07:00', tz: 'America/New_York' })
  const out = await tool.run({ action: 'list' } as never, ctx)
  expect(out.text).toMatch(/07:00 ET/)
})
