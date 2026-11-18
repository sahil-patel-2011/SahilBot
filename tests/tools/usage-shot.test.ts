import { tmpdir } from 'node:os'
import { test } from 'vitest'
import { startMockLlm } from '../fixtures/mock-llm'
import { seedUsage } from '../fixtures/usage-seed'
import { launch, tempProfile } from '../accept/app'

// Dev helper (hidden): screenshots of Settings → Usage with seeded rows, the compact usage card, the monthly
// limit, and the Models page's xAI and Fast mode sections, in light and dark. SHOTS_DIR picks the folder.
test('usage dashboard screenshots', async () => {
  const out = process.env.SHOTS_DIR ?? tmpdir()
  const llm = await startMockLlm()
  llm.models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.2-astra', 'gpt-6.2-sol', 'grok-4.7']
  for (const theme of ['light', 'dark'] as const) {
    const dir = tempProfile()
    seedUsage(dir)
    const { app, page } = await launch(dir, llm.url, { FOREMAN_FORCE_PAID: '1' })
    try {
      await page.setViewportSize({ width: 1280, height: 900 })
      // The app follows the system appearance (prefers-color-scheme); emulate it for the dark pass.
      await page.emulateMedia({ colorScheme: theme })
      await page.evaluate((t) => window.foreman.settings.set({ theme: t, setKeys: { anthropic: 'sk-ant-api-test', openai: 'sk-test', xai: 'xai-test' }, fastMode: { providers: { anthropic: true, openai: false, xai: false }, models: { 'gpt-6.2-astra': 'ultrafast' }, auto: 'speed' } }), theme)
      await page.evaluate(() => window.foreman.models.list())
      await page.waitForTimeout(400)
      await page.keyboard.press('Meta+,')
      await page.waitForSelector('[data-testid="settings"]')
      await page.click('[data-testid="settings-usage"]')
      await page.waitForSelector('[data-testid="usage-table"]')
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${out}/usage-${theme}-top.png` })
      await page.locator('[data-testid="usage-weeks"]').hover()
      await page.locator('[data-testid="usage-table"]').scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      await page.screenshot({ path: `${out}/usage-${theme}-table.png` })
      await page.locator('[data-testid="usage-bots"]').scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${out}/usage-${theme}-bots.png` })
      await page.click('[data-testid="settings-general"]')
      await page.locator('[data-testid="spending-limit"]').scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      await page.screenshot({ path: `${out}/usage-${theme}-limit.png` })
      await page.click('[data-testid="settings-models"]')
      await page.click('[data-testid="models-advanced"] > summary')
      await page.waitForSelector('[data-testid="fast-mode"]')
      await page.locator('[data-testid="xai-section"]').scrollIntoViewIfNeeded()
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${out}/usage-${theme}-models-xai.png` })
      await page.locator('[data-testid="fast-mode"]').scrollIntoViewIfNeeded()
      await page.waitForTimeout(200)
      await page.screenshot({ path: `${out}/usage-${theme}-models-fast.png` })
      await page.click('[data-testid="settings-close"]')
      await page.keyboard.press('Meta+k')
      await page.keyboard.type('Usage')
      await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid="usage-glance-spend"]')
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${out}/usage-${theme}-glance.png` })
    } finally {
      await app.close()
    }
  }
  await llm.close()
}, 180_000)
