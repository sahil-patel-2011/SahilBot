import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Review screenshots of the Grok Bot shape (not a regular test): home, sidebar with bots, a bot chat at work,
// a bot's profile, and the You settings page. Run with UI_SHOTS=<folder>.
const OUT = process.env.UI_SHOTS ?? join(tmpdir(), 'ui-shots')
let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
const snap = (name: string): void => { execFileSync('import', ['-window', 'root', join(OUT, `${name}.png`)]) }

test.skipIf(!process.env.UI_SHOTS)('grok-shape screenshots', async () => {
  mkdirSync(OUT, { recursive: true })
  const { ELECTRON_RUN_AS_NODE: _a, SAHILBOT_HIDDEN: _h, ...env } = process.env
  const app = await electron.launch({ args: ['--no-sandbox', resolve('out/main/index.js')], env: { ...env, FOREMAN_DATA_DIR: mkdtempSync(join(tmpdir(), 'ui-')), FOREMAN_BASE_URL: llm.url, FOREMAN_SKIP_ONBOARDING: '1', FOREMAN_NO_AUTOTITLE: '1', FOREMAN_NO_VERIFY: '1', FOREMAN_NO_BRAIN: '1', FOREMAN_RAM_GB: '32' } as Record<string, string> })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setBounds({ x: 0, y: 0, width: 1400, height: 880 }); w.show(); w.focus() })
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 60000 })
  await page.evaluate(async () => {
    await window.foreman.settings.set({ profile: { firstName: 'Sahil', lastName: 'Patel' } } as never)
    for (const [name, icon] of [['Homework Helper', '🧪'], ['CAD & Mechanical', '⚙️'], ['School and Studying', '📚'], ['Inbox', '📬']]) {
      const b = await window.foreman.spaces.create({ name, intro: false } as never)
      const id = (b as unknown as { space: { id: string } }).space.id; await window.foreman.spaces.update(id, { icon } as never)
    }
  })
  await page.reload()
  await page.waitForSelector('[data-testid="composer-input"]')
  await page.waitForTimeout(2000); snap('g1-home-and-sidebar')

  // A bot at work: "On it." and "<name> is working…", nothing else.
  llm.script.push({ toolCalls: [{ name: 'todo', arguments: JSON.stringify({ items: [{ text: 'Look up the chapter', status: 'in_progress' }] }) }], delay: 3500 }, { content: 'Here are three practice problems on balancing equations, with hints.', delay: 0 })
  await page.locator('[data-testid="space-item"]', { hasText: 'Homework Helper' }).click()
  await page.waitForSelector('[data-testid="composer-input"]')
  await page.fill('[data-testid="composer-input"]', 'Make me three practice problems for balancing chemical equations')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500); snap('g2-bot-working')
  await page.waitForTimeout(5000); snap('g3-bot-answer')

  // Its profile: routines, permissions and customize only.
  await page.click('[data-testid="bot-pill"]').catch(() => undefined)
  await page.waitForTimeout(1200); snap('g4-bot-profile')
  await page.keyboard.press('Escape')

  // The profile menu, then You in Settings.
  await page.click('[data-testid="profile"]')
  await page.waitForTimeout(600); snap('g5-profile-menu')
  await page.click('[data-testid="menu-settings"]')
  await page.waitForTimeout(1500); snap('g6-settings-you')
  await app.close()
}, 120_000)
