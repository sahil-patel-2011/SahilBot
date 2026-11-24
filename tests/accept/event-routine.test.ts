// An event routine in a bot's profile (hidden window, mock model). Grok Bot reviewers: schedules are time-only. A
// routine made by asking ("when an email from vendor.com about an invoice arrives, file it") shows what sets it off,
// how often SahilBot checks, and can be paused like any other.
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

let llm: MockLlm
const shot = async (page: Page, name: string): Promise<void> => { await page.screenshot({ path: `test-results/shots/${name}.png` }).catch(() => undefined) }

describe('event routines', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('a "when an email arrives" routine shows what sets it off and pauses like any other', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    try {
      await page.evaluate(async () => {
        const { space: sp } = await window.foreman.spaces.create({ name: 'Books', intro: false })
        await window.foreman.schedules.create({ title: 'File invoices', prompt: 'Save the invoice PDF to Invoices/ and tell me the total.', schedule: { type: 'when', kind: 'email', from: 'vendor.com', contains: 'invoice' }, spaceId: sp.id })
      })
      await page.reload()
      await page.locator('[data-testid="space-item"]', { hasText: 'Books' }).click()
      await expect.poll(() => page.locator('[data-testid="bot-pill"]').innerText().catch(() => '')).toContain('Books')
      await page.click('[data-testid="bot-pill"]')
      const row = page.locator('[data-testid="routine-row"]', { hasText: 'File invoices' })
      await expect.poll(() => row.count()).toBe(1)
      expect(await row.locator('[data-testid="routine-status"]').innerText()).toBe('When an email from vendor.com mentioning invoice arrives')
      await row.locator('.rt-main').click()
      const detail = page.locator('[data-testid="routine-detail"]')
      await expect.poll(() => detail.innerText().catch(() => '')).toContain('About every 5 minutes while SahilBot is open')
      expect(await detail.innerText()).not.toContain('Not scheduled')
      await shot(page, 'event-routine')
      await page.click('[data-testid="routine-back"]')
      await row.locator('[data-testid="routine-toggle"]').click()
      await expect.poll(() => row.locator('[data-testid="routine-status"]').innerText()).toBe('Paused')
      expect((await page.evaluate(() => window.foreman.schedules.list()))[0].enabled).toBe(false)
    } finally {
      await app.close()
    }
  })
})
