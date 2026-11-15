import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { startFakeServer } from '../fixtures/fake-oauth-mcp'

let llm: MockLlm
const idle = async (page: Page): Promise<void> => {
  await expect.poll(() => llm.script.length, { timeout: 20_000 }).toBe(0)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
}
const lastTool = (req: Record<string, any>): string => String([...req.messages].reverse().find((m: any) => m.role === 'tool')?.content ?? '')

// The in-chat Connect card for an API-key app: the key box is right in the card (nothing is sent to
// the vendor here: a bad paste is caught locally, then the user says Not now and the run goes on).
describe('in-chat connect card', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('an API-key app offers the key box in the card; Cancel lets the run continue', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    llm.script.push(
      { toolCalls: [{ name: 'find_tools', arguments: '{"query":"pagerduty incidents"}' }] },
      (req) => ({ content: lastTool(req).includes('PagerDuty') || /chose not to connect/i.test(lastTool(req)) ? 'OK, without PagerDuty.' : `unexpected: ${lastTool(req).slice(0, 200)}` })
    )
    await page.fill('[data-testid="composer-input"]', 'What incidents are open in PagerDuty?')
    await page.keyboard.press('Enter')
    const card = page.locator('[data-testid="connect-card"]')
    await card.waitFor({ timeout: 20_000 })
    expect(await card.innerText()).toContain('PagerDuty')
    const panel = card.locator('[data-testid="api-key-panel"]')
    await panel.waitFor({ timeout: 10_000 })
    expect(await panel.locator('[data-testid="api-key-link"]').getAttribute('href')).toContain('pagerduty.com')
    expect(await panel.locator('[data-testid="api-key-input"]').getAttribute('type')).toBe('password')
    // A paste with a space is caught before anything is sent.
    await panel.locator('[data-testid="api-key-input"]').fill('not a key')
    await panel.locator('[data-testid="api-key-save"]').click()
    await expect.poll(() => panel.locator('[data-testid="api-key-error"]').innerText()).toMatch(/spaces/)
    await panel.locator('button', { hasText: 'Cancel' }).click()
    await idle(page)
    const bubbles = await page.locator('[data-testid="assistant-bubble"]').allInnerTexts()
    expect(bubbles.join('\n')).toContain('OK, without PagerDuty.')
    expect(await page.evaluate(() => window.foreman.connectors.list().then((l: any) => (Array.isArray(l) ? l : l.connectors ?? []).length))).toBe(0)
    await app.close()
  })

  test('Connect apps: one-click OAuth sign-in (DCR + PKCE) to a local fake app, then revoked → Needs sign-in again → Reconnect; Check all', async () => {
    const fake = await startFakeServer({ name: 'tasks' })
    // SAHILBOT_TEST_OAUTH_FETCH: the sign-in page (on loopback only) is loaded headlessly instead of in the user's browser.
    const { app, page } = await launch(tempProfile(), llm.url, { SAHILBOT_TEST_OAUTH_FETCH: '1' })
    try {
      await page.click('[data-testid="connect-apps"]')
      await page.click('[data-testid="preset-custom"]')
      await page.fill('.conn-form input >> nth=0', 'Tasks')
      await page.fill('[data-testid="conn-url"]', fake.url)
      await page.click('[data-testid="conn-save"]')
      const row = page.locator('[data-testid="connector-row"]')
      await expect.poll(() => row.getAttribute('data-state'), { timeout: 30_000 }).toBe('connected')
      expect(await row.locator('[data-testid="connector-state"]').innerText()).toContain('Connected')
      expect(fake.log.registrations).toHaveLength(1)
      expect(fake.log.authorizes[0].get('code_challenge_method')).toBe('S256')
      // The provider revokes SahilBot's access; Check all finds it without opening a browser.
      fake.revokeAll()
      await page.click('[data-testid="connectors-check-all"]')
      await expect.poll(() => row.getAttribute('data-app-state'), { timeout: 20_000 }).toBe('reauth')
      expect(await row.locator('[data-testid="connector-state"]').innerText()).toContain('Needs sign-in again')
      await expect.poll(() => page.locator('[data-testid="check-all-result"]').innerText()).toContain('1 needs sign-in again')
      expect(fake.log.authorizes).toHaveLength(1)
      // One click on Reconnect signs in again.
      await row.locator('[data-testid="connector-reconnect"]').click()
      await expect.poll(() => row.getAttribute('data-state'), { timeout: 30_000 }).toBe('connected')
      expect(fake.log.authorizes).toHaveLength(2)
      await page.click('[data-testid="connectors-check-all"]')
      await expect.poll(() => page.locator('[data-testid="check-all-result"]').innerText()).toBe('1 working')
    } finally {
      await app.close()
      await fake.close()
    }
  })
})
