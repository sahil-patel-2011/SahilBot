import { claudeInfo, REPLY_HEADROOM } from './claude-models'
import { maxInputOf, openaiInfo } from './openai-models'
import { isGrok, xaiInfo } from './xai-models'
import { savedChoice } from '@shared/context-choices'

// The per-model "Context window" choice (Settings → Models), applied. A choice is used exactly as picked; the
// only change ever made to it is the provider's own limit (a 1M pick on a Claude model is its whole window less
// the reply's room; a 1M pick on GPT-6 is its 922K input limit). Default (no choice) leaves the context strategy
// in charge (claudeWindow / openaiWindow). The window then drives compaction: the server-side trigger is 80%
// of it (compactionTrigger / openaiCompactAt) and the client-side ContextManager budgets against it.

/** The largest prompt a cloud model takes, from the model tables. undefined: not a model the tables know. */
export function providerMaxPrompt(model: string): number | undefined {
  const bare = model.replace(/^(anthropic|openai|x-?ai)\//i, '')
  if (/^claude-/i.test(bare)) {
    const spec = claudeInfo(bare.replace(/\./g, '-'))
    if (!spec?.contextTokens) return undefined
    return spec.contextTokens - Math.min(REPLY_HEADROOM, spec.maxOutput ?? REPLY_HEADROOM)
  }
  if (isGrok(bare)) {
    const spec = xaiInfo(bare)
    return spec?.contextTokens ? spec.contextTokens - Math.min(REPLY_HEADROOM, spec.maxOutput ?? REPLY_HEADROOM) : undefined
  }
  const o = openaiInfo(bare)
  return o ? maxInputOf(o) : undefined
}

/** The user's choice for a model, or undefined for Default. */
export function chosenContext(s: { modelContext?: Record<string, number> }, model: string): number | undefined {
  return savedChoice(s.modelContext, model) || undefined
}

/**
 * The window for a model with a choice: the choice, clamped to the provider's maximum (cloud) or to what fits
 * this Mac (local: `localMax`, the model's maxFittingWindow; never below 16K). undefined: no choice (Default).
 */
export function chosenWindow(s: { modelContext?: Record<string, number> }, model: string, o: { localMax?: number; cloud?: boolean } = {}): number | undefined {
  const c = chosenContext(s, model)
  if (!c) return undefined
  const max = providerMaxPrompt(model)
  if (max) return Math.min(c, max)
  if (o.cloud) return c
  return Math.max(16_384, Math.min(c, o.localMax || c))
}

/** Budget against the catalog of the provider actually serving this chat, including subscription CLIs. */
export function catalogWindow(model: { id: string; provider: string; contextTokens?: number }, strategy: 'max' | 'balanced' | 'economy', picked?: number): number | undefined {
  if (!model.contextTokens) return undefined
  const cap = model.provider === 'anthropic'
    ? Math.max(1, model.contextTokens - Math.min(REPLY_HEADROOM, claudeInfo(model.id)?.maxOutput ?? REPLY_HEADROOM, Math.floor(model.contextTokens / 4)))
    : model.provider === 'openai' ? Math.min(model.contextTokens, providerMaxPrompt(model.id) ?? Infinity) : model.contextTokens
  return Math.min(cap, picked ?? (strategy === 'max' ? 1_000_000 : strategy === 'balanced' ? 400_000 : 128_000))
}
