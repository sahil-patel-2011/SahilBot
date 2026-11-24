import type { Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Bot swarms, Council and bots asking bots, end to end against the mock model (hidden window).
let llm: MockLlm
const sys = (r: Record<string, any>): string => String(r.messages?.[0]?.content ?? '')
const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? '').join(' ') : '')
const lastUser = (r: Record<string, any>): string => textOf([...r.messages].reverse().find((m: any) => m.role === 'user')?.content)
const route = (fn: (r: Record<string, any>) => Record<string, unknown>): void => { for (let i = 0; i < 200; i++) llm.script.push(fn as never) }
const send = async (page: Page, text: string): Promise<void> => {
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
}
const openBot = async (page: Page, name: string): Promise<void> => {
  await page.reload()
  await page.locator('[data-testid="space-item"]', { hasText: name }).click()
  await expect.poll(() => page.locator('[data-testid="bot-pill"]').innerText().catch(() => '')).toContain(name)
}

describe('bot swarms, council and ask_bot', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })
  beforeEach(() => { llm.script.length = 0; llm.requests.length = 0 })

  test('Max on a bot picks a 10-helper swarm: hidden temporary helpers, a live card, the compile and credits', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    await page.evaluate(() => window.foreman.spaces.create({ name: 'Ideas Bot', intro: false }))
    await openBot(page, 'Ideas Bot')
    let lead = 0
    route((r) => {
      if (sys(r).includes('# You are a temporary swarm helper')) {
        const n = Number(/helper H(\d+) of (\d+)/.exec(lastUser(r))?.[1] ?? 0)
        return { content: `1. **Idea ${n}: neighborhood ${n}**: try it. Why it could work: locals. Risk: time.\n2. **Plan ${n}b**: more.\nBest bet: the first.`, delay: 0 }
      }
      lead++
      return lead === 1
        ? { toolCalls: [{ name: 'swarm', arguments: JSON.stringify({ goal: 'Ways to grow a neighborhood bakery', pattern: 'ideate', helpers: 10 }) }], delay: 0 }
        : { content: 'SWARM COMPILED: the best ideas are the club [H2, H5] and the stall [H9].', delay: 0 }
    })
    await send(page, 'Use an agent swarm to brainstorm ways to grow my bakery')
    await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText(), { timeout: 60_000 }).toContain('SWARM COMPILED')
    // The swarm is a phase of the one Max card.
    const max = page.locator('[data-testid="max-card"]')
    await expect.poll(() => max.getAttribute('data-strategy'), { timeout: 15_000 }).toBe('swarm')
    const card = max.locator('[data-testid="swarm-card"]')
    await expect.poll(() => card.getAttribute('data-phase'), { timeout: 15_000 }).toBe('done')
    expect(await card.locator('[data-testid="swarm-helper"][data-status="done"]').count()).toBe(10)
    expect(await card.locator('[data-testid="swarm-count"]').innerText()).toMatch(/10 of 10 helpers · 20 ideas/)
    // Credits from the compiled answer.
    expect(await card.locator('[data-testid="swarm-credit"]').count()).toBe(3)
    // Inside the Max card the credits show once, on its result (not again on the swarm's compile).
    await expect.poll(() => max.locator('[data-testid="max-credits"]').innerText(), { timeout: 15_000 }).toMatch(/H2×1/)
    // Ten distinct briefs went out; every result reached the compile.
    const helpers = llm.requests.filter((r) => sys(r).includes('# You are a temporary swarm helper'))
    expect(new Set(helpers.map((r) => /## Your angle[^\n]*\n(.+)/.exec(lastUser(r))?.[1])).size).toBe(10)
    const compile = llm.requests.filter((r) => !sys(r).includes('# You are a temporary swarm helper')).at(-1)!
    for (let i = 1; i <= 10; i++) expect(JSON.stringify(compile.messages)).toContain(`Idea ${i}: neighborhood ${i}`)
    // Helpers are temporary: never chats in the sidebar; their transcripts open from the card.
    expect(await page.locator('[data-testid="thread-item"]').count()).toBeLessThanOrEqual(1)
    await card.locator('[data-testid="swarm-helper"]').first().locator('button').first().click()
    await expect.poll(() => card.locator('[data-testid="swarm-transcript"]').innerText(), { timeout: 10_000 }).toMatch(/brief[\s\S]*Swarm brief/i)
    await app.close()
  })

  test('Council: two members plan on their own, critique each other, merge, carry it out and review each other on a readable card', async () => {
    // Two models that both fit (the chosen members; Auto would pick cloud ones).
    const saved = [...llm.models]
    llm.models = ['qwen3.8:27b', 'gemma4:12b']
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    route((r) => {
      const s = sys(r)
      if (s.startsWith('[COUNCIL-PLAN]')) return { content: `PLAN FROM ${r.model}\n1. Draft the post\n2. Check facts`, delay: 0 }
      if (s.startsWith('[COUNCIL-CRITIQUE]')) return { content: `CRITIQUE FROM ${r.model}: add a deadline.`, delay: 0 }
      if (s.startsWith('[COUNCIL-MERGE]')) return { content: JSON.stringify({ summary: 'One post, facts checked.', steps: [{ text: 'Draft the post', owner: 1 }, { text: 'Check the facts', owner: 2 }], disagreements: [] }), delay: 0 }
      if (s.startsWith('[COUNCIL-SIGN]')) return { content: '{"ok": true, "objections": []}', delay: 0 }
      if (s.startsWith('[COUNCIL-REVIEW]')) return { content: '{"ok": true, "issues": []}', delay: 0 }
      if (lastUser(r).includes('[COUNCIL-FINAL]')) return { content: 'COUNCIL FINAL: here is the post.', delay: 0 }
      if (s.includes('# You are a council member')) return { content: '### Step 1\nDone.\n### Step 2\nDone.', delay: 0 }
      return { content: 'unexpected', delay: 0 }
    })
    // The simplified composer infers swarm intent. Preserve coverage for legacy saved council requests too.
    const tid = await page.evaluate(async () => {
      const main = (await window.foreman.spaces.list()).find((s) => s.isMain)!
      return (await window.foreman.threads.create(main.id)).id
    })
    await page.evaluate((threadId) => window.foreman.chat.send({ threadId, text: 'Write our launch post', council: ['qwen3.8:27b', 'gemma4:12b'] }), tid)
    // (Recents lists a chat once you've typed in it.)
    await page.reload()
    await page.locator('[data-testid="thread-item"]').first().click()
    await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText(), { timeout: 60_000 }).toContain('COUNCIL FINAL')
    const card = page.locator('[data-testid="council-card"]')
    await expect.poll(() => card.getAttribute('data-phase'), { timeout: 15_000 }).toBe('done')
    expect(await card.locator('[data-testid="council-member"]').count()).toBe(2)
    expect(await card.locator('[data-testid="council-step"]').count()).toBe(2)
    expect(await card.locator('[data-testid="council-review"]').count()).toBe(2)
    expect(await card.locator('[data-testid="council-stop"]').innerText()).toContain('Everyone signed off in round 1')
    // The full plans and critiques are readable on the card.
    await card.locator('[data-testid="council-member"] summary').first().click()
    expect(await card.locator('[data-testid="council-member"]').first().innerText()).toMatch(/PLAN FROM[\s\S]*CRITIQUE FROM/)
    // Each member drafted its plan without seeing the other's.
    const plans = llm.requests.filter((r) => sys(r).startsWith('[COUNCIL-PLAN]'))
    expect(new Set(plans.map((r) => r.model)).size).toBe(2)
    expect(plans.every((r) => !JSON.stringify(r.messages).includes('PLAN FROM'))).toBe(true)
    await app.close()
    llm.models = saved
  })

  test('a bot asks another bot: the answer comes back on an "Asked Finance" card', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    await page.evaluate(async () => {
      await window.foreman.spaces.create({ name: 'Alpha', intro: false })
      await window.foreman.spaces.create({ name: 'Finance', intro: false })
    })
    await openBot(page, 'Alpha')
    let lead = 0
    route((r) => {
      if (JSON.stringify(r.messages).includes('Question from the bot \\"Alpha\\"')) return { content: 'Q3 spend was $12,400.', delay: 0 }
      lead++
      return lead === 1 ? { toolCalls: [{ name: 'ask_bot', arguments: JSON.stringify({ bot: 'Finance', question: 'What was our Q3 spend?' }) }], delay: 0 } : { content: 'ANSWER: Finance says $12,400.', delay: 0 }
    })
    await send(page, 'What was our Q3 spend? Ask Finance.')
    await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText(), { timeout: 30_000 }).toContain('ANSWER')
    const card = page.locator('[data-testid="askbot-card"]')
    expect(await card.innerText()).toContain('Asked Finance')
    await card.locator('button').first().click()
    expect(await card.locator('[data-testid="askbot-answer"]').innerText()).toContain('$12,400')
    // Finance answered in a hidden thread: it has no new chat in the sidebar.
    const fin = await page.evaluate(async () => {
      const spaces = await window.foreman.spaces.list()
      const f = spaces.find((s) => s.name === 'Finance')!
      return (await window.foreman.threads.list(f.id)).length
    })
    expect(fin).toBeLessThanOrEqual(1)
    await app.close()
  })
})
