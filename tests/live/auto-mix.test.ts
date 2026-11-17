import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { describe, expect, test } from 'vitest'
import { expandSteps, launch, tempProfile } from '../accept/app'

// Auto mode on real cloud models through the GUI (hidden window), with BOTH a Claude and an OpenAI key saved:
// which model and effort Auto picks per task, that small tasks stay solo and cheap, that big reports team up
// (across providers when it helps), that the user's decisions are remembered and followed in a later chat,
// and that bots in a group work together. Spend: per-provider caps from the app's own usage ledger
// (MIX_CLAUDE_USD / MIX_OPENAI_USD, default $50 each); a scenario is skipped once either is reached.
// Everything lands in $LIVE_OUT/auto-mix. Only scenarios named in MIX_ONLY run, when set.
const CLAUDE = process.env.ANTHROPIC_LIVE_KEY
const OPENAI = process.env.OPENAI_LIVE_KEY
const OUT = join(process.env.LIVE_OUT ?? tmpdir(), 'auto-mix')
const CAP = { anthropic: Number(process.env.MIX_CLAUDE_USD ?? 50), openai: Number(process.env.MIX_OPENAI_USD ?? 50) }
const ONLY = (process.env.MIX_ONLY ?? '').split(',').filter(Boolean)

type Run = { answer: string; steps: string[]; cards: string[]; ms: number; maxCards: number; error?: string }
type ModelRow = { model: string; provider: string; requests: number; usd: number }

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
      // Never let a test drive the user's other apps (Word, Finder…) or send anything on their behalf.
      const outside = /osascript|tell application|\bopen -a\b|\bopen "|Microsoft|Finder|System Events|computer use|Click at|Type into|send (?:an )?email|Send to|post to/i.test(text)
      cards.push(`${outside ? 'DENIED' : 'approval'}: ${text.slice(0, 200)}`)
      await page.locator(outside ? '[data-testid="approve-deny"]' : '[data-testid="approve-once"]').first().click()
    } else if (await page.locator('[data-testid="purchase-card"], [data-testid="otp-card"]').count()) {
      // Purchases and one-time codes are always the user's: a test never approves one.
      cards.push(`DENIED purchase/code: ${(await page.locator('[data-testid="purchase-card"], [data-testid="otp-card"]').first().innerText()).replace(/\s+/g, ' ').slice(0, 160)}`)
      await page.locator('[data-testid="purchase-deny"], [data-testid="otp-deny"]').first().click()
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
  const r: Run = { answer: bubbles.slice(before).join('\n---\n').slice(0, 8000), steps, cards, ms: Date.now() - t0, maxCards: await page.locator('[data-testid="max-card"], [data-testid="heavy-card"]').count() }
  if (Date.now() - t0 >= timeoutMs) r.error = 'timed out'
  return r
}

describe.skipIf(!CLAUDE || !OPENAI)('live: Auto mode across Claude and OpenAI through the GUI', () => {
  test('small stays solo, big reports team up, decisions are remembered, bots work together', async () => {
    mkdirSync(OUT, { recursive: true })
    const ws = mkdtempSync(join(tmpdir(), 'mix-ws-'))
    const { app, page } = await launch(tempProfile(), '', { FOREMAN_BASE_URL: '', FOREMAN_NO_VERIFY: '', FOREMAN_NO_AUTOTITLE: '' }) // no single-server override: each model goes to its own provider
    const log: Record<string, unknown> = { workspace: ws, scenarios: {} }
    const scen = log.scenarios as Record<string, unknown>
    const save = (): void => writeFileSync(join(OUT, 'log.json'), JSON.stringify(log, null, 2))
    const errors: string[] = []
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)) })
    page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`))
    const procLog = join(OUT, 'app.log')
    writeFileSync(procLog, '')
    app.process().stderr?.on('data', (b: Buffer) => appendFileSync(procLog, b))
    let shot = 0
    const snap = async (name: string): Promise<void> => { await page.screenshot({ path: join(OUT, `${String(++shot).padStart(3, '0')}-${name}.png`) }).catch(() => undefined) }

    const models = async (): Promise<ModelRow[]> => ((await page.evaluate(() => window.foreman.usage.dashboard())) as { byModel: ModelRow[] }).byModel
      .map((m) => ({ model: m.model, provider: m.provider, requests: m.requests, usd: m.usd }))
    const spent = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {}
      for (const m of await models()) out[m.provider] = (out[m.provider] ?? 0) + m.usd
      return out
    }
    const overCap = async (): Promise<string | null> => {
      const s = await spent()
      if ((s.anthropic ?? 0) >= CAP.anthropic) return `Claude cap $${CAP.anthropic} reached`
      if ((s.openai ?? 0) >= CAP.openai) return `OpenAI cap $${CAP.openai} reached`
      return null
    }
    const newChat = async (): Promise<void> => {
      await page.click('[data-testid="main-bot"]').catch(() => undefined)
      await page.keyboard.press('Meta+n').catch(() => undefined)
      await page.waitForSelector('[data-testid="composer-input"]')
      await page.waitForTimeout(500)
    }
    /** One scenario: a fresh chat, the run, and which models it used and what it cost. */
    const scenario = async (name: string, text: string, minutes: number, fresh = true): Promise<Run | null> => {
      if (ONLY.length && !ONLY.includes(name)) return null
      const stop = await overCap()
      if (stop) { scen[name] = { skipped: stop }; save(); return null }
      if (fresh) await newChat()
      const m0 = await models()
      const r = await run(page, text, minutes * 60_000)
      const used = (await models()).map((m) => {
        const b = m0.find((x) => x.model === m.model && x.provider === m.provider)
        return { model: m.model, provider: m.provider, requests: m.requests - (b?.requests ?? 0), usd: +(m.usd - (b?.usd ?? 0)).toFixed(4) }
      }).filter((m) => m.requests > 0)
      scen[name] = { ...r, used, usd: +used.reduce((a, m) => a + m.usd, 0).toFixed(4), providers: [...new Set(used.map((m) => m.provider))] }
      save()
      await snap(name)
      return r
    }

    try {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.evaluate(([c, o, w]) => window.foreman.settings.set({
        setKeys: { anthropic: c as string, openai: o as string }, spendingMode: 'amount', cloudBudgetUsd: 120, workspaceDir: w as string, userName: 'Sahil',
        search: { provider: 'duckduckgo', searxngUrl: '', hasBraveKey: false }
      } as never), [CLAUDE!, OPENAI!, ws])
      await page.reload()
      await page.waitForSelector('[data-testid="composer-input"]')
      await snap('home')

      // 1. Small things: plain chat, solo, a cheap fast model, quick.
      await scenario('chat-hello', 'hi! in two sentences, what can you help me with?', 3)
      await scenario('chat-math', 'What is 17% of 2,340? Just the number and one line of working.', 3)
      await scenario('chat-email', 'Write a quick 3-sentence email to my landlord saying rent will be 2 days late this month. Just give me the text.', 3)
      await scenario('chat-news', 'What did the Federal Reserve decide at its most recent meeting? 3 bullets with sources.', 5)

      // 2. Coding: a real file and a run (Auto should lean on Claude for code).
      await scenario('code-small', 'In my workspace, create wordfreq.py: a function top_words(text, n) returning the n most common words (case-insensitive, ignoring punctuation), plus a few asserts under if __name__ == "__main__". Run it and show me the output.', 10)

      // 3. A decision, then a later chat that should follow it without being told again.
      await scenario('decide', 'A preference for the future: when you make documents for me, always make PDFs (never Word files), and keep the tone casual and short. Got it?', 3)
      await scenario('decide-follow', 'Make me a one-page document on the benefits of a daily 20-minute walk, saved in my workspace.', 10)
      log.filesAfterDecide = readdirSync(ws)

      // 4. A big report: Auto should team up on its own (and may mix providers).
      await scenario('report-big', 'Write a comprehensive market research report on AI medical scribe / note-taking tools for small (1–5 doctor) US practices: the top 8 products, pricing, HIPAA posture (BAA offered?), EHR integrations, standout features, and real user complaints. Use real web sources and cite them. Finish with a recommendation for a 3-doctor family practice. Save it as ai-scribes-report.pdf in my workspace and check it before you finish.', 30)

      // 5. A medium task that should NOT team up (one focused answer).
      await scenario('medium-solo', 'Compare Notion and Obsidian for a solo student taking class notes: 5 bullet points each, then one recommendation.', 5)

      // 6. Bots working together: a group of two bots on one real task.
      if (!ONLY.length || ONLY.includes('group')) {
        const mk = (name: string, job: string) => page.evaluate(([n, j]) => window.foreman.spaces.create({ name: n, intro: false, instructions: j } as never), [name, job])
        const a = await mk('Researcher', 'You research facts on the web and report them with sources.') as { space: { id: string } }
        const b = await mk('Editor', 'You turn research into short, clear writing for busy people.') as { space: { id: string } }
        await page.evaluate((ids) => window.foreman.spaces.create({ kind: 'group', name: 'Desk', members: ids } as never), [a.space.id, b.space.id])
        await page.reload()
        await page.locator('[data-testid="space-item"]', { hasText: 'Desk' }).click()
        await page.waitForSelector('[data-testid="composer-input"]')
        await scenario('group', 'Team: find 3 recent (2026) facts about heat pump adoption in the US with sources, then turn them into a 120-word newsletter blurb.', 15, false)
        log.groupSpeakers = await page.locator('.speaker').allInnerTexts()
      }

      log.spent = await spent()
      log.budget = await page.evaluate(() => window.foreman.budget())
      log.files = readdirSync(ws).map((f) => ({ f, bytes: statSync(join(ws, f)).size }))
      log.memories = await page.evaluate(() => (window.foreman as any).memory?.list?.()).catch(() => null)
      await page.evaluate(() => window.foreman.settings.set({ theme: 'dark' } as never))
      await page.waitForTimeout(800)
      await snap('end-dark')
    } finally {
      await page.evaluate(() => window.foreman.settings.set({ setKeys: { anthropic: null, openai: null } } as never)).catch(() => undefined)
      log.consoleErrors = errors
      save()
      // A sleeping Mac breaks the page connection: make sure the app never keeps working (and spending) on its own.
      await app.close().catch(() => undefined)
      try { app.process().kill() } catch { /* already gone */ }
    }
  }, 120 * 60_000)
})
