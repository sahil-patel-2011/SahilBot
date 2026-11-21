import type { Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Home is about your bots: a card per bot with its state, Talk (a voice conversation with that bot, in a bar at
// the top of the chat) and Open (its ongoing chat). On a fresh start the only card is "New bot", which sets
// itself up with you in its chat. The box below is for quick one-off questions.

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
beforeEach(() => { llm.script.length = 0 })

const shots = process.env.SAHILBOT_SHOTS
const idle = async (page: Page): Promise<void> => {
  await expect.poll(() => llm.script.length, { timeout: 20_000 }).toBe(0)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
}

describe('Home: your bots first', () => {
  test('a fresh start shows one "New bot": it sets itself up in its chat, names itself and saves its instructions', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    try {
      await page.locator('[data-testid="bot-deck"]').waitFor()
      expect(await page.locator('[data-testid="deck-make-bot"]').innerText()).toContain('New bot')
      expect(await page.locator('.home-quick-head').innerText()).toContain('Quick question')
      if (shots) await page.screenshot({ path: `${shots}/home-fresh.png` })

      await page.click('[data-testid="deck-setup"]')
      await expect.poll(() => page.locator('[data-testid="bot-deck"]').count(), { timeout: 10_000 }).toBe(0)
      await expect.poll(() => page.locator('[data-testid="thread"]').innerText(), { timeout: 10_000 }).toContain('Let\'s set me up together')

      // One message with the whole job: the bot proposes, the user agrees, it finishes its own setup.
      llm.script.push(
        { content: 'Got it. I\'d call myself Inbox: I check your email every morning, draft replies, and flag what needs you. Sound good?' },
        { toolCalls: [{ name: 'finish_setup', arguments: JSON.stringify({ name: 'Inbox', job: 'Email and replies', color: 'blue', instructions: 'You are Inbox. Every morning, read the user\'s new email, draft replies in their voice, and list what needs them. Never send without asking.' }) }] },
        { content: 'I\'m set up as Inbox. Want me to go through today\'s email now?' }
      )
      await page.fill('[data-testid="composer-input"]', 'Keep my inbox under control and draft replies every morning')
      await page.keyboard.press('Enter')
      await expect.poll(() => llm.script.length, { timeout: 20_000 }).toBe(2)
      await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
      // The setup tool is offered to this bot (and only while it's being set up).
      const tools = (llm.requests.at(-1)?.tools ?? []).map((t: { function?: { name?: string } }) => t.function?.name)
      expect(tools).toContain('finish_setup')
      await page.fill('[data-testid="composer-input"]', 'Yes, perfect')
      await page.keyboard.press('Enter')
      await idle(page)
      await expect.poll(async () => (await page.evaluate(() => window.foreman.spaces.list())).find((s) => s.name === 'Inbox')?.label, { timeout: 10_000 }).toBe('Email and replies')
      const inbox = (await page.evaluate(() => window.foreman.spaces.list())).find((s) => s.name === 'Inbox')!
      expect(await page.evaluate((id) => window.foreman.spaces.getPrompt(id), inbox.id)).toContain('Never send without asking')
      expect((await page.evaluate(() => window.foreman.spaces.list())).some((s) => s.name === 'New bot')).toBe(false)

      // Done: no setup tool any more in its chat.
      llm.script.push({ content: 'On it.' })
      await page.fill('[data-testid="composer-input"]', 'Go through today\'s email')
      await page.keyboard.press('Enter')
      await idle(page)
      expect((llm.requests.at(-1)?.tools ?? []).map((t: { function?: { name?: string } }) => t.function?.name)).not.toContain('finish_setup')

      // Home now shows Inbox; "New bot" starts another setup.
      await page.click('[data-testid="new-chat"]')
      await expect.poll(() => page.locator('[data-testid="bot-card"] .bot-card-text b').allInnerTexts(), { timeout: 10_000 }).toEqual(['Inbox'])
    } finally {
      await app.close()
    }
  })

  test('first run: after setup, "Your first bot" explains bots in three cards and opens the New bot\'s chat', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_SKIP_ONBOARDING: '' })
    try {
      await page.locator('[data-testid="onboarding"]').waitFor()
      await page.fill('[data-testid="onboarding-name"]', 'Sam')
      await page.click('[data-testid="onboarding-name-next"]')
      await page.click('[data-testid="onboarding-next"]')
      await page.click('[data-testid="onboarding-perms-next"]')
      await page.locator('[data-testid="onboarding-how"]').waitFor()
      expect(await page.locator('[data-testid="onboarding-how"]').innerText()).toMatch(/Give it a job[\s\S]*Talk or type[\s\S]*It remembers/)
      if (shots) await page.screenshot({ path: `${shots}/onboarding-first-bot.png` })
      await page.click('[data-testid="onboarding-first-bot"]')
      await expect.poll(() => page.locator('[data-testid="onboarding"]').count()).toBe(0)
      await expect.poll(() => page.locator('[data-testid="thread"]').innerText().catch(() => ''), { timeout: 10_000 }).toContain('Let\'s set me up together')
      expect((await page.evaluate(() => window.foreman.spaces.list())).some((s) => s.name === 'New bot')).toBe(true)
    } finally {
      await app.close()
    }
  })

  test('with bots: a card each, Open opens its chat, Talk opens the voice bar with that bot and its settings', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    try {
      await page.evaluate(() => window.foreman.spaces.create({ name: 'Finance', intro: false }))
      await page.evaluate(() => window.foreman.spaces.create({ name: 'Scout', intro: false }))
      // The sidebar and Home refresh on the spaces event; a reload makes it certain.
      await page.reload()
      await expect.poll(() => page.locator('[data-testid="bot-card"]').count(), { timeout: 15_000 }).toBe(2)
      const names = await page.locator('[data-testid="bot-card"] .bot-card-text b').allInnerTexts()
      expect(names.sort()).toEqual(['Finance', 'Scout'])
      expect(await page.locator('[data-testid="deck-make-bot"]').count()).toBe(0)
      if (shots) await page.screenshot({ path: `${shots}/home-bots.png` })

      // Open: the bot's ongoing chat.
      await page.locator('[data-testid="bot-card"]', { hasText: 'Finance' }).locator('[data-testid="bot-open"]').click()
      await expect.poll(() => page.locator('[data-testid="bot-deck"]').count(), { timeout: 10_000 }).toBe(0)
      await page.locator('[data-testid="composer-input"]').waitFor()

      // Back home, Talk: the voice bar with that bot (speech may not be set up in a test run; the bar still opens).
      await page.click('[data-testid="new-chat"]')
      await page.locator('[data-testid="bot-deck"]').waitFor()
      await page.locator('[data-testid="bot-card"]', { hasText: 'Scout' }).locator('[data-testid="bot-talk"]').click()
      await page.locator('[data-testid="voice-mode"]').waitFor()
      expect(await page.locator('[data-testid="voice-mode"] .vb-name').innerText()).toContain('Scout')
      for (const id of ['voice-settings', 'voice-transcript', 'voice-mute', 'voice-end']) expect(await page.locator(`[data-testid="${id}"]`).count(), id).toBe(1)

      // Settings: voices for the engine speaking now, speed and language; choices are kept.
      await page.click('[data-testid="voice-settings"]')
      await page.locator('[data-testid="voice-panel"]').waitFor()
      const voices = page.locator('[data-testid^="voice-voice-"]')
      await expect.poll(() => voices.count()).toBeGreaterThan(2)
      const second = await voices.nth(1).getAttribute('data-testid')
      await voices.nth(1).click()
      await expect.poll(() => voices.nth(1).getAttribute('aria-checked')).toBe('true')
      await page.selectOption('[data-testid="voice-language"]', 'es')
      const o = await page.evaluate(() => window.foreman.voice.options!())
      expect(o.voice).toBe(second!.replace('voice-voice-', ''))
      expect(o.language).toBe('es')
      expect((await page.evaluate(() => window.foreman.settings.get())).voiceStyle?.language).toBe('es')
      if (shots) await page.screenshot({ path: `${shots}/voice-settings.png` })
      await page.click('[data-testid="voice-settings"]')

      // Mute and transcript are toggles.
      await page.click('[data-testid="voice-mute"]')
      expect(await page.getAttribute('[data-testid="voice-mute"]', 'aria-pressed')).toBe('true')
      await page.click('[data-testid="voice-transcript"]')
      expect(await page.getAttribute('[data-testid="voice-transcript"]', 'aria-pressed')).toBe('true')
      if (shots) await page.screenshot({ path: `${shots}/voice-bar.png` })
      await page.click('[data-testid="voice-end"]')
      await expect.poll(() => page.locator('[data-testid="voice-mode"]').count()).toBe(0)
    } finally {
      await app.close()
    }
  })
})
