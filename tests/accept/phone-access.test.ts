import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { PhoneAccessStatus } from '@shared/types'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { chromiumPath } from '../fixtures/chromium-path'

// Phone access end to end, hidden (SAHILBOT_HIDDEN=1: no window ever shows): the Mac app turns it on (bound
// to 127.0.0.1 for the test, never the real Wi-Fi), headless Chromium at iPhone size pairs as a phone from
// the QR code's link, chats, answers an approval with a tap, and is refused the Mac-only calls; then, with
// the phone closed, an approval waiting on the Mac and a long task finishing reach it as Web Push. The push
// service is a local sink; the test decrypts the payload with the phone's own keys (RFC 8291).


interface Pushed { endpoint: string; headers: Record<string, string>; body: string }

/** The phone's side of RFC 8291: decrypts an aes128gcm push body with its private key and auth secret. */
function decryptPush(body: Buffer, ua: ReturnType<typeof createECDH>, auth: Buffer): unknown {
  const salt = body.subarray(0, 16)
  const idLen = body[20]
  const asPublic = body.subarray(21, 21 + idLen)
  const ct = body.subarray(21 + idLen)
  const shared = ua.computeSecret(asPublic)
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(ct.subarray(ct.length - 16))
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString('utf8'))
}

let llm: MockLlm
let sink: Server
let sinkUrl = ''
const pushed: Pushed[] = []
let browser: Browser
const shots = join('test-results')

beforeAll(async () => {
  llm = await startMockLlm()
  sink = createServer((req, res) => {
    let text = ''
    req.on('data', (c) => { text += c })
    req.on('end', () => { try { pushed.push(JSON.parse(text) as Pushed) } catch { /* ignored */ } res.writeHead(201); res.end() })
  })
  await new Promise<void>((ok) => sink.listen(0, '127.0.0.1', ok))
  const a = sink.address()
  sinkUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath() })
  mkdirSync(shots, { recursive: true })
})

afterAll(async () => {
  await browser?.close()
  await new Promise((ok) => sink?.close(ok))
  await llm?.close()
})

test('a phone pairs from the QR link, chats, approves, is kept off the Mac’s screen and vault, and gets push notifications', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'sb-phone-ws-'))
  const outside = mkdtempSync(join(tmpdir(), 'sb-phone-out-'))
  const { app, page: mac } = await launch(tempProfile(), llm.url, {
    SAHILBOT_PHONE_TEST_BIND: '127.0.0.1', SAHILBOT_PHONE_PORT: '0', SAHILBOT_PHONE_PUSH_SINK: sinkUrl, SAHILBOT_PHONE_LONG_RUN_MS: '400', SAHILBOT_PHONE_WATCH_MS: '600000'
  })
  try {
    await mac.evaluate((w) => window.foreman.settings.set({ workspaceDir: w }), workspace)

    // Settings → General → Phone access: off by default; on, a QR code and a code.
    await mac.keyboard.press('Meta+,')
    await mac.locator('[data-testid="settings"]').waitFor()
    await mac.click('[data-testid="settings-general"]')
    await mac.waitForSelector('[data-testid="phone-access-toggle"][aria-checked="false"]')
    await mac.click('[data-testid="phone-access-toggle"]')
    await mac.waitForSelector('[data-testid="phone-qr"]', { timeout: 15_000 })
    const st = (await mac.evaluate(() => window.foreman.phoneAccess!.status())) as PhoneAccessStatus
    expect(st).toMatchObject({ enabled: true, running: true })
    expect(await mac.locator('[data-testid="phone-code"]').innerText()).toBe(st.pairing!.code)
    await mac.locator('[data-setting="phone-access"]').screenshot({ path: join(shots, 'phone-access-mac.png') })
    await mac.click('[data-testid="settings-close"]')
    const link = st.pairing!.url
    expect(link).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/pair#code=[A-Z0-9-]{11}&fp=[0-9A-F]{16}$/)

    // The phone: an iPhone-sized headless browser that accepted the Mac's certificate.
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1' })
    const phone = await phoneCtx.newPage()
    const errors: string[] = []
    phone.on('pageerror', (e) => errors.push(e.message))
    await phone.goto(link)
    // The certificate check from the QR link, then one tap to pair.
    await phone.waitForSelector('[data-testid="pair-fingerprint"]')
    expect((await phone.locator('#fp-value').innerText()).replace(/ /g, '')).toBe(st.fingerprint!.replace(/:/g, '').slice(0, 16))
    expect(await phone.inputValue('[data-testid="pair-code"]')).toBe(st.pairing!.code)
    await phone.screenshot({ path: join(shots, 'phone-access-pair.png') })
    await phone.tap('[data-testid="pair-submit"]')
    await phone.waitForSelector('[data-testid="composer-input"]', { timeout: 30_000 })
    expect(await phone.evaluate(() => [window.foreman.runtime, window.foreman.serverHost, document.documentElement.dataset.layout])).toEqual(['server', 'mac', 'phone'])
    const cookies = await phoneCtx.cookies()
    expect(cookies.find((c) => c.name === 'sb_device')).toMatchObject({ httpOnly: true, sameSite: 'Strict', secure: true })
    // The Mac lists the phone (named from its browser).
    await expect.poll(async () => ((await mac.evaluate(() => window.foreman.phoneAccess!.status())) as PhoneAccessStatus).devices.map((d) => d.name)).toEqual(['Safari on iPhone'])

    // Chat from the phone: the reply streams in; the composer sits at the bottom of the screen.
    llm.script.push({ content: 'Hello from your Mac, on your phone.', delay: 20 })
    await phone.fill('[data-testid="composer-input"]', 'Say hello')
    await phone.keyboard.press('Enter')
    const bubble = phone.locator('[data-testid="assistant-bubble"]').last()
    await expect.poll(() => bubble.innerText(), { timeout: 20_000 }).toContain('on your phone')
    await expect.poll(() => bubble.getAttribute('data-status'), { timeout: 20_000 }).toBe('done')
    const composer = await phone.evaluate(() => document.querySelector('.composer-wrap')!.getBoundingClientRect().bottom)
    expect(composer).toBeGreaterThan(844 - 4)
    expect(await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)

    // An approval from the phone: a thumb-sized card; Allow once runs it on the Mac.
    const target = join(outside, 'from-phone.txt')
    llm.script.push({ toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path: target, content: 'approved on a phone' }) }], delay: 0 }, { content: 'Wrote it from your phone.', delay: 5 })
    await phone.fill('[data-testid="composer-input"]', `Write approved on a phone to ${target}`)
    await phone.keyboard.press('Enter')
    const card = phone.locator('[data-testid="approval-card"]')
    await card.waitFor({ timeout: 20_000 })
    const btn = await phone.locator('[data-testid="approve-once"]').boundingBox()
    expect(btn!.height).toBeGreaterThanOrEqual(44)
    expect(btn!.x).toBeGreaterThanOrEqual(0)
    expect(btn!.x + btn!.width).toBeLessThanOrEqual(390)
    await phone.screenshot({ path: join(shots, 'phone-access-approval.png') })
    await phone.tap('[data-testid="approve-once"]')
    await expect.poll(() => existsSync(target) && readFileSync(target, 'utf8'), { timeout: 20_000 }).toBe('approved on a phone')
    await expect.poll(() => phone.locator('[data-testid="assistant-bubble"]').last().innerText(), { timeout: 20_000 }).toContain('from your phone')

    // What stays on the Mac: its browser panel, the vault, Phone access itself.
    const refused = await phone.evaluate(async () => {
      const f = window.foreman as any
      const msg = (p: Promise<unknown>): Promise<string> => p.then(() => 'allowed', (e: Error) => e.message)
      return { browser: await msg(f.browser.navigate('https://example.com')), vault: await msg(f.vault.list()), reveal: await msg(f.vault.reveal('x')), phone: await msg(f.phoneAccess ? f.phoneAccess.setEnabled(false) : Promise.reject(new Error('no phoneAccess api'))) }
    })
    expect(refused.browser).toMatch(/browser runs on your Mac/)
    expect(refused.vault).toMatch(/stay on your Mac/)
    expect(refused.reveal).toMatch(/turned off|stay on your Mac/)
    expect(refused.phone).toBe('no phoneAccess api')

    // Settings → This phone on the phone; then notifications for this phone (a test push service).
    await phone.tap('[data-testid="header-settings"]')
    await phone.tap('[data-testid="settings-server"]')
    await phone.waitForSelector('[data-testid="phone-settings"]')
    await expect.poll(() => phone.locator('[data-testid="phone-host"]').innerText()).toContain('SahilBot on')
    await phone.screenshot({ path: join(shots, 'phone-access-settings.png') })
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const auth = randomBytes(16)
    const endpoint = 'https://push.example.com/wpush/phone-1'
    expect(await phone.evaluate((sub) => window.foreman.server!.pushSubscribe(sub), { endpoint, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } })).toBe(true)
    await phone.close()
    await expect.poll(async () => ((await mac.evaluate(() => window.foreman.phoneAccess!.status())) as PhoneAccessStatus).devices[0]?.sessions, { timeout: 10_000 }).toBe(0)

    // With the phone closed: an approval waits on the Mac → a push that says so.
    const target2 = join(outside, 'waits.txt')
    llm.script.push({ toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path: target2, content: 'x' }) }], delay: 0 }, { content: 'Okay, I won’t.', delay: 5 })
    await mac.fill('[data-testid="composer-input"]', `Write x to ${target2}`)
    await mac.keyboard.press('Enter')
    await mac.waitForSelector('[data-testid="approval-card"]', { timeout: 20_000 })
    await expect.poll(() => pushed.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
    const first = pushed[0]
    expect(first.endpoint).toBe(endpoint)
    expect(first.headers['Content-Encoding']).toBe('aes128gcm')
    expect(first.headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/)
    expect(JSON.parse(Buffer.from(first.headers.Authorization.split(/[ .]/)[2], 'base64url').toString())).toMatchObject({ aud: 'https://push.example.com' })
    const note = decryptPush(Buffer.from(first.body, 'base64'), ua, auth) as { title: string; body: string; threadId: string }
    expect(note.title).toBe('SahilBot needs you')
    expect(note.body).toBe('Wants to write a file')
    expect(note.threadId).toBeTruthy()
    // The push service only ever saw ciphertext.
    expect(Buffer.from(first.body, 'base64').toString('latin1')).not.toContain('needs you')
    await mac.click('[data-testid="approve-deny"]')
    await expect.poll(() => mac.locator('[data-testid="assistant-bubble"]').last().getAttribute('data-status'), { timeout: 20_000 }).toBe('done')
    await expect.poll(() => mac.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
    await mac.waitForTimeout(800)

    // A long task finishing → "done" on the phone.
    // In a new chat: the approval run above may itself count as long, and the same news about the same
    // chat within 5 s goes out once (hub.notify).
    await mac.click('[data-testid="new-chat"]')
    const before = pushed.length
    llm.script.push({ content: 'Here is the long report you asked for, finished at last.', delay: 120 })
    await mac.fill('[data-testid="composer-input"]', 'Write the long report')
    await mac.keyboard.press('Enter')
    await expect.poll(() => pushed.slice(before).map((p) => (decryptPush(Buffer.from(p.body, 'base64'), ua, auth) as { title: string }).title), { timeout: 30_000 }).toContain('SahilBot is done')

    // Removing the phone on the Mac signs it out at once.
    const id = ((await mac.evaluate(() => window.foreman.phoneAccess!.status())) as PhoneAccessStatus).devices[0].id
    await mac.evaluate((x) => window.foreman.phoneAccess!.revoke(x), id)
    const again = await phoneCtx.newPage()
    await again.goto(link.replace(/\/pair#.*/, '/'))
    await again.waitForURL(/\/pair$/)
    const kinds = ((await mac.evaluate(() => window.foreman.phoneAccess!.audit(200))) as Array<{ kind: string }>).map((e) => e.kind)
    expect(kinds).toEqual(expect.arrayContaining(['server.start', 'pair.code', 'pair.ok', 'session.open', 'session.close', 'call.approval', 'call.denied', 'device.revoke']))
    expect(errors).toEqual([])
    await phoneCtx.close()
  } finally {
    await app.close()
  }
})
