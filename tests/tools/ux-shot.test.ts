// Dev helper: a realistic chat (plan, steps, rich answer, sources) for design review. Mock model, hidden window.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { startMockLlm } from '../fixtures/mock-llm'
import { startTestSite } from '../fixtures/test-site'
import { launch, tempProfile } from '../accept/app'

test('ux screenshots', async () => {
  const out = process.env.SHOTS_DIR ?? '.'
  const llm = await startMockLlm()
  const site = await startTestSite()
  const ws = mkdtempSync(join(tmpdir(), 'sb-ux-'))
  for (const scheme of ['light', 'dark'] as const) {
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    await page.emulateMedia({ colorScheme: scheme })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.evaluate((w) => window.foreman.settings.set({ userName: 'JP', workspaceDir: w }), ws)
    await page.reload()
    await page.waitForSelector('[data-testid="composer-input"]')
    llm.script.push(
      { toolCalls: [{ name: 'todo', arguments: JSON.stringify({ items: [{ text: 'Find the latest BPH treatment guidance', status: 'done' }, { text: 'Compare the main medication options', status: 'done' }, { text: 'Write a short patient-friendly summary', status: 'in_progress' }] }) }], reasoning: 'Plan the research.' },
      { toolCalls: [{ name: 'web_search', arguments: JSON.stringify({ query: 'AUA BPH guideline 2025 medical therapy' }) }] },
      { toolCalls: [{ name: 'fetch_page', arguments: JSON.stringify({ url: `${site.url}/widgets` }) }] },
      { toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path: 'bph-summary.md', content: '# BPH options\nAlpha blockers, 5-ARIs, combination therapy.' }) }] },
      { content: '## Treating an enlarged prostate (BPH)\n\nMost men start with **medication**, and many never need surgery. Here are the main options, in plain words:\n\n| Option | How it helps | Typical timing |\n|---|---|---|\n| Alpha blockers (tamsulosin) | Relax the prostate muscle so urine flows easier | Days |\n| 5-ARIs (finasteride) | Shrink the prostate over time | 3–6 months |\n| Combination | Both at once, for larger prostates | Months |\n\n### What to watch for\n- Dizziness when standing up quickly with alpha blockers\n- Changes in ejaculation\n\n```python\n# IPSS score bands\nmild, moderate, severe = range(0, 8), range(8, 20), range(20, 36)\n```\n\nI saved a one-page summary to `bph-summary.md`. Sources: [1] AUA Guideline, [2] MedlinePlus.' }
    )
    await page.fill('[data-testid="composer-input"]', 'What are the treatment options for BPH? Keep it simple for patients.')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-testid="assistant-bubble"][data-status="done"]', { timeout: 30_000 })
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${out}/ux-thread-${scheme}.png` })
    await page.evaluate(() => document.querySelector('[data-testid="thread"]')?.scrollTo({ top: 0 }))
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${out}/ux-top-${scheme}.png` })
    if (scheme === 'light') {
      await page.click('[data-testid="toggle-panel"]')
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${out}/ux-panel.png` })
    }
    await app.close()
  }
  await site.close()
  await llm.close()
}, 120_000)
