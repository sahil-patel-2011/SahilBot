import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { GROK_PLAN_MODEL } from '@shared/grok-plan'
import { launch, tempProfile } from './app'

test('Grok subscription switches on without a key, executes a SahilBot tool, and switches off', async () => {
  const data = tempProfile()
  const workspace = mkdtempSync(join(tmpdir(), 'sahilbot-grok-accept-'))
  const { app, page } = await launch(data, '', { SAHILBOT_GROK_PATH: resolve('tests/fixtures/fake-grok-acp.mjs') })
  try {
    await page.evaluate((folder) => window.foreman.settings.set({ workspaceDir: folder, local: { enabled: false } }), workspace)
    writeFileSync(join(data, 'grok-plan', 'signed-in'), '')
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('sahilbot:open-settings', { detail: 'models' })))
    // Subscriptions sit in their own fold under AI & spending.
    await page.click('[data-testid="models-subscriptions"] summary')
    const status = page.getByTestId('grok-plan-status')
    await expect.poll(() => status.innerText()).toBe('Off')
    await page.getByTestId('grok-plan-on').click()
    await expect.poll(() => status.innerText()).toBe('Connected')
    const { threadId } = await page.evaluate(() => window.foreman.spaces.create({ name: 'Subscription fixture', intro: false }))
    await page.evaluate((id) => window.foreman.chat.send({ threadId: id, text: 'Run SAVE_FIXTURE and save the requested text file in my workspace.' }), threadId)
    await expect.poll(async () => (await page.evaluate((id) => window.foreman.threads.messages(id), threadId)).some((m) => m.role === 'assistant' && m.content === 'Ready.' && m.model === GROK_PLAN_MODEL)).toBe(true)
    expect(readFileSync(join(workspace, 'fixture.txt'), 'utf8')).toBe('Subscription fixture')

    await page.getByTestId('grok-plan-on').click()
    await expect.poll(() => status.innerText()).toBe('Off')
    expect(await page.evaluate(async () => (await window.foreman.models.list()).models.map((model) => model.id))).not.toContain(GROK_PLAN_MODEL)
  } finally { await app.close() }
})
