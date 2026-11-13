// Dev helper: main window with a bot chat, and Connect Apps, for side-by-side comparison.
import { tmpdir } from 'node:os'
import { test } from 'vitest'
import { launch, tempProfile } from '../accept/app'
import { startMockLlm } from '../fixtures/mock-llm'

test('compare shots', async () => {
  const out = process.env.SHOTS_DIR ?? tmpdir()
  const llm = await startMockLlm()
  const { app, page } = await launch(tempProfile(), llm.url)
  await page.setViewportSize({ width: 1000, height: 730 })
  llm.script.push({ content: 'Checking your classes now. I\'ll be back in a few minutes.' })
  await page.fill('[data-testid="composer-input"]', 'whats due in english today')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${out}/c-chat.png` })
  await page.locator('text=Connect apps').first().click().catch(() => undefined)
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${out}/c-connect.png` })
  await app.close()
  await llm.close()
}, 60_000)
