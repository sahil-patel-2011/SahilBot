import { describe, expect, test } from 'vitest'
import { cleanWatchlist, getWatchlist, setWatchlist } from '../../src/main/watchlist'

describe('stock watchlist store', () => {
  test('keeps well-formed symbols in order, upper-cased, without duplicates', () => {
    const out = cleanWatchlist([
      { symbol: 'msft', name: '  Microsoft  ', price: 410.5, changePct: 1.2, asOf: 1, spark: [1, 2, Number.NaN, 3] },
      { symbol: 'MSFT' },
      { symbol: 'brk.b', currency: 'usd' },
      { symbol: 'not a symbol!' },
      null,
      { symbol: 'AAPL', price: 'x' }
    ])
    expect(out).toEqual([
      { symbol: 'MSFT', name: 'Microsoft', price: 410.5, changePct: 1.2, asOf: 1, spark: [1, 2, 3] },
      { symbol: 'BRK.B', currency: 'USD' },
      { symbol: 'AAPL' }
    ])
    expect(cleanWatchlist('nope')).toEqual([])
  })

  test('saves the cleaned list in settings and reads it back', () => {
    const store = new Map<string, unknown>()
    const db = { getSetting: <T,>(k: string) => store.get(k) as T | undefined, setSetting: (k: string, v: unknown) => void store.set(k, v) }
    expect(getWatchlist(db)).toEqual([])
    expect(setWatchlist(db, [{ symbol: 'nvda', spark: Array.from({ length: 90 }, (_, i) => i) }])).toHaveLength(1)
    const back = getWatchlist(db)
    expect(back[0].symbol).toBe('NVDA')
    expect(back[0].spark).toHaveLength(60)
  })
})
