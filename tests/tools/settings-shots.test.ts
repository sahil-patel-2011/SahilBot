// Dev helper: screenshots of the Settings pages, the pinned bots and a plan, against the mock server.
import { startMockLlm } from '../fixtures/mock-llm'
import { launch, tempProfile } from '../accept/app'
import { test } from 'vitest'

test('settings screenshots', async () => {
  const out = process.env.SHOTS_DIR ?? '.'
  const llm = await startMockLlm()
  const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
  await page.setViewportSize({ width: 1320, height: 860 })
  await page.click('[data-testid="model-picker"]')
  await page.screenshot({ path: `${out}/s-picker.png` })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+,')
  await page.waitForSelector('[data-testid="settings"]')
  for (const p of ['models', 'keys', 'appearance', 'memory', 'voice']) {
    await page.click(`[data-testid="settings-${p}"]`)
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${out}/s-${p}.png` })
  }
  await page.click('[data-testid="settings-close"]')
  // A task with a plan.
  llm.script.push(
    { toolCalls: [{ name: 'todo', arguments: '{"items":[{"text":"Find the latest pricing","status":"done"},{"text":"Compare the three plans","status":"in_progress"},{"text":"Write a short summary","status":"pending"}]}' }] },
    { content: 'Done. The Team plan is the best value for 5 people.' }
  )
  await page.fill('[data-testid="composer-input"]', 'Compare the pricing plans and summarize')
  await page.keyboard.press('Enter')
  await page.waitForSelector('[data-testid="plan-card"]')
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${out}/s-plan.png` })
  await app.close()
  await llm.close()
}, 120_000)
