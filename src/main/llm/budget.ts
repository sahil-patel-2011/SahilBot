import type { Settings, SpendingMode } from '@shared/types'
import type { Db } from '../db'
import { CACHE_WRITE_FACTOR, claudeInfo } from './claude-models'
import { openaiInfo, writeFactors } from './openai-models'
import { isPlanModel } from './codex/ids'
import { xaiInfo, xaiRates } from './xai-models'
import { currentFastTier, fastFactor } from './fast-mode'

// Cloud spending guard. Every request to a paid (non-local) endpoint is priced before it is
// sent, using the worst case (full max_tokens of output), and refused if it could push this
// month's total past the cap. Actual usage is recorded after each request.
// The limit is monthly only, in one of three modes (spendingMode): a specific amount, Unlimited (no cap; spend
// is still recorded and shown), or None (pay-per-use API spending off: only the ChatGPT plan via Codex and local
// models run). Fast mode requests are priced at their tier's multiplier (fast-mode.ts), worst case and actual.

/**
 * $ per 1M tokens, from the Claude model table (claude-models.ts: Anthropic first-party rates, cached
 * 2026-10-06) and the OpenAI model table (openai-models.ts: pricing.md, read 2026-11-15). Other paid
 * models are listed here.
 */
const OTHER_PRICES: Array<[RegExp, number, number]> = []
/** Unknown paid models are priced pessimistically (the most expensive tier) so the cap still holds. */
const UNKNOWN: [number, number] = [10, 50]

export function priceFor(model: string, inputTokens = 0): { input: number; output: number; known: boolean; cacheRead?: number; estimated?: boolean } {
  // The user's ChatGPT plan (via Codex): covered by their subscription, recorded at $0 (host "chatgpt-plan").
  if (isPlanModel(model)) return { input: 0, output: 0, cacheRead: 0, known: true }
  const spec = claudeInfo(model)
  if (spec?.price) {
    // Long-context rate card (Haiku 5.5: $0.50 / $2.50 above 100K prompt tokens; cache reads stay 0.1x of it).
    const lc = spec.longContext
    if (lc && inputTokens > lc.above) return { input: lc.input, output: lc.output, known: true, cacheRead: lc.input * 0.1 }
    // A model newer than the table: the family's highest known prices, flagged as an estimate.
    if (spec.estimated) return { input: spec.price.input, output: spec.price.output, known: false, estimated: true, cacheRead: spec.price.cacheRead }
    return { input: spec.price.input, output: spec.price.output, known: true, cacheRead: spec.price.cacheRead }
  }
  // OpenAI (openai-models.ts: pricing.md Standard rates). Above 272K prompt tokens the whole request is billed
  // at 2x input and cache rates and 1.5x output; a GPT id newer than the table is the role's highest, estimated.
  const o = openaiInfo(model)
  if (o) {
    const lc = o.longContext && inputTokens > o.longContext.above ? o.longContext : undefined
    const fi = lc?.input ?? 1
    const fo = lc?.output ?? 1
    return { input: o.price.input * fi, output: o.price.output * fo, cacheRead: o.price.cacheRead * fi, known: !o.estimated, ...(o.estimated ? { estimated: true } : {}) }
  }
  // xAI (xai-models.ts: docs.x.ai pricing). From 200K prompt tokens every token of the request is billed at
  // the long-context rates; a grok id newer than the table gets the highest known rates, estimated.
  const x = xaiInfo(model)
  if (x) {
    const r = xaiRates(model, inputTokens)!
    return { input: r.input, output: r.output, cacheRead: r.cacheRead, known: !x.estimated, ...(x.estimated ? { estimated: true } : {}) }
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
export function stepCost(model: string, contextTokens: number, o: { fresh?: number; reply?: number; fast?: import('@shared/types').FastTier | null } = {}): { usd: number; estimated: boolean; fast?: import('@shared/types').FastTier } {
  const fresh = Math.min(contextTokens, o.fresh ?? 4000)
  const reply = o.reply ?? 2000
  const p = priceFor(model, contextTokens)
  const read = p.cacheRead ?? p.input * 0.1
  // OpenAI: 30-minute cache writes cost 1.25x on GPT-5.6+ and nothing extra before (openai-models.ts); xAI
  // documents no cache-write charge.
  const write = openaiInfo(model) ? writeFactors(model).m30 : xaiInfo(model) ? 1 : CACHE_WRITE_FACTOR
  // Fast mode: the chat's tier now (the same rule the client applies), at its multiplier.
  const fast = o.fast === undefined ? currentFastTier(model) : o.fast ?? undefined
  const f = fastFactor(model, fast)
  const usd = f * ((contextTokens - fresh) * read + fresh * p.input * write + reply * p.output) / 1e6
  return { usd, estimated: !p.known, ...(fast && f > 1 ? { fast } : {}) }
}

/** Prompt size above which a model bills the whole request at long-context rates (undefined: no such rule). */
export function longContextAbove(model: string): number | undefined {
  // xAI's tier starts when the prompt *reaches* 200K, i.e. above 199,999.
  const x = xaiInfo(model)
  return claudeInfo(model)?.longContext?.above ?? openaiInfo(model)?.longContext?.above ?? (x ? x.longContext.atLeast - 1 : undefined)
}

/**
 * The tokens to record for one request so that cost() charges what it really cost. `input` is billing-
 * equivalent input (cache reads and writes weighted against the standard input rate), which can sit far
 * below the real prompt: a 300K-token prompt that is mostly cached is still a long-context request (Claude
 * Haiku 5.5 above 100K, OpenAI above 272K), so the tier comes from `prompt`, the real prompt size (input
 * + cache reads + cache writes). When cost() would pick another tier for `input` than the prompt paid, the
 * same dollars are expressed at the standard tier: input up to the threshold, the rest carried as output.
 * extraUsd: tool fees (web search) on top.
 */
export function tierTokens(model: string, prompt: number, input: number, output: number, extraUsd = 0): { promptTokens: number; completionTokens: number } {
  const above = longContextAbove(model)
  const paid = priceFor(model, prompt)
  const usd = (input * paid.input + output * paid.output) / 1e6 + extraUsd
  const asIs = { promptTokens: Math.round(input), completionTokens: Math.round(output) }
  if (above === undefined && !extraUsd) return asIs
  if (Math.abs(cost(model, asIs.promptTokens, asIs.completionTokens) - usd) <= 1e-9 + usd * 1e-6) return asIs
  // Same tier as paid, with the fee folded into input (long tier: input above the threshold keeps the tier).
  const recordTier = (i: number): boolean => above === undefined || (i > above) === (prompt > above)
  const withFee = Math.round(input + (extraUsd * 1e6) / paid.input)
  if (recordTier(withFee)) return { promptTokens: withFee, completionTokens: asIs.completionTokens }
  // Otherwise the standard tier: input up to the threshold, the rest of the dollars as output tokens.
  const std = priceFor(model, 0)
  const i = Math.max(0, Math.min(Math.round((input * paid.input + extraUsd * 1e6) / std.input), above ?? Infinity))
  return { promptTokens: i, completionTokens: Math.max(0, Math.round((usd * 1e6 - i * std.input) / std.output)) }
}

export const cost = (model: string, input: number, output: number): number => {
  const p = priceFor(model, input)
  return (input * p.input + output * p.output) / 1e6
}

export const month = (d = new Date()): string => d.toISOString().slice(0, 7)

/**
 * The monthly limit's mode. Saved settings from before the modes had only cloudBudgetUsd: a positive cap is
 * 'amount', $0 is 'none' ($0 always refused every cloud request, which is what None means now).
 */
export function spendingMode(s: Pick<Settings, 'cloudBudgetUsd'> & { spendingMode?: SpendingMode }): SpendingMode {
  const m = s.spendingMode
  if (m === 'amount' || m === 'unlimited' || m === 'none') return m
  // Unknown (a partial settings object): a specific amount, as before the modes.
  return typeof s.cloudBudgetUsd === 'number' && s.cloudBudgetUsd <= 0 ? 'none' : 'amount'
}

/** The dollars still allowed this month: Infinity when unlimited, 0 when None. */
export function budgetLeftFor(mode: SpendingMode, cap: number, spent: number): number {
  return mode === 'unlimited' ? Infinity : mode === 'none' ? 0 : Math.max(0, cap - spent)
}

export const NONE_MESSAGE = 'Pay-per-use API spending is turned off (Settings → Models & Keys → Monthly spending limit: None), so nothing was sent. Only your ChatGPT plan (via Codex) and local models can run. Connect the ChatGPT plan in Settings → Models, start a local model, or set a monthly limit.'

/** One request's token detail for the usage table (the providers' own counts). */
export interface RecordDetail {
  provider?: string
  /** Real prompt tokens (input + cache reads + writes). */
  prompt?: number
  cached?: number
  cacheWrite?: number
  /** Output as billed (visible + reasoning). */
  output?: number
  reasoning?: number
  tier?: 'fast' | 'ultrafast' | 'standard'
  webCalls?: number
}

export class Budget {
  /** mode: the monthly limit's mode (spendingMode); a specific amount when not given. */
  constructor(private db: Db, private cap: () => number, private mode: () => SpendingMode = () => 'amount') {
    // The usage table and its detail columns are made by Db (db.ts ensureUsageColumns, idempotent).

  }

  spent(m = month()): number {
    return (this.db.sql.prepare('SELECT COALESCE(SUM(usd), 0) AS s FROM usage WHERE month = ?').get(m) as { s: number }).s
  }

  /** Throws before a request that could exceed the monthly cap (or any paid request when the limit is None). */
  check(model: string, estimatedInput: number, maxOutput: number): void {
    const mode = this.mode()
    // The ChatGPT plan is covered by the user's subscription: never blocked by the API spending limit.
    if (isPlanModel(model)) return
    if (mode === 'none') throw Object.assign(new Error(NONE_MESSAGE), { billed: false, status: 402 })
    if (mode === 'unlimited') return
    const cap = this.cap()
    const spent = this.spent()
    const worst = cost(model, estimatedInput, maxOutput)
    if (spent + worst > cap) {
      throw new Error(`Cloud budget reached: $${spent.toFixed(2)} of your $${cap.toFixed(2)} monthly cap is used, and this request could cost up to $${worst.toFixed(2)}. Nothing was sent. Switch to a local model, or change the limit in Settings → Models & Keys → Monthly spending limit.`)
    }
  }

  /** spaceId: the bot whose run made the request (null when it wasn't made for a bot). */
  /**
   * input / output are billing-equivalent tokens (what cost() prices; fast mode's premium is folded in by the
   * client); d is the providers' own detail for the dashboard. at: for tests and imports (default now).
   */
  record(host: string, model: string, input: number, output: number, spaceId: string | null = null, d: RecordDetail = {}, at = Date.now()): number {
    const usd = cost(model, input, output)
    const n = (v: number | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null)
    this.db.sql.prepare('INSERT INTO usage(month, host, model, input, output, usd, at, space_id, provider, prompt, cached, cache_write, out_tokens, reasoning, tier, web_calls) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(month(new Date(at)), host, model, input, output, usd, at, spaceId, d.provider ?? null, n(d.prompt), n(d.cached) ?? 0, n(d.cacheWrite) ?? 0, n(d.output), n(d.reasoning) ?? 0, d.tier && d.tier !== 'standard' ? d.tier : null, n(d.webCalls) ?? 0)
    return usd
  }

  summary(): { month: string; spent: number; cap: number; requests: number; mode: SpendingMode } {
    const m = month()
    const n = (this.db.sql.prepare('SELECT COUNT(*) AS n FROM usage WHERE month = ?').get(m) as { n: number }).n
    return { month: m, spent: this.spent(m), cap: this.cap(), requests: n, mode: this.mode() }
  }

  /** Dollars still allowed this month (Infinity: unlimited; 0: None). */
  left(): number {
    return budgetLeftFor(this.mode(), this.cap(), this.spent())
  }

  /** Every recorded request, every month: spend and requests since the first one (lifetime survives month rollovers). */
  lifetime(): { usd: number; requests: number; since: number | null } {
    const r = this.db.sql.prepare('SELECT COALESCE(SUM(usd), 0) AS usd, COUNT(*) AS n, MIN(at) AS since FROM usage').get() as { usd: number; n: number; since: number | null }
    return { usd: r.usd, requests: r.n, since: r.since ?? null }
  }
}
