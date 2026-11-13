// Dev helper: bot details panel (routines, routine detail, library) and routine system lines. Hidden window.
import { tmpdir } from 'node:os'
import { test } from 'vitest'
import { launch, tempProfile } from '../accept/app'
import { startMockLlm } from '../fixtures/mock-llm'

test('bot details shots', async () => {
  const out = process.env.SHOTS_DIR ?? tmpdir()
  const llm = await startMockLlm()
  const { app, page } = await launch(tempProfile(), llm.url)
  await page.setViewportSize({ width: 1100, height: 760 })
  // The bot sets a routine itself, then confirms.
  llm.script.push({ toolCalls: [{ name: 'schedule', arguments: JSON.stringify({ action: 'create', title: 'Weekday school reminder', prompt: 'Check what is due today in my classes and remind me.', when: { type: 'cron', expr: '0 7 * * 1-5' } }) }] })
  llm.script.push({ content: 'Done. I\'ll check your classes every weekday at 7:00 AM. See [the class page](https://example.com/classes).' })
  await page.fill('[data-testid="composer-input"]', 'remind me every weekday morning what is due')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2500)
  // A second routine (paused) and a test run, through the API.
  await page.evaluate(async () => {
    const api = (window as any).foreman
    const main = (await api.spaces.list()).find((s: any) => s.isMain)
    const t = await api.schedules.create({ title: 'Friday reading log', prompt: 'Ask me what I read this week and log it.', schedule: { type: 'weekly', days: ['fri'], time: '16:00' }, spaceId: main.id })
    await api.schedules.update(t.id, { enabled: false })
    const first = (await api.schedules.list()).find((x: any) => x.title === 'Weekday school reminder')
    if (first) await api.schedules.runNow(first.id)
  })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${out}/bd-chat.png` })
  await page.click('[data-testid="bot-pill"]')
  await page.waitForSelector('[data-testid="bot-details"]')
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${out}/bd-details.png` })
  await page.locator('[data-testid="routine-menu"]').first().click()
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${out}/bd-menu.png` })
  await page.keyboard.press('Escape')
  await page.locator('[data-testid="routine-row"] .rt-main').first().click()
  await page.waitForSelector('[data-testid="routine-history"]')
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/bd-routine.png` })
  await page.click('[data-testid="routine-back"]')
  await page.click('[data-testid="bot-tab-library"]')
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${out}/bd-library.png` })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.click('[data-testid="bot-tab-details"]')
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/bd-details-dark.png` })
  await app.close()
  await llm.close()
}, 90_000)
