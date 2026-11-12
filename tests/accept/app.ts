import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export function tempProfile(): string {
  return mkdtempSync(join(tmpdir(), 'foreman-test-'))
}

export async function launch(dataDir: string, baseUrl: string, extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [resolve('out/main/index.js')],
    env: { ...process.env, FOREMAN_DATA_DIR: dataDir, FOREMAN_BASE_URL: baseUrl, FOREMAN_SKIP_ONBOARDING: '1', FOREMAN_NO_AUTOTITLE: '1', FOREMAN_NO_VERIFY: '1', SAHILBOT_HIDDEN: '1', ...extraEnv } as Record<string, string>
  })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="composer-input"]')
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
