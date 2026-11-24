import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, settingsPage, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Settings, Grok Bot's way: a plain list of five pages (General, AI, Apps, Voice, Privacy), each a title and a few
// rows; everything else shows in Developer mode only. ⌘K finds any setting and opens Settings right at it (Developer
// mode settings only in Developer mode). Memory isn't listed, but a link opens it: a plain list with edit and
// delete (Undo). Voice shows the speech model picked for this Mac (its download is only recorded in test runs).
// SETTINGS_SHOTS=<folder> saves a screenshot of every page outside Developer mode.

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })

describe('Settings', () => {
  test('Developer mode: every page and its full controls, Memory list/edit/delete, and the one voice choice', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '24', FOREMAN_MODELS_DIR: mkdtempSync(join(tmpdir(), 'set-models-')) })
    try {
      await page.evaluate(async () => {
        await window.foreman.memory.add('Prefers metric units', null, 'preference')
        await window.foreman.memory.add('Sister Alex lives in Austin', null, 'person')
        await window.foreman.memory.add('Training for the Boston marathon in April', null, 'fact')
      })
      await page.keyboard.press('Meta+,')
      await page.locator('[data-testid="settings"]').waitFor()

      // The pages, in order; Phone & server shows in Developer mode (on in tests). Memory has its own place in the app.
      const ids = await page.locator('.set-nav .set-nav-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
      expect(ids).toEqual(['settings-general', 'settings-models', 'settings-connected', 'settings-voice', 'settings-privacy', 'settings-server'])
      expect(await page.locator('[data-testid="settings-more"]').count()).toBe(0)
      // General: the basics plus the Developer mode rows; no text size, step detail or Advanced fold.
      for (const id of ['theme', 'workspace', 'quick-ask', 'birthday', 'dev-mode']) expect(await page.locator(`[data-setting="${id}"]`).count(), id).toBe(1)
      for (const id of ['font-size', 'density', 'chat-width', 'menu-bar']) expect(await page.locator(`[data-setting="${id}"]`).count(), id).toBe(0)
      expect(await page.locator('[data-testid="general-more"]').count()).toBe(0)
      expect(await page.locator('[data-testid="settings-advanced-section"]').count()).toBe(0)
      // Privacy: your Mac, passwords and backups. No approval rules or "what it may see" tab.
      await page.click('[data-testid="settings-privacy"]')
      await page.locator('[data-testid="vault-status"]').waitFor()
      expect(await page.locator('[data-testid="settings-tab-backups"]').count()).toBe(1)
      expect(await page.locator('[data-testid="approvals-rules"]').count()).toBe(0)
      expect(await page.locator('[data-testid="settings-tab-privacy"]').count()).toBe(0)
      // AI: keys, the plans, the limit, how answers are picked, the models list, local models and usage.
      await page.click('[data-testid="settings-models"]')
      await page.locator('[data-testid="key-anthropic"]').waitFor()
      for (const id of ['auto-prefers', 'local-models', 'model-list', 'usage', 'monthly-limit']) expect(await page.locator(`[data-setting="${id}"]`).count(), id).toBe(1)
      expect(await page.locator('[data-testid="spend-mode-unlimited"]').count()).toBe(1)
      expect(await page.locator('[data-testid="models-advanced"]').count()).toBe(0)
      await page.click('[data-testid="settings-connected"]')
      await page.locator('[data-testid="connected-advanced"]').waitFor()

      // ⌘K finds Developer mode settings here, and opens Settings right at them.
      await page.keyboard.press('Meta+k')
      await page.fill('[data-testid="palette-input"]', 'workspace folder')
      await page.locator('.pal-item', { hasText: 'Workspace folder' }).first().click()
      await expect.poll(() => page.locator('[data-testid="settings-general"]').getAttribute('class')).toContain(' on')

      // Memory: one switch, a plain list with category chips, click to edit, delete with Undo.
      await settingsPage(page, 'memory')
      expect(await page.getAttribute('[data-testid="memory-auto"]', 'aria-checked')).toBe('true')
      expect(await page.locator('[data-testid="learning-now"]').count()).toBe(0)
      const rows = page.locator('[data-testid="memory-row"]')
      await expect.poll(() => rows.count()).toBe(3)
      await page.click('[data-testid="memory-chip-person"]')
      await expect.poll(() => rows.count()).toBe(1)
      await page.click('[data-testid="memory-chip-all"]')
      await page.fill('[data-testid="memory-search"]', 'metric')
      await expect.poll(() => rows.count()).toBe(1)
      await rows.first().locator('[data-testid="memory-text"]').click()
      await page.fill('[data-testid="memory-edit"]', 'Prefers metric units and 24-hour time')
      await page.click('[data-testid="memory-save"]')
      await expect.poll(async () => (await page.evaluate(() => window.foreman.memory.list())).map((m) => m.content)).toContain('Prefers metric units and 24-hour time')
      await page.fill('[data-testid="memory-search"]', '')
      const before = await page.evaluate(() => window.foreman.memory.list())
      const alex = before.find((m) => m.content.includes('Alex'))!
      await page.locator('[data-testid="memory-row"]', { hasText: 'Sister Alex' }).hover()
      await page.locator('[data-testid="memory-row"]', { hasText: 'Sister Alex' }).locator('[data-testid="memory-forget"]').click()
      await expect.poll(async () => (await page.evaluate(() => window.foreman.memory.list())).length).toBe(2)
      await page.locator('.toast button', { hasText: 'Undo' }).click()
      await expect.poll(async () => (await page.evaluate(() => window.foreman.memory.list())).find((m) => m.content.includes('Alex'))).toMatchObject({ id: alex.id, category: 'person', createdAt: alex.createdAt })
      await expect.poll(() => rows.count()).toBe(3)
      // The master switch turns learning off (an explicit choice) and back on.
      await page.click('[data-testid="memory-auto"]')
      await expect.poll(async () => (await page.evaluate(() => window.foreman.settings.get())).learning).toMatchObject({ enabled: false, explicit: ['enabled'] })
      await page.click('[data-testid="memory-auto"]')
      await expect.poll(async () => (await page.evaluate(() => window.foreman.settings.get())).learning?.enabled).toBe(true)
      // Memories and Learned are the only tabs (no Brain, sources or vault tabs to manage).
      await page.click('[data-testid="settings-tab-learned"]')
      await page.locator('[data-testid="learning-log"]').waitFor()
      for (const id of ['settings-tab-vault', 'settings-tab-sources', 'settings-tab-brain']) expect(await page.locator(`[data-testid="${id}"]`).count(), id).toBe(0)

      await page.click('[data-testid="settings-voice"]')
      await page.selectOption('[data-testid="voice-provider"]', 'xai')
      await expect.poll(() => page.evaluate(async () => (await window.foreman.settings.get()).voiceOutput?.provider)).toBe('xai')
      expect((await page.evaluate(() => window.foreman.voice.status())).speech?.requested).toEqual([])
      await page.click('[data-testid="settings-close"]')
    } finally {
      await app.close()
    }
  }, 120_000)

  test('outside Developer mode: five plain pages with only the basics, and ⌘K opens the right page', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { SAHILBOT_QUIET: '1' })
    const shots = process.env.SETTINGS_SHOTS
    const snap = async (name: string): Promise<void> => { if (shots) { await page.waitForTimeout(1500); await page.screenshot({ path: join(shots, `settings-${name}.png`) }) } }
    const has = async (id: string): Promise<number> => page.locator(`.set-body [data-setting="${id}"]`).count()
    try {
      expect((await page.evaluate(() => window.foreman.settings.get())).advanced.devMode).toBe(false)
      await page.keyboard.press('Meta+,')
      await page.locator('[data-testid="settings"]').waitFor()

      // A plain list of names with small icons: no hint lines, no search box, no Memory, no Phone & server (not in use).
      const nav = page.locator('.set-nav .set-nav-item')
      expect(await nav.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))).toEqual(['settings-general', 'settings-models', 'settings-connected', 'settings-voice', 'settings-privacy'])
      expect(await nav.allInnerTexts()).toEqual(['General', 'AI', 'Apps', 'Voice', 'Privacy'])
      expect(await page.locator('.set-nav .set-nav-icon').count()).toBe(5)
      expect(await page.locator('.set-nav small, [data-testid="settings-search"], [data-testid="settings-memory"], [data-testid="settings-server"]').count()).toBe(0)
      expect(await page.locator('.set-nav-foot').innerText()).toMatch(/^SahilBot \d/)
      // Each page: its title, then rows (no explanatory line under the title).
      const title = async (t: string): Promise<void> => {
        await expect.poll(() => page.locator('.set-body h2').first().innerText()).toBe(t)
        expect(await page.locator('.set-body h2 + .set-sub').count(), t).toBe(0)
      }

      // General: name, email and phone, theme, open at login, updates (with What's new). Nothing else.
      await title('General')
      for (const id of ['user-name', 'me-contact', 'theme', 'open-at-login', 'updates']) expect(await has(id), id).toBe(1)
      for (const id of ['workspace', 'quick-ask', 'birthday', 'dev-mode', 'phone-access']) expect(await has(id), id).toBe(0)
      for (const id of ['me-first', 'me-last', 'me-emails', 'me-phones', 'theme-dark', 'open-at-login', 'update-check', 'whats-new-toggle']) expect(await page.locator(`[data-testid="${id}"]`).count(), id).toBe(1)
      expect(await page.locator('.set-body .set-row').count()).toBe(5)
      await snap('general')

      // AI: the three keys (with their switches once saved), the ChatGPT/Grok plans, and the limit with this month's spend.
      await page.click('[data-testid="settings-models"]')
      await title('AI')
      for (const id of ['key-anthropic', 'key-openai', 'key-xai', 'chatgpt-plan', 'monthly-limit']) expect(await has(id), id).toBe(1)
      for (const id of ['auto-prefers', 'local-models', 'model-list', 'usage']) expect(await has(id), id).toBe(0)
      expect(await page.locator('[data-testid="models-subscriptions"]').count()).toBe(1)
      await expect.poll(() => page.locator('[data-testid="spend-settings"]').innerText()).toMatch(/^\$\d+\.\d\d of \$\d+\.\d\d used this month$/)
      expect(await page.locator('[data-testid="spend-mode-unlimited"], [data-testid="recommended-row"], [data-testid="settings-ollama-setup"]').count()).toBe(0)
      expect(await page.locator('.set-body').innerText()).not.toMatch(/How answers are picked|Prefer|Models in the picker|Recommended for this Mac|For developers|Cursor/)
      await snap('ai')
      // The limit's one row works: No limit, then back to a monthly amount.
      await page.selectOption('[data-testid="spend-mode"]', 'unlimited')
      await expect.poll(() => page.evaluate(async () => (await window.foreman.settings.get()).spendingMode)).toBe('unlimited')
      await page.selectOption('[data-testid="spend-mode"]', 'amount')
      await page.fill('[data-testid="budget-cap"]', '40')
      await page.locator('[data-testid="budget-cap"]').press('Enter')
      await expect.poll(() => page.evaluate(async () => (await window.foreman.settings.get()).cloudBudgetUsd)).toBe(40)

      // Apps: what's connected and one Connect apps button.
      await page.click('[data-testid="settings-connected"]')
      await title('Apps')
      await page.locator('[data-testid="settings-connect-apps"]').waitFor()
      expect(await page.locator('.set-body .set-row').count()).toBe(1)
      expect(await page.locator('[data-testid="connected-advanced"], [data-testid="connect-cursor"]').count()).toBe(0)
      await snap('apps')

      // Voice: the one choice.
      await page.click('[data-testid="settings-voice"]')
      await title('Voice')
      await page.locator('[data-testid="voice-provider"]').waitFor()
      expect(await page.locator('.set-body .set-row').count()).toBe(1)
      expect(await has('speech-model')).toBe(0)
      await snap('voice')

      // Privacy: the Mac permissions and Passwords; no Backups tab.
      await page.click('[data-testid="settings-privacy"]')
      await title('Privacy')
      await page.locator('[data-testid="vault-status"]').waitFor()
      for (const id of ['mac-permissions', 'passwords']) expect(await has(id), id).toBe(1)
      expect(await page.locator('[data-testid="settings-tab-backups"], [data-testid="settings-tab-passwords"]').count()).toBe(0)
      expect(await has('backups')).toBe(0)
      await snap('privacy')

      // ⌘K: a basic setting opens its page; a Developer mode one isn't offered.
      await page.keyboard.press('Meta+k')
      await page.fill('[data-testid="palette-input"]', 'workspace folder')
      await expect.poll(() => page.locator('.pal-item').allInnerTexts()).not.toContainEqual(expect.stringContaining('Workspace folder'))
      await page.fill('[data-testid="palette-input"]', 'budget')
      await page.locator('.pal-item', { hasText: 'Monthly spending limit' }).first().click()
      await expect.poll(() => page.locator('[data-testid="settings-models"]').getAttribute('class')).toContain(' on')
      // Memory: not listed, but a search still opens it in Settings.
      await page.keyboard.press('Meta+k')
      await page.fill('[data-testid="palette-input"]', 'remember things')
      await page.locator('.pal-item', { hasText: 'Remember things automatically' }).first().click()
      await page.locator('[data-testid="memory-auto"]').waitFor()
      expect(await page.locator('.set-nav-item.on').count()).toBe(0)

      // ⌘K turns Developer mode on: the full controls come back, and General can turn it off again.
      await page.keyboard.press('Meta+k')
      await page.fill('[data-testid="palette-input"]', 'developer')
      await page.locator('.pal-item', { hasText: 'Turn on Developer mode' }).click()
      await expect.poll(() => page.evaluate(async () => (await window.foreman.settings.get()).advanced.devMode)).toBe(true)
      await page.click('[data-testid="settings-general"]')
      await page.locator('[data-setting="workspace"]').waitFor()
      await page.click('[data-testid="dev-mode"]')
      await expect.poll(() => page.evaluate(async () => (await window.foreman.settings.get()).advanced.devMode)).toBe(false)
      await expect.poll(() => page.locator('[data-setting="workspace"]').count()).toBe(0)
      await page.click('[data-testid="settings-close"]')
    } finally {
      await app.close()
    }
  }, 120_000)
})
