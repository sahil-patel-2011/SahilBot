import { expect, test } from 'vitest'
import { calendarItems } from '../../src/main/brain/sources'
import { Connectors } from '../../src/main/connectors'
import { calendarRange, formatEvents, macAppsTool, type MacEvent } from '../../src/main/agent/tools/apps'
import type { ToolContext } from '../../src/main/agent/types'
import { Db } from '../../src/main/db'
import { Scheduler, eventKey, newestVersions } from '../../src/main/scheduler'
import { TRIGGER_DAILY_MAX } from '../../src/main/triggers'

// Connecting the right app, reading the Mac calendar right, and "when a meeting is added" routines that run once
// per meeting.

function memSecrets() {
  const m = new Map<string, string>()
  return { get: (k: string) => m.get(k), set: (k: string, v: string | null) => { if (v === null) m.delete(k); else m.set(k, v) } }
}
const connectors = (): Connectors => new Connectors({ getSetting: () => undefined, setSetting: () => undefined } as never, memSecrets() as never, { register: () => undefined, unregister: () => undefined } as never, () => undefined)

test('connect_app picks the Google app named, not the first Google app in the catalog', () => {
  const c = connectors()
  expect(c.suggest('Google Drive')[0].id).toBe('gdrive')
  expect(c.suggest('Google Calendar')[0].id).toBe('gcal')
  expect(c.suggest('Google Sheets')[0].id).toBe('gsheets')
  expect(c.suggest('Gmail')[0].id).toBe('gmail')
  expect(c.suggest('connect my google drive please')[0].id).toBe('gdrive')
})

test('calendar_events reads from the start of today (events in progress count), or the exact day asked for', () => {
  const now = new Date(2026, 10, 24, 15, 30)
  const r = calendarRange({}, now)
  expect(r.from).toEqual(new Date(2026, 10, 24))
  expect(r.to).toEqual(new Date(2026, 11, 1))
  const tomorrow = calendarRange({ from: '2026-11-25', to: '2026-11-25' }, now)
  expect(tomorrow.from).toEqual(new Date(2026, 10, 25))
  expect(tomorrow.to).toEqual(new Date(2026, 10, 26))
  expect(calendarRange({ from: '2026-11-25' }, now).to).toEqual(new Date(2026, 10, 26))
})

test('calendar_events: the user\'s own events are not outside content; an invite is', async () => {
  const own: MacEvent[] = [{ cal: 'Home', title: 'Run', start: '2026-11-25T11:00:00.000Z', end: '2026-11-25T12:00:00.000Z', where: '' }]
  const calls: Array<{ input: unknown; timeout?: number }> = []
  let events = own
  const tool = macAppsTool({ jxa: async (_fn, input, _s, timeout) => { calls.push({ input, timeout }); return { via: 'eventkit', events } } })
  expect(tool.untrusted).toBeFalsy()
  const ctx = { signal: new AbortController().signal } as unknown as ToolContext
  const a = await tool.run({ action: 'calendar_events', from: '2026-11-25', to: '2026-11-25' }, ctx)
  expect(a.untrusted).toBeFalsy()
  expect(a.text).toMatch(/Run \[Home\]/)
  // The first read can wait on macOS's permission dialog.
  expect(calls[0].timeout).toBeGreaterThanOrEqual(60_000)
  events = [...own, { cal: 'Work', title: 'Standup', start: '2026-11-25T14:00:00.000Z', end: '2026-11-25T14:15:00.000Z', where: 'Zoom', others: true }]
  const b = await tool.run({ action: 'calendar_events' }, ctx)
  expect(b.untrusted).toBe(true)
  expect(b.text).toMatch(/Standup @ Zoom \[Work\] \(invite\)/)
  // Reminders are the user's own too.
  const rem = macAppsTool({ jxa: async () => [] })
  expect((await rem.run({ action: 'reminders_list' }, ctx)).untrusted).toBeFalsy()
  expect(formatEvents([], { from: new Date(2026, 10, 25), to: new Date(2026, 10, 26) }, 'calendar')).toMatch(/can miss repeating events/)
})

test('an edited or RSVP\'d calendar event does not set off a "when a meeting is added" routine again', async () => {
  const db = new Db(':memory:')
  const space = db.createSpace('Assistant', '#000')
  const ran: string[] = []
  const s = new Scheduler(db, async (t) => { ran.push(t.title); return 'done' }, () => undefined)
  const t = s.create({ title: 'Prep meetings', prompt: 'Make a prep note', schedule: { type: 'when', kind: 'calendar' }, spaceId: space.id })
  const ev = (updated: string, created: string): string => JSON.stringify({ items: [{ id: 'evt1', summary: 'Design review', start: { dateTime: '2026-12-01T15:00:00Z' }, created, updated }] })
  const later = new Date(t.createdAt + 60_000).toISOString()
  const first = calendarItems('gcal', ev(later, later))
  expect(first[0].created).toBe(t.createdAt + 60_000)
  expect(s.onItems(first)).toEqual([t.id])
  await expect.poll(() => s.isRunning(t.id)).toBe(false)
  // An attendee accepts: same event, new version.
  const edited = calendarItems('gcal', ev(new Date(t.createdAt + 120_000).toISOString(), later))
  expect(edited[0].id).not.toBe(first[0].id)
  expect(eventKey(edited[0])).toBe(eventKey(first[0]))
  expect(s.onItems(edited)).toEqual([])
  // An event made before the routine existed, edited after: not "added".
  const old = new Date(t.createdAt - 86_400_000).toISOString()
  expect(s.onItems(calendarItems('gcal', JSON.stringify({ items: [{ id: 'evt0', summary: 'Old sync', start: { dateTime: '2026-12-02T15:00:00Z' }, created: old, updated: later }] })))).toEqual([])
  expect(ran).toEqual(['Prep meetings'])
})

test('matches waiting for a busy routine survive a restart', async () => {
  const db = new Db(':memory:')
  const space = db.createSpace('Books', '#000')
  let release!: () => void
  const s = new Scheduler(db, () => new Promise((r) => { release = () => r('done') }), () => undefined)
  const t = s.create({ title: 'Orders', prompt: 'Log it', schedule: { type: 'when', kind: 'email', contains: 'order' }, spaceId: space.id })
  const mail = (title: string) => ({ source: 'gmail', id: title, kind: 'email', at: t.createdAt + 1000, title, from: 'shop@x.com', text: '' })
  expect(s.onItems([mail('Order 1')])).toEqual([t.id])
  expect(s.onItems([mail('Order 2')])).toEqual([])
  // SahilBot quits before the first run ends: the waiting match is still there next time.
  const ran: string[] = []
  const s2 = new Scheduler(db, async (_t, info) => { ran.push(info.event?.note ?? ''); return 'done' }, () => undefined)
  s2.start(60_000)
  await expect.poll(() => ran.length).toBe(1)
  expect(ran[0]).toContain('Order 2')
  s2.stop()
  release()
  // Ran: the saved queue is cleared.
  expect(Object.keys(db.getSetting<Record<string, unknown>>('triggerQueue') ?? {})).toEqual([])
})

test('calendar matches over the daily limit wait for the next day instead of being lost', async () => {
  const db = new Db(':memory:')
  const space = db.createSpace('Assistant', '#000')
  const notes: string[] = []
  let now = new Date()
  const s = new Scheduler(db, async (_t, info) => { notes.push(info.event?.note ?? ''); return 'done' }, () => undefined, () => now)
  const t = s.create({ title: 'Prep meetings', prompt: 'Make a prep note', schedule: { type: 'when', kind: 'calendar' }, spaceId: space.id })
  const at = new Date(t.createdAt + 60_000).toISOString()
  const ev = (i: number) => calendarItems('gcal', JSON.stringify({ items: [{ id: `evt${i}`, summary: `Meeting ${i}`, start: { dateTime: '2026-12-01T15:00:00Z' }, created: at, updated: at }] }))
  for (let i = 0; i < TRIGGER_DAILY_MAX + 1; i++) { s.onItems(ev(i)); await expect.poll(() => s.isRunning(t.id)).toBe(false) }
  expect(notes).toHaveLength(TRIGGER_DAILY_MAX)
  expect(s.get(t.id)!.lastStatus).toMatch(/ran 20 times today/)
  // The 21st meeting is marked seen (never handed over twice) but kept: the next day's first check runs it.
  now = new Date(Date.now() + 86_400_000)
  await s.tick()
  await expect.poll(() => notes.length).toBe(TRIGGER_DAILY_MAX + 1)
  expect(notes.at(-1)).toContain(`Meeting ${TRIGGER_DAILY_MAX}`)
})

test('two versions of one calendar event in one read go into a run once (the newest)', async () => {
  const db = new Db(':memory:')
  const space = db.createSpace('Assistant', '#000')
  const notes: Array<{ note: string; count: number }> = []
  const s = new Scheduler(db, async (_t, info) => { notes.push({ note: info.event?.note ?? '', count: info.event?.count ?? 0 }); return 'done' }, () => undefined)
  const t = s.create({ title: 'Prep meetings', prompt: 'Make a prep note', schedule: { type: 'when', kind: 'calendar' }, spaceId: space.id })
  const created = new Date(t.createdAt + 60_000).toISOString()
  const v1 = calendarItems('gcal', JSON.stringify({ items: [{ id: 'evt1', summary: 'Design review', start: { dateTime: '2026-12-01T15:00:00Z' }, created, updated: created }] }))
  const v2 = calendarItems('gcal', JSON.stringify({ items: [{ id: 'evt1', summary: 'Design review (moved)', start: { dateTime: '2026-12-01T16:00:00Z' }, created, updated: new Date(t.createdAt + 120_000).toISOString() }] }))
  expect(newestVersions([...v1, ...v2]).map((x) => x.title)).toEqual([v2[0].title])
  expect(s.onItems([...v1, ...v2])).toEqual([t.id])
  await expect.poll(() => notes.length).toBe(1)
  expect(notes[0].count).toBe(1)
  expect(notes[0].note).toContain('moved')
})
