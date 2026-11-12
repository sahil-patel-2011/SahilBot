import { writeFileSync } from 'node:fs'
import { test } from 'vitest'
import { startMockLlm } from '../fixtures/mock-llm'
import { startTestSite } from '../fixtures/test-site'
import { launch, tempProfile } from '../accept/app'

test('browser panel screenshot (native view included)', async () => {
  const out = process.env.SHOTS_DIR ?? '.'
  const [llm, site] = await Promise.all([startMockLlm(), startTestSite()])
  const { app, page } = await launch(tempProfile(), llm.url)
  llm.script.push(
    { toolCalls: [{ name: 'browser', arguments: JSON.stringify({ action: 'navigate', url: `${site.url}/login` }) }] },
    { toolCalls: [{ name: 'browser', arguments: JSON.stringify({ action: 'snapshot' }) }], delay: 1500 },
    { content: 'Here is the sign-in page.', delay: 400 }
  )
  await page.fill('[data-testid="composer-input"]', 'Open the Acme portal')
  await page.keyboard.press('Enter')
  await page.locator('[data-testid="browser-overlay"]').waitFor()
  await page.waitForTimeout(600)
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
  writeFileSync(`${out}/browser-panel.png`, Buffer.from(png, 'base64'))
  const tab = await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('/login'))!
    const img = await wc.capturePage()
    return { size: img.getSize(), png: img.toPNG().toString('base64') }
  })
  console.log('TAB SIZE', JSON.stringify(tab.size))
  writeFileSync(`${out}/browser-tab.png`, Buffer.from(tab.png, 'base64'))
  await app.close()
  await Promise.all([llm.close(), site.close()])
}, 60_000)
