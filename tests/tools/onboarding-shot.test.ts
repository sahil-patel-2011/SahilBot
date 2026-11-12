// Dev helper: the first-run setup screen as a new user on this Mac would see it (no model server running).
import { test } from 'vitest'
import { launch, tempProfile } from '../accept/app'

test('onboarding screenshots', async () => {
  const out = process.env.SHOTS_DIR ?? '.'
  const { app, page } = await launch(tempProfile(), '', { FOREMAN_BASE_URL: '', FOREMAN_SKIP_ONBOARDING: '' })
  await page.setViewportSize({ width: 1400, height: 900 })
  await page.waitForSelector('[data-testid="onboarding"]')
  await page.fill('[data-testid="onboarding-name"]', 'Sahil')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${out}/o-models.png` })
  await app.close()
}, 60_000)
