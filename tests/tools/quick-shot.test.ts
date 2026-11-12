// Dev helper: screenshots of Quick Ask and the home ideas (mock model, hidden window).
import { test } from 'vitest'
import { startMockLlm } from '../fixtures/mock-llm'
import { launch, tempProfile } from '../accept/app'

test('quick ask screenshots', async () => {
  const out = process.env.SHOTS_DIR ?? '.'
  const llm = await startMockLlm()
  const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
  await page.setViewportSize({ width: 1400, height: 880 })
  await page.evaluate(() => window.foreman.settings.set({ userName: 'JP' }))
  await page.reload()
  await page.waitForSelector('[data-testid="ideas"]')
  await page.screenshot({ path: `${out}/q-home.png` })
  llm.script.push({ content: '**Tamsulosin** is an alpha-blocker used for BPH symptoms. Common side effects are dizziness and abnormal ejaculation; take it 30 minutes after the same meal each day.\n\nSources: FDA label [1]' })
  await page.evaluate(() => { location.hash = '#quick' })
  await page.reload()
  await page.setViewportSize({ width: 720, height: 300 })
  await page.fill('[data-testid="quick-input"]', 'what is tamsulosin for?')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${out}/q-bar.png` })
  await app.close()
  await llm.close()
}, 60_000)
