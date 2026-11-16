// Dev helper (intuitiveness pass): seven everyday tasks, scripted the way a new user would do them, counting
// clicks, keys, typed fields and screens. Hidden window, mock model, fake OAuth app; no paid calls.
//   npm run build && SHOTS_DIR=<dir> SAHILBOT_HIDDEN=1 npx vitest run --config vitest.tools.config.mts tests/tools/ux-walkthrough.test.ts --silent=false
// WALK_PHASE=before records the numbers into tests/tools/ux-walkthrough.before.json (run against the old UI);
// the default (after) writes <SHOTS_DIR>/steps.json with both, plus a screenshot of each task's end state.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Locator, Page } from 'playwright'
import { test } from 'vitest'
import { launch, tempProfile } from '../accept/app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { startFakeServer } from '../fixtures/fake-oauth-mcp'

const out = process.env.SHOTS_DIR ?? join(tmpdir(), 'ux-walkthrough')
mkdirSync(out, { recursive: true })
const PHASE = process.env.WALK_PHASE === 'before' ? 'before' : 'after'
const BEFORE_FILE = resolve('tests/tools/ux-walkthrough.before.json')

interface Result { clicks: number; keys: number; typed: number; screens: string[]; ms: number; ok: boolean; note?: string }

/** Counts what the user does: pointer clicks, key presses (shortcuts, Enter), fields typed into, screens seen. */
class Meter {
  clicks = 0
  keys = 0
  typed = 0
  screens: string[] = []
  private t0 = Date.now()
  constructor(public page: Page) {}
  private loc(s: string | Locator): Locator { return typeof s === 'string' ? this.page.locator(s).first() : s }
  async click(s: string | Locator): Promise<void> { await this.loc(s).click({ timeout: 15_000 }); this.clicks++ }
  async key(k: string): Promise<void> { await this.page.keyboard.press(k); this.keys++ }
  async type(s: string | Locator, text: string): Promise<void> { await this.loc(s).fill(text, { timeout: 15_000 }); this.typed++ }
  screen(name: string): void { if (this.screens.at(-1) !== name) this.screens.push(name) }
  done(ok = true, note?: string): Result { return { clicks: this.clicks, keys: this.keys, typed: this.typed, screens: this.screens, ms: Date.now() - this.t0, ok, ...(note ? { note } : {}) } }
}

const call = (name: string, args: unknown) => ({ toolCalls: [{ name, arguments: JSON.stringify(args) }], delay: 0 })
const idle = async (page: Page, llm: MockLlm, ms = 30_000): Promise<void> => {
  const end = Date.now() + ms
  while (Date.now() < end && (llm.script.length || (await page.locator('[data-testid="stop"]').count()))) await page.waitForTimeout(150)
  await page.waitForTimeout(300)
}
const answer = (page: Page, text: string) => page.locator('[data-testid="assistant-bubble"]', { hasText: text }).first().waitFor({ timeout: 30_000 })

type Task = { id: string; title: string; run: (llm: MockLlm) => Promise<Result> }

const results: Record<string, Result> = {}

async function withApp<T>(llm: MockLlm, env: Record<string, string>, fn: (page: Page, app: ElectronApplication) => Promise<T>): Promise<T> {
  const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64', ...env })
  await page.setViewportSize({ width: 1280, height: 800 })
  try { return await fn(page, app) } catch (e) {
    await page.screenshot({ path: `${out}/zz-fail-${PHASE}-${Date.now()}.png` }).catch(() => undefined)
    throw e
  } finally { await app.close() }
}
const shot = (page: Page, id: string): Promise<unknown> => page.screenshot({ path: `${out}/walk-${id}-${PHASE}.png` }).catch(() => undefined)

const TASKS: Task[] = [
  {
    id: 'a', title: 'First run → connect a Claude key → first answer',
    run: (llm) => withApp(llm, { FOREMAN_SKIP_ONBOARDING: '', FOREMAN_ANTHROPIC_URL: llm.url }, async (page) => {
      const m = new Meter(page)
      await page.waitForSelector('[data-testid="onboarding"]')
      m.screen('onboarding: name')
      await m.type('[data-testid="onboarding-name"]', 'Sam')
      await m.click('[data-testid="onboarding-name-next"]')
      m.screen('onboarding: connect AI')
      await m.type('[data-testid="onboarding-key"]', 'sk-ant-test-key')
      await m.key('Enter')
      await page.locator('[data-testid="onboarding-connect-anthropic"] .conn.ok').waitFor({ timeout: 15_000 })
      await m.click('[data-testid="onboarding-next"]')
      if (PHASE === 'before') {
        m.screen('onboarding: workspace')
        await m.click('[data-testid="onboarding-workspace-next"]')
        m.screen('onboarding: import memory')
        await m.click('[data-testid="onboarding-finish"]')
      } else if (await page.locator('[data-testid="onboarding-finish"]').count()) {
        m.screen('onboarding: ready')
        await m.click('[data-testid="onboarding-finish"]')
      }
      await page.locator('[data-testid="onboarding"]').waitFor({ state: 'detached', timeout: 10_000 })
      m.screen('home')
      llm.script.push({ content: 'Hi Sam! Here is your first answer.' })
      await m.type('[data-testid="composer-input"]', 'Hello there')
      await m.key('Enter')
      await answer(page, 'first answer')
      m.screen('chat')
      await shot(page, 'a')
      return m.done()
    })
  },
  {
    id: 'b', title: 'Make a bot with a job ("Track my competitors weekly") → it runs',
    run: (llm) => withApp(llm, {}, async (page) => {
      const m = new Meter(page)
      m.screen('home')
      await m.click('[data-testid="new-bot"]')
      m.screen('new bot')
      if (PHASE === 'before') {
        await m.type('[data-testid="bot-name"]', 'Competitor Watch')
        await m.type('[data-testid="bot-editor"] textarea', 'Track my competitors weekly')
        await m.click('[data-testid="bot-save"]')
        m.screen('bot chat')
        await page.waitForSelector('[data-testid="composer-input"]')
        llm.script.push({ content: 'On it: I will track your competitors every week.' })
        await m.type('[data-testid="composer-input"]', 'Track my competitors weekly')
        await m.key('Enter')
      } else {
        // The name is optional now: the bot is named after its job.
        await m.type('[data-testid="bot-job"]', 'Track my competitors weekly')
        llm.script.push({ content: 'On it: I will track your competitors every week.' })
        await m.click('[data-testid="bot-save"]')
        m.screen('bot chat')
        // The job is in the box, ready to send.
        await page.waitForFunction(() => (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement | null)?.value.includes('competitors'), null, { timeout: 10_000 })
        await m.key('Enter')
      }
      await answer(page, 'track your competitors')
      await shot(page, 'b')
      return m.done()
    })
  },
  {
    id: 'c', title: 'Connect an app (one-click OAuth) → use it in a chat',
    run: async (llm) => {
      const fake = await startFakeServer({ name: 'chatter', dcr: false, staticClients: { 'sahilbot-test-client': '' }, tools: [{ name: 'list_items', description: 'Lists your Chatter messages', readOnly: true, reply: () => 'Standup at 10; Ship it' }] })
      const dir = tempProfile()
      try {
        return await withApp(llm, {
          SAHILBOT_TEST_OAUTH_FETCH: '1', SAHILBOT_TEST_EXTERNAL_LOG: join(dir, 'opened.jsonl'),
          SAHILBOT_TEST_PRESETS: JSON.stringify([{ id: 'test-chatter', name: 'Chatter', url: fake.url, auth: 'oauth-static', description: 'Your team chat.' }]),
          SAHILBOT_OAUTH_CLIENTS_JSON: JSON.stringify({ 'test-chatter': { clientId: 'sahilbot-test-client', redirect: 'loopback' } })
        }, async (page) => {
          const m = new Meter(page)
          m.screen('home')
          await m.click('[data-testid="connect-apps"]')
          m.screen('connect apps')
          await m.click('[data-testid="preset-test-chatter"]')
          await page.waitForFunction(() => document.querySelector('[data-testid="preset-test-chatter"]')?.getAttribute('data-state') === 'connected', null, { timeout: 30_000 })
          const TOOL = 'chatter__list_items'
          llm.script.push(
            { toolCalls: [{ name: 'find_tools', arguments: '{"query":"chatter messages"}' }] },
            { toolCalls: [{ name: TOOL, arguments: '{}' }] },
            { content: 'Chatter says: Standup at 10; Ship it.' }
          )
          if (PHASE === 'after' && await page.locator('[data-testid="try-app-test-chatter"]').count()) {
            // Connected: "Try it" starts a chat with a suggested first message.
            await m.click('[data-testid="try-app-test-chatter"]')
            m.screen('chat')
            await page.waitForFunction(() => !!(document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement | null)?.value, null, { timeout: 10_000 })
            await m.key('Enter')
          } else {
            await m.key('Escape')
            m.screen('home')
            await m.type('[data-testid="composer-input"]', 'What are my latest Chatter messages?')
            await m.key('Enter')
            m.screen('chat')
          }
          await answer(page, 'Standup at 10')
          await shot(page, 'c')
          return m.done()
        })
      } finally { await fake.close() }
    }
  },
  {
    id: 'd', title: 'Run a task that makes a file → find and open the file',
    run: (llm) => {
      const ws = mkdtempSync(join(tmpdir(), 'walk-ws-'))
      return withApp(llm, {}, async (page) => {
        await page.evaluate((w) => window.foreman.settings.set({ workspaceDir: w }), ws)
        const m = new Meter(page)
        m.screen('home')
        llm.script.push(call('file_write', { path: 'team-plan.md', content: '# Team plan\nBest value for 5 people: $75/month.' }), { content: 'Saved the team plan to team-plan.md.' })
        await m.type('[data-testid="composer-input"]', 'Write our team plan to a file')
        await m.key('Enter')
        m.screen('chat')
        await answer(page, 'Saved the team plan')
        if (PHASE === 'before') {
          await m.click('[data-testid="activity-head"]')
          await m.click('[data-testid="tool-chip"][data-tool="file_write"] .step-row')
          await m.click(page.locator('.step-detail button', { hasText: 'Open' }))
        } else {
          await m.click('[data-testid="made-file-open"]')
        }
        await page.locator('[data-testid="right-panel"], .rpanel, .right-panel').first().waitFor({ timeout: 10_000 }).catch(() => undefined)
        m.screen('file preview')
        await page.waitForTimeout(400)
        await shot(page, 'd')
        return m.done()
      })
    }
  },
  {
    id: 'e', title: 'Change a setting via search ("monthly limit")',
    run: (llm) => withApp(llm, {}, async (page) => {
      const m = new Meter(page)
      m.screen('home')
      // A new user starts with the app's search (⌘K or the magnifier).
      await m.key('Meta+k')
      m.screen('search')
      await m.type('[data-testid="palette-input"]', 'monthly limit')
      if (PHASE === 'before') {
        // Nothing matches: close it and look in Settings instead.
        await m.key('Escape')
        await m.click('[title="Settings (⌘,)"]')
        m.screen('settings')
        await m.type('[data-testid="settings-search"]', 'monthly limit')
        await m.click('[data-testid="settings-result-monthly-limit"]')
      } else {
        await m.key('Enter')
        m.screen('settings')
      }
      const input = page.locator('[data-testid="budget-cap"]')
      await input.waitFor({ timeout: 10_000 })
      await m.type(input, '150')
      await m.key('Enter')
      await page.waitForFunction(async () => (await window.foreman.settings.get()).cloudBudgetUsd === 150, null, { timeout: 10_000 })
      await shot(page, 'e')
      return m.done()
    })
  },
  {
    id: 'f', title: 'Answer a bot\'s question from Needs you',
    run: (llm) => withApp(llm, { FOREMAN_ASK_GRACE_MS: '0' }, async (page) => {
      // Setup (not counted): a bot asks a question while the user is away.
      const ws = mkdtempSync(join(tmpdir(), 'walk-ws-'))
      await page.evaluate((w) => window.foreman.settings.set({ workspaceDir: w }), ws)
      await page.evaluate(() => window.foreman.spaces.create({ name: 'Trip Planner', intro: false }))
      await page.reload()
      await page.waitForSelector('[data-testid="composer-input"]')
      await page.locator('[data-testid="space-item"]', { hasText: 'Trip Planner' }).click()
      await page.waitForFunction(() => document.querySelector('[data-testid="bot-pill"]')?.textContent?.includes('Trip Planner'), null, { timeout: 10_000 })
      await page.waitForTimeout(300)
      llm.script.push(
        call('file_write', { path: join(ws, 'research.md'), content: '# Flights\nOptions gathered.' }),
        { toolCalls: [{ name: 'ask_user', arguments: JSON.stringify({ question: 'Which hotel area do you prefer?', options: ['Old town (recommended)', 'Near the airport'], preference: true }) }] },
        { content: 'The hotel waits on your choice of area.' }
      )
      await page.fill('[data-testid="composer-input"]', 'Plan my Lisbon trip')
      await page.keyboard.press('Enter')
      await idle(page, llm)
      await page.waitForFunction(async () => (await window.foreman.needsYou.list()).length > 0, null, { timeout: 15_000 })
      await page.locator('[data-testid="main-bot"]').click()
      await page.waitForTimeout(500)
      llm.script.push({ content: 'Great, the airport it is. All done.' })
      const m = new Meter(page)
      m.screen('home')
      await m.click('[data-testid="nav-tasks"]')
      m.screen('needs you')
      await m.click(page.locator('[data-testid="needs-you-item"] [data-testid="needs-you-option"]', { hasText: 'Near the airport' }))
      await page.waitForFunction(async () => (await window.foreman.needsYou.list()).length === 0, null, { timeout: 15_000 })
      await shot(page, 'f')
      return m.done()
    })
  },
  {
    id: 'g', title: 'Turn on Max for one message',
    run: (llm) => withApp(llm, {}, async (page) => {
      const m = new Meter(page)
      m.screen('home')
      await m.click('[data-testid="modes-menu"]')
      await m.click('[data-testid="max-toggle"]')
      await page.locator('[data-testid="mode-chip-max"]').waitFor({ timeout: 5000 })
      await shot(page, 'g')
      return m.done()
    })
  }
]

test('ux walkthrough: clicks and screens per task', async () => {
  const llm = await startMockLlm()
  llm.models = ['qwen3.8:27b', 'llama3.3:70b']
  const only = (process.env.ONLY ?? '').split(',').filter(Boolean)
  try {
    for (const t of TASKS) {
      if (only.length && !only.includes(t.id)) continue
      llm.script.length = 0
      try { results[t.id] = await t.run(llm) } catch (e) { results[t.id] = { clicks: 0, keys: 0, typed: 0, screens: [], ms: 0, ok: false, note: (e as Error).message.split('\n')[0] } }
      console.log(`[walk ${PHASE}] ${t.id} ${t.title}: ${JSON.stringify(results[t.id])}`)
    }
  } finally { await llm.close() }
  const titles = Object.fromEntries(TASKS.map((t) => [t.id, t.title]))
  if (PHASE === 'before') {
    writeFileSync(BEFORE_FILE, `${JSON.stringify({ recorded: new Date().toISOString(), tasks: results }, null, 2)}\n`)
    return
  }
  const before = existsSync(BEFORE_FILE) ? (JSON.parse(readFileSync(BEFORE_FILE, 'utf8')) as { tasks: Record<string, Result> }).tasks : {}
  const steps = Object.fromEntries(Object.keys(results).map((id) => {
    const b = before[id], a = results[id]
    const total = (r?: Result): number | null => (r ? r.clicks + r.keys + r.typed : null)
    return [id, { title: titles[id], before: b ?? null, after: a, actions: { before: total(b), after: total(a) }, screens: { before: b?.screens.length ?? null, after: a.screens.length } }]
  }))
  writeFileSync(join(out, 'steps.json'), `${JSON.stringify(steps, null, 2)}\n`)
  console.log(`steps.json → ${join(out, 'steps.json')}`)
}, 600_000)
