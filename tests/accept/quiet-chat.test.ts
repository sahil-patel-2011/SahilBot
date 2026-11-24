import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// The quiet chat (Developer mode off): messages as bubbles, one working line with a timer that counts from
// when you pressed send, and none of the steps, thinking, model names, tokens or costs. SB_SHOTS=<dir> also
// saves screenshots.

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })

const shots = process.env.SB_SHOTS
const shot = async (page: Page, name: string): Promise<void> => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: `${shots}/${name}.png` })
}

describe('quiet chat', () => {
  test('A bot chat shows only the conversation by default; Developer mode reveals the team and its models', async () => {
    llm.models = ['qwen3.8:27b', 'gemma4:12b']
    const { app, page } = await launch(tempProfile(), llm.url, { SAHILBOT_QUIET: '1', FOREMAN_NO_BRAIN: '', FOREMAN_RAM_GB: '64' })
    try {
      await page.evaluate(() => window.foreman.spaces.create({ name: 'Review Bot', intro: false }))
      await page.reload()
      await page.getByTestId('space-item').filter({ hasText: 'Review Bot' }).click()
      // Grok Bot's plain message box: no model or permissions picker (Auto picks; permissions are in the bot's profile),
      // and no folder chip until the chat works in a folder.
      await expect.poll(() => page.getByTestId('bot-pill').innerText().catch(() => '')).toContain('Review Bot')
      expect(await page.getByTestId('bot-permissions-picker').count()).toBe(0)
      expect(await page.getByTestId('model-picker').count()).toBe(0)
      expect(await page.getByTestId('working-folder').count()).toBe(0)
      llm.script.push(
        { content: JSON.stringify({
          assessment: { goal: 'Suggest a name', work: 'answer', complexity: 'direct', impact: 'routine', deliverable: false, parts: [] },
          category: 'writing', kind: 'chat', difficulty: 1, effort: 'low', model: 'gemma4:12b', team: 'pair',
          partner: 'qwen3.8:27b', needs: ['ideas'], fanout: 0, why: 'Two perspectives on naming'
        }), delay: 0 },
        { content: 'Try Hearth and Grain.', delay: 0 },
        { content: 'I would choose Hearth and Grain.', reasoning: 'Compare memorable names.', delay: 1200 }
      )
      await page.getByTestId('composer-input').fill('What would you call a shop that sells sourdough in the morning?')
      await page.getByTestId('send').click()
      const status = page.getByTestId('status-line')
      await status.waitFor()
      expect(await page.getByTestId('stop').isVisible()).toBe(true)
      expect(await status.getByRole('status').evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
      // A bot's chat (Grok Bot's way): "<name> is working…", then the answer; the team card stays out of sight.
      expect(await page.getByTestId('bot-working').innerText()).toContain('Review Bot is working')
      await expect.poll(() => page.getByTestId('thread').innerText(), { timeout: 25_000 }).toContain('Hearth and Grain')
      const card = page.getByTestId('collaboration-card')
      expect(await card.count()).toBe(0)
      expect(await page.locator('details.reasoning').count()).toBe(0)
      await shot(page, '4-bot-collaboration')

      // Developer mode has no button any more (settings are basics only); turn it on directly.
      await page.evaluate(() => window.foreman.settings.set({ advanced: { devMode: true } } as never))
      await page.evaluate(() => window.dispatchEvent(new Event('sahilbot:settings-changed')))
      // Developer mode shows the work: the team card with each teammate's model.
      await expect.poll(() => card.innerText(), { timeout: 15_000 }).toContain('Second perspective')
      await expect.poll(() => card.locator('.collaboration-model').count()).toBe(2)
      expect(new Set(await card.locator('.collaboration-model').allTextContents()).size).toBe(2)
      expect(await page.getByTestId('model-picker').count()).toBe(1)
      expect(await page.locator('details.reasoning').count()).toBeGreaterThan(0)
      expect(await page.getByTestId('routed').innerText()).toMatch(/\bthinking\b/)
      await shot(page, '5-bot-model-details')
    } finally {
      await app.close()
      llm.script.length = 0
      llm.models = ['qwen3.8:27b', 'llama3.3:70b']
    }
  })

  test('a task reads like a conversation: a short note, quiet work, the result', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { SAHILBOT_QUIET: '1' })
    // Its own workspace: a study guide left by an earlier run would (rightly) not be overwritten unread.
    const ws = mkdtempSync(join(tmpdir(), 'sb-quiet-ws-'))
    await page.evaluate((w) => window.foreman.settings.set({ workspaceDir: w } as never), ws)
    await page.setViewportSize({ width: 1100, height: 760 })
    llm.script.push(
      { content: 'On it, putting together a study guide for your chem quiz.', reasoning: 'The user wants a stoichiometry study guide.', toolCalls: [{ name: 'todo', arguments: JSON.stringify({ items: [{ text: 'Write the study guide', status: 'in_progress' }] }) }], delay: 40 },
      { toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path: 'Chem study guide.md', content: '# Stoichiometry\n\ngrams → moles → moles → grams\n' }) }, { name: 'todo', arguments: JSON.stringify({ items: [{ text: 'Write the study guide', status: 'done' }] }) }], delay: 600 },
      { content: 'Done! Your study guide is saved.\n\n**The key idea:** grams of A → moles of A → moles of B → grams of B.\n\n1. Grams to moles: divide by the molar mass.\n2. Mole ratio: use the balanced equation.\n3. Moles to grams: multiply by the molar mass.', reasoning: 'Summarize.', delay: 30 }
    )
    await page.fill('[data-testid="composer-input"]', 'Help me study for my chem quiz on stoichiometry')
    await page.getByTestId('send').click()
    // While it works (Grok Bot's way): its own opening line, then one quiet line saying what it's on. No timer.
    await expect.poll(() => page.getByTestId('bot-working').innerText().catch(() => ''), { timeout: 15_000 }).toBe('Write the study guide')
    expect(await page.locator('[data-testid="turn-timer"]').count()).toBe(0)
    expect(await page.locator('[data-testid="steer-hint"]').count()).toBe(0)
    expect(await page.getByTestId('thread').innerText()).toContain('On it, putting together a study guide')
    await shot(page, '1-working')
    await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 30_000 }).toBe(0)
    await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').count()).toBe(2)
    expect(await page.locator('[data-testid="activity"]').count()).toBe(0)
    expect(await page.locator('[data-testid="plan-card"]').count()).toBe(0)
    expect(await page.locator('details.reasoning').count()).toBe(0)
    expect(await page.locator('[data-testid="routed"]').count()).toBe(0)
    // No finish line, token count or cost under the answer (Developer mode only): the chat ends on the answer.
    expect(await page.locator('[data-testid="run-summary"]').count()).toBe(0)
    expect(await page.locator('[data-testid="sources"]').count()).toBe(0)
    // What it made stays: the file card.
    expect(await page.locator('[data-testid="made-file"]').count()).toBe(1)
    await shot(page, '2-done')

    // Developer mode shows the steps and the thinking again.
    await page.evaluate(() => window.foreman.settings.set({ advanced: { devMode: true } } as never))
    await page.reload()
    await page.locator('aside >> text=Help me study for my chem quiz').first().click()
    await page.waitForSelector('[data-testid="activity"]')
    expect(await page.locator('details.reasoning').count()).toBeGreaterThan(0)
    await shot(page, '3-dev-mode')
    await app.close()
  })
})
