import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { startTestSite, USER, type TestSite } from '../fixtures/test-site'

// End-to-end verification of features the unit tests cover but nothing ran for real: Teach a task in
// the real browser panel, Pages (panel, thumbnail, window, PDF), "needs you" notifications and the Dock
// badge, routines from the bot details panel, and bot-to-bot handoffs seen in both chats.

let llm: MockLlm
let site: TestSite

const send = async (page: Page, text: string): Promise<void> => {
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
}
const idle = async (page: Page): Promise<void> => {
  await expect.poll(() => llm.script.length, { timeout: 20_000 }).toBe(0)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
}
const call = (name: string, args: unknown) => ({ toolCalls: [{ name, arguments: JSON.stringify(args) }] })

/** The browser panel's live tab, as a Playwright page (it's a WebContentsView, not a window). */
async function browserTab(app: ElectronApplication, prefix: string): Promise<Page> {
  let found: Page | undefined
  await expect.poll(() => {
    found = app.windows().find((p) => p.url().startsWith(prefix))
    return !!found
  }, { timeout: 15_000 }).toBe(true)
  return found!
}

describe('verify: teach, pages, notifications, routines, handoffs', () => {
  beforeAll(async () => { [llm, site] = await Promise.all([startMockLlm(), startTestSite()]) })
  afterAll(async () => { await Promise.all([llm.close(), site.close()]) })
  beforeEach(() => { llm.script.length = 0; llm.requests.length = 0 })

  test('teach a task: the user records a login in the browser panel; readable steps reach the chat, the password never does', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.setViewportSize({ width: 1400, height: 900 })
    // A chat to teach: the recording goes to the chat that's open.
    await send(page, 'hello')
    await idle(page)

    await page.click('[data-testid="toggle-browser"]')
    await page.fill('[data-testid="browser-url"]', `${site.url}/login`)
    await page.keyboard.press('Enter')
    const tab = await browserTab(app, `${site.url}/login`)
    await tab.waitForSelector('#email')

    await page.click('[data-testid="teach-start"]')
    await page.locator('[data-testid="teach-bar"]').waitFor()

    // The lesson: sign in (normal field + password field, Enter), open the form, fill it, pick a topic, send.
    await tab.click('#email')
    await tab.keyboard.type(USER.email, { delay: 15 })
    await tab.click('#pw')
    await tab.keyboard.type(USER.password, { delay: 15 })
    await tab.keyboard.press('Enter')
    await tab.waitForURL(/\/dashboard/)
    await tab.click('text=Contact form')
    await tab.waitForURL(/\/form/)
    await tab.click('#name')
    await tab.keyboard.type('Sam Rivera', { delay: 15 })
    await tab.click('#msg')
    await tab.keyboard.type('Need a quote', { delay: 15 })
    // Keyboard choice on a closed <select> (a click would open the native menu).
    await tab.focus('#topic')
    await tab.keyboard.type('Su')
    await expect.poll(() => tab.$eval('#topic', (el) => (el as HTMLSelectElement).value)).toBe('Support')
    await tab.click('#name')
    await tab.keyboard.press('Enter')
    await tab.waitForURL(/\/result/)
    expect(site.submissions.at(-1)).toMatchObject({ name: 'Sam Rivera', topic: 'Support' })
    // The address bar and Back are steps too.
    await page.fill('[data-testid="browser-url"]', `${site.url}/widgets`)
    await page.keyboard.press('Enter')
    await tab.waitForURL(/\/widgets/)
    await tab.click('text=Show details')
    await page.click('.bbar button[title="Back"]')
    await tab.waitForURL(/\/result/)
    // The bar shows the latest steps as they happen.
    await expect.poll(() => page.locator('[data-testid="teach-bar"] .teach-recent').innerText(), { timeout: 5_000 }).toContain('Go back')

    await page.click('[data-testid="teach-done"]')
    await page.fill('[data-testid="teach-name"]', 'Send Acme a quote request')
    await page.click('[data-testid="teach-send"]')
    await idle(page)

    const bubble = page.locator('[data-testid="user-bubble"]').filter({ hasText: 'Teach:' })
    await bubble.waitFor({ timeout: 10_000 })
    const text = await bubble.innerText()
    expect(text).toContain('Teach: Send Acme a quote request')
    // Readable numbered steps, one per thing the user did: keystrokes folded into one step per field,
    // the click that focused a field folded in, redirects folded into one navigation, and Enter's
    // implicit "click" on the form's submit button not repeated as a click of its own.
    const steps = text.split('\n').filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, ''))
    const expected = [
      /^Go to 127\.0\.0\.1:\d+$/,
      /^Type "sam@example\.test" into the "Email" field$/,
      /^Type ‹secret› into the "Password" field$/,
      /^Press Enter in "Password"$/,
      /^The page opens 127\.0\.0\.1:\d+$/,
      /^Click the link "Contact form"$/,
      /^The page opens 127\.0\.0\.1:\d+$/,
      /^Type "Sam Rivera" into the "Your name" field$/,
      /^Type "Need a quote" into the "Message" field$/,
      /^Choose "Support" in "Topic"$/,
      /^Press Enter in "Your name"$/,
      /^The page opens 127\.0\.0\.1:\d+$/,
      /^Go to 127\.0\.0\.1:\d+$/,
      // A plain clickable div: its text could be anything, so the chat names no text (the model gets the selector).
      /^Click the element$/,
      /^Go back$/
    ]
    expect(steps, text).toHaveLength(expected.length)
    steps.forEach((s, i) => expect(s).toMatch(expected[i]))
    expect(text).toMatch(/\(15 steps, \d+ s\)/)

    // The model got the details note (selectors, full addresses), with the secret still hidden.
    const toModel = JSON.stringify(llm.requests.at(-1)!.messages)
    expect(toModel).toContain('Teach recording details')
    expect(toModel).toContain('selector=\\"#pw\\" value=‹secret›')
    expect(toModel).toContain('selector=\\"#card\\"')
    expect(toModel).toMatch(/navigate tab=1 url=\\"http:\/\/127\.0\.0\.1:\d+\/widgets\\" cause=address/)
    // The password is nowhere: not in the chat, not in the stored messages, not in anything sent to the model.
    const main = (await page.evaluate(() => window.foreman.spaces.list())).find((s) => s.isMain)!
    const threads = await page.evaluate((id) => window.foreman.threads.list(id), main.id)
    const msgs = await page.evaluate((id) => window.foreman.threads.messages(id), threads[0].id)
    expect(msgs.some((m) => m.role === 'user' && m.content.startsWith('Teach:'))).toBe(true)
    expect(JSON.stringify(msgs)).not.toContain(USER.password)
    expect(await page.locator('main').innerText()).not.toContain(USER.password)
    for (const r of llm.requests) expect(JSON.stringify(r)).not.toContain(USER.password)
    // The bar is gone and Teach can start again.
    expect(await page.locator('[data-testid="teach-bar"], [data-testid="teach-sheet"]').count()).toBe(0)
    await page.locator('[data-testid="teach-start"]').waitFor()
    await app.close()
  })

  test('the bot starting a recording always asks first; approved, the Teach bar opens as "Show me once"', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    llm.script.push(
      call('browser', { action: 'recording', op: 'start', text: 'Download the invoice' }),
      { content: 'Show me once: do it in the browser panel, then press Done.' }
    )
    await send(page, 'Let me show you how I download invoices')
    const card = page.locator('[data-testid="approval-card"]')
    await card.waitFor({ timeout: 15_000 })
    expect(await card.innerText()).toMatch(/record/i)
    // Nothing records until the user says yes.
    expect(await page.evaluate(() => window.foreman.browser.state().then((s) => s.teach ?? null))).toBeNull()
    await card.locator('[data-testid="approve-once"]').click()
    await idle(page)
    const st = await page.evaluate(() => window.foreman.browser.state())
    expect(st.teach).toMatchObject({ status: 'recording', by: 'agent', name: 'Download the invoice' })
    // The panel opened by itself with the bar.
    await page.locator('[data-testid="teach-bar"]', { hasText: 'Show me once' }).waitFor({ timeout: 10_000 })

    // The user shows it (in a tab opened after recording started) and sends it back to the same chat.
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.fill('[data-testid="browser-url"]', `${site.url}/widgets`)
    await page.keyboard.press('Enter')
    const tab = await browserTab(app, `${site.url}/widgets`)
    await tab.waitForSelector('#plan')
    await tab.focus('#plan')
    await tab.keyboard.type('Ent')
    await expect.poll(() => page.locator('[data-testid="teach-bar"] .teach-count').innerText(), { timeout: 5_000 }).toBe('2 steps')
    await page.click('[data-testid="teach-done"]')
    expect(await page.inputValue('[data-testid="teach-name"]')).toBe('Download the invoice')
    await page.click('[data-testid="teach-send"]')
    await idle(page)
    const bubble = page.locator('[data-testid="user-bubble"]').filter({ hasText: 'Teach: Download the invoice' })
    await bubble.waitFor({ timeout: 10_000 })
    expect(await bubble.innerText()).toMatch(/1\. Go to 127\.0\.0\.1:\d+\n2\. Choose "Enterprise" in "Plan"/)
    expect(await page.locator('[data-testid="user-bubble"]').count()).toBe(2)
    await app.close()
  })

  test('teach across tabs: a link that opens a new tab, steps in it, switching back; a saved password typed anywhere stays hidden', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.setViewportSize({ width: 1400, height: 900 })
    await send(page, 'hello')
    await idle(page)
    await page.evaluate(([origin, username, password]) => window.foreman.vault.set({ name: 'acme', origin, username, password }), [site.url, USER.email, USER.password] as const)
    await page.click('[data-testid="toggle-browser"]')
    await page.fill('[data-testid="browser-url"]', `${site.url}/links`)
    await page.keyboard.press('Enter')
    const first = await browserTab(app, `${site.url}/links`)
    await first.waitForSelector('a')
    await page.click('[data-testid="teach-start"]')
    await page.locator('[data-testid="teach-bar"]').waitFor()
    // A saved password typed into an ordinary field (not marked as a password) is still never recorded.
    await first.click('#note')
    await first.keyboard.type(USER.password, { delay: 10 })
    await first.click('text=Open widgets in a new tab')
    const second = await browserTab(app, `${site.url}/widgets`)
    await second.waitForSelector('#plan')
    await second.focus('#plan')
    await second.keyboard.type('Te')
    await page.locator('.btab').first().click()
    await expect.poll(() => page.locator('[data-testid="teach-bar"] .teach-recent').innerText(), { timeout: 5_000 }).toContain('Switch to tab 1')
    await page.click('[data-testid="teach-done"]')
    await page.fill('[data-testid="teach-name"]', 'Pick a plan')
    await page.click('[data-testid="teach-send"]')
    await idle(page)
    const bubble = page.locator('[data-testid="user-bubble"]').filter({ hasText: 'Teach:' })
    await bubble.waitFor({ timeout: 10_000 })
    const steps = (await bubble.innerText()).split('\n').filter((l) => /^\d+\. /.test(l))
    expect(steps).toHaveLength(6)
    expect(steps[0]).toMatch(/^1\. Go to 127\.0\.0\.1:\d+$/)
    expect(steps[1]).toBe('2. Type ‹secret› into the "Note" field')
    expect(steps[2]).toBe('3. Click the link "Open widgets in a new tab"')
    expect(steps[3]).toMatch(/^4\. A new tab opens 127\.0\.0\.1:\d+$/)
    expect(steps[4]).toBe('5. Choose "Team" in "Plan"')
    expect(steps[5]).toBe('6. Switch to tab 1 ("Links")')
    const toModel = JSON.stringify(llm.requests.at(-1)!.messages)
    expect(toModel).toMatch(/5\. select tab=2 role=combobox name=\\"Plan\\"/)
    for (const r of llm.requests) expect(JSON.stringify(r)).not.toContain(USER.password)
    expect(JSON.stringify(await page.evaluate(() => window.foreman.browser.state()))).not.toContain(USER.password)
    // A reply that mentions the addresses the user just visited isn't treated as made-up links.
    expect(toModel).toMatch(/url=\\"http:\/\/127\.0\.0\.1:\d+\/widgets\\"/)
    for (const r of llm.requests) expect(JSON.stringify(r)).not.toContain('cites links')
    await app.close()
  })

  test('pages: a page the bot makes shows in the panel with a thumbnail, opens in its own locked-down window and exports a real PDF', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sb-ws-'))
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.setViewportSize({ width: 1400, height: 900 })
    await page.evaluate((w) => window.foreman.settings.set({ workspaceDir: w }), ws)
    // Never open Finder from a test: record what would have been revealed.
    await app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { revealed: string[] }
      g.revealed = []
      shell.showItemInFolder = (p: string) => { g.revealed.push(p) }
    })
    llm.script.push(
      call('create_page', { title: 'Q4 Dashboard', html: '<h1>Q4 results</h1><p>Revenue grew 12%.</p><div id="c"></div><script>sb.chart(document.getElementById("c"), { type: "bar", labels: ["Oct", "Nov"], series: [{ name: "Revenue", values: [100, 112] }] })</script>' }),
      { content: 'Your dashboard is ready.' }
    )
    await send(page, 'Make me a Q4 dashboard')
    await idle(page)
    const file = join(ws, 'pages', 'q4-dashboard.html')
    expect(existsSync(file)).toBe(true)

    // The side panel shows it in its own isolated native view.
    const view = page.locator('[data-testid="page-pane"] [data-testid="page-view"]')
    await expect.poll(() => view.getAttribute('data-isolation'), { timeout: 15_000 }).toBe('webcontentsview')
    expect(await view.getAttribute('data-partition')).toBe('sahilbot-pages')
    // The chat card gets a real picture of the page.
    const thumb = page.locator('[data-testid="page-card"] img.page-thumb-img')
    await expect.poll(() => thumb.count(), { timeout: 20_000 }).toBe(1)
    const src = (await thumb.getAttribute('src'))!
    expect(src).toMatch(/^data:image\/png;base64,/)
    expect(src.length).toBeGreaterThan(2000)

    // Open in window: a new window in the pages partition showing the page.
    const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    await page.click('[data-testid="page-open-window"]')
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 10_000 }).toBe(before + 1)
    const pageWin = await app.evaluate(async ({ BrowserWindow, session }) => {
      const pages = session.fromPartition('sahilbot-pages')
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.session === pages && x.getTitle() === 'Q4 Dashboard')
      if (!w) return null
      for (let i = 0; i < 50 && (w.webContents.isLoading() || !w.webContents.getURL()); i++) await new Promise((r) => setTimeout(r, 100))
      const text = await w.webContents.executeJavaScript('document.body.innerText').catch(() => '')
      return { url: w.webContents.getURL(), visible: w.isVisible(), text, node: await w.webContents.executeJavaScript('typeof require + typeof window.foreman').catch(() => '') }
    })
    expect(pageWin).not.toBeNull()
    expect(pageWin!.url).toMatch(/^foreman-file:/)
    expect(pageWin!.text).toContain('Q4 results')
    expect(pageWin!.node).toBe('undefinedundefined')
    // Hidden test runs never put a window on screen.
    expect(pageWin!.visible).toBe(false)

    // Export PDF: a real PDF next to the page, revealed in Finder (stubbed here).
    await page.click('[data-testid="page-export-pdf"]')
    const pdf = join(ws, 'pages', 'q4-dashboard.pdf')
    await expect.poll(() => existsSync(pdf), { timeout: 20_000 }).toBe(true)
    const bytes = readFileSync(pdf)
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(bytes.length).toBeGreaterThan(1000)
    expect(await app.evaluate(() => (globalThis as unknown as { revealed: string[] }).revealed)).toEqual([realpathSync(pdf)])
    await app.close()
  })

  test('notifications and the Dock badge: a background chat that needs you notifies once with a lock-screen-safe line; the badge counts it until handled', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sb-ws-'))
    const { app, page } = await launch(tempProfile(), llm.url, { SAHILBOT_TEST_NOTIFY: '1' })
    await page.evaluate((w) => window.foreman.settings.set({ workspaceDir: w }), ws)
    // Record instead of showing; and act as if the window were in front (hidden test windows never are).
    await app.evaluate(({ app: a, Notification, BrowserWindow }) => {
      const g = globalThis as unknown as { notes: Array<{ title: string; body: string }>; noteObjs: Electron.Notification[]; badges: string[] }
      g.notes = []
      g.noteObjs = []
      g.badges = []
      Notification.prototype.show = function (this: Electron.Notification) { g.notes.push({ title: this.title, body: this.body }); g.noteObjs.push(this) }
      // Linux needs a notification service to say it's supported; show() is recorded instead anyway.
      Notification.isSupported = () => true
      // No Dock off the Mac (a Linux test run): a stand-in, so the badge count is still checked.
      const host = a as unknown as { dock?: Electron.Dock }
      host.dock ??= {} as Electron.Dock
      host.dock.setBadge = (t: string) => { g.badges.push(t) }
      for (const w of BrowserWindow.getAllWindows()) w.isFocused = () => true
    })
    const notes = (): Promise<Array<{ title: string; body: string }>> => app.evaluate(() => (globalThis as unknown as { notes: Array<{ title: string; body: string }> }).notes)
    const badge = (): Promise<string | undefined> => app.evaluate(() => (globalThis as unknown as { badges: string[] }).badges.at(-1))

    // The chat you're reading.
    await send(page, 'hello')
    await idle(page)
    const main = (await page.evaluate(() => window.foreman.spaces.list())).find((s) => s.isMain)!

    // A chat in the background asks to run a command with a secret in it.
    const bg = await page.evaluate((id) => window.foreman.threads.create(id), main.id)
    await page.evaluate((id) => window.foreman.threads.update(id, { permissionMode: 'ask', title: 'Background job' }), bg.id)
    llm.script.push(call('run_command', { command: 'touch notified-sk-live-ABCDEFGHIJKLMNOP1234.txt' }), { content: 'Done, the file is there.' })
    await page.evaluate((id) => window.foreman.chat.send({ threadId: id, text: 'make the marker file' }), bg.id)
    // (Asked without opening it: chat.pending from the window would make it the chat you're reading.)
    await expect.poll(async () => (await page.evaluate(() => window.foreman.chat.allPending()))[bg.id]?.length ?? 0, { timeout: 15_000 }).toBe(1)

    await expect.poll(notes, { timeout: 5_000 }).toHaveLength(1)
    const [n] = await notes()
    expect(n.title).toBe('SahilBot needs you')
    expect(n.body).toBe('Wants to run a command')
    expect(n.body).not.toContain('sk-live')
    await expect.poll(badge, { timeout: 5_000 }).toBe('1')

    // You approve it: nothing waits on you any more. The finished chat is unread until you open it.
    const [rid] = (await page.evaluate(() => window.foreman.chat.allPending()))[bg.id]
    await page.evaluate(([id, r]) => window.foreman.chat.respond(id, r, 'once'), [bg.id, rid] as const)
    await idle(page)
    await expect.poll(() => existsSync(join(ws, 'notified-sk-live-ABCDEFGHIJKLMNOP1234.txt')), { timeout: 10_000 }).toBe(true)
    expect(await notes()).toHaveLength(1)
    // Clicking the notification opens that chat; reading it clears the badge.
    await app.evaluate(() => { (globalThis as unknown as { noteObjs: Electron.Notification[] }).noteObjs[0].emit('click') })
    await page.locator('[data-testid="assistant-bubble"]', { hasText: 'Done, the file is there.' }).waitFor({ timeout: 10_000 })
    await expect.poll(badge, { timeout: 5_000 }).toBe('')
    expect((await page.evaluate((id) => window.foreman.threads.list(id), main.id)).find((t) => t.id === bg.id)?.unread).toBe(false)

    // With SahilBot in the background: a routine run notifies with its own title and result (not the generic
    // "done"), and an ordinary chat finishing says it's done.
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.isFocused = () => false })
    const task = await page.evaluate((id) => window.foreman.schedules.create({ title: 'Morning check', prompt: 'Say good morning.', schedule: { type: 'daily', time: '07:00' }, spaceId: id }), main.id)
    llm.script.push({ content: 'Good morning! Nothing urgent today.' })
    await page.evaluate((id) => window.foreman.schedules.runNow(id), task.id)
    await expect.poll(async () => (await page.evaluate((id) => window.foreman.schedules.runs(id), task.id))[0]?.status, { timeout: 20_000 }).toBe('succeeded')
    await expect.poll(notes, { timeout: 5_000 }).toHaveLength(2)
    expect((await notes())[1]).toEqual({ title: 'SahilBot: Morning check', body: 'Good morning! Nothing urgent today.' })
    await send(page, 'one more thing')
    await idle(page)
    await expect.poll(notes, { timeout: 5_000 }).toHaveLength(3)
    expect((await notes())[2].title).toBe('SahilBot is done')
    await app.close()
  })

  test('routines from the bot details panel: Test runs it (history says Succeeded, the result lands in the chat); pausing posts a notice', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    const { space: bot } = await page.evaluate(() => window.foreman.spaces.create({ name: 'Morning Bot', color: '#0EA5E9', shape: 'blob', intro: false }))
    // (Made through the API, so the sidebar learns of it on the next load.)
    await page.reload()
    await page.waitForSelector('[data-testid="composer-input"]')
    await page.locator('[data-testid="space-item"]', { hasText: 'Morning Bot' }).click()
    await page.locator('[data-testid="bot-pill"]').waitFor()
    await page.evaluate((id) => window.foreman.schedules.create({ title: 'Morning check', prompt: 'Say good morning.', schedule: { type: 'daily', time: '07:00' }, spaceId: id }), bot.id)
    const chatText = (): Promise<string> => page.locator('main').innerText()
    await page.click('[data-testid="bot-pill"]')
    const details = page.locator('[data-testid="bot-details"]')
    await details.waitFor()
    const row = details.locator('[data-testid="routine-row"]', { hasText: 'Morning check' })
    await row.waitFor({ timeout: 10_000 })

    llm.script.push({ content: 'Good morning! Nothing urgent today.' })
    // (No menu on the row any more: open the routine, and Test is there.)
    await row.locator('.rt-main').click()
    await details.locator('[data-testid="routine-test"]').click()
    await idle(page)
    // The run's reply shows in the bot's chat.
    await expect.poll(chatText, { timeout: 15_000 }).toContain('Good morning! Nothing urgent today.')
    // Its run history says it worked, marked as a test.
    const history = details.locator('[data-testid="routine-history"]')
    await expect.poll(() => history.innerText(), { timeout: 10_000 }).toMatch(/Succeeded\s*·\s*Test/)
    expect(await history.locator('.rt-run').count()).toBe(1)
    // A test doesn't move the schedule.
    const task = (await page.evaluate(() => window.foreman.schedules.list())).find((t) => t.title === 'Morning check')!
    expect(task.enabled).toBe(true)

    // Pausing from the list: the switch flips, the row says Paused, and the chat gets a system line.
    await details.locator('[data-testid="routine-back"]').click()
    await row.locator('[data-testid="routine-toggle"]').click()
    await expect.poll(() => row.innerText(), { timeout: 10_000 }).toContain('Paused')
    await expect.poll(() => page.locator('.notice.sys-line').allInnerTexts(), { timeout: 10_000 }).toContain('Paused routine · Morning check')
    expect((await page.evaluate(() => window.foreman.schedules.list())).find((t) => t.id === task.id)!.enabled).toBe(false)
    // Its creation was announced too, and nothing failed.
    const lines = await page.locator('.notice.sys-line').allInnerTexts()
    expect(lines).toContain('Created routine · Morning check')
    expect(lines.some((l) => l.startsWith('Routine failed'))).toBe(false)

    // Deleting asks first, then the row goes and the chat says so.
    // (Open the routine: Delete is in its view; asking the bot in chat works too.)
    await row.locator('.rt-main').click()
    await details.locator('[data-testid="routine-delete"]').click()
    await details.locator('[data-testid="routine-delete-confirm"]').click()
    await expect.poll(() => details.locator('[data-testid="routine-row"]').count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => page.locator('.notice.sys-line').allInnerTexts(), { timeout: 10_000 }).toContain('Deleted routine · Morning check')
    await app.close()
  })

  test('handoffs: the main bot hands work to another bot; both chats show it', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.evaluate(() => window.foreman.spaces.create({ name: 'Researcher', color: '#0EA5E9', shape: 'blob', intro: false }))
    llm.script.push(
      call('message_bot', { bot: 'Researcher', message: 'Find the boiling point of water at sea level in °C.' }),
      // The two bots run at the same time: answer by who's asking, not by arrival order.
      ...[0, 1].map(() => (req: Record<string, any>) => String(req.messages[0]?.content).includes('Bot: Researcher')
        ? { content: 'Water boils at 100 °C at sea level.' }
        : { content: 'I asked the Researcher; its answer will show in its chat.' })
    )
    await send(page, 'Ask the Researcher bot for the boiling point of water')
    await idle(page)
    // The sender's chat: a system line naming who it went to.
    const sent = page.locator('.notice.sys-line', { hasText: 'Handed off to Researcher' })
    await sent.waitFor({ timeout: 10_000 })
    expect(await sent.innerText()).toContain('Find the boiling point of water')
    // The receiver's chat: who it came from, the message, and its own answer.
    await page.locator('[data-testid="space-item"]', { hasText: 'Researcher' }).click()
    const from = page.locator('.notice.sys-line', { hasText: 'From New bot' })
    await from.waitFor({ timeout: 10_000 })
    expect(await from.innerText()).toContain('Find the boiling point of water')
    await page.locator('[data-testid="assistant-bubble"]', { hasText: 'Water boils at 100 °C' }).waitFor({ timeout: 10_000 })
    await app.close()
  })
})
