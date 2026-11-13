import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { alertCron, alertFromPrompt, alertPrompt, checkAlert, describeAlert, parseAlert, usMarketOpen } from '../../src/main/markets/alerts'
import { MarketData } from '../../src/main/markets/data'
import {
  flowTtm, parseAlphaDaily, parseAlphaQuote, parseCompanyFacts, parseFinnhubQuote, parsePolygonDaily, parseSecTickers, parseStooqCsv,
  parseSubmissions, parseTiingoDaily, type Fetcher
} from '../../src/main/markets/providers'
import { Markets } from '../../src/main/markets/service'
import { normalizeSymbol } from '../../src/main/markets/symbols'
import { ProviderError } from '../../src/main/markets/types'
import { stockTools } from '../../src/main/agent/tools/stocks'

const FX = join(__dirname, '..', 'fixtures', 'markets')
const fx = (f: string): string => readFileSync(join(FX, f), 'utf8')
const CHALLENGE = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><noscript>This site requires JavaScript to verify your browser. Please enable JavaScript and reload.</noscript><script>/* proof of work */</script></body></html>'

/** Stooq-format CSV from one column of the saved real AAPL / S&P 500 closes (2014-2016; same dates). */
function closesCsv(col: 1 | 2, scale = 1): string {
  const rows = fx('aapl-spx-closes.csv').trim().split('\n').slice(1).map((l) => l.split(','))
  return 'Date,Open,High,Low,Close,Volume\n' + rows.map((r) => { const c = Number(r[col]) / scale; return `${r[0]},${c},${c},${c},${c},1000` }).join('\n')
}
/** SPY stand-in: the real S&P 500 index closes / 10 (SPY tracks the index at about a tenth of its level). */
const spyCsv = (): string => closesCsv(2, 10)

describe('symbols', () => {
  test('normalizes share classes, indices, FX and foreign suffixes', () => {
    expect(normalizeSymbol('brk.b')).toMatchObject({ display: 'BRK.B', stooq: 'brk-b.us', sec: 'BRK-B', us: true })
    expect(normalizeSymbol('BRK-B')!.display).toBe('BRK.B')
    expect(normalizeSymbol('$aapl')).toMatchObject({ display: 'AAPL', stooq: 'aapl.us', sec: 'AAPL', kind: 'stock' })
    expect(normalizeSymbol('^GSPC')).toMatchObject({ display: '^SPX', stooq: '^spx', kind: 'index', us: false })
    expect(normalizeSymbol('spx')!.stooq).toBe('^spx')
    expect(normalizeSymbol('VOD.L')).toMatchObject({ display: 'VOD.L', stooq: 'vod.uk', currency: 'GBP', us: false })
    expect(normalizeSymbol('EURUSD=X')).toMatchObject({ display: 'EURUSD', stooq: 'eurusd', kind: 'fx', currency: 'USD' })
    expect(normalizeSymbol('SPY')).toMatchObject({ stooq: 'spy.us', us: true })
    expect(normalizeSymbol('not a ticker!')).toBeNull()
    expect(normalizeSymbol('')).toBeNull()
  })
})

describe('Stooq', () => {
  test('parses the saved AAPL daily CSV', () => {
    const bars = parseStooqCsv(fx('aapl-stooq.csv'))
    expect(bars).toHaveLength(506)
    expect(bars[0]).toMatchObject({ o: 127.49, c: 127.83, v: 63152400 })
    expect(new Date(bars[0].t).toISOString()).toBe('2015-02-17T12:00:00.000Z')
    expect(bars.every((b, i) => i === 0 || b.t > bars[i - 1].t)).toBe(true)
  })
  test('a browser-verification page is reported as blocked, never worked around', () => {
    expect(() => parseStooqCsv(CHALLENGE)).toThrow(/browser verification/)
    try { parseStooqCsv(CHALLENGE) } catch (e) { expect((e as ProviderError).kind).toBe('blocked') }
    expect(() => parseStooqCsv('No data')).toThrow(/no data/i)
    expect(() => parseStooqCsv('Exceeded the daily hits limit')).toThrow(/limit/)
  })
  test('index CSV without volume', () => {
    const bars = parseStooqCsv('Date,Open,High,Low,Close\n2026-11-11,1,2,0.5,1.5\n2026-11-12,1.5,2,1,1.8')
    expect(bars.map((b) => b.c)).toEqual([1.5, 1.8])
    expect(bars[0].v).toBe(0)
  })
})

describe('SEC EDGAR', () => {
  const facts = JSON.parse(fx('edgar-companyfacts-aapl.json'))
  test('company facts: annual, TTM and balance sheet', () => {
    const f = parseCompanyFacts(facts)
    expect(f.name).toBe('Apple Inc.')
    expect(f.fiscalYearEnd).toBe('2026-09-26')
    expect(f.revenueFy).toBe(478834000000)
    expect(f.revenueTtm).toBe(478834000000) // no 10-Q after the 10-K yet
    expect(f.revenueGrowthYoY).toBeCloseTo(478834 / 416161 - 1, 6)
    expect(f.netIncomeTtm).toBe(132175000000)
    expect(f.epsDilutedTtm).toBe(8.98)
    expect(f.cash).toBe(36305000000)
    expect(f.totalDebt).toBe(78114000000 + 1997000000) // long-term debt incl. current + commercial paper
    expect(f.sharesOutstanding).toBe(14532182000)
    expect(f.balanceSheetDate).toBe('2026-09-26')
    expect(f.grossMargin).toBeCloseTo(233602 / 478834, 6)
    expect(f.latestFiling).toEqual({ form: '10-K', filed: '2026-11-03' })
  })
  test('TTM = last fiscal year + this year-to-date - last year-to-date (as of the Q3 10-Q)', () => {
    const rev = facts.facts['us-gaap'].RevenueFromContractWithCustomerExcludingAssessedTax.units.USD.filter((x: { filed: string }) => x.filed <= '2026-08-01')
    const t = flowTtm(rev)
    expect(t.fy).toBe(416161000000)
    expect(t.ttm).toBe(416161000000 + 364357000000 - 313695000000)
    expect(t.ttmEnd).toBe('2026-06-27')
  })
  test('filings list with links and 8-K item meanings', () => {
    const s = parseSubmissions(JSON.parse(fx('edgar-submissions-aapl.json')), 5)
    expect(s.filings).toHaveLength(5)
    expect(s.filings.every((f) => ['10-K', '10-Q', '8-K', 'DEF 14A', '8-K/A', '10-K/A'].includes(f.form))).toBe(true)
    const tenK = s.filings.find((f) => f.form === '10-K')!
    expect(tenK.url).toBe('https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm')
    expect(s.filings.some((f) => /earnings results/.test(f.description))).toBe(true)
  })
  test('ticker map', () => {
    const t = parseSecTickers(JSON.parse(fx('edgar-tickers.json')))
    expect(t.AAPL).toEqual({ cik: 320193, name: 'Apple Inc.' })
    expect(t['BRK-B'].cik).toBe(1067983)
  })
})

describe('keyed provider parsers', () => {
  test('Tiingo uses adjusted prices', () => {
    const bars = parseTiingoDaily(JSON.stringify([{ date: '2026-11-12T00:00:00.000Z', open: 10, high: 11, low: 9, close: 10.5, volume: 5, adjOpen: 5, adjHigh: 5.5, adjLow: 4.5, adjClose: 5.25, adjVolume: 10 }]))
    expect(bars[0]).toMatchObject({ c: 5.25, v: 10 })
    expect(() => parseTiingoDaily(JSON.stringify({ detail: 'Invalid token.' }))).toThrow(/Invalid token/)
  })
  test('Polygon aggregates and errors', () => {
    const bars = parsePolygonDaily(JSON.stringify({ status: 'OK', results: [{ o: 1, h: 2, l: 0.5, c: 1.5, v: 9, t: Date.UTC(2026, 10, 12, 5) }] }))
    expect(new Date(bars[0].t).toISOString().slice(0, 10)).toBe('2026-11-12')
    expect(() => parsePolygonDaily(JSON.stringify({ status: 'NOT_AUTHORIZED', message: 'plan' }))).toThrow(ProviderError)
  })
  test('Alpha Vantage daily is split-adjusted here; rate-limit notes become errors', () => {
    const bars = parseAlphaDaily(JSON.stringify({ 'Time Series (Daily)': {
      '2026-11-10': { '1. open': '400', '2. high': '401', '3. low': '399', '4. close': '400', '5. volume': '10' },
      '2026-11-11': { '1. open': '200', '2. high': '201', '3. low': '199', '4. close': '201', '5. volume': '20' }
    } }))
    expect(bars[0].c).toBe(200)
    expect(() => parseAlphaDaily(JSON.stringify({ Note: 'Thank you for using Alpha Vantage! Our standard API rate limit is 25 requests per day.' }))).toThrow(/rate limit/)
    const q = parseAlphaQuote(JSON.stringify({ 'Global Quote': { '05. price': '180.5', '07. latest trading day': '2026-11-12', '08. previous close': '178' } }), 'AAPL')
    expect(q).toMatchObject({ price: 180.5, prevClose: 178, live: true })
  })
  test('Finnhub quote', () => {
    expect(parseFinnhubQuote(JSON.stringify({ c: 101, pc: 100, t: 1763000000 }), 'X')).toMatchObject({ price: 101, prevClose: 100, asOf: 1763000000000 })
    expect(() => parseFinnhubQuote(JSON.stringify({ c: 0 }), 'ZZZZ')).toThrow(/no quote/)
  })
})

// ---------------------------------------------------------------- the data service with a fake network

interface FakeNet { fetch: Fetcher; calls: string[]; routes: Map<RegExp, () => { status: number; body: string }> }
function fakeNet(routes: Array<[RegExp, string | (() => { status: number; body: string })]>): FakeNet {
  const calls: string[] = []
  const map = new Map(routes.map(([re, b]) => [re, typeof b === 'string' ? () => ({ status: 200, body: b }) : b]))
  return {
    calls, routes: map,
    fetch: async (url) => {
      calls.push(url)
      for (const [re, f] of map) if (re.test(url)) { const r = f(); return { ok: r.status < 400, status: r.status, text: async () => r.body } }
      return { ok: false, status: 404, text: async () => 'not found' }
    }
  }
}
const dirs: string[] = []
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), 'sb-markets-')); dirs.push(d); return d }
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const ROUTES = (): Array<[RegExp, string]> => [
  [/stooq\.com.*s=aapl\.us/, fx('aapl-stooq.csv')],
  [/stooq\.com.*s=spy\.us/, spyCsv()],
  [/company_tickers\.json/, fx('edgar-tickers.json')],
  [/companyfacts\/CIK0000320193/, fx('edgar-companyfacts-aapl.json')],
  [/submissions\/CIK0000320193/, fx('edgar-submissions-aapl.json')]
]

describe('MarketData', () => {
  test('caches daily data on disk (second call: no network) and serves stale data when sources fail', async () => {
    const dir = tmp()
    let now = Date.UTC(2026, 10, 13)
    const net = fakeNet(ROUTES())
    const md = new MarketData({ cacheDir: dir, keys: () => ({}), fetch: net.fetch, now: () => now })
    const a = await md.daily('AAPL')
    expect(a.source).toMatch(/Stooq/)
    await md.daily('aapl')
    expect(net.calls.filter((u) => u.includes('stooq'))).toHaveLength(1)
    // A new process with the same cache folder reads it from disk.
    const md2 = new MarketData({ cacheDir: dir, keys: () => ({}), fetch: net.fetch, now: () => now })
    await md2.daily('AAPL')
    expect(net.calls.filter((u) => u.includes('stooq'))).toHaveLength(1)
    // Expired + Stooq blocked: the old copy is served, marked stale.
    now += 5 * 3_600_000
    net.routes.clear()
    net.routes.set(/stooq/, () => ({ status: 200, body: CHALLENGE }))
    const stale = await md2.daily('AAPL')
    expect(stale.stale).toBe(true)
    expect(stale.bars).toHaveLength(506)
  })
  test('Stooq blocked → falls back to a keyed provider; without keys the error says how to fix it', async () => {
    const tiingo = JSON.stringify(fx('aapl-stooq.csv').trim().split('\n').slice(1).map((l) => { const [d, o, h, lo, c, v] = l.split(','); return { date: `${d}T00:00:00.000Z`, adjOpen: +o, adjHigh: +h, adjLow: +lo, adjClose: +c, adjVolume: +v } }))
    const net = fakeNet([[/stooq/, CHALLENGE], [/api\.tiingo\.com\/tiingo\/daily\/aapl/, tiingo]])
    const md = new MarketData({ cacheDir: null, keys: () => ({ tiingo: 'k' }), fetch: net.fetch })
    const h = await md.daily('AAPL')
    expect(h.source).toMatch(/Tiingo/)
    expect(h.bars).toHaveLength(506)
    const none = new MarketData({ cacheDir: null, keys: () => ({}), fetch: fakeNet([[/stooq/, CHALLENGE]]).fetch })
    await expect(none.daily('AAPL')).rejects.toThrow(/browser verification.*Settings → Markets/)
  })
  test('without a key the quote is the last daily close, clearly not live; with Finnhub it is live', async () => {
    const md = new MarketData({ cacheDir: null, keys: () => ({}), fetch: fakeNet(ROUTES()).fetch })
    const q = await md.quote('AAPL')
    expect(q).toMatchObject({ price: 135.35, live: false })
    expect(new Date(q.asOf).toISOString().slice(0, 10)).toBe('2017-02-16')
    const live = new MarketData({ cacheDir: null, keys: () => ({ finnhub: 'k' }), fetch: fakeNet([...ROUTES(), [/finnhub\.io\/api\/v1\/quote/, JSON.stringify({ c: 140, pc: 135.35, t: 1763050000 })]]).fetch })
    expect(await live.quote('AAPL')).toMatchObject({ price: 140, live: true, source: 'Finnhub' })
  })
  test('SEC requests identify the app with a generic contact', async () => {
    const seen: Array<Record<string, string> | undefined> = []
    const net = fakeNet(ROUTES())
    const md = new MarketData({ cacheDir: null, keys: () => ({}), fetch: (u, i) => { seen.push(i?.headers); return net.fetch(u, i) }, secUserAgent: () => 'SahilBot/0.1 (contact@example.com)' })
    expect(await md.company('brk.b')).toEqual({ cik: 1067983, name: 'BERKSHIRE HATHAWAY INC' })
    expect(seen[0]?.['user-agent']).toBe('SahilBot/0.1 (contact@example.com)')
    expect((await md.search('appl'))[0]).toEqual({ symbol: 'AAPL', name: 'Apple Inc.' })
  })
})

describe('Markets service and tools', () => {
  const markets = new Markets(new MarketData({ cacheDir: null, keys: () => ({}), fetch: fakeNet(ROUTES()).fetch }))

  test('quote card: fractions, sources, as-of date and the disclaimer', async () => {
    const r = await markets.quote('AAPL')
    const c = r.card
    expect(c).toMatchObject({ symbol: 'AAPL', name: 'Apple Inc.', price: 135.35, live: false, kind: 'quote' })
    expect(Math.abs(c.change1d!)).toBeLessThan(0.05) // a fraction, not percent
    expect(c.stats!.volatility).toBeGreaterThan(0.1)
    expect(c.stats!.volatility).toBeLessThan(0.5)
    expect(c.stats!.maxDrawdown).toBeLessThan(0)
    // Beta needs 60+ common sessions in the last year; the AAPL fixture (to 2017) and SPY stand-in (to 2016-03) barely overlap, so none is shown.
    expect(c.stats!.beta).toBeUndefined()
    expect(c.series.length).toBe(252)
    expect(r.text).toMatch(/last daily close on 2017-02-16/)
    expect(r.text).toMatch(/Data: Stooq daily closes.*As of the 2017-02-16 close\. Not financial advice\.$/s)
  })
  test('forecast card: arrays start at the last close, skill numbers present, honest text', async () => {
    const r = await markets.forecast('AAPL', { horizonDays: 10, target: 150 })
    const f = r.card.forecast!
    expect(f.horizonDays).toBe(10)
    for (const k of ['dates', 'p5', 'p25', 'p50', 'p75', 'p95'] as const) expect(f[k]).toHaveLength(11)
    expect(f.p50[0]).toBe(135.35)
    expect(f.dates[0]).toBe(r.card.asOf)
    expect(f.p5[10]).toBeLessThan(f.p95[10])
    expect(f.skill!.samples).toBeGreaterThan(5)
    expect(f.skill!.coverage90).toBeGreaterThanOrEqual(0)
    expect(f.skill!.coverage90).toBeLessThanOrEqual(1)
    expect(r.card.target!.probTouch).toBeGreaterThanOrEqual(r.card.target!.probAboveAtEnd)
    expect(r.card.forecastDetail!.models).toHaveLength(3)
    expect(r.text).toMatch(/close to a random walk/)
    expect(r.text).toMatch(/Honest skill check/)
    expect(r.text).toMatch(/Not financial advice\.$/)
  })
  test('analysis includes SEC fundamentals and filings', async () => {
    const r = await markets.analyze('AAPL')
    expect(r.card.fundamentals?.revenueTtm).toBe(478834000000)
    expect(r.card.filings?.length).toBeGreaterThan(0)
    expect(r.text).toMatch(/Recent SEC filings/)
    expect(r.text).toMatch(/SEC EDGAR/)
  })
  test('compare and backtest', async () => {
    // Real AAPL and S&P 500 closes over the same dates: strongly correlated, beta near 1.
    const same = new Markets(new MarketData({ cacheDir: null, keys: () => ({}), fetch: fakeNet([[/s=aapl\.us/, closesCsv(1)], [/s=spy\.us/, spyCsv()], ...ROUTES().slice(2)]).fetch }))
    const c = await same.compare(['AAPL', 'SPY'])
    expect(c.card.compare!.rows[0].beta).toBeGreaterThan(0.8)
    expect(c.card.compare!.rows[0].beta).toBeLessThan(1.4)
    expect(c.card.compare!.correlation[0][0]).toBe(1)
    expect(c.card.compare!.correlation[0][1]).toBeGreaterThan(0.3)
    expect(c.cards).toHaveLength(2)
    const b = await markets.backtest('AAPL', 'sma_cross', { fast: 10, slow: 30 }, { years: 1 })
    expect(b.card.backtest!.metrics.trades).toBeGreaterThan(0)
    expect(b.text).toMatch(/overfitting/)
    expect(b.text).toMatch(/no look-ahead/)
  })
  test('watchlist quotes: percent change, sparkline, unknown symbols kept', async () => {
    const q = await markets.quotes(['AAPL', 'NOPE'])
    expect(q[0]).toMatchObject({ symbol: 'AAPL', name: 'Apple Inc.', price: 135.35 })
    expect(q[0].changePct).toBeCloseTo((135.35 / 135.51 - 1) * 100, 6)
    expect(q[0].spark).toHaveLength(60)
    expect(q[1]).toEqual({ symbol: 'NOPE' })
  })
  test('tools attach meta.stock and are read-only; none can trade', async () => {
    const tools = stockTools(markets, { scheduler: {} as never, db: {} as never, liveQuotes: () => false })
    expect(tools.map((t) => t.name)).toEqual(['stock_quote', 'stock_analyze', 'stock_forecast', 'stock_compare', 'stock_backtest', 'price_alert'])
    for (const t of tools.slice(0, 5)) expect(t.effect).toBe('read')
    expect(tools.every((t) => !/\b(buy|sell|order)\b/.test(Object.keys((t.parameters as { properties: object }).properties).join(' ')))).toBe(true)
    const out = await tools[0].run({ symbol: 'AAPL' }, { signal: new AbortController().signal } as never)
    expect((out.meta?.stock as { symbol: string }).symbol).toBe('AAPL')
  })
  test('price alerts: no repeat firing for level alerts until the condition clears', async () => {
    let r = await markets.checkAlert({ symbol: 'AAPL', kind: 'below', threshold: 140 }, undefined)
    expect(r.fired).toBe(true)
    expect(r.text).toMatch(/never trades.*Not financial advice/)
    r = await markets.checkAlert({ symbol: 'AAPL', kind: 'below', threshold: 140 }, r.state)
    expect(r.fired).toBe(false)
    const above = await markets.checkAlert({ symbol: 'AAPL', kind: 'above', threshold: 200 }, undefined)
    expect(above.fired).toBe(false)
  })
})

describe('price alert conditions', () => {
  test('parses plain English', () => {
    expect(parseAlert('AAPL below 180')).toEqual({ symbol: 'AAPL', kind: 'below', threshold: 180 })
    expect(parseAlert('aapl drops below $1,250.50')).toEqual({ symbol: 'AAPL', kind: 'below', threshold: 1250.5 })
    expect(parseAlert('TSLA above 300')).toEqual({ symbol: 'TSLA', kind: 'above', threshold: 300 })
    expect(parseAlert('MSFT hits 500')).toEqual({ symbol: 'MSFT', kind: 'above', threshold: 500 })
    expect(parseAlert('NVDA moves ±5% in a day')).toEqual({ symbol: 'NVDA', kind: 'move', threshold: 5, direction: 'either' })
    expect(parseAlert('NVDA moves +/- 2.5%')).toEqual({ symbol: 'NVDA', kind: 'move', threshold: 2.5, direction: 'either' })
    expect(parseAlert('SPY down 3% in a day')).toEqual({ symbol: 'SPY', kind: 'move', threshold: 3, direction: 'down' })
    expect(parseAlert('BRK.B jumps 4%')).toEqual({ symbol: 'BRK.B', kind: 'move', threshold: 4, direction: 'up' })
    expect(parseAlert('AAPL is nice')).toBeNull()
    expect(parseAlert('')).toBeNull()
  })
  test('round-trips through a routine prompt', () => {
    const spec = { symbol: 'AAPL', kind: 'below' as const, threshold: 180 }
    const p = alertPrompt(spec)
    expect(alertFromPrompt(p)).toEqual(spec)
    expect(alertFromPrompt('Check my inbox')).toBeNull()
    expect(alertFromPrompt('[price-alert] {broken')).toBeNull()
    expect(describeAlert(spec)).toBe('AAPL at or below $180')
  })
  test('checks conditions', () => {
    expect(checkAlert({ symbol: 'A', kind: 'below', threshold: 100 }, { price: 99, asOf: 0 }).hit).toBe(true)
    expect(checkAlert({ symbol: 'A', kind: 'above', threshold: 100 }, { price: 99, asOf: 0 }).hit).toBe(false)
    const mv = checkAlert({ symbol: 'A', kind: 'move', threshold: 5, direction: 'either' }, { price: 94, prevClose: 100, asOf: 0 })
    expect(mv.hit).toBe(true)
    expect(mv.changePct).toBeCloseTo(-6, 10)
    expect(checkAlert({ symbol: 'A', kind: 'move', threshold: 5, direction: 'up' }, { price: 94, prevClose: 100, asOf: 0 }).hit).toBe(false)
    expect(checkAlert({ symbol: 'A', kind: 'move', threshold: 5 }, { price: 94, asOf: 0 }).hit).toBe(false)
  })
  test('market hours (New York) and check schedules', () => {
    expect(usMarketOpen(new Date('2026-11-13T15:00:00Z'))).toBe(true) // Fri 10:00 EST
    expect(usMarketOpen(new Date('2026-11-13T14:00:00Z'))).toBe(false) // 9:00 EST
    expect(usMarketOpen(new Date('2026-11-14T16:00:00Z'))).toBe(false) // Saturday
    expect(alertCron(true)).toMatch(/^\*\/15 [\d*-]+ \* \* \*$/)
    expect(alertCron(false)).toMatch(/^\d+ \d+ \* \* \*$/)
  })
})
