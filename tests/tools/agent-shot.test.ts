import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { startMockLlm } from '../fixtures/mock-llm'
import { launch, tempProfile } from '../accept/app'

test('agent screenshot', async () => {
  const out = process.env.SHOTS_DIR ?? '.'
  const llm = await startMockLlm()
  const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
  await page.evaluate((ws) => window.foreman.settings.set({ workspaceDir: ws, search: { provider: 'none', searxngUrl: '', hasBraveKey: false } }), mkdtempSync(join(tmpdir(), 'ws-')))
  await page.setViewportSize({ width: 1320, height: 860 })
  llm.script.push(
    { content: "I'll plan this out first.", toolCalls: [{ name: 'todo', arguments: '{"items":[{"text":"Find last week numbers","status":"done"},{"text":"Draft report","status":"in_progress"},{"text":"Email it to ops","status":"pending"}]}' }] },
    { toolCalls: [{ name: 'fetch_page', arguments: '{"url":"https://example.com"}' }] },
    { toolCalls: [{ name: 'file_write', arguments: '{"path":"reports/weekly-ops.md","content":"# Weekly ops\\n- Tickets closed: 142\\n- SLA: 97%"}' }] },
    { content: 'Draft saved to **reports/weekly-ops.md**. Want me to email it to ops@?' }
  )
  await page.fill('[data-testid="composer-input"]', 'Put together the weekly ops report')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.body.innerText.includes('Want me to email') && !document.querySelector('[data-testid="stop"]'))
  await page.click('[data-testid="mode-picker"]')
  await page.locator('.menu-item', { hasText: 'Ask' }).first().click()
  llm.script.push({ toolCalls: [{ name: 'file_write', arguments: '{"path":"reports/weekly-ops.md","content":"# Weekly ops v2","mode":"overwrite"}' }] }, { content: 'ok' })
  await page.fill('[data-testid="composer-input"]', 'Add the SLA chart')
  await page.keyboard.press('Enter')
  await page.locator('[data-testid="approval-card"]').waitFor({ timeout: 5000 }).catch(async (e) => { await page.screenshot({ path: `${out}/fail.png` }); throw e })
  await page.screenshot({ path: `${out}/agent-light.png` })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: `${out}/agent-dark.png` })
  await app.close()
  await llm.close()
}, 60_000)
