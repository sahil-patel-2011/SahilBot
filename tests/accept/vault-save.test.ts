import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { startTestSite, STORE, USER, type TestSite } from '../fixtures/test-site'

// "Save to Vault?": a sign-in and a checkout typed by hand in the browser panel, and a card number
// pasted into the chat. Nothing is saved without the click; the window only ever gets metadata; the
// model never sees the pasted number. Test card numbers only.

let llm: MockLlm
let site: TestSite

/** Opens a page in the browser panel the way a link in an answer does. */
const openInPanel = async (page: Page, url: string): Promise<void> => {
  await page.evaluate((u) => window.dispatchEvent(new CustomEvent('foreman:open-link', { detail: u })), url)
  await expect.poll(() => page.evaluate(() => window.foreman.browser.state().then((s) => s.tabs[s.active]?.url ?? '')), { timeout: 20_000 }).toContain(new URL(url).pathname)
  await expect.poll(() => page.evaluate(() => window.foreman.browser.state().then((s) => !!s.tabs[s.active] && !s.tabs[s.active].loading)), { timeout: 20_000 }).toBe(true)
}

/**
 * The user's own hands in the panel's page: real (trusted) clicks and typing through the page's input
 * pipeline, the same events a person's mouse and keyboard make. Fields are CSS selectors → text.
 */
const typeAndSubmit = (app: ElectronApplication, urlPrefix: string, fields: Array<[string, string]>, submit: string): Promise<void> =>
  app.evaluate(async ({ webContents }, o) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith(o.urlPrefix))
    if (!wc) throw new Error(`no tab at ${o.urlPrefix}`)
    const send = (m: string, p: Record<string, unknown> = {}): Promise<any> => wc.debugger.sendCommand(m, p)
    const at = async (sel: string): Promise<{ x: number; y: number }> => {
      const r = await send('Runtime.evaluate', { expression: `(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }) })()`, returnByValue: true })
      return JSON.parse(r.result.value)
    }
    const click = async (sel: string): Promise<void> => {
      const p = await at(sel)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    }
    for (const [sel, text] of o.fields) { await click(sel); await send('Input.insertText', { text }) }
    await click(o.submit)
  }, { urlPrefix, fields, submit })

const offerCard = (page: Page) => page.locator('[data-testid="vault-offer"]')

describe('Save to Vault', () => {
  beforeAll(async () => { llm = await startMockLlm(); site = await startTestSite() })
  afterAll(async () => { await llm.close(); await site.close() })

  test('browser panel: a hand-typed sign-in offers "Save login"; Save stores it (metadata only); a new password offers Update; a checkout offers the card', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    try {
      await openInPanel(page, `${site.url}/login`)
      // Nothing is offered just for opening the page.
      expect(await offerCard(page).count()).toBe(0)
      await typeAndSubmit(app, `${site.url}/login`, [['#email', USER.email], ['#pw', USER.password]], 'button[type=submit]')
      const card = offerCard(page)
      await card.waitFor({ timeout: 20_000 })
      const host = new URL(site.url).host
      expect(await card.locator('[data-testid="vault-offer-title"]').innerText()).toBe(`Save login for ${host} to Vault?`)
      // The window got the site and a masked username, never the password or the whole email.
      const shown = await card.innerText()
      expect(shown).toContain('sa•••@example.test')
      const state = JSON.stringify(await page.evaluate(() => window.foreman.browser.state()))
      for (const s of [shown, state, await page.content()]) { expect(s).not.toContain(USER.password); expect(s).not.toContain(USER.email) }
      // Not saved before the click.
      expect(await page.evaluate(() => window.foreman.vault.items())).toEqual([])
      await card.locator('[data-testid="vault-offer-save"]').click()
      await expect.poll(() => offerCard(page).count(), { timeout: 10_000 }).toBe(0)
      const items = await page.evaluate(() => window.foreman.vault.items())
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ type: 'login', sites: [site.url] })
      expect(JSON.stringify(items)).not.toContain(USER.password)

      // The same account with a different password: "Update saved password?" (Not now forgets it).
      await openInPanel(page, `${site.url}/login`)
      await typeAndSubmit(app, `${site.url}/login`, [['#email', USER.email], ['#pw', 'a different password 2']], 'button[type=submit]')
      await offerCard(page).waitFor({ timeout: 20_000 })
      expect(await offerCard(page).locator('[data-testid="vault-offer-title"]').innerText()).toBe(`Update saved password for ${host}?`)
      await offerCard(page).locator('[data-testid="vault-offer-dismiss"]').click()
      await expect.poll(() => offerCard(page).count(), { timeout: 10_000 }).toBe(0)
      expect(await page.evaluate(() => window.foreman.vault.items())).toHaveLength(1)

      // A checkout typed by hand: "Save card ending 4242?"; the security code isn't kept unless ticked.
      await openInPanel(page, `${site.url}/store/checkout`)
      await typeAndSubmit(app, `${site.url}/store/checkout`, [['#cn', STORE.card.number], ['#ce', `${STORE.card.month}/${STORE.card.year.slice(-2)}`], ['#cv', STORE.card.cvc], ['#ch', STORE.card.holder]], 'button[type=submit]')
      await offerCard(page).waitFor({ timeout: 20_000 })
      expect(await offerCard(page).locator('[data-testid="vault-offer-title"]').innerText()).toBe('Save card ending 4242 to Vault?')
      expect(await offerCard(page).locator('[data-testid="vault-offer-cvc"]').isChecked()).toBe(false)
      expect(await offerCard(page).innerText()).not.toContain(STORE.card.number)
      await offerCard(page).locator('[data-testid="vault-offer-save"]').click()
      await expect.poll(() => page.evaluate(() => window.foreman.vault.cards()), { timeout: 10_000 }).toMatchObject([{ last4: '4242', brand: 'visa', hasCvc: false, expMonth: 8, expYear: 2031 }])
      expect(JSON.stringify(await page.evaluate(() => window.foreman.vault.items()))).not.toContain(STORE.card.number)
    } finally {
      await app.close()
    }
  })

  test('chat: a pasted card number is hidden from the model; Save to Vault lists the card; the model then sees [saved to vault: …]', async () => {
    const { page, app } = await launch(tempProfile(), llm.url)
    try {
      llm.requests.length = 0
      const number = '5555 5555 5555 4444'
      await page.fill('[data-testid="composer-input"]', `Use my card ${number} exp 01/32 for the tea order`)
      await expect.poll(() => page.locator('[data-testid="composer-secret-hint"]').innerText()).toContain('card number')
      await page.keyboard.press('Enter')
      await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').count(), { timeout: 20_000 }).toBeGreaterThan(0)
      await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
      const bubble = page.locator('[data-testid="user-bubble"]').last()
      expect(await bubble.innerText()).toContain('[redacted]')
      const offer = page.locator('[data-testid="vault-offers"] [data-testid="vault-offer"]')
      await offer.waitFor({ timeout: 10_000 })
      expect(await offer.locator('[data-testid="vault-offer-title"]').innerText()).toBe('Save card ending 4444 to Vault?')
      // Nothing reached the model (or the window's copy of the message) as typed.
      const wire = JSON.stringify(llm.requests)
      expect(llm.requests.length).toBeGreaterThan(0)
      for (const v of ['5555555555554444', number, '5555-5555-5555-4444']) expect(wire).not.toContain(v)
      expect(wire).toContain('[redacted]')
      expect(JSON.stringify(await page.evaluate(() => window.foreman.threads.list()))).not.toContain('5555555555554444')
      // Not saved until the click; the name on card is needed.
      expect(await page.evaluate(() => window.foreman.vault.cards())).toEqual([])
      await offer.locator('[data-testid="vault-offer-holder"]').fill('Sam Rivera')
      await offer.locator('[data-testid="vault-offer-save"]').click()
      await page.locator('[data-testid="vault-offer-saved"]').waitFor({ timeout: 10_000 })
      expect(await page.evaluate(() => window.foreman.vault.cards())).toMatchObject([{ last4: '4444', brand: 'mastercard', expMonth: 1, expYear: 2032 }])
      await expect.poll(() => bubble.innerText()).toContain('[saved to vault: Mastercard ending 4444]')
      // The next turn's request carries the placeholder, still never the number.
      llm.requests.length = 0
      await page.fill('[data-testid="composer-input"]', 'Thanks')
      await page.keyboard.press('Enter')
      await expect.poll(() => llm.requests.length, { timeout: 20_000 }).toBeGreaterThan(0)
      await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
      const next = JSON.stringify(llm.requests)
      expect(next).toContain('[saved to vault: Mastercard ending 4444]')
      expect(next).not.toContain('5555555555554444')
    } finally {
      await app.close()
    }
  })
})
