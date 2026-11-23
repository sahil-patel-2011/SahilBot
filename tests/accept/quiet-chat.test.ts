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
  test('Bots show teammate roles by default and reveal model details on opt-in', async () => {
    llm.models = ['qwen3.8:27b', 'gemma4:12b']
    const { app, page } = await launch(tempProfile(), llm.url, { SAHILBOT_QUIET: '1', FOREMAN_NO_BRAIN: '', FOREMAN_RAM_GB: '64' })
    try {
      await page.evaluate(() => window.foreman.spaces.create({ name: 'Review Bot', intro: false }))
      await page.reload()
      await page.getByTestId('space-item').filter({ hasText: 'Review Bot' }).click()
      await page.getByTestId('bot-permissions-picker').click()
      expect(await page.getByTestId('picker-menu').getByTestId('model-option').count()).toBe(0)
      expect(await page.getByTestId('mode-auto').getAttribute('aria-checked')).toBe('true')
      await page.keyboard.press('Escape')
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
      const card = page.getByTestId('collaboration-card')
      await expect.poll(() => card.innerText(), { timeout: 25_000 }).toContain('Complete')
      expect(await card.innerText()).toContain('Second perspective')
      expect(await card.locator('.collaboration-model').count()).toBe(0)
      expect(await page.locator('details.reasoning').count()).toBe(0)
      await shot(page, '4-bot-collaboration')

      await page.getByTestId('profile').click()
      await page.getByTestId('settings-search').fill('developer mode')
      await page.getByTestId('settings-result-dev-mode').click()
      await page.getByTestId('dev-mode').click()
      await page.keyboard.press('Escape')
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
    // While it works: one status line with a running timer.
    await page.waitForSelector('[data-testid="turn-timer"]', { timeout: 15_000 })
    await shot(page, '1-working')
    await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 30_000 }).toBe(0)
    await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').count()).toBe(2)
    expect(await page.locator('[data-testid="activity"]').count()).toBe(0)
    expect(await page.locator('[data-testid="plan-card"]').count()).toBe(0)
    expect(await page.locator('details.reasoning').count()).toBe(0)
    expect(await page.locator('[data-testid="routed"]').count()).toBe(0)
    // One plain finish line after real work, for everyone (Grok Bot head-to-head: "a finish line on every task").
    expect(await page.locator('[data-testid="run-summary"]').count()).toBe(1)
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
