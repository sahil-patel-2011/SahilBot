// Dev helper: the inline stock card (chart, ranges, crosshair, forecast fan, model skill, stats) and the
// watchlist tab. A fake market tool result carrying meta.stock is pushed into the open chat through the
// chat:event channel, so this works whether or not the market tools exist yet. Hidden window.
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { launch, tempProfile } from '../accept/app'
import { startMockLlm } from '../fixtures/mock-llm'
import type { StockCardData } from '../../src/shared/types'

const DAY = 864e5

/** A deterministic random walk of daily closes (weekdays only) ending today at `end`. */
function walk(seed: number, n: number, end: number, vol: number): Array<[number, number]> {
  let s = seed
  const rnd = (): number => { s = (s * 16807) % 2147483647; return s / 2147483647 }
  const out: Array<[number, number]> = []
  const now = new Date(); now.setHours(12, 0, 0, 0)
  let t = now.getTime()
  const times: number[] = []
  while (times.length < n) { const d = new Date(t).getDay(); if (d !== 0 && d !== 6) times.unshift(t); t -= DAY }
  let v = end
  for (let i = n - 1; i >= 0; i--) { out.unshift([times[i], +v.toFixed(2)]); v = v / (1 + (rnd() - 0.48) * vol) }
  return out
}

function forecast(last: [number, number], days: number, vol: number, probUp: number, skill: { pinballVsNaive: number; coverage90: number; directionalAccuracy: number; samples: number }): NonNullable<StockCardData['forecast']> {
  const dates: number[] = []
  let t = last[0]
  while (dates.length < days) { t += DAY; const d = new Date(t).getDay(); if (d !== 0 && d !== 6) dates.push(t) }
  const z = { p5: -1.645, p25: -0.674, p50: 0.02, p75: 0.674, p95: 1.645 }
  const band = (k: keyof typeof z): number[] => dates.map((_, i) => +(last[1] * Math.exp(z[k] * vol * Math.sqrt(i + 1))).toFixed(2))
  return { horizonDays: days, dates, p5: band('p5'), p25: band('p25'), p50: band('p50'), p75: band('p75'), p95: band('p95'), probUp, model: 'Bootstrap + GARCH ensemble', skill }
}

test('stock card + watchlist shots', async () => {
  const out = process.env.SHOTS_DIR ?? tmpdir()
  const llm = await startMockLlm()
  const { app, page } = await launch(tempProfile(), llm.url)
  await page.setViewportSize({ width: 1180, height: 1320 })
  await page.fill('[data-testid="composer-input"]', 'How is ACME doing?')
  await page.keyboard.press('Enter')
  await page.waitForSelector('[data-testid="assistant-bubble"]')
  await page.waitForTimeout(800)
  const threadId = await page.evaluate(async () => {
    const api = (window as any).foreman
    return (await api.threads.list())[0].id as string
  })

  const acmeSeries = walk(7, 260, 187.42, 0.035)
  const acme: StockCardData = {
    symbol: 'ACME', name: 'Acme Robotics Inc.', currency: 'USD', price: 187.42, asOf: acmeSeries.at(-1)![0] + 4 * 3600e3,
    change1d: 187.42 / acmeSeries.at(-2)![1] - 1, series: acmeSeries,
    stats: { open: 185.1, high52: Math.max(...acmeSeries.map((x) => x[1])), low52: Math.min(...acmeSeries.map((x) => x[1])), volume: 48_210_000, avgVolume: 52_900_000, marketCap: 2.84e12, pe: 31.6, eps: 5.93, dividendYield: 0.0052, beta: 1.18, volatility: 0.274, rsi14: 58.2, sma50: 181.37, sma200: 172.05, maxDrawdown: -0.183, return1m: acmeSeries.at(-1)![1] / acmeSeries.at(-22)![1] - 1, return1y: acmeSeries.at(-1)![1] / acmeSeries[0][1] - 1 },
    forecast: forecast(acmeSeries.at(-1)!, 21, 0.017, 0.54, { pinballVsNaive: 0.993, coverage90: 0.87, directionalAccuracy: 0.51, samples: 180 }),
    source: 'Stooq daily closes', disclaimer: 'For information only. Not financial advice. Forecasts are ranges of plausible prices from a statistical model, not predictions; past performance and backtests do not guarantee future results.'
  }
  const nordSeries = walk(42, 130, 64.18, 0.05)
  const nord: StockCardData = {
    symbol: 'NRDX', name: 'Nordex Semiconductors', currency: 'USD', price: 64.18, asOf: nordSeries.at(-1)![0] + 4 * 3600e3,
    change1d: 64.18 / nordSeries.at(-2)![1] - 1, series: nordSeries,
    stats: { marketCap: 18.4e9, pe: 22.1, volume: 3_400_000, beta: 1.62, volatility: 0.48, return1m: nordSeries.at(-1)![1] / nordSeries.at(-22)![1] - 1 },
    forecast: forecast(nordSeries.at(-1)!, 21, 0.028, 0.47, { pinballVsNaive: 0.94, coverage90: 0.9, directionalAccuracy: 0.55, samples: 96 }),
    source: 'Stooq daily closes', disclaimer: 'For information only. Not financial advice.'
  }

  await app.evaluate(({ BrowserWindow }, x) => {
    const wc = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#quick'))!.webContents
    const at = Date.now()
    const send = (message: unknown): void => wc.send('chat:event', { threadId: x.threadId, type: 'message', message })
    send({ id: 'stk-a1', threadId: x.threadId, role: 'assistant', content: '', kind: 'normal', status: 'done', createdAt: at,
      toolCalls: [{ id: 'call_acme', name: 'stock_quote', arguments: JSON.stringify({ symbol: 'ACME', forecast: true }) }, { id: 'call_nrdx', name: 'stock_quote', arguments: JSON.stringify({ symbol: 'NRDX' }) }] })
    send({ id: 'stk-t1', threadId: x.threadId, role: 'tool', toolCallId: 'call_acme', toolName: 'stock_quote', content: '<tool_output>ACME 187.42</tool_output>', kind: 'normal', status: 'done', createdAt: at + 10, meta: { status: 'ok', display: 'ACME $187.42', stock: x.acme } })
    send({ id: 'stk-t2', threadId: x.threadId, role: 'tool', toolCallId: 'call_nrdx', toolName: 'stock_quote', content: '<tool_output>NRDX 64.18</tool_output>', kind: 'normal', status: 'done', createdAt: at + 20, meta: { status: 'ok', display: 'NRDX $64.18', stock: x.nord } })
    send({ id: 'stk-a2', threadId: x.threadId, role: 'assistant', content: 'ACME closed at **$187.42**. The model gives about a 54% chance it ends higher in 21 trading days, but it shows no edge over a random walk in backtests, so treat the range as context, not a call. Not financial advice; for information only.', kind: 'normal', status: 'done', createdAt: at + 30 })
  }, { threadId, acme, nord })
  await page.waitForSelector('[data-testid="stock-card"]')
  await page.waitForTimeout(600)
  expect(await page.locator('[data-testid="stock-card"]').count()).toBe(2)
  const card = page.locator('[data-testid="stock-card"]').first()
  await card.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${out}/stocks-chat.png` })
  await card.screenshot({ path: `${out}/stocks-card.png` })

  // Crosshair in the forecast part, then the history part.
  const chart = card.locator('[data-testid="stock-chart"]')
  const box = (await chart.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.82, box.y + box.height / 2)
  await page.waitForTimeout(200)
  await card.screenshot({ path: `${out}/stocks-hover-forecast.png` })
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2)
  await page.waitForTimeout(200)
  await card.screenshot({ path: `${out}/stocks-hover-history.png` })

  await card.locator('[data-testid="stock-range-1Y"]').click()
  await page.mouse.move(0, 0)
  await page.waitForTimeout(200)
  await card.screenshot({ path: `${out}/stocks-card-1y.png` })
  await card.locator('[data-testid="stock-range-1M"]').click()
  await page.waitForTimeout(200)
  await card.screenshot({ path: `${out}/stocks-card-1m.png` })

  await card.locator('[data-testid="stock-skill"]').hover()
  await page.waitForTimeout(250)
  await page.screenshot({ path: `${out}/stocks-skill-tip.png` })

  // Set alert prefills the composer.
  await card.locator('[data-testid="stock-alert"]').click()
  expect(await page.inputValue('[data-testid="composer-input"]')).toBe('Alert me when ACME ')
  await card.locator('[data-testid="stock-report"]').click()
  expect(await page.inputValue('[data-testid="composer-input"]')).toBe('Make a full report page for ACME')

  // Watchlist: add from the card, then open it (the button becomes "On watchlist" and opens the tab).
  await card.locator('[data-testid="stock-add-watch"]').click()
  await page.waitForTimeout(300)
  await page.locator('[data-testid="stock-card"]').nth(1).locator('[data-testid="stock-add-watch"]').click()
  await page.waitForTimeout(300)
  await card.locator('[data-testid="stock-add-watch"]').click()
  await page.waitForSelector('[data-testid="watchlist"]')
  await page.fill('[data-testid="watchlist-input"]', 'msft')
  await page.click('[data-testid="watchlist-add"]')
  await page.waitForTimeout(400)
  expect(await page.locator('[data-testid="watchlist-row"]').count()).toBe(3)
  const saved = await page.evaluate(() => (window as any).foreman.watchlist.get())
  expect(saved.map((x: { symbol: string }) => x.symbol)).toEqual(['ACME', 'NRDX', 'MSFT'])
  expect(saved[0].spark.length).toBeGreaterThan(10)
  await page.locator('[data-testid="watchlist-row"]').nth(1).hover()
  await page.waitForTimeout(150)
  await page.screenshot({ path: `${out}/stocks-watchlist.png` })
  // Reorder (move NRDX up) and click a symbol to ask about it.
  await page.locator('[data-testid="watchlist-row"]').nth(1).getByRole('button', { name: 'Move NRDX up' }).click()
  await page.waitForTimeout(300)
  expect((await page.evaluate(() => (window as any).foreman.watchlist.get())).map((x: { symbol: string }) => x.symbol)).toEqual(['NRDX', 'ACME', 'MSFT'])
  await page.locator('[data-testid="watchlist-row"] .wl-main').first().click()
  expect(await page.inputValue('[data-testid="composer-input"]')).toBe('How is NRDX doing?')

  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/stocks-dark.png` })
  await card.screenshot({ path: `${out}/stocks-card-dark.png` })

  // Narrow window: the card compacts.
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 760, height: 1320 })
  await page.click('[data-testid="right-panel"] button[title^="Close panel"]')
  await page.waitForTimeout(400)
  await card.scrollIntoViewIfNeeded()
  await card.screenshot({ path: `${out}/stocks-card-narrow.png` })
  await app.close()
  await llm.close()
}, 120_000)
