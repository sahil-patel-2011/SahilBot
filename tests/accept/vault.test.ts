import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { lastToolOutput, refFor, startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { startTestSite, USER, type TestSite } from '../fixtures/test-site'

const call = (args: Record<string, unknown>) => ({ toolCalls: [{ name: 'browser', arguments: JSON.stringify(args) }] })
const snapOf = (req: any, title: string): string => String([...req.messages].reverse().find((m: any) => m.role === 'tool' && String(m.content).includes(`Page: "${title}`)).content)
const toolTexts = (llm: MockLlm): string[] => llm.requests.at(-1)!.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content))

/**
 * Approves approval cards until the run ends. When the vault's unlock dialog shows, `onUnlock` decides
 * (and gets the dialog's text).
 */
async function drive(page: Page, llm: MockLlm, onUnlock?: (text: string) => 'unlock' | 'cancel'): Promise<{ approvals: string[]; unlocks: string[] }> {
  const approvals: string[] = []
  const unlocks: string[] = []
  const seen = new Set<string>()
  const deadline = Date.now() + 50_000
  while (Date.now() < deadline) {
    const ids = await page.locator('[data-testid="approval-card"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')!))
    const id = ids.find((x) => !seen.has(x))
    if (id) {
      seen.add(id)
      const card = page.locator(`[data-testid="approval-card"][data-id="${id}"]`)
      approvals.push(await card.innerText())
      await card.locator('[data-testid="approve-once"]').click()
      await card.waitFor({ state: 'detached' })
      continue
    }
    const dlg = page.locator('[data-testid="vault-auth"]')
    if (await dlg.count()) {
      const text = await dlg.innerText()
      unlocks.push(text)
      const choice = onUnlock ? onUnlock(text) : 'cancel'
      await dlg.locator(`[data-testid="vault-auth-${choice}"]`).click()
      await dlg.waitFor({ state: 'detached', timeout: 10_000 })
      continue
    }
    if (llm.script.length === 0 && (await page.locator('[data-testid="stop"]').count()) === 0) return { approvals, unlocks }
    await page.waitForTimeout(80)
  }
  throw new Error('run did not finish')
}

const signIn = (site: TestSite) => [
  call({ action: 'navigate', url: `${site.url}/login` }),
  call({ action: 'snapshot' }),
  (req: any) => call({ action: 'fill_secret', ref: refFor(snapOf(req, 'Sign in'), 'textbox', 'Email'), secret: 'acme', field: 'username' }),
  (req: any) => call({ action: 'fill_secret', ref: refFor(snapOf(req, 'Sign in'), 'textbox', 'Password'), secret: 'acme', field: 'password' }),
  (req: any) => call({ action: 'click', ref: refFor(snapOf(req, 'Sign in'), 'button', 'Sign in') }),
  call({ action: 'snapshot' })
]

describe('secrets vault: sign in by reference, lock, unlock', () => {
  let llm: MockLlm
  let site: TestSite
  beforeAll(async () => { [llm, site] = await Promise.all([startMockLlm(), startTestSite()]) })
  afterAll(async () => { await Promise.all([llm.close(), site.close()]) })

  test('saves a login, the agent signs in by reference, the model never sees the password; locked, a fill asks to unlock', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)

    // 1. Save a login (Settings sends it straight to main; replies are metadata only).
    const saved = await page.evaluate(([origin, username, password]) => window.foreman.vault.set({ name: 'acme', origin, username, password }), [site.url, USER.email, USER.password] as const)
    expect(JSON.stringify(saved)).not.toContain(USER.password)
    expect(JSON.stringify(saved)).not.toContain(USER.email)
    const items = await page.evaluate(() => window.foreman.vault.items())
    expect(items).toMatchObject([{ type: 'login', name: 'acme', sites: [new URL(site.url).origin] }])
    expect(JSON.stringify(items)).not.toContain(USER.password)

    // 2. The agent signs in by reference.
    llm.script.push(...signIn(site), { content: 'Signed in.' })
    await page.fill('[data-testid="composer-input"]', 'Sign in to the Acme portal')
    await page.keyboard.press('Enter')
    const first = await drive(page, llm)
    expect(first.unlocks).toHaveLength(0)
    expect(first.approvals.filter((a) => /typing the saved login "acme"/i.test(a))).toHaveLength(2)
    const outs = toolTexts(llm)
    expect(outs.some((t) => t.includes('Filled the password for "acme". (The value is hidden from you.)'))).toBe(true)
    expect(outs.at(-1)).toContain('Welcome back, Sam')

    // 3. No request to the model ever contained the password.
    for (const r of llm.requests) expect(JSON.stringify(r)).not.toContain(USER.password)

    // The audit log has both fills (site and item name, never the value).
    const audit = await page.evaluate(() => window.foreman.vault.audit(50))
    const fills = audit.filter((e) => e.event === 'fill')
    expect(fills).toHaveLength(2)
    expect(fills[0]).toMatchObject({ item: 'acme', site: new URL(site.url).origin, outcome: 'ok' })
    expect(JSON.stringify(audit)).not.toContain(USER.password)

    // 4. Lock: the next fill asks to unlock (the vault's own dialog), and nothing is typed until it is.
    const st = await page.evaluate(() => window.foreman.vault.lock())
    expect(st.locked).toBe(true)
    llm.script.push(
      call({ action: 'navigate', url: `${site.url}/login` }),
      call({ action: 'snapshot' }),
      (req: any) => call({ action: 'fill_secret', ref: refFor(lastToolOutput(req), 'textbox', 'Password'), secret: 'acme', field: 'password' }),
      { content: 'Waiting for you to unlock.' }
    )
    await page.fill('[data-testid="composer-input"]', 'Sign in to Acme again')
    await page.keyboard.press('Enter')
    const second = await drive(page, llm, () => 'cancel')
    expect(second.unlocks).toHaveLength(1)
    expect(second.unlocks[0]).toMatch(/Unlock your vault/)
    expect(second.unlocks[0]).toContain('type your saved password for "acme"')
    const after = toolTexts(llm)
    expect(after.some((t) => /vault is locked and wasn't unlocked, so nothing was typed/.test(t))).toBe(true)
    expect((await page.evaluate(() => window.foreman.vault.status())).locked).toBe(true)

    // Unlocking from the dialog lets the same fill go through.
    llm.script.push(
      call({ action: 'snapshot' }),
      (req: any) => call({ action: 'fill_secret', ref: refFor(lastToolOutput(req), 'textbox', 'Password'), secret: 'acme', field: 'password' }),
      { content: 'Filled.' }
    )
    await page.fill('[data-testid="composer-input"]', 'Try again, I will unlock it')
    await page.keyboard.press('Enter')
    const third = await drive(page, llm, () => 'unlock')
    expect(third.unlocks).toHaveLength(1)
    expect(toolTexts(llm).some((t) => t.includes('Filled the password for "acme"'))).toBe(true)
    expect((await page.evaluate(() => window.foreman.vault.status())).locked).toBe(false)
    for (const r of llm.requests) expect(JSON.stringify(r)).not.toContain(USER.password)
    const events = (await page.evaluate(() => window.foreman.vault.audit(50))).map((e) => e.event)
    expect(events).toContain('lock')
    expect(events).toContain('unlock_failed')
    expect(events).toContain('unlock')
    await app.close()
  })

  test('Settings → Vault shows metadata only; Reveal shows the value to the user and hides it again', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.evaluate(([origin, username, password]) => window.foreman.vault.set({ name: 'acme', origin, username, password }), [site.url, USER.email, USER.password] as const)
    await page.evaluate(() => window.foreman.vault.setCard({ nickname: 'Personal', number: '4242424242424242', expMonth: '08', expYear: '2031', holder: 'Sam Rivera' }))
    await page.keyboard.press('Meta+,')
    await page.waitForSelector('[data-testid="settings"]')
    await page.click('[data-testid="settings-passwords"]')
    await page.locator('[data-testid="vault-status"]').waitFor()
    await page.locator('[data-testid="vault-item"]').first().waitFor()
    const list = await page.locator('[data-testid="settings"]').innerText()
    expect(list).toContain('acme')
    expect(list).not.toContain(USER.password)
    await page.locator('[data-testid="vault-reveal"]').first().click()
    const panel = page.locator('[data-testid="vault-reveal-panel"]')
    await panel.waitFor()
    expect(await panel.innerText()).toContain(USER.password)
    await panel.locator('text=Hide now').click()
    await panel.waitFor({ state: 'detached' })
    await page.locator('[data-testid="vault-tab-cards"]').click()
    const cards = await page.locator('[data-testid="vault-item"]').first().innerText()
    expect(cards).toContain('•••• 4242')
    expect(cards).not.toContain('4242424242424242')
    await page.locator('[data-testid="vault-tab-security"]').click()
    expect(await page.locator('[data-testid="vault-summary"]').innerText()).toMatch(/AES-256-GCM/)
    await app.close()
  })
})
