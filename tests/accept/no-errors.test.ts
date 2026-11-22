import { chmodSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile, expandMoreSettings } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { startFakeServer } from '../fixtures/fake-oauth-mcp'

// No complex setup, no errors: a first run, start to finish, with nothing going wrong underneath. Any
// renderer console error, page error or main-process unhandled rejection (index.ts logs those with the
// "[sahilbot] unhandledRejection" marker) fails the test. Every model and app is a loopback fake: the
// mock LLM, the fake OAuth + MCP app and the fake `codex` CLI. Main's fetch is guarded so a request to
// any other host is refused and reported.

let llm: MockLlm

/**
 * Noise that comes from outside the app's code. Keep this short and explicit; anything the app itself
 * logs or throws must be fixed, not listed here.
 */
const ALLOWED: Array<{ re: RegExp; why: string }> = [
  // Chromium's own dev-build warning about the renderer CSP; Electron prints it in unpackaged runs only.
  { re: /Electron Security Warning/, why: 'Electron dev-only security banner' },
  // Chromium DevTools protocol chatter when Playwright attaches (Autofill.enable isn't implemented in Electron).
  { re: /Request Autofill\.(enable|setAddresses) failed/, why: 'DevTools autofill domain missing in Electron' },
  // macOS prints these for hidden, never-shown windows (NSWindow / IMK input method noise from the OS).
  { re: /^\s*\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ Electron\[\d+:\d+\] (IMK|NSWindow|TSM)/, why: 'macOS AppKit log lines' }
]

type Problem = { where: 'console' | 'pageerror' | 'main' | 'toast'; text: string }

/** Starts listening for problems on the window and the main process; returns the list it fills. */
async function watch(app: ElectronApplication, page: Page): Promise<Problem[]> {
  const out: Problem[] = []
  const add = (where: Problem['where'], text: string): void => { if (!ALLOWED.some((a) => a.re.test(text))) out.push({ where, text }) }
  page.on('console', (m) => { if (m.type() === 'error') add('console', `${m.text()} @ ${m.location().url}:${m.location().lineNumber}`) })
  page.on('pageerror', (e) => add('pageerror', e.stack ?? e.message))
  let buf = ''
  app.process().stderr?.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      // Main's unhandled rejections, and any uncaught exception or error Node/Electron reports.
      if (/\[sahilbot\] unhandledRejection|UnhandledPromiseRejection|Uncaught|TypeError|ReferenceError|SyntaxError|Error invoking remote method/.test(line)) add('main', line)
    }
  })
  // Error toasts (they go away on their own, so they're caught as they appear).
  await page.exposeFunction('__noErrorsToast', (text: string) => add('toast', text))
  await page.evaluate(() => {
    const seen = new WeakSet<Element>()
    const scan = (): void => document.querySelectorAll('[data-testid="toast"].error').forEach((t) => {
      if (seen.has(t)) return
      seen.add(t)
      void (window as unknown as { __noErrorsToast: (s: string) => Promise<void> }).__noErrorsToast((t.textContent ?? '').trim())
    })
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true })
    scan()
  })
  // Nothing may leave the machine: main's fetch only reaches loopback.
  await app.evaluate(() => {
    const g = globalThis as unknown as { __offHost: string[]; fetch: typeof fetch; __guarded?: boolean }
    if (g.__guarded) return
    g.__guarded = true
    g.__offHost = []
    const orig = g.fetch.bind(globalThis)
    g.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      try {
        const u = new URL(href)
        if (/^https?:$/.test(u.protocol) && !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname)) {
          g.__offHost.push(u.origin + u.pathname)
          return Promise.reject(new TypeError(`fetch failed (test: ${u.host} is not loopback)`))
        }
      } catch { /* not a URL: let fetch decide */ }
      return orig(input, init)
    }) as typeof fetch
  })
  return out
}

/**
 * The watchers really see problems: a deliberate unhandled rejection in main and a console error in the
 * window must both be caught (then they're taken off the list). Guards against a test that passes
 * because it stopped listening.
 */
async function selfCheck(app: ElectronApplication, page: Page, problems: Problem[]): Promise<void> {
  await app.evaluate(() => { void Promise.reject(new Error('no-errors self-check (main)')) })
  await page.evaluate(() => console.error('no-errors self-check (renderer)'))
  const seen = (s: string): boolean => problems.some((p) => p.text.includes(s))
  await expect.poll(() => seen('self-check (main)') && seen('self-check (renderer)'), { timeout: 10_000 }).toBe(true)
  for (let i = problems.length - 1; i >= 0; i--) if (problems[i].text.includes('no-errors self-check')) problems.splice(i, 1)
}

const offHost = (app: ElectronApplication): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { __offHost: string[] }).__offHost)

/** Settles: the app has had a moment to finish whatever a click started (and log any error). */
const settle = (page: Page, ms = 400): Promise<void> => page.waitForTimeout(ms)

const idle = async (page: Page): Promise<void> => {
  await expect.poll(() => llm.script.length, { timeout: 20_000 }).toBe(0)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
}

/** Opens Settings and visits every page in its nav, giving each a moment to load. */
async function everySettingsPage(page: Page): Promise<string[]> {
  await page.keyboard.press('Meta+,')
  await page.locator('[data-testid="settings"]').waitFor()
  await expandMoreSettings(page)
  const ids = await page.locator('.set-nav .set-nav-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''))
  expect(ids.length).toBeGreaterThanOrEqual(6)
  for (const id of ids) {
    await page.click(`[data-testid="${id}"]`)
    await expect.poll(() => page.locator(`[data-testid="${id}"]`).getAttribute('class')).toContain(' on')
    await settle(page, 600)
    // Each page shows something (never a blank body).
    expect((await page.locator('.set-body').innerText()).trim().length, id).toBeGreaterThan(0)
  }
  await page.click('[data-testid="settings-close"]')
  await expect.poll(() => page.locator('[data-testid="settings"]').count()).toBe(0)
  return ids
}

const report = (problems: Problem[]): string => problems.map((p) => `[${p.where}] ${p.text}`).join('\n')

describe('no errors on a first run', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('Claude key: onboarding → first chat → connect an app → make a bot → every Settings page, with no errors', async () => {
    const fake = await startFakeServer({ name: 'tasks' })
    // SAHILBOT_TEST_OAUTH_FETCH: the sign-in page (on loopback only) is loaded headlessly instead of in the user's browser.
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_SKIP_ONBOARDING: '', SAHILBOT_TEST_OAUTH_FETCH: '1' })
    const problems = await watch(app, page)
    // The key check would ask Anthropic for its model list: point it at the mock instead (same handler).
    await app.evaluate(({ ipcMain }, url) => {
      const g = globalThis as unknown as { __keyChecks: string[] }
      g.__keyChecks = []
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers
      const orig = handlers.get('models:test')!
      ipcMain.removeHandler('models:test')
      ipcMain.handle('models:test', (e, baseUrl: string, key?: string) => { g.__keyChecks.push(baseUrl); return orig(e, url, key) })
    }, llm.url)
    try {
      // 1. Onboarding, Claude key path.
      await page.locator('[data-testid="onboarding"]').waitFor()
      await page.fill('[data-testid="onboarding-name"]', 'JP')
      await page.click('[data-testid="onboarding-name-next"]')
      await page.click('[data-testid="onboarding-about-next"]')
      await page.fill('[data-testid="onboarding-key"]', 'sk-ant-test-0000')
      await page.keyboard.press('Enter')
      const claude = page.locator('[data-testid="onboarding-connect-anthropic"]')
      await expect.poll(() => claude.innerText(), { timeout: 10_000 }).toContain('Connected')
      expect(await app.evaluate(() => (globalThis as unknown as { __keyChecks: string[] }).__keyChecks)).toEqual(['https://api.anthropic.com/v1'])
      await settle(page)
      await page.click('[data-testid="onboarding-next"]')
      // The last step: Mac permissions and files anywhere.
      await page.click('[data-testid="onboarding-perms-next"]')
      await page.click('[data-testid="onboarding-finish"]')
      await expect.poll(() => page.locator('[data-testid="onboarding"]').count()).toBe(0)
      expect((await page.evaluate(() => window.foreman.settings.get())).keys.anthropic).toBeTruthy()
      await settle(page)

      // 2. First chat, answered by the mock.
      llm.script.push({ content: 'Hi JP, nice to meet you.' })
      await page.fill('[data-testid="composer-input"]', 'Hello there')
      await page.keyboard.press('Enter')
      await idle(page)
      await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText()).toContain('Hi JP, nice to meet you.')
      await settle(page)

      // 3. Connect an app: a custom connector with one-click OAuth to the local fake.
      await page.click('[data-testid="connect-apps"]')
      await page.click('[data-testid="preset-custom"]')
      await page.fill('.conn-form input >> nth=0', 'Tasks')
      await page.fill('[data-testid="conn-url"]', fake.url)
      await page.click('[data-testid="conn-save"]')
      const row = page.locator('[data-testid="connector-row"]')
      await expect.poll(() => row.getAttribute('data-state'), { timeout: 30_000 }).toBe('connected')
      await settle(page)
      await page.keyboard.press('Escape')
      await expect.poll(() => page.locator('[data-testid="connect-apps-modal"]').count()).toBe(0)

      // 4. Make a bot: it introduces itself.
      llm.script.push({ content: "Hi JP! I'm your new bot, ready for whatever you need." })
      await page.locator('[data-testid="new-bot"], [data-testid="sidebar-make-bot"]').first().click()
      await page.fill('[data-testid="bot-name"]', 'My helper')
      await page.click('[data-testid="bot-save"]')
      await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText().catch(() => ''), { timeout: 20_000 }).toContain('your new bot')
      await idle(page)
      await settle(page)

      // 5. Every Settings page.
      await everySettingsPage(page)
      await settle(page, 800)

      await selfCheck(app, page, problems)
      expect(await offHost(app)).toEqual([])
      expect(report(problems)).toBe('')
    } finally {
      await app.close()
      await fake.close()
    }
  })

  test('ChatGPT plan only: onboarding → Connect → first chat through Codex → every Settings page, with no errors', async () => {
    const dir = tempProfile()
    const fakeCodex = resolve('tests/fixtures/fake-codex.mjs')
    chmodSync(fakeCodex, 0o755)
    const state = join(dir, 'codex-login')
    writeFileSync(state, 'chatgpt')
    // No FOREMAN_BASE_URL: models come from the plan alone (no keys, local models off).
    const { app, page } = await launch(dir, '', { FOREMAN_SKIP_ONBOARDING: '', SAHILBOT_CODEX_PATH: fakeCodex, FAKE_CODEX_STATE: state })
    const problems = await watch(app, page)
    try {
      await page.locator('[data-testid="onboarding"]').waitFor()
      await page.fill('[data-testid="onboarding-name"]', 'JP')
      await page.click('[data-testid="onboarding-name-next"]')
      await page.click('[data-testid="onboarding-about-next"]')
      await page.click('[data-testid="onboarding-chatgpt-plan"]')
      const status = page.locator('[data-testid="chatgpt-plan-status"]')
      await expect.poll(() => status.innerText(), { timeout: 10_000 }).toContain('Signed in to Codex with ChatGPT')
      await page.click('[data-testid="chatgpt-plan-connect"]')
      await expect.poll(() => status.innerText(), { timeout: 15_000 }).toMatch(/^Connected/)
      // Inside setup, the plan's own row already names it: no second heading repeating the same words.
      expect(await page.locator('[data-testid="onboarding"] [data-testid="chatgpt-plan"] .set-label').count()).toBe(0)
      await settle(page)
      await page.click('[data-testid="onboarding-next"]')
      // The last step: Mac permissions and files anywhere.
      await page.click('[data-testid="onboarding-perms-next"]')
      await page.click('[data-testid="onboarding-finish"]')
      await expect.poll(() => page.locator('[data-testid="onboarding"]').count()).toBe(0)
      await settle(page)

      await page.fill('[data-testid="composer-input"]', 'Hello there')
      await page.keyboard.press('Enter')
      await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText().catch(() => ''), { timeout: 30_000 }).toContain('Hello from Codex')
      await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
      // The plan has no per-token price: no "~$…/step" estimate in the header.
      expect(await page.locator('[data-testid="ctx-cost"]').count()).toBe(0)
      await settle(page)

      await everySettingsPage(page)
      await settle(page, 800)

      await selfCheck(app, page, problems)
      expect(await offHost(app)).toEqual([])
      expect(report(problems)).toBe('')
    } finally {
      await app.close()
    }
  })
})
