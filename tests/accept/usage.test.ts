import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile, settingsPage } from './app'
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
      await settingsPage(page, 'usage')
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

      // The limit's modes (Settings → AI & spending): No limit and Don't spend, then back to a monthly limit.
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

  test('Fast mode: a Standard / Fast / Ultrafast choice per model, each with its penalty, saved per model', async () => {
    const prev = llm.models
    llm.models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra']
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_FORCE_PAID: '1' })
    try {
      await page.evaluate(() => window.foreman.settings.set({ setKeys: { anthropic: 'sk-ant-api-test', openai: 'sk-test' } }))
      await page.evaluate(() => window.foreman.models.list())
      await page.keyboard.press('Meta+,')
      await page.waitForSelector('[data-testid="settings"]')
      await page.click('[data-testid="settings-models"]')
      // Fast mode lives under the Models page's Advanced section.
      await page.click('[data-testid="models-advanced"] > summary')
      await page.waitForSelector('[data-testid="fast-mode"]')
      const astra = '[data-testid="fast-model-gpt-6.2-astra"]'
      await page.locator(astra).waitFor()
      // Every option names its speed and its price, in multiples and dollars per million tokens.
      // (Shown under the option's own name; the full line is its tooltip.)
      await expect.poll(() => page.locator('[data-testid="fast-penalty-gpt-6.2-astra-ultrafast"]').textContent()).toMatch(/^up to 4\.5x faster · (3x price \(\$24 \/ \$120 per M\) until Feb 28, 2027, then 6x \(\$48 \/ \$240\)|6x price \(\$48 \/ \$240 per M\))$/)
      expect(await page.locator('[data-testid="fast-penalty-gpt-6.2-astra-ultrafast"]').getAttribute('title')).toMatch(/^Ultrafast · up to 4\.5x faster · /)
      expect(await page.locator('[data-testid="fast-penalty-gpt-6.2-astra-fast"]').textContent()).toBe('up to 2.5x faster · 2x price ($16 / $80 per M)')
      expect(await page.locator('[data-testid="fast-penalty-gpt-6.2-astra-standard"]').textContent()).toBe('normal speed · 1x price ($8 / $40 per M)')
      expect(await page.locator(astra).innerText()).toMatch(/Separate rate limits from Standard and Fast · Responses API only · US data residency only/)
      expect(await page.locator('[data-testid="fast-penalty-gpt-6.2-sol-ultrafast"]').textContent()).toMatch(/\$6 \/ \$30 per M|\$12 \/ \$60 per M/)
      // No Ultrafast where OpenAI doesn't offer it; Claude has Standard and Fast.
      expect(await page.locator('[data-testid="fast-speed-gpt-6.1-terra-ultrafast"]').count()).toBe(0)
      expect(await page.locator('[data-testid="fast-penalty-claude-opus-5-5-fast"]').textContent()).toBe('up to 2.5x faster output · 2x price ($8 / $40 per M)')
      // Off unless switched on: every model follows its provider's switch, which is off.
      expect(await page.locator('[data-testid="fast-speed-gpt-6.2-astra-inherit"]').isChecked()).toBe(true)
      // Choosing Ultrafast for one model saves it for that model only.
      await page.click('[data-testid="fast-speed-gpt-6.2-astra-ultrafast"]')
      await expect.poll(() => page.evaluate(() => window.foreman.settings.get().then((x) => x.fastMode?.models))).toEqual({ 'gpt-6.2-astra': 'ultrafast' })
      await page.click('[data-testid="fast-speed-gpt-6.2-sol-standard"]')
      await expect.poll(() => page.evaluate(() => window.foreman.settings.get().then((x) => x.fastMode?.models))).toEqual({ 'gpt-6.2-astra': 'ultrafast', 'gpt-6.2-sol': 'off' })
      expect(await page.evaluate(() => window.foreman.settings.get().then((x) => x.fastMode?.providers))).toEqual({ anthropic: false, openai: false, xai: false })
      if (process.env.SHOTS_DIR) {
        await page.setViewportSize({ width: 1280, height: 900 })
        await page.locator(astra).scrollIntoViewIfNeeded()
        await page.screenshot({ path: `${process.env.SHOTS_DIR}/fast-mode-speeds.png` })
      }
    } finally {
      llm.models = prev
      await app.close()
    }
  }, 90_000)
})
