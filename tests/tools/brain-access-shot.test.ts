// Dev helper: screenshots of the brain-access work (light and dark): Connected apps with a per-app scope
// picker and the new setup tabs, Team access (invite + QR, teammates, Team questions), the teammate's Ask
// page, the Obsidian section of the knowledge vault, and the function bots in New bot. Hidden window.
// SHOTS_DIR=… npx vitest run -c vitest.tools.config.mts tests/tools/brain-access-shot.test.ts
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { chromium, type Page } from 'playwright'
import { launch, tempProfile } from '../accept/app'
import { startMockLlm } from '../fixtures/mock-llm'

/** The headless shell the phone access test uses. */
function chromiumPath(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH
  if (existsSync(chromium.executablePath())) return undefined
  const cache = join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright')
  if (!existsSync(cache)) return undefined
  for (const d of readdirSync(cache).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
    for (const sub of readdirSync(join(cache, d))) {
      const exe = join(cache, d, sub, 'chrome-headless-shell')
      if (existsSync(exe)) return exe
    }
  }
  return undefined
}

test('brain access shots', async () => {
  const out = process.env.SHOTS_DIR ?? mkdtempSync(join(tmpdir(), 'brain-shots-'))
  mkdirSync(out, { recursive: true })
  const llm = await startMockLlm()
  const { app, page } = await launch(tempProfile(), llm.url, { SAHILBOT_PHONE_TEST_BIND: '127.0.0.1', SAHILBOT_PHONE_PORT: '0', SAHILBOT_PHONE_WATCH_MS: '600000', SAHILBOT_TEST_MCP: '1' })
  await page.setViewportSize({ width: 1180, height: 860 })
  const both = async (name: string, shoot: (p: Page, file: string) => Promise<void>): Promise<void> => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.waitForTimeout(250)
    await shoot(page, join(out, `${name}-light.png`))
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForTimeout(250)
    await shoot(page, join(out, `${name}-dark.png`))
    await page.emulateMedia({ colorScheme: 'light' })
  }
  const openSettings = async (tab: string): Promise<void> => {
    if (!(await page.locator('[data-testid="settings"]').count())) { await page.keyboard.press('Meta+,'); await page.locator('[data-testid="settings"]').waitFor() }
    await page.click(`[data-testid="settings-${tab}"]`)
    await page.waitForTimeout(300)
  }
  const closeSettings = async (): Promise<void> => { if (await page.locator('[data-testid="settings-close"]').count()) await page.click('[data-testid="settings-close"]') }

  // ---- Connected apps: an app with its scope picker open.
  await page.evaluate(async () => {
    const f = (window as any).foreman
    await f.mcp.setEnabled(true)
    await f.mcp.createClient('Claude Desktop')
    await f.mcp.createClient('Cursor')
  })
  await openSettings('connected')
  await page.locator('[data-testid="connected-advanced"] summary').click()
  await page.waitForSelector('[data-testid="mcp-client-Claude Desktop"]')
  await page.click('[data-testid="mcp-scope-Claude Desktop"]')
  await page.click('[data-testid="mcp-scope-editor-src-texts"]').catch(() => undefined)
  await page.waitForTimeout(300)
  await both('mcp-scope', async (p, file) => { await p.locator('[data-setting="mcp-server"]').screenshot({ path: file }) })
  // The setup tabs (a fresh app's token and configs).
  await page.fill('[data-testid="mcp-client-name"]', 'Codex')
  await page.click('[data-testid="mcp-connect"]')
  await page.waitForSelector('[data-testid="mcp-new-client"]')
  await page.click('[data-testid="mcp-tab-chatgpt"]')
  await both('mcp-setup-chatgpt', async (p, file) => { await p.locator('[data-testid="mcp-new-client"]').screenshot({ path: file }) })
  await page.click('[data-testid="mcp-tab-codex"]')
  await page.locator('[data-testid="mcp-new-client"]').screenshot({ path: join(out, 'mcp-setup-codex-light.png') })
  await page.click('[data-testid="mcp-done"]')

  // ---- Team access: Phone access on, invite a teammate, a QR code.
  await openSettings('general')
  await page.click('[data-testid="phone-access-toggle"]')
  await page.waitForSelector('[data-testid="team-section"]', { timeout: 20_000 })
  await page.click('[data-testid="team-invite-open"]')
  await page.fill('[data-testid="team-name"]', 'Alex Rivera')
  await page.click('[data-testid="team-scope-src-accounting"]')
  await page.waitForTimeout(200)
  await both('team-invite-form', async (p, file) => { await p.locator('[data-testid="team-section"]').screenshot({ path: file }) })
  await page.click('[data-testid="team-invite-send"]')
  await page.waitForSelector('[data-testid="team-invite"]')
  const invite = await page.evaluate(async () => (await (window as any).foreman.team.status()).invite)
  await page.evaluate(async () => { await (window as any).foreman.team.invite({ name: 'Jordan Lee', role: 'Finance', scope: { sources: ['accounting', 'email'] } }) })
  await page.waitForTimeout(400)
  await both('team-section', async (p, file) => { await p.locator('[data-testid="team-section"]').screenshot({ path: file }) })

  // ---- The teammate's page: join with the code, ask, get routed to the owner.
  const browser = await chromium.launch({ headless: true, executablePath: chromiumPath() })
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
  if (invite) {
    const tp = await ctx.newPage()
    await tp.setViewportSize({ width: 420, height: 760 })
    await tp.goto(invite.url)
    await tp.waitForSelector('[data-testid="team-join"]')
    await tp.screenshot({ path: join(out, 'team-join-light.png') })
    await tp.click('[data-testid="team-join-submit"]')
    await tp.waitForSelector('[data-testid="team-ask"]')
    await tp.fill('[data-testid="team-question"]', 'What did we promise Partner B?')
    await tp.click('[data-testid="team-ask-submit"]')
    await tp.waitForTimeout(1500)
    await tp.emulateMedia({ colorScheme: 'light' })
    await tp.screenshot({ path: join(out, 'team-ask-light.png') })
    await tp.emulateMedia({ colorScheme: 'dark' })
    await tp.screenshot({ path: join(out, 'team-ask-dark.png') })
  }
  await ctx.close()
  await browser.close()
  await page.waitForTimeout(500)
  await page.locator('[data-testid="team-section"]').screenshot({ path: join(out, 'team-questions-light.png') })
  // The question the brain couldn't answer is waiting for the owner in Needs you.
  const inbox = await page.evaluate(async () => (await (window as any).foreman.needsYou.list()).map((x: any) => x.questions?.[0]?.question ?? ''))
  if (!inbox.some((q: string) => q.includes('asked your brain'))) throw new Error(`Needs you has no team question: ${JSON.stringify(inbox)}`)
  // The owner answers there; it goes back to the teammate (no bot run).
  const answered = await page.evaluate(async () => {
    const f = (window as any).foreman
    const item = (await f.needsYou.list()).find((x: any) => String(x.questions?.[0]?.question ?? '').includes('asked your brain'))
    await f.needsYou.answer(item.id, ['Net 30, per the Oct 14 email.'])
    await new Promise((r) => setTimeout(r, 800))
    return (await f.team.status()).questions[0]
  })
  if (answered?.status !== 'owner' || answered.ownerAnswer !== 'Net 30, per the Oct 14 email.') throw new Error(`owner answer not delivered: ${JSON.stringify(answered)}`)

  // ---- Knowledge vault: the Obsidian section.
  await openSettings('memory')
  await page.click('[data-testid="settings-tab-vault"]')
  await page.waitForSelector('[data-testid="obsidian-section"]')
  await page.locator('[data-testid="obsidian-section"]').scrollIntoViewIfNeeded()
  await both('obsidian', async (p, file) => { await p.locator('[data-testid="obsidian-section"]').screenshot({ path: file }) })
  await closeSettings()

  // ---- New bot: the function bots.
  await page.click('[data-testid="new-bot"]')
  await page.waitForSelector('[data-testid="function-bots"]')
  await both('function-bots', async (p, file) => { await p.locator('[data-testid="function-bots"]').screenshot({ path: file }) })
  await page.keyboard.press('Escape')

  console.log(`shots in ${out}`)
  await app.close()
  await llm.close()
}, 180_000)
