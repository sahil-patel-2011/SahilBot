// Dev helper (finishing pass): the surfaces the performance + polish pass touched, light and dark, at
// 1280×800 and the 900×600 minimum window. Hidden window, mock model.
//   npm run build && SHOTS_DIR=<dir> SAHILBOT_HIDDEN=1 npx vitest run --config vitest.tools.config.mts tests/tools/finish-shots.test.ts --silent=false
// Covers: composer at narrow widths (no wrapped send button), the context gauge, Heavy / Team chips,
// the model picker's Auto entries, QuestionCard (options + type your own), plan approval, the bot
// details panel (a split chunk), the docs editor (a split chunk), the Jobs/Overview panel, Settings
// (Models, Knowledge, Privacy & Permissions) and stacked/deduped toasts. The long-chat window ("show
// earlier") has its own shots in long-thread-perf.test.ts. Failed steps are listed at the end and leave a zz-fail-*.png.
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { test } from 'vitest'
import { launch, tempProfile } from '../accept/app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

const out = process.env.SHOTS_DIR ?? join(tmpdir(), 'finish-shots')
mkdirSync(out, { recursive: true })
const SIZES = [{ w: 1280, h: 800 }, { w: 900, h: 600 }] as const
const errors: string[] = []
const wait = (page: Page, ms: number): Promise<void> => page.waitForTimeout(ms)

async function shoot(page: Page, name: string, sizes: ReadonlyArray<{ w: number; h: number }> = SIZES, prep?: () => Promise<void>): Promise<void> {
  for (const s of sizes) {
    await page.setViewportSize({ width: s.w, height: s.h })
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await wait(page, 220)
      if (prep) await prep().catch(() => undefined)
      await page.screenshot({ path: `${out}/${name}-${scheme}-${s.w}.png` })
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: SIZES[0].w, height: SIZES[0].h })
}

async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  // A hidden window occasionally stops answering (no new frames); a stuck step fails after a minute.
  const stuck = (): Promise<never> => new Promise((_, no) => setTimeout(() => no(new Error('step took over 60 s')), 60_000))
  try { await Promise.race([fn(), stuck()]) } catch (e) {
    errors.push(`${name}: ${(e as Error).message.split('\n')[0]}`)
    await page.screenshot({ path: `${out}/zz-fail-${name}.png` }).catch(() => undefined)
    await page.keyboard.press('Escape').catch(() => undefined)
  }
}

const send = async (page: Page, text: string): Promise<void> => {
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
}
const idle = async (page: Page, llm: MockLlm, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms
  while (Date.now() < end && (llm.script.length || (await page.locator('[data-testid="stop"]').count()))) await wait(page, 150)
  await wait(page, 300)
}
const bottom = (page: Page) => page.evaluate(() => { const el = document.querySelector('.thread-scroll') as HTMLElement | null; el?.scrollTo({ top: el.scrollHeight, behavior: 'instant' }) })
const call = (name: string, args: unknown) => ({ toolCalls: [{ name, arguments: JSON.stringify(args) }] })

test('finishing-pass screenshots', async () => {
  const llm = await startMockLlm()
  const workspace = mkdtempSync(join(tmpdir(), 'finish-ws-'))
  const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
  await page.evaluate((ws) => (window as any).foreman.settings.set({ userName: 'Sahil Patel', workspaceDir: ws }), workspace)
  await page.reload()
  await page.waitForSelector('[data-testid="composer-input"]')
  // A missing element fails its step (and the sweep goes on) instead of waiting forever.
  page.setDefaultTimeout(15_000)
  await wait(page, 500)

  await step(page, 'home', async () => {
    await page.fill('[data-testid="composer-input"]', 'Compare three plans')
    await shoot(page, 'home-composer')
    await page.fill('[data-testid="composer-input"]', '')
  })

  await step(page, 'model-picker', async () => {
    await page.click('[data-testid="model-picker"]')
    await wait(page, 250)
    await shoot(page, 'model-picker-auto', [SIZES[0]])
    await page.keyboard.press('Escape')
  })

  await step(page, 'chat', async () => {
    llm.script.push(
      call('todo', { items: [{ text: 'Find the latest pricing', status: 'done' }, { text: 'Compare the plans', status: 'done' }, { text: 'Write a summary', status: 'done' }] }),
      { content: '## Summary\n\nThe **Team** plan is the best value for five people: SSO and 1 TB for $75/month.\n\n| Plan | Price / seat |\n| --- | ---: |\n| Starter | $8 |\n| Team | $15 |\n| Business | $24 |' }
    )
    await send(page, 'Compare the Starter, Team and Business plans for my 5-person team')
    await idle(page, llm)
    await shoot(page, 'chat-gauge', SIZES, () => bottom(page))
  })

  await step(page, 'question', async () => {
    // The first question of a task, before any research, is sent back once ("research first"): ask twice.
    const ask = { content: 'Happy to draft it.', toolCalls: [{ name: 'ask_user', arguments: '{"question":"Who should the purchase request go to?","options":["My manager","Finance team","IT department"]}' }] }
    llm.script.push(ask, ask, { content: 'Got it — drafting it for your manager now.' })
    await send(page, 'Draft the purchase request')
    await page.locator('[data-testid="question-card"]').waitFor({ timeout: 15_000 })
    await wait(page, 300)
    await shoot(page, 'chat-question', SIZES, () => bottom(page))
    await page.locator('[data-testid="question-card"] .question-option', { hasText: 'My manager' }).first().click()
    await idle(page, llm)
  })

  await step(page, 'plan-approval', async () => {
    // Gates may send the first proposal back (e.g. research first); offer it until the card shows.
    const plan = call('propose_plan', { goal: 'A one-page purchase request for the Team plan, ready to send.', steps: ['Collect the pricing', 'Write the request', 'Save it as a Word document'], assumptions: ['Addressed to your manager'], risks: ['Prices may change before approval'] })
    llm.script.push(plan, plan, plan)
    await page.click('[data-testid="modes-menu"]')
    await page.click('[data-testid="plan-toggle"]')
    await send(page, 'Write the request as a document')
    await page.locator('[data-testid="plan-approval"]').waitFor({ timeout: 15_000 })
    await wait(page, 300)
    await shoot(page, 'chat-plan-approval', SIZES, () => bottom(page))
    await page.locator('[data-testid="stop"]').click().catch(() => undefined)
    llm.script.length = 0
    await idle(page, llm)
  })

  await step(page, 'heavy-chip', async () => {
    await page.click('[data-testid="modes-menu"]')
    await page.click('[data-testid="heavy-toggle"]')
    await shoot(page, 'composer-heavy-on')
    await page.click('[data-testid="modes-menu"]')
    await page.click('[data-testid="heavy-toggle"]')
  })

  await step(page, 'panel', async () => {
    await page.click('[data-testid="toggle-panel"]')
    await page.locator('[data-testid="tab-progress"]').waitFor()
    await shoot(page, 'panel-overview')
    await page.click('[data-testid="toggle-panel"]')
  })

  await step(page, 'doc', async () => {
    llm.script.push(
      call('doc_create', { title: 'Purchase request', markdown: '# Purchase request\n\nWe would like the **Team** plan for five people.\n\n- $15 per seat per month\n- SSO and 1 TB of storage\n\n## Why\n\nIt is the best value for a team our size.' }),
      { content: 'I drafted the request beside the chat.' }
    )
    await send(page, 'Draft it as a live document')
    await idle(page, llm)
    await page.locator('[data-testid="doc-editor"]').waitFor({ timeout: 15_000 })
    await wait(page, 400)
    await shoot(page, 'doc-editor')
    await page.click('[data-testid="toggle-panel"]').catch(() => undefined)
  })

  await step(page, 'toasts', async () => {
    // Through the app: save the same approval rule twice (an "already saved" error) and once more (a repeat).
    await page.keyboard.press('Meta+,')
    await page.waitForSelector('[data-testid="settings"]')
    await page.click('[data-testid="settings-approvals"]')
    await wait(page, 300)
    const input = page.locator('.ar-form textarea, .ar-form input').first()
    for (let i = 0; i < 3; i++) {
      await input.fill('send email')
      await page.locator('.ar-form .btn.primary, .ar-form button', { hasText: 'Add rule' }).first().click()
      await wait(page, 150)
    }
    await shoot(page, 'toasts-stacked', [SIZES[0]])
    await page.click('[data-testid="settings-close"]')
  })

  await step(page, 'palette', async () => {
    await page.keyboard.press('Meta+k')
    await page.waitForSelector('[data-testid="palette"]')
    await page.fill('[data-testid="palette-input"]', 'shortcuts')
    await wait(page, 200)
    await shoot(page, 'palette-shortcuts', [SIZES[0]])
    await page.keyboard.press('Escape')
  })

  await step(page, 'settings', async () => {
    await page.keyboard.press('Meta+,')
    await page.waitForSelector('[data-testid="settings"]')
    for (const p of ['models', 'knowledge', 'privacy']) {
      await page.click(`[data-testid="settings-${p}"]`)
      await wait(page, 400)
      await shoot(page, `settings-${p}`)
    }
    await page.click('[data-testid="settings-close"]')
  })

  await step(page, 'bot-details', async () => {
    await page.locator('[data-testid="thread-item"]').first().click()
    await wait(page, 400)
    await page.click('[data-testid="bot-pill"]')
    await page.waitForSelector('[data-testid="bot-details"]')
    await wait(page, 400)
    await shoot(page, 'bot-details-panel')
    await page.keyboard.press('Escape')
  })

  await app.close()
  await llm.close()
  if (errors.length) console.log(`Steps that failed:\n${errors.join('\n')}`)
  console.log(`Screenshots in ${out}`)
}, 600_000)
