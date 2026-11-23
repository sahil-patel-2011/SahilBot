// Start fresh and Undo, end to end (hidden window, mock model). Grok Bot reviewers: "each Bot is one unbounded thread"
// and "approvals don't reverse anything". A bot's profile starts a fresh conversation (it still remembers; the old
// one is under Past conversations), and the Undo button under an answer takes back the file it made.
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

let llm: MockLlm
const idle = async (page: Page): Promise<void> => {
  await expect.poll(() => llm.script.length, { timeout: 20_000 }).toBe(0)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
}

describe('a bot: start fresh, past conversations, and undo', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('undo takes back the file a task made; start fresh opens a new conversation and keeps the old one', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    try {
      const ws = mkdtempSync(join(tmpdir(), 'sb-fresh-ws-'))
      await page.evaluate((dir) => window.foreman.settings.set({ workspaceDir: dir }), ws)
      await page.evaluate(() => window.foreman.spaces.create({ name: 'Packer', intro: false }))
      await page.reload()
      await page.locator('[data-testid="space-item"]', { hasText: 'Packer' }).click()
      await expect.poll(() => page.locator('[data-testid="bot-pill"]').innerText().catch(() => '')).toContain('Packer')

      // A task that makes a file.
      llm.script.push(
        { toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path: 'packing.md', content: '- socks\n- charger\n' }) }] },
        { content: 'Made your packing list: packing.md.' }
      )
      await page.fill('[data-testid="composer-input"]', 'Make me a packing list file')
      await page.keyboard.press('Enter')
      await idle(page)
      expect(existsSync(join(ws, 'packing.md'))).toBe(true)

      // Undo on the answer: the file goes (kept in a holding folder) and the chat says so.
      const answer = page.locator('[data-testid="assistant-bubble"]').last()
      await answer.hover()
      await page.locator('[data-testid="undo-changes"]').click()
      await expect.poll(() => existsSync(join(ws, 'packing.md'))).toBe(false)
      await expect.poll(() => page.locator('[data-testid="thread"]').innerText()).toContain('Undone: removed packing.md')

      // Start fresh from the bot's profile.
      const first = await page.evaluate(async () => { const sp = (await window.foreman.spaces.list()).find((s) => s.name === 'Packer')!; return (await window.foreman.threads.list(sp.id))[0].id })
      await page.click('[data-testid="bot-pill"]')
      await page.click('[data-testid="bot-start-fresh"]')
      await expect.poll(() => page.locator('[data-testid="thread"]').innerText().catch(() => '')).not.toContain('packing list')
      const ids = await page.evaluate(async () => { const sp = (await window.foreman.spaces.list()).find((s) => s.name === 'Packer')!; return (await window.foreman.threads.list(sp.id)).map((t) => t.id) })
      expect(ids).toHaveLength(2)
      expect(ids).toContain(first)

      // The old one is under Past conversations, one click away.
      await page.click('[data-testid="bot-pill"]')
      const past = page.locator('[data-testid="bot-past-item"]')
      await expect.poll(() => past.count()).toBe(1)
      expect(await past.first().innerText()).toMatch(/Packer · until/)
      await past.first().click()
      await expect.poll(() => page.locator('[data-testid="thread"]').innerText()).toContain('Make me a packing list file')
    } finally {
      await app.close()
    }
  })
})
