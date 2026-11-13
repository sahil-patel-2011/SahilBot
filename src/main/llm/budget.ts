import type { Db } from '../db'
import { claudeSpec } from './claude-models'

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

export function priceFor(model: string, inputTokens = 0): { input: number; output: number; known: boolean; cacheRead?: number } {
  const spec = claudeSpec(model)
  if (spec?.price) {
    // Haiku 5.5 is $0.50 / $2.50 above 100K prompt tokens.
    if (spec.id === 'claude-haiku-5-5' && inputTokens > 100_000) return { input: 0.5, output: 2.5, known: true }
    return { input: spec.price.input, output: spec.price.output, known: true, cacheRead: spec.price.cacheRead }
  }
  const hit = OTHER_PRICES.find(([re]) => re.test(model))
  if (!hit) return { input: UNKNOWN[0], output: UNKNOWN[1], known: false }
  return { input: hit[1], output: hit[2], known: true }
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
