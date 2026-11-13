import { inflateSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import { Db } from '../../src/main/db'
import { catchUp, lastDue, LATE_GRACE_MS, Scheduler, type RoutineEvent } from '../../src/main/scheduler'
import { INTERRUPTED_TEXT, KeepAwake, WorkTracker, wantAwake } from '../../src/main/resume'
import { cleanCatchUpHours, DEFAULTS } from '../../src/main/settings'
import { crc32, encodePng, glyphInk, glyphPixels, trayMenuTemplate, trayTitle, trayTooltip, type TrayActions } from '../../src/main/tray'

const at = (s: string): Date => new Date(s)
const H = 3_600_000

describe('missed routines: catch-up rules', () => {
  const now = at('2026-11-14T10:00:00').getTime()
  test('on time, or only waiting for its previous run, just runs', () => {
    expect(catchUp({ dueAt: now - 30_000, now, lastTickAt: null, catchUpHours: 12 })).toBe('run')
    // The scheduler kept checking after it fell due (the routine was still busy): not "missed".
    expect(catchUp({ dueAt: now - 2 * H, now, lastTickAt: now - 20_000, catchUpHours: 12 })).toBe('run')
  })
  test('missed while closed or asleep: late inside the window, skipped outside it, never with 0', () => {
    expect(catchUp({ dueAt: now - 3 * H, now, lastTickAt: null, catchUpHours: 12 })).toBe('late')
    expect(catchUp({ dueAt: now - 3 * H, now, lastTickAt: now - 5 * H, catchUpHours: 12 })).toBe('late')
    expect(catchUp({ dueAt: now - 13 * H, now, lastTickAt: null, catchUpHours: 12 })).toBe('skip')
    expect(catchUp({ dueAt: now - 3 * H, now, lastTickAt: null, catchUpHours: 0 })).toBe('skip')
    expect(catchUp({ dueAt: now - LATE_GRACE_MS - 1, now, lastTickAt: null, catchUpHours: null })).toBe('late')
  })
  test('the latest missed slot counts, not the first', () => {
    const first = at('2026-11-11T09:00:00').getTime()
    expect(new Date(lastDue({ type: 'daily', time: '09:00' }, first, now)).toString()).toBe(at('2026-11-14T09:00:00').toString())
    expect(lastDue({ type: 'every', minutes: 30 }, at('2026-11-14T07:10:00').getTime(), now)).toBe(at('2026-11-14T09:40:00').getTime())
    expect(lastDue({ type: 'once', at: '2026-11-11T09:00:00' }, first, now)).toBe(first)
  })
})

describe('scheduler: missed runs at launch and wake', () => {
  const setup = (catchUpHours: number | null) => {
    const db = new Db(':memory:')
    const space = db.createSpace('SahilBot', '#000', { isMain: true })
    const clock = { now: at('2026-11-11T08:00:00') }
    const ran: Array<{ title: string; late?: number }> = []
    const events: RoutineEvent[] = []
    const s = new Scheduler(db, async (t, info) => { ran.push({ title: t.title, late: info.late }); return 'done' }, () => undefined, () => clock.now)
    s.catchUpHours = () => catchUpHours
    s.events = (e) => events.push(e)
    return { db, space, clock, ran, events, s }
  }
  test('a daily routine missed for days runs once, late, if its latest slot is inside the window', async () => {
    const { space, clock, ran, events, s } = setup(12)
    s.create({ title: 'daily', prompt: 'x', schedule: { type: 'daily', time: '09:00' }, spaceId: space.id })
    clock.now = at('2026-11-14T10:00:00') // launched three days later, an hour after today's 9:00
    await s.tick()
    await s.tick()
    expect(ran).toEqual([{ title: 'daily', late: at('2026-11-14T09:00:00').getTime() }])
    expect(events.filter((e) => e.type === 'late').map((e) => e.dueAt)).toEqual([at('2026-11-14T09:00:00').getTime()])
  })
  test('older than the window: skipped, recurring advance, one-offs turn off; nothing runs twice', async () => {
    const { space, clock, ran, events, s } = setup(12)
    s.create({ title: 'once', prompt: 'y', schedule: { type: 'once', at: '2026-11-11T09:30:00' }, spaceId: space.id })
    s.create({ title: 'weekly', prompt: 'z', schedule: { type: 'weekly', days: ['wed'], time: '09:00' }, spaceId: space.id })
    clock.now = at('2026-11-14T10:00:00')
    await s.tick()
    await s.tick()
    expect(ran).toEqual([])
    expect(events.filter((e) => e.type === 'missed').map((e) => e.task.title).sort()).toEqual(['once', 'weekly'])
    const once = s.list().find((t) => t.title === 'once')!
    expect(once.enabled).toBe(false)
    expect(once.lastStatus).toMatch(/^skipped: missed/)
    expect(new Date(s.list().find((t) => t.title === 'weekly')!.nextRun!).toString()).toBe(at('2026-11-18T09:00:00').toString())
  })
  test('catch-up off (0) never runs missed ones; on-time runs are unaffected', async () => {
    const { space, clock, ran, s } = setup(0)
    s.create({ title: 'daily', prompt: 'x', schedule: { type: 'daily', time: '09:00' }, spaceId: space.id })
    await s.tick() // 08:00: the scheduler is watching
    clock.now = at('2026-11-11T09:00:10')
    await s.tick()
    expect(ran).toEqual([{ title: 'daily', late: undefined }])
    clock.now = at('2026-11-13T09:30:00') // the Mac slept through the 12th and 13th
    await s.tick()
    expect(ran).toHaveLength(1)
  })
  test('pause all: nothing fires; resuming applies the catch-up rules', async () => {
    const { space, clock, ran, s } = setup(12)
    let paused = true
    s.paused = () => paused
    s.create({ title: 'daily', prompt: 'x', schedule: { type: 'daily', time: '09:00' }, spaceId: space.id })
    clock.now = at('2026-11-11T09:00:30')
    await s.tick()
    expect(ran).toEqual([])
    clock.now = at('2026-11-11T11:00:00')
    paused = false
    await s.tick()
    expect(ran).toEqual([{ title: 'daily', late: at('2026-11-11T09:00:00').getTime() }])
  })
})

describe('resume interrupted work', () => {
  const setup = () => {
    const db = new Db(':memory:')
    const space = db.createSpace('SahilBot', '#000', { isMain: true })
    const t = db.createThread(space.id, 'auto', null)
    return { db, t, space }
  }
  test('a run cut off by quitting gets one Continue notice on next launch', () => {
    const { db, t } = setup()
    const w = new WorkTracker(db)
    w.started(t.id)
    w.quitting()
    w.ended(t.id) // ends as the app shuts down: still counts as cut off
    const next = new WorkTracker(db)
    const out = next.recover()
    expect(out.map((x) => x.threadId)).toEqual([t.id])
    const notice = db.listMessages(t.id).at(-1)!
    expect(notice).toMatchObject({ kind: 'notice', content: INTERRUPTED_TEXT, meta: { interrupted: true, resumable: true } })
    expect(db.getThread(t.id)!.unread).toBe(true)
    expect(next.interrupted().map((x) => x.noticeId)).toEqual([notice.id])
    expect(new WorkTracker(db).recover()).toEqual([]) // never twice
  })
  test('finished or stopped runs leave nothing; Continue clears the button', () => {
    const { db, t } = setup()
    const w = new WorkTracker(db)
    w.started(t.id)
    expect(w.working()).toEqual([t.id])
    w.ended(t.id)
    expect(new WorkTracker(db).recover()).toEqual([])
    w.started(t.id) // crash: no end at all
    const next = new WorkTracker(db)
    next.recover()
    expect(next.isInterrupted(t.id)).toBe(true)
    const m = next.clearNotice(t.id)!
    expect(m.meta?.resumable).toBe(false)
    expect(next.isInterrupted(t.id)).toBe(false)
    expect(next.clearNotice(t.id)).toBeNull()
  })
  test('deleted chats and helper threads are skipped', () => {
    const { db, t, space } = setup()
    const helper = db.createThread(space.id, 'auto', null, t.id)
    const w = new WorkTracker(db)
    w.started(helper.id)
    const gone = db.createThread(space.id, 'auto', null)
    w.started(gone.id)
    db.deleteThread(gone.id)
    expect(new WorkTracker(db).recover()).toEqual([])
  })
})

describe('keep awake', () => {
  test('one blocker while working, released when idle; the setting turns it off', () => {
    const calls: string[] = []
    const k = new KeepAwake({ start: () => { calls.push('start'); return 7 }, stop: (id) => { calls.push(`stop ${id}`) } })
    k.set(wantAwake(true, 2))
    k.set(wantAwake(undefined, 1))
    expect(k.on).toBe(true)
    k.set(wantAwake(true, 0))
    k.set(wantAwake(false, 3))
    expect(calls).toEqual(['start', 'stop 7'])
    expect(k.on).toBe(false)
  })
})

describe('settings', () => {
  test('always-on defaults and the catch-up window', () => {
    expect(DEFAULTS).toMatchObject({ menuBarIcon: true, openAtLogin: false, keepAwakeWhileWorking: true, catchUpHours: 12, routinesPaused: false })
    expect([cleanCatchUpHours(0), cleanCatchUpHours(6.4), cleanCatchUpHours(-3), cleanCatchUpHours(1000), cleanCatchUpHours('x'), cleanCatchUpHours(undefined)]).toEqual([0, 6, 0, 168, 12, 12])
  })
})

describe('menu bar icon', () => {
  test('title and tooltip', () => {
    expect(trayTitle(0, 0)).toBe('')
    expect(trayTitle(2, 0)).toBe(' 2')
    expect(trayTitle(0, 1)).toBe(' ●1')
    expect(trayTitle(3, 2)).toBe(' 3 ●2')
    expect(trayTooltip(0, 0)).toBe('SahilBot — Idle')
    expect(trayTooltip(2, 1, true)).toBe('SahilBot — 2 working, 1 needs you, routines paused')
  })
  test('menu: needs you first, working chats, then the usual items', () => {
    const did: string[] = []
    const a: TrayActions = {
      open: (id) => did.push(`open ${id}`), quickAsk: () => did.push('quick'), newChat: () => did.push('new'),
      setRoutinesPaused: (p) => did.push(`paused ${p}`), showMain: () => did.push('main'), settings: () => did.push('settings'), quit: () => did.push('quit')
    }
    const m = trayMenuTemplate({ working: [{ threadId: 'w1', label: 'Researcher' }], needsYou: [{ threadId: 'n1', label: 'Mailer' }, { threadId: 'n2', label: 'X' }], routinesPaused: false, quickKey: 'Alt+Space' }, a)
    const labels = m.map((i) => i.label ?? i.type)
    expect(labels).toEqual(['2 bots need you', 'separator', 'Working (1)', 'Researcher', 'separator', 'Quick Ask', 'New Chat', 'separator', 'Pause All Routines', 'separator', 'Open SahilBot', 'Settings…', 'separator', 'Quit SahilBot'])
    const click = (label: string): void => (m.find((i) => i.label === label)!.click as () => void)()
    click('2 bots need you'); click('Researcher'); click('Pause All Routines'); click('Quit SahilBot')
    expect(did).toEqual(['open n1', 'open w1', 'paused true', 'quit'])
    expect(m.find((i) => i.label === 'Quick Ask')).toMatchObject({ accelerator: 'Alt+Space', registerAccelerator: false })
    const idle = trayMenuTemplate({ working: [], needsYou: [], routinesPaused: true, quickKey: '' }, a)
    expect(idle[0].label).toBe('Quick Ask')
    expect(idle.some((i) => i.label === 'Resume Routines')).toBe(true)
  })
  test('glyph: hat and face inked, eyes and corners clear', () => {
    expect(glyphInk(8, 4)).toBe(true) // dome
    expect(glyphInk(2, 6.9)).toBe(true) // brim
    expect(glyphInk(8, 13.5)).toBe(true) // face
    expect(glyphInk(6.2, 11.6)).toBe(false) // eye
    expect(glyphInk(0.5, 15.5)).toBe(false)
    const px = glyphPixels(32)
    expect(px.length).toBe(32 * 32 * 4)
    expect(px[(4 * 32 + 1) * 4 + 3]).toBe(0)
    expect(px[(8 * 32 + 16) * 4 + 3]).toBe(255)
    expect(px.filter((_, i) => i % 4 !== 3).every((v) => v === 0)).toBe(true) // black only: a template image
  })
  test('PNG: valid signature, header, CRCs and pixel data', () => {
    expect(crc32(Buffer.from('IEND'))).toBe(0xae426082)
    const px = glyphPixels(16)
    const png = encodePng(16, 16, px)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png.toString('ascii', 12, 16)).toBe('IHDR')
    expect([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]]).toEqual([16, 16, 8, 6])
    expect(png.readUInt32BE(29)).toBe(crc32(png.subarray(12, 29)))
    const idatLen = png.readUInt32BE(33)
    const raw = inflateSync(png.subarray(41, 41 + idatLen))
    expect(raw.length).toBe((16 * 4 + 1) * 16)
    expect(raw[0]).toBe(0)
    expect([...raw.subarray(1, 65)]).toEqual([...px.subarray(0, 64)])
    expect(png.toString('ascii', png.length - 8, png.length - 4)).toBe('IEND')
  })
})
