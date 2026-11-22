import { mkdirSync } from 'node:fs'
import type { Locator, Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Max mode end to end against the mock model (hidden window): one toggle instead of three, the planner's pick
// on one live card, and bots that choose their own model and thinking.
// MAX_SHOTS=1 also saves screenshots (light and dark, 1280 and 900 wide) to test-results/max-shots.

let llm: MockLlm
const shots = !!process.env.MAX_SHOTS
const out = 'test-results/max-shots'
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
const SIZES = [{ w: 1280, h: 820 }, { w: 900, h: 700 }]
async function shoot(page: Page, name: string, el?: () => Locator, prep?: () => Promise<unknown>): Promise<void> {
  if (!shots) return
  mkdirSync(out, { recursive: true })
  for (const s of SIZES) {
    await page.setViewportSize({ width: s.w, height: s.h })
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForTimeout(250)
      if (prep) await prep().catch(() => undefined)
      if (el && name === 'bot-editor') await el().screenshot({ path: `${out}/${name}-${scheme}-${s.w}.png` })
      else if (el) { await el().evaluate((e) => e.scrollIntoView({ block: 'start' })).catch(() => undefined); await page.waitForTimeout(150); await page.screenshot({ path: `${out}/${name}-${scheme}-${s.w}.png` }) }
      else await page.screenshot({ path: `${out}/${name}-${scheme}-${s.w}.png` })
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: SIZES[0].w, height: SIZES[0].h })
}

describe('Max mode', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })
  beforeEach(() => { llm.script.length = 0; llm.requests.length = 0 })

  test('the composer uses one automatic Agent, with plan and swarm intent inferred from the prompt', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    expect(await page.locator('[data-testid="modes-menu"], [data-testid="team-toggle"], [data-testid="swarm-toggle"], [data-testid="heavy-toggle"]').count()).toBe(0)
    await page.fill('[data-testid="composer-input"]', 'Plan first before changing anything')
    expect(await page.locator('[data-testid="agent-strategy"]').innerText()).toContain('Plan first')
    await page.fill('[data-testid="composer-input"]', 'Use an agent swarm to compare the options')
    expect(await page.locator('[data-testid="agent-strategy"]').innerText()).toContain('Agent swarm')
    await shoot(page, 'automatic-agent')
    await app.close()
  })

  test('a brainstorming prompt picks the idea swarm, shown on one Max card', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    await page.evaluate(() => window.foreman.spaces.create({ name: 'Ideas Bot', intro: false }))
    await openBot(page, 'Ideas Bot')
    let lead = 0
    route((r) => {
      if (sys(r).includes('# You are a temporary swarm helper')) {
        const n = Number(/helper H(\d+) of (\d+)/.exec(lastUser(r))?.[1] ?? 0)
        return { content: `1. **Pop-up ${n}**: a weekend stall in a new spot. Why: reach. Risk: weather.\n2. **Club ${n}**: a bread club.\nBest bet: the first.`, delay: 30 }
      }
      lead++
      return lead === 1
        ? { toolCalls: [{ name: 'max', arguments: JSON.stringify({ strategy: 'swarm', goal: 'Ways to grow a neighborhood bakery', pattern: 'ideate', helpers: 8 }) }], delay: 0 }
        : { content: 'MAX COMPILED: the best ideas are the club [H2, H5] and the stall [H7].', delay: 0 }
    })
    await send(page, 'Use an agent swarm to brainstorm ways to grow my bakery')
    const card = page.locator('[data-testid="max-card"]')
    await card.waitFor({ timeout: 15_000 })
    expect(await card.getAttribute('data-strategy')).toBe('swarm')
    expect(await card.locator('[data-testid="max-title"]').innerText()).toBe('idea swarm')
    expect(await card.locator('[data-testid="max-why"]').innerText()).toMatch(/brainstorming/i)
    await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText(), { timeout: 60_000 }).toContain('MAX COMPILED')
    await expect.poll(() => card.getAttribute('data-status'), { timeout: 15_000 }).toBe('done')
    const swarm = card.locator('[data-testid="swarm-card"]')
    expect(await swarm.getAttribute('data-phase')).toBe('done')
    expect(await swarm.locator('[data-testid="swarm-helper"][data-status="done"]').count()).toBe(8)
    expect(await card.locator('[data-testid="max-credits"]').innerText()).toMatch(/H2×1/)
    // One card: no separate swarm card outside it.
    expect(await page.locator('[data-testid="swarm-card"]').count()).toBe(1)
    await shoot(page, 'max-card-swarm', () => page.locator('[data-testid="max-card"]'))
    await app.close()
  })

  test('a hard single-answer prompt picks competing attempts with a judge', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    route((r) => {
      const s = sys(r)
      if (s.includes('[HEAVY-JUDGE]')) return { content: JSON.stringify({ agreements: ['√2 is irrational'], disagreements: [{ point: 'which proof is clearest', attempts: [1, 3] }], errors: [], unsupported: [], recheck: null, summary: 'Attempts 1 and 2 give the classic proof; 3 is more formal.' }), delay: 0 }
      if (lastUser(r).includes('[HEAVY-FINAL]')) return { content: 'JUDGED PROOF: suppose √2 = p/q in lowest terms… [A1][A3]', delay: 0 }
      const n = Number(s.match(/Heavy attempt (\d+) of/)?.[1])
      if (n) return { content: `Attempt ${n}: assume √2 = p/q in lowest terms; then p² = 2q², so p is even…\n\nEvidence: a classic proof.`, delay: 40 }
      return { content: 'unexpected', delay: 0 }
    })
    await send(page, 'Use an agent swarm to prove that the square root of 2 is irrational')
    const card = page.locator('[data-testid="max-card"]')
    await card.waitFor({ timeout: 15_000 })
    expect(await card.getAttribute('data-strategy')).toBe('heavy')
    expect(await card.locator('[data-testid="max-title"]').innerText()).toBe('competing attempts + judge')
    await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText(), { timeout: 60_000 }).toContain('JUDGED PROOF')
    await expect.poll(() => card.getAttribute('data-status'), { timeout: 15_000 }).toBe('done')
    const heavy = card.locator('[data-testid="heavy-card"]')
    expect(await heavy.getAttribute('data-judge')).toBe('done')
    expect(await heavy.locator('[data-testid="heavy-attempt"]').count()).toBeGreaterThanOrEqual(2)
    expect(await heavy.locator('[data-testid="heavy-verdict"]').innerText()).toContain('Attempts 1 and 2 give the classic proof')
    expect(await card.locator('[data-testid="max-credits"]').innerText()).toMatch(/A1×1/)
    expect(await page.locator('[data-testid="heavy-card"]').count()).toBe(1)
    await shoot(page, 'max-card-heavy', () => page.locator('[data-testid="max-card"]'))
    await app.close()
  })

  test('bot setup is simple and model/thinking remain independently overridable in chat', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    await page.evaluate(() => window.foreman.spaces.create({ name: 'Writer', intro: false }))
    await openBot(page, 'Writer')
    await page.click('[data-testid="bot-pill"]')
    await page.click('[data-testid="bot-customize"]')
    const editor = page.locator('[data-testid="bot-editor"]')
    // The editor loads lazily: read its fields only once it's there.
    await editor.waitFor()
    const labels = await editor.locator('.field > label').allInnerTexts()
    expect(labels).not.toContain('Model'); expect(labels).not.toContain('Thinking'); expect(labels).not.toContain('Max')
    expect(await editor.locator('[data-testid="editor-max-mode"]').count()).toBe(0)
    // One layer per Escape: the editor, then the details panel.
    await page.keyboard.press('Escape'); await expect.poll(() => editor.count()).toBe(0)
    await page.keyboard.press('Escape'); await expect.poll(() => page.locator('[data-testid="bot-details"]').count()).toBe(0)
    await page.click('[data-testid="model-picker"]')
    expect(await page.locator('[data-testid="model-option"][data-auto="auto"]').isEnabled()).toBe(true)
    expect(await page.locator('[data-testid="thinking-picker"]').isEnabled()).toBe(true)
    await page.locator('[data-testid="picker-menu"] [data-testid="model-option"]:not([data-auto])').first().click()
    await page.click('[data-testid="model-picker"]')
    await page.click('[data-testid="thinking-picker"]'); await page.click('[data-testid="thinking-high"]')
    await expect.poll(() => page.locator('[data-testid="model-picker"]').innerText()).toContain('High')
    await page.click('[data-testid="model-picker"]'); await page.click('[data-testid="model-option"][data-auto="auto"]')
    // Model Auto does not erase a thinking level the user explicitly chose.
    await expect.poll(() => page.locator('[data-testid="model-picker"]').innerText()).toContain('High')
    await page.click('[data-testid="model-picker"]'); await page.click('[data-testid="thinking-picker"]'); await page.click('[data-testid="thinking-auto"]')
    await expect.poll(() => page.locator('[data-testid="model-picker"]').innerText()).toBe('Auto')
    await shoot(page, 'picker-bot-override')
    await app.close()
  })

})
