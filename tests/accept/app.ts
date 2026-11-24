import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export function tempProfile(): string {
  return mkdtempSync(join(tmpdir(), 'foreman-test-'))
}

export async function launch(dataDir: string, baseUrl: string, extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  // Not as plain Node, even when the test runner itself runs on Electron's Node (ELECTRON_RUN_AS_NODE).
  const { ELECTRON_RUN_AS_NODE: _asNode, ...parentEnv } = process.env
  const app = await electron.launch({
    args: [resolve(process.env.LIVE_MAIN ?? 'out/main/index.js')],
    env: { ...parentEnv, FOREMAN_DATA_DIR: dataDir, FOREMAN_BASE_URL: baseUrl, FOREMAN_SKIP_ONBOARDING: '1', FOREMAN_NO_AUTOTITLE: '1', FOREMAN_NO_VERIFY: '1', FOREMAN_NO_BRAIN: '1', SAHILBOT_HIDDEN: '1', ...extraEnv } as Record<string, string>
  })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="composer-input"]')
  // The tests read every step, the model and the cost: Developer mode shows them (quiet: SAHILBOT_QUIET=1).
  if (!extraEnv.SAHILBOT_QUIET) {
    await page.evaluate(() => window.foreman.settings.set({ advanced: { devMode: true } } as never))
    await page.reload()
    await page.waitForSelector('[data-testid="composer-input"]')
  }
  return { app, page }
}

/** Tool steps live inside collapsed activity groups; open them all. */
export async function expandSteps(page: Page): Promise<void> {
  // One at a time: each click changes which groups still match.
  for (let i = 0; i < 30; i++) {
    const closed = page.locator('[data-testid="activity"]:not(.open) [data-testid="activity-head"]')
    if (!(await closed.count())) return
    await closed.first().click({ timeout: 3000 })
  }
}

/** Opens a Settings page, first opening "More settings" when the page sits under it. Settings must be open. */
export async function settingsPage(page: Page, id: string): Promise<void> {
  const item = page.locator(`[data-testid="settings-${id}"]`)
  // Settings lists every page in one flat list (the phone and server pages only once in use, or in Developer mode).
  await page.locator('[data-testid="settings"] .set-nav').waitFor()
  if (!(await item.count()) && (await page.locator('[data-testid="settings-more"]').count())) await page.click('[data-testid="settings-more"]')
  // Pages folded into a section: Spending is under AI, permissions under Privacy, Advanced under General.
  const section: Record<string, string> = { usage: 'models', permissions: 'privacy', advanced: 'general' }
  if (!(await item.count()) && section[id]) {
    await page.click(`[data-testid="settings-${section[id]}"]`)
    if (id === 'advanced') await page.locator('[data-testid="settings-advanced-section"]:not([open]) > summary').click().catch(() => undefined)
    return
  }
  // A page Settings doesn't list (Memory): open it the way a link does.
  if (!(await item.count())) {
    await page.evaluate((p) => window.dispatchEvent(new CustomEvent('sahilbot:open-settings', { detail: p })), id)
    await page.locator(`.set-body[data-page="${id}"]`).waitFor()
    return
  }
  await item.click()
}

/** Opens "More settings" in the Settings nav if it's closed, so every page is listed. */
export async function expandMoreSettings(page: Page): Promise<void> {
  const more = page.locator('[data-testid="settings-more"]')
  if ((await more.count()) && (await more.getAttribute('aria-expanded')) !== 'true') await more.click()
}

/**
 * Puts text in the message box. Playwright's fill inserts text in one go, which under load on Linux (Xvfb)
 * can be dropped right after a modal or menu closes; then it types the text key by key instead.
 */
export async function typeMessage(page: Page, text: string): Promise<void> {
  const box = page.locator('[data-testid="composer-input"]')
  await box.fill(text)
  if ((await box.inputValue()) === text) return
  await box.click()
  await box.fill('')
  await box.pressSequentially(text)
}
