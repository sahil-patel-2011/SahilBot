import type { Db } from '../db'
import { CACHE_WRITE_FACTOR, claudeInfo } from './claude-models'

// Cloud spending guard. Every request to a paid (non-local) endpoint is priced before it is
// sent, using the worst case (full max_tokens of output), and refused if it could push this
// month's total past the cap. Actual usage is recorded after each request.

/**
 * $ per 1M tokens, from the Claude model table (claude-models.ts: Anthropic first-party rates, cached
 * 2026-10-06). Other paid models are listed here.
 */
const OTHER_PRICES: Array<[RegExp, number, number]> = []
/** Unknown paid models are priced pessimistically (the most expensive tier) so the cap still holds. */
const UNKNOWN: [number, number] = [10, 50]

export function priceFor(model: string, inputTokens = 0): { input: number; output: number; known: boolean; cacheRead?: number; estimated?: boolean } {
  const spec = claudeInfo(model)
  if (spec?.price) {
    // Long-context rate card (Haiku 5.5: $0.50 / $2.50 above 100K prompt tokens; cache reads stay 0.1x of it).
    const lc = spec.longContext
    if (lc && inputTokens > lc.above) return { input: lc.input, output: lc.output, known: true, cacheRead: lc.input * 0.1 }
    // A model newer than the table: the family's highest known prices, flagged as an estimate.
    if (spec.estimated) return { input: spec.price.input, output: spec.price.output, known: false, estimated: true, cacheRead: spec.price.cacheRead }
    return { input: spec.price.input, output: spec.price.output, known: true, cacheRead: spec.price.cacheRead }
  }
  const hit = OTHER_PRICES.find(([re]) => re.test(model))
  if (!hit) return { input: UNKNOWN[0], output: UNKNOWN[1], known: false, estimated: true }
  return { input: hit[1], output: hit[2], known: true }
}

/**
 * What the next request of a running chat costs, roughly, at its current context size: the prompt read
 * from the cache (Claude caches the stable prefix and the history), the newest few thousand tokens written
 * to it, and a typical reply. For the progress chip; the budget still prices the worst case.
 */
export function stepCost(model: string, contextTokens: number, o: { fresh?: number; reply?: number } = {}): { usd: number; estimated: boolean } {
  const fresh = Math.min(contextTokens, o.fresh ?? 4000)
  const reply = o.reply ?? 2000
  const p = priceFor(model, contextTokens)
  const read = p.cacheRead ?? p.input * 0.1
  const usd = ((contextTokens - fresh) * read + fresh * p.input * CACHE_WRITE_FACTOR + reply * p.output) / 1e6
  return { usd, estimated: !p.known }
}

export const cost = (model: string, input: number, output: number): number => {
  const p = priceFor(model, input)
  return (input * p.input + output * p.output) / 1e6
}

const month = (d = new Date()): string => d.toISOString().slice(0, 7)

export class Budget {
  constructor(private db: Db, private cap: () => number) {
    db.sql.exec(`CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, month TEXT NOT NULL, host TEXT NOT NULL, model TEXT NOT NULL,
      input INTEGER NOT NULL, output INTEGER NOT NULL, usd REAL NOT NULL, at INTEGER NOT NULL)`)
  }

  spent(m = month()): number {
    return (this.db.sql.prepare('SELECT COALESCE(SUM(usd), 0) AS s FROM usage WHERE month = ?').get(m) as { s: number }).s
  }

  /** Throws before a request that could exceed the monthly cap. */
  check(model: string, estimatedInput: number, maxOutput: number): void {
    const cap = this.cap()
    const spent = this.spent()
    const worst = cost(model, estimatedInput, maxOutput)
    if (spent + worst > cap) {
      throw new Error(`Cloud budget reached: $${spent.toFixed(2)} of your $${cap.toFixed(2)} monthly cap is used, and this request could cost up to $${worst.toFixed(2)}. Nothing was sent. Switch to a local model, or change the cap in Settings > Cloud budget.`)
    }
  }

  /** spaceId: the bot whose run made the request (null when it wasn't made for a bot). */
  record(host: string, model: string, input: number, output: number, spaceId: string | null = null): number {
    const usd = cost(model, input, output)
    this.db.sql.prepare('INSERT INTO usage(month, host, model, input, output, usd, at, space_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(month(), host, model, input, output, usd, Date.now(), spaceId)
    return usd
  }

  summary(): { month: string; spent: number; cap: number; requests: number } {
    const m = month()
    const n = (this.db.sql.prepare('SELECT COUNT(*) AS n FROM usage WHERE month = ?').get(m) as { n: number }).n
    return { month: m, spent: this.spent(m), cap: this.cap(), requests: n }
  }
}
