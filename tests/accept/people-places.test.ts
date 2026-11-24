import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// People & Places (src/main/context-engine), end to end and hidden: a chat about a person and a place →
// the idle learning pass → a new chat asks about them and its <context> block has the right cards →
// "Forget" in Vault → People & Places removes them (and Undo puts them back). The Privacy panel: every
// source and sensitive category on by default, each one click to turn off; Pause; locked never-stored rows.

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })

const lastUser = (req: Record<string, any>): string => {
  const m = [...req.messages].reverse().find((x: any) => x.role === 'user')
  return typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')
}

async function ask(page: Page, text: string): Promise<string> {
  const before = llm.requests.length
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
  await expect.poll(() => llm.requests.slice(before).some((r) => lastUser(r).includes(text)), { timeout: 20_000 }).toBe(true)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
  return lastUser(llm.requests.slice(before).find((r) => lastUser(r).includes(text))!)
}

describe('People & Places', () => {
  test('chat → learning pass → the cards in a new chat\'s context → forget removes them → undo', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    const ws = mkdtempSync(join(tmpdir(), 'sahilbot-ws-'))
    await page.evaluate((dir) => window.foreman.settings.set({ workspaceDir: dir, userName: 'Sam', local: { enabled: true } } as never), ws)

    await ask(page, "My sister Priya Patel's birthday is March 3 and she loves peonies. Last year I loved Taberna da Rua in Lisbon.")

    // The learning pass (the vault job runs the context engine).
    const before = (await page.evaluate(() => window.foreman.people.status())).lastRunAt ?? 0
    await page.evaluate(() => window.foreman.people.learnNow())
    await expect.poll(async () => (await page.evaluate(() => window.foreman.people.status())).lastRunAt ?? 0, { timeout: 30_000 }).toBeGreaterThan(before)
    const names = (await page.evaluate(() => window.foreman.people.list())).map((e) => e.name)
    expect(names).toEqual(expect.arrayContaining(['Priya Patel', 'Taberna da Rua', 'Lisbon']))
    const vaultRoot = (await page.evaluate(() => window.foreman.notesVault.status())).root
    expect(existsSync(join(vaultRoot, 'Shared/People/Priya Patel.md'))).toBe(true)

    // A new chat about her: one unified section with her card.
    await page.click('[data-testid="new-chat"]')
    const block = await ask(page, "When is Priya's birthday, and which restaurant did I love in Lisbon?")
    expect(block).toContain('## About the user and their world')
    expect(block).toMatch(/- Priya Patel \(person · your sister\): birthday March 3 \[you, chat “/)
    expect(block).toContain('peonies')
    expect(block).toMatch(/- Taberna da Rua \(place\): your take you loved it/)
    expect(block).not.toContain('## What you remember')

    // There is no People view: the user asks a bot to forget someone, which forgets the card (here, the same call).
    expect(await page.locator('[data-testid="vault-view"]').count()).toBe(0)
    const priya = (await page.evaluate(() => window.foreman.people.list())).find((e) => e.name === 'Priya Patel')!
    expect(JSON.stringify(await page.evaluate((id) => window.foreman.people.card(id), priya.id))).toContain('March 3')
    await page.evaluate((id) => window.foreman.people.forget(id), priya.id)
    await expect.poll(async () => (await page.evaluate(() => window.foreman.people.list())).some((e) => e.name === 'Priya Patel')).toBe(false)
    expect(existsSync(join(vaultRoot, 'Shared/People/Priya Patel.md'))).toBe(false)
    expect(readdirSync(join(vaultRoot, '.trash')).some((f) => f.includes('Priya Patel'))).toBe(true)
    // Privacy: every source and sensitive category on by default, one click to turn each off; a master
    // Pause; what's never stored is locked; activity stays off cloud models.
    const st0 = await page.evaluate(() => window.foreman.people.status())
    expect(st0.settings.sources).toEqual({ chats: true, files: true, connectorsInChats: true, activity: true })
    expect(Object.values(st0.settings.sensitive).every(Boolean)).toBe(true)
    expect(st0.connectors.find((c) => c.id === 'gmail')?.on).toBe(true)
    const act = await page.evaluate(() => window.foreman.activity.status())
    expect(act.settings).toMatchObject({ enabled: true, learn: true, shareWithCloud: false })
    expect(act.collecting).toBe(false)
    // No screen for these any more (settings are basics only); the switches still work.
    await page.evaluate(() => window.foreman.people.setSettings({ sources: { files: false } } as never))
    await expect.poll(async () => (await page.evaluate(() => window.foreman.people.status())).settings.sources.files).toBe(false)
    await page.evaluate(() => window.foreman.people.setSettings({ paused: true } as never))
    await expect.poll(async () => (await page.evaluate(() => window.foreman.people.status())).settings.paused).toBe(true)
    await page.evaluate(() => window.foreman.people.setSettings({ paused: false, sources: { files: true } } as never))
    await expect.poll(async () => { const s = (await page.evaluate(() => window.foreman.people.status())).settings; return s.sources.files && !s.paused }).toBe(true)

    // A new chat no longer gets her card.
    await page.click('[data-testid="new-chat"]')
    const after = await ask(page, 'What does Priya like?')
    expect(after).not.toMatch(/Priya Patel \(person/)
    expect(after).not.toContain('peonies')

    // Undo (Privacy → Recently removed) puts her back.
    const trash = (await page.evaluate(() => window.foreman.people.status())).trash
    expect(trash[0].label).toBe('Forgot Priya Patel')
    await page.evaluate((id) => window.foreman.people.undo(id), trash[0].id)
    await expect.poll(async () => (await page.evaluate(() => window.foreman.people.list())).some((e) => e.name === 'Priya Patel')).toBe(true)
    expect(existsSync(join(vaultRoot, 'Shared/People/Priya Patel.md'))).toBe(true)
    await app.close()
  })
})
