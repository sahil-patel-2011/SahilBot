import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { startFakeServer, type FakeServer } from '../fixtures/fake-oauth-mcp'

// Sign-in happens in the user's default browser, and apps without self-registration connect in one
// click with SahilBot's own (built-in) OAuth client. In a hidden run the "open in your browser" request
// is captured instead of opening a real browser (SAHILBOT_TEST_EXTERNAL_LOG); the captured loopback page
// is then signed in headlessly (SAHILBOT_TEST_OAUTH_FETCH) against a local fake provider, and the page
// the browser tab lands on is captured too. Everything stays on 127.0.0.1.

let llm: MockLlm
const idle = async (page: Page): Promise<void> => {
  await expect.poll(() => llm.script.length, { timeout: 30_000 }).toBe(0)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 30_000 }).toBe(0)
}
const send = async (page: Page, text: string): Promise<void> => {
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
}
const names = (r: Record<string, any>): string[] => (r.tools ?? []).map((t: any) => t.function.name)
const lastTool = (r: Record<string, any>): string => String([...r.messages].reverse().find((m: any) => m.role === 'tool')?.content ?? '')
const TOOL = 'chatter__list_items'

type Opened = { url: string; page?: string }
const opened = (log: string): Opened[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Opened) : [])

async function start(): Promise<{ fake: FakeServer; app: Awaited<ReturnType<typeof launch>>['app']; page: Page; log: string }> {
  // A provider without dynamic registration that knows one client: SahilBot's own.
  const fake = await startFakeServer({ name: 'chatter', dcr: false, staticClients: { 'sahilbot-test-client': '' }, tools: [{ name: 'list_items', description: 'Lists your Chatter messages', readOnly: true, reply: () => 'Standup at 10; Ship it' }] })
  const dir = tempProfile()
  const log = join(dir, 'opened-external.jsonl')
  const { app, page } = await launch(dir, llm.url, {
    SAHILBOT_TEST_OAUTH_FETCH: '1',
    SAHILBOT_TEST_EXTERNAL_LOG: log,
    // Two apps without self-registration: one with a built-in client (one click), one without (setup).
    SAHILBOT_TEST_PRESETS: JSON.stringify([
      { id: 'test-chatter', name: 'Chatter', url: fake.url, auth: 'oauth-static', description: 'Your team chat.' },
      { id: 'test-legacy', name: 'Legacy Wiki', url: fake.url, auth: 'oauth-static', description: 'An old wiki.' }
    ]),
    SAHILBOT_OAUTH_CLIENTS_JSON: JSON.stringify({ 'test-chatter': { clientId: 'sahilbot-test-client', redirect: 'loopback' } })
  })
  return { fake, app, page, log }
}

/** The browser was asked to open the provider's own authorize page, and the tab landed on "Connected". */
function expectSignedInExternally(log: string, fake: FakeServer, n: number): void {
  const all = opened(log)
  expect(all).toHaveLength(n)
  const last = all.at(-1)!
  const u = new URL(last.url)
  expect(u.origin).toBe(fake.origin)
  expect(u.pathname).toBe('/authorize')
  expect(u.searchParams.get('client_id')).toBe('sahilbot-test-client')
  expect(u.searchParams.get('code_challenge_method')).toBe('S256')
  expect(u.searchParams.get('state')).toBeTruthy()
  expect(last.page).toContain('Connected to Chatter')
  expect(last.page).toContain('You can close this tab and go back to SahilBot')
}

describe('sign-in in the external browser, one click with a built-in client', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })
  beforeEach(() => { llm.script.length = 0; llm.requests.length = 0 })

  test('Connect apps: the built-in-client app is one click at the top; the other sits under "Needs a one-time setup"', async () => {
    const { fake, app, page, log } = await start()
    try {
      await page.click('[data-testid="connect-apps"]')
      const section = page.locator('[data-testid="section-Other"]')
      await section.waitFor({ timeout: 10_000 })
      const ready = section.locator('[data-testid="section-ready"] [data-testid="preset-test-chatter"]')
      await ready.waitFor({ timeout: 10_000 })
      expect(await ready.locator('[data-testid="badge-test-chatter"]').innerText()).toBe('One click')
      const setupGroup = section.locator('[data-testid="section-setup"]')
      expect(await setupGroup.innerText()).toContain('Needs a one-time setup')
      expect(await setupGroup.locator('[data-testid="preset-test-legacy"] [data-testid="badge-test-legacy"]').innerText()).toBe('Needs setup')
      expect(await section.locator('[data-testid="section-ready"] [data-testid="preset-test-legacy"]').count()).toBe(0)

      // One click: no setup panel, no paste. The provider's page opens in the (captured) default browser.
      await ready.click()
      await expect.poll(() => page.locator('[data-testid="preset-test-chatter"]').getAttribute('data-state'), { timeout: 30_000 }).toBe('connected')
      expect(await page.locator('[data-testid="app-setup"]').count()).toBe(0)
      expectSignedInExternally(log, fake, 1)
      expect(fake.log.registrations).toHaveLength(0)

      // The app without a built-in client opens its one-time setup instead of signing in.
      await page.locator('[data-testid="preset-test-legacy"]').click()
      await page.locator('[data-testid="app-setup"]').waitFor({ timeout: 10_000 })
      expect(opened(log)).toHaveLength(1)
      await page.keyboard.press('Escape')

      // The tools work: a chat uses the connected app directly (no card, no second sign-in).
      llm.script.push(
        { toolCalls: [{ name: 'find_tools', arguments: '{"query":"chatter messages"}' }] },
        (req) => (names(req).includes(TOOL) ? { toolCalls: [{ name: TOOL, arguments: '{}' }] } : { content: `not loaded: ${names(req).join(', ')}` }),
        (req) => ({ content: lastTool(req).includes('Standup at 10') ? 'Chatter says: Standup at 10; Ship it.' : `unexpected: ${lastTool(req).slice(0, 200)}` })
      )
      await send(page, 'What are my latest Chatter messages?')
      await idle(page)
      expect(await page.locator('[data-testid="connect-card"]').count()).toBe(0)
      expect(fake.log.calls.map((c) => c.name)).toEqual(['list_items'])
      await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText().catch(() => ''), { timeout: 10_000 }).toContain('Standup at 10; Ship it')
      expect(opened(log)).toHaveLength(1)
    } finally {
      await app.close()
      await fake.close()
    }
  }, 120_000)

  test('a chat card: one click opens the browser (captured), the tool runs in the same chat; a setup app never gets the one-click button', async () => {
    const { fake, app, page, log } = await start()
    try {
      // An app that still needs its setup: the card shows the setup, not "Connect" (and opens nothing).
      llm.script.push(
        { toolCalls: [{ name: 'find_tools', arguments: '{"query":"legacy wiki pages"}' }] },
        (req) => ({ content: /chose not to connect|Legacy Wiki/i.test(lastTool(req)) ? 'OK, without Legacy Wiki.' : `unexpected: ${lastTool(req).slice(0, 200)}` })
      )
      await send(page, 'Search my Legacy Wiki pages')
      const card = page.locator('[data-testid="connect-card"]')
      await card.waitFor({ timeout: 20_000 })
      await expect.poll(() => card.getAttribute('data-needs-setup'), { timeout: 10_000 }).toBe('1')
      expect(await card.innerText()).toContain('Legacy Wiki needs a one-time setup first')
      expect(await card.locator('[data-testid="connect-card-go"]').count()).toBe(0)
      await card.locator('[data-testid="app-setup"]').waitFor({ timeout: 10_000 })
      await card.locator('[data-testid="app-setup"] button', { hasText: 'Cancel' }).click()
      await idle(page)
      expect(opened(log)).toHaveLength(0)

      // The app with SahilBot's own client: one click in the card, the tool runs on the next step.
      await page.click('[data-testid="new-chat"]')
      llm.requests.length = 0
      llm.script.push(
        { toolCalls: [{ name: 'find_tools', arguments: '{"query":"chatter messages"}' }] },
        (req) => (names(req).includes(TOOL) && /loaded now/.test(lastTool(req)) ? { toolCalls: [{ name: TOOL, arguments: '{}' }] } : { content: `unexpected tools: ${names(req).join(', ')} / ${lastTool(req).slice(0, 300)}` }),
        (req) => ({ content: lastTool(req).includes('Standup at 10') ? 'Your Chatter: Standup at 10; Ship it.' : `unexpected: ${lastTool(req).slice(0, 300)}` })
      )
      await send(page, 'What are my latest Chatter messages?')
      const card2 = page.locator('[data-testid="connect-card"]')
      await card2.waitFor({ timeout: 20_000 })
      expect(await card2.innerText()).toContain('Connect Chatter to continue?')
      expect(await card2.innerText()).toContain('sign-in page opens in your browser')
      expect(await card2.getAttribute('data-needs-setup')).toBeNull()
      await card2.locator('[data-testid="connect-card-go"]').click()
      await idle(page)
      expectSignedInExternally(log, fake, 1)
      expect(fake.log.registrations).toHaveLength(0)
      expect(fake.log.calls.map((c) => c.name)).toEqual(['list_items'])
      await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText().catch(() => ''), { timeout: 10_000 }).toContain('Standup at 10; Ship it')
    } finally {
      await app.close()
      await fake.close()
    }
  }, 120_000)
})
