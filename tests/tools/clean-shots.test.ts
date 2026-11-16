// Dev helper (UI cleanup pass): every surface the last round of features added, light and dark, at 1280 and
// 900 wide, against the mock model, fake Onshape and the local test site. Hidden window; no paid calls.
//   npm run build && SHOTS_DIR=<dir> SAHILBOT_HIDDEN=1 npx vitest run --config vitest.tools.config.mts tests/tools/clean-shots.test.ts --silent=false
// Optional: ONLY=<comma list of shot-name prefixes>. Cards are shot as elements (`card-*`), screens as the window.
// Failed steps are listed at the end and leave a zz-fail-*.png.
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright'
import { test } from 'vitest'
import { launch, tempProfile } from '../accept/app'
import { lastToolOutput, refFor, startMockLlm, type MockLlm, type ScriptedReply } from '../fixtures/mock-llm'
import { startTestSite } from '../fixtures/test-site'
import { FAKE_KEYS, startFakeOnshape } from '../fixtures/fake-onshape'
import { seedUsage } from '../fixtures/usage-seed'

const out = process.env.SHOTS_DIR ?? join(tmpdir(), 'clean-shots')
mkdirSync(out, { recursive: true })
const SIZES = [{ w: 1280, h: 800 }, { w: 900, h: 640 }] as const
const only = (process.env.ONLY ?? '').split(',').map((x) => x.trim()).filter(Boolean)
const errors: string[] = []
const wait = (page: Page, ms: number): Promise<void> => page.waitForTimeout(ms)
const want = (name: string): boolean => !only.length || only.some((o) => name.startsWith(o))

/** The window, light and dark, at both widths. `prep` runs after each resize (scrolling, etc.). */
async function shoot(page: Page, name: string, prep?: () => Promise<unknown>, sizes: ReadonlyArray<{ w: number; h: number }> = SIZES): Promise<void> {
  if (!want(name)) return
  for (const s of sizes) {
    await page.setViewportSize({ width: s.w, height: s.h })
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await wait(page, 200)
      if (prep) await prep().catch(() => undefined)
      await page.screenshot({ path: `${out}/${name}-${scheme}-${s.w}.png` })
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: SIZES[0].w, height: SIZES[0].h })
}

/** One element (a card), light and dark, at both window widths. */
async function shootEl(page: Page, name: string, el: Locator): Promise<void> {
  if (!want(name)) return
  for (const s of SIZES) {
    await page.setViewportSize({ width: s.w, height: s.h })
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await wait(page, 180)
      await el.scrollIntoViewIfNeeded().catch(() => undefined)
      await el.screenshot({ path: `${out}/${name}-${scheme}-${s.w}.png` })
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: SIZES[0].w, height: SIZES[0].h })
}

/** A long settings page in one tall shot per theme and width (to judge its hierarchy). */
async function shootTall(page: Page, name: string): Promise<void> {
  if (!want(name)) return
  for (const w of [1280, 900]) {
    const h = await page.evaluate(() => {
      const b = document.querySelector('.set-body') as HTMLElement | null
      return b ? b.scrollHeight + 40 : 1600
    })
    await page.setViewportSize({ width: w, height: Math.min(4000, Math.max(800, h)) })
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await wait(page, 250)
      await page.screenshot({ path: `${out}/${name}-${scheme}-${w}.png` })
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: SIZES[0].w, height: SIZES[0].h })
}

async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  const stuck = (): Promise<never> => new Promise((_, no) => setTimeout(() => no(new Error('step took over 90 s')), 90_000))
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
const idle = async (page: Page, llm: MockLlm, ms = 25_000): Promise<void> => {
  const end = Date.now() + ms
  while (Date.now() < end && (llm.script.length || (await page.locator('[data-testid="stop"]').count()))) await wait(page, 150)
  await wait(page, 300)
}
const bottom = (page: Page) => page.evaluate(() => { const el = document.querySelector('.thread-scroll') as HTMLElement | null; if (el) { el.style.scrollBehavior = 'auto'; el.scrollTop = el.scrollHeight } })
const call = (name: string, args: unknown): ScriptedReply => ({ toolCalls: [{ name, arguments: JSON.stringify(args) }], delay: 0 })
const sys = (r: Record<string, any>): string => String(r.messages?.[0]?.content ?? '')
const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? '').join(' ') : '')
const lastUser = (r: Record<string, any>): string => textOf([...r.messages].reverse().find((m: any) => m.role === 'user')?.content)
const route = (llm: MockLlm, fn: (r: Record<string, any>) => ScriptedReply): void => { for (let i = 0; i < 200; i++) llm.script.push(fn as never) }
const openBot = async (page: Page, name: string): Promise<void> => {
  await page.locator('[data-testid="space-item"]', { hasText: name }).first().click()
  await page.waitForFunction((n) => document.querySelector('[data-testid="bot-pill"]')?.textContent?.includes(n), name, { timeout: 10_000 })
  await wait(page, 300)
}
const settingsPage = async (page: Page, id: string): Promise<void> => {
  if (!(await page.locator('[data-testid="settings"]').count())) { await page.keyboard.press('Meta+,'); await page.waitForSelector('[data-testid="settings"]') }
  await page.click(`[data-testid="settings-${id}"]`)
  await wait(page, 500)
}

test('cleanup-pass screenshots', async () => {
  const llm = await startMockLlm()

  // ================================================================ main app: chat cards, settings, views
  {
    llm.models = ['qwen3.8:27b', 'llama3.3:70b', 'claude-opus-5-5', 'gpt-6.1-sol', 'grok-4.7']
    const dir = tempProfile()
    seedUsage(dir)
    const ws = mkdtempSync(join(tmpdir(), 'clean-ws-'))
    const { app, page } = await launch(dir, llm.url, { FOREMAN_RAM_GB: '64' })
    page.setDefaultTimeout(15_000)
    await page.evaluate(async (w) => {
      const api = (window as any).foreman
      await api.settings.set({ userName: 'Sahil Patel', workspaceDir: w, setKeys: { anthropic: 'sk-ant-api-test', openai: 'sk-test', xai: 'xai-test' } })
      await api.spaces.create({ name: 'Ideas Bot', color: '#5b8def', intro: false })
      await api.spaces.create({ name: 'Finance', color: '#30a46c', intro: false })
      for (const m of ['Prefers short, direct answers', 'Lives in Atlanta, GA', 'Works on the Vantage iOS app with a team of four']) await api.memory.add(m, null)
      await api.vault.set({ name: 'GitHub', origin: 'https://github.com', username: 'sahil-patel-2011', password: 'x-test-only' })
      await api.vault.set({ name: 'School portal', origin: 'https://portal.example.edu', username: 'spatel@student.example.edu', password: 'x-test-only' })
      const v = api.notesVault
      const priya = await v.create({ title: 'Priya Patel', type: 'person' })
      const n = await v.read(priya)
      await v.save(priya, `${n.text.trim()}\n\n> The user's sister, an ICU nurse.\n\n## Notes\n- Lives in Austin; see [[Austin trip]].\n`)
      const trip = await v.create({ title: 'Austin trip', type: 'project' })
      const t = await v.read(trip)
      await v.save(trip, `${t.text.trim()}\n\n> Visiting [[Priya Patel]] in December.\n\n## Notes\n- Flying Dec 12–16.\n- Still to decide: [[Hotel choice]].\n`)
    }, ws)
    await page.evaluate(() => (window as any).foreman.models.list())
    await page.reload()
    await page.waitForSelector('[data-testid="composer-input"]')
    await wait(page, 600)

    await step(page, 'composer', async () => {
      await shoot(page, 'composer-home-empty')
      await page.fill('[data-testid="composer-input"]', 'Compare three plans for my team')
      await shoot(page, 'composer-home-text')
      await page.fill('[data-testid="composer-input"]', '')
    })

    await step(page, 'modes-menu', async () => {
      // After the cleanup the less-used modes live under one "Modes" menu.
      if (!(await page.locator('[data-testid="modes-menu"]').count())) return
      await page.click('[data-testid="modes-menu"]')
      await wait(page, 250)
      await shoot(page, 'composer-modes-menu')
      await page.click('[data-testid="deep-toggle"]')
      await wait(page, 150)
      await page.keyboard.press('Escape')
      await shoot(page, 'composer-mode-on')
      await page.click('[data-testid="modes-menu"]')
      await page.click('[data-testid="deep-toggle"]')
      await page.keyboard.press('Escape')
    })

    await step(page, 'pickers', async () => {
      await page.click('[data-testid="model-picker"]')
      await wait(page, 250)
      await shoot(page, 'composer-model-picker', undefined, [SIZES[1]])
      await page.keyboard.press('Escape')
      await page.click('[data-testid="model-picker"]')
      await page.click('[data-testid="mode-picker"]')
      await wait(page, 250)
      await shoot(page, 'composer-mode-picker', undefined, [SIZES[1]])
      await page.keyboard.press('Escape')
      await page.click('[data-testid="thinking-picker"]')
      await wait(page, 250)
      await shoot(page, 'composer-thinking-picker', undefined, [SIZES[1]])
      await page.keyboard.press('Escape')
      await page.click('[data-testid="more-models"]')
      await wait(page, 250)
      await shoot(page, 'composer-more-models', undefined, [SIZES[1]])
      // Esc closes the flyout, then the menu.
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
    })

    await step(page, 'profile-menu', async () => {
      await page.click('[data-testid="profile"]', { button: 'right' })
      await wait(page, 250)
      await shoot(page, 'sidebar-profile-menu', undefined, [SIZES[1]])
      await page.keyboard.press('Escape')
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
      const card = page.locator('[data-testid="approval-card"]').first()
      await card.waitFor({ timeout: 15_000 })
      await wait(page, 300)
      await shootEl(page, 'card-approval', card)
      await shoot(page, 'chat-approval', () => bottom(page))
      await page.click('[data-testid="approve-deny"]')
      await idle(page, llm)
      await page.click('[data-testid="model-picker"]')
      await page.click('[data-testid="mode-picker"]')
      await page.click('[data-testid="mode-auto"]')
    })

    await step(page, 'question', async () => {
      const ask = { content: 'Happy to draft it.', toolCalls: [{ name: 'ask_user', arguments: '{"question":"Who should the purchase request go to?","options":["My manager","Finance team","IT department"]}' }] }
      llm.script.push(ask, ask, { content: 'Got it — drafting it for your manager now.' })
      await send(page, 'Draft the purchase request')
      const card = page.locator('[data-testid="question-card"]').first()
      await card.waitFor({ timeout: 15_000 })
      await wait(page, 300)
      await shootEl(page, 'card-question', card)
      await card.locator('.question-option, button', { hasText: 'My manager' }).first().click()
      await idle(page, llm)
    })

    await step(page, 'plan-approval', async () => {
      const plan = call('propose_plan', { goal: 'A one-page purchase request for the Team plan, ready to send.', steps: ['Collect the pricing', 'Write the request', 'Save it as a Word document'], assumptions: ['Addressed to your manager'], risks: ['Prices may change before approval'] })
      llm.script.push(plan, plan, plan)
      if (await page.locator('[data-testid="modes-menu"]').count()) await page.click('[data-testid="modes-menu"]')
      await page.click('[data-testid="plan-toggle"]')
      await page.keyboard.press('Escape').catch(() => undefined)
      await send(page, 'Write the request as a document')
      const card = page.locator('[data-testid="plan-approval"]').first()
      await card.waitFor({ timeout: 15_000 })
      await wait(page, 300)
      await shootEl(page, 'card-plan-approval', card)
      await shoot(page, 'chat-plan-approval', () => bottom(page))
      await page.locator('[data-testid="stop"]').click().catch(() => undefined)
      llm.script.length = 0
      await idle(page, llm)
    })

    await step(page, 'connect-card', async () => {
      await page.click('[data-testid="new-chat"]')
      await wait(page, 300)
      llm.script.push(
        { toolCalls: [{ name: 'find_tools', arguments: '{"query":"pagerduty incidents"}' }] },
        { content: 'OK, without PagerDuty.' }
      )
      await send(page, 'What incidents are open in PagerDuty?')
      const card = page.locator('[data-testid="connect-card"]').first()
      await card.waitFor({ timeout: 20_000 })
      await card.locator('[data-testid="api-key-panel"]').waitFor({ timeout: 10_000 })
      await wait(page, 300)
      await shootEl(page, 'card-connect', card)
      await shoot(page, 'chat-connect', () => bottom(page))
      await card.locator('button', { hasText: 'Cancel' }).first().click()
      await idle(page, llm)
    })

    await step(page, 'doc', async () => {
      await page.click('[data-testid="model-picker"]')
      await page.click('[data-testid="mode-picker"]')
      await page.click('[data-testid="mode-auto"]')
      llm.script.push(
        call('doc_create', { title: 'Purchase request', markdown: '# Purchase request\n\nWe would like the **Team** plan for five people.\n\n- $15 per seat per month\n- SSO and 1 TB of storage\n\n## Why\n\nIt is the best value for a team our size.' }),
        { content: 'I drafted the request beside the chat.' }
      )
      await send(page, 'Draft it as a live document')
      await idle(page, llm)
      await page.locator('[data-testid="doc-editor"]').waitFor({ timeout: 15_000 })
      await wait(page, 400)
      await shoot(page, 'view-doc-editor')
      await page.click('[data-testid="toggle-panel"]').catch(() => undefined)
    })

    await step(page, 'jobs', async () => {
      const port = 5300 + Math.floor(Math.random() * 400)
      const server = `node -e "require('http').createServer((q,s)=>s.end('hi')).listen(${port},()=>{console.log('  ready in 212 ms');console.log('  Local:   http://localhost:${port}/');setInterval(()=>console.log('[hmr] page reload src/App.tsx'),700)})"`
      await page.click('[data-testid="model-picker"]')
      await page.click('[data-testid="mode-picker"]')
      await page.click('[data-testid="mode-auto"]')
      llm.script.push(call('run_command', { command: server, background: true, wait_for: { text: 'Local:', timeout: 20 } }))
      llm.script.push({ content: `The dev server is up at http://localhost:${port}/.` })
      await send(page, 'start the dev server for my site')
      // A background server may still ask once: allow it.
      await page.locator('[data-testid="approve-once"]').first().click({ timeout: 8_000 }).catch(() => undefined)
      await page.waitForSelector('[data-testid="run-summary"]', { timeout: 30_000 })
      await wait(page, 600)
      await page.click('[data-testid="jobs-chip"]')
      await page.waitForSelector('[data-testid="job-card"]')
      await wait(page, 1200)
      await shoot(page, 'view-jobs')
      await page.click('[data-testid="job-stop"]').catch(() => undefined)
      await page.click('[data-testid="jobs-chip"]').catch(() => undefined)
      await page.click('[data-testid="model-picker"]')
      await page.click('[data-testid="mode-picker"]')
      await page.click('[data-testid="mode-auto"]')
    })

    await step(page, 'swarm', async () => {
      await openBot(page, 'Ideas Bot')
      let lead = 0
      llm.script.length = 0
      route(llm, (r) => {
        if (sys(r).includes('# You are a temporary swarm helper')) {
          const n = Number(/helper H(\d+) of (\d+)/.exec(lastUser(r))?.[1] ?? 0)
          return { content: `1. **Idea ${n}: a neighborhood supper club**: try it. Why it could work: locals. Risk: time.\n2. **Plan ${n}b: weekend stall**: more.\nBest bet: the first.`, delay: 0 }
        }
        lead++
        return lead === 1
          ? { toolCalls: [{ name: 'swarm', arguments: JSON.stringify({ goal: 'Ways to grow a neighborhood bakery', pattern: 'ideate', helpers: 8 }) }], delay: 0 }
          : { content: 'The best ideas are the supper club [H2, H5] and the farmers-market stall [H7].', delay: 0 }
      })
      if (await page.locator('[data-testid="modes-menu"]').count()) await page.click('[data-testid="modes-menu"]')
      await page.click('[data-testid="max-toggle"]')
      await page.keyboard.press('Escape').catch(() => undefined)
      await send(page, 'Brainstorm ways to grow my bakery')
      const card = page.locator('[data-testid="swarm-card"]').first()
      await page.waitForFunction(() => document.querySelector('[data-testid="swarm-card"]')?.getAttribute('data-phase') === 'done', undefined, { timeout: 60_000 })
      await wait(page, 400)
      await shootEl(page, 'card-swarm', card)
      await card.locator('[data-testid="swarm-helper"]').first().locator('button').first().click()
      await wait(page, 600)
      await shootEl(page, 'card-swarm-open', card)
      await shoot(page, 'chat-swarm', () => bottom(page))
      llm.script.length = 0
    })

    await step(page, 'askbot', async () => {
      let lead = 0
      route(llm, (r) => {
        if (JSON.stringify(r.messages).includes('Question from the bot')) return { content: 'Q3 spend was $12,400, mostly ads ($7,900) and flour ($2,100).', delay: 0 }
        lead++
        return lead === 1 ? { toolCalls: [{ name: 'ask_bot', arguments: JSON.stringify({ bot: 'Finance', question: 'What was our Q3 spend?' }) }], delay: 0 } : { content: 'Finance says Q3 spend was $12,400.', delay: 0 }
      })
      await send(page, 'What was our Q3 spend? Ask Finance.')
      const card = page.locator('[data-testid="askbot-card"]').first()
      await card.waitFor({ timeout: 30_000 })
      await idle(page, llm, 15_000).catch(() => undefined)
      llm.script.length = 0
      await shootEl(page, 'card-askbot', card)
      await card.locator('button').first().click()
      await wait(page, 300)
      await shootEl(page, 'card-askbot-open', card)
    })

    await step(page, 'bot-details', async () => {
      await page.click('[data-testid="bot-pill"]')
      await page.waitForSelector('[data-testid="bot-details"]')
      await wait(page, 500)
      await shoot(page, 'view-bot-details')
      await shootTall(page, 'view-bot-details-tall').catch(() => undefined)
      await page.click('[data-testid="bot-customize"]')
      await page.waitForSelector('[data-testid="bot-editor"]')
      await wait(page, 400)
      await shoot(page, 'view-bot-editor')
      await page.keyboard.press('Escape')
      await wait(page, 200)
      await page.keyboard.press('Escape')
    })

    await step(page, 'vault-view', async () => {
      await page.keyboard.press('Meta+k')
      await page.fill('[data-testid="palette-input"]', 'vault')
      await page.keyboard.press('Enter')
      await page.locator('[data-testid="vault-view"]').waitFor()
      await page.locator('[data-testid="vault-item"]', { hasText: 'Priya Patel' }).first().click()
      await wait(page, 500)
      await shoot(page, 'view-vault-note')
      await page.click('[data-testid="vault-tab-graph"]')
      await wait(page, 800)
      await shoot(page, 'view-vault-graph')
      await page.click('[data-testid="vault-tab-changes"]').catch(() => undefined)
      await wait(page, 400)
      await shoot(page, 'view-vault-changes', undefined, [SIZES[1]])
      await page.click('[data-testid="vault-close"]')
    })

    await step(page, 'settings', async () => {
      for (const p of ['general', 'models', 'usage', 'passwords', 'memory', 'knowledge']) {
        await settingsPage(page, p)
        await wait(page, p === 'usage' ? 800 : 300)
        await shoot(page, `settings-${p}`)
        await shootTall(page, `tall-settings-${p}`)
      }
      await settingsPage(page, 'memory')
      await page.click('[data-testid="memory-import-open"]')
      await page.locator('[data-testid="memory-import"]').waitFor()
      await wait(page, 300)
      await shoot(page, 'settings-memory-import')
      await page.click('[data-testid="memory-import-cancel"]')
      await page.click('[data-testid="settings-close"]')
    })

    await step(page, 'usage-glance', async () => {
      await page.keyboard.press('Meta+k')
      await page.keyboard.type('Usage')
      await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid="usage-glance"]')
      await wait(page, 400)
      await shoot(page, 'view-usage-glance', undefined, [SIZES[1]])
      await page.keyboard.press('Escape')
    })

    await step(page, 'connect-apps', async () => {
      await page.locator('[data-testid="connect-apps"]').first().click()
      await wait(page, 2500)
      await shoot(page, 'view-connect-browse')
      await page.click('[data-testid="connected-count"]').catch(() => undefined)
      await wait(page, 500)
      await shoot(page, 'view-connect-manage')
      await page.keyboard.press('Escape')
    })

    await app.close()
  }

  // ================================================================ Council (two local members)
  {
    llm.models = ['qwen3.8:27b', 'gemma4:12b']
    llm.script.length = 0
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    page.setDefaultTimeout(15_000)
    await step(page, 'council', async () => {
      route(llm, (r) => {
        const s = sys(r)
        if (s.startsWith('[COUNCIL-PLAN]')) return { content: `Plan from ${r.model}\n1. Draft the launch post\n2. Check the facts and prices`, delay: 0 }
        if (s.startsWith('[COUNCIL-CRITIQUE]')) return { content: `Critique from ${r.model}: add a deadline and a link to the pricing page.`, delay: 0 }
        if (s.startsWith('[COUNCIL-MERGE]')) return { content: JSON.stringify({ summary: 'One post with checked facts and a clear deadline.', steps: [{ text: 'Draft the launch post', owner: 1 }, { text: 'Check the facts and prices', owner: 2 }], disagreements: [] }), delay: 0 }
        if (s.startsWith('[COUNCIL-SIGN]')) return { content: '{"ok": true, "objections": []}', delay: 0 }
        if (s.startsWith('[COUNCIL-REVIEW]')) return { content: '{"ok": true, "issues": []}', delay: 0 }
        if (lastUser(r).includes('[COUNCIL-FINAL]')) return { content: 'Here is the launch post, checked by both members.', delay: 0 }
        if (s.includes('# You are a council member')) return { content: '### Step 1\nDone.\n### Step 2\nDone.', delay: 0 }
        return { content: 'ok', delay: 0 }
      })
      if (await page.locator('[data-testid="modes-menu"]').count()) await page.click('[data-testid="modes-menu"]')
      await page.click('[data-testid="council-toggle"]')
      await page.keyboard.press('Escape').catch(() => undefined)
      await page.click('[data-testid="council-pick"]')
      await wait(page, 200)
      await shoot(page, 'composer-council-pick', undefined, [SIZES[1]])
      const picks = page.locator('[data-testid="council-member-pick"]')
      await picks.filter({ hasText: /qwen/i }).first().click()
      await picks.filter({ hasText: /gemma/i }).first().click()
      await page.keyboard.press('Escape').catch(() => undefined)
      await shoot(page, 'composer-council-on')
      await send(page, 'Write our launch post')
      const card = page.locator('[data-testid="council-card"]').first()
      await page.waitForFunction(() => document.querySelector('[data-testid="council-card"]')?.getAttribute('data-phase') === 'done', undefined, { timeout: 60_000 })
      await wait(page, 400)
      await shootEl(page, 'card-council', card)
      await card.locator('[data-testid="council-member"] summary').first().click()
      await wait(page, 200)
      await shootEl(page, 'card-council-open', card)
      llm.script.length = 0
    })
    await app.close()
  }

  // ================================================================ Planner ⇄ Executor (computer use)
  {
    const site = await startTestSite()
    llm.models = ['qwen3.8:27b', 'qwen3.5:9b']
    llm.script.length = 0
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    page.setDefaultTimeout(15_000)
    await step(page, 'cua', async () => {
      await page.evaluate(() => (window as any).foreman.settings.set({ computerUse: { mode: 'pair', executor: 'qwen3.5:9b', planner: 'qwen3.8:27b' } }))
      const browser = (args: Record<string, unknown>): ScriptedReply => call('browser', args)
      const checkpoint = (args: Record<string, unknown>): ScriptedReply => call('checkpoint', args)
      const planner = (json: Record<string, unknown>): ScriptedReply => ({ content: JSON.stringify(json), delay: 0 })
      const formSnap = (req: Record<string, any>): string => String([...req.messages].reverse().find((m: any) => m.role === 'tool' && String(m.content).includes('Page: "Contact')).content)
      llm.script.push(
        planner({ summary: 'Fill in the Acme contact form without sending it', constraints: ["don't send the form"], checkpoints: [
          { goal: 'The Acme contact form is open', success: 'The "Contact us" page shows the name, message and topic fields' },
          { goal: 'Name, message and topic Billing filled in', success: 'Your name: Sam Rivera, Message: Need a quote for 40 seats, Topic: Billing; not sent' }
        ] }),
        browser({ action: 'navigate', url: `${site.url}/quote` }),
        browser({ action: 'snapshot' }),
        checkpoint({ status: 'done', checkpoint: 1, sees: 'Contact us page with Your name, Message and Topic', evidence: 'The three fields are on the page' }),
        planner({ action: 'next', message: 'Fill in the name and message, and set Topic to Billing.' }),
        checkpoint({ status: 'disagree', reason: 'contradicts_screen', sees: 'Topic offers only Sales and Support', why: 'There is no Billing topic on this form', suggestion: 'Use Sales: a quote request is a sales question' }),
        planner({ action: 'revise', verdict: 'agree', message: 'Right, there is no Billing. Use Sales.', plan: { checkpoints: [{ goal: 'Name, message and topic Sales filled in', success: 'Your name: Sam Rivera, Message: Need a quote for 40 seats, Topic: Sales; not sent' }] } }),
        (req) => browser({ action: 'type', ref: refFor(formSnap(req), 'textbox', 'Your name'), text: 'Sam Rivera' }),
        (req) => browser({ action: 'type', ref: refFor(formSnap(req), 'textbox', 'Message'), text: 'Need a quote for 40 seats' }),
        (req) => browser({ action: 'select', ref: refFor(formSnap(req), 'combobox', 'Topic'), option: 'Sales' }),
        browser({ action: 'snapshot' }),
        (req) => checkpoint({ status: 'done', sees: lastToolOutput(req).includes('Sam Rivera') ? 'Name Sam Rivera, message filled, Topic Sales, not sent' : 'fields filled', evidence: 'All three fields show the values' }),
        planner({ action: 'finish', message: 'Name, message and Sales topic are filled in and the form was not sent.' }),
        { content: 'The contact form is filled in (Sam Rivera, "Need a quote for 40 seats", topic Sales). I did not send it.', delay: 0 }
      )
      await send(page, `Go to the website ${site.url}/quote and fill in the contact form: my name is Sam Rivera, the message is "Need a quote for 40 seats", topic Billing. Don't send it.`)
      await idle(page, llm, 50_000)
      const card = page.locator('[data-testid="cua-card"]').first()
      await card.waitFor({ timeout: 10_000 })
      await wait(page, 400)
      await page.click('[data-testid="toggle-panel"]').catch(() => undefined) // the browser panel may have opened
      await wait(page, 300)
      await shootEl(page, 'card-cua', card)
      await shoot(page, 'chat-cua', () => bottom(page))
    })
    await app.close()
    await site.close()
  }

  // ================================================================ CAD design progress (fake Onshape)
  {
    const onshape = await startFakeOnshape()
    llm.models = ['qwen3.8:27b', 'llama3.3:70b']
    llm.script.length = 0
    const ws = mkdtempSync(join(tmpdir(), 'clean-cad-'))
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64', FOREMAN_ONSHAPE_URL: onshape.url })
    page.setDefaultTimeout(15_000)
    await step(page, 'cad', async () => {
      await page.evaluate(({ w, k }) => (window as any).foreman.settings.set({ workspaceDir: w, onshapeAccessKey: k.accessKey, onshapeSecretKey: k.secretKey }), { w: ws, k: FAKE_KEYS })
      const plan = {
        name: '40 mm filleted cube', units: 'mm',
        variables: [{ name: 'side', value: 40 }, { name: 'fillet_r', value: 5 }],
        features: [{ op: 'cube', id: 'body', name: 'Cube', side: '#side' }, { op: 'fillet', id: 'round', name: 'Edge fillet', edges: { of: 'body' }, radius: '#fillet_r' }],
        expect: { bbox_mm: [40, 40, 40], tolerance_mm: 0.01, volume_mm3: 61592.18, volume_tolerance_pct: 0.5, parts: 1 },
        exports: ['STEP']
      }
      llm.script.push(
        call('cad_design', { action: 'brief', brief: { goal: '40 mm cube with a 5 mm fillet on every edge', units: 'mm', dimensions: ['40 mm cube', '5 mm fillet, all 12 edges'], process: 'fdm', material: 'PLA' } }),
        call('cad_design', { action: 'concepts', concepts: [{ name: 'Cube + fillet', summary: 'Cube feature, one fillet on every edge', scores: { manufacturability: 5, cost: 5 } }, { name: 'Sketch + extrude', summary: 'Square sketch extruded 40 mm, then fillets', scores: { manufacturability: 5, cost: 5 } }], recommended: 0, reasons: 'two features, fully parametric' }),
        call('cad_design', { action: 'plan', plan }),
        call('cad_design', { action: 'build' }),
        call('cad_design', { action: 'verify' }),
        call('cad_design', { action: 'deliver' }),
        { content: 'Built the 40 mm cube with 5 mm fillets in Onshape; all checks pass. STEP exported.' }
      )
      await send(page, 'build a 40 mm cube with a 5 mm fillet in CAD')
      await idle(page, llm, 50_000)
      const card = page.locator('[data-testid="plan-card"]').first()
      await card.waitFor({ timeout: 10_000 })
      await wait(page, 300)
      await shootEl(page, 'card-cad-plan', card)
      await shoot(page, 'chat-cad', () => bottom(page))
    })
    await app.close()
    await onshape.close()
  }

  // ================================================================ cost card (a cloud team asking first)
  {
    llm.models = ['claude-opus-5-5']
    llm.script.length = 0
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_FORCE_PAID: '1' })
    page.setDefaultTimeout(15_000)
    await step(page, 'spend-card', async () => {
      await page.evaluate(() => (window as any).foreman.settings.set({ defaultModel: 'claude-opus-5-5', cloudBudgetUsd: 50, swarm: { askAboveUsd: 0 } }))
      llm.script.push(call('agents', { tasks: [1, 2, 3, 4].map((i) => ({ title: `Pricing: vendor ${i}`, task: `Find vendor ${i}'s team pricing.` })) }))
      await send(page, 'Research pricing for four vendors')
      const card = page.locator('.spend-figs').first().locator('xpath=..')
      await card.waitFor({ timeout: 20_000 })
      await wait(page, 300)
      await shootEl(page, 'card-spend', card)
      await page.locator('[data-testid="spend-deny"]').click().catch(() => undefined)
      llm.script.length = 0
    })
    await app.close()
  }

  await llm.close()
  if (errors.length) console.log(`Steps that failed:\n${errors.join('\n')}`)
  console.log(`Screenshots in ${out}`)
}, 1_200_000)
