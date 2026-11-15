// Dev helper (read state): the sidebar's unread dot (blue), a bot's unread count, the running shimmer on a working bot's name, and a chat opened on its NEW divider with
// "Jump to latest". Light and dark, hidden window, mock model.
//   npm run build && SHOTS_DIR=<dir> SAHILBOT_HIDDEN=1 npx vitest run --config vitest.tools.config.mts tests/tools/read-state-shot.test.ts
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { expect, test } from 'vitest'
import { launch, tempProfile } from '../accept/app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

const out = process.env.SHOTS_DIR ?? join(tmpdir(), 'read-state-shots')
mkdirSync(out, { recursive: true })

const send = async (page: Page, text: string): Promise<void> => {
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
}
const quiet = async (page: Page, llm: MockLlm): Promise<void> => {
  await expect.poll(() => llm.script.length, { timeout: 20_000 }).toBe(0)
  await expect.poll(() => page.locator('.row-spin').count(), { timeout: 20_000 }).toBe(0)
}
const tall = (label: string, n: number): string => Array.from({ length: n }, (_, i) => `${label} ${i + 1}: the numbers moved again this week.`).join('\n\n')

async function shoot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${out}/${name}-${scheme}.png`, ...(clip ? { clip } : {}) })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

test('read state screenshots', async () => {
  const llm = await startMockLlm()
  const { app, page } = await launch(tempProfile(), llm.url)
  try {
    await page.setViewportSize({ width: 1280, height: 800 })
    const mk = (name: string) => page.evaluate((n) => window.foreman.spaces.create({ name: n, intro: false }), name)
    const scout = await mk('Scout')
    const ledger = await mk('Ledger')
    const runner = await mk('Runner')
    await page.reload()
    await page.waitForSelector('[data-testid="composer-input"]')

    // Scout: a read conversation, then two replies you missed.
    await page.locator('[data-testid="space-item"]', { hasText: 'Scout' }).click()
    await expect.poll(() => page.locator('[data-testid="bot-pill"]').innerText().catch(() => '')).toContain('Scout')
    llm.script.push({ content: 'Here is the market overview you asked for. Three players matter; the rest are small.' })
    await send(page, 'Give me the market overview')
    await quiet(page, llm)
    // A plain chat with SahilBot is where you are while the bots work.
    await page.click('[data-testid="main-bot"]')
    await page.waitForTimeout(300)
    llm.script.push({ content: 'Sure, here is a short plan for the week.' })
    await send(page, 'Plan my week')
    await quiet(page, llm)

    llm.script.push({ content: `I checked the competitor sites overnight.\n\n${tall('Finding', 14)}` })
    await page.evaluate((id) => window.foreman.chat.send({ threadId: id, text: 'Check the competitors overnight' }), scout.threadId)
    await quiet(page, llm)
    llm.script.push({ content: 'Pricing is flat across all three. Want a table?' })
    await page.evaluate((id) => window.foreman.chat.send({ threadId: id, text: 'And pricing?' }), scout.threadId)
    await quiet(page, llm)
    // Ledger: one reply (a dot).
    llm.script.push({ content: 'Invoices for October are reconciled.' })
    await page.evaluate((id) => window.foreman.chat.send({ threadId: id, text: 'Reconcile October' }), ledger.threadId)
    await quiet(page, llm)
    // Runner is working while the shots are taken: its name shimmers.
    llm.script.push({ content: 'Crunching the quarterly numbers across every region and every product line now', delay: 2500 })
    await page.evaluate((id) => window.foreman.chat.send({ threadId: id, text: 'Crunch the quarter' }), runner.threadId)
    await expect.poll(() => page.locator('[data-testid="space-item"]', { hasText: 'Runner' }).locator('.run-name').count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => page.locator('[data-testid="space-item"]', { hasText: 'Scout' }).locator('[data-testid="unread-count"]').count()).toBe(1)
    await shoot(page, 'read-sidebar', { x: 0, y: 0, width: 320, height: 800 })
    await shoot(page, 'read-sidebar-full')

    // Opening Scout: the NEW divider at the first reply you missed, and "Jump to latest".
    await page.locator('[data-testid="space-item"]', { hasText: 'Scout' }).click()
    await page.locator('[data-testid="new-divider"]').waitFor({ timeout: 10_000 })
    await page.locator('[data-testid="jump-latest"]').waitFor({ timeout: 5_000 })
    await shoot(page, 'read-divider')
    await page.evaluate(() => { const el = document.querySelector<HTMLElement>('[data-testid="new-divider"]'); el?.scrollIntoView({ block: 'center', behavior: 'instant' }) })
    const box = await page.locator('[data-testid="new-divider"]').boundingBox()
    if (box) await shoot(page, 'read-divider-zoom', { x: Math.max(0, box.x - 20), y: Math.max(0, box.y - 120), width: Math.min(900, box.width + 40), height: 260 })
  } finally {
    await app.close()
    await llm.close()
  }
})
