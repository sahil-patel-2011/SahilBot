// Dev helper (performance): a chat with 1,200 messages, then a long reply streamed into it as fast as the
// mock model can send (2 ms per word). Reports how long the chat takes to open and how much the renderer's
// main thread was blocked while the reply streamed (long tasks over 50 ms, and their total), plus a
// screenshot of the result. Hidden window.
//   npm run build && SAHILBOT_HIDDEN=1 npx vitest run --config vitest.tools.config.mts tests/tools/long-thread-perf.test.ts --silent=false
// MAIN=<path to another build's out/main/index.js> compares builds (see startup-timing.test.ts).
import { _electron as electron, type Page } from 'playwright'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { Db, uid } from '../../src/main/db'
import { tempProfile } from '../accept/app'
import { startMockLlm } from '../fixtures/mock-llm'

const MAIN = resolve(process.env.MAIN ?? 'out/main/index.js')
const out = process.env.SHOTS_DIR ?? join(tmpdir(), 'perf-shots')
mkdirSync(out, { recursive: true })

const ANSWER = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}: the **Team** plan keeps winning on value, and here is more detail about seats, storage and single sign-on so the reply is long.`).join('\n\n')

async function open(profile: string, llmUrl: string): Promise<{ app: Awaited<ReturnType<typeof electron.launch>>; page: Page }> {
  const app = await electron.launch({
    args: [MAIN],
    env: { ...process.env, FOREMAN_DATA_DIR: profile, FOREMAN_BASE_URL: llmUrl, FOREMAN_SKIP_ONBOARDING: '1', FOREMAN_NO_AUTOTITLE: '1', FOREMAN_NO_VERIFY: '1', SAHILBOT_HIDDEN: '1', FOREMAN_RAM_GB: '64' } as Record<string, string>
  })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="composer-input"]')
  return { app, page }
}

test('long chat: open and stream', async () => {
  const llm = await startMockLlm()
  const profile = tempProfile()

  // 1. Make the chat through the app, so it belongs to the main bot like any other.
  let { app, page } = await open(profile, llm.url)
  llm.script.push({ content: 'First answer.' })
  await page.fill('[data-testid="composer-input"]', 'Start a long chat')
  await page.keyboard.press('Enter')
  await page.locator('[data-testid="assistant-bubble"]', { hasText: 'First answer.' }).waitFor()
  await app.close()

  // 2. Fill it with 300 turns of question, tool call, result and a Markdown answer.
  const db = new Db(join(profile, 'foreman.db'))
  const thread = db.listThreads()[0]
  let at = Date.now() - 3 * 86_400_000
  const ins = db.sql.prepare('INSERT INTO messages(id, thread_id, seq, role, content, kind, status, data, created_at) VALUES(?,?,?,?,?,?,?,?,?)')
  let seq = 100
  db.sql.exec('BEGIN')
  for (let i = 0; i < 300; i++) {
    const call = { id: `call${i}`, name: 'web_search', arguments: JSON.stringify({ query: `plans ${i}` }) }
    ins.run(uid(), thread.id, ++seq, 'user', `Question ${i}: how do the plans compare for five people?`, 'normal', 'done', '{}', (at += 60_000))
    ins.run(uid(), thread.id, ++seq, 'assistant', '', 'normal', 'done', JSON.stringify({ toolCalls: [call] }), (at += 1000))
    ins.run(uid(), thread.id, ++seq, 'tool', '<tool_output>results</tool_output>', 'normal', 'done', JSON.stringify({ toolCallId: call.id, toolName: 'web_search', meta: { status: 'ok' } }), (at += 1000))
    ins.run(uid(), thread.id, ++seq, 'assistant', `## Answer ${i}\n\nThe **Team** plan is the best value.\n\n| Plan | Price |\n| --- | ---: |\n| Team | $15 |\n\n\`\`\`ts\nconst seats = 5\n\`\`\``, 'normal', 'done', '{}', (at += 1000))
  }
  db.sql.exec('COMMIT')
  db.sql.close()

  // 3. Open it.
  ;({ app, page } = await open(profile, llm.url))
  await page.setViewportSize({ width: 1280, height: 800 })
  const t0 = Date.now()
  await page.locator('[data-testid="thread-item"]').first().click()
  await page.locator('[data-testid="assistant-bubble"]', { hasText: 'Answer 299' }).waitFor()
  const openMs = Date.now() - t0
  const mounted = await page.locator('[data-testid="assistant-bubble"]').count()

  // 4. Stream a long reply into it and watch the main thread.
  await page.evaluate(() => {
    const w = window as unknown as { __long: number[]; __frames: number[]; __commits: number; __on: boolean }
    w.__long = []
    w.__frames = []
    w.__commits = 0
    w.__on = true
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__long.push(e.duration) }).observe({ type: 'longtask', buffered: false })
    // Frame gaps (jank) and DOM update batches in the thread (about one per React commit that touched it).
    let last = performance.now()
    const frame = (t: number): void => { w.__frames.push(t - last); last = t; if (w.__on) requestAnimationFrame(frame) }
    requestAnimationFrame(frame)
    new MutationObserver(() => { w.__commits++ }).observe(document.querySelector('.thread')!, { subtree: true, childList: true, characterData: true })
  })
  llm.script.push({ content: ANSWER, delay: 2 })
  const s0 = Date.now()
  await page.fill('[data-testid="composer-input"]', 'One more, in detail')
  await page.keyboard.press('Enter')
  await page.locator('[data-testid="assistant-bubble"]', { hasText: 'Paragraph 60' }).waitFor({ timeout: 60_000 })
  await page.locator('[data-testid="stop"]').waitFor({ state: 'detached', timeout: 30_000 })
  const streamMs = Date.now() - s0
  const { long, frames, commits } = await page.evaluate(() => {
    const w = window as unknown as { __long: number[]; __frames: number[]; __commits: number; __on: boolean }
    w.__on = false
    return { long: w.__long, frames: w.__frames, commits: w.__commits }
  })
  const sorted = [...frames].sort((a, b) => a - b)
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
  const visibility = await page.evaluate(() => document.visibilityState)
  await page.screenshot({ path: `${out}/long-thread-streamed.png` })
  // Scroll to the top: the next batch of earlier messages comes in without losing your place.
  await page.evaluate(() => { const el = document.querySelector('.thread-scroll') as HTMLElement; el.scrollTo({ top: 0, behavior: 'instant' }) })
  await page.waitForTimeout(400)
  const afterScroll = await page.locator('[data-testid="assistant-bubble"]').count()
  await page.screenshot({ path: `${out}/long-thread-earlier.png` })
  await app.close()
  await llm.close()

  const total = long.reduce((a, b) => a + b, 0)
  console.log(`${MAIN}\nopen a 1,200-message chat: ${openMs} ms, ${mounted} replies mounted (after scrolling to the top: ${afterScroll})`)
  console.log(`stream ~1,500 words: ${streamMs} ms; thread DOM updates: ${commits}; frames: ${frames.length}, p95 ${p95.toFixed(1)} ms, over 33 ms: ${frames.filter((f) => f > 33).length}; long tasks: ${long.length} (total ${total.toFixed(0)} ms, worst ${Math.max(0, ...long).toFixed(0)} ms); page ${visibility}`)
  console.log(`screenshots in ${out}`)
  expect(openMs).toBeGreaterThan(0)
}, 300_000)
