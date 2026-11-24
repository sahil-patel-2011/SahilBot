import { resolve } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// The chat path in the real app: a simple chat answers with the lean prompt and the chat tools (web search
// through the test SearXNG endpoint, a connected MCP app found with find_tools), with no plan and no
// self-check; a work request still runs the full agent. The self-check is left ON here (FOREMAN_NO_VERIFY off).

let llm: MockLlm
const idle = async (page: Page): Promise<void> => {
  await expect.poll(() => llm.script.length, { timeout: 20_000 }).toBe(0)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
}
const names = (r: Record<string, any>): string[] => (r.tools ?? []).map((t: any) => t.function.name)
const sys = (r: Record<string, any>): string => String(r.messages[0].content)
const send = async (page: Page, text: string): Promise<void> => {
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
}

describe('chat path', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('a simple chat searches the web and uses a connected app without plan UI or a self-check; a work request runs the full agent', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64', FOREMAN_NO_VERIFY: '' })
    try {
      await page.evaluate((u) => window.foreman.settings.set({ search: { provider: 'searxng', searxngUrl: u, hasBraveKey: false } }), llm.url.replace(/\/v1$/, ''))
      // A connected app (the local notes MCP server), named Wiki here.
      await page.click('[data-testid="connect-apps"]')
      await page.click('[data-testid="preset-custom"]')
      await page.fill('.conn-form input >> nth=0', 'Wiki')
      await page.click('.conn-form .seg button:has-text("Local")')
      await page.fill('[data-testid="conn-command"]', `node ${resolve('tests/fixtures/mcp-notes-server.mjs')}`)
      await page.click('[data-testid="conn-save"]')
      const row = page.locator('[data-testid="connector-row"]')
      await expect.poll(() => row.getAttribute('data-state'), { timeout: 30_000 }).toBe('connected')
      await page.keyboard.press('Escape')

      // 1. A question: two web searches and a page, then the answer. Nothing else is sent (no hidden check).
      llm.requests.length = 0
      llm.script.push(
        { toolCalls: [{ name: 'web_search', arguments: '{"query":"qwen 3.8 release"}' }] },
        { toolCalls: [{ name: 'fetch_page', arguments: '{"url":"https://example.com/a"}' }] },
        { toolCalls: [{ name: 'web_search', arguments: '{"query":"qwen 3.8 release date"}' }] },
        { content: 'Qwen 3.8 came out recently [1].\n\nSources:\n[1] Result https://example.com/a' }
      )
      await send(page, 'When did Qwen 3.8 come out?')
      await idle(page)
      expect(llm.requests).toHaveLength(4)
      for (const r of llm.requests) {
        expect(names(r)).toEqual(['find_tools', 'web_search', 'fetch_page', 'memory'])
        expect(sys(r)).toContain('# Chatting')
      }
      expect(String(llm.requests[1].messages.at(-1).content)).toContain('Result for qwen 3.8 release')
      await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText().catch(() => ''), { timeout: 10_000 }).toContain('Qwen 3.8 came out')
      // No plan: no plan card and no progress chip once it's done.
      expect(await page.locator('.plan-card').count()).toBe(0)
      expect(await page.locator('[data-testid="progress-chip"]').count()).toBe(0)

      // 2. Same chat: a connected app, found with find_tools; the chat stays a chat.
      llm.requests.length = 0
      llm.script.push(
        { toolCalls: [{ name: 'find_tools', arguments: '{"query":"wiki"}' }] },
        { toolCalls: [{ name: 'wiki__search_notes', arguments: '{"query":"launch"}' }] },
        { content: 'The wiki says the launch is Dec 1.' }
      )
      await send(page, 'What does the wiki say about the launch date?')
      await idle(page)
      expect(llm.requests).toHaveLength(3)
      const last = llm.requests.at(-1)!
      expect(names(last)).toEqual(['find_tools', 'web_search', 'fetch_page', 'memory', 'wiki__search_notes', 'wiki__send_note'])
      expect(sys(last)).toContain('# Chatting')
      expect(String(last.messages.at(-1).content)).toContain('Launch date is Dec 1')

      // 3. A new chat with a work request: the full agent (plan tools, work tools, the harness prompt).
      await page.click('[data-testid="new-chat"]')
      llm.requests.length = 0
      llm.script.push({ content: 'Here is the plan.' })
      await send(page, 'Write a short report about green tea and save it as a PDF document in my files')
      await idle(page)
      const work = llm.requests[0]
      expect(names(work)).toEqual(expect.arrayContaining(['todo', 'browser', 'file_write', 'create_document']))
      expect(sys(work)).toContain('# Be a teammate')
      const overhead = (r: Record<string, any>): number => Math.ceil((sys(r).length + JSON.stringify(r.tools ?? []).length) / 3.5)
      console.log('[overhead] app, estimate tokens', JSON.stringify({ chat: overhead(last), agent: overhead(work) }))
      expect(overhead(last)).toBeLessThan(overhead(work) / 3)
    } finally {
      await app.close()
    }
  }, 120_000)
})
