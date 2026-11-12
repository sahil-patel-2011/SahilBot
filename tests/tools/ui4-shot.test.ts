import { test } from 'vitest'
import { startMockLlm } from '../fixtures/mock-llm'
import { launch, tempProfile } from '../accept/app'

test('ui v4 screenshots', async () => {
  const out = process.env.SHOTS_DIR ?? '.'
  const llm = await startMockLlm()
  const { app, page } = await launch(tempProfile(), llm.url)
  await page.setViewportSize({ width: 1360, height: 880 })
  await page.evaluate(() => window.foreman.settings.set({ userName: 'Sahil' }))
  await page.reload()
  await page.waitForSelector('[data-testid="ideas"]')
  await page.screenshot({ path: `${out}/v4-home.png` })
  llm.script.push(
    { content: 'Here is a quick script that renames your exports:\n\n```bash\nfor f in *.csv; do mv "$f" "q4-$f"; done\n```\n\nIt prefixes every CSV with `q4-`. See the [bash manual](https://www.gnu.org/software/bash/manual/) for details.' },
    { content: 'Working on it…', delay: 400 }
  )
  await page.fill('[data-testid="composer-input"]', 'Give me a one-liner to prefix all my CSV exports with q4-')
  await page.keyboard.press('Enter')
  await page.waitForSelector('[data-testid="retry"]')
  await page.locator('[data-testid="user-bubble"]').last().hover()
  await page.screenshot({ path: `${out}/v4-thread.png` })
  await app.close()
  await llm.close()
}, 60_000)
