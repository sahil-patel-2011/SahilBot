import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { test } from 'vitest'
import { launch, tempProfile } from '../accept/app'
import { startMockLlm } from '../fixtures/mock-llm'
import { brainFixture, brainReplies } from '../fixtures/brain-fixture'
import { MOBILE_CSS } from '../../src/server/pages'

// Screenshots of the Brain page (light and dark, 1280 and 900 wide, the phone layout) and of an Agent mode
// prompt in Needs you, with fake connected apps and a mock model. SHOTS_DIR picks the folder (outside the repo).

test('brain page screenshots', async () => {
  const out = process.env.SHOTS_DIR ?? tmpdir()
  mkdirSync(out, { recursive: true })
  const llm = await startMockLlm()
  for (let i = 0; i < 80; i++) llm.script.push(brainReplies)
  const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64', SAHILBOT_BRAIN_FIXTURE: brainFixture(), SAHILBOT_QUIET: '1' })
  const size = (w: number, h: number) => app.evaluate(({ BrowserWindow }, [w, h]) => { const win = BrowserWindow.getAllWindows()[0]; win.setMinimumSize(320, 400); win.setContentSize(w, h) }, [w, h])
  try {
    await page.evaluate(() => window.foreman.settings.set({ local: { enabled: true }, userName: 'Sam' } as never))
    await page.evaluate(() => window.foreman.brain.setSettings({ quietHours: { start: '00:00', end: '00:00' }, agentMode: true }))
    await size(1280, 860)
    await page.click('[data-testid="nav-brain"]')
    await page.locator('[data-testid="brain-view"]').waitFor()
    await page.locator('[data-testid="brain-estimate"]').first().waitFor({ timeout: 15_000 })
    for (const scheme of ['light', 'dark'] as const) { await page.emulateMedia({ colorScheme: scheme }); await page.waitForTimeout(150); await page.screenshot({ path: `${out}/brain-empty-estimate-${scheme}.png` }) }
    await page.emulateMedia({ colorScheme: 'light' })
    await page.locator('[data-testid="brain-estimate-ok"]').first().click()
    await page.waitForFunction(async () => (await window.foreman.brain.briefs()).some((b) => /renews Q1/.test(b.text)), undefined, { timeout: 30_000 })
    await page.waitForFunction(async () => !(await window.foreman.brain.status()).syncing, undefined, { timeout: 30_000 })
    await page.click('[data-testid="nav-brain"]')
    await page.waitForTimeout(400)
    for (const [w, h] of [[1280, 860], [900, 860]] as const) {
      await size(w, h)
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme })
        await page.waitForTimeout(200)
        await page.screenshot({ path: `${out}/brain-${w}-${scheme}.png` })
        await page.locator('[data-testid="brain-briefs"]').scrollIntoViewIfNeeded()
        await page.screenshot({ path: `${out}/brain-${w}-${scheme}-briefs.png` })
        await page.locator('[data-testid="brain-view"]').evaluate((el) => { el.scrollTop = 0 })
      }
    }
    // Settings drawer.
    await size(1280, 860)
    await page.emulateMedia({ colorScheme: 'light' })
    await page.click('[data-testid="brain-settings-btn"]')
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${out}/brain-settings-light.png` })
    await page.click('[data-testid="brain-settings-btn"]')
    // The prompt in Needs you.
    await page.click('[data-testid="nav-tasks"]')
    await page.locator('[data-testid="needs-you-item"][data-kind="prompt"]').first().waitFor({ timeout: 15_000 })
    for (const scheme of ['light', 'dark'] as const) { await page.emulateMedia({ colorScheme: scheme }); await page.waitForTimeout(150); await page.screenshot({ path: `${out}/brain-needs-you-${scheme}.png` }) }
    // The phone layout (what Phone access serves): the web UI's markers and mobile stylesheet, 390 wide.
    await page.click('[data-testid="nav-brain"]')
    await page.evaluate((css) => {
      document.documentElement.dataset.runtime = 'server'
      document.documentElement.dataset.layout = 'phone'
      const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st)
    }, MOBILE_CSS)
    await size(390, 844)
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(250)
      await page.screenshot({ path: `${out}/brain-phone-${scheme}.png` })
      await page.locator('[data-testid="brain-briefs"]').scrollIntoViewIfNeeded()
      await page.screenshot({ path: `${out}/brain-phone-${scheme}-briefs.png` })
      await page.locator('[data-testid="brain-view"]').evaluate((el) => { el.scrollTop = 0 })
    }
  } finally {
    await app.close()
    await llm.close()
  }
}, 180_000)
