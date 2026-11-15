import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

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
})
