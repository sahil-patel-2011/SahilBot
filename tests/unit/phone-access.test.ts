import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { ChatEvent, PendingRequest } from '@shared/types'
import { dataCodewords, makeQr, qrPath, rsDivisor, rsRemainder } from '@shared/qr'
import { PhoneAccess, pairingUrl, type PhoneDeps } from '../../src/main/phone'
import { bindable, bindPlan, classify, detectTailscale, peerAllowed, phoneAddresses } from '../../src/main/phone/net'
import { phoneNote } from '../../src/main/phone/notes'
import { phoneDenied, phoneGetsEvent, PURCHASE_ON_MAC, purchaseAnswerAllowed } from '../../src/main/phone/policy'
import { canNotifyDevices } from '../../src/main/notify'
import { LAYOUT, layoutFor, MOBILE_CSS, TAP_PX } from '../../src/server/pages'
import type { Session } from '../../src/server/hub'

// Phone access (src/main/phone): the Mac app serves its UI to paired phones on the home network and the
// tailnet only. These cover where it may listen, pairing and removing phones over real HTTPS, what a phone
// may call, which events notify a phone, the QR encoder and the phone layout's breakpoints.

const iface = (address: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false) => ({ address, family, internal, netmask: '', mac: '', cidr: null }) as never

describe('where Phone access listens, and who may connect', () => {
  test('addresses are classified: home network, Tailscale, loopback, link-local, public', () => {
    expect(classify('192.168.1.20')).toBe('lan')
    expect(classify('10.0.0.5')).toBe('lan')
    expect(classify('172.16.4.1')).toBe('lan')
    expect(classify('172.32.0.1')).toBe('public')
    expect(classify('100.101.102.103')).toBe('tailscale')
    expect(classify('100.128.0.1')).toBe('public')
    expect(classify('127.0.0.1')).toBe('loopback')
    expect(classify('::ffff:192.168.1.9')).toBe('lan')
    expect(classify('169.254.3.3')).toBe('link-local')
    expect(classify('8.8.8.8')).toBe('public')
    expect(classify('fd7a:115c:a1e0::1')).toBe('tailscale')
    expect(classify('2001:db8::1')).toBe('public')
    expect(classify('0.0.0.0')).toBe('other')
  })

  test('only Wi-Fi/Ethernet private addresses and the Tailscale interface are used; bridges, VMs and public IPs are not', () => {
    const addrs = phoneAddresses({
      lo0: [iface('127.0.0.1', 'IPv4', true)],
      en0: [iface('192.168.1.20'), iface('fe80::1', 'IPv6')],
      en7: [iface('8.8.4.4')],
      bridge100: [iface('192.168.2.1')],
      vmnet8: [iface('172.16.0.1')],
      utun4: [iface('100.90.1.2')],
      utun5: [iface('10.8.0.2')]
    })
    expect(addrs).toEqual([{ ip: '192.168.1.20', kind: 'lan', iface: 'en0' }, { ip: '100.90.1.2', kind: 'tailscale', iface: 'utun4' }])
  })

  test('never a public address or every interface; loopback only for hidden test runs', () => {
    for (const ip of ['0.0.0.0', '8.8.8.8', '::', '2001:db8::1', '172.32.0.1']) expect(bindable(ip)).toBe(false)
    expect(bindable('127.0.0.1')).toBe(false)
    expect(bindable('127.0.0.1', { allowLoopback: true })).toBe(true)
    expect(bindable('192.168.1.20')).toBe(true)
    expect(bindable('100.90.1.2')).toBe(true)
  })

  test('the plan follows the Home Wi-Fi and Tailscale switches', () => {
    const addrs = [{ ip: '192.168.1.20', kind: 'lan' as const, iface: 'en0' }, { ip: '100.90.1.2', kind: 'tailscale' as const, iface: 'utun4' }]
    expect(bindPlan(addrs, { lan: true, tailscale: true })).toEqual(['192.168.1.20', '100.90.1.2'])
    expect(bindPlan(addrs, { lan: false, tailscale: true })).toEqual(['100.90.1.2'])
    expect(bindPlan(addrs, { lan: true, tailscale: false })).toEqual(['192.168.1.20'])
    expect(bindPlan(addrs, { lan: false, tailscale: false })).toEqual([])
    expect(bindPlan(addrs, { lan: true, tailscale: true }, { loopbackOnly: true })).toEqual(['127.0.0.1'])
    // A public address that slipped into the list is still never used.
    expect(bindPlan([{ ip: '8.8.8.8', kind: 'lan', iface: 'en0' }], { lan: true, tailscale: true })).toEqual([])
  })

  test('connections from the internet are dropped; this Mac, the home network and the tailnet get through', () => {
    for (const ip of ['127.0.0.1', '::1', '192.168.1.44', '::ffff:10.0.0.9', '100.64.0.7', 'fe80::2']) expect(peerAllowed(ip)).toBe(true)
    for (const ip of ['8.8.8.8', '::ffff:1.2.3.4', '2001:db8::5', undefined, '']) expect(peerAllowed(ip as string)).toBe(false)
  })

  test('Tailscale is detected from its app or command and its interface; the MagicDNS name is read when it can be', async () => {
    const ts = [{ ip: '100.90.1.2', kind: 'tailscale' as const, iface: 'utun4' }]
    expect(await detectTailscale([], { exists: () => false })).toEqual({ installed: false, connected: false, ip: undefined })
    expect(await detectTailscale([], { exists: (p) => p === '/Applications/Tailscale.app' })).toMatchObject({ installed: true, connected: false })
    expect(await detectTailscale(ts, { exists: () => true, status: async () => JSON.stringify({ Self: { DNSName: 'sahils-mac.tail1234.ts.net.' } }) }))
      .toEqual({ installed: true, connected: true, ip: '100.90.1.2', dnsName: 'sahils-mac.tail1234.ts.net' })
    // Anything that isn't a tailnet name is ignored.
    expect((await detectTailscale(ts, { exists: () => true, status: async () => JSON.stringify({ Self: { DNSName: 'evil.example.com' } }) })).dnsName).toBeUndefined()
    expect((await detectTailscale(ts, { exists: () => true, status: async () => 'not json' })).connected).toBe(true)
  })
})

describe('what a phone may call', () => {
  test('the Mac’s own screen, the vault and Phone access itself stay on the Mac', () => {
    for (const ch of ['browser:navigate', 'browser:setBounds', 'pickFolder', 'knowledge:addFolder', 'bots:importPick', 'voice:start', 'quick:open', 'attach:screenshot', 'attach:pick', 'files:open', 'permissions:open', 'connectors:connect', 'vault:list', 'vault:reveal', 'vault:totpCode', 'vault:authRespond', 'phoneAccess:setEnabled', 'phoneAccess:revoke', 'remoteServer:connect', 'update:install', 'mcp:setEnabled']) {
      expect(phoneDenied(ch), ch).toBeTruthy()
    }
    expect(phoneDenied('vault:reveal')).toMatch(/stay on your Mac/)
  })

  test('chats, bots, Needs you, approvals, routines and settings work as on the Mac', () => {
    for (const ch of ['chat:send', 'chat:respond', 'chat:stop', 'needsYou:list', 'needsYou:answer', 'threads:list', 'threads:messages', 'spaces:list', 'schedules:list', 'settings:get', 'settings:set', 'attach:add', 'goals:list', 'botAutonomy:setLevel']) {
      expect(phoneDenied(ch), ch).toBeUndefined()
    }
  })

  test('purchases and one-time codes: a phone may only say no', () => {
    expect(purchaseAnswerAllowed('deny')).toBe(true)
    for (const a of ['approve', 'always', 'once', undefined, 'DENY']) expect(purchaseAnswerAllowed(a)).toBe(false)
  })

  test('events only the Mac window uses are not sent to phones', () => {
    for (const e of ['browser:state', 'voice:event', 'vault:auth', 'vault:changed', 'mini', 'phoneAccess:changed', 'docs:flush']) expect(phoneGetsEvent(e), e).toBe(false)
    for (const e of ['chat:event', 'needsYou:changed', 'settings:changed', 'jobs:event', 'open-thread', 'docs:event']) expect(phoneGetsEvent(e), e).toBe(true)
  })
})

describe('which chat events notify a phone', () => {
  const base = { botName: 'Researcher', notify: true, watchingOnMac: false, now: 1_000_000 }
  const pending = (kind: PendingRequest['kind']): ChatEvent => ({ threadId: 't1', type: 'pending', request: { id: 'r1', threadId: 't1', kind } as PendingRequest })

  test('an approval or a question waiting', () => {
    expect(phoneNote(pending('approval'), { ...base, requestLine: 'Wants to run a command' })).toEqual({ title: 'Researcher needs you', body: 'Wants to run a command', threadId: 't1', tag: 'needs-you:t1', kind: 'needs-you' })
    expect(phoneNote(pending('question'), { ...base, requestLine: 'Which city?' })).toMatchObject({ title: 'Researcher has a question', kind: 'question' })
  })

  test('a purchase or code says only that it waits on the Mac (no store, total or card on a lock screen)', () => {
    const n = phoneNote(pending('purchase'), { ...base, requestLine: 'Buy 2 mugs for $40 with Visa 4242' })
    expect(n?.body).toBe('A purchase or code is waiting for your OK on your Mac.')
  })

  test('a long task finishing, or failing; short ones, routines and Quick Ask runs don’t buzz the phone', () => {
    const done: ChatEvent = { threadId: 't1', type: 'run', status: 'finished', title: 'Market report' }
    expect(phoneNote(done, { ...base, startedAt: base.now - 61_000 })).toEqual({ title: 'Researcher is done', body: 'Market report', threadId: 't1', tag: 'done:t1', kind: 'done' })
    expect(phoneNote({ ...done, status: 'error' } as ChatEvent, { ...base, startedAt: base.now - 90_000 })).toMatchObject({ title: 'Researcher hit a problem', kind: 'error' })
    expect(phoneNote(done, { ...base, startedAt: base.now - 5_000 })).toBeNull()
    expect(phoneNote(done, { ...base, startedAt: base.now - 900, longRunMs: 500 })).not.toBeNull()
    expect(phoneNote(done, { ...base })).toBeNull()
    expect(phoneNote(done, { ...base, startedAt: 0, ownNote: true })).toBeNull()
    expect(phoneNote({ ...done, status: 'stopped' } as ChatEvent, { ...base, startedAt: 0 })).toBeNull()
  })

  test('nothing when the bot’s notifications are off or the user is reading that chat on the Mac', () => {
    expect(phoneNote(pending('approval'), { ...base, notify: false })).toBeNull()
    expect(phoneNote(pending('approval'), { ...base, watchingOnMac: true })).toBeNull()
  })
})

describe('the phone layout', () => {
  test('breakpoints: phone up to 760 px, tablet up to 1024 px', () => {
    expect([320, 375, 390, 430, 760].map(layoutFor)).toEqual(['phone', 'phone', 'phone', 'phone', 'phone'])
    expect([761, 820, 1024].map(layoutFor)).toEqual(['tablet', 'tablet', 'tablet'])
    expect([1025, 1440].map(layoutFor)).toEqual(['desktop', 'desktop'])
    expect(MOBILE_CSS).toContain(`@media (max-width:${LAYOUT.phone}px)`)
    expect(MOBILE_CSS).toContain(`@media (max-width:${LAYOUT.tablet}px)`)
  })

  const phoneBlock = MOBILE_CSS.slice(MOBILE_CSS.indexOf(`@media (max-width:${LAYOUT.phone}px)`))
  const rule = (sel: string): string => phoneBlock.split('\n').find((l) => l.includes(`${sel}{`)) ?? ''

  test('the composer stays at the bottom, above the home indicator, with text iOS won’t zoom', () => {
    expect(rule(' .composer-wrap')).toMatch(/position:sticky;bottom:0/)
    expect(rule(' .composer-wrap')).toContain('env(safe-area-inset-bottom)')
    expect(rule(' .composer textarea')).toContain('font-size:16px')
  })

  test('approval, purchase and Needs-you buttons are thumb-sized; the sidebar is a drawer; safe areas respected', () => {
    expect(TAP_PX).toBeGreaterThanOrEqual(44)
    expect(rule(' .pending-actions .btn')).toContain(`min-height:${TAP_PX}px`)
    expect(rule(' .ny-actions .btn')).toContain(`min-height:${TAP_PX}px`)
    expect(rule(' .ny-option')).toContain(`min-height:${TAP_PX}px`)
    expect(rule(' .sidebar')).toMatch(/position:fixed.*transform:translateX\(-102%\)/)
    expect(rule(' .sb-menu-btn')).toContain(`width:${TAP_PX}px`)
    expect(phoneBlock).toContain('env(safe-area-inset-top)')
    expect(phoneBlock).toContain('env(safe-area-inset-left)')
  })

  test('the stylesheet is well formed', () => {
    let depth = 0
    for (const c of MOBILE_CSS.replace(/\/\*[\s\S]*?\*\//g, '')) { if (c === '{') depth++; if (c === '}') depth--; expect(depth).toBeGreaterThanOrEqual(0) }
    expect(depth).toBe(0)
  })
})

describe('the QR encoder', () => {
  test('Reed–Solomon matches the standard’s worked example (version 1-M "HELLO WORLD")', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]
    expect(rsRemainder(data, rsDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23])
  })

  test('capacities, finder and timing patterns, the dark module, and readable format bits', () => {
    expect([1, 5, 10].map(dataCodewords)).toEqual([16, 86, 216])
    const url = pairingUrl('Sahils-MacBook-Pro.local', 8788, 'ABCDE23456', 'AB:CD:EF:01:23:45:67:89:AA:BB')
    expect(url).toBe('https://Sahils-MacBook-Pro.local:8788/pair#code=ABCDE-23456&fp=ABCDEF0123456789')
    const q = makeQr(url)
    expect(q.size).toBe(q.version * 4 + 17)
    const m = q.modules
    for (const [x, y] of [[0, 0], [q.size - 7, 0], [0, q.size - 7]]) {
      // 7×7 finder: dark ring, light ring, dark 3×3 centre.
      expect(m[y][x] && m[y + 6][x + 6] && !m[y + 1][x + 1] && m[y + 3][x + 3]).toBe(true)
    }
    for (let i = 8; i < q.size - 8; i++) { expect(m[6][i]).toBe(i % 2 === 0); expect(m[i][6]).toBe(i % 2 === 0) }
    expect(m[q.size - 8][8]).toBe(true)
    // Format bits next to the top-left finder decode to level M and the chosen mask.
    let bits = 0
    const at = (x: number, y: number): number => (m[y][x] ? 1 : 0)
    const pos: Array<[number, number]> = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]
    pos.forEach(([x, y], i) => { bits |= at(x, y) << i })
    const data = ((bits ^ 0x5412) >>> 10) & 0x1f
    expect(data >> 3).toBe(0)
    expect(data & 7).toBe(q.mask)
    expect(qrPath(q).size).toBe(q.size + 8)
    expect(qrPath(q).d).toMatch(/^M\d+ \d+h\d+v1h-\d+z/)
  })

  test('long text picks a larger version; too long is refused', () => {
    expect(makeQr('x'.repeat(150)).version).toBe(8)
    expect(() => makeQr('x'.repeat(700))).toThrow(/Too long/)
  })
})

// ------------------------------------------------------------------ pairing and removing phones, over real HTTPS

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function hit(port: number, path: string, o: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((ok, fail) => {
    const body = o.body === undefined ? undefined : JSON.stringify(o.body)
    const req = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', rejectUnauthorized: false, headers: { Host: `127.0.0.1:${port}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...o.headers } }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: text }))
    })
    req.on('error', fail)
    if (body) req.write(body)
    req.end()
  })
}

describe('pairing and removing phones (Phone access on 127.0.0.1, as hidden test runs do)', () => {
  let phone: PhoneAccess
  let dir: string
  let saved: Record<string, unknown>
  let keychain: Map<string, string>
  let keychainOk: boolean
  const respond: string[] = []
  const env = { ...process.env }

  const deps = (): PhoneDeps => ({
    db: { getSetting: <T,>(k: string) => saved[k] as T, setSetting: (k, v) => { saved[k] = v } },
    secrets: { get: (n) => keychain.get(n), set: (n, v) => { if (v === null) keychain.delete(n); else keychain.set(n, v) }, available: () => keychainOk },
    dataDir: dir, uiDir: join(dir, 'no-ui'), bridgeFile: join(dir, 'no-bridge.js'), version: '9.9.9', hidden: true,
    pending: (t) => [{ id: 'p1', threadId: t, kind: 'approval' }],
    purchaseRespond: (_t, id, _n, a) => { respond.push(`${id}:${a}`); return { ok: true } },
    fileResponse: async () => new Response('no', { status: 403 })
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sb-phone-'))
    saved = {}
    keychain = new Map()
    keychainOk = true
    respond.length = 0
    process.env.SAHILBOT_PHONE_TEST_BIND = '127.0.0.1'
    process.env.SAHILBOT_PHONE_PORT = '0'
    phone = new PhoneAccess(deps())
  })
  afterEach(async () => {
    await phone.stop()
    process.env = { ...env }
  })

  const port = (): number => phone.status().port
  const codeOf = (): string => phone.status().pairing!.code
  const pair = (code: string, headers: Record<string, string> = {}): Promise<Reply> => hit(port(), '/api/pair', { method: 'POST', body: { code, name: 'Test iPhone' }, headers: { Origin: `https://127.0.0.1:${port()}`, ...headers } })

  test('off by default; on, it listens with HTTPS and shows a QR code with the code and the certificate check', async () => {
    expect(phone.status()).toMatchObject({ enabled: false, running: false })
    const st = await phone.setEnabled(true)
    expect(st).toMatchObject({ enabled: true, running: true })
    expect(st.addresses.every((a) => !a.listening)).toBe(true)
    expect(st.pairing!.url).toMatch(new RegExp(`^https://127\\.0\\.0\\.1:${st.port}/pair#code=[A-Z0-9]{5}-[A-Z0-9]{5}&fp=[0-9A-F]{16}$`))
    expect(st.pairing!.url).toContain(`fp=${st.fingerprint!.replace(/:/g, '').slice(0, 16)}`)
    expect(st.pairing!.qr.d.length).toBeGreaterThan(100)
    // The pairing page and the certificate download are public; everything else needs a paired phone.
    expect((await hit(st.port, '/pair')).body).toContain('SahilBot on your Mac')
    const cer = await hit(st.port, '/sahilbot.cer')
    expect(cer.headers['content-type']).toBe('application/x-x509-ca-cert')
    expect((await hit(st.port, '/api/session')).status).toBe(401)
    expect(canNotifyDevices()).toBe(true)
    await phone.setEnabled(false)
    expect(canNotifyDevices()).toBe(false)
    await expect(hit(st.port, '/pair')).rejects.toThrow()
  })

  test('a code works once; the phone gets an HttpOnly, Secure, SameSite=Strict cookie; removing it signs it out', async () => {
    await phone.setEnabled(true)
    const code = codeOf()
    const r = await pair(code.toLowerCase())
    expect(r.status).toBe(200)
    const cookie = String(r.headers['set-cookie'])
    expect(cookie).toMatch(/sb_device=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure/)
    const jar = cookie.split(';')[0]
    const st = phone.status()
    expect(st.devices).toHaveLength(1)
    expect(st.devices[0]).toMatchObject({ name: 'Test iPhone', kind: 'browser' })
    expect(st.pairing).toBeUndefined()
    expect((await pair(code)).status).toBe(401)
    expect((await hit(port(), '/api/session', { headers: { Cookie: jar } })).status).toBe(200)
    phone.revoke(st.devices[0].id)
    expect((await hit(port(), '/api/session', { headers: { Cookie: jar } })).status).toBe(401)
    expect(phone.status().devices).toHaveLength(0)
    const kinds = phone.auditLog().map((e) => e.kind)
    expect(kinds).toEqual(expect.arrayContaining(['server.start', 'pair.code', 'pair.ok', 'pair.fail', 'device.revoke']))
    // No tokens or codes in the log.
    expect(JSON.stringify(phone.auditLog())).not.toContain(code.replace('-', ''))
    expect(JSON.stringify(phone.auditLog())).not.toContain(jar.split('=')[1])
  })

  test('pairing is rate-limited, and only this page may pair itself', async () => {
    await phone.setEnabled(true)
    expect((await pair(codeOf(), { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await hit(port(), '/pair', { headers: { Host: 'evil.example' } })).status).toBe(421)
    for (let i = 0; i < 5; i++) expect((await pair('AAAAA-BBBBB')).status).toBe(401)
    const limited = await pair(codeOf())
    expect(limited.status).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    expect(phone.auditLog().map((e) => e.kind)).toContain('pair.limited')
  })

  test('the device list is sealed with a key in the Keychain; tokens are never stored', async () => {
    await phone.setEnabled(true)
    const r = await pair(codeOf())
    const token = String(r.headers['set-cookie']).split(';')[0].split('=')[1]
    phone.status()
    await phone.stop()
    expect(keychain.get('phoneAccessKey')).toMatch(/^[0-9a-f]{64}$/)
    const sealed = readFileSync(join(dir, 'phone-access', 'devices.enc'))
    expect(sealed.toString('latin1')).not.toContain('Test iPhone')
    expect(sealed.toString('latin1')).not.toContain(token)
    expect(existsSync(join(dir, 'phone-access', 'master.key'))).toBe(false)
    // Back on: the same phone is still paired.
    await phone.setEnabled(true)
    expect(phone.status().devices.map((d) => d.name)).toEqual(['Test iPhone'])
  })

  test('without the Keychain it refuses to start, and says why', async () => {
    keychainOk = false
    const st = await phone.setEnabled(true)
    expect(st).toMatchObject({ enabled: true, running: false })
    expect(st.error).toMatch(/Keychain/)
  })

  test('a phone’s calls: Mac-only channels refused, pending answered here, purchases deny-only, push set up for that phone only', async () => {
    await phone.setEnabled(true)
    const hook = (phone as unknown as { hook(): (ch: string, args: unknown[], s: Session) => { deny: string } | { answer: () => unknown } | undefined }).hook()
    const s = { deviceId: 'dev1' } as Session
    expect(hook('browser:navigate', ['https://x.test'], s)).toEqual({ deny: expect.stringMatching(/browser runs on your Mac/) })
    expect(hook('vault:list', [], s)).toHaveProperty('deny')
    expect(hook('phoneAccess:setEnabled', [false], s)).toHaveProperty('deny')
    expect(hook('server:revokeDevice', ['dev2'], s)).toHaveProperty('deny')
    expect(hook('chat:send', [{}], s)).toBeUndefined()
    // The app shell's startup question about the Mac's browser panel: an empty answer, never its tabs.
    expect((hook('browser:state', [], s) as { answer: () => unknown }).answer()).toMatchObject({ tabs: [], controlling: false })
    const pend = hook('chat:pending', ['t9'], s) as { answer: () => unknown }
    expect(pend.answer()).toEqual([{ id: 'p1', threadId: 't9', kind: 'approval' }])
    const approve = hook('purchase:respond', ['t9', 'buy1', 'nonce', 'approve'], s) as { answer: () => unknown }
    expect(approve.answer()).toEqual({ ok: false, error: PURCHASE_ON_MAC })
    const deny = hook('purchase:respond', ['t9', 'buy1', 'nonce', 'deny'], s) as { answer: () => unknown }
    expect(deny.answer()).toEqual({ ok: true })
    expect(respond).toEqual(['buy1:deny'])
    const sub = { endpoint: 'https://push.example.com/send/abc', keys: { p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } }
    expect((hook('server:pushSubscribe', [sub], s) as { answer: () => unknown }).answer()).toBe(true)
    expect((hook('server:pushKey', [], s) as { answer: () => unknown }).answer()).toMatch(/^[\w-]{80,}$/)
    expect((hook('server:pushSubscribe', [{ endpoint: 'http://192.168.1.9/x', keys: sub.keys }], s) as { answer: () => unknown }).answer()).toBe(false)
  })
})
