import type { HelperRole, ModelInfo, Tier } from '@shared/types'
import { claudeFamily, isPremiumClaude } from '../../llm/claude-models'
import { isPremiumOpenAI } from '../../llm/openai-models'
import { routingPrefs } from '../../llm/router'
import { slotOf, slotsFor, type Slot } from '../../llm/routing-table'
import type { TaskCategory } from '../../llm/task-classifier'
import { helperModelFor, isCloudInfo, judgeModelFor } from './capacity'

// Mixed-model swarms and councils: each helper's model follows its role, and every model (Claude, GPT,
// Grok when connected) goes where the evidence says it is strong: the role's row in Auto's routing table
// (llm/routing-table.ts, docs/model-routing.md) for the task's category, quality first, then speed and cost.
//   breadth  cheap breadth (many items, extraction, first drafts): the table's light row (Haiku, Luna, Terra…)
//   solid    solid work: the standard row (Sonnet, Sol…)
//   hard     the hardest or most important slices: the hardest row, Best result (Opus, Astra; Fable only with
//            "Use Fable for the hardest tasks" on, or under a Fable lead)
//   compile  the compile / judge step: as hard
//   review   a reviewer or critic: the standard row, from another provider than the work's author when one
//            is connected (a second opinion)
// When two are close the table already puts the higher-quality, more-reasoning model first.
//
// Provider rules: a bot works cross-provider (Claude, GPT and Grok together). A normal agent chat stays with
// its lead's provider (an Opus lead gets Sonnet/Haiku helpers, a GPT lead Sol/Terra/Luna): aligned work and a
// little cheaper. A local lead keeps its own model for everyone (one model loaded, nothing sent to the cloud),
// and so does Auto (local). Only usable models count (keyed providers, the monthly budget: endpoints.usable()).
// Each provider's effort and fast-mode settings apply as the client sends the request (Settings decide where
// fast mode is allowed); nothing here turns fast mode on.

export type AnyRole = HelperRole | 'compile'
export const ROLE_TIER: Record<AnyRole, Tier> = { breadth: 1, solid: 2, hard: 3, compile: 3, review: 2 }
export const ROLE_SLOTS: Record<AnyRole, Slot[]> = {
  breadth: ['haiku', 'luna', 'terra'],
  solid: ['sonnet', 'sol'],
  hard: ['opus', 'astra', 'fable'],
  compile: ['opus', 'astra', 'fable'],
  review: ['sonnet', 'sol', 'opus', 'astra']
}
export const ROLE_LABEL: Record<HelperRole, string> = { breadth: 'Breadth', solid: 'Solid', hard: 'Hardest', review: 'Reviewer' }
export const isRole = (v: unknown): v is HelperRole => v === 'breadth' || v === 'solid' || v === 'hard' || v === 'review'

/** xAI's Grok (llm/xai-models.ts when present): recognized by id or provider. */
export const isGrok = (m: string | Pick<ModelInfo, 'id' | 'provider'>): boolean => {
  const id = typeof m === 'string' ? m : m.id
  return /(^|\/)grok/i.test(id) || (typeof m !== 'string' && (m.provider as string) === 'xai')
}

export function providerOf(m: string | Pick<ModelInfo, 'id' | 'provider'>): string {
  const id = typeof m === 'string' ? m : m.id
  if (claudeFamily(id)) return 'anthropic'
  if (isGrok(m)) return 'xai'
  if (/^(?:openai\/)?(gpt|o\d)/i.test(id)) return 'openai'
  return typeof m === 'string' ? 'other' : m.provider
}

const toolsOk = (m: ModelInfo): boolean => m.tools !== false
const strongest = (a: ModelInfo, b: ModelInfo): number => b.tier - a.tier || (b.rank ?? 0) - (a.rank ?? 0) || b.id.localeCompare(a.id)
const cloudOk = (m: ModelInfo): boolean => isCloudInfo(m) && toolsOk(m)

/** A role's slots: the routing table's row for the category at the role's tier first, then the role's usual slots. */
export function roleSlots(role: AnyRole, category: TaskCategory, fable: boolean): Slot[] {
  const fallback = ROLE_SLOTS[role].filter((s) => s !== 'fable' || fable)
  let row: Slot[] = []
  try { row = slotsFor(category, ROLE_TIER[role], role === 'hard' || role === 'compile' ? 'best' : 'balanced', fable) } catch { row = [] }
  row = row.filter((s) => s !== 'fable' || fable)
  return [...row, ...fallback.filter((s) => !row.includes(s))]
}

/** The best usable cloud model filling a slot (newest / highest ranked first). */
export function modelForSlot(slot: Slot, usable: ModelInfo[], provider?: string, exclude?: string, maxTier = 3): ModelInfo | undefined {
  return usable.filter((m) => cloudOk(m) && slotOf(m) === slot && m.tier <= maxTier && (!provider || providerOf(m) === provider) && providerOf(m) !== exclude).sort(strongest)[0]
}

/** OpenAI's Pro models ($30 / $180 per 1M): only ever picked by name. */
const pro = (m: ModelInfo): boolean => isPremiumOpenAI(m.id.replace(/^[\w-]+\//, ''))

/** The strongest usable model of a provider. */
export const bestOf = (usable: ModelInfo[], provider: string): ModelInfo | undefined => usable.filter((m) => cloudOk(m) && providerOf(m) === provider && !isPremiumClaude(m.id) && !pro(m)).sort(strongest)[0]

export interface AssignInput {
  usable: ModelInfo[]
  category: TaskCategory
  /** The lead's model (resolved). */
  lead: string
  /** The lead runs on the cloud. */
  leadCloud: boolean
  /** Auto (local): everything stays on this Mac. */
  localOnly?: boolean
  /** Bots: any provider. Normal agent chats: the lead's provider only. */
  crossProvider: boolean
  /** Prefer this provider (bots only: "a Claude lead can run a GPT swarm"). */
  provider?: string
  /** A model the lead asked for by id (used when usable and allowed). */
  explicit?: string
  /** Reviewers: the author's provider, so the review comes from another one when possible. */
  authorProvider?: string
}

/** One helper's model for its role, and why (shown on the card's tooltip). */
export function assignModel(role: AnyRole, o: AssignInput): { model: string; why: string } {
  if (!o.leadCloud || o.localOnly) return { model: o.lead, why: o.localOnly ? 'Auto (local): stays on this Mac' : 'local model: one model loaded' }
  const leadProvider = providerOf(o.usable.find((m) => m.id === o.lead) ?? o.lead)
  const allowed = (m: ModelInfo): boolean => cloudOk(m) && (o.crossProvider || providerOf(m) === leadProvider)
  if (o.explicit) {
    const m = o.usable.find((x) => x.id === o.explicit)
    if (m && allowed(m)) return { model: m.id, why: 'chosen by the lead' }
  }
  const pool = o.usable.filter(allowed)
  const fable = routingPrefs.fableForHardest || isPremiumClaude(o.lead)
  const slots = roleSlots(role, o.category, fable)
  const prefer = !o.crossProvider ? [leadProvider] : o.provider ? [o.provider, undefined] : [undefined]
  // A reviewer from another provider than the author first (bots), then anyone allowed.
  const avoid = role === 'review' && o.crossProvider ? o.authorProvider : undefined
  for (const ex of avoid ? [avoid, undefined] : [undefined]) {
    for (const p of prefer) {
      for (const s of slots) {
        // Breadth stays on the light tier and solid work on the standard one (cheap, fast); the table orders them.
        const m = modelForSlot(s, pool, p, ex, role === 'breadth' ? 1 : role === 'solid' ? 2 : 3)
        if (m) return { model: m.id, why: `${role} role · ${s} (routing table, ${o.category})${o.crossProvider ? '' : ' · same provider as the lead'}` }
      }
    }
  }
  // Nothing in the role's slots: one tier below the lead (same provider), or the strongest allowed.
  const fallback = role === 'hard' || role === 'compile' ? judgeModelFor(o.lead, pool, true) : helperModelFor(o.lead, 'auto', pool, true)
  return { model: fallback, why: `${role} role · no ${slots.join('/')} model connected` }
}

/** A cheaper role, for when the budget can't cover the asked one. */
export const cheaperRole = (r: HelperRole): HelperRole => (r === 'hard' || r === 'review' ? 'solid' : 'breadth')

/**
 * The council's members (strongest first: the chair): 'auto' = the strongest Claude and the strongest GPT that
 * are usable (the hardest row first); with only one of them connected, its two strongest. Chosen ids (Grok
 * or local models included) are kept when usable. Fewer than two: none (the council can't sit).
 */
export function councilMembers(setting: 'auto' | string[], usable: ModelInfo[], lead?: string): { members: string[]; critics: string[]; note?: string } {
  const cloud = usable.filter(cloudOk)
  const fable = routingPrefs.fableForHardest || (!!lead && isPremiumClaude(lead))
  const info = (id: string): ModelInfo => usable.find((m) => m.id === id)!
  const order = (ids: string[]): string[] => [...ids].sort((a, b) => strongest(info(a), info(b)))
  // Members the user picked by name: any usable model with tools (local ones too).
  if (Array.isArray(setting)) {
    const ok = [...new Set(setting.filter((id) => usable.some((m) => m.id === id && toolsOk(m))))]
    if (ok.length >= 2) return { members: order(ok).slice(0, 4), critics: [] }
  }
  const best = (provider: string): ModelInfo | undefined => {
    for (const s of roleSlots('hard', 'agent-tools', fable)) {
      const m = modelForSlot(s, cloud, provider)
      if (m) return m
    }
    return bestOf(cloud, provider)
  }
  const picks = (['anthropic', 'openai'] as const).map(best).filter((m): m is ModelInfo => !!m)
  if (picks.length >= 2) return { members: order(picks.map((m) => m.id)), critics: [] }
  const ranked = cloud.filter((m) => (!isPremiumClaude(m.id) || fable) && !pro(m)).sort(strongest)
  // One of them plus another provider (Grok), or one provider's two strongest, said so.
  if (picks.length === 1) {
    const other = ranked.find((m) => providerOf(m) !== providerOf(picks[0]))
    if (other) return { members: order([picks[0].id, other.id]), critics: [] }
  }
  if (ranked.length >= 2) return { members: [ranked[0].id, ranked[1].id], critics: [], note: 'Only one cloud provider is connected, so both members come from it. Add another provider\'s key for a cross-provider council.' }
  return { members: [], critics: [], note: 'Council needs at least two cloud models (for example Claude Opus and GPT-6 Astra). Add an Anthropic and an OpenAI key in Settings.' }
}

/** A second opinion for a council: the strongest model from a provider none of the members come from. */
export function secondOpinionFor(members: string[], usable: ModelInfo[]): string | undefined {
  const have = new Set(members.map((m) => providerOf(usable.find((x) => x.id === m) ?? m)))
  return usable.filter((m) => cloudOk(m) && !have.has(providerOf(m)) && !isPremiumClaude(m.id) && !pro(m)).sort(strongest)[0]?.id
}
