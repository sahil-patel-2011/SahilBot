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

  test('the composer shows Max instead of Team, Swarm and Heavy; Plan first stays first', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    await page.click('[data-testid="modes-menu"]')
    const menu = page.locator('.modes-menu')
    await menu.waitFor()
    expect(await page.locator('[data-testid="team-toggle"], [data-testid="swarm-toggle"], [data-testid="heavy-toggle"]').count()).toBe(0)
    const ids = await menu.locator('[role="menuitemcheckbox"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
    expect(ids.slice(0, 3)).toEqual(['plan-toggle', 'max-toggle', 'deep-toggle'])
    expect(await page.locator('[data-testid="max-toggle"]').innerText()).toContain('Many agents at once: SahilBot picks a research team, an idea swarm, competing attempts with a judge, or a mix.')
    await shoot(page, 'modes-menu', undefined, async () => { if (!(await menu.isVisible())) await page.click('[data-testid="modes-menu"]') })
    await page.click('[data-testid="max-toggle"]')
    expect(await page.locator('[data-testid="mode-chip-max"]').innerText()).toContain('Max')
    // ⌘⇧M turns it off again.
    await page.keyboard.press('Meta+Shift+M')
    await expect.poll(() => page.locator('[data-testid="mode-chip-max"]').count()).toBe(0)
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
    await page.click('[data-testid="modes-menu"]')
    await page.click('[data-testid="max-toggle"]')
    await send(page, 'Brainstorm ways to grow my bakery')
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
    await page.click('[data-testid="modes-menu"]')
    await page.click('[data-testid="max-toggle"]')
    await send(page, 'Prove that the square root of 2 is irrational')
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

  test('the bot editor has no Model or Thinking rows; a bot chat\'s picker shows Auto (bot) read-only', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    await page.evaluate(() => window.foreman.spaces.create({ name: 'Writer', intro: false }))
    await openBot(page, 'Writer')
    await page.click('[data-testid="bot-pill"]')
    const details = page.locator('[data-testid="bot-details"]')
    await details.waitFor()
    expect(await details.locator('[data-testid="bot-auto-line"]').innerText()).toContain('Model and thinking: automatic')
    await page.click('[data-testid="bot-customize"]')
    const editor = page.locator('[data-testid="bot-editor"]')
    await editor.waitFor()
    const labels = await editor.locator('.field > label').allInnerTexts()
    expect(labels).not.toContain('Model')
    expect(labels).not.toContain('Thinking')
    expect(labels).toContain('Max')
    expect(await editor.locator('[data-testid="bot-effort"]').count()).toBe(0)
    expect(await editor.locator('select').count()).toBe(1)
    expect(await editor.locator('[data-testid="editor-max-mode"]').inputValue()).toBe('auto')
    await shoot(page, 'bot-editor', () => page.locator('[data-testid="bot-editor"]'))
    await page.keyboard.press('Escape')
    await editor.waitFor({ state: 'detached' })
    await page.keyboard.press('Escape')

    // The bot chat's picker: the model reads "Auto (bot)" and can't be changed; there's no thinking choice; permissions can.
    await page.click('[data-testid="model-picker"]')
    const autoRow = page.locator('[data-testid="model-auto-bot"]')
    await autoRow.waitFor()
    expect(await autoRow.innerText()).toContain('Auto (bot)')
    expect(await autoRow.isDisabled()).toBe(true)
    expect(await page.locator('[data-testid="thinking-picker"]').count()).toBe(0)
    expect(await page.locator('[data-testid="picker-menu"] [data-testid="model-option"]:not([data-auto])').count()).toBe(0)
    expect(await page.locator('[data-testid="mode-picker"]').isDisabled()).toBe(false)
    await shoot(page, 'picker-bot', undefined, async () => { if (!(await autoRow.isVisible())) await page.click('[data-testid="model-picker"]') })
    await page.keyboard.press('Escape')
    // A regular chat still has the manual picks.
    await page.keyboard.press('Meta+n')
    await page.click('[data-testid="model-picker"]')
    await expect.poll(() => page.locator('[data-testid="model-option"]').first().innerText()).toContain('Auto')
    expect(await page.locator('[data-testid="model-auto-bot"]').count()).toBe(0)
    await shoot(page, 'picker-chat', undefined, async () => { if (!(await page.locator('[data-testid="picker-menu"]').isVisible())) await page.click('[data-testid="model-picker"]') })
    // On Auto there's no Thinking choice: Auto picks it. Picking a model shows it; going back to Auto hides it again.
    expect(await page.locator('[data-testid="thinking-picker"]').count()).toBe(0)
    await page.locator('[data-testid="picker-menu"] [data-testid="model-option"]:not([data-auto])').first().click()
    await page.click('[data-testid="model-picker"]')
    await page.locator('[data-testid="thinking-picker"]').click()
    await page.locator('[data-testid="thinking-high"]').click()
    await expect.poll(() => page.locator('[data-testid="model-picker"]').innerText()).toContain('High')
    await page.click('[data-testid="model-picker"]')
    await page.click('[data-testid="model-option"][data-auto="auto"]')
    await expect.poll(() => page.locator('[data-testid="model-picker"]').innerText()).toBe('Auto')
    await page.click('[data-testid="model-picker"]')
    expect(await page.locator('[data-testid="thinking-picker"]').count()).toBe(0)
    await page.locator('[data-testid="picker-menu"] [data-testid="model-option"]:not([data-auto])').first().click()
    await page.click('[data-testid="model-picker"]')
    await page.locator('[data-testid="thinking-picker"]').click()
    await shoot(page, 'picker-thinking', undefined, async () => {
      if (!(await page.locator('[data-testid="picker-menu"]').isVisible())) await page.click('[data-testid="model-picker"]')
      if (!(await page.locator('[data-testid="picker-thinking"]').isVisible())) await page.locator('[data-testid="thinking-picker"]').click()
    })
    await app.close()
  })
})
