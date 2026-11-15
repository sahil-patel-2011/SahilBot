import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { describe, expect, test } from 'vitest'
import { expandSteps, launch, tempProfile } from '../accept/app'
import { startTestSite } from '../fixtures/test-site'

// Real-model runs on the user's Anthropic key, through the app's own Settings (the key goes in with
// settings.set like a user pasting it, is stored encrypted in the temp profile, and is cleared at the
// end). Long, multi-step tasks that check the agent keeps facts and constraints across many steps, plus a
// long-context run (~400K tokens of files) with the "max" context strategy.
// Spend is capped by the app's own budget (CLAUDE_LIVE_BUDGET, default $15 per run). Logs to $LIVE_OUT.
const KEY = process.env.ANTHROPIC_LIVE_KEY
const OUT = process.env.LIVE_OUT ?? tmpdir()
const BUDGET = Number(process.env.CLAUDE_LIVE_BUDGET ?? 15)
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

describe.skipIf(!KEY)('live: Claude through the app', () => {
  test('long real tasks keep their facts and constraints', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'live-claude-ws-'))
    const site = await startTestSite()
    const { app, page } = await launch(tempProfile(), 'https://api.anthropic.com/v1', { FOREMAN_NO_VERIFY: '', FOREMAN_NO_AUTOTITLE: '' })
    // The app's own output, so a crash mid-run leaves its reason behind.
    const procLog = join(OUT, `claude-app${process.env.LIVE_TAG ? `-${process.env.LIVE_TAG}` : ''}.log`)
    writeFileSync(procLog, '')
    const tee = (b: Buffer): void => { try { appendFileSync(procLog, b) } catch { /* ignore */ } }
    app.process().stdout?.on('data', tee)
    app.process().stderr?.on('data', tee)
    app.process().on('exit', (code, sig) => tee(Buffer.from(`\n[app exited code=${code} signal=${sig}]\n`)))
    page.on('crash', () => tee(Buffer.from('\n[renderer crashed]\n')))
    const log: Record<string, unknown> = {}
    const save = (): void => writeFileSync(join(OUT, `claude-log${process.env.LIVE_TAG ? `-${process.env.LIVE_TAG}` : ''}.json`), JSON.stringify(log, null, 2))
    try {
      await page.setViewportSize({ width: 1360, height: 900 })
      // The key goes in the way Settings → Models saves it; a hard budget caps everything below.
      await page.evaluate(([k, w, b]) => window.foreman.settings.set({ setKeys: { anthropic: k as string }, cloudBudgetUsd: b as number, workspaceDir: w as string, userName: 'Sahil', search: { provider: 'duckduckgo', searxngUrl: '', hasBraveKey: false } } as never), [KEY!, ws, BUDGET])
      await page.reload()
      await page.waitForSelector('[data-testid="composer-input"]')
      const listed = await page.evaluate(() => window.foreman.models.list())
      log.models = listed.models.map((m) => ({ id: m.id, provider: m.provider, tier: m.tier, ctx: m.contextTokens, note: m.note }))
      save()
      // One Claude model for every run (LIVE_CLAUDE_MODEL, default Sonnet 5.5: the everyday agent model).
      const claude = listed.models.filter((m) => m.provider === 'anthropic')
      const pick = process.env.LIVE_CLAUDE_MODEL ?? claude.find((m) => /^claude-sonnet-5-5/.test(m.id))?.id ?? claude[0]?.id
      log.model = pick
      save()
      expect(pick, 'no Claude model listed for this key').toBeTruthy()
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
      // 5. Long context: ~40 files, ~400K tokens in all, the "max" context strategy; questions that need
      // facts from files read hundreds of thousands of tokens apart.
      if (!ONLY || ONLY === 'longctx') {
        await page.evaluate(() => window.foreman.settings.get().then((s: any) => window.foreman.settings.set({ cloud: { ...s.cloud, contextStrategy: 'max' } } as never)))
        await page.click('[data-testid="main-bot"]')
        const dir = join(ws, 'archive')
        mkdirSync(dir, { recursive: true })
        const cities = ['Lisbon', 'Osaka', 'Quito', 'Tallinn', 'Accra', 'Perth', 'Bergen', 'Cusco']
        const needles: Array<{ file: number; text: string }> = []
        // Varied prose (no fixed marker to grep for): each file is a different meeting narrative. Budgets are
        // stated in words in one file and revised in a later one, so the model has to read and reason across files.
        const topics = ['the warehouse lease', 'hiring for the support desk', 'the new booking system', 'travel policy', 'the quarterly offsite', 'printer contracts', 'the intern program', 'office plants and cleaning', 'the fire drill schedule', 'the coffee machine vote']
        const people = ['Amara', 'Bruno', 'Celia', 'Dev', 'Elif', 'Farid', 'Greta', 'Hugo', 'Ines', 'Jonas']
        const para = (i: number, j: number): string => {
          const t = topics[(i * 7 + j * 3) % topics.length], a = people[(i + j) % people.length], b = people[(i * 3 + j + 4) % people.length]
          return [`${a} opened the item on ${t} and reminded everyone that nothing had been finalised yet.`, `${b} raised a concern about timing and asked whether ${t} could wait until after the holidays.`, `After some back and forth the group parked ${t} for a later session, with ${a} to circulate notes.`, `${b} shared a short update on ${t}: vendors were contacted, quotes are pending, and no money has been committed.`][(i + j) % 4]
        }
        const words = ['six thousand five hundred', 'thirteen thousand', 'nineteen thousand five hundred', 'twenty-six thousand', 'thirty-two thousand five hundred', 'thirty-nine thousand', 'forty-five thousand five hundred', 'fifty-two thousand']
        const finalBudget: Record<string, number> = {}
        for (let i = 1; i <= 40; i++) {
          const parts = Array.from({ length: 150 }, (_, j) => para(i, j))
          if (i % 5 === 0) {
            const k = i / 5 - 1
            const text = `Before closing, ${people[k]} confirmed on behalf of committee ${String.fromCharCode(65 + k)} that the ${cities[k]} office will work with a yearly allowance of ${words[k]} credits.`
            needles.push({ file: i, text })
            finalBudget[cities[k]] = (k + 1) * 6500
            parts.splice(25 + (i % 90), 0, text)
          }
          // Two later revisions: Osaka's allowance is cut and Cusco's is raised.
          if (i === 33) parts.splice(60, 0, 'One correction to an earlier meeting: the Osaka office allowance is reduced by four thousand credits, effective immediately, after the lease fell through.')
          if (i === 38) parts.splice(100, 0, 'Committee H later agreed that the Cusco office gets an extra three thousand credits on top of what was first approved.')
          writeFileSync(join(dir, `minutes-${String(i).padStart(2, '0')}.md`), `# Minutes, meeting ${i}\n\n${parts.join('\n\n')}\n`)
        }
        finalBudget.Osaka -= 4000
        finalBudget.Cusco += 3000
        log.longctxNeedles = needles
        const r = await run(page, 'Read every file in the archive folder of my workspace, all of them, start to finish (they are long meeting minutes; the important bits are buried in ordinary sentences and some are corrected in later meetings). Then answer: (1) every office allowance that was approved, with the office, the final amount in credits after any later corrections, and the committee; (2) which office ends up with the largest allowance; (3) the sum of all the final allowances. Do not skip files and do not guess.', 40 * 60_000)
        const sum = Object.values(finalBudget).reduce((a, b) => a + b, 0)
        const flat = r.answer.replace(/,/g, '')
        log.longctx = {
          ...r, sum, finalBudget,
          found: Object.entries(finalBudget).map(([city, amt]) => ({ city, amt, ok: r.answer.includes(city) && flat.includes(String(amt)) })),
          sumStated: flat.replace(/\s/g, '').includes(String(sum)),
          largest: /Cusco/.test(r.answer.split(/largest/i)[1] ?? '')
        }
        log.budgetAfterLongctx = await page.evaluate(() => window.foreman.budget())
        save()
      }
      log.budget = await page.evaluate(() => window.foreman.budget())
      log.usage = await page.evaluate(() => (window.foreman as unknown as { usage?: { summary?: () => unknown } }).usage?.summary?.()).catch(() => null)
      await page.screenshot({ path: join(OUT, 'claude-last.png') })
      save()
    } finally {
      // The key leaves the test profile again.
      await page.evaluate(() => window.foreman.settings.set({ setKeys: { anthropic: null } } as never)).catch(() => undefined)
      save()
      await app.close()
      await site.close()
    }
  }, 60 * 60_000)
})
