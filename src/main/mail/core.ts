// Email in SahilBot: the pure parts of the Apple Mail tool (query building, parsing what the Mail
// scripts return, message ids, reply quoting, bulk-organize previews). No osascript in here, so it is
// unit-tested with fixtures and never touches the user's real mailboxes.

export interface MailSummary {
  id: string
  date: string
  from: string
  subject: string
  snippet?: string
  unread: boolean
  flagged: boolean
  mailbox: string
  account: string
}

export interface MailMessage extends MailSummary {
  to: string[]
  cc: string[]
  replyTo?: string
  messageId?: string
  body: string
  truncated: boolean
  attachments: Array<{ name: string; size?: number }>
  /** List-Unsubscribe targets (links and mailto:), for the user to act on. Never opened automatically. */
  unsubscribe: string[]
}

// ------------------------------------------------------------------ message ids

/**
 * A message id the model can copy and the Mail scripts can find again without searching every
 * mailbox: "<account>/<mailbox path>#<Mail's numeric id>", e.g. "iCloud/INBOX#48213".
 */
export function formatMailId(account: string, mailbox: string, num: number | string): string {
  return `${account}/${mailbox}#${num}`
}

export function parseMailId(id: string): { account: string; mailbox: string; num: number } | null {
  const s = String(id ?? '').trim()
  const hash = s.lastIndexOf('#')
  if (hash <= 0) return null
  const num = Number(s.slice(hash + 1))
  if (!Number.isInteger(num) || num <= 0) return null
  const head = s.slice(0, hash)
  const slash = head.indexOf('/')
  if (slash <= 0 || slash === head.length - 1) return null
  return { account: head.slice(0, slash), mailbox: head.slice(slash + 1), num }
}

// ------------------------------------------------------------------ search

export interface SearchArgs {
  from?: string; to?: string; subject?: string; text?: string
  unread?: boolean; flagged?: boolean
  since?: string; before?: string
  mailbox?: string; account?: string
  limit?: number; snippets?: boolean
}

/** What the search script receives: validated, trimmed, dates as ISO strings. */
export interface SearchSpec {
  from: string | null; to: string | null; subject: string | null; text: string | null
  unread: boolean; flagged: boolean
  since: string | null; before: string | null
  mailbox: string | null; account: string | null
  limit: number
  /** How many of the newest matches the script looks at for filters Mail can't run itself (to, body text). */
  scan: number
  snippets: boolean
}

const clean = (s?: string | null): string | null => {
  const t = String(s ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim()
  return t ? t.slice(0, 200) : null
}

/** "2026-11-01", "2026-11-01T09:00", "7d", "24h", "2w" → ISO date-time. */
export function parseWhen(v: string | undefined, now = Date.now()): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  const rel = /^(\d{1,4})\s*([hdwm])$/i.exec(s)
  if (rel) {
    const n = Number(rel[1])
    const unit = { h: 3600_000, d: 864e5, w: 7 * 864e5, m: 30 * 864e5 }[rel[2].toLowerCase() as 'h' | 'd' | 'w' | 'm']
    return new Date(now - n * unit).toISOString()
  }
  const t = new Date(s)
  if (Number.isNaN(t.getTime())) throw new Error(`"${s}" is not a date. Use ISO (2026-11-01 or 2026-11-01T09:00) or a span like 7d / 24h.`)
  return t.toISOString()
}

export function buildSearchSpec(a: SearchArgs, now = Date.now()): SearchSpec {
  const limit = Math.max(1, Math.min(50, Math.floor(Number(a.limit ?? 20)) || 20))
  const since = parseWhen(a.since, now)
  const before = parseWhen(a.before, now)
  if (since && before && since >= before) throw new Error('"since" must be earlier than "before".')
  const text = clean(a.text)
  const to = clean(a.to)
  // Body text and recipients are checked message by message, so look at fewer messages for those.
  const scan = text ? Math.max(limit, 120) : to ? Math.max(limit, 250) : limit
  return {
    from: clean(a.from), to, subject: clean(a.subject), text,
    unread: a.unread === true, flagged: a.flagged === true,
    since, before,
    mailbox: clean(a.mailbox), account: clean(a.account),
    limit, scan, snippets: a.snippets !== false
  }
}

// ------------------------------------------------------------------ script output

/** The Mail scripts answer {ok, data} or {error}; "not_running" means Mail isn't open. */
export type ScriptReply<T> = { ok: true; data: T } | { ok: false; error: string; notRunning?: boolean }

export function parseScriptReply<T>(out: string): ScriptReply<T> {
  const s = String(out ?? '').trim()
  if (!s) return { ok: false, error: 'Mail returned nothing.' }
  let v: unknown
  try { v = JSON.parse(s) } catch { return { ok: false, error: `Mail returned something unexpected: ${s.slice(0, 120)}` } }
  if (!v || typeof v !== 'object') return { ok: false, error: 'Mail returned something unexpected.' }
  const o = v as { ok?: unknown; data?: unknown; error?: unknown }
  if (o.error === 'not_running') return { ok: false, error: 'Mail is not open.', notRunning: true }
  if (typeof o.error === 'string') return { ok: false, error: o.error.slice(0, 400) }
  if (o.ok === true) return { ok: true, data: o.data as T }
  return { ok: false, error: 'Mail returned something unexpected.' }
}

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, max)
const iso = (v: unknown): string => {
  const t = typeof v === 'number' ? new Date(v) : new Date(String(v ?? ''))
  return Number.isNaN(t.getTime()) ? '' : t.toISOString()
}

/** Raw search rows from the script → summaries, newest first, invalid rows dropped. */
export function parseSearchRows(rows: unknown): MailSummary[] {
  if (!Array.isArray(rows)) return []
  const out: MailSummary[] = []
  for (const r of rows as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object') continue
    const num = Number(r.num)
    const account = str(r.account, 120)
    const mailbox = str(r.mailbox, 200)
    if (!Number.isInteger(num) || num <= 0 || !account || !mailbox) continue
    out.push({
      id: formatMailId(account, mailbox, num),
      date: iso(r.date),
      from: str(r.from, 200),
      subject: str(r.subject, 300) || '(no subject)',
      ...(typeof r.snippet === 'string' && r.snippet.trim() ? { snippet: str(r.snippet, 240) } : {}),
      unread: r.unread === true,
      flagged: r.flagged === true,
      mailbox, account
    })
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

/** "List-Unsubscribe: <mailto:x@y>, <https://…>" from raw headers. */
export function listUnsubscribe(headers: string): string[] {
  const m = /^list-unsubscribe:\s*((?:.*)(?:\r?\n[ \t].*)*)/im.exec(String(headers ?? ''))
  if (!m) return []
  return [...m[1].replace(/\r?\n[ \t]+/g, ' ').matchAll(/<([^>]+)>/g)].map((x) => x[1].trim()).filter((u) => /^(https?:|mailto:)/i.test(u)).slice(0, 4)
}

export function parseMessage(raw: unknown, maxChars = 12_000): MailMessage | null {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object') return null
  const [s] = parseSearchRows([r])
  if (!s) return null
  const body = typeof r.body === 'string' ? r.body.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : ''
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => str(x, 200)).filter(Boolean).slice(0, 50) : [])
  const atts = Array.isArray(r.attachments) ? (r.attachments as Array<Record<string, unknown>>).filter((a) => a && typeof a.name === 'string').map((a) => ({ name: str(a.name, 200), ...(typeof a.size === 'number' ? { size: a.size } : {}) })).slice(0, 30) : []
  return {
    ...s,
    to: list(r.to), cc: list(r.cc),
    ...(typeof r.replyTo === 'string' && r.replyTo.trim() ? { replyTo: str(r.replyTo, 200) } : {}),
    ...(typeof r.messageId === 'string' && r.messageId.trim() ? { messageId: str(r.messageId, 300) } : {}),
    body: body.slice(0, maxChars),
    truncated: body.length > maxChars,
    attachments: atts,
    unsubscribe: listUnsubscribe(typeof r.headers === 'string' ? r.headers : '')
  }
}

// ------------------------------------------------------------------ formatting for the model

const day = (isoDate: string): string => (isoDate ? isoDate.slice(0, 16).replace('T', ' ') : '?')

export function formatSummaries(list: MailSummary[]): string {
  if (!list.length) return 'No messages match.'
  return list.map((m) => {
    const flags = [m.unread ? 'unread' : '', m.flagged ? 'flagged' : ''].filter(Boolean).join(', ')
    return `- id: ${m.id}\n  ${day(m.date)} · ${m.from}\n  ${m.subject}${flags ? ` [${flags}]` : ''}${m.snippet ? `\n  > ${m.snippet}` : ''}`
  }).join('\n')
}

export function formatMessage(m: MailMessage): string {
  const kb = (n?: number): string => (typeof n === 'number' ? ` (${Math.max(1, Math.round(n / 1024))} KB)` : '')
  return [
    `id: ${m.id}`,
    `From: ${m.from}`,
    `To: ${m.to.join(', ') || '?'}`,
    ...(m.cc.length ? [`Cc: ${m.cc.join(', ')}`] : []),
    ...(m.replyTo ? [`Reply-To: ${m.replyTo}`] : []),
    `Date: ${day(m.date)}`,
    `Subject: ${m.subject}`,
    `Mailbox: ${m.account} / ${m.mailbox}${m.unread ? ' · unread' : ''}${m.flagged ? ' · flagged' : ''}`,
    ...(m.attachments.length ? [`Attachments: ${m.attachments.map((a) => `${a.name}${kb(a.size)}`).join(', ')}`] : []),
    ...(m.unsubscribe.length ? [`Unsubscribe options (list them for the user; never open them yourself): ${m.unsubscribe.join(' , ')}`] : []),
    '',
    m.body || '(empty body)',
    ...(m.truncated ? ['', '[body cut short]'] : [])
  ].join('\n')
}

// ------------------------------------------------------------------ drafts

/** A reply body with the original quoted below it, the way mail apps do. */
export function quoteReply(body: string, orig: { from: string; date: string; text: string }, maxQuoted = 6000): string {
  const when = orig.date ? new Date(orig.date) : null
  const stamp = when && !Number.isNaN(when.getTime()) ? when.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'earlier'
  const text = String(orig.text ?? '').replace(/\r\n?/g, '\n').trim()
  const cut = text.length > maxQuoted ? `${text.slice(0, maxQuoted)}\n[…]` : text
  const quoted = cut.split('\n').map((l) => (l.startsWith('>') ? `>${l}` : `> ${l}`)).join('\n')
  return `${String(body ?? '').trim()}\n\nOn ${stamp}, ${orig.from || 'they'} wrote:\n${quoted}\n`
}

/** "Re: Re: Hello" stays "Re: Hello"; a fresh subject gets one "Re: ". */
export function replySubject(subject: string): string {
  const s = String(subject ?? '').trim()
  return /^(re|aw|sv):/i.test(s) ? s : `Re: ${s || '(no subject)'}`
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/

/** Plain addresses only ("Jane <jane@x.com>" → "jane@x.com"); throws on anything else. */
export function cleanAddresses(list: string[] | undefined, field: string): string[] {
  const out: string[] = []
  for (const raw of list ?? []) {
    for (const part of String(raw).split(/[,;]+/)) {
      const t = part.trim()
      if (!t) continue
      const addr = (/<([^>]+)>/.exec(t)?.[1] ?? t).trim()
      if (!EMAIL.test(addr)) throw new Error(`"${t}" in ${field} is not an email address.`)
      out.push(addr)
    }
  }
  if (out.length > 50) throw new Error(`Too many addresses in ${field} (50 at most).`)
  return out
}

// ------------------------------------------------------------------ bulk organize

export type OrganizeAction = 'move' | 'archive' | 'delete' | 'flag' | 'unflag' | 'mark_read' | 'mark_unread'
export const ORGANIZE_ACTIONS: OrganizeAction[] = ['move', 'archive', 'delete', 'flag', 'unflag', 'mark_read', 'mark_unread']
export interface OrganizeItem { id: string; action: OrganizeAction; target?: string }

export const MAX_ORGANIZE = 500

/** Checks a bulk request: known actions, parseable ids, a target for moves, no id twice. */
export function validateOrganize(items: unknown): { items: OrganizeItem[]; problems: string[] } {
  const problems: string[] = []
  if (!Array.isArray(items) || !items.length) return { items: [], problems: ['items must be a non-empty list of {id, action, target?}'] }
  if (items.length > MAX_ORGANIZE) problems.push(`At most ${MAX_ORGANIZE} messages per organize call; split the rest into another call.`)
  const out: OrganizeItem[] = []
  const seen = new Set<string>()
  items.slice(0, MAX_ORGANIZE).forEach((x, i) => {
    const it = x as Partial<OrganizeItem> | null
    if (!it || typeof it !== 'object') { problems.push(`item ${i + 1}: not an object`); return }
    const id = String(it.id ?? '').trim()
    if (!parseMailId(id)) { problems.push(`item ${i + 1}: "${id.slice(0, 60)}" is not a message id from mail search`); return }
    if (!ORGANIZE_ACTIONS.includes(it.action as OrganizeAction)) { problems.push(`item ${i + 1}: unknown action "${String(it.action)}"`); return }
    const target = typeof it.target === 'string' ? it.target.trim() : ''
    if (it.action === 'move' && !target) { problems.push(`item ${i + 1}: move needs a target mailbox`); return }
    if (seen.has(id)) { problems.push(`item ${i + 1}: ${id} is listed twice`); return }
    seen.add(id)
    out.push({ id, action: it.action as OrganizeAction, ...(it.action === 'move' ? { target: target.slice(0, 200) } : {}) })
  })
  return { items: out, problems }
}

export interface PreviewGroup {
  action: OrganizeAction
  target?: string
  count: number
  samples: Array<{ from: string; subject: string }>
}

const ACTION_ORDER: Record<OrganizeAction, number> = { move: 0, archive: 1, mark_read: 2, mark_unread: 3, flag: 4, unflag: 5, delete: 6 }

/** Groups a bulk request by action (and target), biggest first, with a few example messages each. */
export function groupPreview(items: OrganizeItem[], headers: Record<string, { from: string; subject: string } | undefined>, samplesPer = 3): PreviewGroup[] {
  const groups = new Map<string, PreviewGroup>()
  for (const it of items) {
    const key = `${it.action}\u0000${(it.target ?? '').toLowerCase()}`
    const g = groups.get(key) ?? { action: it.action, ...(it.target ? { target: it.target } : {}), count: 0, samples: [] }
    g.count++
    const h = headers[it.id]
    if (h && g.samples.length < samplesPer) g.samples.push({ from: h.from.slice(0, 60), subject: h.subject.slice(0, 80) })
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || ACTION_ORDER[a.action] - ACTION_ORDER[b.action])
}

export function actionLabel(g: Pick<PreviewGroup, 'action' | 'target'>): string {
  switch (g.action) {
    case 'move': return `Move to "${g.target}"`
    case 'archive': return 'Archive'
    case 'delete': return 'Move to Trash'
    case 'flag': return 'Flag'
    case 'unflag': return 'Unflag'
    case 'mark_read': return 'Mark read'
    case 'mark_unread': return 'Mark unread'
  }
}

/** The dry-run preview the model shows the user (and the approval card summarizes). */
export function formatPreview(groups: PreviewGroup[], missing: string[] = []): string {
  const total = groups.reduce((n, g) => n + g.count, 0)
  const lines = [`Preview: ${total} message${total === 1 ? '' : 's'}, nothing changed yet.`]
  for (const g of groups) {
    lines.push('', `${actionLabel(g)}: ${g.count}`)
    for (const s of g.samples) lines.push(`  - ${s.from}: ${s.subject}`)
    if (g.count > g.samples.length) lines.push(`  - …and ${g.count - g.samples.length} more`)
  }
  if (missing.length) lines.push('', `Not found (left out): ${missing.length} id${missing.length === 1 ? '' : 's'}${missing.length <= 5 ? ` (${missing.join(', ')})` : ''}`)
  return lines.join('\n')
}

/** One line for the approval card: counts per action with one example each. */
export function previewSummary(groups: PreviewGroup[]): string {
  const total = groups.reduce((n, g) => n + g.count, 0)
  const parts = groups.slice(0, 5).map((g) => `${actionLabel(g)} ${g.count}${g.samples[0] ? ` (e.g. "${g.samples[0].subject.slice(0, 40)}" from ${g.samples[0].from.slice(0, 30)})` : ''}`)
  return `Change ${total} email${total === 1 ? '' : 's'}: ${parts.join('; ')}${groups.length > 5 ? `; +${groups.length - 5} more groups` : ''}`
}

/** Splits work into chunks so one Apple Events script never handles too much at once. */
export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

// ------------------------------------------------------------------ errors

export const MAIL_PERMISSION_HELP = 'macOS blocked SahilBot from controlling Mail. Open SahilBot Settings → Privacy & Permissions (or System Settings → Privacy & Security → Automation), allow SahilBot to control Mail, then try again.'

/** What went wrong in an osascript run, from its error text. */
export function classifyMailError(message: string): 'permission' | 'not_running' | 'timeout' | 'other' {
  const m = String(message ?? '')
  if (/-1743|not allowed|Not authori[sz]ed|not permitted to send Apple events/i.test(m)) return 'permission'
  if (/-600|isn't running|is not running|Application can.t be found|-1728.*Mail/i.test(m)) return 'not_running'
  if (/timed? ?out|-1712|ETIMEDOUT|SIGTERM/i.test(m)) return 'timeout'
  return 'other'
}
