import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { lastToolOutput, startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Attachments of any kind (picker, drop, paste), folders indexed for the chat, a bot's working folder
// searched with "search my files", and a write outside the working folder asking first.

let llm: MockLlm
const idle = async (page: Page): Promise<void> => {
  await expect.poll(() => llm.script.length, { timeout: 20_000 }).toBe(0)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
}
const send = async (page: Page, text: string): Promise<void> => {
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
}
/** Stands in for the macOS open dialog. */
const pickerReturns = (app: ElectronApplication, paths: string[]): Promise<void> =>
  app.evaluate(({ dialog }, ps) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: ps })) as never }, paths)
const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('attachments, folders and working folders', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })
  beforeEach(() => { llm.script.length = 0 })

  test('files of any type and a folder from the + menu: typed chips, a live folder count, and a note that says how to read each', async () => {
    const files = tmp('sb-files-')
    writeFileSync(join(files, 'todo.txt'), 'buy milk')
    writeFileSync(join(files, 'archive.zip'), Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0]))
    const folder = tmp('sb-proj-')
    writeFileSync(join(folder, 'README.md'), '# Project Falcon\nShips in May.')
    mkdirSync(join(folder, 'src'))
    writeFileSync(join(folder, 'src', 'app.ts'), 'export const falcon = true')
    mkdirSync(join(folder, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(folder, 'node_modules', 'dep', 'index.js'), 'module.exports = 1')
    writeFileSync(join(folder, '.env'), 'SECRET=1')

    const { app, page } = await launch(tempProfile(), llm.url)
    await pickerReturns(app, [join(files, 'todo.txt'), join(files, 'archive.zip')])
    await page.locator('.plus-pop > button').click()
    await page.click('[data-testid="attach-files"]')
    await expect.poll(() => page.locator('[data-testid="attachment-chip"]').count()).toBe(2)
    const details = await page.locator('[data-testid="attachment-detail"]').allInnerTexts()
    expect(details[0]).toMatch(/^Text · \d/)
    expect(details[1]).toMatch(/^File · 8 B/)

    await pickerReturns(app, [folder])
    await page.locator('.plus-pop > button').click()
    await page.click('[data-testid="attach-folder"]')
    // Counted with the ignore rules: README.md and src/app.ts (not node_modules, not .env).
    await expect.poll(() => page.locator('[data-testid="attachment-chip"][data-kind="folder"]').innerText()).toContain('Folder · 2 files')

    llm.script.push({ content: 'Got them.' })
    await send(page, 'What are these?')
    await idle(page)
    const sent = JSON.stringify(llm.requests.at(-1)!.messages)
    expect(sent).toContain('todo.txt (8 B, text: read it with file_read)')
    expect(sent).toMatch(/archive\.zip \(8 B, zip archive[^)]*don't read it as text/)
    expect(sent).toContain('Attached folders')
    expect(sent).toContain('(2 indexable files)')
    // The folder is in the knowledge base for this chat (and searchable with scope "chat").
    await expect.poll(async () => (await page.evaluate(() => window.foreman.knowledge.status())).sources.some((s) => s.kind === 'attached' && s.path.endsWith(basename(folder)))).toBe(true)
    await app.close()
  })

  test('a drop (synthetic DataTransfer) and a pasted screenshot become attachments; the image reaches the model', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    // Dragging over shows the overlay; dropping a file with no path behind it (like an image from a web page) saves it.
    await page.evaluate(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['hello from a drop'], 'dropped.txt', { type: 'text/plain' }))
      const el = document.querySelector('[data-testid="composer-drop"]')!
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    })
    await expect.poll(() => page.locator('[data-testid="drop-overlay"]').count()).toBe(1)
    expect(await page.locator('[data-testid="drop-overlay"]').innerText()).toContain('Drop files or folders')
    await page.evaluate(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['hello from a drop'], 'dropped.txt', { type: 'text/plain' }))
      document.querySelector('[data-testid="composer-drop"]')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    })
    await expect.poll(() => page.locator('[data-testid="attachments"]').innerText()).toContain('dropped.txt')
    expect(await page.locator('[data-testid="drop-overlay"]').count()).toBe(0)

    // ⌘V of an image: a synthetic paste event with an image on the clipboard.
    await page.evaluate((b64) => {
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
      document.querySelector('[data-testid="composer-input"]')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, PNG_B64)
    await expect.poll(() => page.locator('[data-testid="attachment-chip"][data-kind="image"] img').count()).toBe(1)

    llm.script.push({ content: 'A tiny image and a note.' })
    await send(page, 'Look at these')
    await idle(page)
    const sent = JSON.stringify(llm.requests.at(-1)!.messages)
    expect(sent).toContain('"type":"image_url"')
    expect(sent).toContain('data:image/png;base64')
    expect(sent).toMatch(/dropped\.txt \(17 B, text/)
    // The saved copy is readable by the agent (it's an attachment like any other).
    const path = (sent.match(/- (\/[^"\\]*dropped\.txt)/) ?? [])[1]
    expect(path && existsSync(path) && readFileSync(path, 'utf8')).toBe('hello from a drop')
    await app.close()
  })

  test('a bot that works in a folder searches it ("search my files")', async () => {
    const folder = tmp('sb-botfolder-')
    writeFileSync(join(folder, 'plan.md'), '# Launch plan\n\nThe launch codename is BLUEBIRD and it ships on March 3.')
    const { app, page } = await launch(tempProfile(), llm.url)
    const bot = await page.evaluate(() => window.foreman.spaces.create({ name: 'Docs Bot', intro: false }))
    await pickerReturns(app, [folder])
    const sp = await page.evaluate((id) => window.foreman.attach.pickBotFolder(id), bot.space.id)
    expect(sp?.folder).toContain(basename(folder))
    // Indexed for the bot (keyword search: local models are off, nothing to download).
    await expect.poll(async () => {
      const st = await page.evaluate(() => window.foreman.knowledge.status())
      return st.sources.find((s) => s.path.endsWith(basename(folder)))?.files ?? 0
    }, { timeout: 20_000 }).toBeGreaterThan(0)
    await page.reload()
    await page.locator('[data-testid="space-item"]', { hasText: 'Docs Bot' }).click()
    await expect.poll(() => page.locator('[data-testid="bot-pill"]').innerText().catch(() => '')).toContain('Docs Bot')
    // (No folder chip under the message box: the bot simply works there.)

    llm.script.push(
      { toolCalls: [{ name: 'knowledge_search', arguments: '{"query":"launch codename","scope":"chat"}' }] },
      { content: 'The codename is BLUEBIRD.' }
    )
    await send(page, 'Search my files for the launch codename')
    await idle(page)
    const out = lastToolOutput(llm.requests.at(-1)!)
    expect(out).toContain('BLUEBIRD')
    expect(out).toContain('plan.md')
    // The bot was told where it works.
    expect(JSON.stringify(llm.requests.at(-2)!.messages)).toContain(`Working folder: `)
    await app.close()
  })

  test('the chat\'s working folder: writes inside run, a write outside asks first (approve writes it, deny keeps it out)', async () => {
    const wf = tmp('sb-wf-')
    const outside = tmp('sb-outside-')
    const { app, page } = await launch(tempProfile(), llm.url)
    // No folder chip any more: the chat gets its working folder the way the bot sets one when you name a folder.
    llm.script.push({ content: 'Hi! Which folder?' })
    await send(page, 'hello')
    await idle(page)
    const tid = await page.evaluate(async () => (await window.foreman.threads.list())[0].id)
    await pickerReturns(app, [wf])
    await page.evaluate((t) => window.foreman.attach.pickFolder(t), tid)

    llm.script.push(
      { toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path: 'inside.md', content: 'in the folder' }) }] },
      { toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path: join(outside, 'escape.md'), content: 'outside' }) }] },
      { content: 'Done.' }
    )
    await send(page, 'Write a note here and one in the other folder')
    const card = page.locator('[data-testid="approval-card"]')
    await card.waitFor({ timeout: 20_000 })
    expect(await card.innerText()).toMatch(/outside your folders/)
    // The relative path went to the working folder without asking.
    expect(readFileSync(join(wf, 'inside.md'), 'utf8')).toBe('in the folder')
    expect(existsSync(join(outside, 'escape.md'))).toBe(false)
    await card.locator('[data-testid="approve-once"]').click()
    await idle(page)
    expect(readFileSync(join(outside, 'escape.md'), 'utf8')).toBe('outside')
    // The chat keeps its working folder.
    expect(await page.evaluate(async () => { const t = (await window.foreman.threads.list())[0]; return (await window.foreman.attach.folder(t.id)).source })).toBe('chat')

    llm.script.push(
      { toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path: join(outside, 'second.md'), content: 'no' }) }] },
      { content: 'Okay, I left it.' }
    )
    await send(page, 'One more outside')
    await card.waitFor({ timeout: 20_000 })
    await card.locator('[data-testid="approve-deny"]').click()
    await idle(page)
    expect(existsSync(join(outside, 'second.md'))).toBe(false)
    await app.close()
  })
})
