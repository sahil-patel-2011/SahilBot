import type { Effort } from '@shared/types'

// What SahilBot knows about each Claude model: context window, output cap, first-party prices, and
// which thinking/effort settings the API accepts. Facts come from the bundled Claude API reference
// (claude-api skill: SKILL.md "Current Models" + "Thinking & Effort" tables, shared/models.md,
// shared/prompt-caching.md "Economics", cached 2026-10-06). Values the reference doesn't give are left
// undefined (TODO) rather than guessed: the budget then prices that model pessimistically.

export type ClaudeFamily = 'fable' | 'mythos' | 'opus' | 'sonnet' | 'haiku'

export interface ClaudeSpec {
  /** Alias, as the API lists it (dated snapshots match by prefix). */
  id: string
  family: ClaudeFamily
  /** Context window in tokens (TODO when undefined: not in the reference). */
  contextTokens?: number
  /** Largest max_tokens the model accepts. */
  maxOutput?: number
  /** $ per 1M tokens. cacheRead when the reference gives it; otherwise ~0.1x input (shared/prompt-caching.md). */
  price?: { input: number; output: number; cacheRead?: number }
  /** How the API takes thinking: adaptive (4.6+ and 5.x) or not sent at all (older models need budget_tokens; SahilBot leaves thinking off there). */
  thinking: 'adaptive' | 'none'
  /** output_config.effort values the model accepts ([] = the parameter is rejected). */
  efforts: Effort[]
  /** The API's default effort when none is sent. */
  defaultEffort?: Effort
  /** The newest model of its family (on by default in the picker). Older ones are listed but start off. */
  current?: boolean
}

const ALL: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const NO_XHIGH: Effort[] = ['low', 'medium', 'high', 'max']
const M = 1_000_000
const K128 = 128_000

/** Most specific first: lookups match the first id that prefixes the model name. */
export const CLAUDE: ClaudeSpec[] = [
  { id: 'claude-fable-5-1', family: 'fable', contextTokens: M, maxOutput: K128, price: { input: 10, output: 50, cacheRead: 0.25 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high', current: true },
  { id: 'claude-mythos-5-1', family: 'mythos', contextTokens: M, maxOutput: K128, price: { input: 10, output: 50, cacheRead: 0.25 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high', current: true },
  { id: 'claude-fable-5', family: 'fable', contextTokens: M, maxOutput: K128, price: { input: 10, output: 50, cacheRead: 1 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high' },
  { id: 'claude-mythos-5', family: 'mythos', contextTokens: M, maxOutput: K128, price: { input: 10, output: 50, cacheRead: 1 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high' },
  { id: 'claude-opus-5-5', family: 'opus', contextTokens: M, maxOutput: K128, price: { input: 4, output: 20, cacheRead: 0.2 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'medium', current: true },
  { id: 'claude-opus-5', family: 'opus', contextTokens: M, maxOutput: K128, price: { input: 5, output: 25 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high' },
  { id: 'claude-opus-4-8', family: 'opus', contextTokens: M, maxOutput: K128, price: { input: 5, output: 25 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high' },
  { id: 'claude-opus-4-7', family: 'opus', contextTokens: M, maxOutput: K128, price: { input: 5, output: 25 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high' },
  { id: 'claude-opus-4-6', family: 'opus', contextTokens: M, maxOutput: K128, price: { input: 5, output: 25 }, thinking: 'adaptive', efforts: NO_XHIGH, defaultEffort: 'high' },
  // TODO: context, output cap and prices for these legacy models aren't in the reference.
  { id: 'claude-opus-4-5', family: 'opus', thinking: 'none', efforts: ['low', 'medium', 'high'] },
  { id: 'claude-opus-4-1', family: 'opus', thinking: 'none', efforts: [] },
  // Opus 4 / 4.0 and its dated id claude-opus-4-20250514 (after every newer claude-opus-4-x above).
  { id: 'claude-opus-4', family: 'opus', thinking: 'none', efforts: [] },
  { id: 'claude-sonnet-5-5', family: 'sonnet', contextTokens: M, maxOutput: K128, price: { input: 2, output: 10, cacheRead: 0.2 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high', current: true },
  { id: 'claude-sonnet-5', family: 'sonnet', contextTokens: M, maxOutput: K128, price: { input: 2, output: 10 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high' },
  { id: 'claude-sonnet-4-6', family: 'sonnet', contextTokens: M, maxOutput: K128, price: { input: 3, output: 15 }, thinking: 'adaptive', efforts: NO_XHIGH, defaultEffort: 'high' },
  { id: 'claude-sonnet-4-5', family: 'sonnet', thinking: 'none', efforts: [] },
  { id: 'claude-sonnet-4', family: 'sonnet', thinking: 'none', efforts: [] },
  // Haiku 5.5: $0.10 / $0.50 up to 100K prompt tokens, $0.50 / $2.50 above (see priceFor in budget.ts).
  { id: 'claude-haiku-5-5', family: 'haiku', contextTokens: M, maxOutput: K128, price: { input: 0.1, output: 0.5 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'medium', current: true },
  { id: 'claude-haiku-4-5', family: 'haiku', contextTokens: 200_000, maxOutput: 64_000, price: { input: 1, output: 5 }, thinking: 'none', efforts: [] },
  { id: 'claude-3', family: 'haiku', thinking: 'none', efforts: [] }
]

/** The spec for a model id (dated snapshots and suffixes match their alias). */
export function claudeSpec(model: string): ClaudeSpec | undefined {
  const id = model.toLowerCase()
  return CLAUDE.find((c) => id === c.id || id.startsWith(`${c.id}-`) || (c.id === 'claude-3' && id.startsWith('claude-3')))
}

export function claudeFamily(model: string): ClaudeFamily | undefined {
  const m = model.toLowerCase().match(/^claude-(fable|mythos|opus|sonnet|haiku)\b/)
  return m ? (m[1] as ClaudeFamily) : undefined
}

/**
 * A Claude model SahilBot hasn't been told about (newer than this table): assumed to work like the
 * current generation (adaptive thinking, all five effort levels), since every model since 4.6 does.
 */
const FUTURE: Omit<ClaudeSpec, 'id' | 'family'> = { thinking: 'adaptive', efforts: ALL }

/** Premium tier: priced above Opus, so Auto and the hybrid advisor use it only when picked by name. */
export const isPremiumClaude = (model: string): boolean => /^claude-(fable|mythos)/i.test(model)

const LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * The app's thinking level (Low, Medium, High, Extra, Max) for this model: the level itself when the
 * model accepts it, else the nearest accepted level below it (Extra on Opus/Sonnet 4.6 → High), else
 * the lowest above. undefined: the model takes no effort parameter (Haiku 4.5, Sonnet 4.5, older).
 */
export function claudeEffort(model: string, effort: Effort = 'medium'): Effort | undefined {
  const ok = (claudeSpec(model) ?? (/^claude-/i.test(model) ? { ...FUTURE } : undefined))?.efforts
  if (!ok?.length) return undefined
  if (ok.includes(effort)) return effort
  const i = LEVELS.indexOf(effort)
  for (let j = i - 1; j >= 0; j--) if (ok.includes(LEVELS[j])) return LEVELS[j]
  return LEVELS.slice(i + 1).find((l) => ok.includes(l))
}

/**
 * Thinking parameters for a request. Adaptive models: adaptive thinking with readable summaries, plus
 * output_config.effort sent explicitly (Opus 5.5 and Haiku 5.5 default to medium, the rest to high, so
 * the app's choice always wins). Opus 4.5: effort only. Older models: nothing (they'd need
 * budget_tokens, and a switched-in model's history has no thinking blocks to continue a tool turn).
 */
export function claudeThinking(model: string, effort?: Effort): { thinking?: { type: 'adaptive'; display: 'summarized' }; output_config?: { effort: Effort } } {
  const spec = claudeSpec(model) ?? (/^claude-/i.test(model) ? { id: model, family: 'opus' as const, ...FUTURE } : undefined)
  if (!spec) return {}
  const e = claudeEffort(model, effort ?? 'medium')
  return {
    ...(spec.thinking === 'adaptive' ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
    ...(e ? { output_config: { effort: e } } : {})
  }
}

/** Cache reads as a fraction of the input price: 0.025x Fable/Mythos 5.1, 0.05x Opus 5.5, ~0.1x elsewhere. */
export function cacheReadFactor(model: string): number {
  const p = claudeSpec(model)?.price
  return p?.cacheRead !== undefined ? p.cacheRead / p.input : 0.1
}

/** Cache writes (5-minute TTL) cost 1.25x input on every model (shared/prompt-caching.md). */
export const CACHE_WRITE_FACTOR = 1.25

/** "1M" / "200K" for the Models page. */
export function formatTokens(n: number): string {
  return n >= M ? `${n / M}M` : `${Math.round(n / 1000)}K`
}
