import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { startMockLlm } from '../fixtures/mock-llm'
import { launch, tempProfile } from '../accept/app'

test('ui v3 screenshots', async () => {
  const out = process.env.SHOTS_DIR ?? tmpdir()
  const llm = await startMockLlm()
  const { app, page } = await launch(tempProfile(), llm.url)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.click('[data-testid="connect-apps"]')
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/v3-connect.png` })
  await page.keyboard.press('Escape')
  const folder = mkdtempSync(join(tmpdir(), 'Acme-launch-'))
  writeFileSync(join(folder, 'brief.md'), 'x')
  await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as never }, folder)
  await page.click('[data-testid="new-project"]')
  await page.fill('[data-testid="bot-name"]', 'Acme launch')
  await page.click('[data-testid="project-folder"]')
  await page.fill('[data-testid="project-instructions"]', 'Write in British English for Acme executives. Keep decks under 10 slides.')
  await page.click('[data-testid="bot-save"]')
  await page.locator('[data-testid="project-home"]').waitFor()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/v3-project.png` })
  const sp = await page.evaluate(() => window.foreman.spaces.list())
  await page.evaluate((id) => window.foreman.schedules.create({ title: 'Morning inbox summary', prompt: 'Summarize unread client email.', schedule: { type: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '08:30' }, spaceId: id }), sp.find((s) => s.isMain)!.id)
  await page.evaluate((id) => window.foreman.schedules.create({ title: 'Weekly SEO report', prompt: 'Run the Semrush overview.', schedule: { type: 'cron', expr: '0 9 * * 1' }, spaceId: id }), sp.find((s) => s.isMain)!.id)
  await page.click('[data-testid="nav-scheduled"]')
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/v3-scheduled.png` })
  await app.close()
  await llm.close()
}, 90_000)
