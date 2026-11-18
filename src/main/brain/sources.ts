import type { BrainSourceKind } from '@shared/brain'
import { gmailTime, parseGmailSearch, parseGmailThread } from '../mail/gmail'

// The brain's sources: what it can read from each connected account, newest first, after a cursor.
// Every read is bounded (items per sync, characters per item) and read-only (only tools the connector's
// effect map calls reads: search, list, get). Connected apps are MCP servers whose tool names and shapes
// vary, so each adapter looks for its tool by name and reads the answer with a forgiving JSON walker;
// a source whose server doesn't offer a usable read tool says so instead of guessing.

export interface RawItem {
  source: string
  /** Unique within the source; a thread with a new message gets a new id (it's read again). */
  id: string
  kind: BrainSourceKind
  /** When it happened (sent, updated, modified). */
  at: number
  title: string
  /** "Name <email>" (email, texts, chat). */
  from?: string
  to?: string[]
  /** Body text, untrusted, bounded. */
  text: string
  link?: string
  /** Bulk-mail signs the app reported (List-Unsubscribe, a promotions label). */
  bulk?: boolean
  labels?: string[]
  /** A calendar invite the user declined, or a cancelled event. */
  declined?: boolean
  /** Calendar attendees (structured metadata). */
  people?: Array<{ name: string; email: string }>
  /** The chip's noun when it isn't the kind's ("deal", "contact", "invoice", "doc", "call"). */
  noun?: string
  /** Calendar: when the event starts. */
  start?: string
}

export interface ReadOptions { after: number; before?: number; limit: number; now: number; signal?: AbortSignal }

export interface ConnectorIO {
  /** connected: live; needs_auth: set up but needs signing in again; absent: not set up. */
  state(preset: string): 'connected' | 'needs_auth' | 'absent'
  /** The server's own tool names (read tools included) for a live connector. */
  tools(preset: string): string[]
  call(preset: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>
}

export interface BrainIO {
  connectors?: ConnectorIO
  /** Gmail by app password (IMAP). */
  gmailImap?: { available(): boolean; read(o: ReadOptions): Promise<RawItem[]>; count(after: number): Promise<number> }
  /** Apple Mail on this Mac (only while Mail is open; never launched for the brain). */
  appleMail?: { available(): boolean; read(o: ReadOptions): Promise<RawItem[]> }
  /** Messages (chat.db): 'no-access' without Full Disk Access. */
  texts?: { available(): 'ok' | 'no-access' | 'absent'; read(o: ReadOptions): RawItem[] }
}

export type SourceAvailability = { state: 'connected' } | { state: 'needs-sign-in'; hint: string } | { state: 'not-connected'; hint: string }

export interface SourceDef {
  id: string
  name: string
  kind: BrainSourceKind
  /** The connector preset whose icon it shows (and that Connect opens). */
  preset: string
  /** Off unless the user turns it on. */
  optIn?: boolean
  what: string
  /** "emails", "events"… for the estimate line. */
  unit: string
  availability(io: BrainIO): SourceAvailability
  read(io: BrainIO, o: ReadOptions): Promise<RawItem[]>
  /** How many items the window holds (for the first-read estimate); `more` when the app only says "at least". */
  count?(io: BrainIO, after: number, now: number): Promise<{ n: number; more?: boolean }>
}

const TEXT_MAX = 2500
const DAY = 86_400_000
const secs = (t: number): number => Math.floor(t / 1000)
const iso = (t: number): string => new Date(t).toISOString()
const ymd = (t: number): string => iso(t).slice(0, 10)

/** Control characters out, whitespace squashed, bounded. */
export function clip(s: unknown, max = TEXT_MAX): string {
  const t = String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function json(text: string): unknown {
  try { return JSON.parse(text) } catch { /* not JSON */ }
  const a = text.indexOf('{'), b = text.lastIndexOf('}')
  const c = text.indexOf('['), d = text.lastIndexOf(']')
  for (const [x, y] of [[c, d], [a, b]]) if (x >= 0 && y > x) { try { return JSON.parse(text.slice(x, y + 1)) } catch { /* next */ } }
  return null
}

const ID_KEYS = ['id', 'threadId', 'eventId', 'messageId', 'hs_object_id', 'objectId', 'uid', 'uuid', 'key', 'ts', 'InvoiceID', 'Id', 'page_id', 'meeting_id', 'meetingId', 'fileId']
const TITLE_KEYS = ['subject', 'title', 'summary', 'name', 'dealname', 'topic', 'firstname', 'InvoiceNumber', 'DocNumber', 'channel_name']
const TEXT_KEYS = ['plaintextBody', 'body', 'text', 'snippet', 'content', 'description', 'notes', 'transcript', 'summary_text', 'overview', 'preview', 'excerpt', 'markdown']
const DATE_KEYS = ['updated', 'updatedAt', 'updated_at', 'hs_lastmodifieddate', 'lastmodifieddate', 'modifiedTime', 'last_edited_time', 'lastEditedTime', 'UpdatedDateUTC', 'date', 'internalDate', 'createdAt', 'created_at', 'created', 'createdTime', 'start_time', 'startTime', 'ts', 'timestamp']
const LINK_KEYS = ['url', 'link', 'permalink', 'htmlLink', 'webViewLink', 'hs_url', 'share_url', 'web_url', 'href']
const FROM_KEYS = ['from', 'sender', 'user_name', 'username', 'user', 'author', 'organizer', 'host_email', 'owner']

const pickStr = (o: Record<string, unknown>, keys: string[]): string => {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = v as Record<string, unknown>
      for (const ik of ['email', 'name', 'displayName', 'dateTime', 'date', 'value']) if (typeof inner[ik] === 'string' && (inner[ik] as string).trim()) return (inner[ik] as string).trim()
    }
  }
  return ''
}

/** "1731852000.123456" (Slack ts), ms, seconds or an ISO string → ms (0 when unreadable). */
export function timeOf(v: string): number {
  if (/^\d{9,10}(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000)
  return gmailTime(v)
}

/**
 * Objects in a connector's JSON answer that look like items (an id and a title or some text), with
 * HubSpot-style `properties` flattened. Depth- and count-limited.
 */
export function walkItems(text: string, limit = 200): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const walk = (x: unknown, depth: number): void => {
    if (!x || typeof x !== 'object' || depth > 6 || out.length >= limit) return
    if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return }
    const raw = x as Record<string, unknown>
    const o: Record<string, unknown> = raw.properties && typeof raw.properties === 'object' && !Array.isArray(raw.properties) ? { ...(raw.properties as Record<string, unknown>), ...raw } : raw
    const id = pickStr(o, ID_KEYS)
    const title = pickStr(o, TITLE_KEYS)
    const body = pickStr(o, TEXT_KEYS)
    if (id && (title || body)) { out.push(o); return }
    for (const y of Object.values(raw)) walk(y, depth + 1)
  }
  walk(json(text), 0)
  return out
}

/** A walked object → an item. */
export function genericItem(source: string, kind: BrainSourceKind, o: Record<string, unknown>, extra: Partial<RawItem> = {}): RawItem | null {
  const id = pickStr(o, ID_KEYS)
  if (!id) return null
  const title = clip(pickStr(o, TITLE_KEYS), 200)
  const at = timeOf(pickStr(o, DATE_KEYS))
  return {
    source, id: `${id}${at ? `:${at}` : ''}`, kind, at, title: title || '(untitled)', text: clip(pickStr(o, TEXT_KEYS)),
    ...(pickStr(o, FROM_KEYS) ? { from: clip(pickStr(o, FROM_KEYS), 200) } : {}),
    ...(/^https?:\/\//.test(pickStr(o, LINK_KEYS)) ? { link: pickStr(o, LINK_KEYS) } : {}),
    ...extra
  }
}

/** The first tool of a live connector whose name matches, in the order of the patterns. */
export function findTool(io: BrainIO, preset: string, patterns: RegExp[]): string | undefined {
  const tools = io.connectors?.tools(preset) ?? []
  for (const p of patterns) { const t = tools.find((x) => p.test(x)); if (t) return t }
  return undefined
}

const connectorAvailability = (preset: string, name: string) => (io: BrainIO): SourceAvailability => {
  const s = io.connectors?.state(preset) ?? 'absent'
  if (s === 'connected') return { state: 'connected' }
  if (s === 'needs_auth') return { state: 'needs-sign-in', hint: 'Needs sign-in · tap to fix' }
  return { state: 'not-connected', hint: `Connect ${name}` }
}

const call = (io: BrainIO, preset: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> => {
  if (!io.connectors) throw new Error('Connected apps are not available')
  return io.connectors.call(preset, tool, args, signal)
}

const after = (items: RawItem[], o: ReadOptions): RawItem[] => items
  .filter((x) => (!x.at || x.at > o.after) && (!o.before || !x.at || x.at <= o.before))
  .sort((a, b) => b.at - a.at)
  .slice(0, o.limit)

// ------------------------------------------------------------------ the sources

const GMAIL_FILTER = '-in:drafts -in:spam -in:chats -category:promotions -category:social -category:forums'

const gmail: SourceDef = {
  id: 'gmail', name: 'Gmail', kind: 'email', preset: 'gmail', unit: 'emails',
  what: 'New email threads (sender, subject and the newest message’s text). Promotions, social and spam are skipped.',
  availability: connectorAvailability('gmail', 'Gmail'),
  async read(io, o) {
    const q = `after:${secs(o.after)}${o.before ? ` before:${secs(o.before)}` : ''} ${GMAIL_FILTER}`
    const text = await call(io, 'gmail', 'search_threads', { query: q, pageSize: Math.min(50, o.limit), view: 'THREAD_VIEW_SUMMARY' }, o.signal)
    const hits = parseGmailSearch(text).slice(0, o.limit)
    const canRead = (io.connectors?.tools('gmail') ?? []).includes('get_thread')
    const out: RawItem[] = []
    for (const h of hits) {
      let body = h.snippet
      let from = h.from
      if (canRead) {
        try {
          const msgs = parseGmailThread(await call(io, 'gmail', 'get_thread', { threadId: h.threadId }, o.signal))
          const newest = msgs.sort((a, b) => b.at - a.at)[0]
          if (newest?.text) body = newest.text
          if (newest?.from) from = newest.from
        } catch { /* the summary's snippet will do */ }
      }
      out.push({ source: 'gmail', id: `${h.threadId}:${h.at}`, kind: 'email', at: h.at, title: clip(h.subject || '(no subject)', 200), from: clip(from, 200), text: clip(body), link: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(h.threadId)}` })
    }
    return after(out, o)
  },
  async count(io, since) {
    const text = await call(io, 'gmail', 'search_threads', { query: `after:${secs(since)} ${GMAIL_FILTER}`, pageSize: 50, view: 'THREAD_VIEW_SUMMARY' })
    const v = json(text) as Record<string, unknown> | null
    const est = Number(v?.resultSizeEstimate)
    const n = parseGmailSearch(text).length
    if (Number.isFinite(est) && est > 0) return { n: est }
    return { n, more: !!v?.nextPageToken }
  }
}

const gmailImap: SourceDef = {
  id: 'gmail-imap', name: 'Gmail (app password)', kind: 'email', preset: 'gmail', unit: 'emails',
  what: 'New email over IMAP with your app password: sender, subject and the text. Nothing is marked read.',
  availability: (io) => (io.gmailImap?.available() ? { state: 'connected' } : { state: 'not-connected', hint: 'Connect Google with an app password' }),
  read: (io, o) => io.gmailImap!.read(o).then((xs) => after(xs, o)),
  count: async (io, since) => ({ n: await io.gmailImap!.count(since) })
}

const appleMail: SourceDef = {
  id: 'apple-mail', name: 'Apple Mail', kind: 'email', preset: 'apple-mail', unit: 'emails',
  what: 'New mail in Mail’s inboxes on this Mac, while Mail is open (SahilBot never opens Mail for this).',
  availability: (io) => (io.appleMail?.available() ? { state: 'connected' } : { state: 'not-connected', hint: 'Connect Mail (all your accounts)' }),
  read: (io, o) => io.appleMail!.read(o).then((xs) => after(xs, o))
}

/** Calendar events in a connector's JSON, with who's invited and whether the user declined. */
export function calendarItems(source: string, text: string): RawItem[] {
  const out: RawItem[] = []
  for (const o of walkItems(text)) {
    const title = typeof o.summary === 'string' ? o.summary : typeof o.title === 'string' ? o.title : ''
    const startOf = (s: unknown): string => typeof s === 'string' ? s : s && typeof s === 'object' ? String((s as Record<string, unknown>).dateTime ?? (s as Record<string, unknown>).date ?? '') : ''
    const start = startOf(o.start ?? o.startTime)
    if (!title || !start || typeof o.id !== 'string') continue
    const attendees = (Array.isArray(o.attendees) ? o.attendees : []) as Array<Record<string, unknown>>
    const self = attendees.find((a) => a?.self === true)
    const people = attendees.filter((a) => a && a.self !== true && a.resource !== true && typeof a.email === 'string').map((a) => ({ name: String(a.displayName ?? a.name ?? ''), email: String(a.email).toLowerCase() })).slice(0, 30)
    const updated = timeOf(String(o.updated ?? o.created ?? '')) || timeOf(start)
    out.push({
      source, id: `${o.id}:${updated}`, kind: 'calendar', at: updated, title: clip(title, 200), start,
      text: clip([typeof o.description === 'string' ? o.description : '', typeof o.location === 'string' ? `Where: ${o.location}` : '', `When: ${start}`, people.length ? `With: ${people.map((p) => p.name || p.email).join(', ')}` : ''].filter(Boolean).join('\n')),
      people, declined: o.status === 'cancelled' || self?.responseStatus === 'declined',
      ...(typeof o.htmlLink === 'string' && /^https:\/\//.test(o.htmlLink) ? { link: o.htmlLink } : {})
    })
  }
  return out
}

const gcal: SourceDef = {
  id: 'gcal', name: 'Google Calendar', kind: 'calendar', preset: 'gcal', unit: 'events',
  what: 'Events added or changed: title, time, place, who’s invited and the description. Declined and cancelled events are skipped.',
  availability: connectorAvailability('gcal', 'Google Calendar'),
  async read(io, o) {
    const args = { timeMin: iso(o.now - 2 * DAY), timeMax: iso(o.now + 21 * DAY), maxResults: Math.min(50, o.limit), singleEvents: true, orderBy: 'startTime', updatedMin: iso(Math.max(o.after, o.now - 28 * DAY)) }
    const tool = findTool(io, 'gcal', [/^list_events$/, /^search_events$/]) ?? 'list_events'
    return after(calendarItems('gcal', await call(io, 'gcal', tool, tool === 'search_events' ? { ...args, query: '' } : args, o.signal)), o)
  }
}

/** A read through a connector's own read tool, found by name; generic items. */
function generic(def: Omit<SourceDef, 'read' | 'count' | 'availability'> & {
  tools: RegExp[]
  args: (o: ReadOptions) => Record<string, unknown>
  item?: (o: Record<string, unknown>) => Partial<RawItem> | null
  /** Second read for the text of the newest few (docs). */
  readText?: { tools: RegExp[]; args: (id: string) => Record<string, unknown>; max: number }
}): SourceDef {
  return {
    ...def,
    availability: connectorAvailability(def.preset, def.name),
    async read(io, o) {
      const tool = findTool(io, def.preset, def.tools)
      if (!tool) throw new Error(`${def.name} doesn’t offer a tool SahilBot can read ${def.unit} with`)
      const text = await call(io, def.preset, tool, def.args(o), o.signal)
      const items: RawItem[] = []
      for (const x of walkItems(text)) {
        const extra = def.item ? def.item(x) : {}
        if (extra === null) continue
        const it = genericItem(def.id, def.kind, x, extra)
        if (it) items.push(it)
      }
      const list = after(items, o)
      if (def.readText) {
        const rt = findTool(io, def.preset, def.readText.tools)
        if (rt) for (const it of list.slice(0, def.readText.max)) {
          if (it.text.length > 400) continue
          try { it.text = clip(await call(io, def.preset, rt, def.readText.args(it.id.split(':')[0]), o.signal), 4000) } catch { /* the title will do */ }
        }
      }
      return list
    },
    async count(io, since, now) {
      const items = await this.read(io, { after: since, limit: 100, now })
      return { n: items.length, more: items.length >= 100 }
    }
  }
}

const slack = generic({
  id: 'slack', name: 'Slack', kind: 'chat', preset: 'slack', unit: 'messages',
  what: 'Messages in your channels and DMs that mention you or were sent to you (searched, never posted).',
  tools: [/^(slack_)?search_messages$/i, /^(slack_)?search_public_and_private$/i, /^(slack_)?search/i],
  args: (o) => ({ query: `after:${ymd(o.after - DAY)} to:me`, limit: Math.min(50, o.limit), count: Math.min(50, o.limit), sort: 'timestamp' })
})

const meetings = (id: string, name: string, preset: string): SourceDef => generic({
  id, name, kind: 'meetings', preset, unit: 'meetings',
  what: 'Meeting summaries and transcripts (the text the app made, bounded).',
  tools: [/(meeting_summar|summar)/i, /transcript/i, /(list|search|get).*(meeting|recording|note)/i],
  args: (o) => ({ from: ymd(o.after), to: ymd(o.now + DAY), page_size: Math.min(30, o.limit), limit: Math.min(30, o.limit) }),
  item: () => ({ noun: 'call' })
})

const hubspot = generic({
  id: 'hubspot', name: 'HubSpot', kind: 'crm', preset: 'hubspot', unit: 'deals',
  what: 'Deals changed lately: name, stage, amount and close date.',
  tools: [/^search_crm_objects$/i, /search.*(deal|crm|object)/i, /list.*(deal|object)/i],
  args: (o) => ({
    objectType: 'deals', limit: Math.min(50, o.limit),
    properties: ['dealname', 'amount', 'dealstage', 'closedate', 'hs_lastmodifieddate', 'description'],
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
    filterGroups: [{ filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(o.after) }] }]
  }),
  item: (x) => ({ noun: 'deal', text: clip([x.dealstage && `Stage: ${String(x.dealstage)}`, x.amount && `Amount: ${String(x.amount)}`, x.closedate && `Close date: ${String(x.closedate)}`, typeof x.description === 'string' ? x.description : ''].filter(Boolean).join('\n')) })
})

const drive = generic({
  id: 'gdrive', name: 'Google Drive', kind: 'docs', preset: 'gdrive', unit: 'docs',
  what: 'Titles of files changed lately, and the text of the newest few documents (bounded).',
  tools: [/^list_recent_files$/i, /^search_files$/i, /(list|search).*file/i],
  args: (o) => ({ pageSize: Math.min(30, o.limit), query: `modifiedTime > '${iso(o.after)}'` }),
  item: () => ({ noun: 'doc' }),
  readText: { tools: [/^read_file_content$/i, /^(download|get)_file_content$/i], args: (id) => ({ fileId: id }), max: 5 }
})

const notion = generic({
  id: 'notion', name: 'Notion', kind: 'docs', preset: 'notion', unit: 'pages',
  what: 'Pages edited lately: titles, and the text of the newest few (bounded).',
  tools: [/^(notion_)?search$/i, /search/i],
  args: (o) => ({ query: '', filter: { property: 'object', value: 'page' }, sort: { timestamp: 'last_edited_time', direction: 'descending' }, page_size: Math.min(30, o.limit) }),
  item: () => ({ noun: 'page' }),
  readText: { tools: [/^(notion_)?fetch$/i, /(get|retrieve).*page/i], args: (id) => ({ id }), max: 3 }
})

/** Invoices: amounts, status, dates and who they're for; nothing else from the record. */
const accounting = (id: string, name: string, preset: string): SourceDef => generic({
  id, name, kind: 'accounting', preset, unit: 'invoices',
  what: 'Invoices changed lately: who they’re for, the amount, status and due date (amounts only, never account numbers).',
  tools: [/(list|get|search|query).*invoice/i],
  args: (o) => ({ where: `UpdatedDateUTC>=DateTime(${new Date(o.after).getUTCFullYear()},${new Date(o.after).getUTCMonth() + 1},${new Date(o.after).getUTCDate()})`, updatedAfter: iso(o.after), limit: Math.min(50, o.limit), page: 1 }),
  item: (x) => {
    const who = pickStr(x, ['Contact', 'CustomerRef', 'customer', 'contact', 'ContactName'])
    const amt = pickStr(x, ['Total', 'TotalAmt', 'AmountDue', 'Balance', 'amount', 'total'])
    const due = pickStr(x, ['DueDate', 'DueDateString', 'due_date', 'dueDate'])
    const status = pickStr(x, ['Status', 'status'])
    return { noun: 'invoice', title: clip(`Invoice ${pickStr(x, ['InvoiceNumber', 'DocNumber', 'number'])}${who ? ` · ${who}` : ''}`, 200), text: clip([who && `For: ${who}`, amt && `Amount: ${amt}`, status && `Status: ${status}`, due && `Due: ${due}`].filter(Boolean).join('\n'), 400) }
  }
})

const texts: SourceDef = {
  id: 'texts', name: 'Messages (texts)', kind: 'chat', preset: 'apple-notes', optIn: true, unit: 'texts',
  what: 'Texts from Messages on this Mac. Off unless you turn it on; it needs Full Disk Access.',
  availability: (io) => {
    const a = io.texts?.available() ?? 'absent'
    return a === 'ok' ? { state: 'connected' } : a === 'no-access' ? { state: 'needs-sign-in', hint: 'Allow Full Disk Access for SahilBot' } : { state: 'not-connected', hint: 'Messages isn’t on this Mac' }
  },
  read: async (io, o) => after(io.texts!.read(o), o),
  count: async (io, since, now) => { const n = io.texts!.read({ after: since, limit: 500, now }).length; return { n, more: n >= 500 } }
}

export const SOURCES: SourceDef[] = [
  gmail, gmailImap, appleMail, gcal, slack, texts,
  meetings('zoom', 'Zoom', 'zoom'), meetings('granola', 'Granola', 'granola'), meetings('fireflies', 'Fireflies', 'fireflies'),
  hubspot, drive, notion,
  // QuickBooks has no connector preset yet; it's read the same way as Xero once one is connected.
  accounting('quickbooks', 'QuickBooks', 'quickbooks'), accounting('xero', 'Xero', 'xero')
]

export const sourceDef = (id: string): SourceDef | undefined => SOURCES.find((s) => s.id === id)
