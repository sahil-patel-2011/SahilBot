// Dev helper: what steering looks like while SahilBot works (mock model).
import { test } from 'vitest'
import { startMockLlm } from '../fixtures/mock-llm'
import { launch, tempProfile } from '../accept/app'

test('steer screenshot', async () => {
  const out = process.env.SHOTS_DIR ?? '.'
  const llm = await startMockLlm()
  const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
  await page.setViewportSize({ width: 1400, height: 880 })
  llm.script.push({ content: 'Drafting the newsletter: intro, three tips for new patients, and a short note about extended Saturday hours at the clinic, then a sign-off.', delay: 150 }, { content: 'Got it: I made it shorter and friendlier.' })
  await page.fill('[data-testid="composer-input"]', 'Write this month\'s patient newsletter')
  await page.keyboard.press('Enter')
  await page.locator('[data-testid="steer-hint"]').waitFor()
  await page.fill('[data-testid="composer-input"]', 'keep it under 150 words and friendly')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${out}/r-steer.png` })
  await page.waitForTimeout(5000)
  await page.screenshot({ path: `${out}/r-steer-done.png` })
  await app.close()
  await llm.close()
}, 60_000)
