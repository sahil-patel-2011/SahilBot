import { createHash } from 'node:crypto'
import type { RawItem } from './sources'

// Deterministic filtering before anything reaches a model (free, so it runs on everything read):
// newsletters and marketing, automated notifications and receipts, no-reply senders, calendar declines
// and cancellations, near-empty chat lines, and duplicates (the same message seen through two apps, or
// twice in one read) by a hash of what it says. Only what's left is worth a model's time.

export type DropReason = 'newsletter' | 'notification' | 'no-reply' | 'declined' | 'duplicate' | 'too short'

const NO_REPLY = /(^|[<\s"'])(no-?reply|do-?not-?reply|donotreply|noreply|mailer-daemon|postmaster|bounces?|notifications?|notify|alerts?|newsletters?|digest|updates|marketing|promo(tions)?|news)([+.-][^@\s]*)?@/i
const BULK_TEXT = /\b(unsubscribe|view (this email )?in (your )?browser|manage (your )?(email )?preferences|update your preferences|opt[ -]out|you are receiving this (email|message) because|email preferences)\b/i
const NOTIFY_SUBJECT = /\b(receipt|your order|order (confirmation|#?\d+)|has shipped|delivery (update|scheduled)|verification code|security (alert|code)|sign[- ]?in (attempt|code|alert)|new sign-?in|password reset|reset your password|confirm your (email|account)|one-time (code|passcode)|statement is (ready|available)|payment (received|confirmation)|auto-?pay|subscription (renewed|confirmed)|webinar|\d+% off|sale ends|limited time|weekly digest|daily digest|new login|invitation: .* @ |accepted: |tentatively accepted: )\b/i
const DECLINE_SUBJECT = /^(declined|canceled|cancelled|updated invitation with note|invitation (declined|canceled))\b[: ]/i
const ACK = /^(ok(ay)?|k|thanks?( you)?|thx|ty|cool|great|nice|got it|sounds good|yes|no|yep|nope|lol|haha+|👍|🙏|❤️|\W+)[.!]*$/i

/** The hash two copies of the same thing share (case and spacing don't matter). */
export function itemHash(x: Pick<RawItem, 'title' | 'text' | 'from'>): string {
  const norm = (s: string | undefined): string => String(s ?? '').toLowerCase().replace(/^(re|fwd?|aw):\s*/gi, '').replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(`${norm(x.from).replace(/^.*<|>.*$/g, '')}|${norm(x.title)}|${norm(x.text).slice(0, 1500)}`).digest('hex').slice(0, 32)
}

/** Why an item isn't worth reading, or null to keep it. */
export function dropReason(x: RawItem): DropReason | null {
  if (x.kind === 'calendar' && (x.declined || DECLINE_SUBJECT.test(x.title))) return 'declined'
  if (x.kind === 'email') {
    if (DECLINE_SUBJECT.test(x.title)) return 'declined'
    if (x.from && NO_REPLY.test(x.from)) return 'no-reply'
    if (x.bulk || (x.labels ?? []).some((l) => /promotions|social|forums|newsletters?/i.test(l))) return 'newsletter'
    if (BULK_TEXT.test(x.text)) return 'newsletter'
    if (NOTIFY_SUBJECT.test(x.title)) return 'notification'
  }
  if (x.kind === 'chat') {
    const t = x.text.trim()
    if (t.length < 12 || ACK.test(t)) return 'too short'
  }
  if (!x.text.trim() && (!x.title.trim() || x.title === '(untitled)' || x.title === '(no subject)')) return 'too short'
  return null
}

export interface Filtered { kept: RawItem[]; dropped: Array<{ item: RawItem; reason: DropReason }>; hashes: Map<RawItem, string> }

/** Splits a read into what's worth a model's time and what isn't. `seen`: hashes already stored. */
export function prefilter(items: RawItem[], seen: (hash: string) => boolean): Filtered {
  const kept: RawItem[] = []
  const dropped: Filtered['dropped'] = []
  const hashes = new Map<RawItem, string>()
  const batch = new Set<string>()
  for (const x of items) {
    const h = itemHash(x)
    hashes.set(x, h)
    const why = dropReason(x) ?? (batch.has(h) || seen(h) ? 'duplicate' : null)
    batch.add(h)
    if (why) dropped.push({ item: x, reason: why })
    else kept.push(x)
  }
  return { kept, dropped, hashes }
}

/** About how many of a source's items survive the filter (for the first-read estimate). */
export const KEEP_RATE: Record<RawItem['kind'], number> = { email: 0.45, calendar: 0.8, chat: 0.5, meetings: 1, crm: 1, docs: 0.9, accounting: 1 }
