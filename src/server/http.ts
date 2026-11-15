// SahilBot Server's HTTP(S) front: the web UI (the Mac app's renderer bundle plus the WebSocket bridge),
// pairing, a small JSON API for the Mac app, files the app shows, and the WebSocket itself.
//
// Every request: Host must name this server (DNS rebinding), then security headers. Everything except the
// pairing page, its assets and /healthz needs a paired device (cookie, or a bearer token for the Mac app).
// State-changing browser requests and the WebSocket also need a same-origin Origin (and POSTs a CSRF token).

import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttps } from 'node:https'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'
import type { Duplex } from 'node:stream'
import type { AuditLog } from './audit'
import { clearCookie, COOKIE, deviceCookie, deviceName, hostAllowed, originAllowed, parseCookies, type Device, type Devices, type HostPolicy, type PairingCodes, type RateLimiter } from './auth'
import type { Hub } from './hub'
import { host } from './host'
import { ICON_SVG, MANIFEST, MOBILE_CSS, PAIR_CSS, PAIR_HTML, PAIR_JS, SERVICE_WORKER } from './pages'
import { acceptUpgrade, isUpgrade, rejectUpgrade } from './ws'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.map': 'application/json', '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8'
}

/** The app page's CSP: same-origin scripts and connections only (WebSocket included). */
const APP_CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; frame-src 'self'; object-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
const PAGE_CSP = "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

export interface HttpOptions {
  uiDir: string
  bridgeFile: string
  tls?: { cert: string; key: string }
  devices: Devices
  codes: PairingCodes
  limiter: RateLimiter
  audit: AuditLog
  hub: Hub
  policy: HostPolicy
  /** JSON for GET /api/status (the Mac app's status line). */
  status: () => unknown | Promise<unknown>
  /** WebSocket message size limit. */
  maxPayload?: number
}

const isLoopback = (a: string | undefined): boolean => !!a && (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a.startsWith('127.'))

export class HttpFront {
  readonly server: Server
  private indexHtml: string | null = null
  private hostDenied = 0

  constructor(private o: HttpOptions) {
    const handler = (req: IncomingMessage, res: ServerResponse): void => { void this.route(req, res).catch((e) => this.fail(res, 500, (e as Error).message)) }
    this.server = o.tls ? createHttps({ cert: o.tls.cert, key: o.tls.key, minVersion: 'TLSv1.2' }, handler) : createHttp(handler)
    this.server.headersTimeout = 20_000
    this.server.requestTimeout = 120_000
    this.server.keepAliveTimeout = 5_000
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head))
    this.server.on('clientError', (_e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch { /* gone */ } })
  }

  // ---------------------------------------------------------------- who is asking

  /** The address to rate-limit: the forwarding proxy's client when the proxy is local (tailscale serve). */
  clientIp(req: IncomingMessage): string {
    const peer = req.socket.remoteAddress ?? ''
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
    return isLoopback(peer) && fwd ? fwd : peer.replace(/^::ffff:/, '')
  }

  /** Whether the browser reached us over HTTPS (directly, or through a local TLS proxy such as tailscale serve). */
  secure(req: IncomingMessage): boolean {
    if (this.o.tls) return true
    if (!isLoopback(req.socket.remoteAddress)) return false
    if (String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https') return true
    return String(req.headers.origin ?? '').startsWith('https://')
  }

  /** Same-origin, as the browser sees it. Behind a local proxy the scheme can be either. */
  private sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin
    const h = req.headers.host
    if (this.o.tls) return originAllowed(origin, h, true)
    if (isLoopback(req.socket.remoteAddress)) return originAllowed(origin, h, false) || originAllowed(origin, h, true)
    return originAllowed(origin, h, false)
  }

  private device(req: IncomingMessage): { device: Device; via: 'cookie' | 'bearer' } | undefined {
    const auth = String(req.headers.authorization ?? '')
    if (auth.startsWith('Bearer ')) { const d = this.o.devices.check(auth.slice(7).trim()); return d ? { device: d, via: 'bearer' } : undefined }
    const d = this.o.devices.check(parseCookies(req.headers.cookie)[COOKIE])
    return d ? { device: d, via: 'cookie' } : undefined
  }

  // ---------------------------------------------------------------- responses

  private headers(res: ServerResponse, secure: boolean, csp = PAGE_CSP): void {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)')
    res.setHeader('Content-Security-Policy', csp)
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000')
  }

  private json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text), ...extra })
    res.end(text)
  }

  private fail(res: ServerResponse, status: number, message: string): void {
    if (res.headersSent) { res.destroy(); return }
    this.json(res, status, { error: message })
  }

  private text(res: ServerResponse, type: string, body: string | Buffer, cache = 'no-cache'): void {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  }

  private async body(req: IncomingMessage, max = 64 * 1024): Promise<unknown> {
    const chunks: Buffer[] = []
    let n = 0
    for await (const c of req) {
      n += (c as Buffer).length
      if (n > max) throw Object.assign(new Error('Request too large'), { status: 413 })
      chunks.push(c as Buffer)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }) }
  }

  // ---------------------------------------------------------------- routes

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = this.clientIp(req)
    if (!hostAllowed(req.headers.host, this.o.policy)) {
      if (this.hostDenied++ < 50) this.o.audit.write('host.denied', { ip, detail: String(req.headers.host ?? '').slice(0, 80) })
      this.fail(res, 421, 'This server does not answer to that name. Add it with --allow-host.')
      return
    }
    const secure = this.secure(req)
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    const method = req.method ?? 'GET'
    this.headers(res, secure)

    // Public: health, pairing, and what the pairing page and a home-screen icon need.
    if (path === '/healthz') return this.json(res, 200, { ok: true, ready: host.ready })
    if (method === 'GET' && path === '/pair') return this.text(res, 'text/html; charset=utf-8', PAIR_HTML, 'no-store')
    if (method === 'GET' && path === '/pair.js') return this.text(res, 'text/javascript; charset=utf-8', PAIR_JS)
    if (method === 'GET' && path === '/pair.css') return this.text(res, 'text/css; charset=utf-8', PAIR_CSS)
    if (method === 'GET' && (path === '/icon.svg' || path === '/favicon.ico')) return this.text(res, 'image/svg+xml', ICON_SVG, 'max-age=86400')
    if (method === 'GET' && path === '/manifest.webmanifest') return this.text(res, 'application/manifest+json', MANIFEST, 'max-age=3600')
    if (method === 'GET' && path === '/sw.js') { res.setHeader('Service-Worker-Allowed', '/'); return this.text(res, 'text/javascript; charset=utf-8', SERVICE_WORKER) }
    if (method === 'POST' && path === '/api/pair') return this.pair(req, res, ip, secure)

    const who = this.device(req)
    if (!who) {
      if (method === 'GET' && !path.startsWith('/api/') && !path.startsWith('/foreman-file/') && String(req.headers.accept ?? '').includes('text/html')) {
        res.writeHead(302, { Location: '/pair', 'Cache-Control': 'no-store' })
        res.end()
        return
      }
      if (req.headers.authorization || req.headers.cookie?.includes(`${COOKIE}=`)) this.o.audit.write('auth.fail', { ip, detail: `${method} ${path.slice(0, 60)}` })
      return this.fail(res, 401, 'Pair this device first.')
    }
    const { device, via } = who
    this.o.devices.seen(device.id, ip)
    // A browser's state-changing request: same origin and the CSRF token (the Mac app's bearer calls aren't from a page).
    if (method !== 'GET' && method !== 'HEAD' && via === 'cookie') {
      if (!this.sameOrigin(req)) { this.o.audit.write('origin.denied', { ip, device: device.id, detail: String(req.headers.origin ?? 'none').slice(0, 80) }); return this.fail(res, 403, 'Cross-origin request refused.') }
      if (!this.o.devices.csrfOk(device.id, String(req.headers['x-sahilbot-csrf'] ?? ''))) return this.fail(res, 403, 'Missing or wrong CSRF token.')
    }

    if (method === 'GET' && path === '/api/session') return this.json(res, 200, { device: { id: device.id, name: device.name }, csrf: this.o.devices.csrf(device.id), runtime: 'server', version: host.version })
    if (method === 'GET' && path === '/api/status') return this.json(res, 200, await this.o.status())
    if (method === 'POST' && path === '/api/logout') {
      this.o.devices.revoke(device.id)
      this.o.audit.write('device.revoke', { ip, device: device.id, detail: 'signed out' })
      this.o.hub.closeDevice(device.id, 'signed out')
      return this.json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(secure) })
    }
    if (method === 'POST' && path === '/api/handoff') {
      // The Mac app opens the web UI signed in: a short-lived one-time code, used by the pairing page.
      const c = this.o.codes.create({ ttlMs: 2 * 60_000, label: `handoff from ${device.name}` })
      this.o.audit.write('pair.code', { ip, device: device.id, detail: 'handoff (2 min)' })
      return this.json(res, 200, { code: c.code, expires: c.expires })
    }
    if (method === 'GET' && path.startsWith('/foreman-file/')) return this.file(req, res, path)
    if (method === 'GET' && path === '/__sahilbot/bridge.js') return this.static(res, this.o.bridgeFile, 'no-cache')
    if (method === 'GET' && path === '/__sahilbot/mobile.css') return this.text(res, 'text/css; charset=utf-8', MOBILE_CSS)
    if (method === 'GET') return this.app(res, path)
    return this.fail(res, 404, 'Not found')
  }

  private async pair(req: IncomingMessage, res: ServerResponse, ip: string, secure: boolean): Promise<void> {
    const wait = this.o.limiter.retryAfter(ip)
    if (wait > 0) {
      this.o.audit.write('pair.limited', { ip })
      return this.json(res, 429, { error: 'Too many tries.', retryAfter: Math.ceil(wait / 1000) }, { 'Retry-After': String(Math.ceil(wait / 1000)) })
    }
    // A page may only pair itself (no other site can trade a code it saw for this browser's cookie). The
    // Mac app (no Origin) asks for a token instead of a cookie.
    let body: { code?: string; name?: string; mode?: string }
    try { body = (await this.body(req)) as typeof body } catch (e) { return this.fail(res, (e as { status?: number }).status ?? 400, (e as Error).message) }
    const tokenMode = body.mode === 'token' && !req.headers.origin
    if (!tokenMode && !this.sameOrigin(req)) {
      this.o.audit.write('origin.denied', { ip, detail: `pair from ${String(req.headers.origin ?? 'none').slice(0, 80)}` })
      return this.fail(res, 403, 'Cross-origin request refused.')
    }
    if (!this.o.codes.consume(String(body.code ?? ''))) {
      this.o.limiter.fail(ip)
      this.o.audit.write('pair.fail', { ip })
      return this.fail(res, 401, 'That code didn’t work. Codes work once and expire after 10 minutes.')
    }
    this.o.limiter.reset(ip)
    const name = String(body.name ?? '').trim().slice(0, 60) || deviceName(String(req.headers['user-agent'] ?? ''))
    const { device, token } = this.o.devices.add(name, tokenMode ? 'app' : 'browser', ip)
    this.o.audit.write('pair.ok', { ip, device: device.id, detail: name })
    if (tokenMode) return this.json(res, 200, { token, device: { id: device.id, name: device.name } })
    return this.json(res, 200, { ok: true, device: { id: device.id, name: device.name } }, { 'Set-Cookie': deviceCookie(token, secure) })
  }

  /** Files the app shows (attachments, previews), through the app's own foreman-file: handler and its access rules. */
  private async file(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const handler = host.protocols.get('foreman-file')
    if (!handler) return this.fail(res, 404, 'Not found')
    const r = await handler(new Request(`foreman-file://${path.slice('/foreman-file/'.length)}`, { method: 'GET' }))
    const headers: Record<string, string> = { 'Cache-Control': 'private, max-age=60' }
    r.headers.forEach((v, k) => { headers[k] = v })
    // An inert document (the handler's CSP) replaces the app CSP for these.
    if (!headers['content-security-policy']) headers['Content-Security-Policy'] = "sandbox; default-src 'none'"
    if (!headers['content-type']) headers['Content-Type'] = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
    res.removeHeader('X-Frame-Options')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.writeHead(r.status, headers)
    if (!r.body) { res.end(); return }
    Readable.fromWeb(r.body as never).pipe(res)
    void req
  }

  private static(res: ServerResponse, file: string, cache: string): void {
    if (!existsSync(file) || !statSync(file).isFile()) return this.fail(res, 404, 'Not found')
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': cache, 'Content-Length': statSync(file).size })
    createReadStream(file).pipe(res)
  }

  /** The renderer bundle; its index.html gets the bridge first and the server's CSP. */
  private app(res: ServerResponse, path: string): void {
    res.setHeader('Content-Security-Policy', APP_CSP)
    if (path === '/' || path === '/index.html') {
      if (!this.indexHtml || process.env.SAHILBOT_DEV_RELOAD) {
        const file = join(this.o.uiDir, 'index.html')
        if (!existsSync(file)) return this.fail(res, 503, 'The web UI is not built. Run npm run build (or use a release tarball).')
        const raw = readFileSync(file, 'utf8')
        this.indexHtml = raw
          .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, '')
          .replace(/<meta charset="[^"]*"\s*\/?>/i.test(raw) ? /<meta charset="[^"]*"\s*\/?>/i : /<head>/i, (m) => `${m}\n    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n    <meta name="theme-color" content="#ff6a1a">\n    <link rel="manifest" href="/manifest.webmanifest">\n    <link rel="icon" href="/icon.svg" type="image/svg+xml">\n    <link rel="apple-touch-icon" href="/icon.svg">\n    <script src="/__sahilbot/bridge.js"></script>`)
          .replace(/<\/head>/i, '  <link rel="stylesheet" href="/__sahilbot/mobile.css">\n  </head>')
      }
      return this.text(res, 'text/html; charset=utf-8', this.indexHtml, 'no-store')
    }
    const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '')
    const file = join(this.o.uiDir, rel)
    if (!file.startsWith(this.o.uiDir + sep) || rel.includes('..')) return this.fail(res, 404, 'Not found')
    // Hashed bundle files never change.
    return this.static(res, file, rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
  }

  // ---------------------------------------------------------------- WebSocket

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const ip = this.clientIp(req)
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (!isUpgrade(req) || path !== '/ws') return rejectUpgrade(socket, 404, 'Not Found')
    if (!hostAllowed(req.headers.host, this.o.policy)) { this.o.audit.write('host.denied', { ip, detail: String(req.headers.host ?? '').slice(0, 80) }); return rejectUpgrade(socket, 421, 'Misdirected Request') }
    // Cross-site WebSocket hijacking: only this server's own page may connect with the cookie.
    if (!this.sameOrigin(req)) { this.o.audit.write('origin.denied', { ip, detail: `ws from ${String(req.headers.origin ?? 'none').slice(0, 80)}` }); return rejectUpgrade(socket, 403, 'Forbidden') }
    const d = this.o.devices.check(parseCookies(req.headers.cookie)[COOKIE])
    if (!d) { this.o.audit.write('auth.fail', { ip, detail: 'ws' }); return rejectUpgrade(socket, 401, 'Unauthorized') }
    const ws = acceptUpgrade(req, socket, head, { maxPayload: this.o.maxPayload ?? 80 * 1024 * 1024 })
    if (!ws) return
    this.o.devices.seen(d.id, ip)
    this.o.hub.attach(ws, { id: d.id, name: d.name }, ip)
  }

  listen(port: number, hostName: string): Promise<{ port: number }> {
    return new Promise((ok, fail) => {
      this.server.once('error', fail)
      this.server.listen(port, hostName, () => {
        this.server.off('error', fail)
        const a = this.server.address()
        ok({ port: typeof a === 'object' && a ? a.port : port })
      })
    })
  }

  close(): Promise<void> {
    return new Promise((ok) => {
      this.server.close(() => ok())
      this.server.closeAllConnections?.()
      setTimeout(ok, 2000).unref?.()
    })
  }
}
