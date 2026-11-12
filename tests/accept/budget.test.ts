import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Cloud budget: a paid request that could pass the monthly cap is refused before it is sent.
describe('cloud spending cap', () => {
  let llm: MockLlm
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('blocks over-cap requests without sending them, allows and records them under the cap', async () => {
    llm.models = ['claude-opus-5-5']
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_FORCE_PAID: '1' })
    await page.evaluate(() => window.foreman.settings.set({ defaultModel: 'claude-opus-5-5', cloudBudgetUsd: 0.05 }))
    const before = llm.requests.length
    await page.fill('[data-testid="composer-input"]', 'hello')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.locator('.notice, [data-testid="assistant-bubble"]').allInnerTexts().then((t) => t.join(' ')), { timeout: 15_000 }).toContain('Cloud budget reached')
    expect(llm.requests.length).toBe(before)

    await page.evaluate(() => window.foreman.settings.set({ cloudBudgetUsd: 1 }))
    llm.script.push({ content: 'Hi!' })
    await page.fill('[data-testid="composer-input"]', 'hello again')
    await page.keyboard.press('Enter')
    await expect.poll(() => llm.requests.length, { timeout: 15_000 }).toBe(before + 1)
    await expect.poll(async () => (await page.evaluate(() => window.foreman.budget())).requests, { timeout: 10_000 }).toBe(1)
    const b = await page.evaluate(() => window.foreman.budget())
    expect(b.spent).toBeGreaterThan(0)
    expect(b.spent).toBeLessThan(0.01)
    await app.close()
  })
})
