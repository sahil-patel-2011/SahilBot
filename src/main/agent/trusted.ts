// Trusted recipients: safe autonomy for messages. A bot may send email or texts without asking when EVERY
// recipient is on that bot's "Can message without asking" list or is the user themself (Settings → General
// → Your email and phone). permissions.ts decide() lifts the send hard stop for such a call (trustedSend),
// in Auto and Bypass, attended or not; Ask still asks, and purchases, one-time codes, passwords and other
// credential stops never change. Recipients are matched exactly after normalizing (emails lowercased,
// phone numbers to E.164-ish digits), so outside content can never add a recipient: an address a web page
// or email suggested either is on the user's list already, or the send asks as before.
//
// Limits that still ask: more than MAX_TRUSTED_RECIPIENTS people in one send, or more than
// MAX_TRUSTED_PER_HOUR trusted sends by one bot in the last hour (a loop, or a run steered into spam).

/** More recipients than this in one call is a mass send: it asks whatever the list says. */
export const MAX_TRUSTED_RECIPIENTS = 10
/** Trusted sends one bot may make in a sliding hour before the next one asks. */
export const MAX_TRUSTED_PER_HOUR = 20
/** Entries on one bot's list. */
export const TRUSTED_LIMIT = 50

const EMAIL = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}$/i

/**
 * One recipient in comparable form: "e:addr@x.com" for email, "p:15551234567" for a phone number, or null
 * when it is neither. "Name <addr>" keeps only the address; "tel:" / "sms:" / "mailto:" prefixes go; a
 * 10-digit number is taken as North American (+1), "00" as the international prefix.
 */
export function normalizeRecipient(raw: unknown): string | null {
  let s = String(raw ?? '').trim()
  if (!s) return null
  const angle = /<([^<>]+)>\s*$/.exec(s)
  if (angle) s = angle[1].trim()
  s = s.replace(/^(mailto|tel|sms|imessage):/i, '').trim()
  if (s.includes('@')) return EMAIL.test(s) ? `e:${s.toLowerCase()}` : null
  if (/[a-z]/i.test(s)) return null
  let digits = s.replace(/[\s().\- ‐-―/]+/g, '')
  if (!/^\+?\d{5,16}$/.test(digits)) return null
  const plus = digits.startsWith('+')
  digits = digits.replace(/^\+/, '')
  if (!plus && digits.startsWith('00')) digits = digits.slice(2)
  else if (!plus && digits.length === 10) digits = `1${digits}`
  return digits.length >= 5 ? `p:${digits}` : null
}

/** A normalized recipient as people read it. */
export const showRecipient = (n: string): string => (n.startsWith('p:') ? `+${n.slice(2)}` : n.slice(2))

/** A saved list, cleaned: valid emails and phone numbers only, deduplicated (by normalized form), capped. */
export function cleanTrustedList(v: unknown, limit = TRUSTED_LIMIT): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of Array.isArray(v) ? v : []) {
    if (typeof x !== 'string') continue
    const t = x.replace(/\s+/g, ' ').trim().slice(0, 200)
    const n = normalizeRecipient(t)
    if (!n || seen.has(n) || out.length >= limit) continue
    seen.add(n)
    out.push(t)
  }
  return out
}

/** Phone or email handle in a 1:1 Messages chat id ("iMessage;-;+15551234567"); null for group chats. */
export function chatIdHandle(chatId: string): string | null {
  const m = /^(?:iMessage|SMS|RCS|any);-;(.+)$/i.exec(String(chatId ?? '').trim())
  return m ? m[1] : null
}

/** Argument names that name an audience other than to / cc / bcc / recipients. */
const OTHER_AUDIENCE = /^(attendees?|guests?|invitees?|participants?|members?|users?|channels?|groups?|forward(_?to)?|share(_?with)?|emails?|addresses?|phones?|numbers?|recipient|reply_?to_?all|audience|list(_?id)?|segment|contacts?)$/i

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;\n]+/) : v == null ? [] : [v])

/** to / cc / bcc (and "recipients") of a call, raw, or null when it names none. */
function addressFields(a: Record<string, unknown>): unknown[] | null {
  const all = ['to', 'cc', 'bcc', 'recipients'].flatMap((k) => asList(a[k])).filter((x) => String(x ?? '').trim())
  return all.length ? all : null
}

export interface RecipientLookup {
  /** The participants (handles) of a Messages chat by its id/guid, or null when unknown. */
  chatParticipants?(chatId: string): string[] | null
}

/**
 * Who a send reaches, normalized, or null when that isn't known from the arguments alone (a reply that
 * goes to whoever wrote the original, a group chat whose members can't be looked up, an argument that isn't
 * an address). Null never counts as trusted. Only called for calls whose hard stop is a send.
 */
export function sendRecipients(tool: string, args: unknown, lookup: RecipientLookup = {}): string[] | null {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const inner = (a.args && typeof a.args === 'object' && !Array.isArray(a.args) ? { ...a, ...(a.args as Record<string, unknown>) } : a)
  let raw: unknown[] | null
  if (tool === 'app') {
    // Messages through the app tool: a handle (to), or a chat id whose participants come from chat.db.
    if (!/^(messages|imessage|sms|texts)$/i.test(String(a.app ?? '').trim()) || String(a.action ?? '').trim().toLowerCase() !== 'send') return null
    if (inner.chat_id) {
      const one = chatIdHandle(String(inner.chat_id))
      const members = one ? [one] : lookup.chatParticipants?.(String(inner.chat_id)) ?? null
      if (!members?.length) return null
      raw = members
    } else raw = inner.to ? [inner.to] : null
  } else if (tool === 'mail' || tool === 'gmail_imap') {
    // A reply goes to the original's sender (and, reply-all, everyone on it): not known here.
    if (inner.action !== 'send') return null
    if ((inner.mode && inner.mode !== 'new') || inner.reply_to || inner.uid) return null
    raw = addressFields(inner)
  } else if (tool === 'outlook') {
    // Only a new email's explicit recipients: a reply, a saved draft or an invitation goes to people not known here.
    if (inner.action !== 'send' || inner.draft_id || inner.id || inner.reply_to) return null
    raw = addressFields(inner)
  } else {
    // Resend, Gmail's connector and other send tools: explicit recipients only; a reply tool without them is unknown.
    if (/(^|_)reply/i.test(tool) && !addressFields(inner)) return null
    // Any other field that could reach someone (attendees, a channel, a forward address…) makes the audience
    // unknown: a trusted "to" must never carry an untrusted guest along.
    if (Object.keys(inner).some((k) => OTHER_AUDIENCE.test(k) && String(inner[k] ?? '').trim())) return null
    raw = addressFields(inner)
  }
  if (!raw?.length) return null
  const out = new Set<string>()
  for (const r of raw) {
    const n = normalizeRecipient(r)
    if (!n) return null
    out.add(n)
  }
  return out.size ? [...out] : null
}

export interface TrustedConfig {
  /** This bot's "Can message without asking" list (as saved: emails and phone numbers). */
  bot: string[]
  /** The user's own emails and phone numbers: always trusted. */
  me: string[]
}

export interface TrustCheck {
  trusted: boolean
  /** Why a send to otherwise trusted people still asks (too many at once, too many this hour). */
  note?: string
  recipients?: string[]
}

/** A send hard stop (as tools word them: "sends email …", "sends a message …"). */
export const isSendStop = (s: string | null | undefined): boolean => typeof s === 'string' && /^sends?\b/i.test(s.trim())

/** The pure rule: every recipient on the list (or the user), not too many at once, not too many this hour. */
export function trustVerdict(recipients: string[] | null, cfg: TrustedConfig, sentThisHour: number): TrustCheck {
  if (!recipients?.length) return { trusted: false }
  const list = new Set([...cfg.bot, ...cfg.me].map(normalizeRecipient).filter((x): x is string => !!x))
  if (!recipients.every((r) => list.has(r))) return { trusted: false, recipients }
  if (recipients.length > MAX_TRUSTED_RECIPIENTS) return { trusted: false, recipients, note: `more than ${MAX_TRUSTED_RECIPIENTS} recipients at once` }
  if (sentThisHour >= MAX_TRUSTED_PER_HOUR) return { trusted: false, recipients, note: `this bot already sent ${sentThisHour} messages without asking in the last hour` }
  return { trusted: true, recipients }
}

/**
 * The loop's view: whether one call is a send to trusted people only, and a per-bot sliding-hour count of
 * the sends that ran without asking (recorded after they ran). In memory: a restart starts the hour over.
 */
export class TrustedSends {
  private log = new Map<string, number[]>()
  constructor(private d: { config(botId: string): TrustedConfig; lookup?: RecipientLookup; now?: () => number }) {}

  private recent(botId: string): number[] {
    const now = (this.d.now ?? Date.now)()
    const kept = (this.log.get(botId) ?? []).filter((t) => now - t < 3_600_000)
    this.log.set(botId, kept)
    return kept
  }

  check(botId: string, tool: string, args: unknown, hardStop: string | null | undefined): TrustCheck {
    if (!isSendStop(hardStop)) return { trusted: false }
    let recipients: string[] | null
    try { recipients = sendRecipients(tool, args, this.d.lookup) } catch { recipients = null }
    let cfg: TrustedConfig
    try { cfg = this.d.config(botId) } catch { return { trusted: false } }
    return trustVerdict(recipients, cfg, this.recent(botId).length)
  }

  /** A trusted send ran: it counts toward the bot's hourly limit. */
  record(botId: string): void {
    this.recent(botId).push((this.d.now ?? Date.now)())
  }

  sentThisHour(botId: string): number {
    return this.recent(botId).length
  }
}
