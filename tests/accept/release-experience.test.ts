import { mkdirSync } from 'node:fs'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })

test('service API keys have a masked editor and provider off switches keep saved keys', async () => {
  const { app, page } = await launch(tempProfile(), llm.url, { SAHILBOT_QUIET: '1' })
  try {
    await page.evaluate(() => window.foreman.settings.set({ setKeys: { anthropic: 'fixture-provider-key' } }))
    await page.reload()
    await page.keyboard.press('Meta+,'); await page.click('[data-testid="settings-models"]')
    await page.click('[data-testid="provider-on-anthropic"]')
    const settings = await page.evaluate(() => window.foreman.settings.get())
    expect(settings.keys.anthropic).toBe(false); expect(settings.keysSaved?.anthropic).toBe(true)
    await page.click('[data-testid="provider-on-anthropic"]')
    expect((await page.evaluate(() => window.foreman.settings.get())).keys.anthropic).toBe(true)
    await page.click('[data-testid="settings-privacy"]'); await page.click('[data-testid="vault-tab-logins"]')
    await page.click('[data-testid="vault-add-api_key"]')
    await page.fill('[data-testid="vault-f-name"]', 'my-service')
    await page.fill('[data-testid="vault-f-site"]', 'https://api.example.test')
    await page.fill('[data-testid="vault-f-api-key"]', 'fixture_private_service_key_123456')
    expect(await page.getAttribute('[data-testid="vault-f-api-key"]', 'type')).toBe('password')
    await page.click('[data-testid="vault-save"]')
    await expect.poll(() => page.locator('[data-testid="vault-item"]').count()).toBe(1)
    const items = await page.evaluate(() => window.foreman.vault.items())
    expect(items[0]).toMatchObject({ kind: 'api_key', sites: ['https://api.example.test'], apiHeader: 'Authorization' })
    expect(JSON.stringify(items)).not.toContain('fixture_private')
    expect(await page.locator('[data-testid="settings"]').innerText()).not.toContain('fixture_private')
    // API keys sit under Logins, in their own list: the key isn't counted as a login.
    expect(items.filter((i) => i.kind !== 'api_key')).toHaveLength(0)
  } finally { await app.close() }
})

test('attachments have readable two-line rows and Cursor is not connected by an installed CLI', async () => {
  const { app, page } = await launch(tempProfile(), llm.url, { SAHILBOT_QUIET: '1' })
  try {
    await page.setViewportSize({ width: 900, height: 650 })
    await page.locator('.plus-pop > button').click()
    const items = page.locator('.attachment-pop .menu-item')
    expect(await items.count()).toBe(3)
    const layout = await items.evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect(), copy = el.querySelector('.attachment-menu-copy')!.getBoundingClientRect()
      return { left: r.left, right: r.right, copyWidth: copy.width, height: r.height }
    }))
    expect(layout.every((r) => r.left >= 0 && r.right <= 900 && r.copyWidth > 200 && r.height > 50)).toBe(true)
    mkdirSync('/tmp/sahilbot-ux-shots', { recursive: true })
    await page.screenshot({ path: '/tmp/sahilbot-ux-shots/4-attachments.png' })
    await page.keyboard.press('Escape'); await page.click('[data-testid="profile"]'); await page.click('[data-testid="connect-apps"]')
    await page.fill('[data-testid="conn-search"]', 'Cursor')
    const cursor = page.locator('[data-testid="preset-cursor-app"]')
    await cursor.waitFor()
    expect(await cursor.innerText()).toContain('Add key')
    expect(await cursor.innerText()).not.toContain('Connected')
  } finally { await app.close() }
})
