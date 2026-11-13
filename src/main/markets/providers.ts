// Market data providers: request builders and parsers. Parsers are pure (unit-tested with saved
// fixtures); fetching goes through an injectable fetch so tests never touch the network.
//
// Default, keyless: Stooq daily CSV (split-adjusted OHLCV) and SEC EDGAR (company facts, filings).
// Optional, with a key from Settings → Markets: Tiingo (full adjusted daily history, IEX quotes),
// Polygon (2 years of adjusted daily bars on the free plan, news), Alpha Vantage (quotes, daily bars,
// news) and Finnhub (real-time quotes, company news).
//
// Note (2026-11): Stooq sometimes answers apps with a JavaScript "verify your browser" page instead of
// CSV. SahilBot never tries to get around that check: it reports it and falls back to a keyed provider.

import { adjustSplits } from './indicators'
import type { Bar, Filing, Fundamentals, NewsItem, Quote } from './types'
import { ProviderError } from './types'

export type Fetcher = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/** Session date (YYYY-MM-DD) → 12:00 UTC that day, so it reads as the same date in every time zone. */
export function dayTime(ymd: string): number {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return Date.UTC(y, m - 1, d, 12)
}
export const ymd = (t: number): string => new Date(t).toISOString().slice(0, 10)

const finite = (b: Bar): boolean => [b.o, b.h, b.l, b.c].every((x) => Number.isFinite(x) && x > 0)

/** Sorted, one bar per date, positive prices only. */
export function cleanBars(bars: Bar[]): Bar[] {
  const byDay = new Map<number, Bar>()
  for (const b of bars) if (finite(b)) byDay.set(Math.floor(b.t / 86_400_000), { ...b, v: Number.isFinite(b.v) ? b.v : 0 })
  return [...byDay.values()].sort((a, b) => a.t - b.t)
}

// ---------------------------------------------------------------- Stooq

export function stooqUrl(stooqSymbol: string): string {
  return `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSymbol)}&i=d`
}

/** Parses Stooq's daily CSV (Date,Open,High,Low,Close[,Volume]). Throws ProviderError for its non-CSV answers. */
export function parseStooqCsv(text: string): Bar[] {
  const t = text.trim()
  if (/^<!doctype|^<html|<script/i.test(t)) {
    throw new ProviderError(/verify your browser|requires javascript/i.test(t) ? 'Stooq asked for browser verification (a bot check), so its free data is unavailable to apps right now.' : 'Stooq returned a web page instead of data.', 'blocked')
  }
  if (/exceeded the daily hits limit/i.test(t)) throw new ProviderError('Stooq\'s daily download limit was reached.', 'limit')
  if (!t || /^no data/i.test(t)) throw new ProviderError('Stooq has no data for this symbol.', 'not_found')
  const lines = t.split(/\r?\n/)
  const head = lines[0].toLowerCase().split(',')
  const col = (n: string): number => head.indexOf(n)
  const [di, oi, hi, li, ci, vi] = [col('date'), col('open'), col('high'), col('low'), col('close'), col('volume')]
  if (di < 0 || ci < 0) throw new ProviderError('Stooq returned an unexpected format.', 'bad_data')
  const bars: Bar[] = []
  for (const line of lines.slice(1)) {
    const f = line.split(',')
    if (f.length < 2 || !/^\d{4}-\d{2}-\d{2}/.test(f[di])) continue
    const c = Number(f[ci])
    bars.push({ t: dayTime(f[di]), o: oi >= 0 ? Number(f[oi]) : c, h: hi >= 0 ? Number(f[hi]) : c, l: li >= 0 ? Number(f[li]) : c, c, v: vi >= 0 ? Number(f[vi]) : 0 })
  }
  if (!bars.length) throw new ProviderError('Stooq has no data for this symbol.', 'not_found')
  return cleanBars(bars)
}

// ---------------------------------------------------------------- SEC EDGAR

export const SEC_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json'
export const secFactsUrl = (cik: number): string => `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`
export const secSubmissionsUrl = (cik: number): string => `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`

/** company_tickers.json → ticker (SEC spelling, e.g. BRK-B) → CIK and name. */
export function parseSecTickers(json: unknown): Record<string, { cik: number; name: string }> {
  const out: Record<string, { cik: number; name: string }> = {}
  for (const v of Object.values((json ?? {}) as Record<string, { cik_str: number; ticker: string; title: string }>)) {
    if (v && typeof v.ticker === 'string' && typeof v.cik_str === 'number') out[v.ticker.toUpperCase()] = { cik: v.cik_str, name: v.title }
  }
  return out
}

interface Fact { start?: string; end: string; val: number; form?: string; fp?: string; filed?: string; fy?: number }
type Facts = { cik?: number; entityName?: string; facts?: Record<string, Record<string, { units?: Record<string, Fact[]> }>> }

const DAY = 86_400_000
const days = (f: Fact): number => (f.start ? (Date.parse(f.end) - Date.parse(f.start)) / DAY : 0)

/** One value per period (the most recently filed), oldest first. */
function dedupe(xs: Fact[]): Fact[] {
  const m = new Map<string, Fact>()
  for (const f of xs) {
    if (!Number.isFinite(f.val) || !f.end) continue
    const k = `${f.start ?? ''}|${f.end}`
    const cur = m.get(k)
    if (!cur || (f.filed ?? '') >= (cur.filed ?? '')) m.set(k, f)
  }
  return [...m.values()].sort((a, b) => a.end.localeCompare(b.end) || days(a) - days(b))
}

function factList(j: Facts, tags: string[], unit = 'USD', ns = 'us-gaap'): Fact[] {
  for (const tag of tags) {
    const u = j.facts?.[ns]?.[tag]?.units
    const xs = u?.[unit] ?? (u ? Object.values(u)[0] : undefined)
    if (xs?.length) return dedupe(xs)
  }
  return []
}

/**
 * Flow items (revenue, income, cash flow): latest fiscal year, and trailing twelve months =
 * last annual + this year's year-to-date - last year's year-to-date (when a 10-Q came after the 10-K).
 */
export function flowTtm(xs: Fact[]): { ttm?: number; fy?: number; prevFy?: number; fyEnd?: string; ttmEnd?: string } {
  const annual = xs.filter((f) => days(f) >= 350 && days(f) <= 380)
  const a = annual[annual.length - 1]
  if (!a) return {}
  const prevA = annual.filter((f) => Math.abs(Date.parse(a.end) - Date.parse(f.end) - 365 * DAY) <= 12 * DAY).pop()
  const ytds = xs.filter((f) => days(f) >= 80 && days(f) <= 290 && f.end > a.end)
  // Latest end; among those, the longest (year-to-date rather than the quarter alone).
  const cur = ytds.sort((x, y) => x.end.localeCompare(y.end) || days(x) - days(y)).pop()
  const base = { fy: a.val, prevFy: prevA?.val, fyEnd: a.end }
  if (!cur) return { ...base, ttm: a.val, ttmEnd: a.end }
  const prior = xs.find((f) => Math.abs(Date.parse(cur.end) - Date.parse(f.end) - 365 * DAY) <= 12 * DAY && Math.abs(days(f) - days(cur)) <= 10)
  if (!prior) return { ...base, ttm: a.val, ttmEnd: a.end }
  return { ...base, ttm: a.val + cur.val - prior.val, ttmEnd: cur.end }
}

/** Latest point-in-time value (balance sheet items). */
function latest(xs: Fact[]): Fact | undefined {
  return [...xs].sort((a, b) => a.end.localeCompare(b.end) || (a.filed ?? '').localeCompare(b.filed ?? '')).pop()
}

export function parseCompanyFacts(json: unknown): Fundamentals {
  const j = json as Facts
  const rev = flowTtm(factList(j, ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'TotalRevenuesAndOtherIncome']))
  const ni = flowTtm(factList(j, ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic']))
  const eps = flowTtm(factList(j, ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'EarningsPerShareBasic'], 'USD/shares'))
  const gp = flowTtm(factList(j, ['GrossProfit']))
  const op = flowTtm(factList(j, ['OperatingIncomeLoss']))
  const ocf = flowTtm(factList(j, ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations']))
  const capex = flowTtm(factList(j, ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets']))
  const dps = flowTtm(factList(j, ['CommonStockDividendsPerShareDeclared', 'CommonStockDividendsPerShareCashPaid'], 'USD/shares'))
  const cash = latest(factList(j, ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents', 'Cash']))
  const equity = latest(factList(j, ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']))
  const bsDate = [cash?.end, equity?.end].filter(Boolean).sort().pop()
  const at = (tags: string[]): number | undefined => {
    const f = latest(factList(j, tags))
    return f && (!bsDate || f.end === bsDate) ? f.val : undefined
  }
  const ltd = at(['LongTermDebt']) ?? (() => {
    const nc = at(['LongTermDebtNoncurrent']); const c = at(['LongTermDebtCurrent'])
    return nc === undefined && c === undefined ? undefined : (nc ?? 0) + (c ?? 0)
  })()
  const short = (at(['CommercialPaper']) ?? 0) + (at(['ShortTermBorrowings']) ?? 0)
  const totalDebt = ltd === undefined && !short ? undefined : (ltd ?? 0) + short
  const sharesDei = latest(factList(j, ['EntityCommonStockSharesOutstanding'], 'shares', 'dei'))
  const sharesGaap = latest(factList(j, ['CommonStockSharesOutstanding'], 'shares'))
  const shares = sharesDei && (!sharesGaap || sharesDei.end >= sharesGaap.end) ? sharesDei : sharesGaap
  const all = Object.values(j.facts ?? {}).flatMap((ns) => Object.values(ns).flatMap((c) => Object.values(c.units ?? {}).flat()))
  const newest = all.reduce<Fact | undefined>((b, f) => (!b || (f.filed ?? '') > (b.filed ?? '') ? f : b), undefined)
  const ratio = (a?: number, b?: number): number | undefined => (a !== undefined && b ? a / b : undefined)
  return {
    cik: j.cik ?? 0,
    name: j.entityName ?? '',
    fiscalYearEnd: rev.fyEnd ?? ni.fyEnd,
    revenueTtm: rev.ttm, revenueFy: rev.fy,
    revenueGrowthYoY: rev.fy !== undefined && rev.prevFy ? rev.fy / rev.prevFy - 1 : undefined,
    netIncomeTtm: ni.ttm,
    epsDilutedTtm: eps.ttm, epsDilutedFy: eps.fy,
    grossMargin: ratio(gp.ttm, rev.ttm), operatingMargin: ratio(op.ttm, rev.ttm),
    cash: cash?.val, totalDebt, equity: equity?.val,
    sharesOutstanding: shares?.val,
    operatingCashFlowTtm: ocf.ttm, capexTtm: capex.ttm,
    freeCashFlowTtm: ocf.ttm !== undefined && capex.ttm !== undefined ? ocf.ttm - capex.ttm : undefined,
    dividendsPerShareTtm: dps.ttm,
    balanceSheetDate: bsDate,
    latestFiling: newest?.form && newest.filed ? { form: newest.form, filed: newest.filed } : undefined
  }
}

const FORM_LABEL: Record<string, string> = {
  '10-K': 'Annual report', '10-Q': 'Quarterly report', '8-K': 'Current report', '20-F': 'Annual report (foreign issuer)',
  '6-K': 'Report (foreign issuer)', '40-F': 'Annual report (Canadian issuer)', 'DEF 14A': 'Proxy statement', 'S-1': 'Registration statement',
  '10-K/A': 'Annual report (amended)', '10-Q/A': 'Quarterly report (amended)', '8-K/A': 'Current report (amended)', 'SC 13D': 'Ownership over 5% (active)', 'SC 13G': 'Ownership over 5% (passive)'
}
const ITEM_8K: Record<string, string> = {
  '1.01': 'material agreement', '1.02': 'agreement ended', '2.01': 'acquisition or sale completed', '2.02': 'earnings results', '2.03': 'new debt',
  '2.05': 'restructuring costs', '2.06': 'impairment', '3.01': 'listing notice', '4.01': 'auditor change', '4.02': 'restatement warning',
  '5.02': 'executive or director change', '5.03': 'bylaws change', '5.07': 'shareholder vote results', '7.01': 'Reg FD disclosure', '8.01': 'other events'
}

export function parseSubmissions(json: unknown, max = 8): { filings: Filing[]; name?: string; sic?: string; fiscalYearEnd?: string; exchanges?: string[] } {
  const j = json as { cik?: string | number; name?: string; sicDescription?: string; fiscalYearEnd?: string; exchanges?: string[]; filings?: { recent?: Record<string, Array<string | number>> } }
  const r = j.filings?.recent ?? {}
  const n = (r.form ?? []).length
  const cik = Number(j.cik ?? 0)
  const filings: Filing[] = []
  for (let i = 0; i < n && filings.length < max; i++) {
    const form = String(r.form[i])
    if (!FORM_LABEL[form]) continue
    const acc = String(r.accessionNumber?.[i] ?? '')
    const doc = String(r.primaryDocument?.[i] ?? '')
    const items = String(r.items?.[i] ?? '').split(',').map((x) => ITEM_8K[x.trim()]).filter(Boolean)
    filings.push({
      form, filed: String(r.filingDate?.[i] ?? ''), reportDate: String(r.reportDate?.[i] ?? '') || undefined,
      description: `${FORM_LABEL[form]}${items.length ? `: ${items.join(', ')}` : ''}`,
      url: doc ? `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}/${doc}` : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`
    })
  }
  return { filings, name: j.name, sic: j.sicDescription, fiscalYearEnd: j.fiscalYearEnd, exchanges: j.exchanges }
}

// ---------------------------------------------------------------- keyed providers

function json<T>(text: string, who: string): T {
  try { return JSON.parse(text) as T } catch { throw new ProviderError(`${who} returned something that isn't data.`, 'bad_data') }
}

export function tiingoDailyUrl(sym: string, start: string, key: string): string {
  return `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(sym.toLowerCase())}/prices?startDate=${start}&token=${encodeURIComponent(key)}`
}
export function parseTiingoDaily(text: string): Bar[] {
  const j = json<Array<Record<string, number | string>> | { detail?: string }>(text, 'Tiingo')
  if (!Array.isArray(j)) throw new ProviderError(`Tiingo: ${j.detail ?? 'no data'}`, /not found/i.test(String(j.detail)) ? 'not_found' : 'auth')
  return cleanBars(j.map((r) => ({ t: dayTime(String(r.date)), o: Number(r.adjOpen ?? r.open), h: Number(r.adjHigh ?? r.high), l: Number(r.adjLow ?? r.low), c: Number(r.adjClose ?? r.close), v: Number(r.adjVolume ?? r.volume) })))
}
export const tiingoQuoteUrl = (sym: string, key: string): string => `https://api.tiingo.com/iex/${encodeURIComponent(sym.toLowerCase())}?token=${encodeURIComponent(key)}`
export function parseTiingoQuote(text: string, symbol: string): Quote {
  const j = json<Array<Record<string, number | string | null>> | { detail?: string }>(text, 'Tiingo')
  const r = Array.isArray(j) ? j[0] : undefined
  const price = Number(r?.tngoLast ?? r?.last)
  if (!r || !(price > 0)) throw new ProviderError(`Tiingo has no live quote for ${symbol}.`, 'not_found')
  return { symbol, price, asOf: Date.parse(String(r.timestamp)) || Date.now(), prevClose: Number(r.prevClose) || undefined, open: Number(r.open) || undefined, high: Number(r.high) || undefined, low: Number(r.low) || undefined, volume: Number(r.volume) || undefined, live: true, source: 'Tiingo (IEX)' }
}

export function polygonDailyUrl(sym: string, from: string, to: string, key: string): string {
  return `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${encodeURIComponent(key)}`
}
export function parsePolygonDaily(text: string): Bar[] {
  const j = json<{ status?: string; results?: Array<{ o: number; h: number; l: number; c: number; v: number; t: number }>; error?: string; message?: string }>(text, 'Polygon')
  if (j.status === 'ERROR' || j.status === 'NOT_AUTHORIZED') throw new ProviderError(`Polygon: ${j.error ?? j.message ?? j.status}`, j.status === 'NOT_AUTHORIZED' ? 'auth' : 'limit')
  if (!j.results?.length) throw new ProviderError('Polygon has no data for this symbol.', 'not_found')
  return cleanBars(j.results.map((r) => ({ t: dayTime(new Date(r.t).toISOString()), o: r.o, h: r.h, l: r.l, c: r.c, v: r.v })))
}
export const polygonSnapshotUrl = (sym: string, key: string): string => `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(sym)}?apiKey=${encodeURIComponent(key)}`
export function parsePolygonSnapshot(text: string, symbol: string): Quote {
  const j = json<{ status?: string; ticker?: { day?: { o: number; h: number; l: number; c: number; v: number }; lastTrade?: { p: number; t: number }; prevDay?: { c: number }; updated?: number } }>(text, 'Polygon')
  const t = j.ticker
  const price = t?.lastTrade?.p ?? t?.day?.c
  if (!t || !(Number(price) > 0)) throw new ProviderError(`Polygon has no live quote for ${symbol} on this plan.`, 'auth')
  return { symbol, price: Number(price), asOf: t.lastTrade?.t ? Math.round(t.lastTrade.t / 1e6) : t.updated ? Math.round(t.updated / 1e6) : Date.now(), prevClose: t.prevDay?.c, open: t.day?.o, high: t.day?.h, low: t.day?.l, volume: t.day?.v, live: true, source: 'Polygon' }
}

export const alphaDailyUrl = (sym: string, full: boolean, key: string): string => `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(sym)}&outputsize=${full ? 'full' : 'compact'}&apikey=${encodeURIComponent(key)}`
function alphaError(j: Record<string, unknown>): ProviderError | null {
  const msg = (j['Error Message'] ?? j.Note ?? j.Information) as string | undefined
  if (!msg) return null
  return new ProviderError(`Alpha Vantage: ${String(msg).slice(0, 160)}`, j['Error Message'] ? 'not_found' : /premium/i.test(String(msg)) ? 'auth' : 'limit')
}
/** Alpha Vantage daily bars are not split-adjusted: obvious splits are adjusted here. */
export function parseAlphaDaily(text: string): Bar[] {
  const j = json<Record<string, unknown>>(text, 'Alpha Vantage')
  const err = alphaError(j)
  if (err) throw err
  const ts = j['Time Series (Daily)'] as Record<string, Record<string, string>> | undefined
  if (!ts) throw new ProviderError('Alpha Vantage returned no daily data.', 'not_found')
  const bars = cleanBars(Object.entries(ts).map(([d, r]) => ({ t: dayTime(d), o: Number(r['1. open']), h: Number(r['2. high']), l: Number(r['3. low']), c: Number(r['4. close']), v: Number(r['5. volume']) })))
  return adjustSplits(bars).bars
}
export const alphaQuoteUrl = (sym: string, key: string): string => `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(sym)}&apikey=${encodeURIComponent(key)}`
export function parseAlphaQuote(text: string, symbol: string): Quote {
  const j = json<Record<string, unknown>>(text, 'Alpha Vantage')
  const err = alphaError(j)
  if (err) throw err
  const q = j['Global Quote'] as Record<string, string> | undefined
  const price = Number(q?.['05. price'])
  if (!q || !(price > 0)) throw new ProviderError(`Alpha Vantage has no quote for ${symbol}.`, 'not_found')
  // GLOBAL_QUOTE is the latest trading day's last price (delayed on the free plan).
  return { symbol, price, asOf: dayTime(q['07. latest trading day']), prevClose: Number(q['08. previous close']) || undefined, open: Number(q['02. open']) || undefined, high: Number(q['03. high']) || undefined, low: Number(q['04. low']) || undefined, volume: Number(q['06. volume']) || undefined, live: true, source: 'Alpha Vantage (delayed)' }
}
export const alphaNewsUrl = (sym: string, key: string): string => `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(sym)}&limit=20&apikey=${encodeURIComponent(key)}`
export function parseAlphaNews(text: string): NewsItem[] {
  const j = json<Record<string, unknown>>(text, 'Alpha Vantage')
  const err = alphaError(j)
  if (err) throw err
  const feed = (j.feed ?? []) as Array<{ title: string; url: string; time_published: string; source: string; summary?: string }>
  return feed.map((f) => {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(f.time_published ?? '')
    return { title: f.title, url: f.url, publishedAt: m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : 0, source: f.source, summary: f.summary }
  })
}

export const finnhubQuoteUrl = (sym: string, key: string): string => `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`
export function parseFinnhubQuote(text: string, symbol: string): Quote {
  const j = json<{ c?: number; pc?: number; o?: number; h?: number; l?: number; t?: number; error?: string }>(text, 'Finnhub')
  if (j.error) throw new ProviderError(`Finnhub: ${j.error}`, 'auth')
  if (!(Number(j.c) > 0)) throw new ProviderError(`Finnhub has no quote for ${symbol}.`, 'not_found')
  return { symbol, price: Number(j.c), asOf: j.t ? j.t * 1000 : Date.now(), prevClose: j.pc || undefined, open: j.o || undefined, high: j.h || undefined, low: j.l || undefined, live: true, source: 'Finnhub' }
}
export const finnhubNewsUrl = (sym: string, from: string, to: string, key: string): string => `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(sym)}&from=${from}&to=${to}&token=${encodeURIComponent(key)}`
export function parseFinnhubNews(text: string): NewsItem[] {
  const j = json<Array<{ headline: string; url: string; datetime: number; source: string; summary?: string }> | { error?: string }>(text, 'Finnhub')
  if (!Array.isArray(j)) throw new ProviderError(`Finnhub: ${j.error ?? 'no news'}`, 'auth')
  return j.map((n) => ({ title: n.headline, url: n.url, publishedAt: n.datetime * 1000, source: n.source, summary: n.summary }))
}
export const polygonNewsUrl = (sym: string, key: string): string => `https://api.polygon.io/v2/reference/news?ticker=${encodeURIComponent(sym)}&limit=20&order=desc&apiKey=${encodeURIComponent(key)}`
export function parsePolygonNews(text: string): NewsItem[] {
  const j = json<{ status?: string; results?: Array<{ title: string; article_url: string; published_utc: string; publisher?: { name?: string }; description?: string }>; error?: string }>(text, 'Polygon')
  if (j.status === 'ERROR' || j.status === 'NOT_AUTHORIZED') throw new ProviderError(`Polygon: ${j.error ?? j.status}`, 'auth')
  return (j.results ?? []).map((n) => ({ title: n.title, url: n.article_url, publishedAt: Date.parse(n.published_utc) || 0, source: n.publisher?.name ?? 'Polygon', summary: n.description }))
}
