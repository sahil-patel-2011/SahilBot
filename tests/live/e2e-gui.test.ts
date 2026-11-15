import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { describe, expect, test } from 'vitest'
import { expandSteps, launch, tempProfile } from '../accept/app'

// The whole app, end to end, on the user's real Claude key through the GUI (hidden window): one big agent task
// left to run to the end (research → spreadsheet → PDF report → slide deck → self-check), then a bot swarm,
// with a screenshot every 30 s so the GUI can be reviewed. The app's own monthly limit caps the spend
// (E2E_BUDGET, default $35). Everything lands in $LIVE_OUT/e2e.
const KEY = process.env.ANTHROPIC_LIVE_KEY
const OUT = join(process.env.LIVE_OUT ?? tmpdir(), 'e2e')
const BUDGET = Number(process.env.E2E_BUDGET ?? 35)

type Run = { answer: string; steps: string[]; cards: string[]; ms: number; error?: string }

/** Sends a message and drives cards until the run ends: approves work in the workspace, never other apps. */
async function run(page: Page, text: string, timeoutMs: number): Promise<Run> {
  const t0 = Date.now()
  const before = await page.locator('[data-testid="assistant-bubble"]').count()
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
  const cards: string[] = []
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 30_000 }).toBe(1).catch(() => undefined)
  while (Date.now() - t0 < timeoutMs) {
    if (await page.locator('[data-testid="questions-card"]').count()) {
      const q = page.locator('[data-testid="questions-card"]')
      cards.push(`questions: ${(await q.innerText()).replace(/\s+/g, ' ').slice(0, 300)}`)
      const qs = q.locator('.qcard-q')
      for (let j = 0; j < await qs.count(); j++) {
        const first = qs.nth(j).locator('[data-testid="qcard-option"]').first()
        if (await first.count()) await first.click()
        else await qs.nth(j).locator('[data-testid="qcard-input"]').fill('Use your best judgment')
      }
      await q.locator('[data-testid="qcard-send"]').click()
    } else if (await page.locator('[data-testid="question-card"]').count()) {
      const q = page.locator('[data-testid="question-card"]')
      cards.push(`question: ${(await q.innerText()).replace(/\s+/g, ' ').slice(0, 300)}`)
      const opt = q.locator('button.option, [data-testid="question-option"]').first()
      if (await opt.count()) await opt.click()
      else { await q.locator('[data-testid="question-own-input"]').fill('Use your best judgment'); await q.locator('[data-testid="question-own-send"]').click() }
    } else if (await page.locator('[data-testid="plan-approval"]').count()) {
      cards.push(`plan: ${(await page.locator('[data-testid="plan-approval"]').innerText()).replace(/\s+/g, ' ').slice(0, 400)}`)
      await page.click('[data-testid="plan-approve"]')
    } else if (await page.locator('[data-testid="approval-card"]').count()) {
      const text = (await page.locator('[data-testid="approval-card"]').first().innerText()).replace(/\s+/g, ' ')
      // Never let a test drive the user's other apps (Word, Finder…) on their screen.
      const outside = /osascript|tell application|\bopen -a\b|\bopen "|Microsoft|Finder|System Events|computer use|Click at|Type into/i.test(text)
      cards.push(`${outside ? 'DENIED' : 'approval'}: ${text.slice(0, 200)}`)
      await page.locator(outside ? '[data-testid="approve-deny"]' : '[data-testid="approve-once"]').first().click()
    } else if (await page.locator('[data-testid="spend-card"]').count()) {
      cards.push('spend: approved')
      await page.locator('[data-testid="spend-ok"]').first().click().catch(() => undefined)
    } else if (!(await page.locator('[data-testid="stop"]').count())) break
    await page.waitForTimeout(500)
  }
  await page.waitForTimeout(1000)
  const bubbles = await page.locator('[data-testid="assistant-bubble"]').allInnerTexts()
  await expandSteps(page).catch(() => undefined)
  const steps = await page.locator('[data-testid="tool-chip"]').allInnerTexts()
  const r: Run = { answer: bubbles.slice(before).join('\n---\n'), steps, cards, ms: Date.now() - t0 }
  if (Date.now() - t0 >= timeoutMs) r.error = 'timed out'
  return r
}

describe.skipIf(!KEY)('live e2e: the full app on Claude through the GUI', () => {
  test('one big agent task to the end, then a bot swarm; screenshots throughout', async () => {
    mkdirSync(OUT, { recursive: true })
    const ws = mkdtempSync(join(tmpdir(), 'e2e-ws-'))
    const { app, page } = await launch(tempProfile(), 'https://api.anthropic.com/v1', { FOREMAN_NO_VERIFY: '', FOREMAN_NO_AUTOTITLE: '' })
    const log: Record<string, unknown> = { workspace: ws }
    const save = (): void => writeFileSync(join(OUT, 'e2e-log.json'), JSON.stringify(log, null, 2))
    const errors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)) })
    page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`))
    const procLog = join(OUT, 'app.log')
    writeFileSync(procLog, '')
    app.process().stderr?.on('data', (b: Buffer) => appendFileSync(procLog, b))
    let shot = 0
    const snap = async (name: string): Promise<void> => { await page.screenshot({ path: join(OUT, `${String(++shot).padStart(3, '0')}-${name}.png`) }).catch(() => undefined) }
    const ticker = setInterval(() => void snap('tick'), 30_000)
    try {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.evaluate(([k, w, b]) => window.foreman.settings.set({ setKeys: { anthropic: k as string }, cloudBudgetUsd: b as number, workspaceDir: w as string, userName: 'Sahil', search: { provider: 'duckduckgo', searxngUrl: '', hasBraveKey: false } } as never), [KEY!, ws, BUDGET])
      await page.reload()
      await page.waitForSelector('[data-testid="composer-input"]')
      await snap('home')

      // 1. One big task, Auto picks model and effort, left to finish.
      log.task = await run(page, 'Research the current state of home battery storage for US homeowners (costs per kWh, the top 4 products, federal and common state incentives, and typical payback). Use real web sources and cite them. Then create in my workspace: battery-comparison.xlsx (one row per product: price, usable capacity kWh, warranty, $/kWh, notes), battery-report.pdf (a polished 4–6 page report with a cover, contents, an executive summary, a comparison table, a chart of $/kWh, and recommendations with citations) and battery-deck.pptx (6–8 slides for a homeowner). Check every file before you finish, then tell me what you made.', 30 * 60_000)
      log.files = readdirSync(ws).map((f) => ({ f, bytes: statSync(join(ws, f)).size }))
      log.budgetAfterTask = await page.evaluate(() => window.foreman.budget())
      save()
      await snap('task-done')
      await page.evaluate(() => window.foreman.settings.set({ theme: 'dark' } as never))
      await page.waitForTimeout(800)
      await snap('task-done-dark')
      await page.evaluate(() => window.foreman.settings.set({ theme: 'light' } as never))

      // 2. A bot swarm: the run happens while another chat is open (sidebar shimmer, then unread + NEW divider).
      const { space } = await page.evaluate(() => window.foreman.spaces.create({ name: 'Ideas Lab', intro: false }))
      await page.evaluate((id) => window.foreman.settings.set({ botSwarm: { [id as string]: { mode: 'auto', maxHelpers: 10 } } } as never), space.id)
      await page.reload()
      await page.locator('[data-testid="space-item"]', { hasText: 'Ideas Lab' }).click()
      await page.waitForSelector('[data-testid="composer-input"]')
      await page.click('[data-testid="modes-menu"]').catch(() => undefined)
      await page.click('[data-testid="swarm-toggle"]').catch(() => undefined)
      await page.keyboard.press('Escape').catch(() => undefined)
      await snap('swarm-armed')
      const t0 = Date.now()
      await page.fill('[data-testid="composer-input"]', 'Brainstorm 20 distinct business ideas a solo founder could start in 2027 using AI agents. Then group them, pick the best 5, and for each give the customer, why now, a first 30-day plan and the biggest risk.')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(15_000)
      await snap('swarm-running')
      // Leave the bot while it works: the sidebar should shimmer, then show unread.
      await page.click('[data-testid="main-bot"]')
      await page.waitForTimeout(5_000)
      await snap('sidebar-while-swarm')
      await expect.poll(async () => (await page.evaluate((id) => window.foreman.threads.list().then((ts: any[]) => ts.some((t) => t.spaceId === id && (t.unread || t.unreadCount > 0))), space.id)), { timeout: 20 * 60_000, interval: 5_000 }).toBe(true)
      log.swarmMs = Date.now() - t0
      await page.waitForTimeout(3_000)
      await snap('sidebar-unread')
      await page.locator('[data-testid="space-item"]', { hasText: 'Ideas Lab' }).click()
      await page.waitForTimeout(2_000)
      await snap('bot-new-divider')
      log.newDivider = await page.locator('[data-testid="new-divider"], .new-divider, [data-testid="unread-divider"]').count()
      // Let anything still running finish, then collect the answer.
      await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 10 * 60_000, interval: 3_000 }).toBe(0).catch(() => undefined)
      const bubbles = await page.locator('[data-testid="assistant-bubble"]').allInnerTexts()
      log.swarmAnswer = bubbles.slice(-1)[0]?.slice(0, 6000)
      log.swarmCards = await page.locator('[data-testid="swarm-card"], .heavy-card').count()
      await snap('swarm-done')
      await page.evaluate(() => window.foreman.settings.set({ theme: 'dark' } as never))
      await page.waitForTimeout(800)
      await snap('swarm-done-dark')

      log.budget = await page.evaluate(() => window.foreman.budget())
      log.consoleErrors = errors
      save()
    } finally {
      clearInterval(ticker)
      await page.evaluate(() => window.foreman.settings.set({ setKeys: { anthropic: null } } as never)).catch(() => undefined)
      log.consoleErrors = errors
      save()
      await app.close()
    }
    expect(existsSync(join(ws, 'battery-report.pdf'))).toBe(true)
  }, 75 * 60_000)
})
