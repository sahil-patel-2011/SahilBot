import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { addAdapter, registerHandler, resetRpc } from '../../src/main/rpc'
import { AuditLog } from '../../src/server/audit'
import { Devices, PairingCodes, RateLimiter, formatCode, hostAllowed, normalizeCode, originAllowed } from '../../src/server/auth'
import { decode, encode } from '../../src/server/codec'
import { HttpFront } from '../../src/server/http'
import { Hub } from '../../src/server/hub'
import { resolveMasterKey } from '../../src/server/secrets'

// Pairing and access to SahilBot Server: codes (wrong, expired, reused), devices (revoked), the rate limit,
// Host and Origin checks, CSRF, and the WebSocket transport. A real HTTP server on 127.0.0.1, no Electron.

describe('pairing codes', () => {
  test('a code works once, normalizes spacing and case, and expires', () => {
    let now = 1_000_000
    const codes = new PairingCodes(join(mkdtempSync(join(tmpdir(), 'sb-codes-')), 'p.json'), () => now)
    const { code } = codes.create()
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{10}$/)
    expect(normalizeCode(` ${formatCode(code).toLowerCase()} `)).toBe(code)
    expect(codes.consume(formatCode(code).toLowerCase())).toBe(true)
    expect(codes.consume(code)).toBe(false)
    const late = codes.create().code
    now += 11 * 60_000
    expect(codes.consume(late)).toBe(false)
  })

  test('too many wrong guesses burn the live codes', () => {
    const codes = new PairingCodes(join(mkdtempSync(join(tmpdir(), 'sb-codes-')), 'p.json'))
    const { code } = codes.create()
    for (let i = 0; i < 10; i++) expect(codes.consume('WRONGCODE2')).toBe(false)
    expect(codes.consume(code)).toBe(false)
  })

  test('rate limiter: per address and in total, sliding window', () => {
    let now = 0
    const rl = new RateLimiter({ perKey: 3, total: 5, windowMs: 1000 }, () => now)
    for (let i = 0; i < 3; i++) rl.fail('a')
    expect(rl.retryAfter('a')).toBeGreaterThan(0)
    expect(rl.retryAfter('b')).toBe(0)
    rl.fail('b'); rl.fail('c')
    expect(rl.retryAfter('d')).toBeGreaterThan(0)
    now = 1001
    expect(rl.retryAfter('a')).toBe(0)
  })

  test('host and origin rules', () => {
    const p = { allowHosts: ['bot.example.com', '*.lan.example'] }
    expect(hostAllowed('127.0.0.1:8787', p)).toBe(true)
    expect(hostAllowed('[::1]:8787', p)).toBe(true)
    expect(hostAllowed('localhost:8787', p)).toBe(true)
    expect(hostAllowed('pi.tail1234.ts.net', p)).toBe(true)
    expect(hostAllowed('bot.example.com', p)).toBe(true)
    expect(hostAllowed('x.lan.example:443', p)).toBe(true)
    expect(hostAllowed('evil.example', p)).toBe(false)
    expect(hostAllowed(undefined, p)).toBe(false)
    expect(originAllowed('http://127.0.0.1:8787', '127.0.0.1:8787', false)).toBe(true)
    expect(originAllowed('https://127.0.0.1:8787', '127.0.0.1:8787', false)).toBe(false)
    expect(originAllowed('http://evil.example', '127.0.0.1:8787', false)).toBe(false)
    expect(originAllowed('null', '127.0.0.1:8787', false)).toBe(false)
    expect(originAllowed(undefined, '127.0.0.1:8787', false)).toBe(false)
  })
})

describe('HTTP front and WebSocket', () => {
  let front: HttpFront
  let base: string
  let host: string
  let devices: Devices
  let codes: PairingCodes
  let hub: Hub
  let audit: AuditLog
  const dir = mkdtempSync(join(tmpdir(), 'sb-front-'))

  beforeAll(async () => {
    resetRpc()
    const ui = join(dir, 'ui')
    mkdirSync(join(ui, 'assets'), { recursive: true })
    writeFileSync(join(ui, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8" /><meta http-equiv="Content-Security-Policy" content="x"><title>t</title></head><body><div id="root"></div></body></html>')
    writeFileSync(join(ui, 'assets', 'app.js'), 'console.log(1)')
    writeFileSync(join(dir, 'bridge.js'), '/* bridge */')
    const key = (await resolveMasterKey({ dir, env: {} })).key
    devices = new Devices(dir, key)
    codes = new PairingCodes(join(dir, 'pairing.json'))
    audit = new AuditLog(join(dir, 'audit.log'))
    hub = new Hub({ audit, version: '9.9.9', onDirectSend: () => undefined, heartbeatMs: 60_000 })
    hub.activeDevices = () => devices.active().map((d) => d.id)
    addAdapter(hub.adapter())
    registerHandler('echo', (ctx, x) => ({ x, device: ctx.deviceId, transport: ctx.transport }))
    registerHandler('vault:reveal', () => 'hunter2')
    registerHandler('fails', () => { throw new Error('nope') })
    front = new HttpFront({ uiDir: ui, bridgeFile: join(dir, 'bridge.js'), devices, codes, limiter: new RateLimiter({ perKey: 5, total: 50, windowMs: 60_000 }), audit, hub, policy: { allowHosts: [] }, status: () => ({ ok: true }) })
    const { port } = await front.listen(0, '127.0.0.1')
    host = `127.0.0.1:${port}`
    base = `http://${host}`
  })
  afterAll(async () => { hub.dispose(); await front.close(); resetRpc() })

  const pair = (code: string, origin: string | null = base, extra: Record<string, unknown> = {}): Promise<Response> =>
    fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ code, ...extra }) })
  const cookieOf = (r: Response): string => (r.headers.get('set-cookie') ?? '').split(';')[0]

  test('everything but the pairing page needs a paired device', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
    expect((await fetch(`${base}/pair`)).status).toBe(200)
    const r = await fetch(`${base}/`, { headers: { Accept: 'text/html' }, redirect: 'manual' })
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/pair')
    expect((await fetch(`${base}/api/session`)).status).toBe(401)
    expect((await fetch(`${base}/assets/app.js`)).status).toBe(401)
  })

  test('wrong code, cross-origin pairing and a foreign Host are refused', async () => {
    expect((await pair('AAAAA-BBBBB')).status).toBe(401)
    const { code } = codes.create()
    expect((await pair(code, 'http://evil.example')).status).toBe(403)
    expect((await pair(code, null)).status).toBe(403)
    const evil = await new Promise<number>((ok) => request(`${base}/healthz`, { headers: { Host: 'evil.example' } }, (res) => { res.resume(); ok(res.statusCode ?? 0) }).end())
    expect(evil).toBe(421)
    // The cross-origin attempts didn't use up the code.
    expect((await pair(code)).status).toBe(200)
  })

  test('a paired browser gets an HttpOnly, SameSite=Strict cookie and the app with the bridge', async () => {
    const r = await pair(codes.create().code, base, { name: 'Test phone' })
    expect(r.status).toBe(200)
    const set = r.headers.get('set-cookie') ?? ''
    expect(set).toMatch(/HttpOnly/)
    expect(set).toMatch(/SameSite=Strict/)
    expect(set).not.toMatch(/Secure/)
    const cookie = cookieOf(r)
    const s = await (await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).json() as { device: { name: string }; csrf: string }
    expect(s.device.name).toBe('Test phone')
    const html = await (await fetch(`${base}/`, { headers: { Cookie: cookie } })).text()
    expect(html).toContain('<script src="/__sahilbot/bridge.js"></script>')
    expect(html).not.toContain('http-equiv="Content-Security-Policy"')
    const app = await fetch(`${base}/assets/app.js`, { headers: { Cookie: cookie } })
    expect(app.status).toBe(200)
    expect(app.headers.get('cache-control')).toContain('immutable')
    expect((await fetch(`${base}/assets/../../secrets.ts`, { headers: { Cookie: cookie } })).status).toBe(404)
    // State-changing calls need the CSRF token and the same origin.
    expect((await fetch(`${base}/api/handoff`, { method: 'POST', headers: { Cookie: cookie, Origin: base } })).status).toBe(403)
    expect((await fetch(`${base}/api/handoff`, { method: 'POST', headers: { Cookie: cookie, Origin: 'http://evil.example', 'X-SahilBot-CSRF': s.csrf } })).status).toBe(403)
    expect((await fetch(`${base}/api/handoff`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'X-SahilBot-CSRF': s.csrf } })).status).toBe(200)
  })

  test('the Mac app pairs for a bearer token; a revoked device is locked out', async () => {
    const r = await pair(codes.create().code, null, { mode: 'token', name: 'Mac' })
    const { token, device } = await r.json() as { token: string; device: { id: string } }
    expect(token.length).toBeGreaterThan(30)
    expect((await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200)
    expect(devices.revoke(device.id)).toBe(true)
    expect((await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401)
    expect(audit.recent(50).some((e) => e.kind === 'auth.fail')).toBe(true)
  })

  test('pairing is rate-limited per address', async () => {
    const fresh = new HttpFront({ uiDir: join(dir, 'ui'), bridgeFile: join(dir, 'bridge.js'), devices, codes, limiter: new RateLimiter({ perKey: 3, total: 50, windowMs: 60_000 }), audit, hub, policy: { allowHosts: [] }, status: () => ({}) })
    const { port } = await fresh.listen(0, '127.0.0.1')
    const b = `http://127.0.0.1:${port}`
    const bad = (): Promise<Response> => fetch(`${b}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: b }, body: JSON.stringify({ code: 'ZZZZZ-ZZZZZ' }) })
    for (let i = 0; i < 3; i++) expect((await bad()).status).toBe(401)
    const limited = await bad()
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    // Even the right code waits out the limit.
    const ok = await fetch(`${b}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: b }, body: JSON.stringify({ code: codes.create().code }) })
    expect(ok.status).toBe(429)
    await fresh.close()
  })

  /** Opens a WebSocket the way a browser would (Origin + cookie). */
  function socket(cookie: string, origin = base): Promise<{ ws: WebSocket; msgs: Array<Record<string, any>> }> {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(`ws://${host}/ws`, { headers: { Origin: origin, Cookie: cookie } } as never)
      const msgs: Array<Record<string, any>> = []
      ws.onmessage = (m) => msgs.push(decode(String(m.data)))
      ws.onopen = () => ok({ ws, msgs })
      ws.onerror = () => fail(new Error('refused'))
    })
  }
  const until = async (f: () => boolean, ms = 3000): Promise<void> => {
    const end = Date.now() + ms
    while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)) }
  }

  test('WebSocket: refused cross-origin or without a device; calls, denied channels, events, notifications', async () => {
    const r = await pair(codes.create().code, base, { name: 'Laptop' })
    const cookie = cookieOf(r)
    await expect(socket(cookie, 'http://evil.example')).rejects.toThrow('refused')
    await expect(socket('sb_device=not-a-real-token-at-all-xxxxxxxx')).rejects.toThrow('refused')
    const { ws, msgs } = await socket(cookie)
    await until(() => msgs.some((m) => m.t === 'hello'))
    const hello = msgs.find((m) => m.t === 'hello')!
    expect(hello).toMatchObject({ runtime: 'server', version: '9.9.9', device: { name: 'Laptop' } })

    ws.send(encode({ t: 'call', id: 1, ch: 'echo', args: [{ n: 42, bytes: new Uint8Array([9]) }] }))
    ws.send(encode({ t: 'call', id: 2, ch: 'vault:reveal', args: ['id'] }))
    ws.send(encode({ t: 'call', id: 3, ch: 'fails', args: [] }))
    ws.send(encode({ t: 'call', id: 4, ch: 'missing', args: [] }))
    await until(() => msgs.filter((m) => m.t === 'ret').length === 4)
    const ret = (id: number) => msgs.find((m) => m.t === 'ret' && m.id === id)!
    expect(ret(1).ok).toBe(true)
    expect(ret(1).v.x.n).toBe(42)
    expect([...ret(1).v.x.bytes]).toEqual([9])
    expect(ret(1).v.transport).toBe('ws')
    expect(ret(1).v.device).toBe(hello.device.id)
    expect(ret(2)).toMatchObject({ ok: false })
    expect(ret(2).e).toContain('turned off on SahilBot Server')
    expect(ret(3).e).toBe("Error invoking remote method 'fails': Error: nope")
    expect(ret(4).e).toContain("No handler registered for 'missing'")

    hub.send('chat:event', [{ threadId: 't1', type: 'delta', content: 'hi' }])
    await until(() => msgs.some((m) => m.t === 'ev' && m.ch === 'chat:event'))

    ws.send(encode({ t: 'focus', focused: true, visible: true }))
    await until(() => hub.focused())
    const n = hub.notify('all', { title: 'Bot needs you', threadId: 't1', kind: 'needs-you' })
    expect(n.delivered).toContain(hello.device.id)
    await until(() => msgs.some((m) => m.ch === 'server:notify'))

    // Revoking the device closes its sessions and signs it out.
    const closed = new Promise<number>((r) => { ws.onclose = (e) => r(e.code) })
    devices.revoke(hello.device.id)
    hub.closeDevice(hello.device.id, 'removed')
    expect(await closed).toBe(4001)
    await expect(socket(cookie)).rejects.toThrow('refused')
    // Offline devices get notifications later.
    const other = devices.add('Phone', 'browser')
    const q = hub.notify([other.device.id], { title: 'Done', tag: 'x' })
    expect(q.queued).toEqual([other.device.id])
    const s2 = await socket(`sb_device=${other.token}`)
    await until(() => s2.msgs.some((m) => m.ch === 'server:notify' && m.args[0].missed))
    s2.ws.close()
  })
})
