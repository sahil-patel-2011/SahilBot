import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { lastToolOutput, startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Docs end to end, through the real UI and main process with a scripted model: the bot creates a live
// document, the user edits a block in the Document tab, the bot's next edit (on its stale base) gets a
// conflict and re-reads, the final document keeps both changes, and it exports to Word.

let llm: MockLlm
const idle = async (page: Page): Promise<void> => {
  await expect.poll(() => llm.script.length, { timeout: 30_000 }).toBe(0)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 30_000 }).toBe(0)
}
const send = async (page: Page, text: string): Promise<void> => {
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
}
const call = (name: string, args: unknown) => ({ toolCalls: [{ name, arguments: JSON.stringify(args) }] })

describe('docs: a live document the bot and the user both edit', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })
  beforeEach(() => { llm.script.length = 0 })

  test('create → user edit → stale bot edit conflicts and re-reads → final doc keeps both → export .docx', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sb-docs-ws-'))
    const { app, page } = await launch(tempProfile(), llm.url)
    try {
      await page.evaluate((w) => window.foreman.settings.set({ workspaceDir: w }), ws)

      // 1. The bot drafts a document; it opens beside the chat.
      llm.script.push(
        call('doc_create', { title: 'Trip plan', markdown: '# Trip plan\n\nDay 1: Paris\n\n- Pack bags\n- Book hotel' }),
        { content: 'I drafted the trip plan beside the chat. Edit anything you like.' }
      )
      await send(page, 'Draft a trip plan we can edit together')
      await idle(page)
      await page.locator('[data-testid="doc-card"]').waitFor({ timeout: 10_000 })
      const editor = page.locator('[data-testid="doc-editor"]')
      await editor.waitFor({ timeout: 10_000 })
      await expect.poll(() => editor.getAttribute('data-version'), { timeout: 10_000 }).toBe('1')
      const docId = (await editor.getAttribute('data-doc'))!
      expect(docId).toBeTruthy()
      // The "# Trip plan" heading repeats the title, so it goes into the title field.
      expect(await page.locator('[data-testid="doc-title"]').inputValue()).toBe('Trip plan')
      expect(await page.locator('[data-testid="doc-block"]').count()).toBe(3)

      // 2. The user edits a block in the editor; it autosaves as the user's version 2.
      const para = page.locator('[data-testid="doc-block"]').filter({ hasText: 'Day 1: Paris' }).locator('.doc-text')
      await para.click()
      await page.keyboard.press('End')
      await page.keyboard.type(' and Lyon')
      await expect.poll(async () => {
        const d = await page.evaluate((id) => window.foreman.docs.get(id), docId)
        return `${d.version}:${d.lastAuthor}:${d.content.blocks[0].text}`
      }, { timeout: 15_000 }).toBe('2:user:Day 1: Paris and Lyon')
      const snap = await page.evaluate((id) => window.foreman.docs.get(id), docId)
      const paraId = snap.content.blocks[0].id
      const lastBullet = snap.content.blocks[2].id

      // 3. The bot edits from version 1 (stale): conflict → doc_read → edit on version 2 → export.
      llm.script.push(
        call('doc_edit', { base: 1, ops: [{ op: 'replace', id: paraId, markdown: 'Day 1: Paris (Louvre in the morning)' }] }),
        (req) => {
          expect(lastToolOutput(req)).toMatch(/Conflict: the user changed this document after version 1/)
          expect(lastToolOutput(req)).toContain('Day 1: Paris and Lyon')
          return call('doc_read', {})
        },
        (req) => {
          const out = lastToolOutput(req)
          expect(out).toContain('version 2')
          expect(out).toContain(`[${paraId}] Day 1: Paris and Lyon`)
          return call('doc_edit', {
            base: 2,
            summary: 'Added the Louvre and train tickets',
            ops: [
              { op: 'replace_text', id: paraId, find: 'and Lyon', replace: 'and Lyon (Louvre in the morning)' },
              { op: 'insert', after: lastBullet, markdown: '- Buy train tickets' }
            ]
          })
        },
        (req) => {
          expect(lastToolOutput(req)).toMatch(/now version 3/)
          return call('doc_export', { format: 'docx' })
        },
        { content: 'Done: I kept your Lyon edit, added the Louvre and train tickets, and exported it to Word.' }
      )
      await send(page, 'Add the Louvre to day 1 and a reminder to buy train tickets, then export it to Word')
      await idle(page)

      // The bot was told about the conflict (not silently overwritten).
      expect(llm.requests.some((r) => r.messages.some((m: { role: string; content: unknown }) => m.role === 'tool' && /the user changed this document/.test(String(m.content))))).toBe(true)

      // 4. The final document has both changes, and the editor shows the bot's edit live.
      const final = await page.evaluate((id) => window.foreman.docs.get(id), docId)
      expect(final.version).toBe(3)
      expect(final.lastAuthor).toBe('bot')
      expect(final.lastSummary).toBe('Added the Louvre and train tickets')
      expect(final.content.blocks.map((b) => b.text)).toEqual(['Day 1: Paris and Lyon (Louvre in the morning)', 'Pack bags', 'Book hotel', 'Buy train tickets'])
      await expect.poll(() => page.locator('[data-testid="doc-block"]').filter({ hasText: 'Louvre in the morning' }).count(), { timeout: 10_000 }).toBe(1)
      await expect.poll(() => page.locator('[data-testid="doc-block"]').filter({ hasText: 'Buy train tickets' }).count(), { timeout: 10_000 }).toBe(1)
      await expect.poll(() => editor.getAttribute('data-version'), { timeout: 10_000 }).toBe('3')

      // 5. The export is a real Word file in the workspace's exports folder.
      const docx = join(ws, 'exports', 'trip-plan.docx')
      await expect.poll(() => existsSync(docx), { timeout: 15_000 }).toBe(true)
      expect(statSync(docx).size).toBeGreaterThan(1000)
      expect(readFileSync(docx).subarray(0, 2).toString()).toBe('PK')

      await page.screenshot({ path: join(tmpdir(), 'sahilbot-docspace-editor.png') })

      // 6. History lists every version with its author; a diff opens for a version.
      await page.click('[data-testid="doc-history-toggle"]')
      await page.locator('[data-testid="doc-history"]').waitFor()
      await expect.poll(() => page.locator('[data-testid="doc-version"]').count(), { timeout: 5_000 }).toBe(3)
      await page.locator('[data-testid="doc-version"][data-n="2"]').click()
      await page.locator('[data-testid="doc-diff"]').waitFor()
      await expect.poll(() => page.locator('[data-testid="doc-diff"] ins').allInnerTexts(), { timeout: 5_000 }).toContain(' and Lyon')
      await page.screenshot({ path: join(tmpdir(), 'sahilbot-docspace-history.png') })
    } finally {
      await app.close()
    }
  })
})
