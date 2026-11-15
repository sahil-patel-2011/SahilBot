import type { ModelInfo } from './types'

// The "Context window" choices for one model on the Models page: only sizes the model and its provider really
// take, derived from the model tables (ModelInfo.contextTokens, filled from claude-models.ts / openai-models.ts /
// xai-models.ts) or, for a local model, from what fits this Mac (ModelInfo.maxFittingWindow, the app's fitWindow).
// 0 means "Default (follow strategy)". The main process applies a choice exactly, only ever clamping it to the
// provider's maximum prompt (llm/context-window.ts).

export interface ContextChoice {
  /** Tokens (0 = Default: follow the context strategy). */
  tokens: number
  label: string
  /** A note shown with the option ("higher price tier"). */
  note?: string
}

/** Cloud sizes offered, when the model's window has room for them. */
export const CLOUD_SIZES = [128_000, 256_000, 512_000, 1_000_000]
/** Local sizes (the app's local windows). */
export const LOCAL_SIZES = [16_384, 32_768, 65_536, 131_072]
/** OpenAI bills a prompt over this at the long-context rates (2x input, 1.5x output) on its long-context models. */
export const OPENAI_LONG_PRICE_ABOVE = 272_000

export const DEFAULT_CHOICE: ContextChoice = { tokens: 0, label: 'Default (follow strategy)' }

/** "128K", "1M", "1.05M". */
export function formatContext(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 10_000) / 100}M`
  // The local windows are powers of two (16384 = 16K); cloud sizes are decimal (128,000 = 128K).
  if ((n & (n - 1)) === 0 && n >= 1024) return `${n / 1024}K`
  return `${Math.round(n / 1000)}K`
}

type ModelLike = Pick<ModelInfo, 'id' | 'provider' | 'contextTokens' | 'maxFittingWindow'> & { note?: string }

export const isCloudModelInfo = (m: ModelLike): boolean =>
  m.note === 'remote' || m.note === 'added by you' || ['anthropic', 'openai', 'openrouter', 'xai', 'chatgpt'].includes(m.provider as string)

/**
 * The choices for a model, Default first. A cloud model without a known window, or a local one that fits
 * nothing, has only Default (nothing to choose from that the provider would honor).
 */
export function contextChoices(m: ModelLike): ContextChoice[] {
  const out: ContextChoice[] = [DEFAULT_CHOICE]
  if (isCloudModelInfo(m)) {
    const full = m.contextTokens ?? 0
    if (!full) return out
    // The standard sizes below the model's window (one within 6% of it is the window itself), then the window.
    const longPriced = m.provider === 'openai' && full > 400_000
    const tier = (n: number): Pick<ContextChoice, 'note'> => (longPriced && n > OPENAI_LONG_PRICE_ABOVE ? { note: 'higher price tier' } : {})
    for (const n of CLOUD_SIZES.filter((n) => n < full * 0.94)) out.push({ tokens: n, label: formatContext(n), ...tier(n) })
    out.push({ tokens: full, label: `${formatContext(full)} (full window)`, ...tier(full) })
    return out
  }
  const fits = m.maxFittingWindow ?? 0
  const sizes = LOCAL_SIZES.filter((n) => n <= fits)
  sizes.forEach((n, i) => out.push({ tokens: n, label: `${formatContext(n)}${i === sizes.length - 1 ? ' (most that fits this Mac)' : ''}` }))
  return out
}

/** The option's text in the select ("512K · higher price tier"). */
export const choiceText = (c: ContextChoice): string => (c.note ? `${c.label} · ${c.note}` : c.label)

/** A saved choice for a model (Settings.modelContext), or 0 (Default) when none or not a positive number. */
export function savedChoice(map: Record<string, number> | undefined, model: string): number {
  const v = map?.[model]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0
}

/** The map after choosing `tokens` for `model` (0 removes the entry: Default). */
export function withChoice(map: Record<string, number> | undefined, model: string, tokens: number): Record<string, number> {
  const next = { ...(map ?? {}) }
  if (tokens > 0) next[model] = Math.round(tokens)
  else delete next[model]
  return next
}
