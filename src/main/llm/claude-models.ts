import type { Effort, Settings } from '@shared/types'

// What SahilBot knows about each Claude model: context window, output cap, first-party prices, and
// which thinking/effort settings the API accepts. Facts come from the bundled Claude API reference
// (claude-api skill: shared/models.md "Current Models", shared/model-migration.md per-model sections,
// shared/prompt-caching.md "Economics" + minimum cacheable prefix, shared/tool-use-concepts.md server
// tools / computer use / bash / text editor, shared/platform-availability.md). Values the reference
// doesn't give are left undefined rather than guessed: the budget then prices that model pessimistically.
// A Claude id newer than this table (claude-fable-5-2 is not in the bundled reference and wasn't listed
// by /v1/models when this was written) gets family-inferred capabilities and the family's highest known
// prices, marked estimated (claudeInfo), until it is added here.

export type ClaudeFamily = 'fable' | 'mythos' | 'opus' | 'sonnet' | 'haiku'

/**
 * Computer use on the Claude API (shared/tool-use-concepts.md § Computer Use, shared/model-migration.md
 * breaking change 4): 'toolset' = computer_toolset_20260801 (GA, no beta header, member tool calls);
 * the earlier beta tools take display sizes and actions in input.action.
 */
export type ComputerTool = 'toolset' | 'computer_20251124' | 'computer_20250124'

/** How much of a Claude model's window a chat may use before it is compacted (Settings → Models). */
export type ContextStrategy = 'max' | 'balanced' | 'economy'

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
  /** Long-context rate card: above `above` prompt tokens these rates apply (Claude Haiku 5.5). */
  longContext?: { above: number; input: number; output: number }
  /** Native computer-use tool the model takes on the Claude API (undefined: none documented). */
  computer?: ComputerTool
  /** Server web search / web fetch versions (dynamic filtering on the _20260209+ versions). */
  web?: { search: string; fetch: string }
  /** Threshold compaction (context_management compact_20260112, beta compact-2026-01-12). */
  compaction?: boolean
  /** Preserved thinking (the history-editing check): requests carry block_binding drop_block. */
  preservedThinking?: boolean
  /** Server-side refusal fallback (fallbacks: "default", beta server-side-fallback-2026-07-01). */
  fallback?: boolean
  /** Minimum cacheable prompt in tokens (shared/prompt-caching.md). */
  minCache?: number
  /** Facts inferred from the family (a model newer than this table): prices are the family's highest. */
  estimated?: boolean
}

const ALL: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const NO_XHIGH: Effort[] = ['low', 'medium', 'high', 'max']
const M = 1_000_000
const K128 = 128_000

/** Server tools with dynamic filtering (tool-use-concepts.md § Web Search and Web Fetch). */
const WEB_DYNAMIC = { search: 'web_search_20260209', fetch: 'web_fetch_20260209' }
/** Basic versions, for models the dynamic-filtering list doesn't name (web_search_20250305 / web_fetch_20250910). */
const WEB_BASIC = { search: 'web_search_20250305', fetch: 'web_fetch_20250910' }

/** Most specific first: lookups match the first id that prefixes the model name (dated snapshots only). */
export const CLAUDE: ClaudeSpec[] = [
  // Fable 5.1: $10/$50, cache reads $0.25 (0.025x); computer use via computer_20251124 (its documented tool
  // surface); web fetch web_fetch_20260318 (dynamic filtering) per the Fable 5.1 tool surface.
  // Fable 5.2 (2026-11-09): $8 / $40 from Anthropic's pricing (docs/model-routing.md [A1]); cache reads at the
  // standard 0.1x. Capabilities as the current generation (computer toolset, dynamic web tools, compaction).
  { id: 'claude-fable-5-2', family: 'fable', contextTokens: M, maxOutput: K128, price: { input: 8, output: 40, cacheRead: 0.8 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high', current: true, computer: 'toolset', web: WEB_DYNAMIC, compaction: true, preservedThinking: true, minCache: 512 },
  { id: 'claude-fable-5-1', family: 'fable', contextTokens: M, maxOutput: K128, price: { input: 10, output: 50, cacheRead: 0.25 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high', computer: 'computer_20251124', web: { search: 'web_search_20260209', fetch: 'web_fetch_20260318' }, compaction: true, preservedThinking: true, fallback: true, minCache: 512 },
  { id: 'claude-mythos-5-1', family: 'mythos', contextTokens: M, maxOutput: K128, price: { input: 10, output: 50, cacheRead: 0.25 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high', current: true, computer: 'computer_20251124', web: { search: 'web_search_20260209', fetch: 'web_fetch_20260318' }, compaction: true, preservedThinking: true, minCache: 512 },
  { id: 'claude-fable-5', family: 'fable', contextTokens: M, maxOutput: K128, price: { input: 10, output: 50, cacheRead: 1 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high', computer: 'computer_20251124', web: WEB_DYNAMIC, compaction: true, minCache: 512 },
  { id: 'claude-mythos-5', family: 'mythos', contextTokens: M, maxOutput: K128, price: { input: 10, output: 50, cacheRead: 1 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high', computer: 'computer_20251124', web: WEB_DYNAMIC, compaction: true, minCache: 512 },
  // Opus 5.5: $4/$20, cache reads $0.20 (0.05x); default effort medium; computer use only through the toolset.
  { id: 'claude-opus-5-5', family: 'opus', contextTokens: M, maxOutput: K128, price: { input: 4, output: 20, cacheRead: 0.2 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'medium', current: true, computer: 'toolset', web: WEB_DYNAMIC, compaction: true, preservedThinking: true, fallback: true, minCache: 512 },
  // Opus 5 accepts both computer forms (model-migration.md: "test them on Claude Opus 5, which accepts both").
  { id: 'claude-opus-5', family: 'opus', contextTokens: M, maxOutput: K128, price: { input: 5, output: 25 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high', computer: 'toolset', web: WEB_DYNAMIC, compaction: true, fallback: true, minCache: 512 },
  { id: 'claude-opus-4-8', family: 'opus', contextTokens: M, maxOutput: K128, price: { input: 5, output: 25 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high', computer: 'computer_20251124', web: WEB_DYNAMIC, compaction: true, minCache: 1024 },
  { id: 'claude-opus-4-7', family: 'opus', contextTokens: M, maxOutput: K128, price: { input: 5, output: 25 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high', computer: 'computer_20251124', web: WEB_DYNAMIC, compaction: true, minCache: 2048 },
  { id: 'claude-opus-4-6', family: 'opus', contextTokens: M, maxOutput: K128, price: { input: 5, output: 25 }, thinking: 'adaptive', efforts: NO_XHIGH, defaultEffort: 'high', computer: 'computer_20251124', web: WEB_DYNAMIC, compaction: true, minCache: 4096 },
  // Context, output cap and prices for these legacy models aren't in the reference.
  { id: 'claude-opus-4-5', family: 'opus', thinking: 'none', efforts: ['low', 'medium', 'high'], minCache: 4096 },
  { id: 'claude-opus-4-1', family: 'opus', thinking: 'none', efforts: [], minCache: 1024 },
  // Opus 4 / 4.0 and its dated id claude-opus-4-20250514 (after every newer claude-opus-4-x above).
  { id: 'claude-opus-4', family: 'opus', thinking: 'none', efforts: [], minCache: 1024 },
  // Sonnet 5.5: $2/$10, cache reads $0.20, 5m writes $2.50, 1h writes $4; effort default high (recalibrated).
  { id: 'claude-sonnet-5-5', family: 'sonnet', contextTokens: M, maxOutput: K128, price: { input: 2, output: 10, cacheRead: 0.2 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high', current: true, computer: 'toolset', web: WEB_DYNAMIC, compaction: true, preservedThinking: true, fallback: true, minCache: 512 },
  { id: 'claude-sonnet-5', family: 'sonnet', contextTokens: M, maxOutput: K128, price: { input: 2, output: 10 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'high', computer: 'computer_20251124', web: WEB_DYNAMIC, minCache: 1024 },
  { id: 'claude-sonnet-4-6', family: 'sonnet', contextTokens: M, maxOutput: K128, price: { input: 3, output: 15 }, thinking: 'adaptive', efforts: NO_XHIGH, defaultEffort: 'high', computer: 'computer_20251124', web: WEB_DYNAMIC, compaction: true, minCache: 1024 },
  { id: 'claude-sonnet-4-5', family: 'sonnet', thinking: 'none', efforts: [], minCache: 1024 },
  { id: 'claude-sonnet-4', family: 'sonnet', thinking: 'none', efforts: [], minCache: 1024 },
  // Haiku 5.5: $0.10 / $0.50 up to 100K prompt tokens, $0.50 / $2.50 above; cache reads 0.1x, writes 1.25x (5m) /
  // 2x (1h) of the tier's input rate. No server-side fallback. Not on the dynamic-filtering list: basic web tools.
  { id: 'claude-haiku-5-5', family: 'haiku', contextTokens: M, maxOutput: K128, price: { input: 0.1, output: 0.5 }, longContext: { above: 100_000, input: 0.5, output: 2.5 }, thinking: 'adaptive', efforts: ALL, defaultEffort: 'medium', current: true, computer: 'toolset', web: WEB_BASIC, compaction: true, preservedThinking: true, minCache: 512 },
  { id: 'claude-haiku-4-5', family: 'haiku', contextTokens: 200_000, maxOutput: 64_000, price: { input: 1, output: 5 }, thinking: 'none', efforts: [], computer: 'computer_20250124', web: WEB_BASIC, minCache: 4096 },
  { id: 'claude-3', family: 'haiku', thinking: 'none', efforts: [] }
]

/** The spec for a model id (dated snapshots and suffixes match their alias). */
export function claudeSpec(model: string): ClaudeSpec | undefined {
  const id = model.toLowerCase()
  // A suffix that is a version number ("-2" in claude-fable-5-2) names a different, newer model, not a
  // snapshot of this one: only dated or other non-version suffixes match the alias.
  const snapshotOf = (c: ClaudeSpec): boolean => id.startsWith(`${c.id}-`) && !/^\d{1,2}(?:-|$)/.test(id.slice(c.id.length + 1))
  return CLAUDE.find((c) => id === c.id || snapshotOf(c) || (c.id === 'claude-3' && id.startsWith('claude-3')))
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

/** The family's highest known first-party rates: what an unknown newer model is priced at until it is known. */
const CONSERVATIVE: Record<ClaudeFamily, { input: number; output: number; cacheRead: number }> = {
  fable: { input: 10, output: 50, cacheRead: 1 },
  mythos: { input: 10, output: 50, cacheRead: 1 },
  opus: { input: 5, output: 25, cacheRead: 0.5 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheRead: 0.1 }
}

/**
 * Everything SahilBot assumes about a Claude model: the table's entry, or, for an id newer than the table
 * (claude-fable-5-2, claude-opus-6…), the newest known model of its family with the family's highest
 * prices, marked estimated. Its tool versions follow the newest generation (every model of the 5.5
 * generation takes the computer toolset and the dynamic-filtering web tools); the UI says the pricing is
 * estimated. undefined: not a Claude model.
 */
export function claudeInfo(model: string): ClaudeSpec | undefined {
  const spec = claudeSpec(model)
  if (spec) return spec
  const family = claudeFamily(model)
  if (!family) return undefined
  const base = CLAUDE.find((c) => c.family === family && c.current) ?? CLAUDE.find((c) => c.family === family)
  return {
    ...FUTURE,
    ...(base ? { contextTokens: base.contextTokens, maxOutput: base.maxOutput, defaultEffort: base.defaultEffort } : {}),
    id: model.toLowerCase(),
    family,
    price: { ...CONSERVATIVE[family] },
    computer: 'toolset',
    web: WEB_DYNAMIC,
    compaction: true,
    preservedThinking: true,
    minCache: 512,
    estimated: true
  }
}
/** Premium tier: priced above Opus, so Auto and the hybrid advisor use it only when picked by name. */
export const isPremiumClaude = (model: string): boolean => /^claude-(fable|mythos)/i.test(model)

const LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * The app's thinking level (Low, Medium, High, Extra, Max) for this model: the level itself when the
 * model accepts it, else the nearest accepted level below it (Extra on Opus/Sonnet 4.6 → High), else
 * the lowest above. undefined: the model takes no effort parameter (Haiku 4.5, Sonnet 4.5, older).
 */
export function claudeEffort(model: string, effort: Effort = 'medium'): Effort | undefined {
  const ok = (claudeInfo(model) ?? (/^claude-/i.test(model) ? { ...FUTURE } : undefined))?.efforts
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
  const spec = claudeInfo(model) ?? (/^claude-/i.test(model) ? { id: model, family: 'opus' as const, ...FUTURE } : undefined)
  if (!spec) return {}
  const e = claudeEffort(model, effort ?? 'medium')
  return {
    ...(spec.thinking === 'adaptive' ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
    ...(e ? { output_config: { effort: e } } : {})
  }
}

/** Cache reads as a fraction of the input price: 0.025x Fable/Mythos 5.1, 0.05x Opus 5.5, ~0.1x elsewhere. */
export function cacheReadFactor(model: string): number {
  const p = claudeInfo(model)?.price
  return p?.cacheRead !== undefined ? p.cacheRead / p.input : 0.1
}

/** Cache writes (5-minute TTL) cost 1.25x input on every model (shared/prompt-caching.md). */
export const CACHE_WRITE_FACTOR = 1.25
/** 1-hour cache writes cost 2x input (shared/prompt-caching.md "Economics"). */
export const CACHE_WRITE_1H_FACTOR = 2

// ---------------------------------------------------------------------------------------------------
// Long context. Every current Claude model has a 1M window (shared/models.md); the chat uses as much of
// it as the context strategy allows, then compacts (server-side when the model supports it).
// ---------------------------------------------------------------------------------------------------

/** Room kept for the reply under the full window: thinking counts toward max_tokens (64K for agent turns). */
export const REPLY_HEADROOM = 64_000
const STRATEGY_CAP: Record<Exclude<ContextStrategy, 'max'>, number> = { balanced: 400_000, economy: 128_000 }
/** A Claude model whose window the reference doesn't give: the window SahilBot always used for Claude. */
const UNKNOWN_WINDOW = 131_072

/**
 * The prompt window a chat on this Claude model works in: 'max' = the model's whole window (minus room
 * for the reply), 'balanced' (default) = up to 400K, 'economy' = up to 128K. Compaction starts near it.
 */
export function claudeWindow(model: string, strategy: ContextStrategy = 'balanced'): number {
  const spec = claudeInfo(model)
  if (!spec?.contextTokens) return UNKNOWN_WINDOW
  const full = spec.contextTokens - Math.min(REPLY_HEADROOM, spec.maxOutput ?? REPLY_HEADROOM)
  return strategy === 'max' ? full : Math.min(STRATEGY_CAP[strategy], full)
}

/**
 * Where server-side compaction (compact_20260112) starts for a window: 80% of it, never below the API's
 * 50,000-token minimum (shared/python sdk-upgrade.md: "the API minimum is 50,000"). The client-side
 * summarizer only steps in if a prompt would no longer fit at all.
 */
export const compactionTrigger = (window: number): number => Math.max(50_000, Math.round(window * 0.8))

/** The Claude options in Settings → Models, with their defaults filled in. */
export interface ClaudeOptions {
  contextStrategy: ContextStrategy
  /** Claude's native tool types (computer toolset, text editor, bash, server web search/fetch). */
  nativeTools: boolean
  /** Auto may use Fable (premium) for the hardest tier. */
  fableForHardest: boolean
  /** Auto routes cloud-first: chosen in Settings, or by default when a Claude key is saved. */
  preferCloud: boolean
}

export function claudeOptions(s: { cloud?: Partial<Settings['cloud']>; keys?: Partial<Settings['keys']> }): ClaudeOptions {
  const c = s.cloud ?? {}
  const strategy = c.contextStrategy
  return {
    contextStrategy: strategy === 'max' || strategy === 'economy' ? strategy : 'balanced',
    nativeTools: c.nativeTools !== false,
    fableForHardest: c.fableForHardest === true,
    preferCloud: c.enabled !== false && (c.prefer === 'cloud' || (c.prefer === undefined && !!s.keys?.anthropic))
  }
}

/** "1M" / "200K" for the Models page. */
export function formatTokens(n: number): string {
  return n >= M ? `${n / M}M` : `${Math.round(n / 1000)}K`
}
