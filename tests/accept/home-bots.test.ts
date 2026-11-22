import type { Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Home is about your bots: a card per bot with its state, Talk (a voice conversation with that bot, in a bar at
// the top of the chat) and Open (its ongoing chat). "New bot" asks only for a name, an icon and a color; the bot
// asks what it should do in its chat. The box below is for quick one-off questions.

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
  test('a fresh start: "New bot" asks only for a name, an icon and a color; the bot then asks what to do in its chat', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    try {
      // A fresh start keeps Home to the message box: no bot card yet; the sidebar's "New bot" makes one.
      await page.locator('[data-testid="sidebar-make-bot"]').waitFor()
      expect(await page.locator('[data-testid="bot-deck"]').count()).toBe(0)
      expect(await page.locator('.home-quick-head').count()).toBe(0)
      if (shots) await page.screenshot({ path: `${shots}/home-fresh.png` })

      await page.click('[data-testid="sidebar-make-bot"]')
      await page.locator('[data-testid="bot-editor"]').waitFor()
      // Name, icon and color only: no job box, no templates, no extra instructions.
      for (const id of ['bot-job', 'bot-templates-list', 'bot-instructions', 'bot-editor-more']) expect(await page.locator(`[data-testid="${id}"]`).count(), id).toBe(0)
      expect(await page.locator('[data-testid="bot-save"]').isDisabled()).toBe(true)
      if (shots) await page.screenshot({ path: `${shots}/new-bot.png` })

      llm.script.push(
        { content: 'Hi! Going by my name, I think I\'m here for your email.', toolCalls: [{ name: 'ask_user', arguments: JSON.stringify({ question: 'What should I do for you?', options: ['Draft replies every morning', 'Flag what needs you', 'Clean up newsletters'] }) }] },
        { toolCalls: [{ name: 'update_bot', arguments: JSON.stringify({ instructions: 'You are Inbox. Draft replies every morning. Never send without asking.' }) }] },
        { content: 'Got it: I\'ll draft your replies every morning.' }
      )
      await page.fill('[data-testid="bot-name"]', 'Inbox')
      await page.locator('.shape-pick').nth(1).click()
      await page.click('[data-testid="bot-save"]')
      // Its first message asks what it should do, from its name (the hidden intro instruction says so).
      const q = page.locator('[data-testid="question-card"]')
      await q.waitFor({ timeout: 20_000 })
      expect(await q.innerText()).toContain('What should I do for you?')
      expect(JSON.stringify(llm.requests.at(-1)?.messages ?? '')).toContain('Your name is the best hint')
      await page.fill('[data-testid="composer-input"]', 'Draft replies every morning')
      await page.keyboard.press('Enter')
      await idle(page)
      const inbox = (await page.evaluate(() => window.foreman.spaces.list())).find((s) => s.name === 'Inbox')!
      expect(await page.evaluate((id) => window.foreman.spaces.getPrompt(id), inbox.id)).toContain('Never send without asking')

      // Home now shows Inbox.
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
      // The transcript switch lives in the voice options (the "⋯" button), with the voices.
      // Without speech set up (a test run), the bar says so in plain words with one "Set up voice" button instead of mute.
      const voiceReady = !(await page.locator('[data-testid="voice-mode"] .vb-fix').count())
      for (const id of ['voice-settings', 'voice-end', ...(voiceReady ? ['voice-mute'] : [])]) expect(await page.locator(`[data-testid="${id}"]`).count(), id).toBe(1)

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
      if (voiceReady) {
        await page.click('[data-testid="voice-mute"]')
        expect(await page.getAttribute('[data-testid="voice-mute"]', 'aria-pressed')).toBe('true')
      }
      await page.click('[data-testid="voice-settings"]')
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
