import { createHmac } from 'node:crypto'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { publicSuffix, registrableDomain } from './psl'

/**
 * One-time codes for the user's OWN accounts, password-manager style: authenticator (TOTP, RFC 6238)
 * secrets saved with a login, and codes the site just sent by email or text. Codes are generated or
 * extracted here in main and typed straight into the page; they never reach the model, logs or
 * notifications. (CAPTCHAs are a different thing: always the user's to solve.)
 */

export type OtpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512'
export interface TotpConfig { secret: string; digits: number; period: number; algorithm: OtpAlgorithm; issuer?: string; account?: string }

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Decode(input: string): Buffer {
  const s = String(input ?? '').toUpperCase().replace(/[\s-]+/g, '').replace(/=+$/, '')
  if (!s || /[^A-Z2-7]/.test(s)) throw new Error('That authenticator key is not valid base32 (letters A–Z and digits 2–7).')
  let bits = 0, value = 0
  const out: number[] = []
  for (const ch of s) {
    value = (value << 5) | B32.indexOf(ch)
    bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8 }
  }
  return Buffer.from(out)
}

/** A setup key ("JBSW Y3DP …") or an otpauth://totp/… URI from a QR code. */
export function parseTotp(input: string): TotpConfig {
  const t = String(input ?? '').trim()
  if (/^otpauth:\/\//i.test(t)) {
    let u: URL
    try { u = new URL(t) } catch { throw new Error('That otpauth link is not valid.') }
    if (u.hostname.toLowerCase() !== 'totp') throw new Error('Only time-based (TOTP) authenticator keys are supported.')
    const q = u.searchParams
    const secret = (q.get('secret') ?? '').replace(/\s+/g, '').toUpperCase()
    base32Decode(secret)
    const algorithm = (q.get('algorithm') ?? 'SHA1').toUpperCase().replace('-', '') as OtpAlgorithm
    if (!['SHA1', 'SHA256', 'SHA512'].includes(algorithm)) throw new Error(`Unsupported algorithm ${algorithm}.`)
    const digits = Number(q.get('digits') ?? 6)
    const period = Number(q.get('period') ?? 30)
    if (![6, 7, 8].includes(digits)) throw new Error('Codes must be 6 to 8 digits.')
    if (!Number.isInteger(period) || period < 10 || period > 300) throw new Error('The code period must be 10 to 300 seconds.')
    const label = decodeURIComponent(u.pathname.replace(/^\//, ''))
    const [li, account] = label.includes(':') ? label.split(/:(.*)/s) : [undefined, label]
    return { secret, digits, period, algorithm, issuer: q.get('issuer') ?? li ?? undefined, account: account || undefined }
  }
  const secret = t.replace(/[\s-]+/g, '').toUpperCase()
  base32Decode(secret)
  return { secret, digits: 6, period: 30, algorithm: 'SHA1' }
}

/** HOTP (RFC 4226) with the RFC 6238 hash choices. */
export function hotp(key: Buffer, counter: number, digits = 6, algorithm: OtpAlgorithm = 'SHA1'): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(Math.floor(counter)))
  const h = createHmac(algorithm.toLowerCase(), key).update(msg).digest()
  const off = h[h.length - 1] & 0x0f
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}

/** The current TOTP code (RFC 6238) and seconds until it changes. */
export function totp(c: TotpConfig, nowMs = Date.now()): { code: string; remaining: number } {
  const t = Math.floor(nowMs / 1000)
  return { code: hotp(base32Decode(c.secret), Math.floor(t / c.period), c.digits, c.algorithm), remaining: c.period - (t % c.period) }
}

/** Raw-key variant for the RFC test vectors (ASCII keys). */
export function totpRaw(key: Buffer, unixSeconds: number, digits = 8, period = 30, algorithm: OtpAlgorithm = 'SHA1'): string {
  return hotp(key, Math.floor(unixSeconds / period), digits, algorithm)
}

// ------------------------------------------------------------------ codes in messages

const KEYWORD = /(code|otp|passcode|pass code|pin|verification|verify|security|one[- ]time|2fa|two[- ]factor|sign[- ]?in|log[- ]?in|authenticat|confirm)/i

/**
 * The one-time code in a message: a 4–8 digit number (or "G-123456") near a word like "code" or
 * "verification". Dates, years, prices and phone numbers don't count.
 */
export function extractCode(text: string): string | null {
  const t = String(text ?? '').replace(/\s+/g, ' ')
  const google = /\bG-(\d{4,8})\b/.exec(t)
  if (google) return google[1]
  const re = /(?<![\d$€£]|\d[.,:/-])(\d{4,8}|\d{3}[ -]\d{3})(?![\d%]|[.,:/-]\d)/g
  let best: { code: string; score: number } | null = null
  for (const m of t.matchAll(re)) {
    const code = m[1].replace(/[ -]/g, '')
    const i = m.index ?? 0
    const near = t.slice(Math.max(0, i - 60), i + m[0].length + 40)
    if (!KEYWORD.test(near)) continue
    if (/^(19|20)\d\d$/.test(code) && !/code/i.test(t.slice(Math.max(0, i - 25), i))) continue
    const score = (/code|otp|passcode/i.test(t.slice(Math.max(0, i - 40), i)) ? 2 : 1) + (code.length === 6 ? 1 : 0)
    if (!best || score > best.score) best = { code, score }
  }
  return best?.code ?? null
}

/** "shop.example.co.uk" → "example": the word a site's messages usually mention (Public Suffix List aware). */
export function brandOf(host: string): string {
  const reg = registrableDomain(host)
  if (!reg) return ''
  if (!reg.includes('.')) return reg
  return reg.slice(0, reg.length - publicSuffix(reg).length - 1)
}

/** The registrable domain of a host (PSL): "chase.com.ve" stays "chase.com.ve", never "com.ve" or "chase.com". */
export function domainOf(host: string): string {
  return registrableDomain(host)
}

export interface CodeMessage { from: string; text: string; at: number }

/** The registrable domain an email sender writes from ("Acme <no-reply@mail.acme.test>" → "acme.test"); '' for phone numbers and short codes. */
export function senderDomain(from: string): string {
  const m = /@([a-z0-9.-]+\.[a-z]{2,})>?\s*$/i.exec(String(from ?? '').trim()) ?? /@([a-z0-9.-]+\.[a-z]{2,})/i.exec(String(from ?? ''))
  return m ? registrableDomain(m[1]) : ''
}

/** A sender as one key (lowercase address, or digits of a phone number / short code). */
export function senderKey(from: string): string {
  const f = String(from ?? '').trim().toLowerCase()
  const addr = /<([^>]+)>/.exec(f)?.[1] ?? f
  if (/@/.test(addr)) return addr.trim()
  const digits = addr.replace(/[^\d]/g, '')
  return digits.length >= 3 ? digits : addr.replace(/\s+/g, ' ')
}

/** A short snippet of a message for the approval card, with the code itself hidden. */
export function codeSnippet(text: string, code: string, max = 110): string {
  let t = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim()
  if (code) {
    const spaced = code.length === 6 ? `${code.slice(0, 3)}[ -]?${code.slice(3)}` : code
    t = t.replace(new RegExp(`(?<!\\d)(?:G-)?${spaced}(?!\\d)`, 'g'), '•'.repeat(code.length))
  }
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export interface PickedCode { code: string; from: string; text: string; matched: 'domain' | 'mapping' }

/**
 * The code meant for this site, newest first. A message only counts when its sender is the site
 * itself (the sender's registrable domain equals the site's, by the Public Suffix List) or a sender
 * the user confirmed for this site. A lone code from an unknown sender is never used on its own: see
 * `codeCandidate`, which the approval card shows (sender and snippet) so the user can confirm it.
 */
export function pickCode(msgs: CodeMessage[], host: string, sinceMs: number, confirmedSenders: string[] = []): PickedCode | null {
  const site = registrableDomain(host)
  if (!site) return null
  const keys = new Set(confirmedSenders.map(senderKey).filter(Boolean))
  for (const m of recentWithCodes(msgs, sinceMs)) {
    if (senderDomain(m.m.from) === site) return { code: m.code, from: m.m.from, text: m.m.text, matched: 'domain' }
    if (keys.has(senderKey(m.m.from))) return { code: m.code, from: m.m.from, text: m.m.text, matched: 'mapping' }
  }
  return null
}

/**
 * The best unconfirmed candidate for the user to look at: the newest message with a code that names
 * the site's brand, else the newest message with a code. Only ever used after the user approved it
 * on a card that shows its sender and snippet.
 */
export function codeCandidate(msgs: CodeMessage[], host: string, sinceMs: number): { code: string; from: string; text: string } | null {
  const brand = brandOf(host)
  const all = recentWithCodes(msgs, sinceMs)
  const hit = all.find(({ m }) => brand.length >= 3 && `${m.from} ${m.text}`.toLowerCase().includes(brand)) ?? all[0]
  return hit ? { code: hit.code, from: hit.m.from, text: hit.m.text } : null
}

function recentWithCodes(msgs: CodeMessage[], sinceMs: number): Array<{ m: CodeMessage; code: string }> {
  return msgs.filter((m) => m.at >= sinceMs).sort((a, b) => b.at - a.at)
    .map((m) => ({ m, code: extractCode(m.text) }))
    .filter((x): x is { m: CodeMessage; code: string } => !!x.code)
}

// ------------------------------------------------------------------ SMS (Messages) and Mail.app

export const FULL_DISK_HELP = 'SahilBot needs Full Disk Access to read codes from Messages: open System Settings → Privacy & Security → Full Disk Access, turn on SahilBot, then try again. Until then, ask the user for the code.'

/** Apple's Messages dates: nanoseconds (or seconds on old macOS) since 2001-01-01. */
const APPLE_EPOCH = Date.UTC(2001, 0, 1)
export function appleDate(v: number | bigint): number {
  const n = Number(v)
  return APPLE_EPOCH + (n > 1e12 ? n / 1e6 : n * 1000)
}

/** Text from an attributedBody blob (an archived NSAttributedString): the readable run after NSString. */
export function attributedText(blob: Uint8Array | null | undefined): string {
  if (!blob) return ''
  const s = Buffer.from(blob).toString('utf8')
  const i = s.indexOf('NSString')
  const tail = i >= 0 ? s.slice(i + 8) : s
  const runs = tail.match(/[\p{L}\p{N}\p{P}\p{Zs}$€£]{4,}/gu) ?? []
  return runs.slice(0, 3).join(' ')
}

/** Text messages received in the last few minutes, read-only from the Messages database. */
export async function recentTexts(sinceMs: number, dbPath = join(homedir(), 'Library', 'Messages', 'chat.db')): Promise<CodeMessage[]> {
  const { DatabaseSync } = await import('node:sqlite')
  let db: InstanceType<typeof DatabaseSync>
  try {
    try { db = new DatabaseSync(`file:${encodeURI(dbPath)}?mode=ro&immutable=1`, { readOnly: true } as never) } catch { db = new DatabaseSync(dbPath, { readOnly: true } as never) }
  } catch (e) {
    const msg = (e as Error).message
    if (/authori|permission|not permitted|unable to open|EPERM|EACCES/i.test(msg)) throw new Error(FULL_DISK_HELP)
    throw e
  }
  try {
    const since = BigInt(Math.floor((sinceMs - APPLE_EPOCH) * 1e6))
    const rows = db.prepare(`SELECT m.text AS text, m.attributedBody AS body, m.date AS date, h.id AS sender
      FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE m.is_from_me = 0 AND m.date > ? ORDER BY m.date DESC LIMIT 40`).all(since) as Array<{ text: string | null; body: Uint8Array | null; date: number | bigint; sender: string | null }>
    return rows.map((r) => ({ from: r.sender ?? '', text: r.text || attributedText(r.body), at: appleDate(r.date) }))
  } catch (e) {
    if (/authori|permission|not permitted|unable to open/i.test((e as Error).message)) throw new Error(FULL_DISK_HELP)
    throw e
  } finally {
    try { db.close() } catch { /* closed */ }
  }
}

/** Recent inbox messages from Mail.app, only when Mail is already open (it is never launched for this). */
export function recentMail(minutes = 10): Promise<CodeMessage[]> {
  // Mail filters by date itself; the result is newest-ish and all within the window.
  const script = `if application "Mail" is not running then return "NOT_RUNNING"
tell application "Mail"
  set cutoff to (current date) - ${Math.round(minutes * 60)}
  set out to ""
  repeat with m in (messages of inbox whose date received > cutoff)
    set out to out & (sender of m) & (ASCII character 30) & (subject of m) & " " & (content of m) & (ASCII character 29)
  end repeat
  return out
end tell`
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 20_000, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err) return reject(new Error('Mail could not be read (allow SahilBot to control Mail in System Settings → Privacy & Security → Automation).'))
      const out = String(stdout ?? '').trim()
      if (out === 'NOT_RUNNING') return reject(new Error('Mail is not open, so emailed codes can\'t be read. Ask the user for the code, or to open Mail.'))
      const now = Date.now()
      resolve(out.split('\u001d').filter(Boolean).map((rec) => {
        const [from, text] = rec.split('\u001e')
        return { from: from ?? '', text: (text ?? '').slice(0, 20_000), at: now }
      }))
    })
  })
}

// ------------------------------------------------------------------ email source (Gmail connector, then Mail.app)

export type EmailCodeSource = (minutes: number, site?: string) => Promise<CodeMessage[]>
let connectorEmail: { source: EmailCodeSource; available: () => boolean } | null = null

/** Registers the Gmail connector as the first place to look for emailed codes (index.ts wires it). */
export function setEmailCodeSource(source: EmailCodeSource | null, available: () => boolean = () => true): void {
  connectorEmail = source ? { source, available } : null
}

/**
 * Recent email for fill_otp(source: "email"): the Gmail connector when it's connected, else Mail.app
 * (only if Mail is already open). Messages stay in main: the browser picks the code and types it.
 */
export async function recentEmail(minutes = 10, site?: string, mailApp: (minutes: number) => Promise<CodeMessage[]> = recentMail): Promise<CodeMessage[]> {
  const gmail = connectorEmail?.available() ? connectorEmail : null
  let gmailOk = false
  if (gmail) {
    try {
      const got = await gmail.source(minutes, site)
      gmailOk = true
      if (got.length) return got
    } catch { /* fall back to Mail.app */ }
  }
  try {
    return await mailApp(minutes)
  } catch (e) {
    // Gmail answered (just without a code yet): "no code" is the truer message than "Mail is closed".
    if (gmailOk) return []
    throw e
  }
}
