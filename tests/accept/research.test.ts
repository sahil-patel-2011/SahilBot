import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// "Research first, never guess": the prompt requires lookups for changeable facts, and a code check
// sends back any answer citing links that no tool actually retrieved.
describe('anti-hallucination', () => {
  let llm: MockLlm
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('invented links are caught and fixed; real sources show as pills', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.evaluate((u) => window.foreman.settings.set({ search: { provider: 'searxng', searxngUrl: u, hasBraveKey: false } }), llm.url.replace(/\/v1$/, ''))
    llm.script.push(
      { content: 'Qwen 3.8 was released on Nov 3. Source: https://made-up.example/qwen-news' },
      { toolCalls: [{ name: 'web_search', arguments: '{"query":"Qwen 3.8 release date"}' }] },
      { content: 'I checked: according to the result [1], here is the release info.\n\nSources:\n[1] https://example.com/a' }
    )
    await page.fill('[data-testid="composer-input"]', 'When was Qwen 3.8 released?')
    await page.keyboard.press('Enter')
    await expect.poll(() => llm.script.length, { timeout: 20_000 }).toBe(0)
    await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
    const prompt = String(llm.requests[0].messages[0].content)
    // A question runs on the chat path, whose prompt carries the same look-it-up-first rule.
    expect(prompt).toContain('# Chatting')
    expect(prompt).toContain('Anything specific or changeable')
    // The app sent the first answer back because its link wasn't retrieved by any tool.
    const second = JSON.stringify(llm.requests[1].messages)
    expect(second).toContain("cites links that don't appear in any source")
    expect(second).toContain('made-up.example')
    // Only the corrected answer is shown, with its real source as a pill.
    const bubbles = await page.locator('[data-testid="assistant-bubble"]').allInnerTexts()
    expect(bubbles.join('\n')).not.toContain('made-up.example')
    // Chips show the site; the page title is in the tooltip.
    expect(await page.locator('[data-testid="sources"]').innerText()).toContain('example.com')
    expect(await page.locator('[data-testid="sources"] a').first().getAttribute('title')).toContain('Result for Qwen 3.8 release date')
    await app.close()
  })
})
