import type { ToolEffect } from '@shared/types'
import { brandOf, domainOf, type CodeMessage } from '../otp'

// Gmail through Google's official MCP server: what each of its tools may do (so reads run, label
// changes are routine, trash asks and sending always asks), and reading one-time sign-in codes from
// recent mail for the browser, in main, without any email text reaching the model.

export interface ToolPolicy {
  effect: ToolEffect
  /** false: a routine change Auto mode runs without asking. */
  consequential: boolean
  /** Set for actions that must always ask (sending email). */
  hardStop?: string
}

const SEND = /(^|[_\-.])(send|reply|forward)([_\-.]|$)|^(reply_?all|send_?draft)$/i
const READS = /^(search_threads|search_messages|list_threads|list_messages|get_thread|get_message|get_attachment|get_message_attachment|list_labels|get_label|list_drafts|get_draft|get_profile|list_filters|get_filter)$/i
const DRAFTS = /^(create_draft|update_draft)$/i
const DESTROY = /^(trash_(message|thread)|delete_(draft|label|message|thread|filter)|batch_delete.*|empty_trash)$/i
const SPAM = /^(un)?mark_(message|thread)_spam$/i
const LABELS = /^((un)?label_(message|thread)|update_(message|thread)_labels|apply_sensitive_(message|thread)_label|create_label|update_label|untrash_(message|thread)|(mark|archive|star|unstar)_.*|modify_.*labels)$/i

/**
 * The effect of one Gmail MCP tool, from its name first (Google's names are precise) and its MCP
 * annotations second. A tool that sends is never treated as a read, whatever its annotations say.
 */
export function gmailPolicy(name: string, ann?: { readOnlyHint?: boolean; destructiveHint?: boolean }): ToolPolicy {
  const n = String(name ?? '').trim()
  if (SEND.test(n) && !DRAFTS.test(n)) return { effect: 'write_external', consequential: true, hardStop: 'sends email from your Gmail' }
  if (READS.test(n)) return { effect: 'read', consequential: false }
  if (DESTROY.test(n)) return { effect: 'destructive', consequential: true }
  if (DRAFTS.test(n)) return { effect: 'write_external', consequential: false }
  // Reporting spam tells Google about the sender: worth a question in Auto mode.
  if (SPAM.test(n)) return { effect: 'write_external', consequential: !/^un/i.test(n) }
  if (LABELS.test(n)) return { effect: 'write_external', consequential: false }
  if (ann?.destructiveHint) return { effect: 'destructive', consequential: true }
  if (ann?.readOnlyHint) return { effect: 'read', consequential: false }
  // Unknown Gmail tool: assume it acts outside and ask.
  return { effect: 'write_external', consequential: true }
}

// ------------------------------------------------------------------ parsing the server's JSON

export interface GmailHit { threadId: string; messageId?: string; from: string; subject: string; snippet: string; at: number }

/** Gmail dates come as ISO strings, RFC 2822 strings or epoch milliseconds (as numbers or strings). */
export function gmailTime(v: unknown): number {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  const s = String(v ?? '').trim()
  if (!s) return 0
  if (/^\d{9,14}$/.test(s)) { const n = Number(s); return n < 1e12 ? n * 1000 : n }
  const t = Date.parse(s)
  return Number.isNaN(t) ? 0 : t
}

function json(text: string): unknown {
  try { return JSON.parse(text) } catch { return null }
}

const who = (v: unknown): string => {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return [o.name ?? o.displayName, o.email ?? o.address].filter(Boolean).map(String).join(' ').trim()
  }
  return ''
}

/** search_threads output → the newest message per thread. Unparseable output gives []. */
export function parseGmailSearch(text: string): GmailHit[] {
  const v = json(text) as Record<string, unknown> | null
  const threads = Array.isArray(v?.threads) ? (v!.threads as Array<Record<string, unknown>>) : Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []
  const out: GmailHit[] = []
  for (const t of threads) {
    if (!t || typeof t !== 'object') continue
    const threadId = String(t.id ?? t.threadId ?? '')
    if (!threadId) continue
    const msgs = Array.isArray(t.messages) ? (t.messages as Array<Record<string, unknown>>) : [t]
    const newest = [...msgs].sort((a, b) => gmailTime(b.date ?? b.internalDate) - gmailTime(a.date ?? a.internalDate))[0] ?? t
    out.push({
      threadId,
      messageId: newest.id && newest !== t ? String(newest.id) : undefined,
      from: who(newest.sender ?? newest.from),
      subject: String(newest.subject ?? t.subject ?? ''),
      snippet: String(newest.snippet ?? t.snippet ?? ''),
      at: gmailTime(newest.date ?? newest.internalDate ?? t.date)
    })
  }
  return out.sort((a, b) => b.at - a.at)
}

/** get_thread output → its messages with their plain-text bodies. */
export function parseGmailThread(text: string): Array<{ from: string; subject: string; text: string; at: number }> {
  const v = json(text) as Record<string, unknown> | null
  const msgs = Array.isArray(v?.messages) ? (v!.messages as Array<Record<string, unknown>>) : v && typeof v === 'object' && !Array.isArray(v) ? [v] : []
  return msgs.filter((m) => m && typeof m === 'object').map((m) => ({
    from: who(m.sender ?? m.from),
    subject: String(m.subject ?? ''),
    text: String(m.plaintextBody ?? m.body ?? m.snippet ?? '').slice(0, 20_000),
    at: gmailTime(m.date ?? m.internalDate)
  }))
}

// ------------------------------------------------------------------ one-time codes from Gmail

export type GmailCall = (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>

/**
 * Recent messages for the browser's code picker (otp.pickCode): searches the last day, keeps what
 * arrived within `minutes`, and reads the bodies of the few most likely ones (the site's domain or
 * name first). Runs in main; nothing here is shown to the model.
 */
export function gmailCodeSource(call: GmailCall, now: () => number = Date.now) {
  return async (minutes: number, site?: string): Promise<CodeMessage[]> => {
    const since = now() - minutes * 60_000
    const hits = parseGmailSearch(await call('search_threads', { query: 'newer_than:1d -in:sent -in:drafts', pageSize: 15, view: 'THREAD_VIEW_SUMMARY' }))
      .filter((h) => !h.at || h.at >= since)
    const domain = site ? domainOf(site) : ''
    const brand = site ? brandOf(site) : ''
    const hinted = (h: GmailHit): boolean => !!site && ((!!domain && h.from.toLowerCase().includes(domain)) || (brand.length >= 3 && `${h.from} ${h.subject} ${h.snippet}`.toLowerCase().includes(brand)))
    const ranked = [...hits].sort((a, b) => Number(hinted(b)) - Number(hinted(a)) || b.at - a.at).slice(0, 4)
    const out: CodeMessage[] = []
    for (const h of ranked) {
      let body = ''
      try {
        const msgs = parseGmailThread(await call('get_thread', { threadId: h.threadId, messageFormat: 'PLAIN_TEXT' }))
        body = [...msgs].sort((a, b) => b.at - a.at)[0]?.text ?? ''
      } catch { /* the snippet is often enough */ }
      out.push({ from: h.from, text: `${h.subject} ${h.snippet} ${body}`.slice(0, 20_000), at: h.at || now() })
    }
    return out
  }
}
