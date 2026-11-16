// Dev helper: autonomy picker, Autonomous chip, background job (Jobs tab + header chip) and the end-of-run
// summary. Hidden window; screenshots go to SHOTS_DIR (default: the temp folder).
import { tmpdir } from 'node:os'
import { test } from 'vitest'
import { launch, tempProfile } from '../accept/app'
import { startMockLlm } from '../fixtures/mock-llm'

test('jobs and autonomy shots', async () => {
  const out = process.env.SHOTS_DIR ?? tmpdir()
  const llm = await startMockLlm()
  const { app, page } = await launch(tempProfile(), llm.url)
  await page.setViewportSize({ width: 1280, height: 820 })
  // Autonomy picker.
  await page.click('[data-testid="model-picker"]')
  await page.click('[data-testid="mode-picker"]')
  await page.waitForTimeout(250)
  await page.screenshot({ path: `${out}/jobs-picker.png` })
  await page.click('[data-testid="mode-autonomous"]')
  const port = 5300 + Math.floor(Math.random() * 400)
  const server = `node -e "require('http').createServer((q,s)=>s.end('hi')).listen(${port},()=>{console.log('  VITE v6.0.0  ready in 212 ms');console.log('  ➜  Local:   http://localhost:${port}/');setInterval(()=>console.log('[hmr] page reload src/App.tsx'),700)})"`
  llm.script.push({ toolCalls: [{ name: 'run_command', arguments: JSON.stringify({ command: 'sleep 2; echo "built 42 modules"' }) }] })
  llm.script.push({ toolCalls: [{ name: 'file_write', arguments: JSON.stringify({ path: 'notes.md', content: '# Notes\n' }) }] })
  llm.script.push({ toolCalls: [{ name: 'run_command', arguments: JSON.stringify({ command: server, background: true, wait_for: { text: 'Local:', timeout: 20 } }) }] })
  llm.script.push(() => ({ content: `The dev server is up at http://localhost:${port}/ and I'll keep it running.` }))
  await page.fill('[data-testid="composer-input"]', 'start the dev server for my site')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(900)
  await page.screenshot({ path: `${out}/jobs-running-chip.png` })
  await page.waitForSelector('[data-testid="run-summary"]', { timeout: 30_000 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${out}/jobs-chat.png` })
  await page.click('[data-testid="jobs-chip"]')
  await page.waitForSelector('[data-testid="job-card"]')
  await page.waitForTimeout(1600)
  await page.screenshot({ path: `${out}/jobs-panel.png` })
  await page.fill('[data-testid="job-search"]', 'hmr')
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/jobs-search.png` })
  await page.fill('[data-testid="job-search"]', '')
  await page.hover('[data-testid="run-summary"]')
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/jobs-summary-hover.png` })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${out}/jobs-panel-dark.png` })
  await page.click('[data-testid="job-stop"]')
  await page.waitForSelector('[data-testid="job-card"][data-status="stopped"]', { timeout: 10_000 })
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/jobs-stopped-dark.png` })
  await app.close()
  await llm.close()
}, 120_000)
