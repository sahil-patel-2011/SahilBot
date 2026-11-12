import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Phase 1 acceptance: shell boots, model selector lists GET /models, chat
// streams, Stop works, and everything survives a restart (SQLite).
describe('phase 1: shell + streaming chat + model selector + persistence', () => {
  let llm: MockLlm
  const profile = tempProfile()

  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('chat streams, model choice is honored, stop works, data persists across restart', async () => {
    // Simulate the 64 GB M5 Max target so gating is deterministic on any Mac.
    let { app, page } = await launch(profile, llm.url, { FOREMAN_RAM_GB: '64' })

    // Models that only fit with a small context start switched off; the 27B fits outright and is on.
    await page.click('[data-testid="model-picker"]')
    await expect.poll(() => page.locator('[data-testid="model-option"]').first().innerText()).toContain('Auto')
    const options = page.locator('[data-testid="model-option"]').filter({ hasNotText: 'Picks the right model' })
    await expect.poll(() => options.count()).toBe(1)
    expect(await options.first().innerText()).toContain('Qwen3.8 27B')
    // Switch Llama on in Settings → Models; it then shows with its reduced window.
    await page.keyboard.press('Escape')
    await page.keyboard.press('Meta+,')
    await page.click('[data-testid="settings-models"]')
    await page.click('[data-testid="model-toggle-llama3.3:70b"]')
    await page.click('[data-testid="settings-close"]')
    await page.click('[data-testid="model-picker"]')
    await expect.poll(() => options.count()).toBe(2)
    const llama = options.filter({ hasText: 'Llama 3.3 70B' })
    expect(await llama.isEnabled()).toBe(true)
    expect(await llama.innerText()).toContain('Fits at 16k context')
    const pick = 'llama3.3:70b'
    await llama.click()

    // Send a message; watch it stream.
    llm.script.push({ content: 'one two three four five six seven eight nine ten', reasoning: 'Planning a count.', delay: 60 })
    await page.fill('[data-testid="composer-input"]', 'Count to ten')
    await page.keyboard.press('Enter')
    const bubble = page.locator('[data-testid="assistant-bubble"]').last()
    await expect.poll(() => bubble.getAttribute('data-status')).toBe('streaming')
    await expect.poll(async () => (await bubble.innerText()).includes('three')).toBe(true)
    await expect.poll(() => bubble.getAttribute('data-status'), { timeout: 10_000 }).toBe('done')
    expect(await bubble.innerText()).toContain('one two three four five six seven eight nine ten')
    expect(await bubble.innerText()).toContain('Thought process')
    expect(llm.requests.at(-1)!.model).toBe(pick)
    expect(llm.requests.at(-1)!.stream).toBe(true)
    await expect.poll(() => page.locator('[data-testid="thread-title"]').innerText()).toBe('Count to ten')

    // Stop mid-stream.
    llm.script.push({ content: Array.from({ length: 200 }, (_, i) => `w${i}`).join(' '), delay: 40 })
    await page.fill('[data-testid="composer-input"]', 'Say a lot')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-testid="stop"]')
    await page.waitForTimeout(400)
    await page.click('[data-testid="stop"]')
    await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().getAttribute('data-status')).toBe('stopped')

    await app.close()

    // Restart: the thread and its messages come back from SQLite.
    ;({ app, page } = await launch(profile, llm.url, { FOREMAN_RAM_GB: '64' }))
    const item = page.locator('[data-testid="thread-item"]').filter({ hasText: 'Count to ten' })
    await expect.poll(() => item.count()).toBe(1)
    await item.click()
    await expect.poll(() => page.locator('[data-testid="user-bubble"]').count()).toBe(2)
    const restored = await page.locator('[data-testid="assistant-bubble"]').allInnerTexts()
    expect(restored[0]).toContain('nine ten')
    // The thread keeps the model chosen before restart.
    expect(await page.locator('[data-testid="model-picker"]').innerText()).toContain('Llama 3.3 70B')
    await app.close()

    // On a 24 GB Mac neither big model fits: both start switched off (only Auto is offered).
    ;({ app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '24' }))
    await page.click('[data-testid="model-picker"]')
    await expect.poll(() => page.locator('[data-testid="model-option"]').first().innerText()).toContain('Auto')
    expect(await page.locator('[data-testid="model-option"]').filter({ hasNotText: 'Picks the right model' }).count()).toBe(0)
    await app.close()
  })
})
