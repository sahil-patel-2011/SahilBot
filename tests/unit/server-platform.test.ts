import { createECDH, createDecipheriv, hkdfSync, randomBytes, X509Certificate, verify } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { configureRuns, defaultMemoryLimits, defaultRunLimit, RunScheduler, Slots, setHelperCeiling } from '../../src/main/agent/run-scheduler'
import { botSwarmConfig } from '../../src/main/agent/swarm/bot-config'
import { hasHandler, invoke, resetRpc } from '../../src/main/rpc'
import { SERVER_UNAVAILABLE_TOOLS, serverToolsNote, toolUnavailable } from '../../src/main/runtime'
import { notifyDevices, setDeviceNotifier } from '../../src/main/notify'
import { ToolRegistry } from '../../src/main/agent/registry'
import { host } from '../../src/server/host'
import { encryptPayload, validSubscription, vapidHeader } from '../../src/server/push'
import { selfSigned } from '../../src/server/tls'
import { defaultDataDir, parseArgs } from '../../src/server/index'
import * as electron from '../../src/server/platform/electron'

// SahilBot Server's platform pieces: the headless `electron`, run scheduling and fairness, Web Push
// encryption, the self-signed certificate, tool gating and the command line.

afterEach(() => { delete process.env.SAHILBOT_RUNTIME; resetRpc(); setHelperCeiling(null); configureRuns(null) })

describe('headless electron', () => {
  test('ipcMain.handle lands in the RPC registry; the paired browser is the main window', async () => {
    const w = new electron.BrowserWindow({})
    await w.loadFile('/x/out/renderer/index.html')
    let seen: any
    electron.ipcMain.handle('purchase:respond', (ev: any, a: unknown) => { seen = ev; return a })
    expect(hasHandler('purchase:respond')).toBe(true)
    expect(await invoke('purchase:respond', { transport: 'ws', deviceId: 'd1' }, [5])).toBe(5)
    expect(seen.sender).toBe(w.webContents)
    expect(seen.senderFrame).toBe(w.webContents.mainFrame)
    // Something that isn't a paired browser is never the main window.
    await invoke('purchase:respond', { transport: 'test' }, [1])
    expect(seen.sender).not.toBe(w.webContents)
    electron.ipcMain.removeHandler('purchase:respond')
    expect(hasHandler('purchase:respond')).toBe(false)
    w.close()
  })

  test('the window reaches the browsers; quick windows do not', async () => {
    const sent: unknown[] = []
    host.ui = { send: (e, a) => sent.push([e, ...a]), focused: () => true, connected: () => true, notify: () => ({ delivered: [], queued: [], pushed: [] }) }
    const main = new electron.BrowserWindow({})
    await main.loadFile('/x/out/renderer/index.html')
    const quick = new electron.BrowserWindow({})
    await quick.loadFile('/x/out/renderer/index.html', { hash: 'quick' })
    main.webContents.send('settings:changed')
    quick.webContents.send('quick:shown')
    expect(sent).toEqual([['settings:changed', ]])
    expect(main.isFocused()).toBe(true)
    expect(quick.isFocused()).toBe(false)
    main.close(); quick.close()
  })

  test('notifications go to paired devices with the chat they are about', () => {
    const got: any[] = []
    host.ui = { send: () => undefined, focused: () => false, connected: () => false, notify: (ids, p) => { got.push([ids, p]); return { delivered: [], queued: [], pushed: [] } } }
    expect(electron.Notification.isSupported()).toBe(true)
    host.noteThread = 'thread-9'
    new electron.Notification({ title: 'Researcher needs you', body: 'Approve sending the email?' }).show()
    expect(got[0][0]).toBe('all')
    expect(got[0][1]).toMatchObject({ title: 'Researcher needs you', kind: 'needs-you', threadId: 'thread-9' })
    host.noteThread = undefined
  })

  test('Mac-only services answer "not here" instead of crashing', async () => {
    // Called the way the main process calls Electron (the stand-ins ignore arguments they don't need).
    const E = electron as any
    expect(E.systemPreferences.canPromptTouchID()).toBe(false)
    await expect(E.systemPreferences.promptTouchID('x')).rejects.toThrow('Touch ID is not available')
    expect(E.systemPreferences.isTrustedAccessibilityClient(false)).toBe(false)
    expect(await E.dialog.showOpenDialog({})).toEqual({ canceled: true, filePaths: [] })
    expect((await E.dialog.showMessageBox({ buttons: ['Quit', 'Cancel'], cancelId: 1 })).response).toBe(1)
    expect(E.globalShortcut.register('Alt+Space', () => undefined)).toBe(false)
    const w = new E.BrowserWindow({})
    await expect(w.webContents.printToPDF({})).rejects.toThrow('not available on SahilBot Server')
    // Anything unexpected is a harmless no-op.
    expect(E.app.someFutureApi?.()).toBeUndefined()
    expect(E.app.dock).toBeUndefined()
    new E.Tray('icon').setToolTip('x')
    w.close()
  })

  test('trashItem moves into the data folder (recoverable), never deletes', async () => {
    host.dataDir = mkdtempSync(join(tmpdir(), 'sb-trash-'))
    const f = join(host.dataDir, 'note.txt')
    writeFileSync(f, 'keep me')
    await electron.shell.trashItem(f)
    expect(existsSync(f)).toBe(false)
    expect(readdirSync(join(host.dataDir, 'trash'))[0]).toMatch(/note\.txt$/)
  })

  test('openExternal asks the browser to open http(s) links only', async () => {
    const sent: unknown[] = []
    host.ui = { send: (e, a) => sent.push([e, ...a]), focused: () => true, connected: () => true, notify: () => ({ delivered: [], queued: [], pushed: [] }) }
    await electron.shell.openExternal('https://example.com/a')
    await electron.shell.openExternal('file:///etc/passwd')
    expect(sent).toEqual([['server:open-url', 'https://example.com/a']])
  })
})

describe('tools on the server', () => {
  test('Mac-only tools are not registered on the server, and find_tools explains why', () => {
    const defs = ['computer', 'browser', 'mac_apps', 'web_search'].map((name) => ({ name, description: name, parameters: {}, run: async () => ({ text: '' }) }))
    const mac = new ToolRegistry()
    mac.register(...(defs as never[]))
    expect(mac.all().map((t) => t.name)).toEqual(['computer', 'browser', 'mac_apps', 'web_search'])
    expect(serverToolsNote()).toBe('')
    process.env.SAHILBOT_RUNTIME = 'server'
    const srv = new ToolRegistry()
    srv.register(...(defs as never[]))
    expect(srv.all().map((t) => t.name)).toEqual(['web_search'])
    expect(toolUnavailable('computer')).toBe(true)
    expect(serverToolsNote()).toContain('computer use')
    expect(Object.keys(SERVER_UNAVAILABLE_TOOLS)).toContain('mail')
  })

  test('notifyDevices is a no-op in the Mac app and reaches the server notifier when set', () => {
    expect(notifyDevices('all', { title: 'x' })).toEqual({ delivered: [], queued: [], pushed: [] })
    setDeviceNotifier((ids, p) => ({ delivered: ids === 'all' ? ['d1'] : ids, queued: [], pushed: [p.title] }))
    expect(notifyDevices(['d2'], { title: 'y'.repeat(500) }).pushed[0].length).toBe(120)
    setDeviceNotifier(null)
  })
})

describe('run scheduling', () => {
  const ticket = (spaceId: string, interactive = true) => ({ threadId: `${spaceId}-${Math.random()}`, spaceId, interactive })

  test('a global limit; free slots go to the bot with the fewest runs going', async () => {
    const s = new RunScheduler({ limit: 2 })
    const order: string[] = []
    const go = (t: ReturnType<typeof ticket>) => s.admit(t).then((release) => { order.push(t.spaceId); return release })
    const a1 = await go(ticket('A'))
    const a2 = await go(ticket('A'))
    // Queued runs finish as soon as they start.
    const waiting = [go(ticket('A')), go(ticket('A')), go(ticket('B'))].map((p) => p.then((release) => release()))
    await new Promise((r) => setTimeout(r, 5))
    expect(s.stats()).toMatchObject({ running: 2, queued: 3 })
    a1()
    await new Promise((r) => setTimeout(r, 5))
    // B jumped ahead of A's queued runs: A already had a run going, B had none.
    expect(order.slice(0, 3)).toEqual(['A', 'A', 'B'])
    a2()
    await Promise.all(waiting)
    expect(s.stats()).toMatchObject({ running: 0, queued: 0, admitted: 5, maxRunning: 2 })
  })

  test("within a bot, the user's own runs go before routines; a stopped run leaves the queue", async () => {
    const s = new RunScheduler({ limit: 1 })
    const hold = await s.admit(ticket('A'))
    const order: string[] = []
    const routine = s.admit({ threadId: 'r', spaceId: 'A', interactive: false }).then((r) => { order.push('routine'); r() })
    const ctrl = new AbortController()
    const stopped = s.admit({ threadId: 's', spaceId: 'A', interactive: true, signal: ctrl.signal }).then((r) => { order.push('stopped'); r() })
    const typed = s.admit({ threadId: 't', spaceId: 'A', interactive: true }).then((r) => { order.push('typed'); r() })
    ctrl.abort()
    await stopped
    hold()
    await Promise.all([routine, typed])
    expect(order).toEqual(['stopped', 'typed', 'routine'])
  })

  test('memory pressure queues new runs instead of starting them (one always may run)', async () => {
    let free = 100
    const s = new RunScheduler({ limit: 4, minFreeMB: 500, probe: () => ({ freeMB: free, rssMB: 100 }), recheckMs: 10 })
    const first = await s.admit(ticket('A'))
    let second = false
    const p = s.admit(ticket('B')).then((r) => { second = true; return r })
    await new Promise((r) => setTimeout(r, 30))
    expect(second).toBe(false)
    expect(s.stats().pressure).toBe(true)
    free = 2000
    const r2 = await p
    expect(second).toBe(true)
    first(); r2(); s.dispose()
  })

  test('machine-sized defaults: ~1 run per GB past the first; Pi 5 8 GB gets 7, 4 GB gets 3', () => {
    expect(defaultRunLimit(8, 4)).toBe(7)
    expect(defaultRunLimit(4, 4)).toBe(3)
    expect(defaultRunLimit(2, 4)).toBe(2)
    expect(defaultRunLimit(64, 2)).toBe(32)
    expect(defaultMemoryLimits(8192, 'linux')).toEqual({ minFreeMB: 492, maxRssMB: 4915 })
    expect(defaultMemoryLimits(8192, 'darwin')).toEqual({ maxRssMB: 4915 })
  })

  test('CPU slots: at most N at once, handed over in order', async () => {
    const slots = new Slots(2)
    let busy = 0, peak = 0
    const job = () => slots.run(async () => { busy++; peak = Math.max(peak, busy); await new Promise((r) => setTimeout(r, 5)); busy-- })
    await Promise.all(Array.from({ length: 8 }, job))
    expect(peak).toBe(2)
  })

  test('swarm helpers: the bot max, unless the machine lowers the ceiling', () => {
    expect(botSwarmConfig({ b: { mode: 'auto', maxHelpers: 30, routineUsd: 1 } } as never, 'b').maxHelpers).toBe(30)
    setHelperCeiling(6)
    expect(botSwarmConfig({ b: { mode: 'auto', maxHelpers: 30, routineUsd: 1 } } as never, 'b').maxHelpers).toBe(6)
  })
})

describe('Web Push and TLS', () => {
  test('aes128gcm payloads decrypt with the browser keys (RFC 8291)', () => {
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const auth = randomBytes(16)
    const body = encryptPayload(Buffer.from('{"title":"hi"}'), ua.getPublicKey().toString('base64url'), auth.toString('base64url'))
    const salt = body.subarray(0, 16)
    const idlen = body[20]
    const asPublic = body.subarray(21, 21 + idlen)
    const shared = ua.computeSecret(asPublic)
    const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32))
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
    const ct = body.subarray(21 + idlen)
    const d = createDecipheriv('aes-128-gcm', cek, nonce)
    d.setAuthTag(ct.subarray(ct.length - 16))
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
    expect(plain.subarray(0, -1).toString()).toBe('{"title":"hi"}')
    expect(plain.at(-1)).toBe(2)
  })

  test('VAPID JWT is ES256 over the push service origin; only public HTTPS push endpoints are kept', async () => {
    const { generateKeyPairSync } = await import('node:crypto')
    const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const jwk = kp.publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
    const h = vapidHeader('https://fcm.googleapis.com/fcm/send/abc', kp.privateKey, raw, 'mailto:a@b.c', 0)
    const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h)!
    const [head, claims, sig] = t.split('.')
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'mailto:a@b.c' })
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key: kp.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(true)
    expect(Buffer.from(k, 'base64url').length).toBe(65)
    const keys = { p256dh: raw.toString('base64url'), auth: randomBytes(16).toString('base64url') }
    expect(validSubscription({ endpoint: 'https://web.push.apple.com/abc', keys })).toBe(true)
    expect(validSubscription({ endpoint: 'http://web.push.apple.com/abc', keys })).toBe(false)
    expect(validSubscription({ endpoint: 'https://127.0.0.1/x', keys })).toBe(false)
    expect(validSubscription({ endpoint: 'https://router.local/x', keys })).toBe(false)
  })

  test('the self-signed certificate parses and names this machine', () => {
    const { cert, key } = selfSigned(['localhost', '127.0.0.1', '::1', 'pi.example.ts.net'])
    const x = new X509Certificate(cert)
    expect(x.subject).toContain('CN=SahilBot Server')
    expect(x.subjectAltName).toContain('DNS:pi.example.ts.net')
    expect(x.subjectAltName).toContain('IP Address:127.0.0.1')
    expect(x.checkHost('localhost')).toBe('localhost')
    expect(x.verify(x.publicKey)).toBe(true)
    expect(key).toContain('PRIVATE KEY')
  })
})

describe('command line', () => {
  test('flags, defaults and data folders', () => {
    const a = parseArgs(['--data', '/srv/sb', '--port=9000', '--allow-host', 'bot.example.com', '--max-runs', '6'], {})
    expect(a).toMatchObject({ cmd: 'serve', data: '/srv/sb', port: 9000, listen: '127.0.0.1', allowHosts: ['bot.example.com'], maxRuns: 6 })
    expect(parseArgs(['revoke', 'abc123'], {})).toMatchObject({ cmd: 'revoke', rest: ['abc123'] })
    expect(() => parseArgs(['--port'], {})).toThrow('needs a value')
    expect(() => parseArgs(['--bogus'], {})).toThrow('Unknown option')
    expect(defaultDataDir({ XDG_DATA_HOME: '/x' }, 'linux')).toBe('/x/sahilbot-server')
    expect(defaultDataDir({}, 'darwin')).toContain('Application Support/SahilBot Server')
    expect(defaultDataDir({ SAHILBOT_DATA: '/d' }, 'linux')).toBe('/d')
  })
})
