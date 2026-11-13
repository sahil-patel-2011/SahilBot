import { describe, expect, test } from 'vitest'
import type { PendingRequest } from '@shared/types'
import { botsOverview, CHECKIN_PROMPT, getCheckin, overviewTool, setCheckin } from '../../src/main/checkin'
import { Db } from '../../src/main/db'
import { Scheduler } from '../../src/main/scheduler'

function setup(): { db: Db; s: Scheduler; main: string } {
  const db = new Db(':memory:')
  const main = db.createSpace('SahilBot', '#1F1F1F', { isMain: true, shape: 'mascot' }).id
  const s = new Scheduler(db, async () => 'done', () => undefined)
  return { db, s, main }
}

describe('morning check-in', () => {
  test('off by default; turning it on makes one daily routine on the main bot', () => {
    const { db, s, main } = setup()
    expect(getCheckin(db, s)).toEqual({ enabled: false, time: '08:30' })
    expect(s.list()).toHaveLength(0)
    expect(setCheckin(db, s, { enabled: true, time: '07:45' })).toEqual({ enabled: true, time: '07:45' })
    const [t] = s.list()
    expect(t).toMatchObject({ title: 'Morning check-in', spaceId: main, enabled: true, schedule: { type: 'daily', time: '07:45' }, prompt: CHECKIN_PROMPT })
    // Re-timing and switching off reuse the same routine.
    setCheckin(db, s, { enabled: true, time: '09:00' })
    setCheckin(db, s, { enabled: false, time: '09:00' })
    expect(s.list()).toHaveLength(1)
    expect(s.list()[0]).toMatchObject({ enabled: false, schedule: { time: '09:00' } })
    expect(getCheckin(db, s)).toEqual({ enabled: false, time: '09:00' })
    setCheckin(db, s, { enabled: true, time: '09:00' })
    expect(s.list()).toHaveLength(1)
    expect(getCheckin(db, s).enabled).toBe(true)
  })

  test('the switch follows the routine: pausing or deleting it turns the check-in off', () => {
    const { db, s } = setup()
    setCheckin(db, s, { enabled: true, time: '08:00' })
    const id = s.list()[0].id
    s.update(id, { prompt: 'My own wording.' } as never)
    s.update(id, { enabled: false })
    expect(getCheckin(db, s).enabled).toBe(false)
    setCheckin(db, s, { enabled: true, time: '08:00' })
    expect(s.get(id)!.prompt).toBe('My own wording.')
    s.remove(id)
    expect(getCheckin(db, s)).toEqual({ enabled: false, time: '08:00' })
    setCheckin(db, s, { enabled: true, time: '08:00' })
    expect(s.list()).toHaveLength(1)
  })

  test('bad times are refused; the prompt reads only and keeps it short', () => {
    const { db, s } = setup()
    expect(() => setCheckin(db, s, { enabled: true, time: '25:00' })).toThrow(/time/)
    expect(CHECKIN_PROMPT).toMatch(/don't send/)
    expect(CHECKIN_PROMPT).toMatch(/1–3 next actions/)
    expect(CHECKIN_PROMPT).toMatch(/bots_overview/)
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
