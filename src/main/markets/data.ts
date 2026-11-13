// The market data service: one place that knows which provider to ask, in what order, with caching,
// polite rate limits and stale-if-error. Everything returned says where it came from and how old it is.

import { DiskCache, TTL } from './cache'
import {
  SEC_TICKERS_URL, alphaDailyUrl, alphaNewsUrl, alphaQuoteUrl, finnhubNewsUrl, finnhubQuoteUrl, parseAlphaDaily, parseAlphaNews, parseAlphaQuote,
  parseCompanyFacts, parseFinnhubNews, parseFinnhubQuote, parsePolygonDaily, parsePolygonNews, parsePolygonSnapshot, parseSecTickers, parseStooqCsv,
  parseSubmissions, parseTiingoDaily, parseTiingoQuote, polygonDailyUrl, polygonNewsUrl, polygonSnapshotUrl, secFactsUrl, secSubmissionsUrl,
  stooqUrl, tiingoDailyUrl, tiingoQuoteUrl, ymd, type Fetcher
} from './providers'
import { normalizeSymbol, type SymbolInfo } from './symbols'
import type { Bar, Filing, Fundamentals, MarketKeyProvider, NewsItem, PriceHistory, Quote } from './types'
import { ProviderError } from './types'

export interface MarketDataConfig {
  /** Keys the user saved in Settings → Markets (missing = not configured). */
  keys: () => Partial<Record<MarketKeyProvider, string>>
  /** Preferred live-quote provider ('auto' = the first one with a key). */
  quoteProvider?: () => 'auto' | 'none' | MarketKeyProvider
  /** User-Agent for SEC EDGAR (their fair-access policy asks for an app name and a contact address). */
  secUserAgent?: () => string
  cacheDir: string | null
  fetch?: Fetcher
  now?: () => number
}

/** Bars kept per symbol (~12 years): enough for 10 years of walk-forward checks plus training. */
const MAX_BARS = 3000
const UA = 'SahilBot/0.1 (desktop assistant; contact@example.com)'
const QUOTE_ORDER: MarketKeyProvider[] = ['finnhub', 'tiingo', 'polygon', 'alphavantage']
const HISTORY_ORDER: MarketKeyProvider[] = ['tiingo', 'polygon', 'alphavantage']
export const PROVIDER_LABEL: Record<MarketKeyProvider | 'stooq' | 'sec', string> = { stooq: 'Stooq', sec: 'SEC EDGAR', tiingo: 'Tiingo', polygon: 'Polygon', alphavantage: 'Alpha Vantage', finnhub: 'Finnhub' }

export class MarketData {
  readonly cache: DiskCache
  private fetcher: Fetcher
  private secNext = 0
  private now: () => number

  constructor(private cfg: MarketDataConfig) {
    this.now = cfg.now ?? Date.now
    this.cache = new DiskCache(cfg.cacheDir, this.now)
    this.fetcher = cfg.fetch ?? ((url, init) => fetch(url, init))
  }

  configured(): MarketKeyProvider[] {
    const k = this.cfg.keys()
    return (Object.keys(k) as MarketKeyProvider[]).filter((p) => !!k[p])
  }

  private async get(url: string, signal?: AbortSignal, headers: Record<string, string> = {}): Promise<string> {
    let res
    try {
      res = await this.fetcher(url, { headers: { 'user-agent': UA, accept: '*/*', ...headers }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) })
    } catch (e) {
      if (signal?.aborted) throw e
      throw new ProviderError(`${new URL(url).host} is unreachable (${(e as Error).name === 'TimeoutError' ? 'timed out' : 'network error'}).`, 'network')
    }
    const body = await res.text()
    if (res.status === 401 || res.status === 403) throw new ProviderError(`${new URL(url).host} refused the request (${res.status}): check the API key in Settings → Markets.`, 'auth')
    if (res.status === 404) throw new ProviderError(`${new URL(url).host} has no data for that symbol.`, 'not_found')
    if (res.status === 429) throw new ProviderError(`${new URL(url).host} rate limit reached; try again in a minute.`, 'limit')
    if (!res.ok) throw new ProviderError(`${new URL(url).host} answered ${res.status}.`, 'network')
    return body
  }

  /** SEC fair access: identify ourselves and stay well under 10 requests a second. */
  private async sec(url: string, signal?: AbortSignal): Promise<unknown> {
    const wait = this.secNext - this.now()
    this.secNext = Math.max(this.now(), this.secNext) + 150
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    const text = await this.get(url, signal, { 'user-agent': this.cfg.secUserAgent?.() || UA, accept: 'application/json' })
    try { return JSON.parse(text) } catch { throw new ProviderError('SEC EDGAR returned something that isn\'t data.', 'bad_data') }
  }

  /** Cached value, fresh fetch, or (when the fetch fails) the stale cached value marked stale. */
  private async cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<{ data: T; stale: boolean; at: number }> {
    const hit = this.cache.get<T>(key, ttl)
    if (hit !== undefined) return { data: hit, stale: false, at: this.cache.getStale<T>(key)!.at }
    try {
      const data = await load()
      this.cache.set(key, data)
      return { data, stale: false, at: this.now() }
    } catch (e) {
      const old = this.cache.getStale<T>(key)
      if (old && !(e instanceof ProviderError && e.kind === 'not_found')) return { data: old.data, stale: true, at: old.at }
      throw e
    }
  }

  symbol(input: string): SymbolInfo {
    const s = normalizeSymbol(input)
    if (!s) throw new ProviderError(`"${input}" doesn't look like a ticker symbol.`, 'not_found')
    return s
  }

  /** Daily bars: Stooq first, then keyed providers for US listings. */
  async daily(input: string, signal?: AbortSignal): Promise<PriceHistory> {
    const s = this.symbol(input)
    const keys = this.cfg.keys()
    const errors: string[] = []
    const r = await this.cached(`daily:${s.stooq}`, TTL.daily, async () => {
      const tries: Array<[string, () => Promise<{ bars: Bar[]; source: string; adjusted: boolean }>]> = [
        ['stooq', async () => ({ bars: parseStooqCsv(await this.get(stooqUrl(s.stooq), signal)), source: 'Stooq daily closes', adjusted: true })]
      ]
      if (s.us) {
        const sym = s.display
        const start = ymd(this.now() - 12 * 365 * 86_400_000)
        for (const p of HISTORY_ORDER) {
          const key = keys[p]
          if (!key) continue
          if (p === 'tiingo') tries.push([p, async () => ({ bars: parseTiingoDaily(await this.get(tiingoDailyUrl(s.sec ?? sym, start, key), signal)), source: 'Tiingo daily closes (adjusted)', adjusted: true })])
          if (p === 'polygon') tries.push([p, async () => ({ bars: parsePolygonDaily(await this.get(polygonDailyUrl(sym, start, ymd(this.now()), key), signal)), source: 'Polygon daily closes (adjusted)', adjusted: true })])
          if (p === 'alphavantage') tries.push([p, async () => {
            let text = await this.get(alphaDailyUrl(sym, true, key), signal)
            // Full history is a paid feature on some plans: fall back to the last 100 days.
            if (/premium/i.test(text)) text = await this.get(alphaDailyUrl(sym, false, key), signal)
            return { bars: parseAlphaDaily(text), source: 'Alpha Vantage daily closes (split-adjusted here)', adjusted: true }
          }])
        }
      }
      for (const [name, run] of tries) {
        try {
          const got = await run()
          if (got.bars.length) return { ...got, bars: got.bars.slice(-MAX_BARS) }
        } catch (e) {
          if (signal?.aborted) throw e
          errors.push(`${PROVIDER_LABEL[name as MarketKeyProvider]}: ${(e as Error).message}`)
        }
      }
      const blocked = errors.some((x) => /verification|bot check/i.test(x))
      const hint = !s.us
        ? ' Indices, currencies and non-US listings come only from Stooq here; for US indices use an ETF that tracks one (SPY for the S&P 500, QQQ for the Nasdaq-100, DIA for the Dow).'
        : this.configured().some((p) => HISTORY_ORDER.includes(p))
        ? ''
        : blocked
          ? ' To fix it, add a free API key in Settings → Markets (Tiingo gives full adjusted history; Polygon or Alpha Vantage also work).'
          : ''
      throw new ProviderError(`No daily price data for ${s.display}. ${errors.join(' ')}${hint}`, errors.every((x) => /no data/i.test(x)) ? 'not_found' : 'network')
    })
    return { symbol: s.display, bars: r.data.bars, source: r.data.source, adjusted: r.data.adjusted, ...(r.stale ? { stale: true } : {}) }
  }

  /** A live (or delayed) quote when a keyed provider is set; otherwise the last daily close, clearly marked. */
  async quote(input: string, signal?: AbortSignal, history?: PriceHistory): Promise<Quote> {
    const s = this.symbol(input)
    const keys = this.cfg.keys()
    const pref = this.cfg.quoteProvider?.() ?? 'auto'
    const order = pref === 'none' ? [] : pref === 'auto' ? QUOTE_ORDER : [pref, ...QUOTE_ORDER.filter((p) => p !== pref)]
    if (s.us) {
      for (const p of order) {
        const key = keys[p]
        if (!key) continue
        try {
          const r = await this.cached(`quote:${p}:${s.display}`, TTL.quote, async () => {
            if (p === 'finnhub') return parseFinnhubQuote(await this.get(finnhubQuoteUrl(s.display, key), signal), s.display)
            if (p === 'tiingo') return parseTiingoQuote(await this.get(tiingoQuoteUrl(s.sec ?? s.display, key), signal), s.display)
            if (p === 'polygon') return parsePolygonSnapshot(await this.get(polygonSnapshotUrl(s.display, key), signal), s.display)
            return parseAlphaQuote(await this.get(alphaQuoteUrl(s.display, key), signal), s.display)
          })
          if (!r.stale) return r.data
        } catch (e) { if (signal?.aborted) throw e }
      }
    }
    const h = history ?? await this.daily(input, signal)
    const last = h.bars[h.bars.length - 1]
    const prev = h.bars[h.bars.length - 2]
    return { symbol: s.display, price: last.c, asOf: last.t, prevClose: prev?.c, open: last.o, high: last.h, low: last.l, volume: last.v, live: false, source: h.source + (h.stale ? ' (cached, sources unreachable)' : '') }
  }

  /** CIK and company name for a US ticker (SEC company_tickers.json), or null (ETFs and funds are often missing). */
  async company(input: string, signal?: AbortSignal): Promise<{ cik: number; name: string } | null> {
    const s = this.symbol(input)
    if (!s.sec) return null
    const r = await this.cached('sec:tickers', TTL.tickers, async () => parseSecTickers(await this.sec(SEC_TICKERS_URL, signal)))
    return r.data[s.sec] ?? r.data[s.sec.replace(/-/g, '.')] ?? null
  }

  /** Ticker lookup by symbol prefix or company name (for the watchlist's add box). */
  async search(query: string, limit = 8, signal?: AbortSignal): Promise<Array<{ symbol: string; name: string }>> {
    const q = query.trim().toUpperCase()
    if (!q) return []
    const r = await this.cached('sec:tickers', TTL.tickers, async () => parseSecTickers(await this.sec(SEC_TICKERS_URL, signal)))
    const rows = Object.entries(r.data)
    const score = ([t, v]: [string, { name: string }]): number => (t === q ? 0 : t.startsWith(q) ? 1 : v.name.toUpperCase().startsWith(q) ? 2 : v.name.toUpperCase().includes(q) ? 3 : 9)
    return rows.map((x) => [x, score(x)] as const).filter(([, s]) => s < 9).sort((a, b) => a[1] - b[1] || a[0][0].length - b[0][0].length).slice(0, limit).map(([[t, v]]) => ({ symbol: t.replace(/-/g, '.'), name: v.name }))
  }

  async fundamentals(input: string, signal?: AbortSignal): Promise<Fundamentals | null> {
    const c = await this.company(input, signal)
    if (!c) return null
    const r = await this.cached(`sec:facts:${c.cik}`, TTL.fundamentals, async () => parseCompanyFacts(await this.sec(secFactsUrl(c.cik), signal)))
    return { ...r.data, name: r.data.name || c.name }
  }

  async filings(input: string, max = 8, signal?: AbortSignal): Promise<{ filings: Filing[]; sic?: string; exchanges?: string[] }> {
    const c = await this.company(input, signal)
    if (!c) return { filings: [] }
    const r = await this.cached(`sec:subs:${c.cik}`, TTL.filings, async () => parseSubmissions(await this.sec(secSubmissionsUrl(c.cik), signal), 20))
    return { filings: r.data.filings.slice(0, max), sic: r.data.sic, exchanges: r.data.exchanges }
  }

  /** Recent headlines from a keyed provider (none without a key). */
  async news(input: string, max = 6, signal?: AbortSignal): Promise<{ items: NewsItem[]; source: string } | null> {
    const s = this.symbol(input)
    const keys = this.cfg.keys()
    if (!s.us) return null
    const to = ymd(this.now())
    const from = ymd(this.now() - 14 * 86_400_000)
    const order: Array<[MarketKeyProvider, () => Promise<NewsItem[]>]> = []
    if (keys.finnhub) order.push(['finnhub', async () => parseFinnhubNews(await this.get(finnhubNewsUrl(s.display, from, to, keys.finnhub!), signal))])
    if (keys.polygon) order.push(['polygon', async () => parsePolygonNews(await this.get(polygonNewsUrl(s.display, keys.polygon!), signal))])
    if (keys.alphavantage) order.push(['alphavantage', async () => parseAlphaNews(await this.get(alphaNewsUrl(s.display, keys.alphavantage!), signal))])
    for (const [p, run] of order) {
      try {
        const r = await this.cached(`news:${p}:${s.display}`, TTL.news, run)
        return { items: r.data.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, max), source: PROVIDER_LABEL[p] }
      } catch (e) { if (signal?.aborted) throw e }
    }
    return null
  }
}
