import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile, typeMessage } from './app'
import { lastToolOutput, refFor, startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { startTestSite, STORE, type TestSite } from '../fixtures/test-site'

// Always-on bots against the mock model: a bot in Auto mode runs a multi-step task with one
// question, keeps working while the question waits in Needs you, the answer arrives (one tap in the
// inbox) and the bot finishes. A purchase still stops at the Purchase card.

let llm: MockLlm
let site: TestSite
beforeAll(async () => { [llm, site] = await Promise.all([startMockLlm(), startTestSite()]) })
afterAll(async () => { await Promise.all([llm.close(), site.close()]) })

const idle = async (page: Page): Promise<void> => {
  await expect.poll(() => llm.script.length, { timeout: 20_000 }).toBe(0)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
}
const write = (path: string, content: string) => ({ toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path, content }) }] })
const browser = (args: Record<string, unknown>) => ({ toolCalls: [{ name: 'browser', arguments: JSON.stringify(args) }] })

describe('always-on bots', () => {
  test('an Auto bot keeps working while its question waits, then finishes when the answer arrives; a purchase still stops', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'foreman-ws-'))
    // FOREMAN_ASK_GRACE_MS=0: the question goes straight to Needs you (as when the user is away).
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_ASK_GRACE_MS: '0' })
    await page.evaluate((dir) => window.foreman.settings.set({ workspaceDir: dir }), ws)
    const { space, threadId } = await page.evaluate(() => window.foreman.spaces.create({ name: 'Trip Planner', intro: false }))
    // New bots work at Auto (what Autonomous used to be); the main chat keeps the app default.
    const threads = await page.evaluate(() => window.foreman.threads.list())
    expect(threads.find((t) => t.id === threadId)!.permissionMode).toBe('auto')
    await page.reload()
    await page.locator('[data-testid="space-item"]', { hasText: 'Trip Planner' }).click()
    await page.waitForSelector('[data-testid="composer-input"]')

    const p = (n: string) => join(ws, n)
    llm.script.push(
      write(p('research.md'), '# Flights and hotels\nOptions gathered.'),
      { toolCalls: [{ name: 'ask_user', arguments: JSON.stringify({ question: 'Which hotel area do you prefer?', options: ['Old town (recommended)', 'Near the airport'], preference: true }) }] },
      // The question returned at once: the bot carries on with the parts that don't depend on it.
      (req) => {
        expect(lastToolOutput(req)).toMatch(/Posted to the user's Needs-you inbox/)
        return write(p('itinerary.md'), '# Itinerary\nDay 1: arrive. Day 2: museums.')
      },
      { content: 'Itinerary drafted; the hotel waits on your choice of area.' }
    )
    await typeMessage(page, 'Plan my 3-day Lisbon trip and pick a hotel')
    await page.getByTestId('send').click()
    await idle(page)
    expect(existsSync(p('research.md'))).toBe(true)
    expect(existsSync(p('itinerary.md'))).toBe(true)
    // No blocking card: the question waits in the inbox instead.
    expect(await page.locator('[data-testid="question-card"]').count()).toBe(0)
    const inbox = await page.evaluate(() => window.foreman.needsYou.list())
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({ source: 'queue', kind: 'question', botName: 'Trip Planner', status: 'open', botId: space.id })
    expect(inbox[0].deadline).toBeGreaterThan(Date.now() + 3 * 3_600_000)

    // One tap in Needs you (the Tasks page) answers it and the bot picks the waiting part back up.
    llm.script.push(
      (req) => {
        expect(JSON.stringify(req.messages)).toContain('Answer to \\"Which hotel area do you prefer?\\": Near the airport')
        return write(p('hotel.md'), '# Hotel\nAirport Inn, 3 nights.')
      },
      { content: 'Booked nothing yet: shortlisted the Airport Inn near the airport. All done.' }
    )
    await page.click('[data-testid="nav-tasks"]')
    // The bot's sidebar row shows the "needs you" dot while its question waits in the inbox.
    await expect.poll(() => page.locator('[data-testid="needs-you"]').count(), { timeout: 10_000 }).toBeGreaterThan(0)
    const item = page.locator('[data-testid="needs-you-item"]')
    await item.waitFor({ timeout: 10_000 })
    expect(await item.innerText()).toContain('Which hotel area do you prefer?')
    await item.locator('[data-testid="needs-you-option"]', { hasText: 'Near the airport' }).click()
    await expect.poll(() => llm.script.length, { timeout: 20_000 }).toBe(0)
    await expect.poll(() => existsSync(p('hotel.md')), { timeout: 20_000 }).toBe(true)
    expect(readFileSync(p('hotel.md'), 'utf8')).toContain('Airport Inn')
    await expect.poll(async () => (await page.evaluate(() => window.foreman.needsYou.list())).length, { timeout: 10_000 }).toBe(0)
    await expect.poll(async () => (await page.evaluate((id) => window.foreman.threads.messages(id), threadId)).at(-1)?.content, { timeout: 20_000 }).toContain('All done')

    // A reply typed in the bot's chat answers the waiting question (no inbox, no card).
    await page.locator('[data-testid="space-item"]', { hasText: 'Trip Planner' }).click()
    await page.locator('[data-testid="assistant-bubble"]', { hasText: 'All done' }).waitFor({ timeout: 10_000 })
    llm.script.push(
      write(p('museums.md'), '# Museums\nGulbenkian, MAAT.'),
      { toolCalls: [{ name: 'ask_user', arguments: JSON.stringify({ question: 'Which day should the museum visit be?', options: ['Day 2 (recommended)', 'Day 3'] }) }] },
      { content: 'Museums listed; the day waits on you.' }
    )
    await typeMessage(page, 'Add a museum day')
    await page.getByTestId('send').click()
    await idle(page)
    expect(await page.evaluate(() => window.foreman.needsYou.list())).toHaveLength(1)
    llm.script.push(
      (req) => {
        expect(JSON.stringify(req.messages)).toContain('This message answers your question \\"Which day should the museum visit be?\\"')
        return write(p('museum-day.md'), 'Museums on day 3.')
      },
      { content: 'Museums moved to day 3.' }
    )
    await typeMessage(page, 'Day 3')
    await page.getByTestId('send').click()
    await idle(page)
    expect(existsSync(p('museum-day.md'))).toBe(true)
    expect(await page.locator('[data-testid="question-card"]').count()).toBe(0)
    expect(await page.evaluate(() => window.foreman.needsYou.list())).toHaveLength(0)

    // A purchase still stops: the Purchase card shows (it never goes to the queue or runs on its own).
    await page.evaluate(async (c) => {
      const addrs = await window.foreman.vault.setAddress({ nickname: 'Home', name: 'Sam Rivera', line1: '1 Main St', city: 'Albany', region: 'NY', postal: '12207', country: 'US' })
      await window.foreman.vault.setCard({ nickname: 'Personal', number: c.number, cvc: c.cvc, expMonth: c.month, expYear: c.year, holder: c.holder, billing: addrs[0].id })
    }, STORE.card)
    await fetch(`${site.url}/store/reset`)
    await fetch(`${site.url}/store/cart`, { method: 'POST', body: 'qty=2', headers: { 'content-type': 'application/x-www-form-urlencoded' } })
    llm.script.push(
      browser({ action: 'navigate', url: `${site.url}/store/checkout` }),
      browser({ action: 'fill_payment', card: 'Personal' }),
      browser({ action: 'snapshot' }),
      (req) => browser({ action: 'click', ref: refFor(lastToolOutput(req), 'button', 'Place order') }),
      { content: 'I did not place the order.' }
    )
    await typeMessage(page, 'Buy the travel mugs in my cart with my Personal card')
    await page.getByTestId('send').click()
    const fillCard = page.locator('[data-testid="purchase-card"][data-step="fill"]')
    await fillCard.waitFor({ timeout: 20_000 })
    await fillCard.locator('[data-testid="purchase-approve"]').click()
    const orderCard = page.locator('[data-testid="purchase-card"][data-step="submit"]')
    await orderCard.waitFor({ timeout: 20_000 })
    expect(await orderCard.innerText()).toContain(STORE.total)
    await page.waitForTimeout(500)
    // It waits for the user: nothing was ordered, and nothing went to the queue to be decided later.
    expect(site.orders).toHaveLength(0)
    expect((await page.evaluate(() => window.foreman.needsYou.list())).filter((x) => x.source === 'queue')).toHaveLength(0)
    await orderCard.locator('[data-testid="purchase-deny"]').click()
    await idle(page)
    expect(site.orders).toHaveLength(0)
    await app.close()
  })
})
