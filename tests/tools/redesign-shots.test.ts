// Dev helper: screenshots of the redesigned home, files, projects and a team run (mock model).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { startMockLlm } from '../fixtures/mock-llm'
import { launch, tempProfile } from '../accept/app'

test('redesign screenshots', async () => {
  const out = process.env.SHOTS_DIR ?? '.'
  const llm = await startMockLlm()
  const ws = mkdtempSync(join(tmpdir(), 'sb-shots-'))
  for (const scheme of ['light', 'dark'] as const) {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    await page.emulateMedia({ colorScheme: scheme })
    await page.setViewportSize({ width: 1400, height: 880 })
    await page.evaluate((w) => window.foreman.settings.set({ userName: 'JP', workspaceDir: w }), ws)
    // Make a few files so Recent files has something to show.
    llm.script.push(
      { toolCalls: [{ name: 'create_document', arguments: JSON.stringify({ path: 'Q3 Marketing Report.pdf', markdown: '# Q3 Marketing Report\n\nRevenue grew 18% quarter over quarter, led by paid search.\n\n## Highlights\n- New patients up 22%\n- Cost per lead down 9%' }) }] },
      { toolCalls: [{ name: 'create_document', arguments: JSON.stringify({ path: 'Launch plan.docx', markdown: '# Launch plan\n\nThree steps to launch the new clinic site.\n\n1. Audit\n2. Migrate\n3. Announce' }) }] },
      { toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path: 'notes.md', content: '# Meeting notes\n\nDecided to move the site to Cloudflare.\nNext: DNS cutover on Friday.' }) }] },
      { content: 'Made three files.' }
    )
    await page.fill('[data-testid="composer-input"]', 'make three files')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-testid="assistant-bubble"][data-status="done"]')
    await page.waitForTimeout(500)
    await page.click('[data-testid="new-chat"]')
    await page.waitForTimeout(1200)
    await page.screenshot({ path: `${out}/r-home-${scheme}.png` })
    if (scheme === 'light') {
      await page.click('[data-testid="nav-files"]')
      await page.waitForTimeout(1000)
      await page.screenshot({ path: `${out}/r-files.png` })
      await page.click('[data-testid="nav-projects"]')
      await page.waitForTimeout(400)
      await page.screenshot({ path: `${out}/r-projects.png` })
      await page.click('[data-testid="new-chat"]')
      const reply = (req: Record<string, any>) => {
        const sys = String(req.messages?.[0]?.content ?? '')
        if (sys.includes('You are a helper agent')) return { content: 'REPORT: found it, with sources.', delay: 400 }
        if (req.messages.some((m: any) => m.role === 'tool' && String(m.content).includes('REPORT'))) return { content: '## Clinic SEO: what works in 2026\n\nTen helpers checked the top sources. **Local pages, reviews and fast mobile sites** matter most.' }
        return { toolCalls: [{ name: 'agents', arguments: JSON.stringify({ tasks: ['Google ranking factors', 'Local pack', 'Reviews', 'Site speed', 'Schema markup', 'Backlinks', 'Content', 'Competitors', 'Paid vs organic', 'AI search'].map((t) => ({ title: t, task: `Research ${t} for clinic SEO.` })) }) }] }
      }
      for (let i = 0; i < 40; i++) llm.script.push(reply)
      await page.click('[data-testid="team-toggle"]')
      await page.fill('[data-testid="composer-input"]', 'Research what works for clinic SEO in 2026')
      await page.keyboard.press('Enter')
      await page.waitForSelector('[data-testid="team-card"]')
      await page.waitForTimeout(900)
      await page.screenshot({ path: `${out}/r-team.png` })
      llm.script.length = 0
    }
    await app.close()
  }
  await llm.close()
}, 120_000)
