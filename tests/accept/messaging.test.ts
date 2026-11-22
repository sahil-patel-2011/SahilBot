import { afterAll, beforeAll, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Messaging setup in the real (hidden) app: the Resend tile (open the key page, Paste key, or type it),
// the one "Connect Google" panel (three ways), and the user's own email and phone in Settings. Nothing is
// pasted from the real clipboard, nothing is sent, Apple Mail is never asked (hidden runs skip it).

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })

test('Connect apps: Resend is a paste-your-key tile; Google is one panel with three ways', async () => {
  const { app, page } = await launch(tempProfile(), llm.url, { SAHILBOT_QUIET: '1' })
  try {
    await page.click('[data-testid="connect-apps"]')
    await page.fill('[data-testid="conn-search"]', 'Resend')
    const tile = page.locator('[data-testid="preset-resend"]')
    await tile.waitFor()
    expect(await tile.innerText()).toContain('Add key')
    expect(await page.locator('[data-testid="badge-resend"]').innerText()).toBe('API key')
    await tile.click()
    const panel = page.locator('[data-testid="api-key-panel"]')
    await panel.waitFor()
    expect(await panel.locator('[data-testid="api-key-link"]').getAttribute('href')).toBe('https://resend.com/api-keys')
    expect(await panel.locator('[data-testid="api-key-paste"]').isVisible()).toBe(true)
    expect(await panel.locator('[data-testid="api-key-input"]').getAttribute('type')).toBe('password')
    // A key of the wrong shape is refused in main, before anything is sent anywhere.
    await panel.locator('[data-testid="api-key-input"]').fill('sk_live_not_a_resend_key')
    await panel.locator('[data-testid="api-key-save"]').click()
    await expect.poll(() => panel.locator('[data-testid="api-key-error"]').innerText()).toMatch(/re_/)
    expect((await page.evaluate(() => window.foreman.connectors.list())).keys ?? []).not.toContain('resend')

    await page.click('.ca-back')
    await page.fill('[data-testid="conn-search"]', 'Gmail')
    await page.locator('[data-testid="preset-gmail"]').click()
    const g = page.locator('[data-testid="google-connect"]')
    await g.waitFor()
    expect(await page.locator('.ca-head h2').innerText()).toBe('Connect Google')
    expect(await g.locator('[data-testid="google-signin"]').count()).toBe(1)
    expect(await g.locator('[data-testid="google-app-password-link"]').getAttribute('href')).toBe('https://myaccount.google.com/apppasswords')
    expect(await g.locator('[data-testid="google-mail-option"]').count()).toBe(0)
    expect(await g.locator('[data-testid="google-app-connect"]').isDisabled()).toBe(true)
    await g.locator('[data-testid="google-app-address"]').fill('sam@gmail.com')
    await g.locator('[data-testid="google-app-password"]').fill('abcd efgh')
    expect(await g.innerText()).toMatch(/16 letters/)
    expect(await g.locator('[data-testid="google-app-connect"]').isDisabled()).toBe(true)
    await g.locator('[data-testid="google-advanced"]').click()
    expect(await g.locator('[data-testid="google-own-app"]').isVisible()).toBe(true)
  } finally { await app.close() }
})

test('Settings: your own email and phone; per-bot trusted recipients are cleaned', async () => {
  const { app, page } = await launch(tempProfile(), llm.url, { SAHILBOT_QUIET: '1' })
  try {
    await page.keyboard.press('Meta+,')
    await page.click('[data-testid="general-more"] > summary')
    await page.locator('[data-testid="me-emails"]').fill('Me@Example.com, not-an-email')
    await page.locator('[data-testid="me-phones"]').fill('+1 (555) 010-1234')
    await page.locator('[data-testid="me-phones"]').press('Enter')
    await page.locator('[data-testid="me-emails"]').focus()
    await page.locator('[data-testid="me-emails"]').press('Enter')
    await expect.poll(async () => (await page.evaluate(() => window.foreman.settings.get())).me).toEqual({ emails: ['Me@Example.com'], phones: ['+1 (555) 010-1234'] })
    const s = await page.evaluate(() => window.foreman.settings.set({ botAutonomy: { b1: { trustedRecipients: ['amy@example.com', 'AMY@example.com', 'junk', '555-010-9999'] } } }))
    expect(s.botAutonomy?.b1?.trustedRecipients).toEqual(['amy@example.com', '555-010-9999'])
  } finally { await app.close() }
})
