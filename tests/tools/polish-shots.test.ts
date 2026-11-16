// Dev helper (design polish): every screen in light and dark, at 1280×800 and 900×600, against the
// mock model. Hidden window. SHOTS_DIR=<dir> SAHILBOT_HIDDEN=1 npx vitest run --config vitest.tools.config.mts tests/tools/polish-shots.test.ts
// Optional: ONLY=<comma list of screen-name prefixes> to shoot a subset.
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { test } from 'vitest'
import { expandSteps, launch, tempProfile } from '../accept/app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

const out = process.env.SHOTS_DIR ?? join(tmpdir(), 'polish-shots')
mkdirSync(out, { recursive: true })
const SIZES = [{ w: 1280, h: 800 }, { w: 900, h: 600 }] as const
const only = (process.env.ONLY ?? '').split(',').map((x) => x.trim()).filter(Boolean)
const errors: string[] = []

const wait = (page: Page, ms: number): Promise<void> => page.waitForTimeout(ms)

/** Light + dark at both sizes. `prep` runs after each resize (e.g. to scroll). */
async function shoot(page: Page, name: string, opts: { sizes?: ReadonlyArray<{ w: number; h: number }>; prep?: () => Promise<void> } = {}): Promise<void> {
  if (only.length && !only.some((o) => name.startsWith(o))) return
  for (const s of opts.sizes ?? SIZES) {
    await page.setViewportSize({ width: s.w, height: s.h })
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await wait(page, 220)
      if (opts.prep) await opts.prep().catch(() => undefined)
      await page.screenshot({ path: `${out}/${name}-${scheme}-${s.w}.png` })
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: SIZES[0].w, height: SIZES[0].h })
}

/** Runs a step; a failure is recorded (and a screenshot kept) but doesn't stop the sweep. */
async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn() } catch (e) {
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
const scrollThread = (page: Page, to: 'top' | 'bottom' | number) => page.evaluate((t) => {
  const el = document.querySelector('.thread-scroll') as HTMLElement | null
  if (!el) return
  el.style.scrollBehavior = 'auto'
  el.scrollTop = t === 'top' ? 0 : t === 'bottom' ? el.scrollHeight : t
}, to)

const LONG_ANSWER = `## Pricing comparison

Here's how the three plans stack up for a **5-person team**. I checked each vendor's pricing page today, and the numbers below are per month, billed annually.

### At a glance

| Plan | Price / seat | Storage | SSO | Best for |
| --- | ---: | --- | :---: | --- |
| Starter | $8 | 100 GB | — | Solo or tiny teams |
| Team | $15 | 1 TB | ✓ | Most small teams |
| Business | $24 | Unlimited | ✓ | Compliance-heavy work |

### What I'd pick

1. **Team** is the best value: SSO and 1 TB for $75/month total.
2. **Starter** only makes sense if nobody needs shared drives.
3. **Business** adds audit logs and retention rules, which you said you don't need yet.

A few things to keep in mind:

- Annual billing saves about 17% versus monthly.
- Seats can be added mid-year and are prorated.
- The free trial is 14 days and doesn't need a card.

> Prices change often; I'd re-check before you buy.

### Quick estimate script

\`\`\`ts
const seats = 5
const plans = { starter: 8, team: 15, business: 24 }
for (const [name, price] of Object.entries(plans)) {
  console.log(\`\${name}: $\${price * seats}/month, $\${price * seats * 12}/year\`)
}
\`\`\`

Run it with \`npx tsx estimate.ts\` and you'll get the monthly and yearly totals for each plan. Let me know if you want me to draft the purchase request for **Team**.`

test('polish screenshots', async () => {
  const llm = await startMockLlm()

  // ---------- onboarding (fresh profile, no model server) ----------
  if (!only.length || only.some((o) => 'onboarding'.startsWith(o) || o.startsWith('onboarding'))) {
    const { app, page } = await launch(tempProfile(), '', { FOREMAN_BASE_URL: '', FOREMAN_SKIP_ONBOARDING: '' })
    await page.waitForSelector('[data-testid="onboarding"]')
    await step(page, 'onboarding', async () => {
      await shoot(page, 'onboarding-1-name')
      await page.fill('[data-testid="onboarding-name"]', 'Sahil')
      await page.keyboard.press('Enter')
      await wait(page, 1500)
      await shoot(page, 'onboarding-2-models')
      await page.click('[data-testid="onboarding-next"]')
      await wait(page, 400)
      await shoot(page, 'onboarding-3-ready')
    })
    await app.close()
  }

  // ---------- main app ----------
  const profile = tempProfile()
  const workspace = mkdtempSync(join(tmpdir(), 'polish-ws-'))
  const { app, page } = await launch(profile, llm.url, { FOREMAN_RAM_GB: '64' })
  await page.evaluate((ws) => (window as any).foreman.settings.set({ userName: 'Sahil Patel', workspaceDir: ws }), workspace)
  await page.reload()
  await page.waitForSelector('[data-testid="composer-input"]')
  await page.setViewportSize({ width: 1280, height: 800 })
  await wait(page, 600)

  await step(page, 'home-empty', () => shoot(page, 'home-empty'))

  // Seed bots: pinned widgets, long names, hidden bots, a group and a project.
  await page.evaluate(async () => {
    const api = (window as any).foreman
    const mk = async (name: string, color: string, shape?: string) => (await api.spaces.create({ name, color, shape, intro: false })).space
    const main = (await api.spaces.list()).find((s: any) => s.isMain)
    const coach = await mk('Study Coach', '#5b8def', 'circle')
    const chef = await mk("Grandma's Recipe Organizer and Weekly Meal Planner", '#30a46c', 'square')
    const fit = await mk('Fitness', '#e5484d', 'triangle')
    const robo = await mk('Robotics Team Captain', '#8e4ec6')
    const inbox = await mk('Inbox Zero', '#f5a524')
    const h1 = await mk('Old Tax Helper 2023', '#888888')
    const h2 = await mk('A very long hidden bot name that should truncate cleanly', '#0ea5e9')
    await api.spaces.update(h1.id, { hidden: true })
    await api.spaces.update(h2.id, { hidden: true })
    await api.spaces.create({ name: 'Weekend crew', kind: 'group', members: [coach.id, fit.id, robo.id], intro: false })
    await api.spaces.create({ name: 'Vantage app', kind: 'project', color: '#5856d6', intro: false }).catch(() => undefined) // needs the folder picker
    await api.settings.set({ pinnedBots: [main.id, coach.id, fit.id, chef.id] })
    void inbox
    // Memory, passwords, approval rules for the Settings pages.
    for (const m of ['Prefers short, direct answers', 'Lives in Atlanta, GA', 'Works on the Vantage iOS app with a team of four', 'Always ask before sending email', 'Daughter Maya plays violin on Tuesdays']) await api.memory.add(m, null)
    await api.memory.add('Uses the AP Calculus BC syllabus from Ms. Rivera', coach.id)
    await api.vault.set({ name: 'GitHub', origin: 'https://github.com', username: 'sahil-patel-2011', password: 'x-test-only' })
    await api.vault.set({ name: 'School portal', origin: 'https://portal.example.edu', username: 'spatel@student.example.edu', password: 'x-test-only' })
    await api.settings.set({ customRules: [
      { id: 'r1', when: 'send email', action: 'ask' },
      { id: 'r2', when: 'click Buy', action: 'ask' },
      { id: 'r3', when: 'npm install', action: 'allow' },
      { id: 'r4', when: 'tool:run_command git status', action: 'allow' }
    ] })
  })
  await page.reload()
  await page.waitForSelector('[data-testid="composer-input"]')
  await wait(page, 800)

  // ---------- main chat: long markdown + tool activity + plan ----------
  await step(page, 'chat', async () => {
    llm.script.push(
      { toolCalls: [{ name: 'todo', arguments: '{"items":[{"text":"Find the latest pricing","status":"done"},{"text":"Compare the three plans","status":"done"},{"text":"Write a short summary","status":"done"}]}' }] },
      { toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path: 'pricing-notes.md', content: '# Notes\n- Team plan $15' }) }] },
      { toolCalls: [{ name: 'file_read', arguments: '{"path":"pricing-notes.md"}' }] },
      { content: LONG_ANSWER, delay: 1 }
    )
    await send(page, 'Compare the Starter, Team and Business plans for my 5-person team and tell me which to buy')
    await idle(page, llm)
    await shoot(page, 'chat-long-top', { prep: () => scrollThread(page, 'top') })
    await shoot(page, 'chat-long-bottom', { prep: () => scrollThread(page, 'bottom') })
    await expandSteps(page).catch(() => undefined)
    await shoot(page, 'chat-tools-open', { prep: () => scrollThread(page, 'top') })
  })

  await step(page, 'approval', async () => {
    await page.click('[data-testid="model-picker"]')
    await page.click('[data-testid="mode-picker"]')
    await page.click('[data-testid="mode-ask"]')
    llm.script.push(
      { content: 'I\'ll save the summary next to your notes.', toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path: 'team-plan-summary.md', content: '# Team plan\nBest value for 5 people: $75/month.' }) }] },
      { content: 'Okay, I left it unsaved.' }
    )
    await send(page, 'Save that summary to a file')
    await page.locator('[data-testid="approval-card"]').waitFor({ timeout: 15_000 })
    await wait(page, 400)
    await shoot(page, 'chat-approval', { prep: () => scrollThread(page, 'bottom') })
    await page.click('[data-testid="approve-deny"]')
    await idle(page, llm)
  })

  await step(page, 'question', async () => {
    llm.script.push(
      { content: 'Happy to draft it.', toolCalls: [{ name: 'ask_user', arguments: '{"question":"Who should the purchase request go to?","options":["My manager","Finance team","IT department","Someone else"]}' }] },
      { content: 'Got it — drafting it for your manager now.' }
    )
    await send(page, 'Draft the purchase request')
    await page.locator('[data-testid="question-card"]').waitFor({ timeout: 15_000 })
    await wait(page, 400)
    await shoot(page, 'chat-question', { prep: () => scrollThread(page, 'bottom') })
    await page.locator('[data-testid="question-card"] button', { hasText: 'My manager' }).click()
    await idle(page, llm)
  })

  await step(page, 'plan-first', async () => {
    llm.script.push(
      { toolCalls: [{ name: 'ask_user', arguments: JSON.stringify({ questions: [{ question: 'Who is this for?', options: ['Patients', 'Referring doctors', 'Staff'] }, { question: 'Which format do you want?', options: ['Email newsletter', 'Blog post', 'PDF handout'] }, { question: 'Anything it must mention?' }] }) }] },
      { toolCalls: [{ name: 'propose_plan', arguments: JSON.stringify({ goal: 'A 300-word patient email newsletter about treating an enlarged prostate, in plain words, ready for review.', steps: ['Check the current AUA guidance and MedlinePlus', 'Outline: what BPH is, treatment options, when to call us', 'Write the draft (about 300 words, 7th-grade reading level)', 'Fact-check every claim against the sources', 'Save it as a Word document and summarize the key points'], assumptions: ['Sent by email to existing patients', 'Signed by the practice'], risks: ['Medical claims need a physician\'s review before sending'] }) }] }
    )
    // Its own chat, so the plan waiting for approval doesn't follow the other screens around.
    await page.click('[data-testid="new-chat"]')
    await wait(page, 300)
    await page.click('[data-testid="modes-menu"]')
    await page.click('[data-testid="plan-toggle"]')
    await send(page, 'Write this month\'s patient newsletter')
    await page.locator('[data-testid="questions-card"]').waitFor({ timeout: 15_000 })
    await page.locator('[data-testid="qcard-option"]', { hasText: 'Patients' }).click()
    await wait(page, 300)
    await shoot(page, 'chat-questions', { prep: () => scrollThread(page, 'bottom') })
    await page.locator('[data-testid="qcard-option"]', { hasText: 'Email newsletter' }).click()
    await page.locator('[data-testid="qcard-send"]').click()
    await page.locator('[data-testid="plan-approval"]').waitFor({ timeout: 15_000 })
    await wait(page, 400)
    await shoot(page, 'chat-plan-approval', { prep: () => scrollThread(page, 'bottom') })
  })

  // Side panel (progress) on the main chat.
  await step(page, 'panel', async () => {
    await page.click('[data-testid="toggle-panel"]')
    await wait(page, 500)
    await shoot(page, 'chat-panel-progress')
    await page.click('[data-testid="toggle-panel"]')
  })

  // ---------- sidebar with bots ----------
  await step(page, 'sidebar', async () => {
    await page.click('[data-testid="hidden-bots"]')
    await wait(page, 300)
    await shoot(page, 'sidebar-bots', { prep: () => page.evaluate(() => { const s = document.querySelector('.side-scroll'); if (s) s.scrollTop = s.scrollHeight }) })
    await page.click('[data-testid="hidden-bots"]')
  })

  // ---------- a bot with routines ----------
  await step(page, 'bot', async () => {
    await page.locator('[data-testid="main-bot"], [data-testid="space-item"]', { hasText: 'Study Coach' }).first().click()
    await wait(page, 600)
    await shoot(page, 'bot-empty-chat')
    llm.script.push({ toolCalls: [{ name: 'schedule', arguments: JSON.stringify({ action: 'create', title: 'Weekday school reminder', prompt: 'Check what is due today in my classes and remind me.', when: { type: 'cron', expr: '0 7 * * 1-5' } }) }] })
    llm.script.push({ content: 'Done. I\'ll check your classes every weekday at 7:00 AM. See [the class page](https://example.com/classes).' })
    await send(page, 'remind me every weekday morning what is due')
    await idle(page, llm)
    await page.evaluate(async () => {
      const api = (window as any).foreman
      const coach = (await api.spaces.list()).find((s: any) => s.name === 'Study Coach')
      const t = await api.schedules.create({ title: 'Friday reading log with a deliberately long routine name', prompt: 'Ask me what I read this week and log it.', schedule: { type: 'weekly', days: ['fri'], time: '16:00' }, spaceId: coach.id })
      await api.schedules.update(t.id, { enabled: false })
      const first = (await api.schedules.list()).find((x: any) => x.title === 'Weekday school reminder')
      if (first) await api.schedules.runNow(first.id)
    })
    await wait(page, 2500)
    await shoot(page, 'bot-chat', { prep: () => scrollThread(page, 'bottom') })
    await page.click('[data-testid="bot-pill"]')
    await page.waitForSelector('[data-testid="bot-details"]')
    await wait(page, 500)
    await shoot(page, 'bot-details')
    await page.locator('[data-testid="routine-menu"]').first().click()
    await wait(page, 200)
    await shoot(page, 'bot-routine-menu', { sizes: [SIZES[0]] })
    await page.keyboard.press('Escape')
    await page.locator('[data-testid="routine-row"] .rt-main').first().click()
    await page.waitForSelector('[data-testid="routine-history"]')
    await wait(page, 300)
    await shoot(page, 'bot-routine-detail')
    await page.click('[data-testid="routine-back"]')
    await page.click('[data-testid="bot-tab-library"]')
    await wait(page, 500)
    await shoot(page, 'bot-library')
    await page.click('[data-testid="bot-tab-details"]')
    await page.keyboard.press('Escape')
  })

  // Main bot details (no routines: empty state).
  await step(page, 'main-details', async () => {
    await page.click('[data-testid="main-bot"]')
    await wait(page, 400)
    await page.locator('[data-testid="thread-item"]').first().click()
    await wait(page, 500)
    await page.click('[data-testid="bot-pill"]')
    await page.waitForSelector('[data-testid="bot-details"]')
    await wait(page, 400)
    await shoot(page, 'main-details-empty')
    await page.keyboard.press('Escape')
  })

  // ---------- Connect apps ----------
  await step(page, 'connect', async () => {
    await page.locator('[data-testid="connect-apps"]').first().click()
    await wait(page, 3500)
    await shoot(page, 'connect-browse')
    await shoot(page, 'connect-browse-scrolled', { prep: () => page.locator('.ca-body').evaluate((el) => el.scrollTo({ top: 900 })) })
    await page.click('.ca-chip:has-text("More")')
    await wait(page, 250)
    await shoot(page, 'connect-more', { sizes: [SIZES[0]] })
    await page.keyboard.press('Escape')
    if (!(await page.locator('[data-testid="conn-search"]').count())) await page.locator('[data-testid="connect-apps"]').first().click()
    await page.fill('[data-testid="conn-search"]', 'pdf')
    await wait(page, 250)
    await shoot(page, 'connect-search')
    await page.fill('[data-testid="conn-search"]', 'zzzz no such app')
    await wait(page, 250)
    await shoot(page, 'connect-search-empty', { sizes: [SIZES[0]] })
    await page.fill('[data-testid="conn-search"]', '')
    await page.click('[data-testid="bot-templates"]')
    await wait(page, 400)
    await shoot(page, 'connect-templates')
    await page.click('.ca-back')
    await page.click('[data-testid="connected-count"]')
    await wait(page, 400)
    await shoot(page, 'connect-manage')
    await page.keyboard.press('Escape')
  })

  // ---------- Settings ----------
  await step(page, 'settings', async () => {
    await page.keyboard.press('Meta+,')
    await page.waitForSelector('[data-testid="settings"]')
    for (const p of ['general', 'models', 'keys', 'appearance', 'voice', 'memory', 'rules', 'approvals', 'passwords', 'advanced']) {
      await page.click(`[data-testid="settings-${p}"]`)
      await wait(page, 400)
      await shoot(page, `settings-${p}`)
    }
    await page.click('[data-testid="settings-memory"]')
    await page.click('[data-testid="memory-import-open"]').catch(() => undefined)
    await wait(page, 300)
    await shoot(page, 'settings-memory-import', { sizes: [SIZES[0]] })
    await page.click('[data-testid="settings-close"]')
  })

  // ---------- Scheduled ----------
  await step(page, 'scheduled', async () => {
    await page.click('[data-testid="nav-scheduled"]')
    await page.waitForSelector('[data-testid="scheduled"]')
    await wait(page, 400)
    await shoot(page, 'scheduled')
    await page.click('[data-testid="schedule-new"]')
    await wait(page, 300)
    await shoot(page, 'scheduled-new', { sizes: [SIZES[0]] })
    await page.keyboard.press('Escape')
  })

  // ---------- ⌘K palette ----------
  await step(page, 'palette', async () => {
    await page.keyboard.press('Meta+k')
    await page.waitForSelector('[data-testid="palette"]')
    await wait(page, 250)
    await shoot(page, 'palette')
    await page.fill('[data-testid="palette-input"]', 'study')
    await wait(page, 200)
    await shoot(page, 'palette-search', { sizes: [SIZES[0]] })
    await page.keyboard.press('Escape')
  })

  // ---------- Bot editor ----------
  await step(page, 'editor', async () => {
    await page.click('[data-testid="new-bot"]')
    await wait(page, 400)
    await shoot(page, 'bot-editor')
    await page.keyboard.press('Escape')
    await wait(page, 200)
  })

  // ---------- Projects / Files ----------
  await step(page, 'views', async () => {
    await page.click('[data-testid="nav-projects"]')
    await wait(page, 400)
    await shoot(page, 'view-projects')
    await page.click('[data-testid="nav-files"]')
    await wait(page, 400)
    await shoot(page, 'view-files')
  })

  // ---------- Home with ideas, toasts ----------
  await step(page, 'home', async () => {
    await page.click('[data-testid="main-bot"]')
    await wait(page, 400)
    await shoot(page, 'home-populated')
  })

  await step(page, 'toasts', async () => {
    await page.keyboard.press('Meta+,')
    await page.click('[data-testid="settings-approvals"]')
    await page.fill('[data-testid="rule-when"]', 'delete files')
    await page.click('[data-testid="rule-add"]')
    await page.waitForSelector('.toast.ok', { timeout: 5000 })
    await page.fill('[data-testid="rule-when"]', 'send email')
    await page.selectOption('[data-testid="rule-action"]', 'ask')
    await page.click('[data-testid="rule-add"]')
    await page.waitForSelector('.toast.error', { timeout: 5000 })
    await wait(page, 200)
    await shoot(page, 'toasts', { sizes: [SIZES[0]] })
    await page.click('[data-testid="settings-close"]')
  })

  await step(page, 'error-reply', async () => {
    llm.script.push({ status: 400 })
    await send(page, 'this one fails')
    await wait(page, 1500)
    await shoot(page, 'chat-error', { sizes: [SIZES[0]] })
  })

  // ---------- Voice mode ----------
  await step(page, 'voice', async () => {
    await page.keyboard.press('Meta+Shift+v')
    await page.waitForSelector('[data-testid="voice-mode"]')
    await wait(page, 800)
    await shoot(page, 'voice-mode')
    await page.click('[data-testid="voice-end"]')
  })

  // ---------- Quick Ask ----------
  await step(page, 'quick', async () => {
    llm.script.push({ content: '**Tamsulosin** is an alpha-blocker used for BPH symptoms. Common side effects are dizziness and abnormal ejaculation; take it 30 minutes after the same meal each day.\n\nSources: FDA label [1]' })
    await page.evaluate(() => { location.hash = '#quick' })
    await page.reload()
    await page.waitForSelector('[data-testid="quick-input"]')
    await shoot(page, 'quick-empty', { sizes: [{ w: 720, h: 120 }] })
    await page.fill('[data-testid="quick-input"]', 'what is tamsulosin for?')
    await page.keyboard.press('Enter')
    await wait(page, 2500)
    await shoot(page, 'quick-answer', { sizes: [{ w: 720, h: 320 }] })
  })

  await app.close()
  await llm.close()
  if (errors.length) console.log(`Steps that failed:\n${errors.join('\n')}`)
  console.log(`Screenshots in ${out}`)
}, 900_000)
