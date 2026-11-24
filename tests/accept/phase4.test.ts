import { resolve } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { expandSteps, launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

let llm: MockLlm
const idle = async (page: Page): Promise<void> => {
  await expect.poll(() => llm.script.length, { timeout: 20_000 }).toBe(0)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
}
const lastTool = (): string => String([...llm.requests.at(-1)!.messages].reverse().find((m: any) => m.role === 'tool')?.content ?? '')

// Phase 4 acceptance: MCP connectors (local stdio server standing in for Gmail/Semrush) and web search.
describe('phase 4: connectors + web search', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('connect a local MCP server from Connect apps; the agent finds and uses its tools with the right permissions', async () => {
    // The 64 GB target Mac: on a small Mac the local window (16-32K) is mostly taken by the prompt and tools,
    // and the run compacts every step, which isn't what this test is about.
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    await page.click('[data-testid="profile"]'); await page.click('[data-testid="connect-apps"]')
    await page.click('[data-testid="preset-custom"]')
    await page.fill('.conn-form input >> nth=0', 'Notes')
    await page.click('.conn-form .seg button:has-text("Local")')
    await page.fill('[data-testid="conn-command"]', `node ${resolve('tests/fixtures/mcp-notes-server.mjs')}`)
    await page.click('[data-testid="conn-save"]')
    const row = page.locator('[data-testid="connector-row"]')
    await expect.poll(() => row.getAttribute('data-state'), { timeout: 30_000 }).toBe('connected')
    await expect.poll(() => row.innerText(), { timeout: 10_000 }).toContain('2 tools')
    await page.keyboard.press('Escape')

    llm.script.push(
      { toolCalls: [{ name: 'find_tools', arguments: '{"query":"notes"}' }] },
      { toolCalls: [{ name: 'notes__search_notes', arguments: '{"query":"launch"}' }] },
      { toolCalls: [{ name: 'notes__send_note', arguments: '{"to":"sam@acme.test","text":"Launch is Dec 1"}' }] },
      { content: 'Found it and sent Sam a note.' }
    )
    await page.fill('[data-testid="composer-input"]', 'Look up the launch date in my notes and send it to sam@acme.test')
    await page.keyboard.press('Enter')
    // Reading and sending (what you asked for) both run on their own in Auto.
    await idle(page)
    expect(await page.locator('[data-testid="approval-card"]').count()).toBe(0)
    const tools = llm.requests.at(-1)!.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content))
    expect(tools.some((t: string) => t.includes('Launch date is Dec 1') && t.includes('trust="untrusted"'))).toBe(true)
    expect(tools.at(-1)).toContain('Sent to sam@acme.test')
    // find_tools loaded the connector's tools into the request's tool list.
    const names = (llm.requests.at(-1)!.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(names).toContain('notes__search_notes')
    // No tool cap: built-ins stay, the connector's tools are added after them.
    expect(names).toContain('browser')
    expect(names.indexOf('notes__search_notes')).toBeGreaterThan(names.indexOf('browser'))
    await expandSteps(page)
    expect(await page.locator('[data-testid="tool-chip"]').count()).toBe(3)
    await app.close()
  })

  test('web search goes through the configured SearXNG endpoint', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.evaluate((u) => window.foreman.settings.set({ search: { provider: 'searxng', searxngUrl: u, hasBraveKey: false } }), llm.url.replace(/\/v1$/, ''))
    llm.script.push({ toolCalls: [{ name: 'web_search', arguments: '{"query":"qwen 3.8 release"}' }] }, { content: 'Here is what I found.' })
    await page.fill('[data-testid="composer-input"]', 'When did Qwen 3.8 come out?')
    await page.keyboard.press('Enter')
    await idle(page)
    expect(lastTool()).toContain('Result for qwen 3.8 release')
    expect(lastTool()).toContain('https://example.com/a')
    await app.close()
  })
})
