// Dev helper (intuitiveness pass): every surface this pass changed, light and dark, at 1280 and 900 wide.
// Mock model, fake OAuth app, hidden window; no paid calls.
//   npm run build && SHOTS_DIR=<dir> SAHILBOT_HIDDEN=1 npx vitest run --config vitest.tools.config.mts tests/tools/ux-pass-shots.test.ts --silent=false
// Optional: ONLY=<comma list of shot-name prefixes>. Failed steps are listed at the end and leave a zz-fail-*.png.
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright'
import { test } from 'vitest'
import { launch, tempProfile } from '../accept/app'
import { startMockLlm, type MockLlm, type ScriptedReply } from '../fixtures/mock-llm'
import { startFakeServer } from '../fixtures/fake-oauth-mcp'

const out = process.env.SHOTS_DIR ?? join(tmpdir(), 'ux-pass-shots')
mkdirSync(out, { recursive: true })
const SIZES = [{ w: 1280, h: 800 }, { w: 900, h: 640 }] as const
const only = (process.env.ONLY ?? '').split(',').map((x) => x.trim()).filter(Boolean)
const errors: string[] = []
const wait = (page: Page, ms: number): Promise<void> => page.waitForTimeout(ms)
const want = (name: string): boolean => !only.length || only.some((o) => name.startsWith(o))

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
async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn() } catch (e) {
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
const setMode = async (page: Page, id: string): Promise<void> => {
  await page.click('[data-testid="model-picker"]')
  await page.click('[data-testid="mode-picker"]')
  await page.click(`[data-testid="mode-${id}"]`)
}
const newChat = async (page: Page): Promise<void> => { await page.click('[data-testid="new-chat"]'); await page.waitForSelector('[data-testid="composer-input"]'); await wait(page, 300) }

test('intuitiveness-pass screenshots', async () => {
  const llm = await startMockLlm()
  llm.models = ['qwen3.8:27b', 'llama3.3:70b', 'claude-opus-5-5', 'gpt-6.1-sol']

  // ---------------------------------------------------------------- onboarding (first run)
  {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_SKIP_ONBOARDING: '', FOREMAN_ANTHROPIC_URL: llm.url })
    await step(page, 'onboarding', async () => {
      await page.waitForSelector('[data-testid="onboarding"]')
      await page.fill('[data-testid="onboarding-name"]', 'Sahil')
      await shoot(page, 'onboard-1-name')
      await page.click('[data-testid="onboarding-name-next"]')
      await page.click('[data-testid="onboarding-about-next"]')
      await page.fill('[data-testid="onboarding-key"]', 'sk-ant-test-key')
      await page.keyboard.press('Enter')
      await page.locator('[data-testid="onboarding-connect-anthropic"] .conn.ok').waitFor({ timeout: 15_000 })
      await shoot(page, 'onboard-2-connect')
    })
    await app.close()
  }

  // ---------------------------------------------------------------- the main app
  const fake = await startFakeServer({ name: 'chatter', dcr: false, staticClients: { 'sahilbot-test-client': '' }, tools: [{ name: 'list_items', description: 'Lists your Chatter messages', readOnly: true, reply: () => 'Standup at 10; Ship it' }] })
  const dir = tempProfile()
  const ws = mkdtempSync(join(tmpdir(), 'ux-ws-'))
  const { app, page } = await launch(dir, llm.url, {
    FOREMAN_RAM_GB: '64', FOREMAN_ASK_GRACE_MS: '0',
    SAHILBOT_TEST_OAUTH_FETCH: '1', SAHILBOT_TEST_EXTERNAL_LOG: join(dir, 'opened.jsonl'),
    SAHILBOT_TEST_PRESETS: JSON.stringify([{ id: 'test-chatter', name: 'Chatter', url: fake.url, auth: 'oauth-static', description: 'Your team chat.' }]),
    SAHILBOT_OAUTH_CLIENTS_JSON: JSON.stringify({ 'test-chatter': { clientId: 'sahilbot-test-client', redirect: 'loopback' } })
  })
  page.setDefaultTimeout(15_000)
  await page.evaluate(async (w) => {
    const api = (window as any).foreman
    await api.settings.set({ userName: 'Sahil Patel', workspaceDir: w })
    await api.spaces.create({ name: 'Finance', color: '#30a46c', intro: false })
    const r = await api.spaces.create({ name: 'Research', color: '#3b6fd4', intro: false })
    await api.spaces.update(r.space.id, { label: 'Deep dives on demand' })
    await api.spaces.create({ name: 'Writer', color: '#7c5cff', intro: false })
  }, ws)
  await page.reload()
  await page.waitForSelector('[data-testid="composer-input"]')
  await wait(page, 600)

  await step(page, 'home', async () => {
    await shoot(page, 'home')
    await page.click('[data-testid="working-folder"]')
    await wait(page, 250)
    await shoot(page, 'home-folder-menu', undefined, [SIZES[0]])
    await page.keyboard.press('Escape')
  })

  await step(page, 'picker', async () => {
    await page.click('[data-testid="model-picker"]')
    await wait(page, 250)
    await shoot(page, 'picker-auto', undefined, [SIZES[0]])
    await page.click('[data-testid="mode-picker"]')
    await wait(page, 250)
    await shoot(page, 'picker-permissions', undefined, [SIZES[0]])
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    // A picked model: Thinking appears.
    await page.click('[data-testid="model-picker"]')
    await page.locator('[data-testid="model-option"]:not([data-auto])').first().click()
    await page.click('[data-testid="model-picker"]')
    await page.click('[data-testid="thinking-picker"]')
    await wait(page, 250)
    await shoot(page, 'picker-manual-thinking', undefined, [SIZES[0]])
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    // Back to Auto: no Thinking row.
    await page.click('[data-testid="model-picker"]')
    await page.click('[data-testid="model-option"][data-auto="auto"]')
  })

  await step(page, 'bypass', async () => {
    llm.script.push({ content: 'Hello!' })
    await send(page, 'Hi')
    await idle(page, llm)
    await setMode(page, 'bypass')
    await page.locator('[data-testid="bypass-confirm"]').waitFor()
    await shoot(page, 'bypass-confirm', undefined, [SIZES[0]])
    await page.click('[data-testid="bypass-confirm-ok"]')
    await page.locator('[data-testid="bypass-chip"]').waitFor()
    await shoot(page, 'bypass-on', () => bottom(page))
    await setMode(page, 'auto')
  })

  await step(page, 'approvals', async () => {
    await newChat(page)
    await setMode(page, 'ask')
    llm.script.push(call('file_write', { path: 'team-plan-summary.md', content: '# Team plan\n\nBest value for **5 people**: $75/month.\n\n- Shared workspace\n- Priority support\n- Cancel anytime' }, "I'll save the summary next to your notes."))
    await send(page, 'Save that summary to a file')
    const card = page.locator('[data-testid="approval-card"]').first()
    await card.waitFor()
    await wait(page, 300)
    await shootEl(page, 'card-approval-file', card)
    await shoot(page, 'chat-approval-file', () => bottom(page))
    llm.script.push(call('run_command', { command: 'npm ci && npm test', cwd: ws }), { content: 'Done.' })
    await card.locator('[data-testid="approve-once"]').click()
    const cmd = page.locator('[data-testid="approval-card"]').first()
    await cmd.waitFor()
    await wait(page, 300)
    await shootEl(page, 'card-approval-command', cmd)
    await cmd.locator('[data-testid="approve-deny"]').click()
    await idle(page, llm)
    await shoot(page, 'chat-made-file', () => bottom(page))
    await setMode(page, 'auto')
  })

  await step(page, 'approval-message', async () => {
    await newChat(page)
    await setMode(page, 'ask')
    llm.script.push(call('mail', { action: 'send', to: ['sam@example.com'], subject: 'Q3 numbers', body: 'Hi Sam,\n\nQ3 spend was $12,400, mostly ads ($7,900) and flour ($2,100). Full breakdown attached.\n\nThanks,\nSahil' }), { content: 'Okay, not sent.' })
    await send(page, 'Email Sam the Q3 numbers')
    const card = page.locator('[data-testid="approval-card"]').first()
    await card.waitFor()
    await wait(page, 300)
    await shootEl(page, 'card-approval-email', card)
    await card.locator('[data-testid="approve-deny"]').click()
    await idle(page, llm)
    await setMode(page, 'auto')
  })

  await step(page, 'running', async () => {
    await newChat(page)
    llm.script.push({ content: 'Working on it, one moment while I look through everything carefully and put it together for you.', delay: 250, usage: { prompt: 26_000, completion: 80 } })
    await send(page, 'Summarize this week')
    await page.locator('[data-testid="steer-hint"]').waitFor()
    await page.fill('[data-testid="composer-input"]', 'Also add a section on hiring')
    await shoot(page, 'chat-running', () => bottom(page), [SIZES[0]])
    await page.fill('[data-testid="composer-input"]', '')
    await idle(page, llm)
    await shoot(page, 'chat-done-status', () => bottom(page))
  })

  await step(page, 'palette', async () => {
    await page.keyboard.press('Meta+k')
    await page.fill('[data-testid="palette-input"]', 'monthly limit')
    await wait(page, 250)
    await shoot(page, 'palette-settings', undefined, [SIZES[0]])
    await page.keyboard.press('Escape')
  })

  await step(page, 'needs-you', async () => {
    await page.locator('[data-testid="space-item"]', { hasText: 'Finance' }).click()
    await page.waitForFunction(() => document.querySelector('[data-testid="bot-pill"]')?.textContent?.includes('Finance'))
    await wait(page, 300)
    llm.script.push(
      call('file_write', { path: join(ws, 'q3.md'), content: '# Q3\nNumbers gathered.' }),
      { toolCalls: [{ name: 'ask_user', arguments: JSON.stringify({ question: 'Which budget should the report use?', options: ['Marketing (recommended)', 'Operations'], preference: true }) }] },
      { content: 'The report waits on your choice of budget.' }
    )
    await send(page, 'Prepare the Q3 report')
    await idle(page, llm)
    await page.locator('[data-testid="main-bot"]').click()
    await wait(page, 600)
    await shoot(page, 'sidebar-needs-you')
    await page.click('[data-testid="nav-tasks"]')
    await page.locator('[data-testid="needs-you-item"]').first().waitFor()
    await shoot(page, 'view-needs-you')
  })

  await step(page, 'bot-details', async () => {
    await page.locator('[data-testid="space-item"]', { hasText: 'Finance' }).click()
    await page.click('[data-testid="bot-pill"]')
    await page.locator('[data-testid="bot-details"]').waitFor()
    await wait(page, 400)
    await shoot(page, 'view-bot-details')
    const h = await page.evaluate(() => (document.querySelector('[data-testid="bot-details"] .bd-body') as HTMLElement | null)?.scrollHeight ?? 1400)
    for (const w of [1280, 900]) {
      await page.setViewportSize({ width: w, height: Math.min(2600, h + 380) })
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme })
        await wait(page, 250)
        if (want('view-bot-details-tall')) await page.screenshot({ path: `${out}/view-bot-details-tall-${scheme}-${w}.png` })
      }
    }
    await page.emulateMedia({ colorScheme: 'light' })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.keyboard.press('Escape')
  })

  await step(page, 'new-bot', async () => {
    await page.click('[data-testid="new-bot"]')
    await page.locator('[data-testid="bot-editor"]').waitFor()
    await page.fill('[data-testid="bot-job"]', 'Track my competitors weekly and tell me what changed')
    await wait(page, 500)
    await shoot(page, 'new-bot')
    await page.click('[data-testid="bot-save"]')
    await page.waitForFunction(() => (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement | null)?.value.includes('competitors'), null, { timeout: 10_000 })
    await wait(page, 300)
    await shoot(page, 'new-bot-chat')
  })

  await step(page, 'connect', async () => {
    await page.click('[data-testid="connect-apps"]')
    await page.locator('[data-testid="connect-apps-modal"]').waitFor()
    await wait(page, 500)
    await shoot(page, 'connect-browse')
    await page.click('[data-testid="preset-test-chatter"]')
    await page.waitForFunction(() => document.querySelector('[data-testid="preset-test-chatter"]')?.getAttribute('data-state') === 'connected', null, { timeout: 30_000 })
    await page.locator('[data-testid="preset-test-chatter"]').scrollIntoViewIfNeeded()
    await wait(page, 300)
    await shoot(page, 'connect-connected')
    await page.keyboard.press('Escape')
  })

  await app.close()
  await fake.close()
  await llm.close()
  if (errors.length) console.log(`FAILED STEPS:\n${errors.join('\n')}`)
}, 600_000)
