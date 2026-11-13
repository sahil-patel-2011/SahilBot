// Dev helper (Connect Apps redesign): light + dark screenshots of browse, templates and manage.
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'vitest'
import { launch, tempProfile } from '../accept/app'
import { startMockLlm } from '../fixtures/mock-llm'

test('connect apps shots', async () => {
  const out = process.env.SHOTS_DIR ?? tmpdir()
  const llm = await startMockLlm()
  const { app, page } = await launch(tempProfile(), llm.url)
  await page.setViewportSize({ width: 1100, height: 800 })
  // A local MCP server added through the UI (same steps as the phase 4 acceptance test).
  await page.click('[data-testid="connect-apps"]')
  await page.click('[data-testid="preset-custom"]')
  await page.fill('.conn-form input >> nth=0', 'Notes')
  await page.click('.conn-form .seg button:has-text("Local")')
  await page.fill('[data-testid="conn-command"]', `node ${resolve('tests/fixtures/mcp-notes-server.mjs')}`)
  await page.click('[data-testid="conn-save"]')
  const row = page.locator('[data-testid="connector-row"]')
  for (let i = 0; i < 60 && (await row.getAttribute('data-state')) !== 'connected'; i++) await page.waitForTimeout(250)
  if (!(await row.innerText()).includes('2 tools')) throw new Error(`row: ${await row.innerText()}`)
  // Switching a tool off removes it from the agent's tools and persists.
  // The app just added opens with its tools listed.
  await page.click('[data-testid="tool-send_note"]')
  await page.waitForTimeout(300)
  const off = await page.evaluate(async () => (await (window as any).foreman.connectors.list()).configs[0].disabledTools)
  if (JSON.stringify(off) !== '["send_note"]') throw new Error(`disabledTools: ${JSON.stringify(off)}`)
  if (!(await row.innerText()).includes('1 of 2 tools')) throw new Error(`row after toggle: ${await row.innerText()}`)
  await page.screenshot({ path: `${process.env.SHOTS_DIR ?? tmpdir()}/ca-tool-off.png` })
  await page.click('[data-testid="tool-send_note"]')
  await page.keyboard.press('Escape')
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.locator('[data-testid="connect-apps"]').first().click()
    await page.waitForTimeout(scheme === 'light' ? 5000 : 800)
    await page.screenshot({ path: `${out}/ca-${scheme}-browse.png` })
    await page.locator('.ca-body').evaluate((el) => el.scrollTo({ top: 900 }))
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${out}/ca-${scheme}-browse2.png` })
    await page.click('.ca-chip:has-text("More")')
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${out}/ca-${scheme}-more.png` })
    await page.keyboard.press('Escape')
    await page.locator('[data-testid="connect-apps"]').first().click()
    await page.fill('[data-testid="conn-search"]', 'pdf')
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${out}/ca-${scheme}-search.png` })
    await page.fill('[data-testid="conn-search"]', '')
    await page.click('[data-testid="bot-templates"]')
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${out}/ca-${scheme}-templates.png` })
    await page.click('.ca-back')
    await page.click('[data-testid="connected-count"]')
    if (await page.locator('.ca-tools-btn[aria-expanded="false"]').count()) await page.click('.ca-tools-btn')
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${out}/ca-${scheme}-manage.png` })
    await page.keyboard.press('Escape')
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: `${out}/ca-sidebar.png` })
  // Adding a template creates the bot with its first message.
  await page.locator('[data-testid="connect-apps"]').first().click()
  await page.click('[data-testid="bot-templates"]')
  await page.click('[data-testid="template-travel-planner"] button')
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${out}/ca-added.png` })
  await app.close()
  await llm.close()
}, 120_000)
