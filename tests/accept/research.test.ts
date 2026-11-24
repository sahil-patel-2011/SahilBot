import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// "Research first, never guess": the prompt requires lookups for changeable facts, and a code check takes out
// any link no tool actually retrieved, in place (the answer is never sent back or pulled off screen: post once).
describe('anti-hallucination', () => {
  let llm: MockLlm
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('invented links are taken out in place; real sources show as pills', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.evaluate((u) => window.foreman.settings.set({ search: { provider: 'searxng', searxngUrl: u, hasBraveKey: false } }), llm.url.replace(/\/v1$/, ''))
    llm.script.push(
      { toolCalls: [{ name: 'web_search', arguments: '{"query":"Qwen 3.8 release date"}' }] },
      { content: 'According to the result [1], here is the release info. More at https://made-up.example/qwen-news.\n\nSources:\n[1] https://example.com/a' }
    )
    await page.fill('[data-testid="composer-input"]', 'When was Qwen 3.8 released?')
    await page.keyboard.press('Enter')
    await expect.poll(() => llm.script.length, { timeout: 20_000 }).toBe(0)
    await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
    const prompt = String(llm.requests[0].messages[0].content)
    // A question runs on the chat path, whose prompt carries the same look-it-up rule for what changes.
    expect(prompt).toContain('# Chatting')
    expect(prompt).toContain('Look up what changes')
    // The answer was never sent back for its link: two requests (the search, the answer), nothing after.
    expect(llm.requests).toHaveLength(2)
    for (const r of llm.requests) expect(JSON.stringify(r)).not.toContain('cites links')
    // The answer is shown without the made-up link, with its real source as a pill.
    const bubbles = await page.locator('[data-testid="assistant-bubble"]').allInnerTexts()
    expect(bubbles.join('\n')).toContain('here is the release info')
    expect(bubbles.join('\n')).not.toContain('made-up.example')
    // Chips show the site; the page title is in the tooltip.
    expect(await page.locator('[data-testid="sources"]').innerText()).toContain('example.com')
    expect(await page.locator('[data-testid="sources"] a').first().getAttribute('title')).toContain('Result for Qwen 3.8 release date')
    await app.close()
  })
})
