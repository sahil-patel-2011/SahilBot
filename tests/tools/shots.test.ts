// Dev helper: launches the app against the mock server and saves screenshots.
import { startMockLlm } from '../fixtures/mock-llm'
import { launch, tempProfile } from '../accept/app'

import { test } from 'vitest'

test('screenshots', async () => {
const out = process.env.SHOTS_DIR ?? '.'
const llm = await startMockLlm()
for (const scheme of ['light', 'dark'] as const) {
  const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
  await page.emulateMedia({ colorScheme: scheme })
  await page.setViewportSize({ width: 1320, height: 860 })
  await page.screenshot({ path: `${out}/home-${scheme}.png` })
  llm.script.push({ content: 'Here is a plan:\n\n1. **Pull** the latest numbers\n2. Draft the summary\n3. Send it to `ops@`\n\nWant me to start?', reasoning: 'User wants a weekly report plan.' })
  await page.fill('[data-testid="composer-input"]', 'Help me put together the weekly ops report')
  await page.keyboard.press('Enter')
  await page.waitForSelector('[data-testid="assistant-bubble"][data-status="done"]')
  await page.screenshot({ path: `${out}/thread-${scheme}.png` })
  await app.close()
}
await llm.close()
}, 120_000)
