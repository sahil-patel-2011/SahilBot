import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { startMockLlm } from '../fixtures/mock-llm'
import { launch, tempProfile } from '../accept/app'

test('ui v2 screenshots', async () => {
  const out = process.env.SHOTS_DIR ?? tmpdir()
  const llm = await startMockLlm()
  const { app, page } = await launch(tempProfile(), llm.url)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => window.foreman.settings.set({ userName: 'Sahil' }))
  for (const [n, c, sh] of [['School and Studying', '#FF4D4F', 'drop'], ['CAD & Mechanical Engineering', '#1F1F1F', 'square'], ['AI', '#9CA3AF', 'blob']] as const) {
    const r = await page.evaluate((a) => window.foreman.spaces.create({ name: a[0], color: a[1], shape: a[2] as never, intro: false }), [n, c, sh])
    void r
  }
  await page.reload()
  await page.click('[data-testid="new-bot"]')
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/v2-palette.png` })
  llm.script.push(
    { content: "Hey Sahil! I'm your new bot, fresh and ready to take on whatever you want to throw at me.", toolCalls: [{ name: 'ask_user', arguments: '{"question":"What do you want me to focus on?","options":["Vantage app work","Robotics team stuff","Personal errands","Something else"]}' }] }
  )
  await page.click('[data-testid="bot-save"]')
  await page.locator('[data-testid="question-card"]').waitFor()
  await page.screenshot({ path: `${out}/v2-newbot.png` })
  await page.keyboard.press('Escape')
  // agent run with grouped steps + progress panel
  await page.click('[data-testid="main-bot"]')
  const folder = mkdtempSync(join(tmpdir(), 'ws-'))
  writeFileSync(join(folder, 'x.md'), 'x')
  await page.evaluate((ws) => window.foreman.settings.set({ workspaceDir: ws }), folder)
  llm.script.length = 0
  llm.script.push(
    { content: "On it. Here's the plan.", toolCalls: [{ name: 'todo', arguments: '{"items":[{"text":"Research Q4 numbers","status":"done"},{"text":"Build the deck","status":"in_progress"},{"text":"Write the memo","status":"pending"}]}' }] },
    { toolCalls: [{ name: 'fetch_page', arguments: '{"url":"https://example.com"}' }] },
    { toolCalls: [{ name: 'create_document', arguments: JSON.stringify({ path: 'q4-review.pptx', slides: [{ title: 'Q4 Review', layout: 'title' }, { title: 'Growth', bullets: ['Revenue +12%'] }] }) }] },
    { toolCalls: [{ name: 'create_document', arguments: JSON.stringify({ path: 'q4-numbers.xlsx', sheets: [{ name: 'Q4', rows: [['Month', 'Revenue'], ['Oct', 100]] }] }) }] },
    { toolCalls: [{ name: 'todo', arguments: '{"items":[{"text":"Research Q4 numbers","status":"done"},{"text":"Build the deck","status":"done"},{"text":"Write the memo","status":"done"}]}' }] },
    { content: 'Done. I made **q4-review.pptx** and **q4-numbers.xlsx** — they are in the Progress panel.' }
  )
  await page.fill('[data-testid="composer-input"]', 'Put together the Q4 review deck and numbers')
  await page.keyboard.press('Enter')
  await expect.poll(() => llm.script.length, { timeout: 20000 }).toBe(0)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20000 }).toBe(0)
  await page.click('[data-testid="toggle-panel"]')
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/v2-agent.png` })
  await page.locator('[data-testid="activity-head"]').first().click()
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${out}/v2-agent-open.png` })
  await page.locator('[data-testid="assistant-bubble"]').last().hover()
  await page.locator('[data-testid="react-btn"]').last().click()
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${out}/v2-react.png` })
  await page.keyboard.press('Escape')
  await page.click('[data-testid="connect-apps"]')
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/v2-connect.png` })
  await app.close()
  await llm.close()
}, 90_000)
