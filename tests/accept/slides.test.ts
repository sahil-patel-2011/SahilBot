import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Native decks end to end: the bot drafts a deck, it opens in the slide editor, the user types on a slide and
// adds one, the deck exports to PowerPoint; and Artifacts → Slides starts a blank deck in a new chat.

let llm: MockLlm
const shots = process.env.SAHILBOT_SHOTS
const shot = async (page: Page, name: string): Promise<void> => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }) }
const call = (name: string, args: unknown) => ({ toolCalls: [{ name, arguments: JSON.stringify(args) }] })

describe('slides: a native deck the bot and the user both edit', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('bot drafts a deck → user edits a slide and adds one → exports .pptx; Artifacts → Slides makes a new deck', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sb-slides-ws-'))
    const { app, page } = await launch(tempProfile(), llm.url)
    try {
      await page.evaluate((w) => window.foreman.settings.set({ workspaceDir: w }), ws)
      await page.setViewportSize({ width: 1500, height: 950 }).catch(() => undefined)
      llm.script.push(
        call('doc_create', { title: 'Launch plan', type: 'slides', markdown: '## Launch plan\n- Spring 2027\n\n## Goals\n- 1,000 sign-ups\n- Two partners\n  - One retailer\n> Keep this under a minute.\n\n## Timeline\n- March: beta\n- April: launch' }),
        { content: 'I drafted the deck beside the chat.' }
      )
      await page.fill('[data-testid="composer-input"]', 'Make a launch deck we can edit together')
      await page.keyboard.press('Enter')
      await page.locator('[data-testid="slides"]').waitFor({ timeout: 20_000 })
      const editor = page.locator('[data-testid="doc-editor"]')
      const docId = (await editor.getAttribute('data-doc'))!
      await expect.poll(() => page.locator('[data-testid="slide-thumb"]').count(), { timeout: 10_000 }).toBe(3)
      expect(await page.locator('[data-testid="slide-title"]').inputValue()).toBe('Launch plan')
      await shot(page, 'deck-title')

      // The user picks slide 2 and changes its title and points by typing on the slide.
      await page.locator('[data-testid="slide-thumb"]').nth(1).click()
      expect(await page.locator('[data-testid="slide-points"]').inputValue()).toBe('1,000 sign-ups\nTwo partners\n\tOne retailer')
      expect(await page.locator('[data-testid="slide-notes"]').inputValue()).toBe('Keep this under a minute.')
      await page.locator('[data-testid="slide-title"]').click()
      await page.keyboard.press('End')
      await page.keyboard.type(' for 2027')
      await page.locator('[data-testid="slide-points"]').click()
      await page.keyboard.press('Meta+ArrowDown')
      await page.keyboard.type('\nPress coverage')
      await shot(page, 'deck-edit')
      await page.locator('[data-testid="slide-add"]').click()
      await expect.poll(() => page.locator('[data-testid="slide-thumb"]').count()).toBe(4)
      await page.locator('[data-testid="slide-title"]').fill('Questions?')
      await expect.poll(async () => {
        const d = await page.evaluate((id) => window.foreman.docs.get(id), docId)
        return d.content.blocks.filter((b) => b.type === 'h2').map((b) => b.text).join(' | ') + ' / ' + d.content.blocks.some((b) => b.text === 'Press coverage') + ' / ' + d.content.kind
      }, { timeout: 15_000 }).toBe('Launch plan | Goals for 2027 | Timeline | Questions? / true / slides')

      const pptx = await page.evaluate((id) => window.foreman.docs.export(id, 'pptx'), docId)
      expect(pptx.endsWith('.pptx')).toBe(true)

      // Artifacts → Slides: a blank deck in its own chat.
      await page.locator('[data-testid="nav-artifacts"], [data-testid="nav-files"]').first().click()
      await page.locator('[data-testid="make-new"]').waitFor({ timeout: 10_000 })
      await shot(page, 'artifacts')
      await page.locator('[data-testid="make-slides"]').click()
      await page.locator('[data-testid="slides"]').waitFor({ timeout: 15_000 })
      expect(await page.locator('[data-testid="slide-thumb"]').count()).toBe(1)
      expect(await page.locator('[data-testid="doc-editor"]').getAttribute('data-doc')).not.toBe(docId)
      await shot(page, 'new-deck')
    } catch (e) { await shot(page, 'failure'); throw e } finally { await app.close() }
  }, 120_000)
})
