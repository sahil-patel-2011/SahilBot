import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { callbackPage, redactSecret } from '../connectors'
import { ENTRA_CLIENT_ID } from '../oauth-clients'
import { htmlToText } from './mime'

// Outlook (Outlook.com and Microsoft 365 mail and calendar), natively: SahilBot's own tool calls Microsoft
// Graph with the user's own Microsoft sign-in. Microsoft's hosted Microsoft 365 MCP server only serves
// Anthropic's Claude apps, so there is no MCP server to connect to (connectors.ts, "Not listed").
//
// Sign-in: Microsoft identity platform, public client (no secret), authorization code + PKCE (S256) on
// /common (work, school and personal accounts). The redirect is http://localhost:<free port> on a one-shot
// listener bound to 127.0.0.1: Entra's "Mobile and desktop applications" platform takes http://localhost
// with any port. The client is the user's own Entra app (Connect apps → Outlook → Advanced) when they set
// one, else SahilBot's built-in one (resources/oauth-clients.json "outlook", oauth-clients.ts).
//
// Tokens: the refresh token lives only in the Keychain-backed secrets store (OUTLOOK_REFRESH_SECRET), never
// in settings, the renderer, the model or an error. The access token stays in memory with its expiry. A
// refresh saves the rotated refresh token; invalid_grant (expired or revoked) forgets everything and says
// "sign in again". Graph requests go only to https://graph.microsoft.com, tokens only to
// login.microsoftonline.com; every other URL is refused before a token is attached.

export const OUTLOOK_REFRESH_SECRET = 'outlook:refreshToken'
/** The user's own Entra application (client) ID (not a secret). */
export const OUTLOOK_CLIENT_SETTING = 'outlook:clientId'
/** Who is signed in and with which client: { address, clientId, at } (no secrets). */
export const OUTLOOK_ACCOUNT_SETTING = 'outlook:account'
export const LOGIN_ORIGIN = 'https://login.microsoftonline.com'
export const AUTHORIZE_URL = `${LOGIN_ORIGIN}/common/oauth2/v2.0/authorize`
export const TOKEN_URL = `${LOGIN_ORIGIN}/common/oauth2/v2.0/token`
export const GRAPH_ORIGIN = 'https://graph.microsoft.com'
export const GRAPH_BASE = `${GRAPH_ORIGIN}/v1.0`
export const OUTLOOK_SCOPES = 'offline_access openid email User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite'
export const ENTRA_PORTAL = 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'
const SIGN_IN_TIMEOUT = 5 * 60_000
const UA = 'SahilBot/1.0'

export const NOT_CONNECTED = 'Outlook isn\'t connected. Ask the user to open Connect apps → Outlook and press "Sign in with Microsoft".'
export const SIGN_IN_AGAIN = 'Your Outlook sign-in expired or was turned off. Sign in again: Connect apps → Outlook → "Sign in with Microsoft".'
const NO_CLIENT = 'This copy of SahilBot has no Microsoft app yet. Open Connect apps → Outlook, register a free app at entra.microsoft.com (the steps are there) and paste its client ID.'

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string>; headers?: { get(name: string): string | null } }>

export interface OutlookStatus {
  /** This build ships SahilBot's own Microsoft app. */
  builtin: boolean
  /** The user saved their own Entra app's client ID. */
  ownClient: boolean
  /** That client ID (not a secret), so the panel can show which app is in use. */
  ownClientId?: string
  connected: boolean
  address?: string
}

export interface DbLike { getSetting<T>(k: string): T | undefined | null; setSetting(k: string, v: unknown): void }
export interface SecretsLike { get(k: string): string | undefined; set(k: string, v: string | null): void }

/** An Outlook (Graph or sign-in) error, in words the user can act on, with its HTTP status. */
export class OutlookError extends Error {
  constructor(message: string, readonly status = 0, readonly code = '') { super(message); this.name = 'OutlookError' }
}

// ---------------------------------------------------------------- sign-in pieces

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** A PKCE pair: a random verifier (43 characters) and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: pkceChallenge(verifier) }
}
export const pkceChallenge = (verifier: string): string => b64url(createHash('sha256').update(verifier).digest())

/** Microsoft's sign-in page for this client, redirect and PKCE challenge. */
export function authorizeUrl(o: { clientId: string; redirectUri: string; state: string; challenge: string; scopes?: string }): string {
  const u = new URL(AUTHORIZE_URL)
  u.searchParams.set('client_id', o.clientId)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('redirect_uri', o.redirectUri)
  u.searchParams.set('response_mode', 'query')
  u.searchParams.set('scope', o.scopes ?? OUTLOOK_SCOPES)
  u.searchParams.set('state', o.state)
  u.searchParams.set('code_challenge', o.challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('prompt', 'select_account')
  return u.toString()
}

/** What to do about an error Microsoft's sign-in sent back (to the browser or from the token endpoint). */
export function explainSignInError(error: string, description = ''): string {
  const d = description.replace(/\s+/g, ' ').slice(0, 300)
  const aad = /AADSTS(\d+)/.exec(d)?.[1]
  if (error === 'access_denied' || aad === '65004') return 'Sign-in was cancelled or the permissions weren\'t allowed. Press "Sign in with Microsoft" to try again.'
  if (aad === '700016' || error === 'unauthorized_client') return 'Microsoft doesn\'t know this app\'s client ID (or it isn\'t set up for personal and work accounts). Check the client ID under Connect apps → Outlook → Advanced.'
  if (aad === '50011' || aad === '500113') return 'The Microsoft app doesn\'t list SahilBot\'s redirect. In entra.microsoft.com → your app → Authentication, add the platform "Mobile and desktop applications" with the redirect http://localhost.'
  if (aad === '7000218' || aad === '700025' || error === 'invalid_client') return 'The Microsoft app isn\'t set up as a desktop (public) app. In entra.microsoft.com → your app → Authentication, use the platform "Mobile and desktop applications" with http://localhost (not Web), and turn on "Allow public client flows".'
  if (aad === '65001' || error === 'consent_required' || error === 'interaction_required') return 'Microsoft needs you to allow SahilBot\'s permissions. Press "Sign in with Microsoft" and accept them (a work account may need an admin to approve).'
  if (aad === '90072' || aad === '50020') return 'This account can\'t sign in to that Microsoft app. Register the app for "Accounts in any organizational directory and personal Microsoft accounts".'
  if (error === 'invalid_scope') return 'Microsoft refused the permissions SahilBot asks for. In the Entra app, add the delegated Microsoft Graph permissions Mail.ReadWrite, Mail.Send, Calendars.ReadWrite, User.Read and offline_access.'
  return `Microsoft sign-in failed${error ? ` (${error})` : ''}${d ? `: ${d}` : ''}.`
}

export interface Loopback {
  redirectUri: string
  /** The authorization code, once the browser comes back with the right state. */
  code: Promise<string>
  /** Stops listening (a code still pending is rejected). */
  close(): void
}

/**
 * A one-shot listener on 127.0.0.1 (a free port) for the browser's return. Only a request carrying `state`
 * counts: a wrong one is refused (400) and the listener keeps waiting. It gives up after `timeoutMs`.
 */
export function startLoopback(state: string, o: { timeoutMs?: number } = {}): Promise<Loopback> {
  return new Promise((resolveStart, rejectStart) => {
    let settle: { ok: (c: string) => void; fail: (e: Error) => void } | null = null
    const code = new Promise<string>((ok, fail) => { settle = { ok, fail } })
    code.catch(() => undefined)
    let done = false
    const finish = (e: Error | null, c?: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      setTimeout(() => server.close(), 50)
      if (e) settle!.fail(e); else settle!.ok(c!)
    }
    const page = (res: import('node:http').ServerResponse, status: number, html: string): void => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
      res.end(html)
    }
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://localhost')
      if (req.method !== 'GET' || u.pathname !== '/') { res.writeHead(404); res.end(); return }
      if (done) { page(res, 410, callbackPage(false, { app: 'Outlook', hint: 'This sign-in already finished. Go back to SahilBot.' })); return }
      if (u.searchParams.get('state') !== state) {
        page(res, 400, callbackPage(false, { app: 'Outlook', hint: 'This sign-in link was out of date. Go back to SahilBot and press "Sign in with Microsoft" again.' }))
        return
      }
      const err = u.searchParams.get('error')
      if (err) {
        const why = explainSignInError(err, u.searchParams.get('error_description') ?? '')
        page(res, 200, callbackPage(false, { app: 'Outlook', hint: 'Go back to SahilBot: it shows what to do.', detail: why }))
        finish(new OutlookError(why, 0, err))
        return
      }
      const c = u.searchParams.get('code')
      if (!c) { page(res, 400, callbackPage(false, { app: 'Outlook' })); return }
      page(res, 200, callbackPage(true, { app: 'Outlook' }))
      finish(null, c)
    })
    const timer = setTimeout(() => finish(new OutlookError('Sign-in to Outlook didn\'t finish in the browser within 5 minutes. Press "Sign in with Microsoft" to try again.', 0, 'timeout')), o.timeoutMs ?? SIGN_IN_TIMEOUT)
    server.on('error', (e) => { clearTimeout(timer); rejectStart(e) })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolveStart({ redirectUri: `http://localhost:${port}`, code, close: () => finish(new OutlookError('Sign-in was cancelled.', 0, 'cancelled')) })
    })
  })
}

// ---------------------------------------------------------------- the connection

interface Account { address?: string; clientId?: string; at: number }
interface TokenAnswer { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }

export class OutlookConnect {
  private access: { token: string; expiresAt: number; clientId: string } | null = null
  private refreshing: Promise<string> | null = null
  private pending: Loopback | null = null
  private f: Fetch

  constructor(private d: {
    db: DbLike
    secrets: SecretsLike
    /** SahilBot's own Microsoft app, when this build ships one. */
    builtinClientId?: () => string | undefined
    fetch?: Fetch
    /** Opens Microsoft's sign-in page in the user's browser. */
    openExternal?: (url: string) => unknown
    /** The browser came back with a code: bring SahilBot to the front. */
    onSignedIn?: () => void
    changed?: () => void
    now?: () => number
    signInTimeoutMs?: number
  }) {
    this.f = d.fetch ?? ((url, init) => fetch(url, { ...init, redirect: 'error' }) as never)
  }

  private now(): number { return this.d.now?.() ?? Date.now() }

  private ownClient(): string | undefined {
    const v = this.d.db.getSetting<string>(OUTLOOK_CLIENT_SETTING)
    return typeof v === 'string' && ENTRA_CLIENT_ID.test(v) ? v : undefined
  }

  /** The client in use: the user's own app when they set one, else SahilBot's built-in one. */
  clientId(): string | undefined {
    return this.ownClient() ?? this.d.builtinClientId?.()
  }

  private account(): Account | null {
    const v = this.d.db.getSetting<Account>(OUTLOOK_ACCOUNT_SETTING)
    return v && typeof v === 'object' ? v : null
  }

  connected(): boolean {
    if (!this.d.secrets.get(OUTLOOK_REFRESH_SECRET)) return false
    const a = this.account()
    return !a?.clientId || a.clientId === this.clientId()
  }

  status(): OutlookStatus {
    const own = this.ownClient()
    const connected = this.connected()
    const address = connected ? this.account()?.address : undefined
    return { builtin: !!this.d.builtinClientId?.(), ownClient: !!own, ...(own ? { ownClientId: own } : {}), connected, ...(address ? { address } : {}) }
  }

  /**
   * Opens Microsoft's sign-in page in the browser and resolves once signed in (or throws the reason). A
   * second press while one is waiting starts over.
   */
  async signIn(): Promise<OutlookStatus> {
    const clientId = this.clientId()
    if (!clientId) throw new OutlookError(NO_CLIENT)
    this.pending?.close()
    const { verifier, challenge } = pkcePair()
    const state = b64url(randomBytes(24))
    const lb = await startLoopback(state, { timeoutMs: this.d.signInTimeoutMs })
    this.pending = lb
    let code: string
    try {
      await this.d.openExternal?.(authorizeUrl({ clientId, redirectUri: lb.redirectUri, state, challenge }))
      code = await lb.code
    } finally {
      lb.close()
      if (this.pending === lb) this.pending = null
    }
    this.d.onSignedIn?.()
    const tok = await this.tokenRequest({ client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: lb.redirectUri, code_verifier: verifier, scope: OUTLOOK_SCOPES })
    if (!tok.refresh_token || !tok.access_token) throw new OutlookError('Microsoft signed you in but sent no refresh token (offline_access). Add the offline_access permission to the Entra app and sign in again.')
    this.keep(tok, clientId)
    let address: string | undefined
    try {
      const me = await this.request<{ mail?: string | null; userPrincipalName?: string }>('GET', '/me?$select=mail,userPrincipalName')
      address = (me.mail || me.userPrincipalName || '').trim() || undefined
    } catch { /* the address is only for display */ }
    this.d.db.setSetting(OUTLOOK_ACCOUNT_SETTING, { ...(address ? { address } : {}), clientId, at: this.now() } satisfies Account)
    this.d.changed?.()
    return this.status()
  }

  /** Forgets the sign-in: refresh token, access token, account. */
  disconnect(): void {
    this.pending?.close()
    this.clear()
    this.d.changed?.()
  }

  private clear(): void {
    this.access = null
    this.d.secrets.set(OUTLOOK_REFRESH_SECRET, null)
    this.d.db.setSetting(OUTLOOK_ACCOUNT_SETTING, null)
  }

  /** Saves (or with null, forgets) the user's own Entra app. A different client can't use the old sign-in. */
  setClient(clientId: string | null): OutlookStatus {
    const before = this.clientId()
    if (clientId === null || clientId === '') {
      this.d.db.setSetting(OUTLOOK_CLIENT_SETTING, null)
    } else {
      const id = String(clientId).trim().toLowerCase()
      if (!ENTRA_CLIENT_ID.test(id)) throw new OutlookError('That isn\'t an Entra client ID. Copy the "Application (client) ID" from your app\'s Overview page: it looks like 1a2b3c4d-1234-5678-9abc-0123456789ab.')
      this.d.db.setSetting(OUTLOOK_CLIENT_SETTING, id)
    }
    if (this.clientId() !== before) this.clear()
    this.d.changed?.()
    return this.status()
  }

  private keep(tok: TokenAnswer, clientId: string): void {
    if (tok.refresh_token) this.d.secrets.set(OUTLOOK_REFRESH_SECRET, tok.refresh_token)
    this.access = { token: tok.access_token!, expiresAt: this.now() + Math.max(60, Number(tok.expires_in) || 3600) * 1000, clientId }
  }

  private async tokenRequest(form: Record<string, string>): Promise<TokenAnswer> {
    const url = new URL(TOKEN_URL)
    if (url.origin !== LOGIN_ORIGIN) throw new OutlookError('Refusing to send an Outlook token anywhere but login.microsoftonline.com.')
    const secrets = [form.code, form.refresh_token, form.code_verifier]
    let r: Awaited<ReturnType<Fetch>>
    try {
      r = await this.f(url.toString(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': UA }, body: new URLSearchParams(form).toString() })
    } catch (e) {
      throw new OutlookError(`Couldn't reach Microsoft's sign-in (check the internet connection): ${redactSecret((e as Error).message, ...secrets).slice(0, 200)}`)
    }
    const text = await r.text()
    let j: TokenAnswer = {}
    try { j = JSON.parse(text) as TokenAnswer } catch { /* not JSON */ }
    if (r.status >= 200 && r.status < 300 && j.access_token) return j
    const error = String(j.error ?? '')
    const desc = redactSecret(String(j.error_description ?? ''), ...secrets)
    if (form.grant_type === 'refresh_token' && (error === 'invalid_grant' || error === 'interaction_required')) {
      this.clear()
      this.d.changed?.()
      throw new OutlookError(SIGN_IN_AGAIN, r.status, error)
    }
    if (r.status >= 500) throw new OutlookError('Microsoft\'s sign-in is having trouble right now. Try again in a minute.', r.status, error)
    throw new OutlookError(explainSignInError(error, desc), r.status, error)
  }

  /** A valid access token: the one in memory, else a fresh one from the refresh token. */
  async accessToken(force = false): Promise<string> {
    const clientId = this.clientId()
    if (!this.connected() || !clientId) throw new OutlookError(NOT_CONNECTED, 0, 'not_connected')
    if (!force && this.access && this.access.clientId === clientId && this.access.expiresAt - 60_000 > this.now()) return this.access.token
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const rt = this.d.secrets.get(OUTLOOK_REFRESH_SECRET)
      if (!rt) throw new OutlookError(NOT_CONNECTED, 0, 'not_connected')
      const tok = await this.tokenRequest({ client_id: clientId, grant_type: 'refresh_token', refresh_token: rt, scope: OUTLOOK_SCOPES })
      this.keep(tok, clientId)
      return tok.access_token!
    })().finally(() => { this.refreshing = null })
    return this.refreshing
  }

  /**
   * One Microsoft Graph call (`path` under /v1.0, e.g. "/me/messages?$top=5"). The token goes only to
   * graph.microsoft.com; a 401 refreshes once and retries. Errors come back in plain words, tokens redacted.
   */
  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, o: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
    if (!path.startsWith('/')) throw new OutlookError('Graph paths start with "/".')
    const url = new URL(`${GRAPH_BASE}${path}`)
    if (url.origin !== GRAPH_ORIGIN || !url.pathname.startsWith('/v1.0/')) throw new OutlookError('Refusing to send the Outlook token anywhere but graph.microsoft.com.')
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(attempt > 0)
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': UA, ...(o.headers ?? {}) }
      if (o.body !== undefined) headers['Content-Type'] = 'application/json'
      let r: Awaited<ReturnType<Fetch>>
      try {
        r = await this.f(url.toString(), { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}), signal: o.signal })
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e
        throw new OutlookError(`Couldn't reach Outlook (check the internet connection): ${redactSecret((e as Error).message, token).slice(0, 200)}`)
      }
      const text = await r.text()
      if (r.status === 401 && attempt === 0) continue
      if (r.status < 200 || r.status >= 300) throw explainGraphError(r.status, text, r.headers?.get('retry-after') ?? null, token, this.d.secrets.get(OUTLOOK_REFRESH_SECRET))
      if (!text.trim()) return undefined as T
      try { return JSON.parse(text) as T } catch { throw new OutlookError('Outlook sent back something that isn\'t JSON.', r.status, 'bad_response') }
    }
  }
}

/** Graph's answer to a failed request, in words the user can act on (tokens never included). */
export function explainGraphError(status: number, body: string, retryAfter: string | null, ...secrets: Array<string | undefined>): OutlookError {
  let j: { error?: { code?: string; message?: string } } = {}
  try { j = JSON.parse(body) as typeof j } catch { /* not JSON */ }
  const code = String(j.error?.code ?? '')
  const msg = redactSecret(String(j.error?.message ?? '').replace(/\s+/g, ' ').slice(0, 300), ...secrets)
  const say = (m: string): OutlookError => new OutlookError(m, status, code || String(status))
  if (status === 401) return say('Outlook needs you to sign in again: Connect apps → Outlook → "Sign in with Microsoft".')
  if (code === 'MailboxNotEnabledForRESTAPI' || code === 'MailboxNotSupportedForRESTAPI') return say('This Microsoft account has no Outlook mailbox that SahilBot can reach (an inactive, on-premises or unlicensed mailbox).')
  if (status === 403) return say(`Outlook refused this: SahilBot is missing a permission${msg ? ` (${msg})` : ''}. Disconnect and sign in again in Connect apps → Outlook and accept every permission it asks for; a work account may need an admin to approve them.`)
  if (status === 429 || code === 'ApplicationThrottled' || code === 'TooManyRequests') {
    const s = Number(retryAfter)
    return say(`Outlook is limiting requests right now. Wait ${Number.isFinite(s) && s > 0 ? `about ${Math.ceil(s)} second${s === 1 ? '' : 's'}` : 'a minute'} and try again later.`)
  }
  if (status === 404) return say('Outlook has no such message or event (it may have been moved or deleted). Search again for fresh ids.')
  if (status === 400 || status === 422) return say(`Outlook rejected the request${msg ? `: ${msg}` : ''}.`)
  if (status >= 500) return say('Outlook (Microsoft Graph) is having trouble right now. Try again in a minute.')
  return say(`Outlook error ${status}${msg ? `: ${msg}` : ''}.`)
}

// ---------------------------------------------------------------- mail and calendar on Graph

export interface Graph { request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, o?: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal }): Promise<T> }

interface GAddress { emailAddress?: { name?: string; address?: string } }
export interface MailSummary { id: string; subject: string; from: string; to: string[]; date: string; unread: boolean; attachments: boolean; preview: string }
export interface MailMessage extends MailSummary { cc: string[]; body: string; truncated: boolean; link?: string }

const who = (a: GAddress | undefined): string => {
  const e = a?.emailAddress
  if (!e?.address) return e?.name ?? ''
  return e.name && e.name !== e.address ? `${e.name} <${e.address}>` : e.address
}
const recipients = (xs: string[]): Array<{ emailAddress: { address: string; name?: string } }> => xs.map((x) => {
  const m = /^\s*(.*?)\s*<\s*([^<>\s]+)\s*>\s*$/.exec(x)
  return m ? { emailAddress: { address: m[2], ...(m[1] ? { name: m[1].replace(/^"|"$/g, '') } : {}) } } : { emailAddress: { address: x.trim() } }
})
/** Ids Graph hands out (base64-ish), checked before they go into a URL. */
export const GRAPH_ID = /^[A-Za-z0-9+/=_-]{8,512}$/
const idPath = (id: string): string => {
  const v = String(id ?? '').trim()
  if (!GRAPH_ID.test(v)) throw new OutlookError('Give the Outlook message id from mail_search (or the draft id from draft).')
  return encodeURIComponent(v)
}
const SUMMARY_FIELDS = 'id,subject,from,toRecipients,receivedDateTime,isRead,hasAttachments,bodyPreview'
const toSummary = (m: Record<string, unknown>): MailSummary => ({
  id: String(m.id ?? ''), subject: String(m.subject ?? '') || '(no subject)', from: who(m.from as GAddress), to: ((m.toRecipients as GAddress[] | undefined) ?? []).map(who).filter(Boolean),
  date: String(m.receivedDateTime ?? ''), unread: m.isRead === false, attachments: m.hasAttachments === true, preview: String(m.bodyPreview ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
})

/**
 * Mail, newest first: a search ($search, Outlook's own syntax: words, from:, subject:…), or the inbox filtered
 * by unread and/or a start date. Graph can't combine $search with $filter, so those filters are applied to
 * the search's results here.
 */
export async function searchMail(g: Graph, o: { query?: string; unread?: boolean; since?: string; limit?: number; signal?: AbortSignal }): Promise<MailSummary[]> {
  const top = Math.max(1, Math.min(50, Math.floor(o.limit ?? 20)))
  const q = String(o.query ?? '').trim()
  const since = o.since ? isoInstant(o.since) : undefined
  let rows: MailSummary[]
  if (q) {
    const search = `"${q.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`
    const r = await g.request<{ value?: Array<Record<string, unknown>> }>('GET', `/me/messages?$search=${encodeURIComponent(search)}&$top=${top}&$select=${SUMMARY_FIELDS}`, { headers: { ConsistencyLevel: 'eventual' }, signal: o.signal })
    rows = (r?.value ?? []).map(toSummary).filter((m) => (!o.unread || m.unread) && (!since || Date.parse(m.date) >= Date.parse(since)))
  } else {
    // A $filter with $orderby must name the ordered property first (Graph's rule), so the date always leads.
    const filter = [`receivedDateTime ge ${since ?? '1900-01-01T00:00:00Z'}`, ...(o.unread ? ['isRead eq false'] : [])].join(' and ')
    const r = await g.request<{ value?: Array<Record<string, unknown>> }>('GET', `/me/mailFolders/inbox/messages?$filter=${encodeURIComponent(filter)}&$orderby=${encodeURIComponent('receivedDateTime desc')}&$top=${top}&$select=${SUMMARY_FIELDS}`, { signal: o.signal })
    rows = (r?.value ?? []).map(toSummary)
  }
  return rows.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
}

export const MAIL_BODY_MAX = 20_000

/** One whole message: headers and the body as readable text (HTML stripped), capped at MAIL_BODY_MAX characters. */
export async function readMail(g: Graph, id: string, signal?: AbortSignal): Promise<MailMessage> {
  const m = await g.request<Record<string, unknown>>('GET', `/me/messages/${idPath(id)}?$select=${SUMMARY_FIELDS},ccRecipients,body,webLink`, { headers: { Prefer: 'outlook.body-content-type="text"' }, signal })
  const b = (m.body ?? {}) as { contentType?: string; content?: string }
  const raw = String(b.content ?? '')
  const text = /html/i.test(b.contentType ?? '') || /<(html|body|div|p|br|table)\b/i.test(raw) ? htmlToText(raw) : raw.replace(/\r\n/g, '\n').trim()
  return {
    ...toSummary(m), cc: ((m.ccRecipients as GAddress[] | undefined) ?? []).map(who).filter(Boolean),
    body: text.length > MAIL_BODY_MAX ? text.slice(0, MAIL_BODY_MAX) : text, truncated: text.length > MAIL_BODY_MAX,
    ...(typeof m.webLink === 'string' ? { link: m.webLink } : {})
  }
}

export interface Draft { to?: string[]; cc?: string[]; bcc?: string[]; subject?: string; body: string }

/**
 * A draft in Outlook's Drafts folder (never sent): a new message, or with `replyTo` a reply (reply-all with
 * `all`) to that message, its thread quoted by Outlook, with extra recipients or a new subject PATCHed on.
 */
export async function createDraft(g: Graph, d: Draft & { replyTo?: string; all?: boolean }, signal?: AbortSignal): Promise<{ id: string; subject: string; link?: string; to: string[] }> {
  let m: Record<string, unknown>
  if (d.replyTo) {
    m = await g.request<Record<string, unknown>>('POST', `/me/messages/${idPath(d.replyTo)}/${d.all ? 'createReplyAll' : 'createReply'}`, { body: { comment: d.body }, signal })
    const patch: Record<string, unknown> = {}
    if (d.to?.length) patch.toRecipients = [...((m.toRecipients as GAddress[] | undefined) ?? []), ...recipients(d.to)]
    if (d.cc?.length) patch.ccRecipients = [...((m.ccRecipients as GAddress[] | undefined) ?? []), ...recipients(d.cc)]
    if (d.bcc?.length) patch.bccRecipients = recipients(d.bcc)
    if (d.subject?.trim()) patch.subject = d.subject.trim()
    if (Object.keys(patch).length) m = await g.request<Record<string, unknown>>('PATCH', `/me/messages/${idPath(String(m.id ?? ''))}`, { body: patch, signal })
  } else {
    m = await g.request<Record<string, unknown>>('POST', '/me/messages', { body: outgoing(d), signal })
  }
  return { id: String(m.id ?? ''), subject: String(m.subject ?? d.subject ?? ''), ...(typeof m.webLink === 'string' ? { link: m.webLink } : {}), to: ((m.toRecipients as GAddress[] | undefined) ?? []).map(who).filter(Boolean) }
}

const outgoing = (d: Draft): Record<string, unknown> => ({
  subject: d.subject ?? '', body: { contentType: 'Text', content: d.body },
  toRecipients: recipients(d.to ?? []), ...(d.cc?.length ? { ccRecipients: recipients(d.cc) } : {}), ...(d.bcc?.length ? { bccRecipients: recipients(d.bcc) } : {})
})

/** Sends a new message (saved to Sent Items). */
export async function sendMail(g: Graph, d: Draft, signal?: AbortSignal): Promise<void> {
  await g.request('POST', '/me/sendMail', { body: { message: outgoing(d), saveToSentItems: true }, signal })
}

/** Sends a draft that's already in Outlook (from draft). */
export async function sendDraft(g: Graph, draftId: string, signal?: AbortSignal): Promise<void> {
  await g.request('POST', `/me/messages/${idPath(draftId)}/send`, { signal })
}

/** Replies (or replies to all) to a message, right away; Outlook quotes the thread and threads it. */
export async function replyMail(g: Graph, id: string, body: string, all: boolean, signal?: AbortSignal): Promise<void> {
  await g.request('POST', `/me/messages/${idPath(id)}/${all ? 'replyAll' : 'reply'}`, { body: { comment: body }, signal })
}

// ---------------------------------------------------------------- calendar

export interface CalEvent { id: string; subject: string; start: string; end: string; allDay: boolean; location: string; organizer: string; attendees: number; preview: string; link?: string }

const ISO_LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i

/** A time zone's offset from UTC (ms) at an instant. */
function zoneOffset(at: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at)).map((x) => [x.type, x.value]))
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(at / 1000) * 1000
}
/** A wall-clock time in a time zone ("2026-11-25T09:00") as an instant. */
export function zonedInstant(local: string, tz: string): number {
  const m = ISO_LOCAL.exec(local.trim())
  if (!m) return NaN
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))
  const first = guess - zoneOffset(guess, tz)
  return guess - zoneOffset(first, tz)
}
export const validTimeZone = (tz: string): boolean => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false } }
const isoInstant = (s: string, tz = 'UTC'): string => {
  const v = String(s).trim()
  const t = HAS_OFFSET.test(v) ? Date.parse(v) : zonedInstant(v, tz)
  if (Number.isNaN(t)) throw new OutlookError(`"${v.slice(0, 40)}" isn't a date. Use ISO 8601, e.g. 2026-11-25 or 2026-11-25T09:00.`)
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Events between two times (a bare date is that whole day; default: the next 7 days), in the user's time zone. */
export async function calendarEvents(g: Graph, o: { from?: string; to?: string; timeZone: string; limit?: number; now?: number; signal?: AbortSignal }): Promise<CalEvent[]> {
  const tz = o.timeZone
  const now = o.now ?? Date.now()
  const today = new Date(now + zoneOffset(now, tz)).toISOString().slice(0, 10)
  const from = o.from?.trim() || today
  const bareFrom = /^\d{4}-\d{2}-\d{2}$/.test(from)
  const start = isoInstant(from, tz)
  let end: string
  if (o.to?.trim()) {
    const to = o.to.trim()
    // A bare end date includes that whole day.
    end = /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(Date.parse(isoInstant(to, tz)) + 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z') : isoInstant(to, tz)
  } else end = new Date(Date.parse(start) + (bareFrom && o.from ? 1 : 7) * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (Date.parse(end) <= Date.parse(start)) throw new OutlookError('The end of the range is before its start.')
  const top = Math.max(1, Math.min(100, Math.floor(o.limit ?? 50)))
  const r = await g.request<{ value?: Array<Record<string, unknown>> }>('GET', `/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$orderby=${encodeURIComponent('start/dateTime')}&$top=${top}&$select=id,subject,start,end,isAllDay,location,organizer,attendees,bodyPreview,webLink`, { headers: { Prefer: `outlook.timezone="${tz}"` }, signal: o.signal })
  return (r?.value ?? []).map((e) => ({
    id: String(e.id ?? ''), subject: String(e.subject ?? '') || '(no title)',
    start: String((e.start as { dateTime?: string } | undefined)?.dateTime ?? ''), end: String((e.end as { dateTime?: string } | undefined)?.dateTime ?? ''),
    allDay: e.isAllDay === true, location: String((e.location as { displayName?: string } | undefined)?.displayName ?? ''), organizer: who(e.organizer as GAddress),
    attendees: Array.isArray(e.attendees) ? e.attendees.length : 0, preview: String(e.bodyPreview ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    ...(typeof e.webLink === 'string' ? { link: e.webLink } : {})
  }))
}

/** "2026-11-25T09:00" (wall clock) with Graph's timeZone, or UTC for a time that carries its own offset. */
export function graphTime(s: string, tz: string): { dateTime: string; timeZone: string } {
  const v = String(s ?? '').trim()
  if (HAS_OFFSET.test(v)) {
    const t = Date.parse(v)
    if (Number.isNaN(t)) throw new OutlookError(`"${v.slice(0, 40)}" isn't a date-time. Use ISO 8601, e.g. 2026-11-25T09:00.`)
    return { dateTime: new Date(t).toISOString().slice(0, 19), timeZone: 'UTC' }
  }
  const m = ISO_LOCAL.exec(v)
  if (!m || m[4] === undefined) throw new OutlookError(`"${v.slice(0, 40)}" isn't a date-time. Use ISO 8601 with a time, e.g. 2026-11-25T09:00.`)
  return { dateTime: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}`, timeZone: tz }
}

export interface NewEvent { subject: string; start: string; end?: string; timeZone: string; location?: string; attendees?: string[]; body?: string }

/** Adds an event to the user's calendar. With attendees, Outlook sends them invitations. Default length: 1 hour. */
export async function createEvent(g: Graph, e: NewEvent, signal?: AbortSignal): Promise<CalEvent> {
  const start = graphTime(e.start, e.timeZone)
  let end: { dateTime: string; timeZone: string }
  if (e.end?.trim()) end = graphTime(e.end, e.timeZone)
  else end = { dateTime: new Date(Date.parse(`${start.dateTime}Z`) + 3_600_000).toISOString().slice(0, 19), timeZone: start.timeZone }
  if (start.timeZone === end.timeZone && Date.parse(`${end.dateTime}Z`) <= Date.parse(`${start.dateTime}Z`)) throw new OutlookError('The event ends before it starts.')
  const body: Record<string, unknown> = {
    subject: e.subject, start, end,
    ...(e.location?.trim() ? { location: { displayName: e.location.trim() } } : {}),
    ...(e.body?.trim() ? { body: { contentType: 'Text', content: e.body } } : {}),
    ...(e.attendees?.length ? { attendees: recipients(e.attendees).map((a) => ({ ...a, type: 'required' })) } : {})
  }
  const r = await g.request<Record<string, unknown>>('POST', '/me/events', { body, signal })
  return {
    id: String(r.id ?? ''), subject: String(r.subject ?? e.subject), start: String((r.start as { dateTime?: string } | undefined)?.dateTime ?? start.dateTime),
    end: String((r.end as { dateTime?: string } | undefined)?.dateTime ?? end.dateTime), allDay: false, location: e.location ?? '', organizer: '', attendees: e.attendees?.length ?? 0, preview: '',
    ...(typeof r.webLink === 'string' ? { link: r.webLink } : {})
  }
}
