// Resend's REST API (no Electron, no tool plumbing): requests with the key pinned to api.resend.com,
// error mapping, key verification and the send body. The tool is agent/tools/resend.ts.
//
// Resend (resend.com): transactional email over its REST API, with the user's own API key (Connect apps →
// Resend; kept in the Keychain as "resendKey", never shown to the model or the renderer). The key is only
// ever sent to https://api.resend.com: every request URL is checked against that origin before the key is
// attached. Sending is a send hard stop (asks), lifted only when every recipient is trusted for this bot
// (agent/trusted.ts). Errors come back in plain words: unverified domain, test mode, rate limit, bad key.
//
// API (resend.com/docs/api-reference): POST /emails {from, to[] (≤50), subject, cc, bcc, reply_to, html,
// text, attachments[{filename, content (base64)}]} → {id}; GET /emails/{id} → {object, id, to, from,
// subject, created_at, last_event, …}; GET /emails?limit= → {object: 'list', has_more, data[]};
// GET /domains → {object: 'list', data[{id, name, status, region, capabilities}]}. Auth: Bearer key; a
// User-Agent is required (403 / 1010 without one). 10 requests a second per team.

export const RESEND_ORIGIN = 'https://api.resend.com'
export const RESEND_KEY_SECRET = 'resendKey'
export const RESEND_KEYS_URL = 'https://resend.com/api-keys'
/** Attachments' total size before base64 (Resend's limit is 40 MB after encoding). */
export const RESEND_ATTACH_MAX = 15 * 1024 * 1024
const MAX_RECIPIENTS = 50
const UA = 'SahilBot/1.0 (+https://resend.com/docs)'

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>

/** A Resend error with its HTTP status and Resend's error name. */
export class ResendError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); this.name = 'ResendError' }
}

/** Resend's answer to a failed request, in words the user can act on. */
export function explainResendError(status: number, body: string): ResendError {
  let j: { name?: string; message?: string; error?: string } = {}
  try { j = JSON.parse(body) as typeof j } catch { /* not JSON */ }
  const name = String(j.name ?? '')
  const msg = String(j.message ?? j.error ?? body ?? '').slice(0, 400)
  const say = (m: string): ResendError => new ResendError(m, status, name || String(status))
  if (name === 'restricted_api_key' && status === 401) return say('This Resend API key can only send email, so it can\'t list domains or sent emails. Sending still works; for the rest, make a "Full access" key at resend.com/api-keys and paste it under Connect apps → Resend.')
  if (name === 'missing_api_key' || name === 'invalid_api_key' || name === 'suspended_api_key' || (name === 'restricted_api_key' && status === 403) || /api key is (invalid|not active)|invalid api key/i.test(msg)) {
    return say(`Resend didn't accept the API key${name === 'suspended_api_key' ? ' (it is suspended)' : ''}. Make a new one at ${RESEND_KEYS_URL} and paste it under Connect apps → Resend.`)
  }
  if (/domain.*not verified|not verified.*domain|verify (a|your) domain/i.test(msg)) return say(`The "from" address's domain isn't verified in Resend. Send from a verified domain (resend action "domains" lists them), or verify this one at resend.com/domains (it takes a few DNS records).`)
  if (/testing emails|own email address|test sends|only send testing/i.test(msg)) return say('Resend is in test mode for this account: it only sends to your own address until you verify a domain at resend.com/domains, then send from that domain.')
  if (name === 'daily_quota_exceeded') return say('Resend\'s daily sending quota is used up. It resets at midnight UTC, or upgrade the Resend plan.')
  if (name === 'monthly_quota_exceeded') return say('Resend\'s monthly sending quota is used up. Upgrade the Resend plan (or turn on pay-as-you-go) to send more this month.')
  if (status === 429 || name === 'rate_limit_exceeded') return say('Resend\'s rate limit was hit (10 requests a second per team). Wait a few seconds and try again.')
  if (status === 403 && /1010/.test(body)) return say('Resend refused the request (error 1010: a missing User-Agent). This is a SahilBot bug; try again later.')
  if (status === 404) return say(`Resend has no such email or endpoint${msg ? ` (${msg})` : ''}.`)
  if (status === 422 || status === 400 || name === 'validation_error') return say(`Resend rejected the email: ${msg || 'a field is invalid'}.`)
  if (status >= 500) return say('Resend is having trouble right now. Try again in a minute (status.resend.com).')
  return say(`Resend error ${status}${msg ? `: ${msg}` : ''}.`)
}

/**
 * One Resend API call. The key goes only to api.resend.com: anything else (a redirect target, a URL with
 * another origin) is refused before the request is made.
 */
export async function resendRequest<T>(f: Fetch, key: string, method: 'GET' | 'POST', path: string, body?: unknown, o: { signal?: AbortSignal; idempotencyKey?: string } = {}): Promise<T> {
  const url = new URL(path, RESEND_ORIGIN)
  if (url.origin !== RESEND_ORIGIN) throw new Error('Refusing to send the Resend key anywhere but api.resend.com.')
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, 'User-Agent': UA, Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (o.idempotencyKey) headers['Idempotency-Key'] = o.idempotencyKey.slice(0, 256)
  const r = await f(url.toString(), { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: o.signal })
  const text = await r.text()
  if (r.status < 200 || r.status >= 300) throw explainResendError(r.status, text)
  try { return JSON.parse(text) as T } catch { throw new ResendError('Resend sent back something that isn\'t JSON.', r.status, 'bad_response') }
}

export interface ResendDomain { id: string; name: string; status: string; region?: string; capabilities?: { sending?: string; receiving?: string } }

/** Checks a key with one cheap read (GET /domains). A send-only key is valid too (Resend says so with restricted_api_key). */
export async function verifyResendKey(f: Fetch, key: string, signal?: AbortSignal): Promise<{ ok: true; domains: ResendDomain[] | null } | { ok: false; error: string }> {
  try {
    const r = await resendRequest<{ data?: ResendDomain[] }>(f, key, 'GET', '/domains', undefined, { signal })
    return { ok: true, domains: r.data ?? [] }
  } catch (e) {
    if (e instanceof ResendError && e.code === 'restricted_api_key' && e.status === 401) return { ok: true, domains: null }
    return { ok: false, error: (e as Error).message }
  }
}

type Attachment = { path: string; filename?: string }
export interface ResendArgs {
  action: 'send' | 'get' | 'list' | 'domains'
  from?: string; to?: string | string[]; cc?: string | string[]; bcc?: string | string[]
  subject?: string; text?: string; html?: string; reply_to?: string | string[]
  attachments?: Attachment[]
  id?: string; limit?: number
}

const list = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? String(v).split(/[,;]+/) : []).map((x) => String(x).trim()).filter(Boolean)
const ADDRESS = /^(?:[^<>@\s][^<>@]*<\s*)?[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}\s*>?$/i

/** The JSON body of a send, checked: Resend's field names, recipients ≤ 50, a body, attachments as base64. */
export function resendSendBody(a: ResendArgs, readFile: (p: Attachment) => { filename: string; content: Buffer }): Record<string, unknown> {
  const to = list(a.to), cc = list(a.cc), bcc = list(a.bcc), replyTo = list(a.reply_to)
  if (!a.from?.trim()) throw new Error('send needs "from": an address on a domain verified in Resend (action "domains" lists them), e.g. "Sahil <hello@yourdomain.com>".')
  if (!to.length) throw new Error('send needs at least one "to" address.')
  if (!a.subject?.trim()) throw new Error('send needs a subject.')
  if (!a.text?.trim() && !a.html?.trim()) throw new Error('send needs "text" and/or "html".')
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw new Error(`Resend takes at most ${MAX_RECIPIENTS} recipients per email.`)
  const bad = [a.from, ...to, ...cc, ...bcc, ...replyTo].find((x) => !ADDRESS.test(String(x).trim()))
  if (bad) throw new Error(`"${String(bad).slice(0, 80)}" isn't an email address.`)
  let total = 0
  const attachments = (a.attachments ?? []).slice(0, 20).map((x) => {
    const f = readFile(x)
    total += f.content.length
    if (total > RESEND_ATTACH_MAX) throw new Error(`Attachments are over ${Math.round(RESEND_ATTACH_MAX / 1024 / 1024)} MB in total; send a link instead.`)
    return { filename: f.filename, content: f.content.toString('base64') }
  })
  return {
    from: a.from.trim(), to, subject: a.subject.trim(),
    ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}), ...(replyTo.length ? { reply_to: replyTo.length === 1 ? replyTo[0] : replyTo } : {}),
    ...(a.text?.trim() ? { text: a.text } : {}), ...(a.html?.trim() ? { html: a.html } : {}),
    ...(attachments.length ? { attachments } : {})
  }
}

