import type { Effort, Settings, Tier } from '@shared/types'
import { isOpenAI } from './providers'

// What SahilBot knows about each OpenAI model: windows, prices (incl. cached input, cache writes and the
// >272K long-context rule), reasoning efforts, which API its tool calls need, and the built-in tools it
// documents. Facts come from OpenAI's docs, read 2026-11-15:
//   developers.openai.com/api/docs/models/<id>.md (gpt-6-astra, gpt-6.1-sol, gpt-6-luna, gpt-6-sol,
//     gpt-5.6-sol, gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.2): windows, efforts, endpoints, built-in tools;
//   /api/docs/pricing.md: Standard rates (short and long context, cached input, 30m / 12h cache writes);
//   /api/docs/guides/latest-model/gpt-6-astra.md: "GPT-6 Astra, GPT-6.1 Sol, and GPT-6.1 Terra support Chat
//     Completions, but tool calling requires Responses. GPT-6 Sol and GPT-6 Luna support function calling in
//     Chat Completions only with reasoning_effort: none";
//   /api/docs/guides/prompt-caching.md: GPT-5.6 and later take prompt_cache_options (ttl 30m / 12h), report
//     cache_write_tokens and bill writes at 1.25x (30m) / 2.5x (12h) of input; earlier models have no write charge;
//   /api/docs/guides/reasoning.md: reasoning.context all_turns (GPT-5.6 family default; GPT-6.1 Sol supports it).
// A GPT id newer than this table (gpt-6.2-sol, gpt-7…) gets the facts of its role's newest model and the
// role's highest known prices, flagged estimated (openaiInfo), until it is added here.

export type OpenAIRole = 'astra' | 'sol' | 'terra' | 'luna' | 'base' | 'mini' | 'nano' | 'pro'

/** Values `reasoning.effort` takes on the Responses API (reference: responses/methods/create). */
export type OpenAIEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface OpenAISpec {
  /** The model id as the API lists it (dated snapshots `<id>-YYYY-MM-DD` match it). */
  id: string
  /** Other ids that route to this model (gpt-5.6 → gpt-5.6-sol). */
  aliases?: string[]
  /** Generation, as a number for ordering (6.1, 6, 5.6…). */
  gen: number
  role: OpenAIRole
  label: string
  /** Auto routing: 0 instant (Luna), 1 light (Terra), 2 standard (Sol), 3 hardest (Astra). */
  tier: Tier
  /** The current lineup (on by default in the picker). Older models are listed but start off. */
  current?: boolean
  /** Superseded or deprecated (listed, off by default). */
  supersededBy?: string
  deprecated?: boolean
  /** Priced far above the rest (pro models): Auto never picks it; by name it works. */
  premium?: boolean
  /** Context window, largest prompt, largest max_output_tokens (undefined: not documented here). */
  contextTokens?: number
  maxInput?: number
  maxOutput?: number
  /** $ per 1M tokens at standard (short-context) rates. cacheRead = cached input; writes when billed. */
  price: { input: number; output: number; cacheRead: number; write30m?: number; write12h?: number }
  /** "Prompts with more than 272K input tokens are priced at 2x input and cache rates and 1.5x output for the full request." */
  longContext?: { above: number; input: number; output: number }
  /** reasoning.effort values the model accepts (undefined: not documented; nothing is sent). */
  efforts?: OpenAIEffort[]
  defaultEffort?: OpenAIEffort
  /** Which API SahilBot uses: 'responses' (function tools, encrypted reasoning) or 'chat' (Chat Completions). */
  api: 'responses' | 'chat'
  /** Tool calling needs the Responses API (6-astra, 6.1-sol, 6.1-terra); Chat tools only with effort none (6-sol, 6-luna). */
  tools: 'responses-only' | 'chat-with-none' | 'both'
  /** GPT-5.6+: prompt_cache_options / prompt_cache_breakpoint, cache writes reported and billed. */
  cacheOptions?: boolean
  /** reasoning.context 'all_turns' supported (GPT-5.6 family, GPT-6.1 Sol). */
  allTurns?: boolean
  /** Server-side compaction (context_management compaction). */
  compaction?: boolean
  /** Assistant `phase` (commentary / final_answer) is round-tripped (gpt-5.3-codex and later). */
  phase?: boolean
  /** Built-in Responses tools the model documents (SahilBot only ever enables web_search). */
  builtins?: string[]
  /** Promotional pricing until this date (the table price is the promo price). */
  promoUntil?: string
  /** Facts inferred for an id newer than this table: prices are the role's highest known. */
  estimated?: boolean
}

const M = 1_000_000
const K128 = 128_000
/** GPT-6.x and GPT-5.6.x: 1,050,000 context, 922,000 max input, 128,000 max output. */
const BIG = { contextTokens: 1_050_000, maxInput: 922_000, maxOutput: K128 }
/** gpt-5.4-mini / nano: 400,000 context, 272,000 max input, 128,000 output (they can't go past 272K input). */
const MINI = { contextTokens: 400_000, maxInput: 272_000, maxOutput: K128 }
const LONG = { above: 272_000, input: 2, output: 1.5 }
const ALL6: OpenAIEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
const NO_NONE: OpenAIEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const TO_XHIGH: OpenAIEffort[] = ['none', 'low', 'medium', 'high', 'xhigh']
const BUILTINS = ['web_search', 'file_search', 'image_generation', 'code_interpreter', 'hosted_shell', 'apply_patch', 'skills', 'computer_use', 'mcp', 'tool_search']
const BUILTINS_NANO = BUILTINS.filter((t) => t !== 'computer_use' && t !== 'tool_search')
/** GPT-5.6 and later (Responses): every current feature SahilBot uses. */
const MODERN = { api: 'responses' as const, cacheOptions: true, compaction: true, phase: true, builtins: BUILTINS }
const LEGACY = { api: 'chat' as const, tools: 'both' as const }

export const OPENAI: OpenAISpec[] = [
  // The current lineup (pricing.md "Standard pricing data", model pages).
  { id: 'gpt-6-astra', gen: 6, role: 'astra', label: 'GPT-6 Astra', tier: 3, current: true, ...BIG, price: { input: 10, cacheRead: 1, output: 50, write30m: 12.5, write12h: 25 }, longContext: LONG, efforts: NO_NONE, tools: 'responses-only', ...MODERN },
  { id: 'gpt-6.1-sol', gen: 6.1, role: 'sol', label: 'GPT-6.1 Sol', tier: 2, current: true, ...BIG, price: { input: 2, cacheRead: 0.1, output: 10, write30m: 2.5, write12h: 5 }, longContext: LONG, efforts: NO_NONE, defaultEffort: 'medium', tools: 'responses-only', allTurns: true, ...MODERN },
  { id: 'gpt-6.1-terra', gen: 6.1, role: 'terra', label: 'GPT-6.1 Terra', tier: 1, current: true, ...BIG, price: { input: 1, cacheRead: 0.05, output: 5, write30m: 1.25, write12h: 2.5 }, longContext: LONG, efforts: ALL6, defaultEffort: 'medium', tools: 'responses-only', ...MODERN },
  { id: 'gpt-6-luna', gen: 6, role: 'luna', label: 'GPT-6 Luna', tier: 0, current: true, ...BIG, price: { input: 0.1, cacheRead: 0.01, output: 0.5, write30m: 0.125, write12h: 0.25 }, longContext: LONG, efforts: ALL6, defaultEffort: 'medium', tools: 'chat-with-none', ...MODERN },
  // Superseded by 6.1 Sol.
  { id: 'gpt-6-sol', gen: 6, role: 'sol', label: 'GPT-6 Sol', tier: 2, supersededBy: 'gpt-6.1-sol', ...BIG, price: { input: 2, cacheRead: 0.2, output: 10, write30m: 2.5, write12h: 5 }, longContext: LONG, efforts: ALL6, defaultEffort: 'medium', tools: 'chat-with-none', ...MODERN },
  // GPT-5.6 (alias gpt-5.6 → Sol). Sol's $4 / $20 is promotional until 2026-11-30.
  { id: 'gpt-5.6-sol', aliases: ['gpt-5.6'], gen: 5.6, role: 'sol', label: 'GPT-5.6 Sol', tier: 3, ...BIG, price: { input: 4, cacheRead: 0.4, output: 20, write30m: 5, write12h: 10 }, longContext: LONG, efforts: ALL6, defaultEffort: 'medium', tools: 'both', allTurns: true, promoUntil: '2026-11-30', ...MODERN },
  { id: 'gpt-5.6-terra', gen: 5.6, role: 'terra', label: 'GPT-5.6 Terra', tier: 2, ...BIG, price: { input: 2, cacheRead: 0.2, output: 12, write30m: 2.5, write12h: 5 }, longContext: LONG, efforts: ALL6, defaultEffort: 'medium', tools: 'both', allTurns: true, ...MODERN },
  { id: 'gpt-5.6-luna', gen: 5.6, role: 'luna', label: 'GPT-5.6 Luna', tier: 1, ...BIG, price: { input: 0.2, cacheRead: 0.02, output: 1.2, write30m: 0.25, write12h: 0.5 }, longContext: LONG, efforts: ALL6, defaultEffort: 'medium', tools: 'both', allTurns: true, ...MODERN },
  // GPT-5.5 and 5.4: no cache-write charge, prompt_cache_retention instead of prompt_cache_options.
  { id: 'gpt-5.5', gen: 5.5, role: 'base', label: 'GPT-5.5', tier: 3, contextTokens: 1_050_000, maxOutput: K128, price: { input: 5, cacheRead: 0.5, output: 30 }, longContext: LONG, efforts: TO_XHIGH, defaultEffort: 'medium', api: 'responses', tools: 'both', compaction: true, phase: true, builtins: BUILTINS },
  { id: 'gpt-5.4', gen: 5.4, role: 'base', label: 'GPT-5.4', tier: 2, contextTokens: 1_050_000, maxOutput: K128, price: { input: 2.5, cacheRead: 0.25, output: 15 }, longContext: LONG, efforts: TO_XHIGH, defaultEffort: 'none', api: 'responses', tools: 'both', compaction: true, phase: true, builtins: BUILTINS },
  { id: 'gpt-5.4-mini', gen: 5.4, role: 'mini', label: 'GPT-5.4 mini', tier: 1, ...MINI, price: { input: 0.75, cacheRead: 0.075, output: 4.5 }, efforts: TO_XHIGH, defaultEffort: 'none', api: 'responses', tools: 'both', compaction: true, phase: true, builtins: BUILTINS },
  { id: 'gpt-5.4-nano', gen: 5.4, role: 'nano', label: 'GPT-5.4 nano', tier: 0, deprecated: true, ...MINI, price: { input: 0.2, cacheRead: 0.02, output: 1.25 }, efforts: TO_XHIGH, defaultEffort: 'none', api: 'responses', tools: 'both', compaction: true, phase: true, builtins: BUILTINS_NANO },
  { id: 'gpt-5.2', gen: 5.2, role: 'base', label: 'GPT-5.2', tier: 2, contextTokens: 400_000, maxOutput: K128, price: { input: 1.75, cacheRead: 0.175, output: 14 }, efforts: TO_XHIGH, defaultEffort: 'none', api: 'responses', tools: 'both', builtins: BUILTINS.filter((t) => t !== 'computer_use' && t !== 'tool_search') },
  // Pro models: priced far above the rest (no cached-input rate). Efforts aren't on the pages read: none sent.
  { id: 'gpt-5.5-pro', gen: 5.5, role: 'pro', label: 'GPT-5.5 Pro', tier: 3, premium: true, price: { input: 30, cacheRead: 30, output: 180 }, longContext: LONG, api: 'responses', tools: 'both' },
  { id: 'gpt-5.4-pro', gen: 5.4, role: 'pro', label: 'GPT-5.4 Pro', tier: 3, premium: true, price: { input: 30, cacheRead: 30, output: 180 }, longContext: LONG, api: 'responses', tools: 'both' },
  { id: 'gpt-5.2-pro', gen: 5.2, role: 'pro', label: 'GPT-5.2 Pro', tier: 3, premium: true, price: { input: 21, cacheRead: 21, output: 168 }, api: 'responses', tools: 'both' },
  // Older models, priced only (pricing.md); they keep the Chat Completions path they always used.
  { id: 'gpt-5.1', gen: 5.1, role: 'base', label: 'GPT-5.1', tier: 2, price: { input: 1.25, cacheRead: 0.125, output: 10 }, ...LEGACY },
  { id: 'gpt-5-pro', gen: 5, role: 'pro', label: 'GPT-5 Pro', tier: 3, premium: true, price: { input: 15, cacheRead: 15, output: 120 }, ...LEGACY },
  { id: 'gpt-5-mini', gen: 5, role: 'mini', label: 'GPT-5 mini', tier: 1, price: { input: 0.25, cacheRead: 0.025, output: 2 }, ...LEGACY },
  { id: 'gpt-5-nano', gen: 5, role: 'nano', label: 'GPT-5 nano', tier: 0, price: { input: 0.05, cacheRead: 0.005, output: 0.4 }, ...LEGACY },
  { id: 'gpt-5', gen: 5, role: 'base', label: 'GPT-5', tier: 2, price: { input: 1.25, cacheRead: 0.125, output: 10 }, ...LEGACY },
  { id: 'gpt-4.1-mini', gen: 4.1, role: 'mini', label: 'GPT-4.1 mini', tier: 1, price: { input: 0.4, cacheRead: 0.1, output: 1.6 }, ...LEGACY },
  { id: 'gpt-4.1', gen: 4.1, role: 'base', label: 'GPT-4.1', tier: 2, price: { input: 2, cacheRead: 0.5, output: 8 }, ...LEGACY },
  { id: 'gpt-4o-mini', gen: 4, role: 'mini', label: 'GPT-4o mini', tier: 1, price: { input: 0.15, cacheRead: 0.075, output: 0.6 }, ...LEGACY },
  { id: 'gpt-4o', gen: 4, role: 'base', label: 'GPT-4o', tier: 2, price: { input: 2.5, cacheRead: 1.25, output: 10 }, ...LEGACY },
  { id: 'o3-pro', gen: 3, role: 'pro', label: 'o3-pro', tier: 3, premium: true, price: { input: 20, cacheRead: 20, output: 80 }, ...LEGACY },
  { id: 'o3', gen: 3, role: 'base', label: 'o3', tier: 3, price: { input: 2, cacheRead: 0.5, output: 8 }, ...LEGACY }
]

const DATED = /^-\d{4}-\d{2}-\d{2}$/

/** The table entry for an id: exact, an alias, or a dated snapshot (`gpt-5.4-mini-2026-03-17`). */
export function openaiSpec(model: string): OpenAISpec | undefined {
  const id = model.toLowerCase()
  const names = (s: OpenAISpec): string[] => [s.id, ...(s.aliases ?? [])]
  return OPENAI.find((s) => names(s).some((n) => id === n || (id.startsWith(n) && DATED.test(id.slice(n.length)))))
}

/** Not chat models (images, audio, realtime, search-only, open weights, specialized): never inferred. */
const NOT_CHAT = /image|realtime|audio|transcribe|tts|whisper|live|search|embed|oss|moderation|cyber|rosalind|sora/i

/** `gpt-6.2-sol` → { gen: 6.2, role: 'sol' }. undefined: not a GPT chat id this table can reason about. */
export function parseGpt(model: string): { gen: number; role: OpenAIRole } | undefined {
  const id = model.toLowerCase()
  if (NOT_CHAT.test(id)) return undefined
  const m = id.match(/^gpt-(\d+)(?:\.(\d+))?(?:-([a-z]+))?/)
  if (!m) return undefined
  const gen = Number(`${m[1]}.${m[2] ?? '0'}`)
  const r = m[3]
  const role: OpenAIRole = r === 'astra' || r === 'sol' || r === 'terra' || r === 'luna' || r === 'mini' || r === 'nano' || r === 'pro' ? r : 'base'
  return { gen, role }
}

/** The role's highest known first-party rates: what an unknown newer model is priced at until it is known. */
function highest(role: OpenAIRole): OpenAISpec['price'] {
  // An unknown role (gpt-7, gpt-5.3-codex) is priced like the most expensive non-pro model (Astra).
  const pool = OPENAI.filter((s) => s.api === 'responses' && (role === 'base' ? !s.premium : s.role === role))
  const from = pool.length ? pool : OPENAI.filter((s) => s.role === 'astra')
  const top = (k: keyof OpenAISpec['price']): number | undefined => {
    const v = from.map((s) => s.price[k]).filter((x): x is number => typeof x === 'number')
    return v.length ? Math.max(...v) : undefined
  }
  return { input: top('input')!, output: top('output')!, cacheRead: top('cacheRead')!, write30m: top('write30m'), write12h: top('write12h') }
}

/**
 * Everything SahilBot assumes about an OpenAI model: the table's entry, or, for a GPT id the table doesn't
 * know (gpt-6.2-sol, gpt-7, gpt-5.3-codex), the newest known model of its role (Astra for an unknown role)
 * with the role's highest prices, marked estimated. Only GPT-5 and later are inferred (Responses-era models);
 * anything else is undefined (priced pessimistically by the budget, served over Chat Completions).
 */
export function openaiInfo(model: string): OpenAISpec | undefined {
  const spec = openaiSpec(model)
  if (spec) return spec
  const p = parseGpt(model)
  if (!p || p.gen < 5) return undefined
  const current = OPENAI.filter((s) => s.current)
  const base = current.find((s) => s.role === p.role) ?? current.find((s) => s.role === 'astra')!
  return {
    ...base,
    id: model.toLowerCase(),
    aliases: undefined,
    gen: p.gen,
    role: p.role,
    label: gptLabel(model) ?? model,
    current: true,
    tier: p.role === 'pro' ? 3 : base.tier,
    premium: p.role === 'pro' || undefined,
    price: highest(p.role),
    // A newer model is assumed to work like the current generation (Responses, every effort but none).
    efforts: base.efforts?.filter((e) => e !== 'none'),
    estimated: true
  }
}

/** "gpt-6.1-sol" → "GPT-6.1 Sol"; a dated snapshot gets its date. undefined: not a GPT id. */
export function gptLabel(model: string): string | undefined {
  const spec = openaiSpec(model)
  const date = model.match(/-(\d{4}-\d{2}-\d{2})$/)?.[1]
  if (spec) return spec.id === model.toLowerCase() || (spec.aliases ?? []).includes(model.toLowerCase()) ? spec.label : `${spec.label}${date ? ` (${date})` : ''}`
  const m = model.match(/^gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?(?:-(\d{4}-\d{2}-\d{2}))?$/i)
  if (!m || NOT_CHAT.test(model)) return undefined
  const role = m[2] ? ` ${m[2] === 'mini' || m[2] === 'nano' ? m[2] : m[2][0].toUpperCase() + m[2].slice(1)}` : ''
  return `GPT-${m[1]}${role}${m[3] ? ` (${m[3]})` : ''}`
}

/** Quality within a tier, for Auto: newer generations first, aliases over snapshots; below Claude (3+), so Claude's preference holds. */
export function openaiRank(model: string): number | undefined {
  const spec = openaiInfo(model)
  if (!spec) return undefined
  const snapshot = /-\d{4}-\d{2}-\d{2}$/.test(model) ? 0.0001 : 0
  return 2 + spec.gen / 100 - snapshot
}

/** Premium OpenAI models (pro): Auto leaves them alone; picking one by name works. */
export const isPremiumOpenAI = (model: string): boolean => !!openaiInfo(model)?.premium

/** On the API, model ids that start switched off: everything but the current lineup (and newer, inferred ids). */
export function olderOpenAI(ids: string[]): Set<string> {
  return new Set(ids.filter((id) => {
    const spec = openaiSpec(id)
    if (spec) return !spec.current || id.toLowerCase() !== spec.id
    const inferred = openaiInfo(id)
    // A newer GPT the table doesn't know yet is on (it's the newest); anything else (old, special) starts off.
    return !(inferred && parseGpt(id)!.gen > Math.max(...OPENAI.filter((s) => s.current).map((s) => s.gen)) && !/-\d{4}-\d{2}-\d{2}$/.test(id))
  }))
}

/** SahilBot's effort levels, lowest first. */
const LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * The app's thinking level (Low, Medium, High, Extra, Max) as the model's reasoning.effort: the level itself
 * when the model takes it, else the nearest accepted level below it (Max on GPT-5.5 → xhigh), else the
 * lowest above. Never 'none' or 'minimal' (Astra and 6.1 Sol reject none; quick replies still reason a
 * little). undefined: the model's efforts aren't documented here, so nothing is sent.
 */
/** The least reasoning the model accepts ('none' where it can), for short structured answers. */
export function quickestEffort(model: string): OpenAIEffort | undefined {
  const ok = openaiInfo(model)?.efforts
  return ok?.length ? (['none', 'minimal', 'low'] as OpenAIEffort[]).find((e) => ok.includes(e)) : undefined
}

export function openaiEffort(model: string, effort: Effort = 'medium'): OpenAIEffort | undefined {
  const ok = openaiInfo(model)?.efforts
  if (!ok?.length) return undefined
  if (ok.includes(effort)) return effort
  const i = LEVELS.indexOf(effort)
  for (let j = i - 1; j >= 0; j--) if (ok.includes(LEVELS[j])) return LEVELS[j]
  return LEVELS.slice(i + 1).find((l) => ok.includes(l))
}

/**
 * max_output_tokens to send: reasoning tokens count toward it, and OpenAI suggests reserving at least 25,000
 * for reasoning and output (guides/reasoning). Higher effort gets more room, never past the model's cap.
 */
export function openaiMaxTokens(requested: number, effort?: Effort, model?: string): number {
  const want = Math.max(requested, effort === 'max' || effort === 'xhigh' ? 64_000 : effort === 'high' ? 32_000 : 25_000)
  const cap = model ? openaiInfo(model)?.maxOutput : undefined
  return cap ? Math.min(want, cap) : want
}

/** Whether this request goes over the Responses API: an OpenAI endpoint and a model that uses it. */
export function usesResponses(baseUrl: string, model: string): boolean {
  return isOpenAI(baseUrl) && openaiInfo(model)?.api === 'responses'
}

// ---------------------------------------------------------------------------------------------------
// Long context. GPT-6.x / 5.6.x take 922K input tokens, but a prompt over 272K is billed at 2x input and
// 1.5x output for the whole request. The chat works in a window set by the context strategy (the same
// cloud.contextStrategy setting as Claude's), then compacts (server-side, context_management).
// ---------------------------------------------------------------------------------------------------

export type ContextStrategy = 'max' | 'balanced' | 'economy'
/** Balanced stays under the 272K long-context price threshold, with room for the estimate's error. */
export const OPENAI_BALANCED = 256_000
export const OPENAI_ECONOMY = 128_000
const UNKNOWN_WINDOW = 131_072

/** The largest prompt the model takes: its documented max input, else the window minus its output cap. */
export function maxInputOf(spec: OpenAISpec): number | undefined {
  if (spec.maxInput) return spec.maxInput
  return spec.contextTokens ? spec.contextTokens - (spec.maxOutput ?? K128) : undefined
}

/**
 * The prompt window a chat on this OpenAI model works in: 'max' = its whole input limit (922K on GPT-6.x),
 * 'balanced' (default) = 256K (below the 272K long-context surcharge), 'economy' = 128K.
 */
export function openaiWindow(model: string, strategy: ContextStrategy = 'balanced'): number {
  const spec = openaiInfo(model)
  const max = spec ? maxInputOf(spec) : undefined
  if (!max) return UNKNOWN_WINDOW
  return strategy === 'max' ? max : Math.min(max, strategy === 'economy' ? OPENAI_ECONOMY : OPENAI_BALANCED)
}

/** Where server-side compaction starts: 80% of the window (the API's minimum is 1,000; SahilBot never goes below 50K). */
export const openaiCompactAt = (window: number): number => Math.max(50_000, Math.round(window * 0.8))

export function openaiStrategy(s: { cloud?: Partial<Settings['cloud']> }): ContextStrategy {
  const v = s.cloud?.contextStrategy
  return v === 'max' || v === 'economy' ? v : 'balanced'
}

/** Cache-write price factors (of the input rate) for a model: 1.25x / 2.5x on GPT-5.6+, none before. */
export function writeFactors(model: string): { m30: number; h12: number } {
  const p = openaiInfo(model)?.price
  if (!p?.write30m) return { m30: 1, h12: 1 }
  return { m30: p.write30m / p.input, h12: (p.write12h ?? p.write30m * 2) / p.input }
}

/** "1.05M" for the Models page. */
export const formatWindow = (n: number): string => (n >= M ? `${Math.round(n / 10_000) / 100}M` : `${Math.round(n / 1000)}K`)
