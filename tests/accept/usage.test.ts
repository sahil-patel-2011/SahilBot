import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { seedUsage } from '../fixtures/usage-seed'

// Settings → Usage with seeded usage rows: "$X used of $Y this month", this week / month / lifetime, tokens per
// day and per week, the per-model and per-provider table, per-bot spend, the monthly limit's three modes, and
// the compact card from ⌘K "Usage". Runs hidden; no real provider is called.
describe('usage dashboard', () => {
  let llm: MockLlm
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('shows the seeded month, charts, breakdowns and limit modes', async () => {
    const dir = tempProfile()
    seedUsage(dir)
    const { app, page } = await launch(dir, llm.url)
    try {
      const b = await page.evaluate(() => window.foreman.budget())
      expect(b.requests).toBeGreaterThan(5)
      expect(b.mode).toBe('amount')
      const d = await page.evaluate(() => window.foreman.usage.dashboard())
      expect(d.days).toHaveLength(30)
      expect(d.weeks).toHaveLength(12)
      expect(d.lifetime.requests).toBeGreaterThan(b.requests)
      expect(d.byProvider.map((p) => p.provider)).toEqual(expect.arrayContaining(['anthropic', 'openai', 'xai']))

      await page.keyboard.press('Meta+,')
      await page.waitForSelector('[data-testid="settings"]')
      await page.click('[data-testid="settings-usage"]')
      await page.waitForSelector('[data-testid="usage-page"]')
      await expect.poll(() => page.locator('[data-testid="usage-spend"]').textContent()).toMatch(/\$\d+\.\d\d used of \$200\.00 this month/)
      const tiles = await page.locator('[data-testid="usage-tiles"]').innerText()
      expect(tiles).toMatch(/This week/)
      expect(tiles).toMatch(/Lifetime spend/)
      expect(tiles).toMatch(/Lifetime tokens/)
      expect(await page.locator('[data-testid="usage-days"] svg rect.ud-cloud').count()).toBeGreaterThan(10)
      expect(await page.locator('[data-testid="usage-weeks"] svg rect.ud-cloud').count()).toBe(12)
      const table = await page.locator('[data-testid="usage-table"]').innerText()
      for (const m of ['claude-opus-5-5', 'gpt-6.1-sol', 'grok-4.7', 'qwen3.8:27b']) expect(table).toContain(m)
      expect(table).toMatch(/fast/)
      await page.click('[data-testid="usage-group-provider"]')
      const byProvider = await page.locator('[data-testid="usage-table"]').innerText()
      for (const p of ['Anthropic', 'OpenAI', 'xAI', 'Local models']) expect(byProvider).toContain(p)
      const bots = await page.locator('[data-testid="usage-bots"]').innerText()
      expect(bots).toContain('Research')
      expect(bots).toContain('Writer')

      // The limit's modes (Settings → Models & Keys): Unlimited and None, then back to an amount.
      await page.click('[data-testid="settings-models"]')
      await page.click('[data-testid="spend-mode-unlimited"]')
      await expect.poll(() => page.locator('[data-testid="spend-settings"]').textContent()).toMatch(/used this month · no limit/)
      await page.click('[data-testid="spend-mode-none"]')
      await expect.poll(() => page.evaluate(() => window.foreman.budget().then((x) => x.mode))).toBe('none')
      await expect.poll(() => page.locator('[data-testid="spend-settings"]').textContent()).toMatch(/API spending off/)
      await page.click('[data-testid="spend-mode-amount"]')
      await page.fill('[data-testid="budget-cap"]', '75')
      await page.keyboard.press('Enter')
      await expect.poll(() => page.evaluate(() => window.foreman.budget().then((x) => `${x.mode} ${x.cap}`))).toBe('amount 75')
      await page.click('[data-testid="settings-close"]')

      // The compact card from ⌘K "Usage".
      await page.keyboard.press('Meta+k')
      await page.keyboard.type('Usage')
      await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid="usage-glance"]')
      await expect.poll(() => page.locator('[data-testid="usage-glance-spend"]').textContent()).toMatch(/used of \$75\.00 this month/)
    } finally {
      await app.close()
    }
  }, 90_000)
})
