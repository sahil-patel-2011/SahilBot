import { GMAIL_IMAP, ImapError, withImap, type ImapClient, type ImapOptions } from './imap'
import { GMAIL_SMTP, SmtpError, smtpSend, type SmtpOptions } from './smtp'
import { bareAddress, buildMail, parseMail, replySubjectLine, splitAddresses, type OutgoingMail, type ParsedMail } from './mime'
import type { Duplex } from 'node:stream'

// Gmail with an app password: IMAP to read, search, mark and label (imap.ts), SMTP to send (smtp.ts),
// MIME in between (mime.ts). Also the three ways Connect apps offers to connect Google (Sign in with Google,
// the Mac's Mail app, an app password), saved as one link record. The app password lives only in the
// Keychain-backed secrets store (GMAIL_APP_PASSWORD_SECRET): never in settings, never shown again, never
// in a tool result or an error.

export const GMAIL_APP_PASSWORD_SECRET = 'gmail:appPassword'
export const GOOGLE_LINK_SETTING = 'google:link'
export const GMAIL_APP_PASSWORDS_URL = 'https://myaccount.google.com/apppasswords'

export type GoogleMethod = 'oauth' | 'mail' | 'app-password'
export interface GoogleLink { method: GoogleMethod; address?: string; at: number }
export interface GmailCreds { user: string; pass: string }

/** "abcd efgh ijkl mnop" (as Google shows it) → "abcdefghijklmnop". */
export const normalizeAppPassword = (raw: string): string => String(raw ?? '').replace(/[\s -]+/g, '').toLowerCase()

/** Why an app password can't be right, or null: exactly 16 letters once spaces are gone. */
export function appPasswordProblem(raw: string): string | null {
  const p = normalizeAppPassword(raw)
  if (!p) return 'Paste the 16-letter app password.'
  if (!/^[a-z]{16}$/.test(p)) return `An app password is exactly 16 letters (spaces don't matter); this has ${p.length} character${p.length === 1 ? '' : 's'}${/[^a-z]/.test(p) ? ', and not only letters' : ''}. Copy it again from ${GMAIL_APP_PASSWORDS_URL}.`
  return null
}

export function gmailAddressProblem(raw: string): string | null {
  const a = String(raw ?? '').trim()
  if (!/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(a)) return 'Enter your Gmail address (you@gmail.com, or your Google Workspace address).'
  return null
}

/** Gmail's sign-in and connection errors in words the user can act on. */
export function explainGmailError(e: unknown): string {
  const m = String((e as Error)?.message ?? e)
  if (/application-specific password required|5\.7\.9/i.test(m)) return `Gmail wants an app password here, not your regular Google password. Make one at ${GMAIL_APP_PASSWORDS_URL} (it needs 2-Step Verification on) and paste its 16 letters.`
  if (/AUTHENTICATIONFAILED|invalid credentials|username and password not accepted|5\.7\.8|535/i.test(m)) return `Gmail didn't accept that address and app password. Check the address, make a new app password at ${GMAIL_APP_PASSWORDS_URL}, and make sure IMAP is on (Gmail → Settings → See all settings → Forwarding and POP/IMAP → Enable IMAP).`
  if (/WEBALERT|web login required|sign in via your web browser|5\.7\.14/i.test(m)) return 'Google wants you to sign in once in a web browser (it flagged this sign-in). Sign in to Gmail on the web, then try again.'
  if (/2-?step|two-step/i.test(m)) return `App passwords need 2-Step Verification: turn it on at https://myaccount.google.com/signinoptions/twosv, then make an app password at ${GMAIL_APP_PASSWORDS_URL}.`
  if (/IMAP access is disabled|IMAP is disabled|\[ALERT\].*IMAP/i.test(m)) return 'IMAP is off for this Gmail account. Turn it on: Gmail → Settings → See all settings → Forwarding and POP/IMAP → Enable IMAP, then try again.'
  if ((e instanceof ImapError && e.kind === 'NET') || (e instanceof SmtpError && e.code === 0)) return m
  if (e instanceof ImapError && e.kind === 'TIMEOUT') return 'Gmail didn\'t answer in time. Try again in a moment.'
  return `Gmail error: ${m.slice(0, 300)}`
}

/** How the client reaches Gmail (tests swap in local fake servers). */
export interface GmailTransport {
  imap?: () => Duplex
  smtp?: () => Duplex
}

const imapOpts = (c: GmailCreds, t: GmailTransport): ImapOptions => ({ user: c.user, pass: c.pass, host: GMAIL_IMAP.host, port: GMAIL_IMAP.port, ...(t.imap ? { connect: t.imap } : {}) })
const smtpOpts = (c: GmailCreds, t: GmailTransport): SmtpOptions => ({ user: c.user, pass: c.pass, host: GMAIL_SMTP.host, port: GMAIL_SMTP.port, ...(t.smtp ? { connect: t.smtp } : {}) })

/** One IMAP session on Gmail's All Mail (so UIDs mean the same message everywhere), logged out after. */
export function gmailSession<T>(c: GmailCreds, t: GmailTransport, fn: (imap: ImapClient, allMail: string) => Promise<T>): Promise<T> {
  return withImap(imapOpts(c, t), async (imap) => fn(imap, await imap.allMail()))
}

/** Checks the address and app password by logging in to IMAP once. Throws the plain-words error. */
export async function verifyGmail(c: GmailCreds, t: GmailTransport = {}): Promise<void> {
  try { await withImap(imapOpts(c, t), async () => undefined) } catch (e) { throw new Error(explainGmailError(e)) }
}

export interface GmailSummary { uid: number; from: string; to: string[]; subject: string; date: string; unread: boolean; labels: string[]; size: number }

/** The newest `limit` messages a Gmail search finds (headers only, nothing marked read). */
export async function gmailSearch(imap: ImapClient, allMail: string, query: string, limit = 20): Promise<GmailSummary[]> {
  await imap.select(allMail, false)
  const uids = (await imap.search(query)).slice(-Math.max(1, Math.min(50, limit)))
  const got = await imap.fetch(uids, 'headers')
  return got.sort((a, b) => b.uid - a.uid).map((m) => {
    const p = parseMail(Buffer.concat([m.raw, Buffer.from('\r\n')]))
    return { uid: m.uid, from: p.from, to: p.to, subject: p.subject || '(no subject)', date: p.date || m.internalDate, unread: !m.flags.some((f) => /^\\Seen$/i.test(f)), labels: m.labels.filter((l) => !/^\\(Important|Starred)$/i.test(l)), size: m.size }
  })
}

/** One whole message, parsed (never marked read here). */
export async function gmailRead(imap: ImapClient, allMail: string, uid: number, maxBytes = 10 * 1024 * 1024): Promise<{ mail: ParsedMail; labels: string[]; unread: boolean; size: number; truncated: boolean } | null> {
  await imap.select(allMail, false)
  const [m] = await imap.fetch([uid], 'full', maxBytes)
  if (!m) return null
  return { mail: parseMail(m.raw), labels: m.labels, unread: !m.flags.some((f) => /^\\Seen$/i.test(f)), size: m.size, truncated: m.size > maxBytes }
}

export function formatSummaries(rows: GmailSummary[]): string {
  if (!rows.length) return 'No messages found.'
  return rows.map((r) => `- [uid ${r.uid}] ${r.date} · ${r.from} · "${r.subject}"${r.unread ? ' · unread' : ''}${r.labels.length ? ` · ${r.labels.join(', ')}` : ''}`).join('\n')
}

/** Who a reply goes to: Reply-To (else From); reply-all adds To and Cc, minus the user's own address. */
export function replyRecipients(orig: ParsedMail, self: string, all: boolean): { to: string[]; cc: string[] } {
  const me = self.toLowerCase()
  const replyTo = orig.headers.get('reply-to')?.[0]
  const to = splitAddresses(replyTo || orig.from).filter((a) => bareAddress(a) !== me)
  const seen = new Set(to.map(bareAddress))
  const cc = all ? [...orig.to, ...orig.cc].filter((a) => { const b = bareAddress(a); if (b === me || seen.has(b)) return false; seen.add(b); return true }) : []
  return { to: to.length ? to : splitAddresses(orig.from), cc }
}

/** Sends one message over SMTP: the envelope gets every recipient, the headers never show Bcc. */
export async function gmailSend(c: GmailCreds, t: GmailTransport, m: OutgoingMail & { bcc?: string[] }): Promise<{ messageId: string; recipients: string[] }> {
  const raw = buildMail(m)
  const messageId = /^Message-ID: (.+)$/im.exec(raw)?.[1] ?? ''
  const rcpt = [...new Set([...m.to, ...(m.cc ?? []), ...(m.bcc ?? [])].map(bareAddress))]
  try {
    await smtpSend(smtpOpts(c, t), { from: m.from, to: rcpt }, raw)
  } catch (e) { throw new Error(explainGmailError(e)) }
  return { messageId, recipients: rcpt }
}

export { replySubjectLine }
