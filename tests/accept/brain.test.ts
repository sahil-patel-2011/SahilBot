import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { EXTRACT, brainFixture, brainReplies } from '../fixtures/brain-fixture'

// Your brain, end to end and hidden: fake connected apps (SAHILBOT_BRAIN_FIXTURE) → the Brain page shows the
// sources (on / needs sign-in) and the first-read estimate → OK → a sync on the local model writes facts and a
// "Written for you" brief with source chips → Agent mode on → a prompt in Needs you → Draft it starts a normal
// chat run. No real accounts, no paid calls.

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })

describe('Your brain', () => {
  test('sources, first-read estimate, a sync into briefs with chips, Agent mode prompt in Needs you, Draft it', async () => {
    for (let i = 0; i < 80; i++) llm.script.push(brainReplies)
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64', SAHILBOT_BRAIN_FIXTURE: brainFixture(), FOREMAN_IDLE_MS: '0' })
    try {
      await page.evaluate(() => window.foreman.settings.set({ local: { enabled: true }, userName: 'Sam' } as never))
      await page.evaluate(() => window.foreman.brain.setSettings({ quietHours: { start: '00:00', end: '00:00' } }))

      await page.click('[data-testid="profile"]'); await page.click('[data-testid="nav-brain"]')
      await page.locator('[data-testid="brain-view"]').waitFor()
      await expect.poll(() => page.locator('[data-testid="brain-source"][data-id="gmail"]').getAttribute('data-state')).toBe('on')
      expect(await page.locator('[data-testid="brain-source"][data-id="hubspot"]').getAttribute('data-state')).toBe('needs-sign-in')
      expect(await page.locator('[data-testid="brain-source"][data-id="texts"]').count()).toBe(1)
      expect(await page.locator('[data-testid="brain-stat-cadence"]').innerText()).toMatch(/~15 min/)
      expect(await page.locator('[data-testid="brain-empty-briefs"]').innerText()).toMatch(/No briefs yet/)
      // Nothing to search or filter yet: no search box or filter tabs.
      expect(await page.locator('[data-testid="brain-search"]').count()).toBe(0)

      // The first read waits for an OK on its estimate.
      await page.click('[data-testid="profile"]'); await page.click('[data-testid="nav-brain"]')
      const estimate = page.locator('[data-testid="brain-estimate"]', { hasText: 'Gmail' })
      await expect.poll(() => estimate.count(), { timeout: 15_000 }).toBe(1)
      expect(await estimate.innerText()).toMatch(/Read the last 30 days of Gmail: about 2 emails/)
      await estimate.locator('[data-testid="brain-estimate-ok"]').click()

      // The sync: filtered, extracted on the local model, briefs written.
      await expect.poll(async () => (await page.evaluate(() => window.foreman.brain.briefs())).find((b) => b.name === 'Acme Retail')?.text ?? '', { timeout: 30_000 }).toMatch(/renews Q1/)
      const extract = llm.requests.filter((r) => String(r.messages?.[0]?.content ?? '').startsWith(EXTRACT))
      expect(extract.length).toBeGreaterThanOrEqual(1)
      expect(String(extract[0].messages[1].content)).toContain('revised proposal by Friday')
      expect(String(extract[0].messages[1].content)).not.toContain('weekly digest')
      const card = page.locator('[data-testid="brain-brief"]').filter({ has: page.locator('.brain-card-name', { hasText: /^Acme Retail$/ }) })
      await card.waitFor()
      expect(await card.innerText()).toMatch(/CLIENT/i)
      expect(await page.locator('[data-testid="brain-search"]').count()).toBe(1)
      expect(await card.locator('[data-testid="brain-chip"]').first().innerText()).toMatch(/^Email · /)
      const status = await page.evaluate(() => window.foreman.brain.status())
      expect(status.stats.tools).toBe(2)
      expect(status.stats.memories).toBeGreaterThan(0)
      expect(status.recent[0].jobs.some((j) => j.job === 'extract' && j.model === 'qwen3.8:27b')).toBe(true)

      // Agent mode: SahilBot reaches out.
      // (Once the first read has settled: the page reflows as briefs land.)
      await expect.poll(async () => (await page.evaluate(() => window.foreman.brain.status())).syncing, { timeout: 20_000 }).toBe(false)
      await page.click('[data-testid="brain-agent-on"]')
      await expect.poll(async () => (await page.evaluate(() => window.foreman.brain.status())).settings.agentMode, { timeout: 10_000 }).toBe(true)
      await page.click('[data-testid="brain-refresh"]')
      await expect.poll(async () => (await page.evaluate(() => window.foreman.needsYou.list())).filter((x) => x.source === 'brain').length, { timeout: 20_000 }).toBeGreaterThan(0)
      await page.click('[data-testid="nav-tasks"]')
      const prompt = page.locator('[data-testid="needs-you-item"][data-kind="prompt"]', { hasText: 'Sarah Lee asked for the revised proposal' })
      await prompt.waitFor()
      expect(await prompt.locator('[data-testid="needs-you-prompt-remind"]').innerText()).toMatch(/^Remind me/)
      await prompt.locator('[data-testid="needs-you-prompt-draft"]').click()
      await expect.poll(() => llm.requests.some((r) => (r.messages ?? []).some((m: any) => m.role === 'user' && String(m.content).includes('Draft the revised proposal for Sarah Lee'))), { timeout: 20_000 }).toBe(true)
      await expect.poll(async () => (await page.evaluate(() => window.foreman.needsYou.list())).filter((x) => x.source === 'brain' && x.prompt?.text.includes('revised proposal')).length).toBe(0)
    } finally {
      await app.close()
    }
  })
})
