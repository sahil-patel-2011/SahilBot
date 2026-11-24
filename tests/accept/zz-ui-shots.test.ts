import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// UI review screenshots (not a regular test): the real window on Xvfb, captured from the X display.
const OUT = process.env.UI_SHOTS ?? join(tmpdir(), 'ui-shots')
let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
const snap = (name: string): void => { execFileSync('import', ['-window', 'root', join(OUT, `${name}.png`)]) }

test.skipIf(!process.env.UI_SHOTS)('ui screenshots', async () => {
  mkdirSync(OUT, { recursive: true })
  const { ELECTRON_RUN_AS_NODE: _a, SAHILBOT_HIDDEN: _h, ...env } = process.env
  const app = await electron.launch({ args: ['--no-sandbox', resolve('out/main/index.js')], env: { ...env, FOREMAN_DATA_DIR: mkdtempSync(join(tmpdir(), 'ui-')), FOREMAN_BASE_URL: llm.url, FOREMAN_SKIP_ONBOARDING: '1', FOREMAN_NO_AUTOTITLE: '1', FOREMAN_NO_VERIFY: '1', FOREMAN_NO_BRAIN: '1', FOREMAN_RAM_GB: '32' } as Record<string, string> })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setBounds({ x: 0, y: 0, width: 1400, height: 880 }); w.show(); w.focus() })
  await page.waitForSelector('[data-testid="composer-input"]', { timeout: 60000 })
  await page.evaluate(() => window.foreman.settings.set({ profile: { firstName: 'Sahil', lastName: 'Patel' } } as never))
  await page.waitForTimeout(2500); snap('01-home')
  // A chat: the reply asks a question with options (the duplicated "what to focus on?" from the user's screenshot).
  llm.script.push({ toolCalls: [{ name: 'ask_user', arguments: JSON.stringify({ question: 'What do you want me to focus on?', options: ['Research', 'Documents', 'Code', 'Planning'] }) }] }, { content: 'I can research, draft and edit documents, build presentations and spreadsheets, work on code and CAD, and help with everyday planning. Pick an option or type your own, and I\'ll tailor my help to it.' })
  await page.fill('[data-testid="composer-input"]', 'Tell me what you can do')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(4000); snap('02-chat-question')
  ;(await import('node:fs')).writeFileSync(join(OUT, 'msgs.json'), JSON.stringify(await page.evaluate(async () => { const ts = await window.foreman.threads.list(); return Promise.all(ts.map((t: { id: string }) => window.foreman.threads.messages(t.id))) }).catch((e) => String(e)), null, 1))
  // Voice.
  await page.click('[data-testid="voice-btn"]', { timeout: 5000 }).catch(() => undefined)
  await page.waitForTimeout(2500); snap('03-voice')
  await page.keyboard.press('Escape'); await page.waitForTimeout(800)
  await page.click('[data-testid="voice-end"]', { timeout: 2000 }).catch(() => undefined)
  // Composer menus and the chat header.
  const pop = async (sel: string, name: string): Promise<void> => {
    if (await page.locator(sel).first().click({ timeout: 2000 }).then(() => true).catch(() => false)) { await page.waitForTimeout(900); snap(name); await page.keyboard.press('Escape'); await page.waitForTimeout(500) }
  }
  await pop('.composer-bar .plus-pop > button', '04-composer-plus')
  await pop('[data-testid="agent-strategy"]', '05-composer-model')
  await pop('.wf-pick > button, button.wf-pick', '06-composer-folder')
  await pop('[data-testid="bot-pill"]', '07-header-bot')
  for (const [id, name] of [['nav-tasks', '30-needs-you'], ['nav-artifacts', '31-artifacts'], ['nav-brain', '32-brain'], ['nav-search', '33-search']] as const) {
    await page.click(`[data-testid="${id}"]`, { timeout: 2000 }).catch(() => undefined)
    await page.waitForTimeout(1800); snap(name)
    await page.keyboard.press('Escape'); await page.waitForTimeout(500)
  }
  await page.click('[data-testid="new-chat"]').catch(() => undefined); await page.waitForTimeout(800)
  // Settings, every page.
  await page.click('[data-testid="profile"]'); await page.waitForTimeout(1500)
  for (const id of ['general', 'models', 'connected', 'memory', 'privacy', 'voice', 'server']) {
    await page.click(`[data-testid="settings-${id}"]`, { timeout: 3000 }).catch(() => undefined)
    await page.waitForTimeout(1500); snap(`10-settings-${id}`)
  }
  await page.keyboard.press('Escape'); await page.waitForTimeout(600)
  await page.click('[data-testid="profile"]'); await page.click('[data-testid="connect-apps"]').catch(() => undefined); await page.waitForTimeout(2000); snap('20-connect-apps')
  await page.keyboard.press('Escape'); await page.waitForTimeout(600)
  await page.click('[data-testid="nav-vault"]').catch(() => undefined); await page.waitForTimeout(2000); snap('21-vault')
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))])
}, 300000)
