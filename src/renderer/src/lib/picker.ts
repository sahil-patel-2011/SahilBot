import type { Effort, EffortChoice, ModelInfo, PermissionMode } from '@shared/types'
import { autoLabel, isAutoModel } from '@shared/model-picker'
// Pure model tables (no Node): which thinking levels a cloud model takes, and which ones are premium.
import { claudeInfo, isPremiumClaude } from '../../../main/llm/claude-models'
import { isPremiumOpenAI, openaiInfo } from '../../../main/llm/openai-models'
import { xaiInfo } from '../../../main/llm/xai-models'

// The composer's one picker (components/ComposerPicker.tsx): its button label, the top models it lists
// first, and the thinking levels a model offers.

export const THINKING_LABEL: Record<EffortChoice, string> = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' }
export const MODE_LABEL: Record<PermissionMode, string> = { ask: 'Ask', auto: 'Auto', autonomous: 'Auto', bypass: 'Bypass' }

const LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const ALL_THINKING: EffortChoice[] = ['auto', ...LEVELS]

/** "anthropic/claude-opus-5-5", "chatgpt-plan/gpt-6.1-sol" → the model's own id. */
const bareId = (id: string): string => id.replace(/^[\w.-]+\//, '')

/** A model's name, short: "Claude Opus 5.5" → "Opus 5.5" (the button and the rows have little room). */
export function shortModelName(id: string, m?: Pick<ModelInfo, 'label'>): string {
  const auto = isAutoModel(id) ? autoLabel(id) : undefined
  if (auto) return auto
  return (m?.label || id).replace(/^Claude\s+/i, '')
}

/**
 * The picker button: "Auto" when the model, thinking and permissions are all Auto (the default); otherwise the
 * overrides ("Opus 5.5 · High", "Auto · Low", "Auto · Ask", "Auto · Bypass").
 */
export function pickerLabel(o: { model: string; models?: Array<Pick<ModelInfo, 'id' | 'label'>> | null; thinking?: EffortChoice; mode: PermissionMode }): string {
  const perm = o.mode !== 'auto' && o.mode !== 'autonomous' ? MODE_LABEL[o.mode] : undefined
  const modelPart = isAutoModel(o.model) ? (o.model && o.model !== 'auto' ? shortModelName(o.model) : undefined) : shortModelName(o.model, o.models?.find((m) => m.id === o.model))
  const think = o.thinking && o.thinking !== 'auto' ? THINKING_LABEL[o.thinking] : undefined
  if (!modelPart && !think && !perm) return 'Auto'
  return [modelPart ?? 'Auto', think, perm].filter(Boolean).join(' · ')
}

/** Premium models (Fable, Mythos, GPT Pro) cost far more: listed after the flagship of their tier. */
const isPremium = (id: string): boolean => isPremiumClaude(bareId(id)) || isPremiumOpenAI(bareId(id))

/** Quality order: tier first (heavy → instant), then rank within the tier (premium models a step lower). */
export function byQuality(a: Pick<ModelInfo, 'id' | 'tier' | 'rank'>, b: Pick<ModelInfo, 'id' | 'tier' | 'rank'>): number {
  const score = (m: Pick<ModelInfo, 'id' | 'rank'>): number => (m.rank ?? 0) - (isPremium(m.id) ? 1.5 : 0)
  return b.tier - a.tier || score(b) - score(a)
}

/** Can be picked at all (a local model too big for this Mac at any context window can't). */
export const runnable = (m: Pick<ModelInfo, 'fits' | 'maxFittingWindow'>): boolean => m.fits || m.maxFittingWindow > 0

/**
 * The picker's first models (up to `n`), best first, and the rest (for More models). `models` is what
 * can run (pickerModels). The same model from two providers is listed once at the top.
 */
export function splitModels<T extends Pick<ModelInfo, 'id' | 'tier' | 'rank' | 'fits' | 'maxFittingWindow'>>(models: T[], n = 4): { top: T[]; more: T[] } {
  const sorted = models.map((m, i) => ({ m, i })).sort((a, b) => byQuality(a.m, b.m) || a.i - b.i).map((x) => x.m)
  const top: T[] = []
  const seen = new Set<string>()
  for (const m of sorted) {
    if (top.length >= n) break
    const key = bareId(m.id).toLowerCase()
    if (!runnable(m) || seen.has(key)) continue
    seen.add(key)
    top.push(m)
  }
  return { top, more: models.filter((m) => !top.includes(m)) }
}

/**
 * Thinking levels a model offers, Auto first: from the cloud model tables when SahilBot knows the
 * model (Claude, GPT, Grok), else all of them (local models, Auto, unknown ids).
 */
export function thinkingLevels(model: string): EffortChoice[] {
  if (isAutoModel(model)) return ALL_THINKING
  const id = bareId(model)
  const efforts = (claudeInfo(id)?.efforts ?? openaiInfo(id)?.efforts ?? xaiInfo(id)?.efforts) as string[] | undefined
  if (!efforts) return ALL_THINKING
  return ['auto', ...LEVELS.filter((l) => efforts.includes(l))]
}
