// Dev helper (UI audit): every main screen and state, light and dark, at 1280×800 and 900×700, plus the phone
// web UI at 390×844 (Phone access, headless Chromium). Mock model, test site, hidden window; no paid calls.
//   npm run build && SHOTS_DIR=<dir> SAHILBOT_HIDDEN=1 npx vitest run --config vitest.tools.config.mts tests/tools/ui-audit-shots.test.ts --silent=false
// Optional: ONLY=<comma list of shot-name prefixes>. Failed steps are listed at the end and leave a zz-fail-*.png.
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Locator, type Page } from 'playwright'
import { test } from 'vitest'
import type { PhoneAccessStatus } from '@shared/types'
import { launch, tempProfile } from '../accept/app'
import { refFor, startMockLlm, type MockLlm, type ScriptedReply } from '../fixtures/mock-llm'
import { startTestSite, STORE } from '../fixtures/test-site'
import { seedUsage } from '../fixtures/usage-seed'

const out = process.env.SHOTS_DIR ?? join(tmpdir(), 'ui-audit-shots')
mkdirSync(out, { recursive: true })
const SIZES = [{ w: 1280, h: 800 }, { w: 900, h: 700 }] as const
const only = (process.env.ONLY ?? '').split(',').map((x) => x.trim()).filter(Boolean)
const skip = (process.env.SKIP ?? '').split(',').map((x) => x.trim()).filter(Boolean)
const errors: string[] = []
const wait = (page: Page, ms: number): Promise<void> => page.waitForTimeout(ms)
const want = (name: string): boolean => (!only.length || only.some((o) => name.startsWith(o))) && !skip.some((o) => name.startsWith(o))

async function shoot(page: Page, name: string, prep?: () => Promise<unknown>, sizes: ReadonlyArray<{ w: number; h: number }> = SIZES): Promise<void> {
  if (!want(name)) return
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
async function shootEl(page: Page, name: string, el: Locator): Promise<void> {
  if (!want(name)) return
  for (const s of SIZES) {
    await page.setViewportSize({ width: s.w, height: s.h })
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await wait(page, 200)
      await el.scrollIntoViewIfNeeded().catch(() => undefined)
      await el.screenshot({ path: `${out}/${name}-${scheme}-${s.w}.png` })
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: SIZES[0].w, height: SIZES[0].h })
}
/** A long scrolling page (Settings, Bot details) in one tall shot per theme and width. */
async function shootTall(page: Page, name: string, sel = '.set-body'): Promise<void> {
  if (!want(name)) return
  for (const w of [1280, 900]) {
    await page.setViewportSize({ width: w, height: 800 })
    await wait(page, 150)
    const h = await page.evaluate((q) => { const b = document.querySelector(q) as HTMLElement | null; return b ? b.scrollHeight + 60 : 1600 }, sel)
    await page.setViewportSize({ width: w, height: Math.min(4200, Math.max(800, h)) })
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await wait(page, 250)
      await page.screenshot({ path: `${out}/${name}-${scheme}-${w}.png` })
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: SIZES[0].w, height: SIZES[0].h })
}
/** STEPS=<comma list> runs only those steps (the setup still runs). */
const steps = (process.env.STEPS ?? '').split(',').map((x) => x.trim()).filter(Boolean)
const stepOn = (name: string): boolean => !steps.length || steps.some((x) => name.startsWith(x))
/** A card taller than the window: the window grows to fit it, then the card alone. */
async function shootCard(page: Page, name: string, el: Locator): Promise<void> {
  if (!want(name)) return
  for (const w of [1280, 900]) {
    await page.setViewportSize({ width: w, height: 800 })
    await wait(page, 150)
    const h = await el.evaluate((e) => e.getBoundingClientRect().height)
    await page.setViewportSize({ width: w, height: Math.min(4000, Math.max(800, Math.ceil(h) + 360)) })
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await wait(page, 250)
      await el.evaluate((e) => e.scrollIntoView({ block: 'center' }))
      await wait(page, 150)
      await el.screenshot({ path: `${out}/${name}-${scheme}-${w}.png` })
    }
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: SIZES[0].w, height: SIZES[0].h })
}
async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  if (!stepOn(name)) return
  const stuck = (): Promise<never> => new Promise((_, no) => setTimeout(() => no(new Error('step took over 300 s')), 300_000))
  try { await Promise.race([fn(), stuck()]) } catch (e) {
    errors.push(`${name}: ${(e as Error).message.split('\n')[0]}`)
    await page.screenshot({ path: `${out}/zz-fail-${name}.png` }).catch(() => undefined)
    await page.keyboard.press('Escape').catch(() => undefined)
  }
}
const send = async (page: Page, text: string): Promise<void> => { await page.fill('[data-testid="composer-input"]', text); await page.keyboard.press('Enter') }
const idle = async (page: Page, llm: MockLlm, ms = 25_000): Promise<void> => {
  const end = Date.now() + ms
  while (Date.now() < end && (llm.script.length || (await page.locator('[data-testid="stop"]').count()))) await wait(page, 150)
  await wait(page, 300)
}
const bottom = (page: Page) => page.evaluate(() => { const el = document.querySelector('.thread-scroll') as HTMLElement | null; if (el) { el.style.scrollBehavior = 'auto'; el.scrollTop = el.scrollHeight } })
const call = (name: string, args: unknown, content = ''): ScriptedReply => ({ content, toolCalls: [{ name, arguments: JSON.stringify(args) }], delay: 0 })
const sys = (r: Record<string, any>): string => String(r.messages?.[0]?.content ?? '')
const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? '').join(' ') : '')
const lastUser = (r: Record<string, any>): string => textOf([...r.messages].reverse().find((m: any) => m.role === 'user')?.content)
const route = (llm: MockLlm, fn: (r: Record<string, any>) => ScriptedReply): void => { for (let i = 0; i < 200; i++) llm.script.push(fn as never) }
const newChat = async (page: Page): Promise<void> => { await page.click('[data-testid="new-chat"]'); await page.waitForSelector('[data-testid="composer-input"]'); await wait(page, 300) }
const setMode = async (page: Page, id: string): Promise<void> => {
  await page.click('[data-testid="model-picker"]')
  await page.click('[data-testid="mode-picker"]')
  await page.click(`[data-testid="mode-${id}"]`)
  await page.keyboard.press('Escape').catch(() => undefined)
}
const settingsPage = async (page: Page, id: string): Promise<void> => {
  if (!(await page.locator('[data-testid="settings"]').count())) { await page.keyboard.press('Meta+,'); await page.waitForSelector('[data-testid="settings"]') }
  await page.click(`[data-testid="settings-${id}"]`)
  await wait(page, 500)
}
const openBot = async (page: Page, name: string): Promise<void> => {
  await page.locator('[data-testid="space-item"]', { hasText: name }).first().click()
  await page.waitForFunction((n) => document.querySelector('[data-testid="bot-pill"]')?.textContent?.includes(n), name, { timeout: 10_000 })
  await wait(page, 300)
}
const snapOf = (req: any, title: string): string => String([...req.messages].reverse().find((m: any) => m.role === 'tool' && String(m.content).includes(`Page: "${title}`))?.content ?? '')
const lastTool = (req: any): string => String([...req.messages].reverse().find((m: any) => m.role === 'tool')?.content ?? '')

function chromiumPath(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH
  if (existsSync(chromium.executablePath())) return undefined
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  if (!existsSync(cache)) return undefined
  for (const d of readdirSync(cache).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
    for (const sub of readdirSync(join(cache, d))) {
      const exe = join(cache, d, sub, 'chrome-headless-shell')
      if (existsSync(exe)) return exe
    }
  }
  return undefined
}

test('UI audit screenshots', async () => {
  const llm = await startMockLlm()

  // ---------------------------------------------------------------- onboarding (first run, nothing connected)
  if (want('onboard') && stepOn('onboarding')) {
    llm.models = []
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_SKIP_ONBOARDING: '', SAHILBOT_QUIET: '1' })
    await step(page, 'onboarding', async () => {
      await page.waitForSelector('[data-testid="onboarding"]')
      await shoot(page, 'onboard-1-name')
      await page.fill('[data-testid="onboarding-name"]', 'Sahil')
      await page.click('[data-testid="onboarding-name-next"]')
      await page.locator('[data-testid="onboarding-cloud"]').waitFor()
      await wait(page, 600)
      await shoot(page, 'onboard-2-connect')
      await page.click('[data-testid="onboarding-next"]')
      await page.locator('[data-testid="onboarding-perms-next"]').waitFor()
      await wait(page, 600)
      await shoot(page, 'onboard-3-finish')
    })
    await app.close()
  }

  // ---------------------------------------------------------------- the main app, as a normal user (no Developer mode)
  llm.models = ['qwen3.8:27b', 'claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.2-astra', 'gpt-6.2-sol']
  const dir = tempProfile()
  seedUsage(dir)
  const ws = mkdtempSync(join(tmpdir(), 'audit-ws-'))
  const site = await startTestSite()
  const { app, page } = await launch(dir, llm.url, {
    SAHILBOT_QUIET: '1', FOREMAN_RAM_GB: '64', FOREMAN_ASK_GRACE_MS: '0',
    SAHILBOT_PHONE_TEST_BIND: '127.0.0.1', SAHILBOT_PHONE_PORT: '0', SAHILBOT_PHONE_WATCH_MS: '600000'
  })
  page.setDefaultTimeout(15_000)
  await page.evaluate(async ({ w, c }) => {
    const api = (window as any).foreman
    await api.settings.set({ userName: 'Sahil Patel', workspaceDir: w, me: { emails: ['sahil@example.com'], phones: ['+1 555 010 1234'] }, setKeys: { anthropic: 'sk-ant-api-test', openai: 'sk-test' } })
    const f = await api.spaces.create({ name: 'Finance', color: '#30a46c', intro: false })
    await api.spaces.create({ name: 'Ideas Bot', color: '#5b8def', intro: false })
    await api.settings.set({ botAutonomy: { [f.space?.id ?? f.id]: { trustedRecipients: ['amy@example.com', '+1 555 010 9999'] } } })
    for (const m of ['Prefers short, direct answers', 'Lives in Atlanta, GA', 'Works on the Vantage iOS app with a team of four']) await api.memory.add(m, null)
    await api.memory.add('Chose Stripe over Paddle for payments (lower fees for US cards)', null, 'decision')
    await api.memory.add('Ship the iOS app before the Android one', null, 'decision')
    const addrs = await api.vault.setAddress({ nickname: 'Home', name: 'Sam Rivera', line1: '1 Main St', city: 'Albany', region: 'NY', postal: '12207', country: 'US' })
    await api.vault.setCard({ nickname: 'Personal', number: c.number, cvc: c.cvc, expMonth: c.month, expYear: c.year, holder: c.holder, billing: addrs[0].id })
  }, { w: ws, c: STORE.card })
  await page.evaluate(() => (window as any).foreman.models.list())
  await page.reload()
  await page.waitForSelector('[data-testid="composer-input"]')
  await wait(page, 800)

  await step(page, 'home', async () => {
    await shoot(page, 'home')
    await page.fill('[data-testid="composer-input"]', 'Compare three plans for my team')
    await shoot(page, 'home-typed', undefined, [SIZES[1]])
    await page.fill('[data-testid="composer-input"]', '')
  })

  await step(page, 'picker', async () => {
    await page.click('[data-testid="model-picker"]')
    await wait(page, 300)
    await shoot(page, 'picker')
    await page.keyboard.press('Escape')
  })

  await step(page, 'profile', async () => {
    await page.click('[data-testid="profile"]', { button: 'right' })
    await wait(page, 250)
    await shoot(page, 'profile-menu', undefined, [SIZES[1]])
    await page.keyboard.press('Escape')
  })

  await step(page, 'approval', async () => {
    await newChat(page)
    await setMode(page, 'ask')
    llm.script.push(call('file_write', { path: 'team-plan-summary.md', content: '# Team plan\n\nBest value for 5 people: $75/month.' }, "I'll save the summary next to your notes."), { content: 'Okay, not saved.' })
    await send(page, 'Save that summary to a file')
    const card = page.locator('[data-testid="approval-card"]').first()
    await card.waitFor()
    await wait(page, 300)
    await shoot(page, 'chat-approval', () => bottom(page))
    await card.locator('[data-testid="approve-deny"]').click()
    await idle(page, llm)
    await setMode(page, 'auto')
  })

  await step(page, 'purchase', async () => {
    await newChat(page)
    llm.script.push(
      call('browser', { action: 'navigate', url: `${site.url}/store/product` }),
      (req) => call('browser', { action: 'select', ref: refFor(snapOf(req, 'Ceramic mug'), 'combobox', 'Quantity'), option: '2' }),
      (req) => call('browser', { action: 'click', ref: refFor(snapOf(req, 'Ceramic mug'), 'button', 'Add to cart') }),
      call('browser', { action: 'navigate', url: `${site.url}/store/checkout` }),
      call('browser', { action: 'wallet' }),
      call('browser', { action: 'fill_address', address: 'Home' }),
      call('browser', { action: 'fill_payment', card: 'Personal' }),
      call('browser', { action: 'snapshot' }),
      (req) => call('browser', { action: 'click', ref: refFor(lastTool(req), 'button', 'Place order') }),
      { content: 'Okay, I did not place the order.' }
    )
    await send(page, 'Buy two of the ceramic mugs from the tea shop, ship to Home, pay with my Personal card')
    const end = Date.now() + 60_000
    let n = 0
    while (Date.now() < end && n < 2) {
      const ap = page.locator('[data-testid="approval-card"] [data-testid="approve-once"]')
      if (await ap.count()) { await ap.first().click(); await wait(page, 300); continue }
      const pc = page.locator('[data-testid="purchase-card"]')
      if (await pc.count()) {
        await wait(page, 300)
        await page.click('[data-testid="toggle-panel"]').catch(() => undefined)
        await shootEl(page, n === 0 ? 'card-purchase-card' : 'card-purchase-order', pc.first())
        if (n === 1) await shoot(page, 'chat-purchase', () => bottom(page))
        await pc.first().locator(n === 0 ? '[data-testid="purchase-approve"]' : '[data-testid="purchase-deny"]').click()
        await pc.first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined)
        n++
        continue
      }
      await wait(page, 120)
    }
    llm.script.length = 0
    await idle(page, llm)
  })

  await step(page, 'max-swarm', async () => {
    await openBot(page, 'Ideas Bot')
    let lead = 0
    llm.script.length = 0
    route(llm, (r) => {
      if (sys(r).includes('# You are a temporary swarm helper')) {
        const n = Number(/helper H(\d+) of (\d+)/.exec(lastUser(r))?.[1] ?? 0)
        return { content: `1. **Pop-up ${n}**: a weekend stall in a new spot. Why: reach. Risk: weather.\n2. **Club ${n}**: a bread club.\nBest bet: the first.`, delay: 20 }
      }
      lead++
      return lead === 1
        ? { toolCalls: [{ name: 'max', arguments: JSON.stringify({ strategy: 'swarm', goal: 'Ways to grow a neighborhood bakery', pattern: 'ideate', helpers: 8 }) }], delay: 0 }
        : { content: 'The best ideas are the bread club [H2, H5] and the weekend stall [H7].', delay: 0 }
    })
    await send(page, 'Use an agent swarm to brainstorm ways to grow my bakery')
    const card = page.locator('[data-testid="max-card"]').first()
    await card.waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="max-card"]')?.getAttribute('data-status') === 'done', undefined, { timeout: 60_000 })
    llm.script.length = 0
    await idle(page, llm)
    await shootCard(page, 'card-max-swarm', card)
    await shoot(page, 'chat-max-swarm', () => bottom(page))
  })

  await step(page, 'max-heavy', async () => {
    await newChat(page)
    route(llm, (r) => {
      const s = sys(r)
      if (s.includes('[HEAVY-JUDGE]')) return { content: JSON.stringify({ agreements: ['√2 is irrational'], disagreements: [{ point: 'which proof is clearest', attempts: [1, 3] }], errors: [], unsupported: [], recheck: null, summary: 'Attempts 1 and 2 give the classic proof; 3 is more formal.' }), delay: 0 }
      if (lastUser(r).includes('[HEAVY-FINAL]')) return { content: 'Suppose √2 = p/q in lowest terms; then p² = 2q², so p is even, and so is q: a contradiction. [A1][A3]', delay: 0 }
      const n = Number(s.match(/Heavy attempt (\d+) of/)?.[1])
      if (n) return { content: `Attempt ${n}: assume √2 = p/q in lowest terms; then p² = 2q², so p is even…\n\nEvidence: a classic proof.`, delay: 30 }
      return { content: 'ok', delay: 0 }
    })
    await send(page, 'Use an agent swarm to prove that the square root of 2 is irrational')
    const card = page.locator('[data-testid="max-card"]').first()
    await card.waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="max-card"]')?.getAttribute('data-status') === 'done', undefined, { timeout: 60_000 })
    llm.script.length = 0
    await idle(page, llm)
    await shootCard(page, 'card-max-heavy', card)
  })

  await step(page, 'needs-you', async () => {
    await openBot(page, 'Finance')
    llm.script.push(
      call('file_write', { path: join(ws, 'q3.md'), content: '# Q3\nNumbers gathered.' }),
      { toolCalls: [{ name: 'ask_user', arguments: JSON.stringify({ question: 'Which budget should the report use?', options: ['Marketing (recommended)', 'Operations'], preference: true }) }] },
      { content: 'The report waits on your choice of budget.' }
    )
    await send(page, 'Prepare the Q3 report')
    await idle(page, llm)
    await shoot(page, 'chat-question', () => bottom(page), [SIZES[0]])
    await page.locator('[data-testid="main-bot"]').click()
    await wait(page, 600)
    await page.click('[data-testid="nav-tasks"]')
    await page.locator('[data-testid="needs-you-item"]').first().waitFor()
    await wait(page, 300)
    await shoot(page, 'view-needs-you')
  })

  await step(page, 'bot-details', async () => {
    await openBot(page, 'Finance')
    await page.click('[data-testid="bot-pill"]')
    await page.locator('[data-testid="bot-details"]').waitFor()
    await wait(page, 500)
    await shoot(page, 'view-bot-details')
    await shootTall(page, 'tall-bot-details', '[data-testid="bot-details"] .bd-body')
    await page.keyboard.press('Escape')
  })

  await step(page, 'new-bot', async () => {
    await page.click('[data-testid="new-bot"]')
    await page.locator('[data-testid="bot-editor"]').waitFor()
    await wait(page, 400)
    await shoot(page, 'view-new-bot')
    await page.keyboard.press('Escape')
  })

  await step(page, 'connect', async () => {
    await page.locator('[data-testid="connect-apps"]').first().click()
    await page.locator('[data-testid="connect-apps-modal"]').waitFor()
    await wait(page, 1500)
    await shoot(page, 'connect-browse')
    await page.fill('[data-testid="conn-search"]', 'Gmail')
    await wait(page, 300)
    await page.click('[data-testid="preset-gmail"]')
    await page.locator('[data-testid="google-connect"]').waitFor()
    await wait(page, 400)
    await shoot(page, 'connect-google')
    await page.keyboard.press('Escape')
    await page.locator('[data-testid="connect-apps"]').first().click()
    await page.locator('[data-testid="connect-apps-modal"]').waitFor()
    await wait(page, 800)
    await page.fill('[data-testid="conn-search"]', 'Resend')
    await page.click('[data-testid="preset-resend"]')
    await page.locator('[data-testid="api-key-panel"]').waitFor()
    await wait(page, 400)
    await shoot(page, 'connect-resend')
    await page.keyboard.press('Escape')
    await page.locator('[data-testid="connect-apps"]').first().click()
    await page.locator('[data-testid="connect-apps-modal"]').waitFor()
    await wait(page, 600)
    await page.fill('[data-testid="conn-search"]', 'Messages')
    await wait(page, 400)
    await shoot(page, 'connect-search-messages', undefined, [SIZES[1]])
    await page.click('[data-testid="connected-count"]').catch(() => undefined)
    await wait(page, 500)
    await shoot(page, 'connect-manage', undefined, [SIZES[1]])
    await page.keyboard.press('Escape')
  })

  await step(page, 'usage-glance', async () => {
    await page.keyboard.press('Meta+k')
    await wait(page, 250)
    await shoot(page, 'palette', undefined, [SIZES[1]])
    await page.keyboard.type('Usage')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-testid="usage-glance"]')
    await wait(page, 400)
    await shoot(page, 'view-usage-glance')
    await page.keyboard.press('Escape')
  })

  let phoneLink = ''
  await step(page, 'settings', async () => {
    for (const p of ['general', 'models', 'connected', 'permissions', 'memory', 'voice', 'privacy', 'usage', 'server', 'advanced']) {
      await settingsPage(page, p)
      await wait(page, p === 'usage' ? 900 : 300)
      await shoot(page, `settings-${p}`)
      await shootTall(page, `tall-settings-${p}`)
    }
    // General → More open (appearance, routines with the lid setting).
    await settingsPage(page, 'general')
    await page.click('[data-testid="settings-advanced-section"] > summary').catch(() => undefined)
    await wait(page, 300)
    await shootTall(page, 'tall-settings-general-more')
    // Models → Advanced (Fast mode).
    await settingsPage(page, 'models')
    await page.click('[data-testid="models-advanced"] > summary').catch(() => undefined)
    await page.locator('[data-testid="fast-mode"]').waitFor().catch(() => undefined)
    await wait(page, 300)
    await shootTall(page, 'tall-settings-models-advanced')
    // Memory → Decisions.
    await settingsPage(page, 'memory')
    await page.locator('button, [role="tab"]', { hasText: /^Decisions/ }).first().click().catch(() => undefined)
    await wait(page, 300)
    await shoot(page, 'settings-memory-decisions')
    // Phone access on: the QR code.
    await settingsPage(page, 'general')
    await page.click('[data-testid="phone-access-toggle"]')
    await page.waitForSelector('[data-testid="phone-qr"]', { timeout: 20_000 })
    await wait(page, 500)
    await page.locator('[data-setting="phone-access"]').scrollIntoViewIfNeeded()
    await shoot(page, 'settings-phone-on', () => page.locator('[data-setting="phone-access"]').scrollIntoViewIfNeeded())
    await shootTall(page, 'tall-settings-general-phone')
    const st = (await page.evaluate(() => window.foreman.phoneAccess!.status())) as PhoneAccessStatus
    phoneLink = st.pairing?.url ?? ''
    await page.click('[data-testid="settings-close"]')
  })

  // ---------------------------------------------------------------- the phone web UI (390×844)
  if (phoneLink && want('phone') && stepOn('phone')) {
    const browser = await chromium.launch({ headless: true, executablePath: chromiumPath() })
    for (const scheme of ['light', 'dark'] as const) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true, colorScheme: scheme, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1' })
      const phone = await ctx.newPage()
      await step(phone, `phone-${scheme}`, async () => {
        if (scheme === 'dark') {
          const st = (await page.evaluate(() => window.foreman.phoneAccess!.newCode?.() ?? window.foreman.phoneAccess!.status())) as PhoneAccessStatus
          phoneLink = st.pairing?.url ?? phoneLink
        }
        await phone.goto(phoneLink)
        await phone.waitForSelector('[data-testid="pair-submit"]')
        await phone.screenshot({ path: `${out}/phone-pair-${scheme}-390.png` })
        await phone.tap('[data-testid="pair-submit"]')
        await phone.waitForSelector('[data-testid="composer-input"]', { timeout: 30_000 })
        await phone.waitForTimeout(800)
        await phone.screenshot({ path: `${out}/phone-home-${scheme}-390.png` })
        llm.script.push({ toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path: join(mkdtempSync(join(tmpdir(), 'audit-out-')), 'from-phone.txt'), content: 'hi' }) }], delay: 0 }, { content: 'Okay, not written.', delay: 0 })
        await phone.fill('[data-testid="composer-input"]', 'Write hi to a file')
        await phone.keyboard.press('Enter')
        await phone.locator('[data-testid="approval-card"]').waitFor({ timeout: 20_000 })
        await phone.waitForTimeout(400)
        await phone.screenshot({ path: `${out}/phone-approval-${scheme}-390.png` })
        await phone.tap('[data-testid="approve-deny"]')
        await phone.waitForTimeout(800)
        llm.script.length = 0
        await phone.tap('[data-testid="header-settings"]').catch(() => undefined)
        await phone.waitForTimeout(500)
        await phone.screenshot({ path: `${out}/phone-settings-${scheme}-390.png` })
        await phone.tap('[data-testid="settings-server"]').catch(() => undefined)
        await phone.waitForTimeout(600)
        await phone.screenshot({ path: `${out}/phone-this-phone-${scheme}-390.png`, fullPage: true })
      })
      await ctx.close()
    }
    await browser.close()
  }

  await app.close()
  await site.close()
  await llm.close()
  if (errors.length) console.log(`FAILED STEPS:\n${errors.join('\n')}`)
  console.log(`Screenshots in ${out}`)
}, 3_000_000)
