// Read state: what counts as read and unread (in the shared rules and in the database's SQL, which must
// agree), which chats get the NEW divider (bots and agent chats, never plain chat-mode ones), and where the
// divider goes, including in long chats where only the latest window of blocks is mounted.
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { parseHTML } from 'linkedom'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Message } from '@shared/types'
import { countLabel, countsAsUnread, dividerKind, firstUnread, newestReplyAt, UNREAD_CAP, unreadCount } from '@shared/read-state'
import { Db, ensureReadColumns } from '../../src/main/db'

type TV = typeof import('../../src/renderer/src/components/ThreadView')
let tv: TV

beforeAll(async () => {
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
  const g = globalThis as Record<string, unknown>
  g.window = Object.assign(window, { foreman: {} })
  g.document = document
  g.navigator ??= { clipboard: { writeText: async () => undefined } }
  tv = await import('../../src/renderer/src/components/ThreadView')
})

const T0 = Date.UTC(2026, 10, 1, 9)
let n = 0
const msg = (p: Partial<Message>): Message => ({ id: `m${++n}`, threadId: 't1', role: 'assistant', content: '', kind: 'normal', status: 'done', createdAt: T0 + n * 1000, ...p })
const actions = { onRetry: () => undefined, onEditLast: () => undefined, onRespond: () => undefined, onReact: () => undefined, onReply: () => undefined, onOpenFile: () => undefined }

describe('what counts as unread', () => {
  it('only the bot\'s own visible replies', () => {
    expect(countsAsUnread(msg({ content: 'Here you go.' }))).toBe(true)
    // Your own words, tool results, empty tool-call turns and system lines never count.
    expect(countsAsUnread(msg({ role: 'user', content: 'hi' }))).toBe(false)
    expect(countsAsUnread(msg({ role: 'tool', content: 'ok' }))).toBe(false)
    expect(countsAsUnread(msg({ content: '', toolCalls: [{ id: 'c', name: 'web_search', arguments: '{}' }] }))).toBe(false)
    expect(countsAsUnread(msg({ kind: 'notice', content: 'Routine started' }))).toBe(false)
    expect(countsAsUnread(msg({ kind: 'compacted', content: 'Summary' }))).toBe(false)
    // Hidden instructions, superseded drafts and routine notices.
    expect(countsAsUnread(msg({ content: 'x', meta: { hidden: true } }))).toBe(false)
    expect(countsAsUnread(msg({ content: 'x', meta: { superseded: true } }))).toBe(false)
    expect(countsAsUnread(msg({ content: 'x', meta: { routineNotice: 'started' } }))).toBe(false)
    // A reply still streaming counts (you can see it arriving).
    expect(countsAsUnread(msg({ content: 'Working on', status: 'streaming' }))).toBe(true)
  })

  it('counts, the first unread and the newest reply, against a read mark', () => {
    const ms = [msg({ role: 'user', content: 'q' }), msg({ content: 'a1' }), msg({ kind: 'notice', content: 'n' }), msg({ content: 'a2' }), msg({ role: 'user', content: 'q2' })]
    const mark = ms[0].createdAt
    expect(unreadCount(ms, mark)).toBe(2)
    expect(firstUnread(ms, mark)?.content).toBe('a1')
    expect(unreadCount(ms, ms[1].createdAt)).toBe(1)
    expect(firstUnread(ms, ms[3].createdAt)).toBeUndefined()
    expect(newestReplyAt(ms)).toBe(ms[3].createdAt)
    expect(newestReplyAt([msg({ role: 'user', content: 'x' })])).toBe(0)
    expect(unreadCount(Array.from({ length: 150 }, () => msg({ content: 'r' })), 0)).toBe(UNREAD_CAP)
  })

  it('the sidebar count shows from two, caps at 99+', () => {
    expect(countLabel(undefined)).toBe('')
    expect(countLabel(1)).toBe('')
    expect(countLabel(2)).toBe('2')
    expect(countLabel(99)).toBe('99+')
  })
})

describe('read state in the database', () => {
  function setup() {
    const db = new Db(':memory:')
    const main = db.createSpace('SahilBot', '#1F1F1F', { isMain: true, shape: 'mascot' })
    const bot = db.createSpace('Scout', '#3366ff')
    return { db, main, bot }
  }
  const at = (db: Db, threadId: string, p: Partial<Message> & { createdAt: number }): Message =>
    db.insertMessage({ threadId, role: 'assistant', content: '', kind: 'normal', status: 'done', ...p })
  /** A chat opened (and read) a minute ago, so its replies can be timed in the past. */
  const fresh = (db: Db, spaceId: string) => {
    const t = db.createThread(spaceId, 'auto', null)
    const past = Date.now() - 60_000
    db.sql.prepare('UPDATE threads SET created_at = ?, updated_at = ?, last_read_at = ? WHERE id = ?').run(past, past, past, t.id)
    return db.getThread(t.id)!
  }

  it('a new chat starts read; replies after the mark are unread; the SQL agrees with the shared rule', () => {
    const { db, bot } = setup()
    const t = db.createThread(bot.id, 'auto', null)
    expect(t).toMatchObject({ unread: false, unreadCount: 0 })
    expect(t.lastReadAt).toBeGreaterThan(0)
    const base = t.lastReadAt! + 10
    at(db, t.id, { role: 'user', content: 'go', createdAt: base })
    at(db, t.id, { content: '', toolCalls: [{ id: 'c1', name: 'web_search', arguments: '{}' }], createdAt: base + 1 })
    at(db, t.id, { role: 'tool', toolCallId: 'c1', content: 'ok', createdAt: base + 2 })
    at(db, t.id, { content: 'First finding', createdAt: base + 3 })
    at(db, t.id, { kind: 'notice', content: 'Routine finished', createdAt: base + 4 })
    at(db, t.id, { content: 'draft', meta: { superseded: true }, createdAt: base + 5 })
    at(db, t.id, { content: 'hidden', meta: { hidden: true }, createdAt: base + 6 })
    at(db, t.id, { content: 'Routine notice', meta: { routineNotice: 'started' }, createdAt: base + 7 })
    at(db, t.id, { content: 'Second finding', createdAt: base + 8 })
    const got = db.getThread(t.id)!
    expect(got.unreadCount).toBe(unreadCount(db.listMessages(t.id), t.lastReadAt!))
    expect(got).toMatchObject({ unread: true, unreadCount: 2 })
    // The bot's sidebar row: the sum over its chats.
    expect(db.listSpaces().find((s) => s.id === bot.id)).toMatchObject({ unread: true, unreadCount: 2 })
  })

  it('markRead moves forward only, up to what you saw, and is idempotent', () => {
    const { db, bot } = setup()
    const t = fresh(db, bot.id)
    const a = at(db, t.id, { content: 'one', createdAt: t.lastReadAt! + 100 })
    const b = at(db, t.id, { content: 'two', createdAt: t.lastReadAt! + 200 })
    // Seen up to the first reply only (the second hadn't reached the screen yet).
    let r = db.markRead(t.id, a.createdAt)
    expect(r).toMatchObject({ unread: true, unreadCount: 1, lastReadAt: a.createdAt })
    // A slower device reporting an older mark changes nothing.
    r = db.markRead(t.id, a.createdAt - 50)
    expect(r.lastReadAt).toBe(a.createdAt)
    r = db.markRead(t.id, b.createdAt)
    expect(r).toMatchObject({ unread: false, unreadCount: 0, lastReadAt: b.createdAt })
    expect(db.markRead(t.id, b.createdAt)).toEqual(r)
    // Never past now (a clock running ahead can't read the future).
    expect(db.markRead(t.id, Date.now() + 3_600_000).lastReadAt!).toBeLessThanOrEqual(Date.now())
    expect(() => db.markRead('nope')).toThrow()
  })

  it('the "marked unread" flag: set by runs and Mark as Unread, cleared by reading', () => {
    const { db, bot } = setup()
    const t = fresh(db, bot.id)
    const reply = at(db, t.id, { content: 'Done.', createdAt: t.lastReadAt! + 100 })
    db.markRead(t.id)
    // A run ending sets the flag without new replies: unread, but nothing to count.
    expect(db.updateThread(t.id, { unread: true }, true)).toMatchObject({ unread: true, unreadCount: 0 })
    // Other updates keep the flag as it is (they don't copy the derived value back).
    expect(db.updateThread(t.id, { title: 'Scout' }).unread).toBe(true)
    expect(db.updateThread(t.id, { unread: false })).toMatchObject({ unread: false, unreadCount: 0 })
    // Mark as Unread: the read mark goes back to just before the latest reply, so the chat opens on its divider.
    const m = db.markUnread(t.id)
    expect(m).toMatchObject({ unread: true, unreadCount: 1, lastReadAt: reply.createdAt - 1 })
    expect(db.markRead(t.id)).toMatchObject({ unread: false, unreadCount: 0 })
  })

  it("a bot's helper threads never make it unread; plain chats count for the main bot's dot", () => {
    const { db, main, bot } = setup()
    const top = db.createThread(bot.id, 'auto', null)
    const helper = db.createThread(bot.id, 'auto', null, top.id)
    at(db, helper.id, { content: 'helper result', createdAt: helper.lastReadAt! + 50 })
    db.updateThread(helper.id, { unread: true })
    expect(db.listSpaces().find((s) => s.id === bot.id)).toMatchObject({ unread: false, unreadCount: 0 })
    const chat = db.createThread(main.id, 'auto', null)
    at(db, chat.id, { content: 'hello', createdAt: chat.lastReadAt! + 50 })
    expect(db.listSpaces().find((s) => s.id === main.id)?.unread).toBe(true)
    expect(db.listThreads(main.id)[0]).toMatchObject({ id: chat.id, unread: true, unreadCount: 1 })
  })

  it('tool mode comes from the agent state', () => {
    const { db, bot } = setup()
    const t = db.createThread(bot.id, 'auto', null)
    expect(db.getThread(t.id)!.toolMode).toBeUndefined()
    db.setState(t.id, { ...db.getState(t.id), toolMode: 'chat' })
    expect(db.getThread(t.id)!.toolMode).toBe('chat')
    db.setState(t.id, { ...db.getState(t.id), toolMode: 'quick' })
    expect(db.getThread(t.id)!.toolMode).toBe('chat')
    db.setState(t.id, { ...db.getState(t.id), toolMode: 'full' })
    expect(db.listThreads(bot.id)[0].toolMode).toBe('full')
  })

  it('the migration is idempotent and fills in sensible marks for existing chats', () => {
    const { db, bot } = setup()
    const read = db.createThread(bot.id, 'auto', null)
    const unread = db.createThread(bot.id, 'auto', null)
    const u = at(db, unread.id, { role: 'user', content: 'question', createdAt: unread.createdAt + 10 })
    at(db, unread.id, { content: 'answer you missed', createdAt: unread.createdAt + 20 })
    at(db, read.id, { content: 'answer you saw', createdAt: read.createdAt + 20 })
    db.sql.prepare('UPDATE threads SET unread = 1 WHERE id = ?').run(unread.id)
    // An older database: no column, no index.
    db.sql.exec('DROP INDEX messages_thread_at; ALTER TABLE threads DROP COLUMN last_read_at')
    ensureReadColumns(db.sql)
    ensureReadColumns(db.sql)
    expect(db.getThread(read.id)).toMatchObject({ unread: false, unreadCount: 0 })
    expect(db.getThread(unread.id)).toMatchObject({ unread: true, unreadCount: 1, lastReadAt: u.createdAt })
    const idx = db.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'messages_thread_at'").all()
    expect(idx).toHaveLength(1)
  })
})

describe('which chats get the NEW divider', () => {
  const tools = [msg({ role: 'user', content: 'q' }), msg({ toolCalls: [{ id: 'c', name: 'file_write', arguments: '{}' }] }), msg({ content: 'done' })]
  const talk = [msg({ role: 'user', content: 'hi' }), msg({ content: 'hello!' })]
  it('bots and groups, always', () => {
    expect(dividerKind({ space: { kind: 'bot', isMain: false }, thread: { toolMode: 'chat' }, messages: talk })).toBe('bot')
    expect(dividerKind({ space: { kind: 'group', isMain: false }, thread: {}, messages: talk })).toBe('bot')
  })
  it('agent chats: the full agent path ran, or an older chat (no mode saved) ran tools', () => {
    expect(dividerKind({ space: { kind: 'bot', isMain: true }, thread: { toolMode: 'full' }, messages: talk })).toBe('agent')
    expect(dividerKind({ space: { kind: 'project', isMain: false }, thread: { toolMode: 'full' }, messages: talk })).toBe('agent')
    expect(dividerKind({ space: { kind: 'bot', isMain: true }, thread: {}, messages: tools })).toBe('agent')
  })
  it('never a plain chat-mode conversation, even one that looked something up', () => {
    expect(dividerKind({ space: { kind: 'bot', isMain: true }, thread: { toolMode: 'chat' }, messages: talk })).toBeNull()
    expect(dividerKind({ space: { kind: 'bot', isMain: true }, thread: { toolMode: 'chat' }, messages: tools })).toBeNull()
    expect(dividerKind({ space: { kind: 'bot', isMain: true }, thread: {}, messages: talk })).toBeNull()
    expect(dividerKind({ space: { kind: 'project', isMain: false }, thread: {}, messages: talk })).toBeNull()
  })
})

describe('where the NEW divider goes', () => {
  it('before the first unread reply, over the steps that led to it, never above your message', () => {
    const q = msg({ role: 'user', content: 'Check the site' })
    const work = msg({ toolCalls: [{ id: 'w1', name: 'web_search', arguments: '{}' }] })
    const res = msg({ role: 'tool', toolCallId: 'w1', content: 'ok' })
    const reply = msg({ content: 'All good.' })
    const later = msg({ content: 'One more thing.' })
    const ms = [q, work, res, reply, later]
    const bs = tv.blocks(ms)
    expect(bs.map((b) => b.kind)).toEqual(['user', 'activity', 'text', 'text'])
    // Read up to your question: the divider starts at the work the bot did after it.
    expect(tv.dividerBlock(bs, reply, q.createdAt)).toBe(1)
    // Read up to the first reply: only the later one is new.
    expect(tv.dividerBlock(bs, later, reply.createdAt)).toBe(3)
    // Never above your own message, even with an old mark.
    expect(tv.dividerBlock(bs, reply, 0)).toBe(1)
    expect(tv.dividerBlock(bs, { id: 'gone', createdAt: Number.MAX_SAFE_INTEGER }, 0)).toBe(-1)
  })

  it('renders once in a short chat, and not at all without a read mark', () => {
    const ms = [msg({ role: 'user', content: 'hi' }), msg({ content: 'seen' }), msg({ content: 'NEWREPLY' })]
    const html = renderToString(createElement(tv.ThreadView, { messages: ms, running: false, pending: [], actions, ready: true, unreadAfter: ms[1].createdAt }))
    expect((html.match(/data-testid="new-divider"/g) ?? []).length).toBe(1)
    expect(html.indexOf('new-divider')).toBeGreaterThan(html.indexOf('seen'))
    expect(html.indexOf('new-divider')).toBeLessThan(html.indexOf('NEWREPLY'))
    // Plain chats (App passes no mark), nothing unread, or messages not loaded yet: no divider.
    for (const props of [{ unreadAfter: null }, { unreadAfter: ms[2].createdAt }, { unreadAfter: ms[1].createdAt, ready: false }]) {
      const h = renderToString(createElement(tv.ThreadView, { messages: ms, running: false, pending: [], actions, ready: true, ...props }))
      expect(h).not.toContain('new-divider')
    }
  })

  it('long chats: an unread reply older than the mounted window grows the window to include it', () => {
    const ms: Message[] = []
    for (let i = 0; i < 200; i++) ms.push(msg({ role: 'user', content: `Q${i}` }), msg({ content: `Reply ${i}` }))
    const bs = tv.blocks(ms)
    expect(bs).toHaveLength(400)
    // Read up to reply 49: replies 50…199 are new, 300 blocks back from the end, beyond WINDOW (120).
    const mark = ms[99].createdAt
    const first = firstUnread(ms, mark)!
    const at = tv.dividerBlock(bs, first, mark)
    expect(at).toBe(101)
    expect(tv.windowLimit(tv.WINDOW, bs.length, at)).toBe(bs.length - at + tv.DIVIDER_CONTEXT)
    expect(tv.windowLimit(tv.WINDOW, bs.length, -1)).toBe(tv.WINDOW)
    expect(tv.windowLimit(tv.WINDOW, bs.length, 390)).toBe(tv.WINDOW)
    const html = renderToString(createElement(tv.ThreadView, { messages: ms, running: false, pending: [], actions, ready: true, unreadAfter: mark }))
    expect(html).toContain('data-testid="new-divider"')
    expect(html).toContain('Reply 50<')
    // A little context above it, not the whole history.
    expect(html).toContain('Reply 49<')
    expect(html).not.toContain('Reply 10<')
    expect(html).toContain('data-testid="show-earlier"')
  })
})
