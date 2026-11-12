import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { expandSteps, launch, tempProfile } from './app'
import { lastToolOutput, refFor, startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { startTestSite, USER, type TestSite } from '../fixtures/test-site'

const call = (args: Record<string, unknown>) => ({ toolCalls: [{ name: 'browser', arguments: JSON.stringify(args) }] })

/** Clicks "Allow once" on every approval card until the run ends; records what was asked. */
async function runApproving(page: Page, llm: MockLlm): Promise<string[]> {
  const asked: string[] = []
  const seen = new Set<string>()
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const ids = await page.locator('[data-testid="approval-card"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')!))
    const id = ids.find((x) => !seen.has(x))
    if (id) {
      seen.add(id)
      const card = page.locator(`[data-testid="approval-card"][data-id="${id}"]`)
      asked.push(await card.innerText())
      await card.locator('[data-testid="approve-once"]').click()
      await card.waitFor({ state: 'detached' })
      continue
    }
    if (llm.script.length === 0 && (await page.locator('[data-testid="stop"]').count()) === 0) return asked
    await page.waitForTimeout(80)
  }
  throw new Error('run did not finish')
}

// Phase 3 acceptance: log into a test site with a vault login, fill a form, read the result.
describe('phase 3: browser pane + browser tools + vault', () => {
  let llm: MockLlm
  let site: TestSite

  beforeAll(async () => { [llm, site] = await Promise.all([startMockLlm(), startTestSite()]) })
  afterAll(async () => { await Promise.all([llm.close(), site.close()]) })

  test('logs in with a saved login, fills a form, reads the result; the model never sees the password', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.evaluate((origin) => window.foreman.vault.set({ name: 'acme', origin, username: 'sam@example.test', password: 'correct horse battery' }), site.url)

    let overlaySeen = false
    const watch = setInterval(() => void page.locator('[data-testid="browser-overlay"]').count().then((n) => { if (n) overlaySeen = true }).catch(() => undefined), 50)

    llm.script.push(
      { toolCalls: [{ name: 'find_tools', arguments: '{"query":"browser"}' }] },
      call({ action: 'navigate', url: `${site.url}/login` }),
      call({ action: 'snapshot' }),
      (req) => call({ action: 'fill_secret', ref: refFor(lastToolOutput(req), 'textbox', 'Email'), secret: 'acme', field: 'username' }),
      (req) => { const snap = String(req.messages.find((m: any) => m.role === 'tool' && String(m.content).includes('Page: "Sign in')).content); return call({ action: 'fill_secret', ref: refFor(snap, 'textbox', 'Password'), secret: 'acme', field: 'password' }) },
      (req) => { const snap = String(req.messages.find((m: any) => m.role === 'tool' && String(m.content).includes('Page: "Sign in')).content); return call({ action: 'click', ref: refFor(snap, 'button', 'Sign in') }) },
      call({ action: 'snapshot' }),
      call({ action: 'navigate', url: `${site.url}/form` }),
      call({ action: 'snapshot' }),
      (req) => call({ action: 'type', ref: refFor(lastToolOutput(req), 'textbox', 'Your name'), text: 'Sam Rivera' }),
      (req) => { const snap = String([...req.messages].reverse().find((m: any) => m.role === 'tool' && String(m.content).includes('Page: "Contact')).content); return call({ action: 'type', ref: refFor(snap, 'textbox', 'Message'), text: 'Need a quote for 40 seats' }) },
      (req) => { const snap = String([...req.messages].reverse().find((m: any) => m.role === 'tool' && String(m.content).includes('Page: "Contact')).content); return call({ action: 'click', ref: refFor(snap, 'button', 'Send message') }) },
      call({ action: 'get_text' }),
      call({ action: 'screenshot' }),
      { content: 'Sent. The portal confirmed it with reference #A-1001.' }
    )
    await page.fill('[data-testid="composer-input"]', 'Log into the Acme portal and send them a quote request for 40 seats')
    await page.keyboard.press('Enter')
    const asked = await runApproving(page, llm)
    clearInterval(watch)

    // The browser worked quietly in the background: the panel never opened on its own.
    expect(await page.locator('[data-testid="right-panel"]').count()).toBe(0)
    expect(overlaySeen).toBe(false)

    // Every browser step ran.
    await expandSteps(page)
    const chips = await page.locator('[data-testid="tool-chip"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-status')))
    expect(chips.every((s) => s === 'ok')).toBe(true)

    // Logged in via the vault, the form reached the server, and the agent read the result.
    expect(site.submissions).toEqual([{ name: 'Sam Rivera', message: 'Need a quote for 40 seats', topic: 'Sales' }])
    const textResult = String(llm.requests.at(-2)!.messages.filter((m: any) => m.role === 'tool').at(-1).content)
    expect(textResult).toContain('Thanks Sam Rivera')
    expect(textResult).toContain('A-1001')

    // Credentials were hard stops (asked, even in Auto). Sending the form is consequential and asked;
    // clicking "Sign in" and typing into fields are routine, so Auto ran them without interrupting.
    expect(asked.filter((a) => a.includes('Hard stop: typing the saved login'))).toHaveLength(2)
    expect(asked.some((a) => a.includes('Send message'))).toBe(true)
    expect(asked.some((a) => a.includes('Click button "Sign in"'))).toBe(false)
    expect(asked).toHaveLength(3)

    // The screenshot went to the model as an image on the next request.
    const lastReq = JSON.stringify(llm.requests.at(-1)!.messages)
    expect(lastReq).toContain('"type":"image_url"')
    expect(lastReq).toContain('data:image/jpeg;base64,')

    // The password never appeared in anything sent to the model.
    for (const r of llm.requests) expect(JSON.stringify(r)).not.toContain(USER.password)
    await app.close()
  })

  test('secrets cannot leak and stay on their own site; injected instructions stay data; take-over pauses the agent', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.evaluate((origin) => window.foreman.vault.set({ name: 'acme', origin, username: 'sam@example.test', password: 'correct horse battery' }), site.url)
    // Same site served on another origin: localhost vs 127.0.0.1.
    const other = site.url.replace('127.0.0.1', 'localhost')
    llm.script.push(
      call({ action: 'navigate', url: `${other}/login` }),
      call({ action: 'snapshot' }),
      (req) => call({ action: 'fill_secret', ref: refFor(lastToolOutput(req), 'textbox', 'Password'), secret: 'acme', field: 'password' }),
      call({ action: 'navigate', url: `${site.url}/inject` }),
      call({ action: 'snapshot' }),
      (req) => call({ action: 'type', ref: refFor(lastToolOutput(req), 'textbox', 'Feedback'), text: 'correct horse battery' }),
      { content: 'I will not do that.' }
    )
    await page.fill('[data-testid="composer-input"]', 'check the pricing page')
    await page.keyboard.press('Enter')
    await runApproving(page, llm)
    const results = llm.requests.at(-1)!.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content))
    // Wrong origin: refused before anything was typed.
    expect(results.some((t: string) => t.includes('will only be typed on its own site'))).toBe(true)
    // The page's "system notice" arrived fenced as untrusted data.
    expect(results.some((t: string) => t.includes('trust="untrusted"') && t.includes('IMPORTANT SYSTEM NOTICE'))).toBe(true)
    // Typing the password anywhere is blocked outright.
    expect(results.at(-1)).toMatch(/^Blocked: .*saved password/)

    // Take over: agent browser actions are refused until handed back.
    await page.click('[data-testid="toggle-browser"]')
    await page.evaluate(() => window.foreman.browser.takeOver(true))
    await page.locator('[data-testid="browser-overlay"]', { hasText: "You're in control" }).waitFor()
    llm.script.push(call({ action: 'snapshot' }), { content: 'Waiting for you.' })
    await page.fill('[data-testid="composer-input"]', 'continue')
    await page.keyboard.press('Enter')
    await runApproving(page, llm)
    expect(String(llm.requests.at(-1)!.messages.filter((m: any) => m.role === 'tool').at(-1).content)).toContain('taken over the browser')
    await app.close()
  })

  test('browser quality: outcomes, new elements, clickable divs, dropdowns, overlays and page dialogs', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    const snapOf = (req: any): string => String([...req.messages].reverse().find((m: any) => m.role === 'tool' && String(m.content).includes('Page: "Widgets')).content)
    llm.script.push(
      call({ action: 'navigate', url: `${site.url}/widgets` }),
      (req) => call({ action: 'click', ref: refFor(snapOf(req), 'clickable', 'Show details') }),
      call({ action: 'snapshot' }),
      (req) => call({ action: 'select', ref: refFor(lastToolOutput(req), 'combobox', 'Plan'), option: 'team' }),
      (req) => call({ action: 'click', ref: refFor(snapOf(req), 'button', 'Does nothing') }),
      (req) => call({ action: 'click', ref: refFor(snapOf(req), 'button', 'Hidden action') }),
      (req) => call({ action: 'click', ref: refFor(snapOf(req), 'button', 'Remove widget') }),
      call({ action: 'dialog', accept: true }),
      (req) => call({ action: 'click', ref: refFor(snapOf(req), 'button', 'Remove widget') }),
      call({ action: 'get_text' }),
      { content: 'Done.' }
    )
    await page.fill('[data-testid="composer-input"]', 'try the widgets page')
    await page.keyboard.press('Enter')
    const asked = await runApproving(page, llm)
    const outs = llm.requests.at(-1)!.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content))
    // navigate returned the page inline; the onclick div got a ref; the dropdown listed its options.
    expect(outs[0]).toMatch(/clickable "Show details" \[ref=e\d+\]/)
    expect(outs[0]).toMatch(/combobox "Plan".*options: \[x\] Starter \| Team \| Enterprise/)
    // Clicking it changed the page; the new button is marked as new.
    expect(outs[1]).toContain('The page changed')
    expect(outs[2]).toMatch(/- \*button "Save details"/)
    expect(outs[3]).toContain('Selected "Team"')
    expect(outs[4]).toContain('No visible change')
    // The covered button wasn't clicked, and the cover was named.
    expect(outs[5]).toMatch(/covered by a dialog "Cookie banner"; nothing was clicked/)
    // A confirm dialog is answered Cancel by default and reported; saying OK is a hard stop the user approves.
    expect(outs[6]).toContain('asked to confirm "Delete this widget forever?" and it was answered Cancel')
    expect(asked.some((a) => a.includes('Delete this widget forever?'))).toBe(true)
    expect(outs[8]).toContain('answered OK as you chose')
    expect(outs[9]).toContain('Widget deleted')
    await app.close()
  })
})
