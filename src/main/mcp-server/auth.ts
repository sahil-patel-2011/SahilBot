import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

// Who may talk to SahilBot's MCP server: programs on this Mac (loopback only) that present a token
// the user created in Settings, and never a web page (DNS rebinding, cross-site requests).

/** Every client token starts with this, so a leaked one is easy to recognize (and to grep for). */
export const TOKEN_PREFIX = 'sbm_'
/** The endpoint path. Anything else is 404. */
export const MCP_PATH = '/mcp'
/** Largest request body accepted (JSON-RPC messages are small). */
export const MAX_BODY_BYTES = 1024 * 1024

/** A new client token: 256 random bits. Shown to the user once; only its hash is stored. */
export function newToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url')
}

/** Tokens are long random strings, so a plain SHA-256 is enough (no password stretching needed). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Constant-time comparison of two hex hashes. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

/** The token from an `Authorization: Bearer …` header, or null. */
export function bearerOf(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header
  const m = /^Bearer[ \t]+([A-Za-z0-9._~+/=-]{8,512})[ \t]*$/i.exec(h ?? '')
  return m ? m[1] : null
}

/** True for this Mac's own addresses (IPv4 127/8, IPv6 ::1, and IPv4-mapped loopback). */
export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false
  const a = addr.toLowerCase().replace(/^::ffff:/, '')
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)
}

/**
 * The Host header must name this server by a loopback name and its own port. A DNS-rebinding page
 * reaches 127.0.0.1 under its own domain name, which fails here.
 */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase()
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`
}

/**
 * Requests made by a web page. Browsers send Origin on every cross-origin request and on every POST
 * (including form posts), so any Origin at all means a page sent it. Desktop MCP clients don't send one.
 */
export function fromBrowser(headers: IncomingHttpHeaders): boolean {
  if (headers.origin !== undefined) return true
  // Fetch metadata from a browser context (Node's fetch sends at most sec-fetch-mode, never these).
  const site = headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'none') return true
  const dest = headers['sec-fetch-dest']
  return typeof dest === 'string' && dest !== 'empty'
}

export interface GateInput {
  remoteAddress?: string
  method?: string
  url?: string
  headers: IncomingHttpHeaders
  port: number
}

export type GateResult = { ok: true; token: string } | { ok: false; status: number; error: string; authFailure?: boolean }

/**
 * Checks everything that doesn't need the client list, in order: loopback peer, Host, browser origin,
 * path, method, JSON body, and a bearer token being present. The token itself is checked by the store.
 */
export function gate(i: GateInput): GateResult {
  if (!isLoopback(i.remoteAddress)) return { ok: false, status: 403, error: 'Only programs on this Mac can connect.' }
  if (!hostAllowed(i.headers.host, i.port)) return { ok: false, status: 403, error: 'Unexpected Host header.' }
  if (fromBrowser(i.headers)) return { ok: false, status: 403, error: 'Requests from web pages are not allowed.' }
  const path = (i.url ?? '').split('?')[0]
  if (path !== MCP_PATH) return { ok: false, status: 404, error: 'Not found.' }
  // Stateless server: every message is a POST (no standing GET stream, no sessions to DELETE).
  if (i.method !== 'POST') return { ok: false, status: 405, error: 'Use POST.' }
  const type = String(i.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') return { ok: false, status: 415, error: 'Content-Type must be application/json.' }
  const token = bearerOf(i.headers.authorization)
  if (!token) return { ok: false, status: 401, error: 'Missing bearer token. Create one in SahilBot → Settings → Connected apps → Let apps on this Mac use SahilBot.', authFailure: true }
  return { ok: true, token }
}
