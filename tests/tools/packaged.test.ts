import { _electron as electron } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'vitest'
// Smoke check: the packaged SahilBot.app starts and renders its UI (no model calls).
test('packaged app starts', async () => {
  const app = await electron.launch({ executablePath: resolve('dist/mac-arm64/SahilBot.app/Contents/MacOS/SahilBot'), env: { ...process.env, FOREMAN_DATA_DIR: mkdtempSync(join(tmpdir(), 'pkg-')), FOREMAN_SKIP_ONBOARDING: '1', FOREMAN_BASE_URL: 'http://127.0.0.1:9/v1', SAHILBOT_HIDDEN: '1' } as Record<string, string> })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 30_000 })
  const info = await app.evaluate(({ app: a }) => ({ name: a.getName(), packaged: a.isPackaged }))
  const docs = await page.evaluate(() => document.title)
  process.stderr.write(`PKG ${JSON.stringify({ ...info, title: docs, errors })}\n`)
  await app.close()
}, 60_000)
