// Mac app: Settings → Always-on server. Links this Mac to a SahilBot Server (a Raspberry Pi, a VM, a Mac
// mini) with a one-time pairing code, shows its status, and opens its web UI already signed in.
//
// The device token lives in the Keychain (Secrets). A server with a self-signed certificate is pinned at
// pairing (its SHA-256 fingerprint, which the server prints) and every later connection must match it, so
// the token is never sent to anything else. Tailscale's real certificates verify normally.

import { request as httpRequest, type IncomingMessage } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { hostname } from 'node:os'
import type { RemoteServerStatus } from '@shared/types'
import type { Db } from './db'
import type { Secrets } from './secrets'
import { registerHandler } from './rpc'
import { isServer } from './runtime'

interface Saved { url: string; deviceName: string; pinned?: string }

const KEY = 'remoteServer'
const TOKEN = 'remoteServerToken'
const CERT_ERRORS = /SELF_SIGNED|UNABLE_TO_VERIFY|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID|UNABLE_TO_GET_ISSUER/

/** The server's base URL, cleaned: https anywhere, plain http only on this Mac. */
export function normalizeServerUrl(raw: string): string {
  let u: URL
  try { u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`) } catch { throw new Error('That isn’t a web address.') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (u.protocol === 'http:' && !local) throw new Error('Use the server’s https:// address (Tailscale gives one: tailscale serve), so your sign-in is encrypted.')
  return `${u.protocol}//${u.host}`
}

interface Reply { status: number; json: Record<string, unknown>; fingerprint?: string }

/** A TLS connection whose certificate must have this fingerprint (checked before anything is sent). */
function pinnedSocket(u: URL, pin: string): Promise<TLSSocket> {
  return new Promise((ok, fail) => {
    const s = tlsConnect({ host: u.hostname, port: Number(u.port) || 443, servername: u.hostname.match(/^[\d.]+$|:/) ? undefined : u.hostname, rejectUnauthorized: false, timeout: 10_000 })
    s.once('secureConnect', () => {
      const fp = s.getPeerCertificate()?.fingerprint256
      if (fp !== pin) { s.destroy(); fail(new Error('The server’s certificate changed since this Mac was linked. If you replaced it, unlink and link again.')); return }
      ok(s)
    })
    s.once('error', fail)
    s.once('timeout', () => { s.destroy(); fail(new Error('The server didn’t answer.')) })
  })
}

/** An agent whose one connection is the already-verified (pinned) socket. */
function pinnedAgent(socket: TLSSocket): HttpsAgent {
  const a = new HttpsAgent({ keepAlive: false, maxSockets: 1 })
  ;(a as unknown as { createConnection: () => TLSSocket }).createConnection = () => socket
  return a
}

export async function callServer(base: string, path: string, o: { method?: string; token?: string; body?: unknown; pin?: string; trustOnFirstUse?: boolean } = {}): Promise<Reply> {
  const u = new URL(path, base)
  const body = o.body === undefined ? undefined : JSON.stringify(o.body)
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'SahilBot-Mac' }
  if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(Buffer.byteLength(body)) }
  if (o.token) headers.Authorization = `Bearer ${o.token}`
  const socket = u.protocol === 'https:' && o.pin ? await pinnedSocket(u, o.pin) : undefined
  return new Promise<Reply>((ok, fail) => {
    const opts = { method: o.method ?? 'GET', headers, timeout: 15_000, ...(socket ? { agent: pinnedAgent(socket) } : {}), ...(o.trustOnFirstUse ? { rejectUnauthorized: false } : {}) }
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, opts, (res: IncomingMessage) => {
      // Read while the connection is still open (it may be gone by the end of the body).
      const fingerprint = (res.socket as TLSSocket | undefined)?.getPeerCertificate?.()?.fingerprint256
      const chunks: Buffer[] = []
      let received = 0
      res.on('data', (c: Buffer) => {
        received += c.length
        if (received > 256 * 1024) req.destroy(new Error('The server returned too much data.'))
        else chunks.push(c)
      })
      res.on('error', fail)
      res.on('end', () => {
        let json: Record<string, unknown> = {}
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* not JSON */ }
        ok({ status: res.statusCode ?? 0, json, fingerprint })
      })
    })
    req.on('timeout', () => req.destroy(new Error('The server didn’t answer.')))
    req.on('error', fail)
    if (body) req.write(body)
    req.end()
  })
}

export function setupRemoteServer(d: { db: Db; secrets: Secrets; openExternal: (url: string) => void }): void {
  if (isServer()) return
  const saved = (): Saved | undefined => d.db.getSetting<Saved>(KEY) ?? undefined
  const token = (): string | undefined => d.secrets.get(TOKEN)

  const status = async (refresh = false): Promise<RemoteServerStatus> => {
    const s = saved()
    const t = token()
    if (!s || !t) return { linked: false }
    const base: RemoteServerStatus = { linked: true, url: s.url, deviceName: s.deviceName, pinned: s.pinned, online: null }
    if (!refresh) return base
    try {
      const r = await callServer(s.url, '/api/status', { token: t, pin: s.pinned })
      if (r.status === 401) return { ...base, online: false, error: 'this Mac was removed from the server; unlink and link again' }
      if (r.status !== 200) return { ...base, online: false, error: `it answered ${r.status}` }
      return { ...base, online: true, info: r.json as unknown as RemoteServerStatus['info'] }
    } catch (e) {
      return { ...base, online: false, error: (e as Error).message }
    }
  }

  registerHandler('remoteServer:status', (_ctx, refresh) => status(refresh === true))

  registerHandler('remoteServer:connect', async (_ctx, rawUrl, rawCode) => {
    const url = normalizeServerUrl(String(rawUrl ?? ''))
    const code = String(rawCode ?? '').trim()
    if (!code) throw new Error('Enter the pairing code from the server (sahilbot-server pair).')
    // The label survives a long hostname: the name part is cut, never "(Mac app)".
    const deviceName = `${hostname().replace(/\.local$/, '').slice(0, 49)} (Mac app)`
    const pair = (tofu: boolean): Promise<Reply> => callServer(url, '/api/pair', { method: 'POST', body: { code, name: deviceName, mode: 'token' }, trustOnFirstUse: tofu })
    let r: Reply
    let pinned: string | undefined
    try { r = await pair(false) } catch (e) {
      // A self-signed certificate: trusted from now on (pinned), now that the user is pairing with a code from it.
      if (!CERT_ERRORS.test(`${(e as { code?: string }).code ?? ''} ${(e as Error).message}`)) throw new Error(`Couldn’t reach ${url}: ${(e as Error).message}`)
      r = await pair(true)
      pinned = r.fingerprint
    }
    if (r.status === 429) throw new Error('Too many wrong codes. Wait a few minutes, then make a new code on the server.')
    if (r.status !== 200 || typeof r.json.token !== 'string') throw new Error(String(r.json.error ?? `The server answered ${r.status}.`))
    d.secrets.set(TOKEN, r.json.token)
    d.db.setSetting(KEY, { url, deviceName, pinned } satisfies Saved)
    return status(true)
  })

  registerHandler('remoteServer:disconnect', async () => {
    const s = saved()
    const t = token()
    if (s && t) { try { await callServer(s.url, '/api/logout', { method: 'POST', token: t, pin: s.pinned }) } catch { /* offline: forget it here anyway */ } }
    d.secrets.set(TOKEN, null)
    d.db.setSetting(KEY, null)
    return { linked: false } satisfies RemoteServerStatus
  })

  registerHandler('remoteServer:openUi', async () => {
    const s = saved()
    const t = token()
    if (!s || !t) throw new Error('Link a server first.')
    const r = await callServer(s.url, '/api/handoff', { method: 'POST', token: t, pin: s.pinned })
    if (r.status !== 200 || typeof r.json.code !== 'string') throw new Error(String(r.json.error ?? `The server answered ${r.status}.`))
    // The code rides in the fragment: it never reaches a server log or a Referer.
    d.openExternal(`${s.url}/pair#code=${encodeURIComponent(r.json.code)}`)
  })
}
