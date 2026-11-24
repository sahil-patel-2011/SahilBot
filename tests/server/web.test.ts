import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { chromiumPath } from '../fixtures/chromium-path'

// The served web UI in headless Chromium (not Electron): the built server (out/server/index.js) runs as its
// own process with a mock model; the browser pairs with the printed code, chats, approves an action, and
// the layout holds at phone width (390 px). Build first: npm run build && npm run build:server.


let llm: MockLlm
let proc: ChildProcess
let browser: Browser
let url = ''
let code = ''
const data = mkdtempSync(join(tmpdir(), 'sb-web-'))
const workspace = mkdtempSync(join(tmpdir(), 'sb-web-ws-'))
const outside = mkdtempSync(join(tmpdir(), 'sb-web-outside-'))

beforeAll(async () => {
  if (!existsSync(resolve('out/server/index.js')) || !existsSync(resolve('out/renderer/index.html'))) throw new Error('Build first: npm run build && npm run build:server')
  llm = await startMockLlm()
  proc = spawn(process.execPath, [resolve('out/server/index.js'), '--data', data, '--port', '0'], {
    env: { ...process.env, FOREMAN_BASE_URL: llm.url, FOREMAN_SKIP_ONBOARDING: '1', FOREMAN_NO_AUTOTITLE: '1', FOREMAN_NO_VERIFY: '1', FOREMAN_NO_BRAIN: '1', FOREMAN_RAM_GB: '64', SAHILBOT_KNOWLEDGE: '0', SAHILBOT_LEARNING: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  proc.stdout!.on('data', (d) => { out += String(d) })
  proc.stderr!.on('data', (d) => { out += String(d) })
  const end = Date.now() + 30_000
  while (!(url && code)) {
    if (Date.now() > end) throw new Error(`server did not start:\n${out}`)
    url = /running at (http:\/\/\S+)/.exec(out)?.[1] ?? ''
    code = /Pairing code: ([A-Z0-9-]+)/.exec(out)?.[1] ?? ''
    await new Promise((r) => setTimeout(r, 50))
  }
  browser = await chromium.launch({ headless: true, executablePath: chromiumPath() })
})

afterAll(async () => {
  await browser?.close()
  if (proc && proc.exitCode === null) { const gone = new Promise((r) => proc.once('exit', r)); proc.kill('SIGTERM'); await gone }
  await llm?.close()
})

test('pair in a browser, chat, approve, and use it at phone width', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  // Not paired: the app sends you to pairing. A wrong code is refused.
  await page.goto(url)
  await page.waitForURL(/\/pair$/)
  await page.fill('[data-testid="pair-code"]', 'AAAAA-BBBBB')
  await page.click('[data-testid="pair-submit"]')
  await expect.poll(() => page.locator('#msg').innerText()).toContain('didn’t work')
  await page.fill('[data-testid="pair-code"]', code.toLowerCase())
  await page.fill('[data-testid="pair-name"]', 'Playwright')
  await page.click('[data-testid="pair-submit"]')
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 30_000 })
  expect(await page.evaluate(() => (window as any).foreman.runtime)).toBe('server')
  const cookies = await ctx.cookies()
  expect(cookies.find((c) => c.name === 'sb_device')).toMatchObject({ httpOnly: true, sameSite: 'Strict' })
  await page.evaluate((w) => (window as any).foreman.settings.set({ workspaceDir: w }), workspace)

  // Chat: the reply streams in.
  llm.script.push({ content: 'Hello from SahilBot Server in a plain browser.', delay: 30 })
  await page.fill('[data-testid="composer-input"]', 'Say hello')
  await page.keyboard.press('Enter')
  const bubble = page.locator('[data-testid="assistant-bubble"]').last()
  await expect.poll(() => bubble.innerText(), { timeout: 20_000 }).toContain('plain browser')
  await expect.poll(() => bubble.getAttribute('data-status'), { timeout: 20_000 }).toBe('done')

  // An action that needs approval (writing outside the workspace): the card shows; Allow once runs it.
  const target = join(outside, 'approved.txt')
  llm.script.push({ toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path: target, content: 'ok from the web' }) }], delay: 0 }, { content: 'Wrote it.', delay: 5 })
  await page.fill('[data-testid="composer-input"]', `Write ok from the web to ${target}`)
  await page.keyboard.press('Enter')
  await page.waitForSelector('[data-testid="approval-card"]', { timeout: 20_000 })
  await page.click('[data-testid="approve-once"]')
  await expect.poll(() => existsSync(target) && readFileSync(target, 'utf8'), { timeout: 20_000 }).toBe('ok from the web')
  await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText(), { timeout: 20_000 }).toContain('Wrote it')

  // Settings → Server: this device listed; a new pairing code can be made.
  await page.getByTestId('header-settings').click()
  await page.click('[data-testid="settings-server"]')
  await page.waitForSelector('[data-testid="server-status"]')
  await expect.poll(() => page.locator('[data-testid="server-settings"]').innerText()).toContain('Playwright')
  await page.click('[data-testid="server-pair-new"]')
  await expect.poll(() => page.locator('[data-testid="server-pair-code"]').innerText()).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/)
  expect(await page.locator('[data-testid="settings-voice"]').count()).toBe(0)
  await page.click('[data-testid="settings-close"]')

  // Phone width: no sideways scrolling; the sidebar is a drawer; the Tasks / Needs-you board fits.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: await ctx.storageState(), isMobile: true, hasTouch: true })
  const m = await phone.newPage()
  m.on('pageerror', (e) => errors.push(e.message))
  await m.goto(url)
  await m.waitForSelector('[data-testid="composer-input"]', { timeout: 30_000 })
  const overflow = (): Promise<number> => m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(await overflow()).toBeLessThanOrEqual(1)
  const sidebarX = (): Promise<number> => m.evaluate(() => document.querySelector('.sidebar')!.getBoundingClientRect().right)
  expect(await sidebarX()).toBeLessThanOrEqual(0)
  // From the phone: a request that needs approval, answered in the Needs-you inbox (Tasks).
  const target2 = join(outside, 'from-phone.txt')
  llm.script.push({ toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path: target2, content: 'approved on a phone' }) }], delay: 0 }, { content: 'Done on the phone.', delay: 5 })
  await m.fill('[data-testid="composer-input"]', `Write approved on a phone to ${target2}`)
  await m.keyboard.press('Enter')
  await m.waitForSelector('[data-testid="approval-card"]', { timeout: 20_000 })
  expect(await overflow()).toBeLessThanOrEqual(1)
  await m.screenshot({ path: join('test-results', 'server-web-390-approval.png') })
  await m.click('[data-testid="mobile-menu"]')
  await expect.poll(sidebarX).toBeGreaterThan(200)
  await m.click('[data-testid="nav-tasks"]')
  await expect.poll(sidebarX).toBeLessThanOrEqual(0)
  await m.waitForSelector('[data-testid="needs-you-item"][data-kind="approval"]', { timeout: 15_000 })
  expect(await overflow()).toBeLessThanOrEqual(1)
  const card = await m.evaluate(() => { const r = document.querySelector('[data-testid="needs-you-item"]')!.getBoundingClientRect(); return { left: r.left, right: r.right } })
  expect(card.left).toBeGreaterThanOrEqual(0)
  expect(card.right).toBeLessThanOrEqual(390)
  await m.screenshot({ path: join('test-results', 'server-web-390-needs-you.png') })
  await m.click('[data-testid="needs-you-approve"]')
  await expect.poll(() => existsSync(target2) && readFileSync(target2, 'utf8'), { timeout: 20_000 }).toBe('approved on a phone')
  expect(errors).toEqual([])
  await phone.close()
  await ctx.close()
})
