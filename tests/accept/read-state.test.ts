// Read state, end to end (hidden window, mock model): a bot replies while you're in another chat; the
// sidebar shows it working (the name's shimmer class) and then unread (blue dot, then a count); opening it
// lands on the NEW divider at the first reply you missed, with "Jump to latest"; reaching the bottom reads
// it, and after leaving and coming back the divider is gone. A plain chat gets the dot but never a divider.
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

let llm: MockLlm
const send = async (page: Page, text: string): Promise<void> => {
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
}
const idle = async (page: Page): Promise<void> => {
  await expect.poll(() => llm.script.length, { timeout: 20_000 }).toBe(0)
  await expect.poll(() => page.locator('.row-spin').count(), { timeout: 20_000 }).toBe(0)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
}
/** Long replies without spaces stream as one chunk (the mock splits on spaces) but fill the screen. */
const tall = (label: string, n = 40): string => Array.from({ length: n }, (_, i) => `${label}-${i + 1}`).join('\n\n')

describe('read state: unread dots, the running shimmer and the NEW divider', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('a bot that replied while you were elsewhere opens on the NEW divider; a plain chat never does', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    try {
      const { space, threadId: botThread } = await page.evaluate(() => window.foreman.spaces.create({ name: 'Scout', intro: false }))
      await page.reload()
      await page.waitForSelector('[data-testid="composer-input"]')
      const row = page.locator('[data-testid="space-item"]', { hasText: 'Scout' })

      // Some history you've read: open the bot and talk to it.
      await row.click()
      await expect.poll(() => page.locator('[data-testid="bot-pill"]').innerText().catch(() => '')).toContain('Scout')
      llm.script.push({ content: tall('Earlier', 30) })
      await send(page, 'Start with the market')
      await idle(page)
      await expect.poll(async () => (await page.evaluate((id) => window.foreman.threads.list(id), space.id))[0].unread).toBe(false)

      // Now you're in another chat (a plain one: New chat, which is what Recents lists).
      await page.click('[data-testid="new-chat"]')
      llm.script.push({ content: 'Hi! What can I do for you?' })
      await send(page, 'hello there')
      await idle(page)
      expect(await page.locator('[data-testid="thread-item"]').count()).toBe(1)

      // The bot works in the background: its name shimmers (and the working mark shows) while it runs…
      llm.script.push({ content: `Checking the sites now.\n\n${tall('Finding')}`, delay: 700 })
      await page.evaluate((id) => window.foreman.chat.send({ threadId: id, text: 'Check the competitors' }), botThread)
      await expect.poll(() => row.locator('.br-name.run-name').count(), { timeout: 10_000 }).toBe(1)
      expect(await row.locator('.row-spin').count()).toBe(1)
      await idle(page)
      // …then it's unread: a blue dot, no shimmer.
      expect(await row.locator('.run-name').count()).toBe(0)
      await expect.poll(() => row.locator('[data-testid="unread-dot"]').count(), { timeout: 5_000 }).toBe(1)
      // The --unread blue (light or dark, whichever the Mac is in), not the old grey.
      const dotColor = await row.locator('[data-testid="unread-dot"]').evaluate((el) => getComputedStyle(el).backgroundColor)
      expect(['rgb(43, 125, 233)', 'rgb(76, 155, 255)']).toContain(dotColor)
      // A second reply: the count shows instead.
      llm.script.push({ content: 'Pricing is flat across all three.' })
      await page.evaluate((id) => window.foreman.chat.send({ threadId: id, text: 'And pricing?' }), botThread)
      await idle(page)
      await expect.poll(() => row.locator('[data-testid="unread-count"]').innerText().catch(() => ''), { timeout: 5_000 }).toBe('2')
      const listed = (await page.evaluate((id) => window.foreman.threads.list(id), space.id))[0]
      expect(listed).toMatchObject({ unread: true, unreadCount: 2 })
      // The chat you're in stays read.
      expect(await page.locator('[data-testid="thread-item"] [data-testid="unread-dot"]').count()).toBe(0)

      // Opening the bot: the divider sits right above the first reply you missed, and the view starts there.
      await row.click()
      const divider = page.locator('[data-testid="new-divider"]')
      await divider.waitFor({ timeout: 10_000 })
      expect(await divider.count()).toBe(1)
      expect(await divider.innerText()).toMatch(/new/i)
      const order = await page.evaluate(() => {
        const thread = document.querySelector('[data-testid="thread"]')!
        const d = thread.querySelector('[data-testid="new-divider"]')!
        const next = d.nextElementSibling?.textContent ?? ''
        const prev = d.previousElementSibling?.textContent ?? ''
        return { next, prev }
      })
      expect(order.next).toContain('Checking the sites now.')
      expect(order.prev).toContain('Check the competitors')
      const pos = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-testid="thread"]')!
        const d = el.querySelector<HTMLElement>('[data-testid="new-divider"]')!
        return { fromTop: d.getBoundingClientRect().top - el.getBoundingClientRect().top, toBottom: el.scrollHeight - el.scrollTop - el.clientHeight }
      })
      // Near the top (a little context above it, clear of the header), not at the bottom.
      expect(pos.fromTop).toBeGreaterThanOrEqual(40)
      expect(pos.fromTop).toBeLessThan(120)
      expect(pos.toBottom).toBeGreaterThan(200)
      // Not at the bottom yet, so not read yet; "Jump to latest" is offered.
      const jump = page.locator('[data-testid="jump-latest"]')
      await jump.waitFor({ timeout: 5_000 })
      expect(await jump.innerText()).toContain('Jump to latest')
      await page.waitForTimeout(600)
      expect((await page.evaluate((id) => window.foreman.threads.list(id), space.id))[0].unread).toBe(true)

      // Jumping to the latest reads it; the divider stays while you're here.
      await jump.click()
      await expect.poll(async () => (await page.evaluate((id) => window.foreman.threads.list(id), space.id))[0], { timeout: 5_000 }).toMatchObject({ unread: false, unreadCount: 0 })
      expect(await divider.count()).toBe(1)
      await expect.poll(() => row.locator('[data-testid="unread-dot"], [data-testid="unread-count"]').count()).toBe(0)
      // A reply that lands while you watch the bottom is read too (and goes below the divider).
      llm.script.push({ content: 'One more: a new competitor launched today.' })
      await send(page, 'Anything else?')
      await idle(page)
      await expect.poll(async () => (await page.evaluate((id) => window.foreman.threads.list(id), space.id))[0].unread, { timeout: 5_000 }).toBe(false)
      expect(await divider.count()).toBe(1)

      // Leave and come back: caught up, no divider.
      await page.locator('[data-testid="thread-item"]').first().click()
      await expect.poll(() => page.locator('[data-testid="thread-title"]').innerText().catch(() => '')).not.toBe('')
      await row.click()
      await page.locator('[data-testid="assistant-bubble"]', { hasText: 'a new competitor launched today' }).waitFor({ timeout: 10_000 })
      await page.waitForTimeout(400)
      expect(await page.locator('[data-testid="new-divider"]').count()).toBe(0)

      // A plain chat that got a reply while you were in the bot: the dot, but never a divider.
      const chats = await page.evaluate(() => window.foreman.threads.list())
      const plain = chats.find((t) => t.spaceId !== space.id)!
      expect(plain.toolMode).not.toBe('full')
      llm.script.push({ content: 'Also: your meeting moved to 3pm.' })
      await page.evaluate((id) => window.foreman.chat.send({ threadId: id, text: 'anything new?' }), plain.id)
      await idle(page)
      const chatRow = page.locator('[data-testid="thread-item"]').first()
      await expect.poll(() => chatRow.locator('[data-testid="unread-dot"]').count(), { timeout: 5_000 }).toBe(1)
      // Chats get the dot only, never a count.
      expect(await chatRow.locator('[data-testid="unread-count"]').count()).toBe(0)
      await chatRow.click()
      await page.locator('[data-testid="assistant-bubble"]', { hasText: 'meeting moved' }).waitFor({ timeout: 10_000 })
      await page.waitForTimeout(400)
      expect(await page.locator('[data-testid="new-divider"]').count()).toBe(0)
      // Read on opening (it fits on screen, so you're at the bottom).
      await expect.poll(async () => (await page.evaluate(() => window.foreman.threads.list())).find((t) => t.id === plain.id)?.unread, { timeout: 5_000 }).toBe(false)
    } finally {
      await app.close()
    }
  })

  test('a reply while the window is in the background stays unread until you come back to it', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    try {
      const { space, threadId } = await page.evaluate(() => window.foreman.spaces.create({ name: 'Watcher', intro: false }))
      await page.reload()
      await page.waitForSelector('[data-testid="composer-input"]')
      await page.locator('[data-testid="space-item"]', { hasText: 'Watcher' }).click()
      await expect.poll(() => page.locator('[data-testid="bot-pill"]').innerText().catch(() => '')).toContain('Watcher')
      // You switch to another app (the page loses focus).
      await page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false })
        window.dispatchEvent(new Event('blur'))
      })
      llm.script.push({ content: 'The report is ready.' })
      await page.evaluate((id) => window.foreman.chat.send({ threadId: id, text: 'make the report' }), threadId)
      await idle(page)
      await page.waitForTimeout(500)
      expect((await page.evaluate((id) => window.foreman.threads.list(id), space.id))[0]).toMatchObject({ unread: true, unreadCount: 1 })
      // Back to SahilBot: it's on screen and at the bottom, so it's read.
      await page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true })
        window.dispatchEvent(new Event('focus'))
      })
      await expect.poll(async () => (await page.evaluate((id) => window.foreman.threads.list(id), space.id))[0].unread, { timeout: 5_000 }).toBe(false)
    } finally {
      await app.close()
    }
  })
})
