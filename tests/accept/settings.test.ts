import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Settings, simplified: nine pages with the common choices on top and the rest behind "Advanced"; search
// jumps to any setting (opening its tab and disclosure); Memory is a plain list with edit and delete (Undo);
// Voice shows the speech model picked for this Mac (its download is only recorded in test runs).

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })

describe('Settings', () => {
  test('the pages, search to an Advanced setting, Memory list/edit/delete, and Voice\'s model', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '24', FOREMAN_MODELS_DIR: mkdtempSync(join(tmpdir(), 'set-models-')) })
    try {
      await page.evaluate(async () => {
        await window.foreman.memory.add('Prefers metric units', null, 'preference')
        await window.foreman.memory.add('Sister Alex lives in Austin', null, 'person')
        await window.foreman.memory.add('Training for the Boston marathon in April', null, 'fact')
      })
      await page.keyboard.press('Meta+,')
      await page.locator('[data-testid="settings"]').waitFor()

      // One flat list, most-used first. Phone & server only shows once in use or in Developer mode (on in tests).
      const ids = await page.locator('.set-nav .set-nav-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
      expect(ids).toEqual(['settings-general', 'settings-models', 'settings-connected', 'settings-memory', 'settings-privacy', 'settings-permissions', 'settings-voice', 'settings-usage', 'settings-server', 'settings-advanced'])
      expect(await page.locator('[data-testid="settings-more"]').count()).toBe(0)
      // General: theme folded in; appearance details under More (closed).
      expect(await page.locator('[data-setting="theme"]').count()).toBe(1)
      expect(await page.locator('[data-testid="general-more"]').getAttribute('open')).toBeNull()
      // Privacy & Security: tabs for passwords, approvals, permissions, activity, sensitive details.
      await page.click('[data-testid="settings-privacy"]')
      await page.locator('[data-testid="vault-status"]').waitFor()
      await page.click('[data-testid="settings-permissions"]')
      await page.locator('[data-testid="approvals-rules"] > summary').click()
      await page.locator('[data-testid="rule-when"]').waitFor()
      await page.click('[data-testid="settings-privacy"]')
      await page.click('[data-testid="settings-tab-sensitive"]')
      await expect.poll(() => page.locator('[data-testid^="settings-sens-"]').count()).toBeGreaterThan(5)
      // Advanced: rules & skills, knowledge folders, developer.
      await page.click('[data-testid="settings-advanced"]')
      await page.click('[data-testid="settings-tab-knowledge"]')
      await page.locator('[data-testid="knowledge-settings"]').waitFor()

      // Search jumps to a setting inside a closed Advanced section and opens it.
      await page.click('[data-testid="settings-general"]')
      await page.fill('[data-testid="settings-search"]', 'openrouter')
      await page.locator('[data-testid="settings-result-servers"]').waitFor()
      expect(await page.locator('[data-testid="settings-result-servers"]').innerText()).toContain('Models & Keys · Advanced')
      await page.keyboard.press('Enter')
      await expect.poll(() => page.locator('[data-testid="settings-models"]').getAttribute('class')).toContain(' on')
      await expect.poll(() => page.locator('[data-testid="models-advanced"]').getAttribute('open')).not.toBeNull()
      await expect.poll(() => page.locator('[data-setting="servers"]').isVisible()).toBe(true)
      expect(await page.locator('[data-testid="key-openrouter"]').isVisible()).toBe(true)
      // ...and to one on another page's tab.
      await page.fill('[data-testid="settings-search"]', 'approval')
      await page.click('[data-testid="settings-result-approval-rules"]')
      await expect.poll(() => page.locator('[data-testid="settings-permissions"]').getAttribute('class')).toContain(' on')
      await expect.poll(() => page.locator('[data-testid="rule-when"]').isVisible()).toBe(true)

      // Memory: one switch, a plain list with category chips, click to edit, delete with Undo.
      await page.click('[data-testid="settings-memory"]')
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
      // Learned and the knowledge vault are tabs; People & Places is a link.
      await page.click('[data-testid="settings-tab-learned"]')
      await page.locator('[data-testid="learning-log"]').waitFor()
      await page.click('[data-testid="settings-tab-vault"]')
      await page.locator('[data-testid="vault-settings"]').waitFor()
      expect(await page.locator('[data-testid="memory-people"]').count()).toBe(1)

      await page.click('[data-testid="settings-voice"]')
      await page.selectOption('[data-testid="voice-provider"]', 'xai')
      await expect.poll(() => page.evaluate(async () => (await window.foreman.settings.get()).voiceOutput?.provider)).toBe('xai')
      expect((await page.evaluate(() => window.foreman.voice.status())).speech?.requested).toEqual([])
      await page.click('[data-testid="settings-close"]')
    } finally {
      await app.close()
    }
  }, 120_000)
})
