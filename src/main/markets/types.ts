// Shared shapes for the markets engine (main process only; the UI contract is StockCardData in
// src/shared/types.ts).

/** One daily bar. t = the session date at 12:00 UTC (so it shows as the same calendar day in any time zone). */
export interface Bar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
}

export interface PriceHistory {
  symbol: string
  bars: Bar[]
  /** Human-readable source, e.g. "Stooq daily closes". */
  source: string
  /** Prices are split-adjusted (true for Stooq, Tiingo adjClose, Polygon adjusted). */
  adjusted: boolean
  /** Served from an older cache entry because every provider failed just now. */
  stale?: boolean
}

export interface Quote {
  symbol: string
  price: number
  /** When the price is from (ms). */
  asOf: number
  prevClose?: number
  open?: number
  high?: number
  low?: number
  volume?: number
  /** True when this is a live/delayed intraday quote; false when it's the last daily close. */
  live: boolean
  source: string
}

export interface NewsItem {
  title: string
  url: string
  publishedAt: number
  source: string
  summary?: string
}

export interface Filing {
  form: string
  filed: string
  reportDate?: string
  description: string
  url: string
}

export interface Fundamentals {
  cik: number
  name: string
  /** Fiscal period end of the latest annual report (YYYY-MM-DD). */
  fiscalYearEnd?: string
  revenueTtm?: number
  revenueFy?: number
  revenueGrowthYoY?: number
  netIncomeTtm?: number
  epsDilutedTtm?: number
  epsDilutedFy?: number
  grossMargin?: number
  operatingMargin?: number
  cash?: number
  totalDebt?: number
  equity?: number
  sharesOutstanding?: number
  operatingCashFlowTtm?: number
  capexTtm?: number
  freeCashFlowTtm?: number
  dividendsPerShareTtm?: number
  /** Latest balance-sheet date used. */
  balanceSheetDate?: string
  /** Which filing the newest numbers came from. */
  latestFiling?: { form: string; filed: string }
}

export type { MarketKeyProvider } from '@shared/types'

export class ProviderError extends Error {
  constructor(message: string, readonly kind: 'blocked' | 'not_found' | 'limit' | 'auth' | 'network' | 'bad_data') {
    super(message)
  }
}
