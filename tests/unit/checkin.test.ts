import { describe, expect, test } from 'vitest'
import type { PendingRequest } from '@shared/types'
import { botsOverview, overviewTool, removeCheckin } from '../../src/main/checkin'
import { Db } from '../../src/main/db'
import { Scheduler } from '../../src/main/scheduler'

function setup(): { db: Db; s: Scheduler; main: string } {
  const db = new Db(':memory:')
  const main = db.createSpace('SahilBot', '#1F1F1F', { isMain: true, shape: 'mascot' }).id
  const s = new Scheduler(db, async () => 'done', () => undefined)
  return { db, s, main }
}

describe('morning check-in removed', () => {
  test('the routine an earlier version made is deleted at startup; the setting goes with it', () => {
    const { db, s, main } = setup()
    const t = s.create({ title: 'Morning check-in', prompt: 'Give me a short morning check-in.', schedule: { type: 'daily', time: '08:30' }, spaceId: main, enabled: true })
    db.setSetting('checkin', { taskId: t.id, time: '08:30' })
    expect(removeCheckin(db, s)).toBe(true)
    expect(s.get(t.id)).toBeUndefined()
    expect(db.getSetting('checkin')).toBeUndefined()
    // Next startup: nothing left to do.
    expect(removeCheckin(db, s)).toBe(false)
  })

  test('a routine the user made is never touched, even one with the same title', () => {
    const { db, s, main } = setup()
    const mine = s.create({ title: 'Morning check-in', prompt: 'My own wording.', schedule: { type: 'daily', time: '07:00' }, spaceId: main, enabled: true })
    expect(removeCheckin(db, s)).toBe(false)
    db.setSetting('checkin', { taskId: null, time: '08:30' })
    expect(removeCheckin(db, s)).toBe(false)
    expect(s.get(mine.id)?.enabled).toBe(true)
    expect(db.getSetting('checkin')).toBeUndefined()
  })
})

describe('bots overview', () => {
  test('summaries only: open plans, waits, failed routines, unread', async () => {
    const { db, s, main } = setup()
    const writer = db.createSpace('Writer', '#7C5CFF').id
    const t1 = db.createThread(writer, 'auto', null)
    db.setState(t1.id, { ...db.getState(t1.id), todos: [{ text: 'Outline', status: 'done' }, { text: 'Draft the intro about the secret plan', status: 'in_progress' }, { text: 'Edit', status: 'pending' }] })
    db.updateThread(t1.id, { unread: true }, true)
    const t2 = db.createThread(main, 'auto', null)
    db.updateThread(t2.id, { title: 'Taxes' }, true)
    db.insertMessage({ threadId: t1.id, role: 'user', content: 'PRIVATE CHAT TEXT', kind: 'normal', status: 'done' })
    const task = s.create({ title: 'Inbox sweep', prompt: 'Sweep the inbox every morning.', schedule: { type: 'daily', time: '08:00' }, spaceId: writer })
    db.sql.prepare('UPDATE scheduled_tasks SET last_run = ?, last_status = ? WHERE id = ?').run(Date.now() - 3_600_000, 'error: Gmail is not connected', task.id)
    const pending: PendingRequest[] = [{ id: 'r1', threadId: t2.id, kind: 'approval', summary: 'Send an email to the accountant' }]

    const text = botsOverview({ db, pending: () => pending, routines: () => s.list() })
    expect(text).toContain('Writer: 2 of 3 steps open; next: Draft the intro about the secret plan')
    expect(text).toContain('SahilBot (main) · "Taxes": approve: Send an email to the accountant')
    expect(text).toContain('Writer: "Inbox sweep" error: Gmail is not connected')
    expect(text).toContain('Writer: 1 unread chat')
    expect(text).not.toContain('PRIVATE CHAT TEXT')

    const tool = overviewTool({ db, pending: () => [], routines: () => [] })
    expect(tool.effect).toBe('read')
    const out = await tool.run({}, {} as never)
    expect(out.text).toContain('2 of 3 steps open')
  })

  test('nothing open says so', () => {
    const { db, s } = setup()
    expect(botsOverview({ db, pending: () => [], routines: () => s.list() })).toMatch(/^Nothing open/)
  })
})
