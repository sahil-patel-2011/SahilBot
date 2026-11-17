import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileProbe } from '../permissions-center'
import { normalizeRecipient } from '../agent/trusted'

// Messages history, read-only, straight from ~/Library/Messages/chat.db (node:sqlite). Messages' scripting
// can't read message text, so this is how SahilBot reads texts: the latest conversations, one chat's
// messages, and a bounded text search. It needs Full Disk Access (macOS protects the file); without it
// every call says exactly where to turn it on. Nothing is ever written: the database is opened read-only,
// or, when SQLite can't open it in place (the WAL's shared memory belongs to Messages), a copy of the
// database and its -wal is read from a private temp folder and deleted right after.
//
// Message text is written by other people: the tools that show it mark their output untrusted.

export const CHAT_DB = join(homedir(), 'Library', 'Messages', 'chat.db')

export const FULL_DISK_ACCESS_HELP = 'SahilBot needs Full Disk Access to read your Messages history. Open System Settings → Privacy & Security → Full Disk Access, turn on SahilBot (add it with + if it isn\'t listed), then quit and reopen SahilBot.'

export class FullDiskAccessError extends Error {
  constructor() { super(FULL_DISK_ACCESS_HELP); this.name = 'FullDiskAccessError' }
}

/** Apple's Messages dates: nanoseconds (or seconds on old macOS) since 2001-01-01, to epoch ms. */
const APPLE_EPOCH = Date.UTC(2001, 0, 1)
export function appleTime(v: number | bigint | null | undefined): number {
  const n = Number(v ?? 0)
  if (!n) return 0
  return Math.round(APPLE_EPOCH + (n > 1e12 ? n / 1e6 : n * 1000))
}

// ------------------------------------------------------------------ attributedBody (typedstream NSAttributedString)

/**
 * The text of an attributedBody blob. Newer macOS keeps many messages only here (text is NULL): an archived
 * NSAttributedString in Apple's "typedstream" format. Its string is the first NSString after the class
 * chain: the class name, a few type bytes ending in '+' (a C string follows), then the length (one byte;
 * or 0x81 and a 2-byte little-endian length; or 0x82 and a 4-byte one) and the UTF-8 bytes. Attachment
 * placeholders (U+FFFC) are dropped. Anything that doesn't fit returns '' rather than garbage.
 */
export function decodeAttributedBody(blob: Uint8Array | null | undefined): string {
  if (!blob || !blob.length) return ''
  const b = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
  let from = 0
  // NSMutableString counts too (its name ends in "String"); the first string after either marker wins.
  for (let guard = 0; guard < 4; guard++) {
    const at = b.indexOf('NSString', from, 'latin1')
    if (at < 0) break
    let i = at + 8
    const plus = b.indexOf(0x2b, i)
    from = at + 8
    if (plus < 0 || plus - i > 12) continue
    i = plus + 1
    if (i >= b.length) break
    let len = b[i++]
    if (len === 0x81) { if (i + 2 > b.length) break; len = b.readUInt16LE(i); i += 2 }
    else if (len === 0x82) { if (i + 4 > b.length) break; len = b.readUInt32LE(i); i += 4 }
    else if (len > 0x80) continue
    if (len <= 0 || i + len > b.length) continue
    const text = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(i, i + len))
    return text.replace(/￼/g, '').replace(/\u0000/g, '').trim()
  }
  return ''
}

/** A message's text: the text column, else its attributedBody. */
export const messageText = (text: string | null | undefined, body: Uint8Array | null | undefined): string => (text && text.trim() ? text : decodeAttributedBody(body))

// ------------------------------------------------------------------ opening

type Db = InstanceType<typeof DatabaseSync>

const denied = (msg: string): boolean => /authori[sz]|not permitted|operation not permitted|EPERM|EACCES|permission denied/i.test(msg)

/**
 * Runs `fn` with chat.db open read-only, closed right after. Full Disk Access missing → FullDiskAccessError.
 * If SQLite can't read it in place, a private copy (database + WAL) is read instead and removed.
 */
export function withChatDb<T>(fn: (db: Db) => T, path = CHAT_DB): T {
  const probe = fileProbe(path)
  if (probe === 'denied') throw new FullDiskAccessError()
  if (probe === 'missing') throw new Error('No Messages history on this Mac (Messages has never been used here, or iCloud Messages hasn\'t synced yet).')
  let db: Db | null = null
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const out = fn(db)
    return out
  } catch (e) {
    const msg = (e as Error).message ?? ''
    if (denied(msg)) throw new FullDiskAccessError()
    // Locked or unopenable in place (WAL shared memory): read a private copy.
    if (!/unable to open|locked|busy|readonly|disk I\/O|SQLITE_CANTOPEN|malformed/i.test(msg)) throw e
  } finally {
    try { db?.close() } catch { /* closed */ }
  }
  const dir = mkdtempSync(join(tmpdir(), 'sahilbot-chatdb-'))
  try {
    const copy = join(dir, 'chat.db')
    try {
      copyFileSync(path, copy)
      for (const ext of ['-wal', '-shm']) if (existsSync(path + ext)) copyFileSync(path + ext, copy + ext)
    } catch (e) {
      if (denied((e as Error).message ?? '') || ['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw new FullDiskAccessError()
      throw e
    }
    const c = new DatabaseSync(copy)
    try { return fn(c) } finally { c.close() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------ queries

export interface ChatSummary {
  id: number
  /** The chat's guid, which Messages' scripting calls its id ("iMessage;-;+15551234567"): send with it. */
  guid: string
  name: string
  participants: string[]
  service: string
  lastText: string
  lastAt: number
  lastFromMe: boolean
  unread: number
}

export interface ChatMessage {
  id: number
  chatGuid?: string
  /** The other person's handle, or "me". */
  sender: string
  fromMe: boolean
  text: string
  at: number
  service: string
  attachments: number
}

/** Real messages only: no tapbacks or edits (associated_message_type), no group events (item_type). */
const REAL = `COALESCE(m.associated_message_type, 0) = 0 AND COALESCE(m.item_type, 0) = 0`

/**
 * A statement that reads integers as BigInt: Messages' dates (nanoseconds since 2001, ~8e17) are past
 * Number's exact range, and node:sqlite refuses to read them otherwise. Callers convert with Number().
 */
function q(db: Db, sql: string): ReturnType<Db['prepare']> {
  const st = db.prepare(sql)
  st.setReadBigInts(true)
  return st
}

function columns(db: Db, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name))
}

/** The query text with columns older macOS lacks replaced by defaults. */
function adapt(db: Db, sql: string): string {
  const m = columns(db, 'message')
  let s = sql
  if (!m.has('associated_message_type')) s = s.replace(/COALESCE\(m\.associated_message_type, 0\)/g, '0')
  if (!m.has('item_type')) s = s.replace(/COALESCE\(m\.item_type, 0\)/g, '0')
  if (!m.has('attributedBody')) s = s.replace(/m\.attributedBody/g, 'NULL')
  if (!m.has('cache_has_attachments')) s = s.replace(/m\.cache_has_attachments/g, '0')
  if (!m.has('is_read')) s = s.replace(/m\.is_read/g, '1')
  return s
}

function participantsOf(db: Db): Map<number, string[]> {
  const rows = q(db, 'SELECT chj.chat_id AS chat, h.id AS handle FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id').all() as Array<{ chat: number; handle: string }>
  const out = new Map<number, string[]>()
  for (const r of rows) out.set(Number(r.chat), [...(out.get(Number(r.chat)) ?? []), String(r.handle)])
  return out
}

/** The latest conversations, newest first, with their last message and how many are unread. */
export function recentChats(db: Db, limit = 20): ChatSummary[] {
  const n = Math.max(1, Math.min(100, Math.floor(limit) || 20))
  const rows = q(db, adapt(db, `
    WITH last AS (
      SELECT cmj.chat_id AS chat, MAX(m.date) AS at FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id
      WHERE ${REAL} GROUP BY cmj.chat_id
    )
    SELECT c.ROWID AS id, c.guid AS guid, COALESCE(c.display_name, '') AS name, COALESCE(c.service_name, '') AS service, last.at AS at,
      (SELECT m.text FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id WHERE j.chat_id = c.ROWID AND ${REAL} ORDER BY m.date DESC LIMIT 1) AS text,
      (SELECT m.attributedBody FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id WHERE j.chat_id = c.ROWID AND ${REAL} ORDER BY m.date DESC LIMIT 1) AS body,
      (SELECT m.is_from_me FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id WHERE j.chat_id = c.ROWID AND ${REAL} ORDER BY m.date DESC LIMIT 1) AS fromMe,
      (SELECT COUNT(*) FROM chat_message_join j JOIN message m ON m.ROWID = j.message_id WHERE j.chat_id = c.ROWID AND m.is_from_me = 0 AND m.is_read = 0 AND ${REAL}) AS unread
    FROM chat c JOIN last ON last.chat = c.ROWID
    ORDER BY last.at DESC LIMIT ?`)).all(n) as Array<{ id: number; guid: string; name: string; service: string; at: number | bigint; text: string | null; body: Uint8Array | null; fromMe: number; unread: number }>
  const people = participantsOf(db)
  return rows.map((r) => ({
    id: Number(r.id), guid: String(r.guid), name: r.name, participants: people.get(Number(r.id)) ?? [], service: r.service || 'iMessage',
    lastText: messageText(r.text, r.body), lastAt: appleTime(r.at), lastFromMe: !!r.fromMe, unread: Number(r.unread) || 0
  }))
}

/**
 * The chats a reference means: a chat guid or ROWID, or a phone/email handle (its one-to-one chats).
 * Handles match after normalizing ("(555) 010-1234" finds "+15550101234").
 */
export function findChats(db: Db, ref: { chat?: string; handle?: string }): number[] {
  if (ref.chat) {
    const c = String(ref.chat).trim()
    const row = (/^\d+$/.test(c) ? q(db, 'SELECT ROWID AS id FROM chat WHERE ROWID = ?').get(Number(c)) : q(db, 'SELECT ROWID AS id FROM chat WHERE guid = ? OR chat_identifier = ?').get(c, c)) as { id: number } | undefined
    return row ? [Number(row.id)] : []
  }
  const want = normalizeRecipient(ref.handle)
  if (!want) return []
  const handles = (q(db, 'SELECT ROWID AS id, id AS handle FROM handle').all() as Array<{ id: number; handle: string }>).filter((h) => normalizeRecipient(h.handle) === want).map((h) => Number(h.id))
  if (!handles.length) return []
  const people = participantsOf(db)
  const byHandle = q(db, `SELECT DISTINCT chat_id AS chat FROM chat_handle_join WHERE handle_id IN (${handles.map(() => '?').join(',')})`).all(...handles) as Array<{ chat: number }>
  // One-to-one conversations only: a group with this person isn't "the chat with them".
  return byHandle.map((r) => Number(r.chat)).filter((id) => (people.get(id)?.length ?? 0) <= 1)
}

/** One conversation's messages (several chats: a person's iMessage and SMS threads merged), newest N, oldest first. */
export function chatMessages(db: Db, chats: number[], limit = 30): ChatMessage[] {
  if (!chats.length) return []
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 30))
  const rows = q(db, adapt(db, `
    SELECT m.ROWID AS id, c.guid AS guid, m.text AS text, m.attributedBody AS body, m.date AS at, m.is_from_me AS fromMe,
      COALESCE(m.service, c.service_name, '') AS service, COALESCE(h.id, '') AS handle, m.cache_has_attachments AS att
    FROM chat_message_join cmj JOIN message m ON m.ROWID = cmj.message_id JOIN chat c ON c.ROWID = cmj.chat_id
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    WHERE cmj.chat_id IN (${chats.map(() => '?').join(',')}) AND ${REAL}
    ORDER BY m.date DESC LIMIT ?`)).all(...chats, n) as Array<{ id: number; guid: string; text: string | null; body: Uint8Array | null; at: number | bigint; fromMe: number; service: string; handle: string; att: number }>
  return rows.reverse().map((r) => ({
    id: Number(r.id), chatGuid: r.guid, sender: r.fromMe ? 'me' : r.handle || 'unknown', fromMe: !!r.fromMe,
    text: messageText(r.text, r.body), at: appleTime(r.at), service: r.service || 'iMessage', attachments: Number(r.att) || 0
  }))
}

/** Messages containing words (case-insensitive), newest first. Scans at most the newest `scan` messages (bodies may need decoding). */
export function searchMessages(db: Db, query: string, o: { limit?: number; scan?: number } = {}): ChatMessage[] {
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) throw new Error('search needs some words to look for.')
  const limit = Math.max(1, Math.min(50, Math.floor(o.limit ?? 20)))
  const scan = Math.max(100, Math.min(50_000, Math.floor(o.scan ?? 20_000)))
  const stmt = q(db, adapt(db, `
    SELECT m.ROWID AS id, c.guid AS guid, m.text AS text, m.attributedBody AS body, m.date AS at, m.is_from_me AS fromMe,
      COALESCE(m.service, '') AS service, COALESCE(h.id, '') AS handle, m.cache_has_attachments AS att
    FROM message m LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID LEFT JOIN chat c ON c.ROWID = cmj.chat_id
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    WHERE ${REAL} ORDER BY m.date DESC LIMIT ?`))
  const out: ChatMessage[] = []
  for (const r of stmt.iterate(scan) as Iterable<{ id: number; guid: string | null; text: string | null; body: Uint8Array | null; at: number | bigint; fromMe: number; service: string; handle: string; att: number }>) {
    const text = messageText(r.text, r.body)
    const low = text.toLowerCase()
    if (!words.every((w) => low.includes(w))) continue
    out.push({ id: Number(r.id), chatGuid: r.guid ?? undefined, sender: r.fromMe ? 'me' : r.handle || 'unknown', fromMe: !!r.fromMe, text, at: appleTime(r.at), service: r.service || 'iMessage', attachments: Number(r.att) || 0 })
    if (out.length >= limit) break
  }
  return out
}

/** The handles in one chat (by guid), for trusted-recipient checks on a group send. Null when unknown. */
export function chatParticipants(db: Db, guid: string): string[] | null {
  const row = q(db, 'SELECT ROWID AS id FROM chat WHERE guid = ? OR chat_identifier = ?').get(guid, guid) as { id: number } | undefined
  if (!row) return null
  return participantsOf(db).get(Number(row.id)) ?? null
}

/** Which services a handle has been reached on ('iMessage', 'SMS', 'RCS'), for choosing how to send. */
export function handleServices(db: Db, handle: string): string[] {
  const want = normalizeRecipient(handle)
  if (!want) return []
  const rows = q(db, 'SELECT id AS handle, COALESCE(service, \'\') AS service FROM handle').all() as Array<{ handle: string; service: string }>
  return [...new Set(rows.filter((r) => normalizeRecipient(r.handle) === want).map((r) => r.service).filter(Boolean))]
}

/** Whether the newest message sent to a handle since `sinceMs` failed (error set, not delivered): null when none is found. */
export function lastSendFailed(db: Db, handle: string, sinceMs: number): { failed: boolean; service: string } | null {
  const want = normalizeRecipient(handle)
  if (!want) return null
  const m = columns(db, 'message')
  const since = BigInt(Math.floor((sinceMs - APPLE_EPOCH) * 1e6))
  const rows = q(db, `SELECT h.id AS handle, ${m.has('error') ? 'm.error' : '0'} AS err, COALESCE(m.service, '') AS service FROM message m JOIN handle h ON h.ROWID = m.handle_id
    WHERE m.is_from_me = 1 AND m.date >= ? ORDER BY m.date DESC LIMIT 20`).all(since) as Array<{ handle: string; err: number; service: string }>
  const hit = rows.find((r) => normalizeRecipient(r.handle) === want)
  return hit ? { failed: Number(hit.err) !== 0, service: hit.service } : null
}

// ------------------------------------------------------------------ formatting

const stamp = (t: number): string => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const oneLine = (s: string, n: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t }

export function formatChats(chats: ChatSummary[]): string {
  if (!chats.length) return 'No conversations.'
  return chats.map((c) => `- ${c.name || c.participants.join(', ') || '(unnamed)'} [chat_id: ${c.guid}] · ${c.service}${c.unread ? ` · ${c.unread} unread` : ''}\n  ${stamp(c.lastAt)} ${c.lastFromMe ? 'me' : 'them'}: ${oneLine(c.lastText || '(attachment)', 160)}`).join('\n')
}

export function formatMessages(ms: ChatMessage[], o: { chat?: boolean } = {}): string {
  if (!ms.length) return 'No messages.'
  return ms.map((m) => `[${stamp(m.at)}] ${m.fromMe ? 'me' : m.sender} (${m.service})${o.chat && m.chatGuid ? ` [chat_id: ${m.chatGuid}]` : ''}: ${oneLine(m.text || '(no text)', 2000)}${m.attachments ? ' [attachment]' : ''}`).join('\n')
}
