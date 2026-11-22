import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Keyboard: ⌘1–9 open bots in sidebar order, ⌘F finds in the open chat, ⌘/ lists every shortcut.
let llm: MockLlm
const shots = process.env.SAHILBOT_SHOTS
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })

describe('keyboard shortcuts', () => {
  test('⌘2 opens the second bot and ⌘1 SahilBot (Home); ⌘F highlights matches and steps through them; ⌘/ shows the list', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    try {
      await page.evaluate(() => window.foreman.spaces.create({ name: 'Finance', intro: false }))
      await page.reload()
      await page.locator('[data-testid="composer-input"]').waitFor()

      await page.keyboard.press('Meta+2')
      await expect.poll(() => page.locator('.bot-pill .pill-name').innerText().catch(() => ''), { timeout: 10_000 }).toBe('Finance')
      // ⌘1: SahilBot, which opens on Home (like clicking it in the sidebar).
      await page.keyboard.press('Meta+1')
      await expect.poll(() => page.locator('.bot-pill').count(), { timeout: 10_000 }).toBe(0)
      expect(await page.getAttribute('[data-testid="composer-input"]', 'placeholder')).toContain('How can I help')

      // Find in a chat.
      llm.script.push({ content: 'Revenue grew 12% this quarter. Most of the revenue came from renewals.' })
      await page.fill('[data-testid="composer-input"]', 'How did revenue do?')
      await page.keyboard.press('Enter')
      await expect.poll(() => page.locator('[data-testid="thread"]').innerText(), { timeout: 20_000 }).toContain('renewals')
      await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
      await page.keyboard.press('Meta+f')
      await page.locator('[data-testid="find-input"]').waitFor()
      await page.keyboard.type('revenue')
      await expect.poll(() => page.locator('[data-testid="find-count"]').innerText()).toBe('1 of 3')
      expect(await page.evaluate(() => (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('find')?.size)).toBe(3)
      await page.keyboard.press('Enter')
      await expect.poll(() => page.locator('[data-testid="find-count"]').innerText()).toBe('2 of 3')
      if (shots) { await page.waitForTimeout(400); await page.screenshot({ path: `${shots}/find.png` }) }
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.press('Shift+Enter')
      await expect.poll(() => page.locator('[data-testid="find-count"]').innerText()).toBe('3 of 3')
      await page.fill('[data-testid="find-input"]', 'zebra')
      await expect.poll(() => page.locator('[data-testid="find-count"]').innerText()).toBe('No matches')
      await page.keyboard.press('Escape')
      await expect.poll(() => page.locator('[data-testid="find-bar"]').count()).toBe(0)
      expect(await page.evaluate(() => (CSS as unknown as { highlights: Map<string, unknown> }).highlights.has('find'))).toBe(false)

      // Every shortcut on one page.
      await page.keyboard.press('Meta+/')
      const sheet = page.locator('[data-testid="shortcuts-sheet"]')
      await sheet.waitFor()
      if (shots) { await page.waitForTimeout(1200); await page.screenshot({ path: `${shots}/shortcuts.png` }) }
      expect(await sheet.innerText()).toMatch(/Open a bot[\s\S]*Find in this chat[\s\S]*Dictate/)
      await page.keyboard.press('Escape')
      await expect.poll(() => sheet.count()).toBe(0)
    } finally {
      await app.close()
    }
  })
})
