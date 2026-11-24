import { existsSync, readFileSync } from 'node:fs'
import type { ConnectorPreset } from '@shared/types'

// Built-in OAuth clients: SahilBot's own app registration with providers whose MCP servers don't let
// apps register themselves (Slack, GitHub, HubSpot…, and Google). With one here, the app connects in
// one click: Connect opens the provider's own sign-in page in the user's browser, nothing to paste.
// The user can still bring their own app instead (Connect apps → the app → "Use your own app").
//
// Where they come from (first found wins; docs/oauth-registration.md has the checklist per provider):
//   1. SAHILBOT_OAUTH_CLIENTS_JSON (the JSON itself): development and hidden test runs only. Release
//      builds get it from the CI secret of the same name, written to the file below at build time.
//   2. resources/oauth-clients.json, shipped with the app. Not committed (it's gitignored): the
//      committed resources/oauth-clients.example.json shows the format. No file = no built-in clients.
//
// Shape: { "<preset id>" | "google": { clientId, clientSecret?, redirect: "loopback" | "<exact URI>", scopes? } }
//   redirect "loopback": the provider takes any loopback port (RFC 8252 §7.3; Google Desktop clients),
//                        so SahilBot listens on a free 127.0.0.1 port per sign-in.
//   redirect "<URI>":    the exact URI registered with the provider, e.g. http://localhost:47613/callback.
//                        It must be a loopback http URI with a port and the path /callback (that's
//                        where SahilBot's sign-in listener answers). Omitted: the preset's own redirect.
//   clientSecret:        only for providers that require one even for desktop apps (GitHub OAuth apps,
//                        Google Desktop clients…). A desktop app can't keep it secret: per RFC 8252 §8.5
//                        it's an "installed app" secret, and PKCE (S256) is still always used.
//   scopes:              space-separated (or an array): asked for instead of the server's advertised set.
//   "google":            shared by every Google app (Gmail, Calendar, Drive, Docs, Sheets, Slides,
//                        BigQuery); a "gmail" entry would override it for Gmail alone.
//   "outlook":           SahilBot's own Microsoft Entra app (Outlook mail and calendar, mail/outlook.ts): a
//                        public client (no secret: Microsoft refuses one from a desktop app), its client ID a
//                        GUID, redirect "loopback" (Entra's "Mobile and desktop" http://localhost, any port).
// Keys starting with "$" or "_" are comments. Anything malformed is skipped (with a reason) and the app
// falls back to "Use your own app" for that provider: a bad entry never blocks the rest.

export interface BuiltinClient {
  clientId: string
  clientSecret?: string
  /** 'loopback' (any 127.0.0.1 port) or the exact loopback redirect URI registered with the provider. */
  redirect: 'loopback' | string
  /** Space-separated scopes to ask for instead of the server's advertised set. */
  scopes?: string
}

export type BuiltinClients = Record<string, BuiltinClient>

export const OAUTH_CLIENTS_ENV = 'SAHILBOT_OAUTH_CLIENTS_JSON'
export const OAUTH_CLIENTS_FILE = 'oauth-clients.json'
/** The key whose client every Google app shares. */
export const GOOGLE_CLIENT_ID_KEY = 'google'
/** The key of SahilBot's own Microsoft Entra app (Outlook: mail/outlook.ts signs in with it natively). */
export const OUTLOOK_CLIENT_ID_KEY = 'outlook'
/** A Microsoft Entra application (client) ID. */
export const ENTRA_CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const PRINTABLE = /^[\x21-\x7e]+$/

/** An exact redirect SahilBot can receive: http on loopback, an explicit port, the /callback path. */
export function validLoopbackRedirect(uri: string): boolean {
  let u: URL
  try { u = new URL(uri) } catch { return false }
  const port = Number(u.port)
  return u.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname) && Number.isInteger(port) && port >= 1024 && port <= 65535
    && u.pathname === '/callback' && !u.search && !u.hash && !u.username && !u.password
}

/**
 * Checks and tidies a built-in clients document. `presets` is the catalog: only entries that need an
 * app registration (oauth-static and Google apps) take a built-in client, plus "google" itself.
 */
export function parseBuiltinClients(raw: unknown, presets: Array<Pick<ConnectorPreset, 'id' | 'auth' | 'setup'>>): { clients: BuiltinClients; problems: string[] } {
  const clients: BuiltinClients = {}
  const problems: string[] = []
  if (raw === null || raw === undefined) return { clients, problems }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { clients, problems: ['oauth-clients: expected an object of { "<preset id>": { clientId, … } }'] }
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (id.startsWith('$') || id.startsWith('_')) continue
    if (id === OUTLOOK_CLIENT_ID_KEY) {
      const o = parseOutlookClient(v)
      if (typeof o === 'string') problems.push(`${id}: ${o} (skipped)`)
      else clients[id] = o
      continue
    }
    const p = presets.find((x) => x.id === id)
    if (id !== GOOGLE_CLIENT_ID_KEY && (!p || (p.auth !== 'oauth-static' && p.auth !== 'google'))) { problems.push(`${id}: not a catalog app that needs its own OAuth app (skipped)`); continue }
    if (!v || typeof v !== 'object' || Array.isArray(v)) { problems.push(`${id}: expected { clientId, … } (skipped)`); continue }
    const e = v as Record<string, unknown>
    const clientId = typeof e.clientId === 'string' ? e.clientId.trim() : ''
    if (!clientId || clientId.length < 4 || clientId.length > 300 || !PRINTABLE.test(clientId)) { problems.push(`${id}: clientId is missing or malformed (skipped)`); continue }
    let clientSecret: string | undefined
    if (e.clientSecret !== undefined && e.clientSecret !== null && e.clientSecret !== '') {
      const s = typeof e.clientSecret === 'string' ? e.clientSecret.trim() : ''
      if (!s || s.length > 512 || !PRINTABLE.test(s)) { problems.push(`${id}: clientSecret is malformed (skipped)`); continue }
      clientSecret = s
    }
    const isGoogle = id === GOOGLE_CLIENT_ID_KEY || p?.auth === 'google'
    let redirect = typeof e.redirect === 'string' ? e.redirect.trim() : ''
    if (!redirect) redirect = isGoogle ? 'loopback' : (p?.setup?.redirectUri ?? '')
    if (redirect !== 'loopback' && !validLoopbackRedirect(redirect)) { problems.push(`${id}: redirect must be "loopback" or an exact http://127.0.0.1|localhost:<port>/callback URI (skipped)`); continue }
    let scopes: string | undefined
    if (e.scopes !== undefined && e.scopes !== null) {
      const list = Array.isArray(e.scopes) ? e.scopes : typeof e.scopes === 'string' ? e.scopes.split(/\s+/) : null
      if (!list || !list.every((s) => typeof s === 'string' && PRINTABLE.test(s) && !/["\\]/.test(s))) { problems.push(`${id}: scopes must be a string or an array of strings (skipped)`); continue }
      scopes = (list as string[]).filter(Boolean).join(' ') || undefined
    }
    clients[id] = { clientId, ...(clientSecret ? { clientSecret } : {}), redirect, ...(scopes ? { scopes } : {}) }
  }
  return { clients, problems }
}

/** The "outlook" entry: a GUID client ID, no secret, loopback redirect. A string is what's wrong with it. */
function parseOutlookClient(v: unknown): BuiltinClient | string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'expected { clientId, … }'
  const e = v as Record<string, unknown>
  const clientId = typeof e.clientId === 'string' ? e.clientId.trim() : ''
  if (!ENTRA_CLIENT_ID.test(clientId)) return 'clientId must be the Entra application (client) ID, a GUID like 00000000-0000-0000-0000-000000000000'
  if (e.clientSecret !== undefined && e.clientSecret !== null && e.clientSecret !== '') return 'a public client has no clientSecret (Microsoft refuses one from a desktop app)'
  if (e.redirect !== undefined && e.redirect !== null && e.redirect !== '' && e.redirect !== 'loopback') return 'redirect must be "loopback" (register http://localhost under "Mobile and desktop applications")'
  if (e.scopes !== undefined && e.scopes !== null) return 'scopes are fixed by SahilBot (leave them out)'
  return { clientId: clientId.toLowerCase(), redirect: 'loopback' }
}

/**
 * Reads the built-in clients: the environment variable when allowed (development and hidden test runs),
 * else the first file that exists. A file that can't be parsed counts as none (with a problem).
 */
export function readBuiltinClients(o: {
  presets: Array<Pick<ConnectorPreset, 'id' | 'auth' | 'setup'>>
  env?: NodeJS.ProcessEnv
  allowEnv?: boolean
  files?: string[]
}): { clients: BuiltinClients; problems: string[]; source?: string } {
  const env = o.env ?? process.env
  const fromEnv = o.allowEnv ? env[OAUTH_CLIENTS_ENV] : undefined
  if (fromEnv && fromEnv.trim()) {
    try { return { ...parseBuiltinClients(JSON.parse(fromEnv), o.presets), source: OAUTH_CLIENTS_ENV } } catch { return { clients: {}, problems: [`${OAUTH_CLIENTS_ENV} is not valid JSON`], source: OAUTH_CLIENTS_ENV } }
  }
  for (const f of o.files ?? []) {
    if (!existsSync(f)) continue
    let text: string
    try { text = readFileSync(f, 'utf8') } catch { continue }
    if (!text.trim()) return { clients: {}, problems: [], source: f }
    try { return { ...parseBuiltinClients(JSON.parse(text), o.presets), source: f } } catch { return { clients: {}, problems: [`${f} is not valid JSON`], source: f } }
  }
  return { clients: {}, problems: [] }
}

/** The built-in client for a catalog app: its own entry, else (for Google apps) the shared Google one. */
export function builtinFor(clients: BuiltinClients, preset: Pick<ConnectorPreset, 'id' | 'auth'> | undefined): BuiltinClient | undefined {
  if (!preset) return undefined
  if (preset.auth !== 'oauth-static' && preset.auth !== 'google') return undefined
  if (Object.prototype.hasOwnProperty.call(clients, preset.id)) return clients[preset.id]
  return preset.auth === 'google' && Object.prototype.hasOwnProperty.call(clients, GOOGLE_CLIENT_ID_KEY) ? clients[GOOGLE_CLIENT_ID_KEY] : undefined
}
