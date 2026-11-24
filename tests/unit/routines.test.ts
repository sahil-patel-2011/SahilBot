import { describe, expect, test } from 'vitest'
import { Db } from '../../src/main/db'
import { RUNS_KEPT, Scheduler, runOutcome, type RoutineEvent } from '../../src/main/scheduler'
import { clock, describeSchedule, groupLibrary, midSentence, when } from '../../src/renderer/src/routines'
import type { LibraryItem } from '../../src/shared/types'

const at = (s: string) => new Date(s)

describe('describeSchedule (in words)', () => {
  test('daily, weekly and day sets', () => {
    expect(clock('09:00')).toBe('9:00 AM')
    expect(clock('17:30')).toBe('5:30 PM')
    expect(clock('00:05')).toBe('12:05 AM')
    expect(describeSchedule({ type: 'daily', time: '09:00' })).toBe('Every day at 9:00 AM')
    expect(describeSchedule({ type: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '08:00' })).toBe('Weekdays at 8:00 AM')
    expect(describeSchedule({ type: 'weekly', days: ['sun', 'sat'], time: '10:15' })).toBe('Weekends at 10:15 AM')
    expect(describeSchedule({ type: 'weekly', days: ['monday'], time: '13:00' })).toBe('Every Monday at 1:00 PM')
    expect(describeSchedule({ type: 'weekly', days: ['fri', 'mon', 'wed'], time: '07:00' })).toBe('Mon, Wed, Fri at 7:00 AM')
    expect(describeSchedule({ type: 'weekly', days: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], time: '07:00' })).toBe('Every day at 7:00 AM')
  })
  test('every N', () => {
    expect(describeSchedule({ type: 'every', minutes: 1 })).toBe('Every minute')
    expect(describeSchedule({ type: 'every', minutes: 15 })).toBe('Every 15 minutes')
    expect(describeSchedule({ type: 'every', minutes: 60 })).toBe('Every hour')
    expect(describeSchedule({ type: 'every', minutes: 120 })).toBe('Every 2 hours')
    expect(describeSchedule({ type: 'every', minutes: 90 })).toBe('Every 90 minutes')
    expect(describeSchedule({ type: 'every', minutes: 2880 })).toBe('Every 2 days')
  })
  test('once', () => {
    expect(describeSchedule({ type: 'once', at: '2026-11-12T09:00:00' })).toBe('Once · Thu, Nov 12 at 9:00 AM')
  })
  test('common cron shapes read as words; anything else says custom', () => {
    expect(describeSchedule({ type: 'cron', expr: '0 9 * * 1-5' })).toBe('Weekdays at 9:00 AM')
    expect(describeSchedule({ type: 'cron', expr: '30 18 * * *' })).toBe('Every day at 6:30 PM')
    expect(describeSchedule({ type: 'cron', expr: '0 10 * * 0,6' })).toBe('Weekends at 10:00 AM')
    expect(describeSchedule({ type: 'cron', expr: '0 8 * * mon,thu' })).toBe('Mon, Thu at 8:00 AM')
    expect(describeSchedule({ type: 'cron', expr: '*/15 * * * *' })).toBe('Every 15 minutes')
    expect(describeSchedule({ type: 'cron', expr: '0 * * * *' })).toBe('Every hour')
    expect(describeSchedule({ type: 'cron', expr: '0 */3 * * *' })).toBe('Every 3 hours')
    expect(describeSchedule({ type: 'cron', expr: '0 9 1 * *' })).toBe('Monthly on the 1st at 9:00 AM')
    expect(describeSchedule({ type: 'cron', expr: '0 9 1 1 *' })).toBe('Custom schedule (0 9 1 1 *)')
    expect(describeSchedule({ type: 'cron', expr: 'nonsense' })).toBe('Custom schedule')
  })
})

describe('library + times', () => {
  const now = at('2026-11-12T15:00:00').getTime()
  test('when()', () => {
    expect(when(at('2026-11-12T09:02:00').getTime(), now)).toBe('Today at 9:02 AM')
    expect(when(at('2026-11-11T21:40:00').getTime(), now)).toBe('Yesterday at 9:40 PM')
    expect(when(at('2026-11-09T09:02:00').getTime(), now)).toBe('Mon, Nov 9 at 9:02 AM')
  })
  test('groups Today / This week / Older, newest first, drops empty groups', () => {
    const item = (iso: string, title: string): LibraryItem => ({ kind: 'file', title, path: `/x/${title}`, at: at(iso).getTime(), threadId: 't' })
    const g = groupLibrary([item('2026-11-01T10:00:00', 'old'), item('2026-11-12T08:00:00', 'a'), item('2026-11-12T11:00:00', 'b'), item('2026-11-08T10:00:00', 'week')], now)
    expect(g.map((x) => x.label)).toEqual(['Today', 'This week', 'Older'])
    expect(g[0].items.map((x) => x.title)).toEqual(['b', 'a'])
    expect(g[1].items.map((x) => x.title)).toEqual(['week'])
    expect(groupLibrary([item('2026-11-12T08:00:00', 'a')], now).map((x) => x.key)).toEqual(['today'])
  })
})

describe('routine runs', () => {
  test('outcomes', () => {
    expect(runOutcome('done')).toEqual({ status: 'succeeded', reason: null })
    expect(runOutcome('stopped').status).toBe('failed')
    expect(runOutcome('skipped: the chat was busy')).toEqual({ status: 'failed', reason: 'the chat was busy' })
    expect(runOutcome('error: Ollama is not running')).toEqual({ status: 'failed', reason: 'Ollama is not running' })
  })

  test('records each run, keeps the last 20, and Test leaves the schedule alone', async () => {
    const db = new Db(':memory:')
    const space = db.createSpace('Bot', '#000')
    const now = at('2026-11-12T08:00:00')
    let n = 0
    const s = new Scheduler(db, async () => (++n % 3 === 0 ? 'error: boom' : 'done'), () => undefined, () => now)
    const t = s.create({ title: 'r', prompt: 'x', schedule: { type: 'once', at: '2026-11-13T09:00:00' }, spaceId: space.id })
    const first = s.test(t.id)!
    expect(s.runs(t.id)[0].status).toBe('running')
    expect(s.test(t.id)).toBeNull() // already running
    await first.done
    expect(s.runs(t.id)[0]).toMatchObject({ status: 'succeeded', test: true, reason: null })
    // A Test never uses up a one-off or moves its next run.
    expect(s.get(t.id)!.enabled).toBe(true)
    expect(s.get(t.id)!.nextRun).toBe(t.nextRun)
    for (let i = 0; i < 25; i++) await s.test(t.id)!.done
    const runs = s.runs(t.id)
    expect(runs).toHaveLength(RUNS_KEPT)
    expect((db.sql.prepare('SELECT COUNT(*) AS c FROM routine_runs').get() as { c: number }).c).toBe(RUNS_KEPT)
    const failed = runs.find((r) => r.status === 'failed')!
    expect(failed.reason).toBe('boom')
    expect(failed.finishedAt).not.toBeNull()
    // Deleting the routine drops its history.
    s.remove(t.id)
    expect((db.sql.prepare('SELECT COUNT(*) AS c FROM routine_runs').get() as { c: number }).c).toBe(0)
  })

  test('scheduled runs are recorded too, and runs left running by a quit are marked failed', async () => {
    const db = new Db(':memory:')
    const space = db.createSpace('Bot', '#000')
    let now = at('2026-11-12T08:00:00')
    const s = new Scheduler(db, async () => ({ status: 'done', threadId: 'th1' }), () => undefined, () => now)
    const t = s.create({ title: 'daily', prompt: 'x', schedule: { type: 'daily', time: '09:00' }, spaceId: space.id })
    now = at('2026-11-12T09:01:00')
    await s.tick()
    expect(s.runs(t.id)).toHaveLength(1)
    expect(s.runs(t.id)[0]).toMatchObject({ status: 'succeeded', test: false, threadId: 'th1' })
    db.sql.prepare(`INSERT INTO routine_runs(id, task_id, started_at, status) VALUES('x', ?, 1, 'running')`).run(t.id)
    const again = new Scheduler(db, async () => 'done', () => undefined, () => now)
    expect(again.runs(t.id).find((r) => r.id === 'x')!.status).toBe('failed')
  })

  test('emits created / paused / resumed / changed / deleted / failed', async () => {
    const db = new Db(':memory:')
    const space = db.createSpace('Bot', '#000')
    const s = new Scheduler(db, async () => 'error: no network', () => undefined, () => at('2026-11-12T08:00:00'))
    const seen: RoutineEvent[] = []
    s.events = (e) => seen.push(e)
    const t = s.create({ title: 'r', prompt: 'x', schedule: { type: 'daily', time: '09:00' }, spaceId: space.id })
    s.update(t.id, { enabled: false })
    s.update(t.id, { enabled: true })
    s.update(t.id, { schedule: { type: 'daily', time: '10:00' } })
    s.update(t.id, { enabled: true }) // no change, no line
    await s.test(t.id)!.done
    s.remove(t.id)
    expect(seen.map((e) => e.type)).toEqual(['created', 'paused', 'resumed', 'changed', 'failed', 'deleted'])
    expect(seen.find((e) => e.type === 'failed')!.reason).toBe('no network')
  })
})

describe('bot label, notifications, library', () => {
  test('label persists; notifications are automatic for every bot (no per-bot switch)', () => {
    const db = new Db(':memory:')
    const s = db.createSpace('Bot', '#000')
    expect(s.label).toBeNull()
    expect(s.notify).toBe(true)
    const u = db.updateSpace(s.id, { label: '  Homework   helper ', notify: false })
    expect(u.label).toBe('Homework helper')
    expect(u.notify).toBe(true)
    expect(db.updateSpace(s.id, { label: '' }).label).toBeNull()
    expect(db.updateSpace(s.id, { name: 'Renamed' })).toMatchObject({ notify: true, label: null })
  })
  test('library: files the bot made, sources it cited and links you sent, only from its own chats', () => {
    const db = new Db(':memory:')
    const bot = db.createSpace('Bot', '#000')
    const other = db.createSpace('Other', '#111')
    const th = db.createThread(bot.id, 'auto', null)
    const th2 = db.createThread(other.id, 'auto', null)
    db.insertMessage({ threadId: th.id, role: 'tool', content: 'ok', kind: 'normal', status: 'done', toolName: 'file_write', meta: { path: '/tmp/notes.md', status: 'ok' } })
    db.insertMessage({ threadId: th.id, role: 'tool', content: 'no', kind: 'normal', status: 'done', toolName: 'file_write', meta: { path: '/tmp/failed.md', status: 'error' } })
    db.insertMessage({ threadId: th.id, role: 'assistant', content: 'see', kind: 'normal', status: 'done', meta: { sources: [{ title: 'Docs', url: 'https://example.com/docs' }] } })
    db.insertMessage({ threadId: th.id, role: 'user', content: 'look at https://news.example.org/a, thanks', kind: 'normal', status: 'done' })
    db.insertMessage({ threadId: th2.id, role: 'user', content: 'https://elsewhere.example.net', kind: 'normal', status: 'done' })
    const lib = db.spaceLibrary(bot.id)
    expect(lib.filter((x) => x.kind === 'file').map((x) => x.title)).toEqual(['notes.md'])
    expect(lib.filter((x) => x.kind === 'link').map((x) => x.url).sort()).toEqual(['https://example.com/docs', 'https://news.example.org/a'])
    expect(lib.find((x) => x.url === 'https://news.example.org/a')!.title).toBe('news.example.org')
  })
})

describe('midSentence', () => {
  test('a relative day reads lowercase inside a line ("next tomorrow at 7:30 AM"); dates keep their capitals', () => {
    expect(midSentence('Tomorrow at 7:30 AM')).toBe('tomorrow at 7:30 AM')
    expect(midSentence('Today at 9:02 AM')).toBe('today at 9:02 AM')
    expect(midSentence('Yesterday at 9:02 AM')).toBe('yesterday at 9:02 AM')
    expect(midSentence('Wed, Nov 25 at 7:30 AM')).toBe('Wed, Nov 25 at 7:30 AM')
    expect(midSentence('Todayish')).toBe('Todayish')
  })
})
