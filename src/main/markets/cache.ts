// On-disk JSON cache for market data (userData/markets-cache). Each entry remembers when it was saved;
// callers pass the time-to-live that fits the data (quotes: a minute, daily bars: hours, filings: hours,
// the SEC ticker list: a week). Expired entries are kept so they can be served, clearly marked stale,
// when every provider is down.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const TTL = {
  quote: 60_000,
  daily: 4 * 3_600_000,
  fundamentals: 24 * 3_600_000,
  filings: 6 * 3_600_000,
  news: 30 * 60_000,
  tickers: 7 * 24 * 3_600_000
} as const

export class DiskCache {
  private mem = new Map<string, { at: number; data: unknown }>()

  constructor(private dir: string | null, private now = () => Date.now()) {
    if (dir) mkdirSync(dir, { recursive: true })
  }

  private file(key: string): string | null {
    if (!this.dir) return null
    const safe = key.replace(/[^\w.^-]+/g, '_').slice(0, 80)
    return join(this.dir, `${safe}-${createHash('sha1').update(key).digest('hex').slice(0, 8)}.json`)
  }

  private read(key: string): { at: number; data: unknown } | undefined {
    const m = this.mem.get(key)
    if (m) return m
    const f = this.file(key)
    if (!f || !existsSync(f)) return undefined
    try {
      const e = JSON.parse(readFileSync(f, 'utf8')) as { at: number; data: unknown }
      if (typeof e?.at !== 'number') return undefined
      this.mem.set(key, e)
      return e
    } catch { return undefined }
  }

  /** The cached value when younger than ttl, else undefined. */
  get<T>(key: string, ttl: number): T | undefined {
    const e = this.read(key)
    return e && this.now() - e.at <= ttl ? (e.data as T) : undefined
  }

  /** Any cached value, however old, with its age (for stale-if-error). */
  getStale<T>(key: string): { data: T; at: number } | undefined {
    const e = this.read(key)
    return e ? { data: e.data as T, at: e.at } : undefined
  }

  set(key: string, data: unknown): void {
    const e = { at: this.now(), data }
    this.mem.set(key, e)
    if (this.mem.size > 300) this.mem.delete(this.mem.keys().next().value!)
    const f = this.file(key)
    if (!f) return
    try {
      const tmp = `${f}.tmp`
      writeFileSync(tmp, JSON.stringify(e))
      renameSync(tmp, f)
    } catch { /* a cache write is never worth failing the request */ }
  }
}
