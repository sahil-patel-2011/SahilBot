// Ticker normalization across sources. Users type "brk.b", "$AAPL", "^GSPC", "SPX", "VOD.L", "EURUSD=X";
// each provider spells them differently:
//   display  BRK.B   ^SPX    VOD.L   EURUSD
//   stooq    brk-b.us ^spx   vod.uk  eurusd
//   sec      BRK-B   (none)  (none)  (none)
//   tiingo   brk-b   (none)  (none)  (none)   polygon / alphavantage / finnhub: BRK.B style

export interface SymbolInfo {
  /** How we show it (upper case, Yahoo-like). */
  display: string
  kind: 'stock' | 'index' | 'fx'
  /** Stooq spelling. */
  stooq: string
  /** SEC company_tickers spelling (US listings only). */
  sec?: string
  /** US-listed: keyed US providers (Tiingo, Polygon, Alpha Vantage, Finnhub) apply. */
  us: boolean
  currency: string
}

/** Index aliases → Stooq index symbols. */
const INDEXES: Record<string, { stooq: string; display: string }> = {
  '^GSPC': { stooq: '^spx', display: '^SPX' }, '^SPX': { stooq: '^spx', display: '^SPX' }, SPX: { stooq: '^spx', display: '^SPX' }, 'S&P500': { stooq: '^spx', display: '^SPX' },
  '^DJI': { stooq: '^dji', display: '^DJI' }, DJI: { stooq: '^dji', display: '^DJI' }, DJIA: { stooq: '^dji', display: '^DJI' },
  '^IXIC': { stooq: '^ndq', display: '^IXIC' }, IXIC: { stooq: '^ndq', display: '^IXIC' }, '^NDQ': { stooq: '^ndq', display: '^IXIC' },
  '^NDX': { stooq: '^ndx', display: '^NDX' }, NDX: { stooq: '^ndx', display: '^NDX' },
  '^RUT': { stooq: '^rut', display: '^RUT' }, '^VIX': { stooq: '^vix', display: '^VIX' }, VIX: { stooq: '^vix', display: '^VIX' },
  '^FTSE': { stooq: '^ftm', display: '^FTSE' }, '^GDAXI': { stooq: '^dax', display: '^GDAXI' }, '^N225': { stooq: '^nkx', display: '^N225' }, '^HSI': { stooq: '^hsi', display: '^HSI' }
}

/** Yahoo-style exchange suffixes → Stooq market suffix and currency. */
const SUFFIX: Record<string, { stooq: string; currency: string }> = {
  L: { stooq: 'uk', currency: 'GBP' }, LN: { stooq: 'uk', currency: 'GBP' }, UK: { stooq: 'uk', currency: 'GBP' },
  DE: { stooq: 'de', currency: 'EUR' }, F: { stooq: 'de', currency: 'EUR' },
  T: { stooq: 'jp', currency: 'JPY' }, JP: { stooq: 'jp', currency: 'JPY' },
  HK: { stooq: 'hk', currency: 'HKD' },
  HU: { stooq: 'hu', currency: 'HUF' }, BD: { stooq: 'hu', currency: 'HUF' },
  WA: { stooq: 'pl', currency: 'PLN' }, PL: { stooq: 'pl', currency: 'PLN' },
  US: { stooq: 'us', currency: 'USD' }
}

const FX = /^([A-Z]{3})([A-Z]{3})(=X)?$/
const CURRENCIES = new Set(['USD', 'EUR', 'JPY', 'GBP', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY', 'HKD', 'SEK', 'NOK', 'DKK', 'PLN', 'HUF', 'MXN', 'INR', 'SGD', 'KRW', 'ZAR', 'TRY', 'BRL'])

/** Normalizes user input to the spellings each source needs; null for something that can't be a ticker. */
export function normalizeSymbol(input: string): SymbolInfo | null {
  let s = input.trim().replace(/^\$/, '').toUpperCase().replace(/\s+/g, '')
  if (!s || s.length > 16 || !/^[A-Z0-9^.\-=&/]+$/.test(s)) return null
  const idx = INDEXES[s]
  if (idx) return { display: idx.display, kind: 'index', stooq: idx.stooq, us: false, currency: idx.stooq.startsWith('^ftm') ? 'GBP' : 'USD' }
  if (s.startsWith('^')) return { display: s, kind: 'index', stooq: s.toLowerCase(), us: false, currency: 'USD' }
  s = s.replace('/', '')
  const fx = FX.exec(s)
  // Six letters that are two different currency codes: an FX pair (EURUSD, USDJPY=X). US tickers are 5 letters at most.
  if (fx && CURRENCIES.has(fx[1]) && CURRENCIES.has(fx[2]) && fx[1] !== fx[2]) {
    return { display: `${fx[1]}${fx[2]}`, kind: 'fx', stooq: `${fx[1]}${fx[2]}`.toLowerCase(), us: false, currency: fx[2] }
  }
  const parts = s.split('.')
  const last = parts[parts.length - 1]
  if (parts.length >= 2 && SUFFIX[last] && last !== 'US') {
    const base = parts.slice(0, -1).join('-')
    return { display: `${parts.slice(0, -1).join('.')}.${last}`, kind: 'stock', stooq: `${base.toLowerCase()}.${SUFFIX[last].stooq}`, us: false, currency: SUFFIX[last].currency }
  }
  const core = (parts.length >= 2 && last === 'US' ? parts.slice(0, -1) : parts).join('.')
  // Share classes: BRK.B, BRK-B, BRK/B all mean the same listing.
  const dash = core.replace(/[.]/g, '-')
  if (!/^[A-Z][A-Z0-9-]{0,9}$/.test(dash)) return null
  return { display: dash.replace(/-/g, '.'), kind: 'stock', stooq: `${dash.toLowerCase()}.us`, sec: dash, us: true, currency: 'USD' }
}
