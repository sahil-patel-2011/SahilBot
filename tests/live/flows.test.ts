import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { describe, expect, test } from 'vitest'
import { expandSteps, launch, tempProfile } from '../accept/app'

// Real-model run (Claude Haiku 5.5, $1 cap) of the agent flows: plan first with questions and
// approval, the research tool, Team of Experts, and a quick chat. Logs to $LIVE_OUT/flows-log.json.
const KEY = process.env.FOREMAN_LIVE_KEY
const OUT = process.env.LIVE_OUT ?? tmpdir()

/** Sends a message and drives any cards (answers questions with the first option, approves plans) until done. */
async function run(page: Page, text: string, opts: { plan?: boolean; team?: boolean } = {}): Promise<{ answer: string; steps: string[]; plan: string[]; cards: string[]; ms: number; team: number }> {
  const t0 = Date.now()
  const before = await page.locator('[data-testid="assistant-bubble"]').count()
  if (opts.plan) await page.click('[data-testid="plan-toggle"]')
  if (opts.team) await page.click('[data-testid="team-toggle"]')
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
  const cards: string[] = []
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 15_000 }).toBe(1).catch(() => undefined)
  for (let i = 0; i < 600; i++) {
    if (await page.locator('[data-testid="questions-card"]').count()) {
      const q = page.locator('[data-testid="questions-card"]')
      cards.push(`questions: ${(await q.innerText()).replace(/\s+/g, ' ').slice(0, 300)}`)
      const opts = q.locator('.qcard-q')
      for (let j = 0; j < await opts.count(); j++) {
        const first = opts.nth(j).locator('[data-testid="qcard-option"]').first()
        if (await first.count()) await first.click()
        else await opts.nth(j).locator('[data-testid="qcard-input"]').fill('Use your best judgment')
      }
      await q.locator('[data-testid="qcard-send"]').click()
    } else if (await page.locator('[data-testid="plan-approval"]').count()) {
      cards.push(`plan: ${(await page.locator('[data-testid="plan-approval"]').innerText()).replace(/\s+/g, ' ').slice(0, 400)}`)
      await page.click('[data-testid="plan-approve"]')
    } else if (await page.locator('[data-testid="approval-card"]').count()) {
      cards.push(`approval: ${(await page.locator('[data-testid="approval-card"]').first().innerText()).replace(/\s+/g, ' ').slice(0, 200)}`)
      await page.locator('[data-testid="approve-once"]').first().click()
    } else if (await page.locator('[data-testid="question-card"]').count()) {
      cards.push(`question: ${(await page.locator('[data-testid="question-card"]').innerText()).slice(0, 200)}`)
      const opt = page.locator('[data-testid="question-card"] .question-option').first()
      if (await opt.count()) await opt.click()
      else { await page.fill('[data-testid="composer-input"]', 'Use your best judgment.'); await page.keyboard.press('Enter') }
    } else if (!(await page.locator('[data-testid="stop"]').count())) break
    await page.waitForTimeout(500)
  }
  await page.waitForTimeout(800)
  await expandSteps(page).catch(() => undefined)
  const answer = (await page.locator('[data-testid="assistant-bubble"]').allInnerTexts()).slice(before).join('\n---\n')
  return {
    answer, cards, ms: Date.now() - t0,
    steps: await page.locator('[data-testid="tool-chip"]').allInnerTexts(),
    plan: await page.locator('[data-testid="plan-step"]').allInnerTexts(),
    team: await page.locator('[data-testid="team-member"]').count()
  }
}

describe.skipIf(!KEY)('live: agent flows on Claude Haiku 5.5', () => {
  test('plan first, research, team, chat', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'live-flows-'))
    const { app, page } = await launch(tempProfile(), 'https://api.anthropic.com/v1', { FOREMAN_NO_VERIFY: '', FOREMAN_NO_AUTOTITLE: '' })
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.evaluate(([k, w]) => window.foreman.settings.set({ apiKey: k, defaultModel: 'auto', cloudBudgetUsd: 1, workspaceDir: w, userName: 'Sahil', search: { provider: 'duckduckgo', searxngUrl: '', hasBraveKey: false } }), [KEY!, ws])
    const listed = await page.evaluate(() => window.foreman.models.list())
    await page.evaluate((ids) => window.foreman.settings.set({ hiddenModels: ids }), listed.models.map((m) => m.id).filter((id) => !/^claude-haiku-5-5/.test(id)))
    await page.reload()
    await page.waitForSelector('[data-testid="composer-input"]')
    const log: Record<string, unknown> = {}
    const save = (): void => writeFileSync(join(OUT, 'flows-log.json'), JSON.stringify(log, null, 2))
    try {
      log.chat = await run(page, 'hey, quick one: what is 15% of 240?')
      save()
      await page.click('[data-testid="new-chat"]')
      log.plan = await run(page, 'Make a short onboarding checklist for a new front-desk receptionist at a medical clinic and save it as onboarding.md in my workspace.', { plan: true })
      log.fileExists = existsSync(join(ws, 'onboarding.md'))
      log.file = log.fileExists ? readFileSync(join(ws, 'onboarding.md'), 'utf8').slice(0, 1200) : null
      save()
      await page.click('[data-testid="new-chat"]')
      log.research = await run(page, 'According to the FDA label, what are the most common side effects of tamsulosin? Cite the label.')
      save()
      await page.click('[data-testid="new-chat"]')
      log.team = await run(page, 'Compare the 3 most popular note-taking apps for doctors (pricing, HIPAA, standout feature).', { team: true })
      save()
    } finally {
      log.budget = await page.evaluate(() => window.foreman.budget())
      save()
      await page.screenshot({ path: join(OUT, 'flows-last.png') })
      await app.close()
    }
    expect(log.fileExists).toBe(true)
  }, 900_000)
})
