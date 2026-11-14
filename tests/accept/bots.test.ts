import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { expandSteps, launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

let llm: MockLlm
const idle = async (page: Page): Promise<void> => {
  await expect.poll(() => llm.script.length, { timeout: 20_000 }).toBe(0)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
}
const send = async (page: Page, text: string): Promise<void> => {
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
}

describe('bots, group chats, reactions, attachments and documents', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })
  beforeEach(() => { llm.script.length = 0 })

  test('a new bot introduces itself, asks what to focus on, and renames itself from the answer', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.evaluate(() => window.foreman.settings.set({ userName: 'Sahil' }))
    llm.script.push(
      { content: "Hey Sahil! I'm your new bot, fresh and ready to take on whatever you want to throw at me.", toolCalls: [{ name: 'ask_user', arguments: '{"question":"What do you want me to focus on?","options":["Vantage app work","Robotics team stuff","Personal errands"]}' }] },
      { toolCalls: [{ name: 'update_bot', arguments: '{"name":"Robo Coach","instructions":"You help with the robotics team."}' }] },
      { content: 'Done — I am Robo Coach now.' }
    )
    await page.click('[data-testid="new-bot"]')
    await page.click('[data-testid="bot-save"]')
    const q = page.locator('[data-testid="question-card"]')
    await q.waitFor({ timeout: 20_000 })
    // Three choices, then a fourth row to type your own answer.
    expect(await q.innerText()).toMatch(/A\s*Vantage app work[\s\S]*C\s*Personal errands[\s\S]*D/)
    expect(await q.locator('[data-testid="question-own-input"]').count()).toBe(1)
    // The intro instruction itself is hidden from the user.
    expect(await page.locator('[data-testid="user-bubble"]').count()).toBe(0)
    // Typing in the composer answers the question.
    expect(await page.getAttribute('[data-testid="composer-input"]', 'placeholder')).toContain('Type your answer')
    await send(page, 'Robotics team stuff')
    await idle(page)
    expect(await page.locator('[data-testid="answer-bubble"]').innerText()).toBe('Robotics team stuff')
    await expect.poll(() => page.locator('[data-testid="bot-pill"]').innerText()).toContain('Robo Coach')
    await expect.poll(() => page.locator('[data-testid="space-item"]').first().innerText()).toContain('Robo Coach')
    // The first request was the hidden intro, with update_bot preloaded.
    const first = llm.requests.find((r) => JSON.stringify(r.messages).includes('You were just created'))!
    expect(first.tools.map((t: any) => t.function.name)).toContain('update_bot')

    // Context menu: pin, then hide; the palette brings it back.
    await page.locator('[data-testid="space-item"]').first().click({ button: 'right' })
    await page.locator('.ctx-menu button', { hasText: 'Hide from sidebar' }).click()
    await expect.poll(() => page.locator('[data-testid="space-item"]').count()).toBe(0)
    await app.close()
  })

  test('group chat: every bot answers in turn with its own name, and @mentions route to one bot', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    const mk = (name: string) => page.evaluate((n) => window.foreman.spaces.create({ name: n, intro: false }), name)
    const ana = await mk('Ana')
    const ben = await mk('Ben')
    await page.evaluate((ids) => window.foreman.spaces.create({ kind: 'group', name: 'Launch team', members: ids }), [ana.space.id, ben.space.id])
    await page.reload()
    await page.locator('[data-testid="space-item"]', { hasText: 'Launch team' }).click()
    await expect.poll(() => page.locator('[data-testid="bot-pill"]').innerText().catch(() => '')).toContain('Launch team')
    llm.script.push({ content: 'Ana here: I will draft copy. @Ben can you check numbers?' }, { content: 'Ben here: numbers look good.' })
    await send(page, 'Plan the launch')
    await idle(page)
    const speakers = await page.locator('.speaker').allInnerTexts()
    expect(speakers).toEqual(['Ana', 'Ben'])
    // Ben saw Ana's message as quoted user text, not as his own turn.
    const benReq = llm.requests.at(-1)!
    expect(JSON.stringify(benReq.messages)).toContain('[Ana]: Ana here')
    expect(String(benReq.messages[0].content)).toContain('You are Ben')

    llm.script.push({ content: 'Ben: on it.' })
    await send(page, '@Ben what is the budget?')
    await idle(page)
    expect(await page.locator('.speaker').last().innerText()).toBe('Ben')
    await app.close()
  })

  test('reactions go both ways and reach the model as feedback', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    llm.script.push({ content: '<react>🎉</react>Congrats on the launch!' })
    await send(page, 'We launched today!')
    await idle(page)
    expect(await page.locator('[data-testid="bot-reaction"]').innerText()).toBe('🎉')
    expect(await page.locator('[data-testid="assistant-bubble"]').last().innerText()).not.toContain('<react>')
    await page.locator('[data-testid="assistant-bubble"]').last().hover()
    await page.locator('[data-testid="react-btn"]').last().click()
    await page.locator('[data-testid="emoji"]', { hasText: '❤️' }).click()
    expect(await page.locator('[data-testid="user-reaction"]').innerText()).toBe('❤️')
    llm.script.push({ content: 'Thanks!' })
    await send(page, 'thanks')
    await idle(page)
    expect(JSON.stringify(llm.requests.at(-1)!.messages)).toContain('The user reacted ❤️ to your message')
    await app.close()
  })

  test('attach a folder; the agent reads and edits it, builds PPTX/XLSX/DOCX/PDF, previews them, and deleting asks even in Bypass', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'foreman-attached-'))
    writeFileSync(join(folder, 'notes.md'), '# Notes\nRevenue grew 12%.')
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.setViewportSize({ width: 1500, height: 950 })
    // Stand in for the macOS folder picker.
    await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as never }, folder)
    await page.locator('.plus-pop > button').click()
    await page.click('[data-testid="attach-folder"]')
    await expect.poll(() => page.locator('[data-testid="attachments"]').innerText()).toContain('foreman-attached-')

    const p = (n: string) => JSON.stringify(join(folder, n))
    llm.script.push(
      { toolCalls: [{ name: 'file_read', arguments: `{"path":${p('notes.md')}}` }] },
      { toolCalls: [{ name: 'file_write', arguments: `{"path":${p('notes.md')},"content":"# Notes\\nRevenue grew 12%.\\nReviewed by Foreman.","mode":"overwrite"}` }] },
      { toolCalls: [{ name: 'create_document', arguments: JSON.stringify({ path: join(folder, 'deck.pptx'), slides: [{ title: 'Q4 Review', subtitle: 'Acme', layout: 'title' }, { title: 'Growth', bullets: ['Revenue +12%', 'Churn down'] }] }) }] },
      { toolCalls: [{ name: 'create_document', arguments: JSON.stringify({ path: join(folder, 'numbers.xlsx'), sheets: [{ name: 'Q4', rows: [['Month', 'Revenue'], ['Oct', 100], ['Nov', 112], ['Total', '=SUM(B2:B3)']] }] }) }] },
      { toolCalls: [{ name: 'create_document', arguments: JSON.stringify({ path: join(folder, 'memo.docx'), markdown: '# Memo\n\nRevenue grew **12%**.\n\n- Item one\n- Item two\n\n| A | B |\n|---|---|\n| 1 | 2 |' }) }] },
      { toolCalls: [{ name: 'create_document', arguments: JSON.stringify({ path: join(folder, 'memo.pdf'), markdown: '# Memo\n\nRevenue grew 12%.' }) }] },
      { toolCalls: [{ name: 'file_read', arguments: `{"path":${p('memo.docx')}}` }] },
      { content: 'All done.' }
    )
    await send(page, 'Review my notes and make a deck, a sheet, a memo and a PDF')
    await idle(page)
    expect(readFileSync(join(folder, 'notes.md'), 'utf8')).toContain('Reviewed by Foreman')
    for (const f of ['deck.pptx', 'numbers.xlsx', 'memo.docx', 'memo.pdf']) expect(existsSync(join(folder, f))).toBe(true)
    expect(readFileSync(join(folder, 'memo.pdf')).subarray(0, 5).toString()).toBe('%PDF-')
    // The model read the Word file back as text.
    expect(String([...llm.requests.at(-1)!.messages].reverse().find((m: any) => m.role === 'tool').content)).toContain('Revenue grew 12%')
    // The first user message told the model about the folder.
    expect(JSON.stringify(llm.requests.find((r) => JSON.stringify(r.messages).includes('Attached folders'))!.messages)).toContain(folder.split('/').pop())
    await expandSteps(page)
    const statuses = await page.locator('[data-testid="tool-chip"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-status')))
    expect(statuses.every((s) => s === 'ok')).toBe(true)

    // Outputs appear in the Progress panel and open in the File preview.
    await page.click('[data-testid="toggle-panel"]')
    await expect.poll(() => page.locator('[data-testid="output-card"]').count()).toBeGreaterThanOrEqual(4)
    await page.locator('[data-testid="output-card"]', { hasText: 'deck.pptx' }).click()
    await expect.poll(() => page.locator('[data-testid="file-pane"]').getAttribute('data-kind')).toBe('slides')
    expect(await page.locator('.slide').count()).toBe(2)
    await page.click('[data-testid="tab-progress"]')
    await page.locator('[data-testid="output-card"]', { hasText: 'numbers.xlsx' }).click()
    await expect.poll(() => page.locator('[data-testid="file-pane"]').getAttribute('data-kind')).toBe('sheets')
    expect(await page.locator('.sheet').innerText()).toContain('112')

    // Deleting asks even in Bypass; deny keeps the file. (Bypass is offered only after Settings → Advanced → Offer Bypass.)
    await page.evaluate(() => window.foreman.settings.set({ advanced: { allowBypass: true } } as never))
    await page.click('[data-testid="mode-picker"]')
    await page.locator('.menu-item', { hasText: 'Bypass' }).click()
    llm.script.push({ toolCalls: [{ name: 'file_manage', arguments: `{"op":"delete","path":${p('memo.pdf')}}` }] }, { content: 'Kept it.' })
    await send(page, 'Delete the PDF')
    const card = page.locator('[data-testid="approval-card"]')
    await card.waitFor()
    expect(await card.innerText()).toContain('Move')
    expect(await card.innerText()).toContain('Trash')
    await card.locator('[data-testid="approve-deny"]').click()
    await idle(page)
    expect(existsSync(join(folder, 'memo.pdf'))).toBe(true)

    // Paths outside the workspace and the attached folder are refused.
    llm.script.push({ toolCalls: [{ name: 'file_read', arguments: '{"path":"/etc/hosts"}' }] }, { content: 'ok' })
    await send(page, 'read /etc/hosts')
    await idle(page)
    expect(String([...llm.requests.at(-1)!.messages].reverse().find((m: any) => m.role === 'tool').content)).toMatch(/outside the workspace and the folders the user attached/)
    await app.close()
  })
})
