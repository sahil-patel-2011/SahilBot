import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// New agent features against the mock model: Team of Experts, the terminal's permission rules,
// rules in the prompt, and settings (keys, servers) surviving a restart.
describe('agent platform', () => {
  let llm: MockLlm
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  const sys = (req: Record<string, any>): string => String(req.messages?.[0]?.content ?? '')
  const lastUser = (req: Record<string, any>): string => String([...req.messages].reverse().find((m: any) => m.role === 'user')?.content ?? '')

  test('Team of Experts: the lead sends tasks to helpers in parallel, gets their reports, and finishes', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    // Every request decides its own reply: helpers report, the lead delegates once then answers.
    const reply = (req: Record<string, any>) => {
      if (sys(req).includes('You are a helper agent')) return { content: `REPORT for "${lastUser(req).slice(0, 30)}": found it, source https://example.com/${lastUser(req).length}` }
      if (req.messages.some((m: any) => m.role === 'tool' && String(m.content).includes('REPORT for'))) return { content: 'Both helpers reported back; the answer is combined.' }
      return { toolCalls: [{ name: 'agents', arguments: JSON.stringify({ tasks: [{ title: 'Paris facts', task: 'Find the population of Paris.' }, { title: 'Tokyo facts', task: 'Find the population of Tokyo.' }] }) }] }
    }
    for (let i = 0; i < 6; i++) llm.script.push(reply)
    await page.click('[data-testid="team-toggle"]')
    await page.fill('[data-testid="composer-input"]', 'Compare the populations of Paris and Tokyo')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText(), { timeout: 30_000 }).toContain('Both helpers reported back')
    // The lead got Team mode instructions, and each helper got its own task.
    const lead = llm.requests.find((r) => !sys(r).includes('You are a helper agent') && lastUser(r).includes('Paris and Tokyo'))!
    expect(JSON.stringify(lead.messages)).toContain('Team of Experts is on')
    const helpers = llm.requests.filter((r) => sys(r).includes('You are a helper agent'))
    // (Each helper may be sent back once: its made-up link was never opened, so the link check catches it.)
    expect([...new Set(helpers.map((r) => r.messages.find((m: any) => m.role === 'user')?.content))].sort()).toEqual(['Find the population of Paris.', 'Find the population of Tokyo.'])
    // The team card shows both helpers finished; helper threads don't appear as chats.
    await expect.poll(() => page.locator('[data-testid="team-member"].tm-done').count()).toBe(2)
    expect(await page.locator('[data-testid="thread-item"]').count()).toBe(1)
    await app.close()
  })

  test('run_command: changes run in Auto, deleting asks first', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sb-cmd-'))
    writeFileSync(join(ws, 'old.txt'), 'bye')
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    await page.evaluate((w) => window.foreman.settings.set({ workspaceDir: w }), ws)
    llm.script.push(
      { toolCalls: [{ name: 'run_command', arguments: JSON.stringify({ command: 'echo hello > made.txt && cat made.txt' }) }] },
      { toolCalls: [{ name: 'run_command', arguments: JSON.stringify({ command: 'rm old.txt' }) }] },
      { content: 'Done.' }
    )
    await page.fill('[data-testid="composer-input"]', 'make a file and delete old.txt')
    await page.keyboard.press('Enter')
    const card = page.locator('[data-testid="approval-card"]')
    await card.waitFor({ timeout: 15_000 })
    // The first command already ran without asking; the delete waits for approval.
    expect(readFileSync(join(ws, 'made.txt'), 'utf8').trim()).toBe('hello')
    expect(existsSync(join(ws, 'old.txt'))).toBe(true)
    expect(await card.innerText()).toMatch(/rm old\.txt/)
    await card.locator('[data-testid="approve-once"]').click()
    await expect.poll(() => existsSync(join(ws, 'old.txt')), { timeout: 15_000 }).toBe(false)
    const out = llm.requests.at(-1)!.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content).join('\n')
    expect(out).toContain('exit code 0')
    await app.close()
  })

  test('rules: enabled rules reach the prompt of new chats; switched-off ones do not', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    await page.evaluate(async () => {
      await window.foreman.rules.save({ name: 'sign-off', text: 'Always sign emails as Captain Sahil.' })
      await window.foreman.rules.setEnabled('cite-sources', false)
    })
    llm.script.push({ content: 'ok' })
    await page.fill('[data-testid="composer-input"]', 'hello')
    await page.keyboard.press('Enter')
    await expect.poll(() => llm.requests.length > 0 && sys(llm.requests.at(-1)!).includes('Captain Sahil')).toBe(true)
    const prompt = sys(llm.requests.at(-1)!)
    expect(prompt).toContain('Finish the whole job')
    expect(prompt).not.toContain('cite the sources inline as [1]')
    // Built-in skills are listed by name for the agent to read on demand.
    expect(prompt).toContain('deep-web-research')
    await app.close()
  })

  test('API keys and server addresses survive quitting the app', async () => {
    const profile = tempProfile()
    let { app, page } = await launch(profile, llm.url)
    await page.evaluate(() => window.foreman.settings.set({ setKeys: { openai: 'sk-test-123' }, providers: { lmstudio: { enabled: true, baseUrl: 'http://192.168.1.50:1234/v1' } } as never, cursorKey: 'key_test' }))
    await app.close()
    ;({ app, page } = await launch(profile, llm.url))
    const s = await page.evaluate(() => window.foreman.settings.get())
    expect(s.keys.openai).toBe(true)
    expect(s.hasCursorKey).toBe(true)
    expect(s.providers.lmstudio.baseUrl).toBe('http://192.168.1.50:1234/v1')
    // Keys are never sent to the screen, only whether one is saved.
    expect(JSON.stringify(s)).not.toContain('sk-test-123')
    await app.close()
  })
})
