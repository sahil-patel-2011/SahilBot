import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { invoke, resetRpc } from '../../src/main/rpc'
import { normalizeServerUrl, setupRemoteServer } from '../../src/main/remote-server'
import { AuditLog } from '../../src/server/audit'
import { Devices, PairingCodes, RateLimiter } from '../../src/server/auth'
import { HttpFront } from '../../src/server/http'
import { Hub } from '../../src/server/hub'
import { resolveMasterKey } from '../../src/server/secrets'
import { loadTls } from '../../src/server/tls'

// The Mac app's Settings → Always-on server against a real SahilBot Server front over HTTPS with a
// self-signed certificate: pairing for a token (the certificate pinned), status, opening the web UI
// signed in, unlinking.

describe('Mac app ↔ server', () => {
  let front: HttpFront
  let url: string
  let codes: PairingCodes
  let devices: Devices
  const opened: string[] = []
  const store = new Map<string, unknown>()
  const secret = new Map<string, string>()

  beforeAll(async () => {
    resetRpc()
    const dir = mkdtempSync(join(tmpdir(), 'sb-remote-'))
    mkdirSync(join(dir, 'ui'))
    writeFileSync(join(dir, 'ui', 'index.html'), '<html><head></head><body></body></html>')
    const key = (await resolveMasterKey({ dir, env: {} })).key
    devices = new Devices(dir, key)
    codes = new PairingCodes(join(dir, 'pairing.json'))
    const audit = new AuditLog(join(dir, 'audit.log'))
    const hub = new Hub({ audit, version: '1.2.3', onDirectSend: () => undefined, heartbeatMs: 60_000 })
    front = new HttpFront({ uiDir: join(dir, 'ui'), bridgeFile: join(dir, 'b.js'), tls: loadTls({ dir }), devices, codes, limiter: new RateLimiter({ perKey: 5, total: 50, windowMs: 60_000 }), audit, hub, policy: { allowHosts: [] },
      status: () => ({ version: '1.2.3', uptime: 60, bots: 3, routines: 2, running: 1, queued: 0, rssMB: 140, platform: 'linux', arch: 'arm64' }) })
    const { port } = await front.listen(0, '127.0.0.1')
    url = `https://127.0.0.1:${port}`
    setupRemoteServer({
      db: { getSetting: (k: string) => store.get(k), setSetting: (k: string, v: unknown) => { if (v === null) store.delete(k); else store.set(k, v) } } as never,
      secrets: { get: (k: string) => secret.get(k), set: (k: string, v: string | null) => { if (v === null) secret.delete(k); else secret.set(k, v) } } as never,
      openExternal: (u) => opened.push(u)
    })
  })
  afterAll(async () => { await front.close(); resetRpc() })

  const call = (ch: string, ...args: unknown[]): Promise<any> => invoke(ch, { transport: 'test' }, args)

  test('addresses: https anywhere, plain http only on this Mac', () => {
    expect(normalizeServerUrl('pi.tail123.ts.net')).toBe('https://pi.tail123.ts.net')
    expect(normalizeServerUrl('https://pi.tail123.ts.net/some/path')).toBe('https://pi.tail123.ts.net')
    expect(normalizeServerUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787')
    expect(() => normalizeServerUrl('http://192.168.1.20:8787')).toThrow('https://')
  })

  test('link with a code (self-signed certificate pinned), see status, open the UI signed in, unlink', async () => {
    expect(await call('remoteServer:status')).toEqual({ linked: false })
    await expect(call('remoteServer:connect', url, 'WRONG-CODE1')).rejects.toThrow('didn’t work')
    const st = await call('remoteServer:connect', url, codes.create().code)
    expect(st).toMatchObject({ linked: true, online: true, info: { version: '1.2.3', bots: 3, arch: 'arm64' } })
    expect(st.pinned).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect([...secret.values()][0].length).toBeGreaterThan(30)
    expect(JSON.stringify([...store.values()])).not.toContain([...secret.values()][0])
    expect(devices.list().find((d) => d.kind === 'app')?.name).toContain('(Mac app)')

    await call('remoteServer:openUi')
    expect(opened[0]).toMatch(new RegExp(`^${url}/pair#code=[A-Z0-9]{10}$`))
    // The handed-off code pairs a browser once.
    const code = decodeURIComponent(opened[0].split('#code=')[1])
    expect(codes.consume(code)).toBe(true)

    // A different certificate at the same address is refused (pinning).
    store.set('remoteServer', { ...(store.get('remoteServer') as object), pinned: 'AA:'.repeat(31) + 'AA' })
    expect(await call('remoteServer:status', true)).toMatchObject({ online: false })
    expect((await call('remoteServer:status', true)).error).toContain('certificate changed')
    store.set('remoteServer', { ...(store.get('remoteServer') as object), pinned: st.pinned })

    expect(await call('remoteServer:disconnect')).toEqual({ linked: false })
    expect(devices.list().find((d) => d.kind === 'app')?.revokedAt).toBeTruthy()
    expect(secret.size).toBe(0)
  })
})
