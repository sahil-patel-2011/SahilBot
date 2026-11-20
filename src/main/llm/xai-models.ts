import type { Effort, Tier } from '@shared/types'

// What SahilBot knows about each xAI (Grok) model: windows, prices (incl. cached input and the >=200K
// long-context rule), reasoning efforts, vision and tool support. Facts from xAI's docs, read 2026-11-15
// (sources and quotes in docs/grok.md):
//   docs.x.ai/docs/models and /docs/models/<id> (grok-4.7, grok-4.6, grok-4.5, grok-4.3, grok-build-0.1):
//     context windows, "text, image → text", function calling, structured outputs, effort lists and defaults;
//   docs.x.ai/docs/pricing: per-1M rates below / at-or-above 200K prompt tokens ("requests whose prompt reaches
//     the listed token threshold are billed at the higher rate for all tokens in the request"), Priority
//     ("billed at a 2x premium over standard rates", only "when the response confirms service_tier: priority"),
//     Web Search $5 per 1,000 calls, the Batch discount (unused here) and the US regional endpoint (unused);
//   docs.x.ai/docs/guides/reasoning: reasoning.effort low / medium / high / xhigh, default high, "Reasoning
//     cannot be disabled" (grok-4.7 / 4.6 / 4.5; "xhigh is not available on grok-4.5"); presencePenalty,
//     frequencyPenalty and stop are rejected by reasoning models;
//   REST reference (Responses, Chat Completions): max_output_tokens "Defaults to 128,000 when unset";
//     service_tier "default" | "priority" | "fast" (fast and priority are the same tier).
// A grok id newer than this table (grok-4.8, grok-5…) gets the newest model's facts and the highest known
// prices, flagged estimated (xaiInfo), until it is added here.

/** Values xAI's reasoning.effort takes (per model: XaiSpec.efforts). */
export type XaiEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'

export interface XaiSpec {
  /** The model id as the API lists it. */
  id: string
  /** Other ids xAI routes to it (grok-4.3-latest, grok-code-fast-1…). */
  aliases?: string[]
  /** Version for ordering (4.7, 4.6…); grok-build-0.1 sorts by its date of arrival, below 4.5. */
  gen: number
  label: string
  /** SahilBot's tier for Auto: Grok is a reviewer and second opinion, never the default (docs/model-routing.md). */
  tier: Tier
  /** The current flagship (on by default in the picker). Older models are listed but start off. */
  current?: boolean
  /** A special-purpose model Auto never picks (the multi-agent model, where effort means agent count). */
  special?: boolean
  contextTokens: number
  /** Largest visible output: xAI's documented default for max_output_tokens (no model page gives a cap). */
  maxOutput: number
  /** $ per 1M tokens below 200K prompt tokens. */
  price: { input: number; cacheRead: number; output: number }
  /** At or above 200K prompt tokens, every token of the request is billed at these rates. */
  longContext: { atLeast: number; input: number; cacheRead: number; output: number }
  /** reasoning.effort values the model accepts (undefined: not documented, nothing is sent). */
  efforts?: XaiEffort[]
  defaultEffort?: XaiEffort
  /** Reasons by itself (no effort control documented): presence/frequency penalties and stop are left out. */
  reasoning: boolean
  vision: boolean
  tools: boolean
  /** Rate limits at Tier 0 (rate-limits page): requests per second and tokens per minute. */
  limits?: { rps: number; tpm: number }
  /** Facts inferred for an id newer than this table: prices are the highest known. */
  estimated?: boolean
}

const K = 1000
const M = 1_000_000
const OUT = 128 * K
const LONG = 200 * K
const FLAGSHIP = { input: 2, cacheRead: 0.5, output: 6 }
const FLAGSHIP_LONG = { atLeast: LONG, input: 4, cacheRead: 1, output: 12 }
const MID = { input: 1.25, cacheRead: 0.2, output: 2.5 }
const MID_LONG = { atLeast: LONG, input: 2.5, cacheRead: 0.4, output: 5 }
const TO_XHIGH: XaiEffort[] = ['low', 'medium', 'high', 'xhigh']

export const XAI: XaiSpec[] = [
  // The flagship: "grok-4.7", 500K, $2 / $0.50 / $6 (>=200K: $4 / $1 / $12), efforts low..xhigh (default high).
  { id: 'grok-4.7', gen: 4.7, label: 'Grok 4.7', tier: 2, current: true, contextTokens: 500 * K, maxOutput: OUT, price: FLAGSHIP, longContext: FLAGSHIP_LONG, efforts: TO_XHIGH, defaultEffort: 'high', reasoning: true, vision: true, tools: true, limits: { rps: 150, tpm: 50 * M } },
  { id: 'grok-4.6', gen: 4.6, label: 'Grok 4.6', tier: 2, contextTokens: 500 * K, maxOutput: OUT, price: FLAGSHIP, longContext: FLAGSHIP_LONG, efforts: TO_XHIGH, defaultEffort: 'high', reasoning: true, vision: true, tools: true, limits: { rps: 150, tpm: 50 * M } },
  // grok-4.5: cached input $0.30 ($0.60 long). Its model page lists xhigh, the reasoning guide says "xhigh is not
  // available on grok-4.5": the guide wins (a rejected effort fails the request).
  { id: 'grok-4.5', aliases: ['grok-4.5-latest', 'grok-build-latest'], gen: 4.5, label: 'Grok 4.5', tier: 2, contextTokens: 500 * K, maxOutput: OUT, price: { input: 2, cacheRead: 0.3, output: 6 }, longContext: { atLeast: LONG, input: 4, cacheRead: 0.6, output: 12 }, efforts: ['low', 'medium', 'high'], defaultEffort: 'high', reasoning: true, vision: true, tools: true, limits: { rps: 150, tpm: 50 * M } },
  // grok-4.3: 1M window, $1.25 / $0.20 / $2.50; efforts none..xhigh, default low (its model page).
  { id: 'grok-4.3', aliases: ['grok-4.3-latest'], gen: 4.3, label: 'Grok 4.3', tier: 1, contextTokens: M, maxOutput: OUT, price: MID, longContext: MID_LONG, efforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'low', reasoning: true, vision: true, tools: true, limits: { rps: 37, tpm: 10 * M } },
  // The coding model ("agentic software, engineering, and workflow tasks"), aliases grok-code-fast-1…; effort levels not documented.
  { id: 'grok-build-0.1', aliases: ['grok-code-fast-1', 'grok-code-fast', 'grok-code-fast-1-0825'], gen: 4.25, label: 'Grok Build 0.1', tier: 1, contextTokens: 256 * K, maxOutput: OUT, price: { input: 1, cacheRead: 0.2, output: 2 }, longContext: { atLeast: LONG, input: 2, cacheRead: 0.4, output: 4 }, reasoning: true, vision: true, tools: true, limits: { rps: 37, tpm: 10 * M } },
  { id: 'grok-4.20-0309-reasoning', gen: 4.2, label: 'Grok 4.20 (reasoning)', tier: 1, contextTokens: M, maxOutput: OUT, price: MID, longContext: MID_LONG, reasoning: true, vision: true, tools: true, limits: { rps: 37, tpm: 10 * M } },
  { id: 'grok-4.20-0309-non-reasoning', gen: 4.2, label: 'Grok 4.20 (fast, no reasoning)', tier: 0, contextTokens: M, maxOutput: OUT, price: MID, longContext: MID_LONG, reasoning: false, vision: true, tools: true, limits: { rps: 37, tpm: 10 * M } },
  // reasoning.effort sets how many agents collaborate (4 or 16), not depth: Auto leaves it alone, nothing is sent.
  { id: 'grok-4.20-multi-agent-0309', aliases: ['grok-4.20-multi-agent'], gen: 4.2, label: 'Grok 4.20 Multi-agent', tier: 2, special: true, contextTokens: M, maxOutput: OUT, price: MID, longContext: MID_LONG, reasoning: true, vision: false, tools: true, limits: { rps: 9, tpm: 2.5 * M } }
]

/** Not chat models (images, video, voice, embeddings): never inferred, never listed in the picker. */
const NOT_CHAT = /imagine|image|video|vision-beta|voice|tts|stt|speech|transcri|embed/i

/** xAI's alias patterns (<name>-latest, <name>-<date>) match the table's entry. */
const SUFFIX = /^-(latest|\d{4}(-?\d{2}){0,2}|\d{4})$/

export function xaiSpec(model: string): XaiSpec | undefined {
  const id = model.toLowerCase().replace(/^x-?ai\//, '')
  const names = (s: XaiSpec): string[] => [s.id, ...(s.aliases ?? [])]
  return XAI.find((s) => names(s).some((n) => id === n)) ?? XAI.find((s) => names(s).some((n) => id.startsWith(n) && SUFFIX.test(id.slice(n.length))))
}

export const isGrok = (model: string): boolean => /^(x-?ai\/)?grok-/i.test(model.trim())

/** grok-4.8 → 4.8; grok-5 → 5; grok-4.20-… → 4.2 (xAI writes 4.20 for the March 2026 model). */
export function grokVersion(model: string): number | undefined {
  const m = model.toLowerCase().replace(/^x-?ai\//, '').match(/^grok-(\d+)(?:\.(\d+))?/)
  if (!m) return undefined
  return Number(`${m[1]}.${m[2] ? String(Number(m[2])).replace(/0+$/, '') || '0' : '0'}`)
}

const discovered = new Map<string, XaiSpec>()

/** The authenticated /models list includes context length, standard and long-context prices, and accepted efforts. */
export function updateXaiCatalog(rows: Array<{ id: string } & Record<string, unknown>>): void {
  discovered.clear()
  for (const row of rows) {
    if (typeof row.id !== 'string' || !isGrok(row.id) || NOT_CHAT.test(row.id)) continue
    const number = (key: string): number | undefined => {
      const n = row[key]
      return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
    }
    const input = number('prompt_text_token_price'), output = number('completion_text_token_price')
    if (input === undefined || output === undefined) continue
    const known = xaiInfo(row.id)
    const price = { input: input / 10_000, output: output / 10_000, cacheRead: (number('cached_prompt_text_token_price') ?? input) / 10_000 }
    const rates = (key: string, standard: number): number => (number(key) || 0) / 10_000 || standard
    const capabilities = row.capabilities as { reasoning_effort?: unknown } | undefined
    const efforts = Array.isArray(capabilities?.reasoning_effort)
      ? capabilities.reasoning_effort.filter((v): v is XaiEffort => ['none', 'low', 'medium', 'high', 'xhigh'].includes(v)) : known?.efforts
    discovered.set(row.id.toLowerCase(), {
      id: row.id, gen: grokVersion(row.id) ?? 0, tier: 2, current: true, label: grokLabel(row.id),
      tools: true, vision: false, reasoning: true, ...known, price, efforts,
      contextTokens: number('context_length') || known?.contextTokens || 128_000,
      maxOutput: known?.maxOutput ?? 4096,
      longContext: row.long_context_threshold === undefined && known ? known.longContext : {
        atLeast: number('long_context_threshold') || Infinity,
        input: rates('prompt_text_token_price_long_context', price.input),
        output: rates('completion_text_token_price_long_context', price.output),
        cacheRead: rates('cached_prompt_text_token_price_long_context', price.cacheRead)
      }
    })
  }
}

/**
 * Everything SahilBot assumes about an xAI model: the table's entry, or, for a newer grok id (grok-4.8,
 * grok-5), the flagship's facts with the highest known prices, marked estimated. Non-chat ids (Imagine,
 * voice) and unknown older ids are undefined.
 */
export function xaiInfo(model: string): XaiSpec | undefined {
  const spec = discovered.get(model.toLowerCase().replace(/^x-?ai\//, '')) ?? xaiSpec(model)
  if (spec) return spec
  if (!isGrok(model) || NOT_CHAT.test(model)) return undefined
  const v = grokVersion(model)
  const flagship = XAI.find((s) => s.current)!
  if (v === undefined || v <= flagship.gen) return undefined
  const top = (k: 'input' | 'cacheRead' | 'output'): number => Math.max(...XAI.map((s) => s.price[k]))
  const topLong = (k: 'input' | 'cacheRead' | 'output'): number => Math.max(...XAI.map((s) => s.longContext[k]))
  const id = model.toLowerCase().replace(/^x-?ai\//, '')
  return {
    ...flagship,
    id,
    aliases: undefined,
    gen: v,
    label: grokLabel(id),
    current: true,
    price: { input: top('input'), cacheRead: top('cacheRead'), output: top('output') },
    longContext: { atLeast: LONG, input: topLong('input'), cacheRead: topLong('cacheRead'), output: topLong('output') },
    estimated: true
  }
}

/** "grok-4.7" → "Grok 4.7"; table ids keep their table label. */
export function grokLabel(model: string): string {
  const spec = xaiSpec(model)
  if (spec) return spec.label
  const id = model.toLowerCase().replace(/^x-?ai\//, '')
  return id.replace(/^grok-/, 'Grok ').replace(/-(\w)/g, (_, c: string) => ` ${c.toUpperCase()}`)
}

/** Within Grok, newer first; aliases and dated ids rank just below their model. Below Claude and GPT (2+). */
export function xaiRank(model: string): number | undefined {
  const s = xaiInfo(model)
  if (!s) return undefined
  return 1 + s.gen / 100 - (model.toLowerCase() === s.id ? 0 : 0.0001)
}

/** On the API listing, model ids that start switched off: everything but the current flagship (and newer ids). */
export function olderXai(ids: string[]): Set<string> {
  return new Set(ids.filter((id) => {
    const s = xaiInfo(id)
    if (!s) return true
    return !(s.current && (s.estimated || id.toLowerCase() === s.id))
  }))
}

/** SahilBot's levels, lowest first. */
const LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * The app's thinking level as xAI's reasoning.effort: the level itself when the model takes it, else the
 * nearest accepted level below (Max → xhigh; Extra on grok-4.5 → high), else the lowest above. Never 'none'
 * (Low still reasons a little, like the other providers). undefined: no effort documented, nothing sent.
 */
export function xaiEffort(model: string, effort: Effort = 'medium'): XaiEffort | undefined {
  const ok = xaiInfo(model)?.efforts?.filter((e) => e !== 'none')
  if (!ok?.length) return undefined
  if ((ok as string[]).includes(effort)) return effort as XaiEffort
  const i = LEVELS.indexOf(effort)
  for (let j = i - 1; j >= 0; j--) if ((ok as string[]).includes(LEVELS[j])) return LEVELS[j] as XaiEffort
  return LEVELS.slice(i + 1).find((l) => (ok as string[]).includes(l)) as XaiEffort | undefined
}

/**
 * max_output_tokens to send. On xAI it caps the visible output only ("Applies to visible output only"),
 * so reasoning doesn't eat into it; never past the documented 128K default.
 */
export function xaiMaxTokens(requested: number, model?: string): number {
  const cap = (model ? xaiInfo(model)?.maxOutput : undefined) ?? OUT
  return Math.max(1, Math.min(requested, cap))
}

/** Rates for one request: the long-context card once the real prompt reaches 200K tokens. */
export function xaiRates(model: string, promptTokens = 0): { input: number; cacheRead: number; output: number; long: boolean } | undefined {
  const s = xaiInfo(model)
  if (!s) return undefined
  const long = promptTokens >= s.longContext.atLeast
  const p = long ? s.longContext : s.price
  return { input: p.input, cacheRead: p.cacheRead, output: p.output, long }
}

/** Web Search: $5 per 1,000 calls (pricing page "Tool Invocation Prices"). */
export const XAI_WEB_SEARCH_USD = 0.005

/** "500K" for the Models page. */
export const xaiWindowLabel = (n: number): string => (n >= M ? `${n / M}M` : `${Math.round(n / K)}K`)
