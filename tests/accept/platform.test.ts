import { existsSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { launch, tempProfile, settingsPage } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// End to end through the real UI and main process, with a scripted model: templates, bot-to-bot
// handoffs, pages, approval rules, routine tests and memory import.

let llm: MockLlm
const idle = async (page: Page): Promise<void> => {
  await expect.poll(() => llm.script.length, { timeout: 20_000 }).toBe(0)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
}
const send = async (page: Page, text: string): Promise<void> => {
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
}
const call = (name: string, args: unknown) => ({ toolCalls: [{ name, arguments: JSON.stringify(args) }] })

describe('platform: templates, handoffs, pages, rules, routines, memory', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })
  beforeEach(() => { llm.script.length = 0 })

  test('adding a bot template (New bot → Or start from a template) creates the bot with its intro and paused routines', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.click('[data-testid="new-bot"]')
    await page.click('[data-testid="template-school-studying"]')
    // The new bot opens with its starter message.
    await expect.poll(() => page.locator('[data-testid="space-item"]').filter({ hasText: 'Study Buddy' }).count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(async () => (await page.locator('.bubble.ai').allInnerTexts()).join('\n').length, { timeout: 10_000 }).toBeGreaterThan(20)
    // Its suggested routines exist and are paused until the user says yes.
    const spaces = await page.evaluate(() => window.foreman.spaces.list())
    const bot = spaces.find((s) => s.name === 'Study Buddy')!
    const routines = (await page.evaluate(() => window.foreman.schedules.list())).filter((t) => t.spaceId === bot.id)
    expect(routines.length).toBeGreaterThan(0)
    expect(routines.every((r) => !r.enabled)).toBe(true)
    await page.click('[data-testid="bot-pill"]')
    await page.locator('[data-testid="bot-details"]').waitFor()
    await expect.poll(() => page.locator('[data-testid="routine-row"]').count(), { timeout: 5_000 }).toBe(routines.length)
    await app.close()
  })

  test('one bot hands work to another and gets its answer back', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.evaluate(() => window.foreman.spaces.create({ name: 'Researcher', color: '#0EA5E9', shape: 'blob', intro: false }))
    llm.script.push(
      call('message_bot', { bot: 'researcher', message: 'Find the boiling point of water at sea level in °C.', wait: true }),
      { content: 'Water boils at 100 °C at sea level.' },
      { content: 'The Researcher says water boils at 100 °C at sea level.' }
    )
    await send(page, 'Ask the Researcher bot for the boiling point of water')
    await idle(page)
    const replies = (await page.locator('.bubble.ai').allInnerTexts()).join('\n')
    expect(replies).toContain('100 °C')
    // The handoff is visible in both chats, and the researcher's run saw who asked.
    const spaces = await page.evaluate(() => window.foreman.spaces.list())
    const researcher = spaces.find((s) => s.name === 'Researcher')!
    const threads = await page.evaluate((id) => window.foreman.threads.list(id), researcher.id)
    const msgs = await page.evaluate((id) => window.foreman.threads.messages(id), threads[0].id)
    expect(msgs.some((m) => m.role === 'user' && m.content.includes('boiling point'))).toBe(true)
    expect(msgs.some((m) => m.role === 'assistant' && m.content.includes('100 °C'))).toBe(true)
    await app.close()
  })

  test('a page the agent builds opens isolated in the side panel, with the safety policy in the file', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sb-ws-'))
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.evaluate((w) => window.foreman.settings.set({ workspaceDir: w }), ws)
    llm.script.push(
      call('create_page', { title: 'Q4 Dashboard', html: '<h1>Q4</h1><div id="c"></div><script>sb.chart(document.getElementById("c"), { type: "bar", labels: ["Oct", "Nov"], series: [{ name: "Revenue", values: [100, 112] }] })</script>' }),
      { content: 'Your dashboard is ready.' }
    )
    await send(page, 'Make me a Q4 dashboard')
    await idle(page)
    const card = page.locator('[data-testid="page-card"]')
    await card.waitFor({ timeout: 10_000 })
    await page.locator('[data-testid="page-pane"]').waitFor({ timeout: 10_000 })
    // The live page is not in the app window: main lays a native view from the isolated pages session over
    // the panel and reports how it is locked down (no iframe, own session, WebRTC limited to proxied traffic).
    const view = page.locator('[data-testid="page-pane"] [data-testid="page-view"]')
    await expect.poll(() => view.getAttribute('data-isolation'), { timeout: 10_000 }).toBe('webcontentsview')
    expect(await view.getAttribute('data-partition')).toBe('sahilbot-pages')
    expect(await view.getAttribute('data-webrtc')).toBe('disable_non_proxied_udp')
    expect(await view.getAttribute('data-guard')).toBe('true')
    expect(await page.locator('iframe[src*="/pages/"]').count()).toBe(0)
    const file = join(ws, 'pages', 'q4-dashboard.html')
    expect(existsSync(file)).toBe(true)
    const html = readFileSync(file, 'utf8')
    expect(html).toMatch(/Content-Security-Policy/)
    expect(html).toMatch(/connect-src 'none'/)
    await app.close()
  })

  test('an Ask-first approval rule makes SahilBot ask even in Bypass', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sb-ws-'))
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.evaluate((w) => window.foreman.settings.set({ workspaceDir: w, advanced: { hardStopsEnabled: true, allowBypass: true }, customRules: [{ id: 'r1', when: 'tool:file_write', action: 'ask' }] }), ws)
    const main = (await page.evaluate(() => window.foreman.spaces.list())).find((s) => s.isMain)!
    const t = await page.evaluate((id) => window.foreman.threads.create(id), main.id)
    await page.evaluate((id) => window.foreman.threads.update(id, { permissionMode: 'bypass' }), t.id)
    llm.script.push(
      call('file_write', { path: 'notes.txt', content: 'hello' }),
      { content: 'Saved.' }
    )
    await page.evaluate((id) => window.foreman.chat.send({ threadId: id, text: 'Write hello to notes.txt' }), t.id)
    // Bypass would normally just write; the rule makes it ask first.
    await expect.poll(async () => (await page.evaluate((id) => window.foreman.chat.pending(id), t.id)).length, { timeout: 15_000 }).toBe(1)
    expect(existsSync(join(ws, 'notes.txt'))).toBe(false)
    const [req] = await page.evaluate((id) => window.foreman.chat.pending(id), t.id)
    await page.evaluate(([id, rid]) => window.foreman.chat.respond(id, rid, 'once'), [t.id, req.id] as const)
    await expect.poll(() => existsSync(join(ws, 'notes.txt')), { timeout: 15_000 }).toBe(true)
    expect(readFileSync(join(ws, 'notes.txt'), 'utf8')).toBe('hello')
    await app.close()
  })

  test('testing a routine records the run and posts its result in the bot\'s chat', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    const main = (await page.evaluate(() => window.foreman.spaces.list())).find((s) => s.isMain)!
    const task = await page.evaluate((id) => window.foreman.schedules.create({ title: 'Morning check', prompt: 'Say good morning.', schedule: { type: 'daily', time: '07:00' }, spaceId: id }), main.id)
    llm.script.push({ content: 'Good morning! Nothing urgent today.' })
    await page.evaluate((id) => window.foreman.schedules.runNow(id), task.id)
    await expect.poll(async () => (await page.evaluate((id) => window.foreman.schedules.runs(id), task.id))[0]?.status, { timeout: 20_000 }).toBe('succeeded')
    // A test run doesn't move the schedule.
    const after = (await page.evaluate(() => window.foreman.schedules.list())).find((t) => t.id === task.id)!
    expect(after.nextRun).toBe(task.nextRun)
    await app.close()
  })

  test('memories pasted from another assistant import with a preview and dedupe', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.evaluate(() => window.foreman.memory.add('Lives in Atlanta, GA', null))
    await page.click('[data-testid="profile"]')
    await settingsPage(page, 'memory')
    await page.click('[data-testid="memory-import-open"]')
    await page.fill('[data-testid="memory-import-text"]', "Here's what I remember about you:\n- Prefers concise answers\n- Lives in Atlanta, GA\n- Always ask before sending email\n- Sister Priya is a nurse")
    await page.click('[data-testid="memory-import-preview"]')
    const rows = page.locator('[data-testid="memory-import-row"]')
    await rows.first().waitFor()
    // The intro line is dropped and the Atlanta memory already exists.
    expect(await rows.count()).toBe(3)
    await page.click('[data-testid="memory-import-commit"]')
    await expect.poll(async () => (await page.evaluate(() => window.foreman.memory.list())).length, { timeout: 10_000 }).toBe(4)
    await app.close()
  })
})
