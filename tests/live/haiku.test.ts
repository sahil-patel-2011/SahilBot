import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { describe, expect, test } from 'vitest'
import { expandSteps, launch, tempProfile } from '../accept/app'
import { startTestSite } from '../fixtures/test-site'

// A few cheap real-model runs (Claude Haiku 5.5, $1 cap) to see how the agent actually behaves.
// Writes transcripts to $LIVE_OUT for review.
const KEY = process.env.FOREMAN_LIVE_KEY
const OUT = process.env.LIVE_OUT ?? tmpdir()

async function ask(page: Page, text: string): Promise<{ answer: string; plan: string[]; steps: string[]; ms: number; firstWordMs: number | null; routed: string | null }> {
  const before = await page.locator('[data-testid="assistant-bubble"]').count()
  const t0 = Date.now()
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
  // Time until the first words of a reply appear (what "fast" feels like).
  let firstWordMs: number | null = null
  const watch = (async () => {
    while (Date.now() - t0 < 120_000 && firstWordMs === null) {
      const texts = await page.locator('[data-testid="assistant-bubble"] .md').allInnerTexts().catch(() => [] as string[])
      if (texts.slice(before).some((x) => x.trim().length > 0)) firstWordMs = Date.now() - t0
      else await page.waitForTimeout(50)
    }
  })()
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 15_000 }).toBe(1).catch(() => undefined)
  await expect.poll(async () => (await page.locator('[data-testid="stop"]').count()) === 0 && (await page.locator('[data-testid="approval-card"]').count()) === 0, { timeout: 240_000, interval: 500 }).toBe(true)
  // The final message can land a moment after the run ends.
  await page.waitForTimeout(600)
  const bubbles = await page.locator('[data-testid="assistant-bubble"]').allInnerTexts()
  await watch
  await expandSteps(page).catch(() => undefined)
  const routed = await page.locator('[data-testid="routed"]').last().innerText().catch(() => null)
  const plan = await page.locator('[data-testid="plan-step"]').allInnerTexts()
  const steps = await page.locator('[data-testid="tool-chip"]').allInnerTexts()
  return { answer: bubbles.slice(before).join('\n---\n'), plan, steps, ms: Date.now() - t0, firstWordMs, routed }
}

describe.skipIf(!KEY)('live: Claude Haiku 5.5', () => {
  test('explain, act, browse quietly, research', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'live-ws-'))
    const site = await startTestSite()
    const { app, page } = await launch(tempProfile(), 'https://api.anthropic.com/v1', { FOREMAN_NO_VERIFY: '', FOREMAN_NO_AUTOTITLE: '' })
    await page.setViewportSize({ width: 1360, height: 900 })
    await page.evaluate(([k, w]) => window.foreman.settings.set({ apiKey: k, defaultModel: 'auto', cloudBudgetUsd: 1, workspaceDir: w, userName: 'Sahil', search: { provider: 'duckduckgo', searxngUrl: '', hasBraveKey: false } }), [KEY!, ws])
    // Auto, but with only Haiku switched on: the routing path runs end to end and nothing pricier is used.
    const listed = await page.evaluate(() => window.foreman.models.list())
    await page.evaluate((ids) => window.foreman.settings.set({ hiddenModels: ids }), listed.models.map((m) => m.id).filter((id) => !/^claude-haiku-5-5/.test(id)))
    await page.reload()
    await page.waitForSelector('[data-testid="composer-input"]')
    const log: Record<string, unknown> = {}
    // Saved after every scenario so a failure never loses a paid run.
    const save = (): void => writeFileSync(join(OUT, 'live-log.json'), JSON.stringify(log, null, 2))

    // Normal chat: should answer directly, quickly, with no tools.
    log.chat = await ask(page, 'hey! how is it going?')
    save()
    await page.click('[data-testid="main-bot"]')
    log.quick = await ask(page, 'Give me three fun names for a golden retriever puppy.')
    save()
    await page.click('[data-testid="main-bot"]')
    log.explain = await ask(page, 'In plain words, what does a VPN actually do? Two or three sentences.')
    save()
    await page.click('[data-testid="main-bot"]')
    log.file = await ask(page, 'Create notes/newsletter-plan.md with a short 3-step plan for launching a small business newsletter.')
    save()
    log.fileExists = existsSync(join(ws, 'notes/newsletter-plan.md'))
    log.fileContent = log.fileExists ? readFileSync(join(ws, 'notes/newsletter-plan.md'), 'utf8') : null
    await page.click('[data-testid="main-bot"]')
    log.browse = await ask(page, `Open ${site.url}/widgets in the browser, set the Plan dropdown to Team, click "Show details", and tell me what text appears.`)
    save()
    log.panelOpened = (await page.locator('[data-testid="right-panel"]').count()) > 0
    await page.click('[data-testid="main-bot"]')
    log.research = await ask(page, 'Who is the current CEO of Anthropic? Look it up and cite your source.')
    save()
    // Team of Experts with real helpers.
    await page.click('[data-testid="main-bot"]')
    await page.click('[data-testid="max-toggle"]')
    log.team = await ask(page, 'What are the capital cities of Australia and Canada? Have one helper check each, and cite sources.')
    log.teamMembers = await page.locator('[data-testid="team-member"]').allInnerTexts()
    save()
    log.budget = await page.evaluate(() => window.foreman.budget())
    await page.screenshot({ path: join(OUT, 'live-last.png') })
    writeFileSync(join(OUT, 'live-log.json'), JSON.stringify(log, null, 2))
    await app.close()
    await site.close()
    expect(log.fileExists).toBe(true)
  })
})
