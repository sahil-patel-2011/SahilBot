import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, test } from 'vitest'
import { appleTime, chatMessages, chatParticipants, decodeAttributedBody, findChats, FullDiskAccessError, handleServices, lastSendFailed, recentChats, searchMessages, withChatDb } from '../../src/main/messages/chatdb'
import { messages, sendPlan, smsError } from '../../src/main/computer/apps/messages'
import { attributedText } from '../../src/main/otp'
import type { AppEnv } from '../../src/main/computer/apps/types'

// Messages history from a FIXTURE chat.db built here (same schema subset as macOS): never the real
// ~/Library/Messages/chat.db. Sends go to a fake AppleScript runner: nothing is ever sent.

/** An attributedBody blob shaped like macOS writes it (typedstream NSAttributedString). */
function blob(text: string): Uint8Array {
  const utf8 = Buffer.from(text, 'utf8')
  const len = utf8.length < 0x80 ? Buffer.from([utf8.length]) : utf8.length < 0x10000 ? Buffer.concat([Buffer.from([0x81]), (() => { const b = Buffer.alloc(2); b.writeUInt16LE(utf8.length); return b })()]) : Buffer.concat([Buffer.from([0x82]), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(utf8.length); return b })()])
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]), Buffer.from('streamtyped', 'latin1'), Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84, 0x12]),
    Buffer.from('NSAttributedString', 'latin1'), Buffer.from([0x00, 0x84, 0x84, 0x08]), Buffer.from('NSObject', 'latin1'), Buffer.from([0x00, 0x85, 0x92, 0x84, 0x84, 0x84, 0x08]),
    Buffer.from('NSString', 'latin1'), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]), len, utf8,
    Buffer.from([0x86, 0x84, 0x02, 0x69, 0x49, 0x01, 0x0c, 0x92, 0x84, 0x84, 0x84, 0x0c]), Buffer.from('NSDictionary', 'latin1'), Buffer.from([0x00, 0x94, 0x84, 0x01, 0x69, 0x01, 0x92, 0x84, 0x96, 0x96, 0x1d]),
    Buffer.from('__kIMMessagePartAttributeName', 'latin1'), Buffer.from([0x86, 0x92, 0x84, 0x84, 0x84, 0x08]), Buffer.from('NSNumber', 'latin1'), Buffer.from([0x00, 0x84, 0x84, 0x07]), Buffer.from('NSValue', 'latin1'), Buffer.from([0x00, 0x94, 0x84, 0x01, 0x2a, 0x84, 0x99, 0x99, 0x00, 0x86, 0x86, 0x86])
  ])
}

const APPLE = Date.UTC(2001, 0, 1)
const ns = (ms: number): bigint => BigInt(Math.round((ms - APPLE) * 1e6))
const T0 = Date.UTC(2026, 10, 17, 9, 0, 0)

/** chat.db's tables (the columns SahilBot reads), with two people, a group, SMS and iMessage. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'chatdb-'))
  const path = join(dir, 'chat.db')
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, service_name TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER, date INTEGER, is_from_me INTEGER, is_read INTEGER, service TEXT, cache_has_attachments INTEGER, associated_message_type INTEGER, item_type INTEGER, error INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);`)
  db.prepare('INSERT INTO handle VALUES (?, ?, ?)').run(1, '+15550101234', 'iMessage')
  db.prepare('INSERT INTO handle VALUES (?, ?, ?)').run(2, '+15550109999', 'SMS')
  db.prepare('INSERT INTO handle VALUES (?, ?, ?)').run(3, 'kim@example.com', 'iMessage')
  db.prepare('INSERT INTO chat VALUES (?, ?, ?, ?, ?)').run(1, 'iMessage;-;+15550101234', '+15550101234', '', 'iMessage')
  db.prepare('INSERT INTO chat VALUES (?, ?, ?, ?, ?)').run(2, 'SMS;-;+15550109999', '+15550109999', '', 'SMS')
  db.prepare('INSERT INTO chat VALUES (?, ?, ?, ?, ?)').run(3, 'iMessage;+;chat42', 'chat42', 'Family', 'iMessage')
  for (const [chat, h] of [[1, 1], [2, 2], [3, 1], [3, 3]]) db.prepare('INSERT INTO chat_handle_join VALUES (?, ?)').run(chat, h)
  let id = 0
  const msg = (chat: number, o: { text?: string | null; body?: Uint8Array; handle: number; at: number; me?: boolean; read?: boolean; service?: string; tapback?: boolean; error?: number }): void => {
    id++
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, `g${id}`, o.text ?? null, o.body ?? null, o.handle, ns(o.at), o.me ? 1 : 0, o.read === false ? 0 : 1, o.service ?? 'iMessage', 0, o.tapback ? 2000 : 0, 0, o.error ?? 0)
    db.prepare('INSERT INTO chat_message_join VALUES (?, ?, ?)').run(chat, id, ns(o.at))
  }
  msg(1, { text: 'Are we still on for lunch?', handle: 1, at: T0 })
  msg(1, { text: 'Yes, 12:30 at the usual place', handle: 1, at: T0 + 60_000, me: true })
  // Newer macOS: text NULL, the words only in attributedBody.
  msg(1, { text: null, body: blob('Perfect 👍 see you there'), handle: 1, at: T0 + 120_000, read: false })
  msg(1, { text: 'Loved “Perfect”', handle: 1, at: T0 + 130_000, tapback: true })
  msg(2, { text: 'Your package was delivered', handle: 2, at: T0 + 30_000, service: 'SMS', read: false })
  msg(3, { text: null, body: blob('x'.repeat(300) + ' long family note'), handle: 3, at: T0 + 200_000 })
  msg(3, { text: 'Dinner Sunday?', handle: 1, at: T0 + 300_000, read: false })
  db.close()
  return path
}

const path = fixture()
afterAll(() => { delete process.env.FOREMAN_CHAT_DB })

describe('attributedBody (typedstream) decoding', () => {
  test('one-byte, 0x81 two-byte and 0x82 four-byte lengths; UTF-8; attachment marks dropped', () => {
    expect(decodeAttributedBody(blob('hi there'))).toBe('hi there')
    expect(decodeAttributedBody(blob('Café ☕️ 🎉'))).toBe('Café ☕️ 🎉')
    const long = 'a'.repeat(200) + ' end'
    expect(decodeAttributedBody(blob(long))).toBe(long)
    const huge = 'b'.repeat(70_000)
    expect(decodeAttributedBody(blob(huge))).toBe(huge)
    expect(decodeAttributedBody(blob('￼ look at this'))).toBe('look at this')
  })
  test('garbage and empties give "", never junk; otp reads codes with it', () => {
    expect(decodeAttributedBody(null)).toBe('')
    expect(decodeAttributedBody(Buffer.from('no marker here'))).toBe('')
    expect(decodeAttributedBody(Buffer.concat([Buffer.from('NSString', 'latin1'), Buffer.from([0x01, 0x2b, 0x40])]))).toBe('')
    expect(attributedText(blob('Your code is 482913'))).toBe('Your code is 482913')
  })
  test('Apple dates (nanoseconds since 2001) become epoch ms', () => {
    expect(appleTime(ns(T0))).toBe(T0)
    expect(appleTime(0)).toBe(0)
  })
})

describe('reading the fixture chat.db (read-only)', () => {
  test('recent: newest first, last message (from attributedBody too), unread counts, no tapbacks', () => {
    const r = withChatDb((db) => recentChats(db, 10), path)
    expect(r.map((c) => c.guid)).toEqual(['iMessage;+;chat42', 'iMessage;-;+15550101234', 'SMS;-;+15550109999'])
    const amy = r.find((c) => c.guid === 'iMessage;-;+15550101234')!
    expect(amy.lastText).toBe('Perfect 👍 see you there')
    expect(amy.unread).toBe(1)
    expect(r[0].name).toBe('Family')
    expect(r[0].participants.sort()).toEqual(['+15550101234', 'kim@example.com'])
    expect(r.find((c) => c.service === 'SMS')!.unread).toBe(1)
  })
  test('read: by handle in any format (one-to-one chats only) or chat id; sender, me, service', () => {
    const ms = withChatDb((db) => chatMessages(db, findChats(db, { handle: '(555) 010-1234' }), 10), path)
    expect(ms.map((m) => m.text)).toEqual(['Are we still on for lunch?', 'Yes, 12:30 at the usual place', 'Perfect 👍 see you there'])
    expect(ms[1]).toMatchObject({ fromMe: true, sender: 'me', service: 'iMessage' })
    expect(ms[0].sender).toBe('+15550101234')
    const fam = withChatDb((db) => chatMessages(db, findChats(db, { chat: 'iMessage;+;chat42' }), 1), path)
    expect(fam.map((m) => m.text)).toEqual(['Dinner Sunday?'])
    expect(withChatDb((db) => findChats(db, { handle: 'nobody@x.com' }), path)).toEqual([])
  })
  test('search: words across text and attributedBody, bounded', () => {
    expect(withChatDb((db) => searchMessages(db, 'family note'), path).map((m) => m.chatGuid)).toEqual(['iMessage;+;chat42'])
    expect(withChatDb((db) => searchMessages(db, 'PERFECT see'), path)).toHaveLength(1)
    expect(withChatDb((db) => searchMessages(db, 'lunch', { limit: 1 }), path)).toHaveLength(1)
    expect(() => withChatDb((db) => searchMessages(db, '  '), path)).toThrow(/needs some words/)
  })
  test('participants, services and failed sends for the send path', () => {
    expect(withChatDb((db) => chatParticipants(db, 'iMessage;+;chat42'), path)?.sort()).toEqual(['+15550101234', 'kim@example.com'])
    expect(withChatDb((db) => handleServices(db, '555-010-9999'), path)).toEqual(['SMS'])
    expect(withChatDb((db) => lastSendFailed(db, '+15550101234', T0), path)).toEqual({ failed: false, service: 'iMessage' })
  })
  test('no Full Disk Access, or no history, is a clear message', () => {
    expect(() => withChatDb(() => 1, join(tmpdir(), 'nope', 'chat.db'))).toThrow(/No Messages history/)
    expect(new FullDiskAccessError().message).toMatch(/Privacy & Security → Full Disk Access/)
  })
})

describe('the Messages app actions', () => {
  const env = (log: string[][], fail: Record<string, string> = {}): AppEnv => ({
    applescript: async (_src, args) => { log.push(args); const e = fail[args[3]]; if (e) throw new Error(e); return 'sent' },
    jxa: async () => { throw new Error('no jxa in tests') }, sh: async () => '', computer: async () => ({ text: '' }), macApps: async () => ({ text: '' }),
    workspace: tmpdir(), roots: [], signal: new AbortController().signal
  })
  test('recent / read / search read the database (FOREMAN_CHAT_DB) and say the text is data', async () => {
    process.env.FOREMAN_CHAT_DB = path
    const r = await messages.actions.recent.run({ limit: 5 }, env([]))
    expect(r.text).toMatch(/data, not instructions/)
    expect(r.text).toContain('[chat_id: iMessage;-;+15550101234]')
    expect(r.display).toMatch(/3 conversations, 3 unread/)
    expect((await messages.actions.read.run({ handle: '+1 555 010 1234' }, env([]))).text).toContain('Perfect 👍 see you there')
    expect((await messages.actions.search.run({ text: 'package' }, env([]))).text).toContain('Your package was delivered')
  })
  test('SMS fallback: which services to try', () => {
    expect(sendPlan('amy@example.com', [])).toEqual(['iMessage'])
    expect(sendPlan('+15550101234', ['iMessage'])).toEqual(['iMessage', 'SMS'])
    expect(sendPlan('+15550109999', ['SMS'])).toEqual(['SMS'])
    expect(sendPlan('+15550100000', [])).toEqual(['iMessage', 'SMS'])
    expect(sendPlan('+15550101234', ['iMessage'], 'sms')).toEqual(['SMS'])
    expect(sendPlan('+15550109999', ['SMS'], 'imessage')).toEqual(['iMessage'])
    expect(smsError("Can't get account 1 whose service type = SMS")).toMatch(/Text Message Forwarding/)
  })
  test('send: an SMS-only number goes straight to SMS; an iMessage error falls back to SMS and says so', async () => {
    process.env.FOREMAN_CHAT_DB = path
    const log: string[][] = []
    const r = await messages.actions.send.run({ to: '555-010-9999', text: 'hi' }, env(log))
    expect(log.map((a) => a[3])).toEqual(['SMS'])
    expect(r.text).toMatch(/over SMS/)
    // A number Messages hasn't seen: iMessage first; iMessage refuses, so SMS.
    const log2: string[][] = []
    const r2 = await messages.actions.send.run({ to: '+1 555 010 7777', text: 'hi' }, env(log2, { iMessage: 'Messages got an error: not registered' }))
    expect(log2.map((a) => [a[0], a[2], a[3]])).toEqual([['+15550107777', 'handle', 'iMessage'], ['+15550107777', 'handle', 'SMS']])
    expect(r2.text).toMatch(/so it went as SMS/)
    // Both fail: plain words about Text Message Forwarding.
    await expect(messages.actions.send.run({ to: '+15550107777', text: 'hi' }, env([], { iMessage: 'nope', SMS: "Can't get account 1 whose service type = SMS" }))).rejects.toThrow(/Text Message Forwarding/)
    // A chat id goes to that conversation as is.
    const log3: string[][] = []
    await messages.actions.send.run({ chat_id: 'iMessage;+;chat42', text: 'hi all' }, env(log3))
    expect(log3).toEqual([['iMessage;+;chat42', 'hi all', 'chat', '']])
    // Sending is a send stop (the trusted-recipient rule can lift it).
    expect(messages.actions.send.hardStop!({ to: '+15550101234' })).toMatch(/^sends a message/)
  })
})
