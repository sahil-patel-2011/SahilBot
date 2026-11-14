import type { ModelInfo, SwarmSettings } from '@shared/types'
import { claudeFamily, claudeSpec, isPremiumClaude, type ClaudeFamily } from '../../llm/claude-models'
import { teamCapacity } from '../../llm/models'

// How big a team can be and which models it runs on. Local models are bound by this Mac's memory
// (llm/models.ts teamCapacity); cloud models by the user's swarm settings and the provider's rate limits.

const CLOUD_PROVIDERS = new Set(['anthropic', 'openai', 'openrouter'])

/** A model served from the cloud (as teamCapacity counts it: unknown models too). */
export const isCloudInfo = (m: ModelInfo | undefined): boolean =>
  !m || m.note === 'remote' || m.note === 'added by you' || CLOUD_PROVIDERS.has(m.provider)

export type SwarmCapacity = { parallel: number; maxAgents: number; heavy: boolean; why: string; cloud: boolean }

/** Team capacity for the lead's model: RAM-bound on this Mac, settings-bound on the cloud. */
export function swarmCapacity(m: ModelInfo | undefined, cfg: SwarmSettings): SwarmCapacity {
  if (isCloudInfo(m)) {
    return { parallel: Math.min(cfg.maxParallel, cfg.maxAgents), maxAgents: cfg.maxAgents, heavy: true, cloud: true, why: `cloud model: up to ${cfg.maxAgents} helpers, ${Math.min(cfg.maxParallel, cfg.maxAgents)} at once` }
  }
  return { ...teamCapacity(m), cloud: false }
}

const LOWER: Record<ClaudeFamily, ClaudeFamily | null> = { fable: 'opus', mythos: 'opus', opus: 'sonnet', sonnet: 'haiku', haiku: null }

const toolsOk = (m: ModelInfo): boolean => m.tools !== false
const byStrength = (a: ModelInfo, b: ModelInfo): number => b.tier - a.tier || (b.rank ?? 0) - (a.rank ?? 0)
/** The newest model of a Claude family that is usable (the table's current one first). */
function newestOf(family: ClaudeFamily, usable: ModelInfo[]): ModelInfo | undefined {
  return usable.filter((m) => claudeFamily(m.id) === family && toolsOk(m))
    .sort((a, b) => Number(!!claudeSpec(b.id)?.current) - Number(!!claudeSpec(a.id)?.current) || (b.rank ?? 0) - (a.rank ?? 0) || b.id.localeCompare(a.id))[0]
}

/**
 * The model helpers run on. Local leads keep their own model (one model loaded, not several). On the
 * cloud: 'same', an explicit usable model id, or 'auto' = one tier below the lead (Sonnet helpers under
 * an Opus lead, Haiku under Sonnet; other providers: the best usable model one tier down from the same
 * provider). Anything not usable falls back to the lead's model.
 */
export function helperModelFor(lead: string, setting: string, usable: ModelInfo[], cloud: boolean): string {
  if (!cloud || setting === 'same') return lead
  if (setting !== 'auto') return usable.some((m) => m.id === setting && toolsOk(m)) ? setting : lead
  const fam = claudeFamily(lead)
  if (fam) {
    const down = LOWER[fam]
    return (down && newestOf(down, usable)?.id) || lead
  }
  const info = usable.find((m) => m.id === lead)
  if (!info || info.tier <= 1) return lead
  const below = usable.filter((m) => m.provider === info.provider && isCloudInfo(m) && toolsOk(m) && m.tier === info.tier - 1).sort(byStrength)[0]
  return below?.id ?? lead
}

/**
 * The judge for Heavy: the strongest usable model on the same side as the lead (cloud leads get the
 * strongest cloud model, premium Claude only when the lead already is one; local leads keep their model,
 * so nothing is sent to the cloud and no second local model has to load).
 */
export function judgeModelFor(lead: string, usable: ModelInfo[], cloud: boolean): string {
  if (!cloud) return lead
  const best = usable.filter((m) => isCloudInfo(m) && toolsOk(m) && (!isPremiumClaude(m.id) || isPremiumClaude(lead))).sort(byStrength)[0]
  return best?.id ?? lead
}

/**
 * The models Heavy's attempts run on. Local: all on the lead's model (different temperatures and angles).
 * Cloud 'auto': two on the lead's model, one on the strongest, one on another provider's best when that
 * provider is keyed (e.g. 2× Sonnet + 1× Opus + 1× GPT); the rest on the lead's. An explicit list is used
 * as given (unusable ids fall back to the lead's model) and padded with the lead's.
 */
export function heavyMix(lead: string, mix: 'auto' | 'same' | string[], usable: ModelInfo[], n: number, cloud: boolean): string[] {
  if (!cloud || mix === 'same') return Array(n).fill(lead)
  if (Array.isArray(mix)) return Array.from({ length: n }, (_, i) => (mix[i] && usable.some((m) => m.id === mix[i] && toolsOk(m)) ? mix[i] : lead))
  const strongest = judgeModelFor(lead, usable, cloud)
  const S = strongest !== lead ? strongest : undefined
  const leadProvider = usable.find((m) => m.id === lead)?.provider
  const other = usable.filter((m) => isCloudInfo(m) && toolsOk(m) && m.provider !== leadProvider && !isPremiumClaude(m.id) && m.id !== S).sort(byStrength)[0]?.id
  if (n === 2) return [lead, other ?? S ?? lead]
  if (n === 3) return [lead, S ?? lead, other ?? lead]
  return Array.from({ length: n }, (_, i) => (i === 2 ? S ?? lead : i === 3 ? other ?? lead : lead))
}
