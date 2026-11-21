import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
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
        call('doc_create', { title: 'Launch plan', type: 'slides', markdown: '### Product launch\n## Launch plan\n- Spring 2027\n- From beta to a public launch in six weeks\n- **1,000** Sign-ups\n- **6** Weeks\n\n## Goals\n- 1,000 sign-ups\n- Two partners\n  - One retailer\n> Keep this under a minute.\n\n## Timeline\n- March: beta\n- April: launch' }),
        { content: 'I drafted the deck beside the chat.' }
      )
      await page.fill('[data-testid="composer-input"]', 'Make a launch deck we can edit together')
      await page.keyboard.press('Enter')
      await page.locator('[data-testid="slides"]').waitFor({ timeout: 20_000 })
      const editor = page.locator('[data-testid="doc-editor"]')
      const docId = (await editor.getAttribute('data-doc'))!
      await expect.poll(() => page.locator('[data-testid="slide-thumb"]').count(), { timeout: 10_000 }).toBe(3)
      expect(await page.locator('[data-testid="slide-title"]').textContent()).toBe('Launch plan')
      expect(await page.locator('[data-testid="slide-kicker"]').textContent()).toBe('Product launch')
      await shot(page, 'deck-title')

      // The user picks slide 2 and types on the slide itself.
      await page.locator('[data-testid="slide-thumb"]').nth(1).click()
      expect(await page.locator('[data-testid="slide-point"]').allTextContents()).toEqual(['1,000 sign-ups', 'Two partners', 'One retailer'])
      expect(await page.locator('[data-testid="slide-notes"]').inputValue()).toBe('Keep this under a minute.')
      await page.locator('[data-testid="slide-title"]').click()
      await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-testid]')?.getAttribute('data-testid') ?? '')).toBe('slide-title')
      await page.keyboard.press('End')
      await page.keyboard.type(' for 2027')
      await page.locator('[data-testid="slide-point"]').last().click()
      await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[data-testid]')?.getAttribute('data-testid') ?? '')).toBe('slide-point')
      await page.keyboard.press('End')
      await page.keyboard.press('Shift+Tab')
      await expect.poll(() => page.evaluate(() => document.activeElement?.textContent ?? '')).toBe('One retailer')
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
      // The new, empty point has the caret before typing (as when a person types).
      await expect.poll(() => page.evaluate(() => { const a = document.activeElement; return a?.getAttribute('data-testid') === 'slide-point' && !a.textContent })).toBe(true)
      await page.keyboard.type('Press coverage')
      await page.locator('[data-testid="slide-add-stat"]').click()
      await page.keyboard.press('Meta+a')
      await page.keyboard.type('3')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Meta+a')
      await page.keyboard.type('Partners')
      await shot(page, 'deck-edit')
      await page.locator('[data-testid="slide-add"]').click()
      await expect.poll(() => page.locator('[data-testid="slide-thumb"]').count()).toBe(4)
      await page.keyboard.type('Questions?')
      await expect.poll(async () => {
        const d = await page.evaluate((id) => window.foreman.docs.get(id), docId)
        const b = d.content.blocks
        return [b.filter((x) => x.type === 'h2').map((x) => x.text).join(' | '), b.some((x) => x.text === 'Press coverage'), b.some((x) => x.text === '**3** Partners'), b.find((x) => x.text === 'One retailer')?.indent ?? 0, d.content.kind].join(' / ')
      }, { timeout: 15_000 }).toBe('Launch plan | Goals for 2027 | Questions? | Timeline / true / true / 0 / slides')

      // Every deck format.
      for (const f of ['pptx', 'pdf', 'pptx_pictures', 'odp', 'png'] as const) {
        const out = await page.evaluate(([id, fmt]) => window.foreman.docs.export(id, fmt), [docId, f] as const)
        const st = statSync(out)
        if (f === 'png') { expect(st.isDirectory()).toBe(true); expect(readdirSync(out).filter((n) => n.endsWith('.png'))).toHaveLength(4) }
        else expect(st.size).toBeGreaterThan(f === 'pptx_pictures' ? 50_000 : 2_000)
        if (f === 'pdf') expect(readFileSync(out).toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length).toBe(4)
        if (f === 'pptx_pictures') expect(out.endsWith('-pictures.pptx')).toBe(true)
        if (shots) cpSync(out, join(shots, `export-${f}${f === 'png' ? '' : `.${f === 'pptx_pictures' ? 'pptx' : f}`}`), { recursive: true })
      }

      // Grid view and Present.
      await page.locator('[data-testid="deck-view"]').click()
      await page.locator('[data-testid="deck-grid"]').click()
      await expect.poll(() => page.locator('.deck-grid [data-testid="slide-thumb"]').count()).toBe(4)
      await shot(page, 'deck-grid')
      await page.locator('[data-testid="slide-thumb"]').first().click()
      await page.locator('[data-testid="deck-view"]').click()
      await page.locator('[data-testid="deck-present"]').click()
      await page.locator('.deck-present').waitFor()
      await shot(page, 'deck-present')
      await page.keyboard.press('Escape')
      await expect.poll(() => page.locator('.deck-present').count()).toBe(0)

      // Artifacts → Slides: a blank deck in its own chat.
      await page.locator('[data-testid="nav-artifacts"], [data-testid="nav-files"]').first().click()
      await page.locator('[data-testid="make-new"]').waitFor({ timeout: 10_000 })
      await shot(page, 'artifacts')
      await page.locator('[data-testid="make-slides"]').click()
      await page.locator('[data-testid="slides"]').waitFor({ timeout: 15_000 })
      expect(await page.locator('[data-testid="slide-thumb"]').count()).toBe(1)
      expect(await page.locator('[data-testid="doc-editor"]').getAttribute('data-doc')).not.toBe(docId)
      await shot(page, 'new-deck')

      // Slash command: "/de" → /deck opens a new deck.
      await page.locator('[data-testid="nav-artifacts"], [data-testid="nav-files"]').first().click()
      await page.keyboard.press('Meta+n')
      await page.fill('[data-testid="composer-input"]', '/de')
      await page.locator('[data-testid="slash-menu"]').waitFor({ timeout: 5_000 })
      await shot(page, 'slash-menu')
      await page.keyboard.press('Enter')
      await expect.poll(async () => (await page.locator('[data-testid="slide-thumb"]').count()) === 1 && (await page.locator('[data-testid="doc-editor"]').getAttribute('data-doc')) !== docId, { timeout: 15_000 }).toBe(true)
      expect(await page.locator('[data-testid="composer-input"]').inputValue()).toBe('')

      // Artifacts → Dashboards: a starter dashboard, drawn, with a chart from its table; exports to PDF.
      await page.locator('[data-testid="nav-artifacts"], [data-testid="nav-files"]').first().click()
      await page.locator('[data-testid="make-dashboard"]').click()
      await page.locator('[data-testid="dashboard"]').waitFor({ timeout: 15_000 })
      expect(await page.locator('[data-testid="dashboard"] .db-tile').count()).toBe(2)
      expect(await page.locator('[data-testid="dashboard"] svg rect').count()).toBeGreaterThan(0)
      await shot(page, 'dashboard')
      const dashId = (await page.locator('[data-testid="doc-editor"]').getAttribute('data-doc'))!
      const dpdf = await page.evaluate((id) => window.foreman.docs.export(id, 'pdf'), dashId)
      expect(statSync(dpdf).size).toBeGreaterThan(5_000)
      await page.locator('[data-testid="dash-edit"]').click()
      expect(await page.locator('[data-testid="doc-block"]').count()).toBeGreaterThan(3)
    } catch (e) {
      await shot(page, 'failure')
      if (process.env.SLIDES_DEBUG) { const { writeFileSync } = await import('node:fs'); const id = await page.locator('[data-testid="doc-editor"]').getAttribute('data-doc'); writeFileSync(process.env.SLIDES_DEBUG, JSON.stringify(await page.evaluate((x) => window.foreman.docs.get(x!), id), null, 1)) }
      throw e
    } finally { await app.close() }
  }, 120_000)
})
