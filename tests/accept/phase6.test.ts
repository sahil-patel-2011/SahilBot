import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

let llm: MockLlm
const idle = async (page: Page): Promise<void> => {
  await expect.poll(() => llm.script.length, { timeout: 20_000 }).toBe(0)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)
}
const tools = (): string[] => llm.requests.at(-1)!.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content))

// Phase 6 acceptance: Projects (folder + instructions + chats) and scheduled tasks.
describe('phase 6: projects + scheduled tasks', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })
  beforeEach(() => { llm.script.length = 0 })

  test('a project chat follows the project instructions and works in its folder', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'proj-'))
    writeFileSync(join(folder, 'brief.md'), 'Client: Acme. Deadline Dec 1.')
    const { app, page } = await launch(tempProfile(), llm.url)
    await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as never }, folder)
    await page.click('[data-testid="new-project"]')
    await page.fill('[data-testid="bot-name"]', 'Acme launch')
    await page.click('[data-testid="project-folder"]')
    await page.fill('[data-testid="project-instructions"]', 'Always write in British English. The audience is Acme executives.')
    await page.click('[data-testid="bot-save"]')
    await page.locator('[data-testid="project-home"]').waitFor()
    await expect.poll(() => page.locator('[data-testid="project-home"]').innerText()).toContain('British English')

    llm.script.push(
      { toolCalls: [{ name: 'file_read', arguments: JSON.stringify({ path: join(folder, 'brief.md') }) }] },
      { toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path: join(folder, 'summary.md'), content: '# Summary\nDeadline 1 Dec.' }) }] },
      { content: 'Summary written.' }
    )
    await page.fill('[data-testid="composer-input"]', 'Summarise the brief into summary.md')
    await page.keyboard.press('Enter')
    await idle(page)
    const sys = String(llm.requests.at(-1)!.messages[0].content)
    expect(sys).toContain('British English')
    expect(sys).toContain(`Project folder (read and edit with absolute paths): `)
    expect(tools()[0]).toContain('Deadline Dec 1')
    expect(existsSync(join(folder, 'summary.md'))).toBe(true)
    // Sidebar lists the project; its home lists the chat.
    expect(await page.locator('[data-testid="project-item"]').innerText()).toContain('Acme launch')
    await app.close()
  })

  test('the agent schedules a task; a run happens unattended and skips anything that needs approval', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'))
    writeFileSync(join(ws, 'old.txt'), 'x')
    const { app, page } = await launch(tempProfile(), llm.url)
    await page.evaluate((w) => window.foreman.settings.set({ workspaceDir: w }), ws)
    llm.script.push(
      { toolCalls: [{ name: 'find_tools', arguments: '{"query":"schedule"}' }] },
      { toolCalls: [{ name: 'schedule', arguments: JSON.stringify({ action: 'create', title: 'Tidy workspace', prompt: 'Delete old.txt from the workspace and report.', when: { type: 'daily', time: '09:00' } }) }] },
      { content: "Done — I'll tidy up every day at 9." }
    )
    await page.fill('[data-testid="composer-input"]', 'Every morning at 9, tidy my workspace')
    await page.keyboard.press('Enter')
    await idle(page)
    const list = await page.evaluate(() => window.foreman.schedules.list())
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ title: 'Tidy workspace', schedule: { type: 'daily', time: '09:00' }, enabled: true })

    // Run it now from the Scheduled view: the delete would need approval, so it is skipped.
    llm.script.push(
      { toolCalls: [{ name: 'file_manage', arguments: '{"op":"delete","path":"old.txt"}' }] },
      { content: 'I would delete old.txt, but that needs your OK.' }
    )
    await page.click('[data-testid="nav-scheduled"]')
    await page.locator('[data-testid="schedule-row"]').waitFor()
    await page.click('[data-testid="schedule-run"]')
    await expect.poll(async () => (await page.evaluate(() => window.foreman.schedules.list()))[0].lastStatus, { timeout: 20_000 }).toBe('done')
    expect(existsSync(join(ws, 'old.txt'))).toBe(true)
    expect(tools().at(-1)).toContain('ran on a schedule with nobody to approve it')
    expect(JSON.stringify(llm.requests.at(-1)!.messages)).toContain('⏰ Tidy workspace')
    expect(await page.locator('[data-testid="approval-card"]').count()).toBe(0)
    await app.close()
  })
})
