import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// New agent features against the mock model: Team of Experts, the terminal's permission rules,
// rules in the prompt, and settings (keys, servers) surviving a restart.
describe('agent platform', () => {
  let llm: MockLlm
  beforeAll(async () => { llm = await startMockLlm() })
  // Each test scripts its own replies; leftovers from a previous test must not leak in.
  beforeEach(() => { llm.script.length = 0 })
  afterAll(async () => { await llm.close() })

  const sys = (req: Record<string, any>): string => String(req.messages?.[0]?.content ?? '')
  const lastUser = (req: Record<string, any>): string => String([...req.messages].reverse().find((m: any) => m.role === 'user')?.content ?? '')

  const CITIES = ['Paris', 'Tokyo', 'Lagos', 'Lima', 'Oslo', 'Cairo', 'Seoul', 'Quito', 'Hanoi', 'Perth']
  test('Max picks a research team: the lead sends at least 10 helpers in parallel, gets their reports, and compiles them', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    // Every request decides its own reply: helpers report, the lead delegates once then answers.
    const reply = (req: Record<string, any>) => {
      if (sys(req).includes('You are a helper agent')) return { content: `REPORT for "${lastUser(req).slice(0, 30)}": found it, source https://example.com/${lastUser(req).length}` }
      if (req.messages.some((m: any) => m.role === 'tool' && String(m.content).includes('REPORT for'))) return { content: 'Both helpers reported back; the answer is combined.' }
      return { toolCalls: [{ name: 'agents', arguments: JSON.stringify({ tasks: CITIES.map((c) => ({ title: `${c} facts`, task: `Find the population of ${c}.` })) }) }] }
    }
    for (let i = 0; i < 40; i++) llm.script.push(reply)
    await page.fill('[data-testid="composer-input"]', 'Use an agent swarm to research and compare the populations of Paris and Tokyo across the official census sources')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText(), { timeout: 30_000 }).toContain('Both helpers reported back')
    // The lead got Team mode instructions, and each helper got its own task.
    const lead = llm.requests.find((r) => !sys(r).includes('You are a helper agent') && lastUser(r).includes('Paris and Tokyo'))!
    expect(JSON.stringify(lead.messages)).toContain('Max is on for this request: research team')
    const helpers = llm.requests.filter((r) => sys(r).includes('You are a helper agent'))
    // (Each helper may be sent back once: its made-up link was never opened, so the link check catches it.)
    expect([...new Set(helpers.map((r) => String(r.messages.find((m: any) => m.role === 'user')?.content).replace(/^<context from="app">[\s\S]*?<\/context>\n\n/, '')))].sort()).toEqual(CITIES.map((c) => `Find the population of ${c}.`).sort())
    expect(JSON.stringify(lead.messages)).toContain('at least 10')
    // The team card shows both helpers finished; helper threads don't appear as chats.
    await expect.poll(() => page.locator('[data-testid="team-member"].tm-done').count()).toBe(10)
    // One Max card holds the team (the planner's strategy and why on top).
    const card = page.locator('[data-testid="max-card"]')
    expect(await card.getAttribute('data-strategy')).toBe('team')
    expect(await card.locator('[data-testid="team-member"]').count()).toBe(10)
    expect(await page.locator('[data-testid="team-card"]').count()).toBe(1)
    expect(await page.locator('[data-testid="thread-item"]').count()).toBe(1)
    await app.close()
  })

  test('run_command: Auto makes and deletes files without asking (you asked for it)', async () => {
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
    await expect.poll(() => existsSync(join(ws, 'old.txt')), { timeout: 15_000 }).toBe(false)
    expect(readFileSync(join(ws, 'made.txt'), 'utf8').trim()).toBe('hello')
    expect(await page.locator('[data-testid="approval-card"]').count()).toBe(0)
    await expect.poll(() => llm.script.length, { timeout: 15_000 }).toBe(0)
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
    // Built-in skills are listed by name for the agent to read on demand (agent work; a chat doesn't list them).
    await page.click('[data-testid="new-chat"]')
    llm.script.push({ content: 'ok' })
    const before = llm.requests.length
    await page.fill('[data-testid="composer-input"]', 'Draft a memo about the new schedule')
    await page.keyboard.press('Enter')
    await expect.poll(() => llm.requests.length > before).toBe(true)
    const agentPrompt = sys(llm.requests.at(-1)!)
    expect(agentPrompt).toContain('deep-web-research')
    expect(agentPrompt).toContain('Captain Sahil')
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

describe('human checks', () => {
  let llm: MockLlm
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('a CAPTCHA page brings the browser to the user and the agent waits; it never tries to solve it', async () => {
    const { startTestSite } = await import('../fixtures/test-site')
    const site = await startTestSite()
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    llm.script.push(
      { toolCalls: [{ name: 'browser', arguments: JSON.stringify({ action: 'navigate', url: `${site.url}/check` }) }] },
      { content: 'Thanks, carrying on.' }
    )
    await page.fill('[data-testid="composer-input"]', `Open ${site.url}/check`)
    await page.keyboard.press('Enter')
    // The browser tool itself hands the check to the user: the panel opens and the card waits for them.
    const card = page.locator('[data-testid="question-card"]')
    await card.waitFor({ timeout: 20_000 })
    expect(await page.locator('[data-testid="right-panel"]').count()).toBe(1)
    expect(await card.innerText()).toMatch(/complete it in the browser panel/)
    // Nothing was sent to the model while it waited.
    const before = llm.requests.length
    await card.locator('button', { hasText: 'Done' }).click()
    await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText(), { timeout: 15_000 }).toContain('carrying on')
    expect(llm.requests.length).toBe(before + 1)
    // The model learns the outcome (the fixture page still shows its check after Done) and never how to solve it.
    const told = llm.requests.at(-1)!.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content).join('\n')
    expect(told).toMatch(/still shows a|completed the check/)
    await app.close()
    await site.close()
  })
})

describe('steering and queueing', () => {
  let llm: MockLlm
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })
  const lastUserOf = (req: Record<string, any>): string => String([...req.messages].reverse().find((m: any) => m.role === 'user')?.content ?? '')

  test('Enter while it works steers the running agent; ⌘Enter queues for after', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    llm.script.push(
      // A slow first answer, so there's time to steer.
      { content: 'Painting the logo red, one careful stroke at a time and still going for a while longer now.', delay: 120 },
      (req) => lastUserOf(req).includes('make it blue') ? { content: 'Switched to blue as you asked.' } : { content: 'missed the steer' },
      { content: 'Queued one answered.' }
    )
    await page.fill('[data-testid="composer-input"]', 'Paint the logo')
    await page.keyboard.press('Enter')
    await page.locator('[data-testid="stop"]').waitFor()
    // Steer with Enter.
    await page.fill('[data-testid="composer-input"]', 'actually make it blue')
    await page.keyboard.press('Enter')
    // Queue with ⌘Enter.
    await page.fill('[data-testid="composer-input"]', 'then say hi')
    await page.keyboard.press('Meta+Enter')
    await expect.poll(() => page.locator('[data-testid="queued"]').count()).toBe(1)
    await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').allInnerTexts().then((t) => t.join('\n')), { timeout: 20_000 }).toContain('Switched to blue')
    expect(await page.locator('[data-testid="steered"]').count()).toBe(1)
    // The steer reached the model in the same run, with a note saying it came mid-task.
    const steered = llm.requests.find((r) => lastUserOf(r).includes('make it blue'))!
    expect(JSON.stringify(steered.messages)).toContain('while you were working')
    // The queued message goes out after the run ends.
    await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText(), { timeout: 20_000 }).toContain('Queued one answered')
    expect(lastUserOf(llm.requests.at(-1)!)).toContain('then say hi')
    await app.close()
  })
})

describe('quick ask and deep research', () => {
  let llm: MockLlm
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('Quick Ask answers in the floating bar and saves the chat', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    llm.script.push({ content: 'Paris is the capital of France.' })
    // Show the bar's view in this (hidden) window.
    await page.evaluate(() => { location.hash = '#quick' })
    await page.reload()
    await page.locator('[data-testid="quick-input"]').waitFor()
    await page.fill('[data-testid="quick-input"]', 'capital of France?')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.locator('.quick-answer').innerText(), { timeout: 15_000 }).toContain('Paris is the capital')
    // It asked for a brief answer, and the chat is saved for later.
    expect(JSON.stringify(llm.requests.at(-1)!.messages)).toContain('Quick Ask')
    const threads = await page.evaluate(async () => (await window.foreman.threads.list()).map((t) => t.title))
    expect(threads.join('|')).toContain('capital of France?')
    await app.close()
  })

  test('Deep Research turns on the team and asks for a cited PDF report', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    llm.script.push({ content: 'ok' })
    const before = llm.requests.length
    await page.fill('[data-testid="composer-input"]', 'Run deep research on the market for at-home urology tests')
    await page.keyboard.press('Enter')
    await expect.poll(() => llm.requests.length).toBeGreaterThan(before)
    const sent = JSON.stringify(llm.requests[before].messages)
    expect(sent).toContain('Deep Research is on')
    expect(sent).toContain('Team of Experts is on')
    expect(sent).toContain('Research/')
    await app.close()
  })
})

describe('plan, then execute', () => {
  let llm: MockLlm
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })
  const toolOut = (req: Record<string, any>): string => String([...req.messages].reverse().find((m: any) => m.role === 'tool')?.content ?? '')

  test('Plan first: clarifying questions in one card, a plan to approve, then it executes', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    const ask = { toolCalls: [{ name: 'ask_user', arguments: JSON.stringify({ questions: [{ question: 'Who is the newsletter for?', options: ['Patients', 'Referring doctors'] }, { question: 'How long should it be?' }] }) }] }
    // The first ask is sent back with "Research first"; asking again (pure preference) shows the card.
    llm.script.push(
      ask,
      (req) => toolOut(req).includes('Research first') ? ask : { content: 'research-first gate did not run' },
      (req) => toolOut(req).includes('Patients') && toolOut(req).includes('300 words')
        ? { toolCalls: [{ name: 'propose_plan', arguments: JSON.stringify({ goal: 'A 300-word patient newsletter about BPH.', steps: ['Check the latest guidance', 'Draft the newsletter', 'Proofread it'], risks: ['Medical claims need a doctor\'s review'] }) }] }
        : { content: 'answers did not arrive' },
      (req) => toolOut(req).includes('approved the plan') ? { content: 'Plan approved; here is the newsletter draft.' } : { content: 'plan was not approved' }
    )
    await page.fill('[data-testid="composer-input"]', 'Plan first before writing our monthly newsletter')
    await page.keyboard.press('Enter')
    // One card, two questions: pick an option, type the other answer.
    const card = page.locator('[data-testid="questions-card"]')
    await card.waitFor({ timeout: 15_000 })
    expect(JSON.stringify(llm.requests[0].messages)).toContain('Plan first is on')
    await card.locator('[data-testid="qcard-option"]', { hasText: 'Patients' }).click()
    await card.locator('[data-testid="qcard-input"]').nth(1).fill('300 words')
    await card.locator('[data-testid="qcard-send"]').click()
    // The plan waits for approval, with its risks.
    const plan = page.locator('[data-testid="plan-approval"]')
    await plan.waitFor({ timeout: 15_000 })
    expect(await plan.innerText()).toContain('Draft the newsletter')
    expect(await plan.innerText()).toContain("doctor's review")
    await plan.locator('[data-testid="plan-approve"]').click()
    await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText(), { timeout: 15_000 }).toContain('Plan approved')
    // The approved plan became the checklist.
    expect(await page.locator('[data-testid="plan-step"]').allInnerTexts()).toEqual(['Check the latest guidance', 'Draft the newsletter', 'Proofread it'])
    await app.close()
  })

  test('two chats work at the same time; the sidebar shows which is still working', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    llm.script.length = 0
    llm.script.push(
      { content: 'Long answer that takes a while to write, word by word, so the other chat can finish first while this keeps going for some time.', delay: 150 },
      { content: 'Quick answer.' }
    )
    await page.fill('[data-testid="composer-input"]', 'slow one')
    await page.keyboard.press('Enter')
    await page.locator('[data-testid="stop"]').waitFor()
    await page.click('[data-testid="new-chat"]')
    await page.fill('[data-testid="composer-input"]', 'fast one')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText(), { timeout: 15_000 }).toContain('Quick answer')
    // The first chat is still working in the background, and the sidebar shows it.
    const slow = page.locator('[data-testid="thread-item"]', { hasText: 'slow one' })
    expect(await slow.locator('.row-spin').count()).toBe(1)
    await expect.poll(() => slow.locator('.row-spin').count(), { timeout: 30_000 }).toBe(0)
    await app.close()
  })
})
