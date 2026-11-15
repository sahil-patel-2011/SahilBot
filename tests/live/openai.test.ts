import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { describe, expect, test } from 'vitest'
import { expandSteps, launch, tempProfile } from '../accept/app'
import { startTestSite } from '../fixtures/test-site'

// Real-model runs on the user's OpenAI key, through the app's own Settings (the key goes in with
// settings.set like a user pasting it, is stored encrypted in the temp profile, and is cleared at the
// end). Long, multi-step tasks that check the agent keeps facts and constraints across many steps.
// Spend is capped by the app's own budget (OPENAI_LIVE_BUDGET, default $10). Logs to $LIVE_OUT.
const KEY = process.env.OPENAI_LIVE_KEY
const OUT = process.env.LIVE_OUT ?? tmpdir()
const BUDGET = Number(process.env.OPENAI_LIVE_BUDGET ?? 10)
const ONLY = process.env.LIVE_ONLY ?? ''

type Run = { answer: string; steps: string[]; plan: string[]; cards: string[]; ms: number; error?: string }

/** Sends a message and drives any cards (first option, approve plans and actions) until the run ends. */
async function run(page: Page, text: string, timeoutMs = 15 * 60_000): Promise<Run> {
  const t0 = Date.now()
  const before = await page.locator('[data-testid="assistant-bubble"]').count()
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
  const cards: string[] = []
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(1).catch(() => undefined)
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
      // Never let a test drive the user's other apps (Word, Finder, …) on their screen: deny those, allow the rest.
      const outside = /osascript|tell application|\bopen -a\b|\bopen "|Microsoft|Finder|System Events|computer use|Click at|Type into/i.test(text)
      cards.push(`${outside ? 'DENIED' : 'approval'}: ${text.slice(0, 200)}`)
      await page.locator(outside ? '[data-testid="approve-deny"]' : '[data-testid="approve-once"]').first().click()
    } else if (!(await page.locator('[data-testid="stop"]').count())) break
    await page.waitForTimeout(400)
  }
  await page.waitForTimeout(800)
  const bubbles = await page.locator('[data-testid="assistant-bubble"]').allInnerTexts()
  await expandSteps(page).catch(() => undefined)
  const steps = await page.locator('[data-testid="tool-chip"]').allInnerTexts()
  const plan = await page.locator('[data-testid="plan-step"]').allInnerTexts()
  const r: Run = { answer: bubbles.slice(before).join('\n---\n'), steps, plan, cards, ms: Date.now() - t0 }
  if (Date.now() - t0 >= timeoutMs) r.error = 'timed out'
  return r
}

/** Filler prose so each file is a few thousand tokens, with the one fact that matters buried inside. */
function vendorFile(n: number, fact: string): string {
  const para = (i: number): string => `Section ${i}. The vendor relationship review covered onboarding, quarterly business reviews, escalation paths, uptime reports and invoicing cadence. Notes from meeting ${i}: the account team was responsive, the roadmap slides were generic, and follow-ups arrived within two business days. No changes to the master agreement were proposed in this section.`
  const body = Array.from({ length: 22 }, (_, i) => para(i + 1))
  body.splice(9 + (n % 7), 0, fact)
  return `# Vendor ${String(n).padStart(2, '0')} review\n\n${body.join('\n\n')}\n`
}

describe.skipIf(!KEY)('live: OpenAI through the app', () => {
  test('long real tasks keep their facts and constraints', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'live-oai-ws-'))
    const site = await startTestSite()
    const { app, page } = await launch(tempProfile(), 'https://api.openai.com/v1', { FOREMAN_NO_VERIFY: '', FOREMAN_NO_AUTOTITLE: '' })
    const log: Record<string, unknown> = {}
    const save = (): void => writeFileSync(join(OUT, 'openai-log.json'), JSON.stringify(log, null, 2))
    try {
      await page.setViewportSize({ width: 1360, height: 900 })
      // The key goes in the way Settings → Models saves it; a hard budget caps everything below.
      await page.evaluate(([k, w, b]) => window.foreman.settings.set({ setKeys: { openai: k as string }, cloudBudgetUsd: b as number, workspaceDir: w as string, userName: 'Sahil', search: { provider: 'duckduckgo', searxngUrl: '', hasBraveKey: false } } as never), [KEY!, ws, BUDGET])
      await page.reload()
      await page.waitForSelector('[data-testid="composer-input"]')
      const listed = await page.evaluate(() => window.foreman.models.list())
      log.models = listed.models.map((m) => ({ id: m.id, provider: m.provider, tier: m.tier, ctx: m.contextTokens, note: m.note }))
      save()
      // One OpenAI model for every run (LIVE_OPENAI_MODEL, else the strongest listed GPT).
      const gpt = listed.models.filter((m) => m.provider === 'openai')
      // (The launch URL is api.openai.com, so models are OpenAI's and run over the Responses API. Only the current
      // lineup is on by default; older and pro models are listed but off.)
      const on = gpt.filter((m) => m.enabled)
      const pick = process.env.LIVE_OPENAI_MODEL ?? [...(on.length ? on : gpt)].sort((a, b) => (b.tier - a.tier) || ((b.rank ?? 0) - (a.rank ?? 0)))[0]?.id
      log.model = pick
      save()
      expect(pick, 'no OpenAI model listed for this key').toBeTruthy()
      if (ONLY === 'models') return
      await page.evaluate(([id, all]) => window.foreman.settings.set({ defaultModel: id as string, hiddenModels: (all as string[]).filter((x) => x !== id) } as never), [pick!, listed.models.map((m) => m.id)])
      await page.reload()
      await page.waitForSelector('[data-testid="composer-input"]')

      // 1. Many files, one fact each, constraints set up front: the spreadsheet and summary must be exact.
      if (!ONLY || ONLY === 'vendors') {
        const dir = join(ws, 'vendors')
        mkdirSync(dir, { recursive: true })
        const facts: Array<{ n: number; cost: number; ends: string; contact: string }> = []
        const names = ['Ana Ruiz', 'Ben Okafor', 'Chen Wei', 'Dana Holt', 'Eli Moss', 'Fay Grant', 'Gus Lind', 'Hana Sato', 'Ivo Petrov', 'Jo Banks', 'Kai Doyle', 'Lea Voss', 'Max Ortiz', 'Nia Shah', 'Oli Brandt', 'Pia Kerr', 'Raj Iyer', 'Sol Reyes']
        for (let n = 1; n <= names.length; n++) {
          const f = { n, cost: 1000 * ((n * 37) % 90 + 10), ends: `${2026 + (n % 3)}-${String((n * 5) % 12 + 1).padStart(2, '0')}`, contact: names[n - 1] }
          facts.push(f)
          writeFileSync(join(dir, `vendor-${String(n).padStart(2, '0')}.md`), vendorFile(n, `KEY FACTS: annual cost EUR ${f.cost.toLocaleString('en-US')}; contract ends ${f.ends}; account contact ${f.contact}.`))
        }
        log.vendorFacts = facts
        const r = await run(page, 'Two rules for this whole task: give every amount in euros, and do not email or contact anyone. Go through every file in the vendors folder of my workspace (read each one; the key facts are buried in each file). Make vendors.xlsx with one row per vendor: vendor number, annual cost, contract end (YYYY-MM) and contact. Then write summary.md with the three most expensive vendors and every contract that ends in 2027. Finish by telling me the total annual cost across all vendors.')
        const total = facts.reduce((a, f) => a + f.cost, 0)
        const top3 = [...facts].sort((a, b) => b.cost - a.cost).slice(0, 3).map((f) => f.n)
        const ends2027 = facts.filter((f) => f.ends.startsWith('2027')).map((f) => f.n)
        const summary = existsSync(join(ws, 'summary.md')) ? readFileSync(join(ws, 'summary.md'), 'utf8') : ''
        log.vendors = {
          ...r, total, top3, ends2027,
          files: readdirSync(ws),
          xlsx: existsSync(join(ws, 'vendors.xlsx')),
          summary: summary.slice(0, 4000),
          totalStated: r.answer.replace(/[,\s.]/g, '').includes(String(total)),
          euros: /€|EUR|euro/i.test(r.answer + summary),
          dollars: /\$\s?\d/.test(r.answer + summary),
          top3InSummary: top3.every((n) => new RegExp(`\\b0?${n}\\b`).test(summary)),
          ends2027InSummary: ends2027.every((n) => new RegExp(`\\b0?${n}\\b`).test(summary))
        }
        log.budgetAfterVendors = await page.evaluate(() => window.foreman.budget())
        save()
      }

      // 2. A long conversation: facts in turn 1, big pasted documents in between, recall at the end.
      if (!ONLY || ONLY === 'memory') {
        await page.click('[data-testid="main-bot"]')
        const turns: Run[] = []
        turns.push(await run(page, 'Context for this chat: my project codename is BLUE-HERON, the launch date is 3 March 2027, the budget is EUR 48,500, and my manager is called Priya. Never round the budget. Just say "noted" for now.'))
        const doc = (topic: string): string => Array.from({ length: 60 }, (_, i) => `${topic} note ${i + 1}: the team discussed scope, staffing, vendor timelines, testing windows and the communications plan; action items were assigned and reviewed at the next stand-up.`).join(' ')
        for (const topic of ['Design review', 'Security audit', 'Marketing plan']) turns.push(await run(page, `Here is the ${topic.toLowerCase()} document. Give me its three main themes in one line each.\n\n${doc(topic)}`))
        turns.push(await run(page, 'Without looking anything up: what is my project codename, the exact launch date, the exact budget, and my manager\'s name? Then draft a two-sentence status update for my manager that uses all four.'))
        const last = turns[turns.length - 1].answer
        log.memory = { turns, recalled: { codename: /BLUE-HERON/i.test(last), date: /3 March 2027|March 3,? 2027|2027-03-03/i.test(last), budget: /48,?500/.test(last), manager: /Priya/.test(last), notRounded: !/48\.5k|~?€?49,?000|48k/i.test(last) } }
        log.budgetAfterMemory = await page.evaluate(() => window.foreman.budget())
        save()
      }

      // 3. A multi-step browser task on the local test site.
      if (!ONLY || ONLY === 'browser') {
        await page.click('[data-testid="main-bot"]')
        const r = await run(page, `Open ${site.url}/widgets in the browser, set the Plan dropdown to Team, click "Show details", and tell me exactly what text appears. Then go back to ${site.url}/ and list every link on that page.`)
        log.browser = r
        log.budgetAfterBrowser = await page.evaluate(() => window.foreman.budget())
        save()
      }

      // 4. Plan first with questions, then a deliverable.
      if (!ONLY || ONLY === 'plan') {
        await page.click('[data-testid="main-bot"]')
        await page.click('[data-testid="plan-toggle"]')
        const r = await run(page, 'Write a one-page onboarding checklist for a new remote employee as onboarding.docx in my workspace.')
        log.plan = { ...r, docx: existsSync(join(ws, 'onboarding.docx')) }
        save()
      }
      log.budget = await page.evaluate(() => window.foreman.budget())
      log.usage = await page.evaluate(() => (window.foreman as unknown as { usage?: { summary?: () => unknown } }).usage?.summary?.()).catch(() => null)
      await page.screenshot({ path: join(OUT, 'openai-last.png') })
      save()
    } finally {
      // The key leaves the test profile again.
      await page.evaluate(() => window.foreman.settings.set({ setKeys: { openai: null } } as never)).catch(() => undefined)
      save()
      await app.close()
      await site.close()
    }
  }, 60 * 60_000)
})
