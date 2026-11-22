import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Bot details → Routines → New routine: what to do, how often, when (no chat needed).
let llm: MockLlm
const shots = process.env.SAHILBOT_SHOTS
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })

describe('New routine form', () => {
  test('weekdays at 9:10: saved as a routine in this bot, shown with its schedule', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    try {
      const bot = await page.evaluate(() => window.foreman.spaces.create({ name: 'Science', intro: false }))
      await page.reload()
      await page.locator('[data-testid="space-item"]', { hasText: 'Science' }).first().click()
      await page.click('[data-testid="bot-pill"]')
      await page.locator('[data-testid="bot-details"]').waitFor()
      await page.click('[data-testid="routine-new"]')
      await page.fill('[data-testid="routine-form-prompt"]', 'Send me a short science fact')
      await page.click('[data-testid="routine-form-weekdays"]')
      await page.fill('[data-testid="routine-form-time"]', '09:10')
      if (shots) { await page.waitForTimeout(400); await page.screenshot({ path: `${shots}/routine-form.png` }) }
      await page.click('[data-testid="routine-form-save"]')
      await expect.poll(async () => (await page.evaluate(() => window.foreman.schedules.list())).length, { timeout: 10_000 }).toBe(1)
      const [r] = await page.evaluate(() => window.foreman.schedules.list())
      expect(r).toMatchObject({ title: 'Send me a short science fact', spaceId: bot.space.id, schedule: { type: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '09:10' } })
      await expect.poll(() => page.locator('[data-testid="routine-row"]').count()).toBe(1)
      expect(await page.locator('[data-testid="routine-form"]').count()).toBe(0)
      // A time in the past can't be saved as a one-time routine.
      await page.click('[data-testid="routine-new"]')
      await page.fill('[data-testid="routine-form-prompt"]', 'Remind me')
      await page.click('[data-testid="routine-form-once"]')
      await page.fill('[data-testid="routine-form-date"]', '2020-01-01')
      expect(await page.locator('[data-testid="routine-form-save"]').isDisabled()).toBe(true)
    } finally {
      await app.close()
    }
  })
})
