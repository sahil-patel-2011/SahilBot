import type { Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { startFakeServer, type FakeServer } from '../fixtures/fake-oauth-mcp'

// One-click connectors from inside a conversation: a plain chat (the lean chat path) and a bot ask for an
// app that isn't connected → the in-chat Connect card → one click (OAuth DCR + PKCE against a local fake
// server, signed in headlessly) → the app's tool runs on the very next step of the same run → the answer.
// A second chat then uses the app directly, with no card. Everything stays on 127.0.0.1.

let llm: MockLlm
const idle = async (page: Page): Promise<void> => {
  await expect.poll(() => llm.script.length, { timeout: 30_000 }).toBe(0)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 30_000 }).toBe(0)
}
const send = async (page: Page, text: string): Promise<void> => {
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
}
const names = (r: Record<string, any>): string[] => (r.tools ?? []).map((t: any) => t.function.name)
const sys = (r: Record<string, any>): string => String(r.messages[0].content)
const lastTool = (r: Record<string, any>): string => String([...r.messages].reverse().find((m: any) => m.role === 'tool')?.content ?? '')
const TOOL = 'acme_tasks__list_tasks'
const CHAT_SET = ['find_tools', 'web_search', 'fetch_page', 'memory']

async function start(): Promise<{ fake: FakeServer; app: Awaited<ReturnType<typeof launch>>['app']; page: Page }> {
  const fake = await startFakeServer({ name: 'acme', tools: [{ name: 'list_tasks', description: 'Lists your open tasks', readOnly: true, reply: () => 'Buy milk; File taxes' }] })
  const { app, page } = await launch(tempProfile(), llm.url, {
    // The sign-in page (loopback only) loads headlessly instead of in the user's browser.
    SAHILBOT_TEST_OAUTH_FETCH: '1',
    // A one-click catalog entry for the fake app (test runs only; loopback only).
    SAHILBOT_TEST_PRESETS: JSON.stringify([{ id: 'test-acme', name: 'Acme Tasks', url: fake.url, description: 'Your Acme task lists.' }])
  })
  return { fake, app, page }
}

/** The scripted run: find_tools → (card, one click) → the app's tool on the next step → the answer. */
function scriptAsk(o: { expectChat: boolean }): void {
  llm.script.push(
    { toolCalls: [{ name: 'find_tools', arguments: '{"query":"acme tasks"}' }] },
    (req) => {
      const ok = names(req).includes(TOOL) && /loaded now/.test(lastTool(req)) && (!o.expectChat || names(req).slice(0, 4).join() === CHAT_SET.join())
      return ok ? { toolCalls: [{ name: TOOL, arguments: '{}' }] } : { content: `unexpected tools: ${names(req).join(', ')} / ${lastTool(req).slice(0, 300)}` }
    },
    (req) => ({ content: lastTool(req).includes('Buy milk') ? 'Your open tasks: Buy milk; File taxes.' : `unexpected: ${lastTool(req).slice(0, 300)}` })
  )
}

describe('connect apps from a chat', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })
  beforeEach(() => { llm.script.length = 0; llm.requests.length = 0 })

  test('a plain chat: Connect card → one click → the tool runs in the same chat; a new chat uses it directly', async () => {
    const { fake, app, page } = await start()
    try {
      scriptAsk({ expectChat: true })
      await send(page, "What's on my Acme Tasks list?")
      const card = page.locator('[data-testid="connect-card"]')
      await card.waitFor({ timeout: 20_000 })
      expect(await card.innerText()).toContain('Acme Tasks')
      await card.locator('[data-testid="connect-card-go"]').click()
      await idle(page)
      expect(await card.count()).toBe(0)
      expect(fake.log.registrations).toHaveLength(1)
      expect(fake.log.authorizes[0].get('code_challenge_method')).toBe('S256')
      expect(fake.log.calls.map((c) => c.name)).toEqual(['list_tasks'])
      await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText().catch(() => ''), { timeout: 10_000 }).toContain('Buy milk; File taxes')
      // Still the lean chat path all the way: the chat prompt, the chat tools, then the app's tools.
      for (const r of llm.requests) expect(sys(r)).toContain('# Chatting')
      expect(names(llm.requests.at(-1)!)).toEqual([...CHAT_SET, TOOL])

      // Connect apps shows the app connected (the connect came from the chat card).
      await page.click('[data-testid="connect-apps"]')
      await expect.poll(() => page.locator('[data-testid="preset-test-acme"]').getAttribute('data-state'), { timeout: 10_000 }).toBe('connected')
      await page.click('[data-testid="connected-count"]')
      const row = page.locator('[data-testid="connector-row"]')
      await expect.poll(() => row.getAttribute('data-state'), { timeout: 10_000 }).toBe('connected')
      expect(await row.innerText()).toContain('Acme Tasks')
      await page.keyboard.press('Escape')

      // A brand-new chat: find_tools finds the connected app; no card, no second sign-in.
      await page.click('[data-testid="new-chat"]')
      llm.requests.length = 0
      llm.script.push(
        { toolCalls: [{ name: 'find_tools', arguments: '{"query":"acme tasks"}' }] },
        (req) => (names(req).includes(TOOL) ? { toolCalls: [{ name: TOOL, arguments: '{}' }] } : { content: `not loaded: ${names(req).join(', ')}` }),
        (req) => ({ content: lastTool(req).includes('Buy milk') ? 'Still: Buy milk; File taxes.' : 'unexpected' })
      )
      await send(page, 'Anything new on my Acme Tasks list?')
      await idle(page)
      expect(await page.locator('[data-testid="connect-card"]').count()).toBe(0)
      expect(fake.log.calls).toHaveLength(2)
      expect(fake.log.authorizes).toHaveLength(1)
      await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText().catch(() => ''), { timeout: 10_000 }).toContain('Still: Buy milk')
      for (const r of llm.requests) expect(sys(r)).toContain('# Chatting')
    } finally {
      await app.close()
      await fake.close()
    }
  }, 120_000)

  test('a bot: Connect card in the bot\'s chat → one click → the tool runs; another bot then uses it directly', async () => {
    const { fake, app, page } = await start()
    try {
      await page.evaluate(async () => { await window.foreman.spaces.create({ name: 'Ana', intro: false }); await window.foreman.spaces.create({ name: 'Ben', intro: false }) })
      await page.reload()
      const open = async (name: string): Promise<void> => {
        await page.locator('[data-testid="space-item"]', { hasText: name }).click()
        await expect.poll(() => page.locator('[data-testid="bot-pill"]').innerText().catch(() => '')).toContain(name)
      }
      await open('Ana')
      scriptAsk({ expectChat: false })
      await send(page, "What's on my Acme Tasks list?")
      const card = page.locator('[data-testid="connect-card"]')
      await card.waitFor({ timeout: 20_000 })
      await card.locator('[data-testid="connect-card-go"]').click()
      await idle(page)
      expect(fake.log.calls.map((c) => c.name)).toEqual(['list_tasks'])
      await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText().catch(() => ''), { timeout: 10_000 }).toContain('Buy milk; File taxes')
      // The bot's own prompt answered.
      expect(sys(llm.requests.at(-1)!)).toContain('You are Ana')

      // Another bot: the connection is the user's, so Ben finds the app with find_tools (no card, no sign-in).
      await open('Ben')
      llm.requests.length = 0
      llm.script.push(
        { toolCalls: [{ name: 'find_tools', arguments: '{"query":"acme tasks"}' }] },
        (req) => (names(req).includes(TOOL) ? { toolCalls: [{ name: TOOL, arguments: '{}' }] } : { content: `not loaded: ${names(req).join(', ')}` }),
        (req) => ({ content: lastTool(req).includes('Buy milk') ? 'Ben here: Buy milk; File taxes.' : `unexpected: ${lastTool(req).slice(0, 200)}` })
      )
      await send(page, 'List my Acme tasks')
      await idle(page)
      expect(await page.locator('[data-testid="connect-card"]').count()).toBe(0)
      expect(fake.log.calls).toHaveLength(2)
      expect(fake.log.authorizes).toHaveLength(1)
      await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText().catch(() => ''), { timeout: 10_000 }).toContain('Ben here: Buy milk')
      expect(sys(llm.requests[0])).toContain('You are Ben')
    } finally {
      await app.close()
      await fake.close()
    }
  }, 120_000)
})
