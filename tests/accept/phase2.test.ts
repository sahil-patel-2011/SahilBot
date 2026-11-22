import { existsSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { expandSteps, launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

const chips = (page: Page) => page.locator('[data-testid="tool-chip"]')
const lastBubble = (page: Page) => page.locator('[data-testid="assistant-bubble"]').last()
let llmRef: MockLlm
let sentAt = 0
const send = async (page: Page, text: string) => {
  sentAt = llmRef.requests.length
  await page.fill('[data-testid="composer-input"]', text)
  await page.keyboard.press('Enter')
}
/** Every scripted reply has been served, the model was called, and the Stop button is gone. */
const idle = async (page: Page) => {
  await expect.poll(() => llmRef.requests.length > sentAt && llmRef.script.length === 0, { timeout: 15_000 }).toBe(true)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 15_000 }).toBe(0)
}
const toolMessages = (llm: MockLlm) => (llm.requests.at(-1)!.messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool')

// Phase 2 acceptance: the agent loop runs tools under each permission mode,
// repairs bad arguments once, remembers facts across threads, and compacts.
describe('phase 2: agent loop + permissions + context', () => {
  let llm: MockLlm
  const workspace = mkdtempSync(join(tmpdir(), 'foreman-ws-'))

  beforeAll(async () => { llm = llmRef = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('auto mode: plans, writes a file, repairs bad args, saves a memory', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    await page.evaluate((ws) => window.foreman.settings.set({ workspaceDir: ws, userName: 'Sam Rivera' }), workspace)

    llm.script.push(
      { toolCalls: [{ name: 'todo', arguments: '{"items":[{"text":"Write the brief","status":"in_progress"},{"text":"Remember the client","status":"pending"}]}' }] },
      // Missing "content": must come back as a schema error with one retry allowed.
      { toolCalls: [{ name: 'file_write', arguments: '{"path":"briefs/acme.md"}' }] },
      { toolCalls: [{ name: 'file_write', arguments: '{"path":"briefs/acme.md","content":"# Acme brief\\nLaunch on Dec 1."}' }] },
      { toolCalls: [{ name: 'memory', arguments: '{"action":"save","fact":"Main client is Acme Co, launching Dec 1.","category":"work"}' }] },
      { toolCalls: [{ name: 'todo', arguments: '{"items":[{"text":"Write the brief","status":"done"},{"text":"Remember the client","status":"done"}]}' }] },
      { content: 'Done. I wrote **briefs/acme.md** and noted Acme as your main client.' }
    )
    await send(page, 'Write a short brief for Acme in my workspace')
    await idle(page)

    expect(await lastBubble(page).innerText()).toContain('briefs/acme.md')
    // The run shows as one collapsed activity line until opened.
    expect(await page.locator('[data-testid="activity"]').count()).toBe(1)
    expect(await chips(page).count()).toBe(0)
    await expandSteps(page)
    const statuses = await chips(page).evaluateAll((els) => els.map((e) => `${e.getAttribute('data-tool')}:${e.getAttribute('data-status')}`))
    expect(statuses).toEqual(['file_write:invalid', 'file_write:ok', 'memory:ok'])
    // The plan is its own checklist card showing the latest version, all ticked off.
    expect(await page.locator('[data-testid="plan-card"]').count()).toBe(1)
    expect(await page.locator('[data-testid="plan-step"]').allInnerTexts()).toEqual(['Write the brief', 'Remember the client'])
    expect(await page.locator('[data-testid="plan-step"].ps-done').count()).toBe(2)
    expect(readFileSync(join(workspace, 'briefs/acme.md'), 'utf8')).toContain('Launch on Dec 1.')

    // The repair message carried the schema back to the model.
    const req3 = llm.requests.at(-4)!.messages as Array<{ role: string; content: string }>
    expect(req3.filter((m) => m.role === 'tool').at(-1)!.content).toMatch(/Invalid arguments for file_write[\s\S]*content/)
    // Tool output is fenced as data.
    expect(toolMessages(llm).at(-2)!.content).toMatch(/^<tool_output tool="memory"/)
    // Tools were sent natively, core set only.
    const names = (llm.requests.at(-1)!.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    // Built-in tools are all there (no cap); connector tools only after find_tools.
    expect(names).toEqual(expect.arrayContaining(['find_tools', 'todo', 'ask_user', 'file_read', 'file_write', 'file_manage', 'create_document', 'web_search', 'fetch_page', 'memory', 'browser', 'run_command', 'max', 'cursor', 'mac_apps', 'schedule']))
    // Max is the one tool for many agents; its older names (agents, swarm) still run but aren't listed up front.
    expect(names).not.toContain('agents')
    expect(names).not.toContain('swarm')
    // Heavy tools (computer use, code, pages…) load only when a request needs them.
    expect(names).not.toContain('computer')

    // Cross-thread memory: a brand-new thread's system prompt already knows.
    await page.click('[data-testid="main-bot"]')
    await send(page, 'Who is my main client?')
    await idle(page)
    const msgs = llm.requests.at(-1)!.messages as Array<{ role: string; content: string }>
    // Memories ride in the <context> block on the new chat's message (the system prompt stays cacheable).
    expect(String(msgs.find((m) => m.role === 'user')!.content)).toContain('Main client is Acme Co, launching Dec 1.')
    expect(String(msgs[0].content)).toContain("The user's name is Sam Rivera (call them Sam).")
    await app.close()
  })

  test('ask mode: approval card, deny is respected, allow once runs', async () => {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    await page.evaluate((ws) => window.foreman.settings.set({ workspaceDir: ws }), workspace)
    // The picker under the box → Permissions → Ask first.
    await page.click('[data-testid="model-picker"]')
    await page.click('[data-testid="mode-picker"]')
    await page.click('[data-testid="mode-ask"]')

    llm.script.push(
      { toolCalls: [{ name: 'file_write', arguments: '{"path":"denied.md","content":"nope"}' }] },
      { content: 'Okay, I did not write it.' }
    )
    await send(page, 'Write denied.md')
    const card = page.locator('[data-testid="approval-card"]')
    await card.waitFor()
    expect(await card.innerText()).toContain('denied.md')
    await page.click('[data-testid="approve-deny"]')
    await idle(page)
    expect(existsSync(join(workspace, 'denied.md'))).toBe(false)
    await expandSteps(page)
    expect(await chips(page).last().getAttribute('data-status')).toBe('denied')
    expect(await chips(page).last().innerText()).toContain('Skipped')
    expect(toolMessages(llm).at(-1)!.content).toMatch(/declined/)

    llm.script.push(
      { toolCalls: [{ name: 'file_write', arguments: '{"path":"allowed.md","content":"yes"}' }] },
      { content: 'Written.' }
    )
    await send(page, 'Now write allowed.md')
    await card.waitFor()
    await page.click('[data-testid="approve-once"]')
    await idle(page)
    expect(readFileSync(join(workspace, 'allowed.md'), 'utf8')).toBe('yes')

    // Reads never ask, even in Ask mode.
    llm.script.push({ toolCalls: [{ name: 'file_read', arguments: '{"path":"allowed.md"}' }] }, { content: 'It says yes.' })
    await send(page, 'Read it back')
    await idle(page)
    expect(await lastBubble(page).innerText()).toContain('It says yes.')

    // Stop while waiting for approval ends the run cleanly.
    llm.script.push({ toolCalls: [{ name: 'file_write', arguments: '{"path":"stopped.md","content":"x"}' }] })
    await send(page, 'Write stopped.md')
    await card.waitFor()
    await page.click('[data-testid="stop"]')
    await idle(page)
    expect(existsSync(join(workspace, 'stopped.md'))).toBe(false)
    await app.close()
  })

  test('ask_user pauses the run and feeds the answer back', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    llm.script.push(
      // A task's first question before any research is sent back once ("research first")…
      { toolCalls: [{ name: 'ask_user', arguments: '{"question":"Which format?","options":["PDF","Doc"]}' }] },
      // …and a question that's purely the user's preference goes through on the second try.
      { toolCalls: [{ name: 'ask_user', arguments: '{"question":"Which format?","options":["PDF","Doc"]}' }] },
      { content: 'Going with PDF.' }
    )
    await send(page, 'Make the report')
    await page.locator('[data-testid="question-card"]').waitFor()
    await page.locator('[data-testid="question-card"] button', { hasText: 'PDF' }).click()
    await idle(page)
    expect(toolMessages(llm).some((m: any) => /Research first/.test(String(m.content)))).toBe(true)
    expect(toolMessages(llm).at(-1)!.content).toContain('User answered: PDF')
    // The question and the answer read as conversation.
    expect(await page.locator('[data-testid="answer-bubble"]').innerText()).toBe('PDF')
    await app.close()
  })

  test('compaction near a full 16k window shows a marker and keeps facts', async () => {
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.evaluate(() => window.foreman.settings.set({ contextWindow: 16384 }))
    const start = llm.requests.length
    // ~3.4k tokens per user message (chars/3.5 fallback) + ~2.5k of system and tools: the 3rd crosses 12k (75% of 16k).
    for (let i = 0; i < 4; i++) {
      llm.script.push({ content: `ok ${i}`, delay: 0 })
      await send(page, `Part ${i}: ` + 'background detail '.repeat(660) + (i === 0 ? ' The codeword is PELICAN.' : ''))
      await idle(page)
    }
    const marker = page.locator('[data-testid="compacted"]')
    await expect.poll(() => marker.count()).toBeGreaterThanOrEqual(1)
    // It waited until the window was nearly full: at least one normal turn went through first.
    const mine = llm.requests.slice(start)
    const firstSummaryAt = mine.findIndex((r) => String(r.messages[0].content).includes('You are compressing'))
    expect(mine.slice(0, firstSummaryAt).filter((r) => !String(r.messages[0].content).includes('compressing')).length).toBeGreaterThanOrEqual(1)
    const last = llm.requests.at(-1)!.messages as Array<{ role: string; content: string }>
    expect(last[0].content).toContain('<conversation_summary>')
    expect(last[0].content).toContain('PELICAN')
    // Compacted turns are gone from the prompt; the current one is verbatim.
    expect(last.filter((m) => m.role === 'user').length).toBeLessThan(4)
    // The app's context block leads the message that started the run.
    expect(String(last.at(-1)!.content).replace(/^<context from="app">[\s\S]*?<\/context>\n\n/, '')).toMatch(/^Part 3: /)
    // The prompt now fits under the threshold.
    expect(JSON.stringify(last).length / 3.5).toBeLessThan(0.97 * (16384 - 4096))
    await app.close()
  })
})
