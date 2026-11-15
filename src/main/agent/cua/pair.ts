import type { ModelInfo, Tier } from '@shared/types'
import { isPremiumOpenAI } from '../../llm/openai-models'
import { type AutoVariant, autoPool, pick } from '../../llm/router'
import { type AutoPreference, routeTier, slotOf, slotsFor, type Slot } from '../../llm/routing-table'
import type { CuaMode } from './protocol'

// Which models plan and which execute (agent/cua). Pure and local: no model calls.
//
// Evidence (docs/model-routing.md "Computer use", docs/computer-use.md "Planner and executor", read 2026-11-15):
// - End-to-end GUI tasks, OSWorld 2.1 offline (VR): Fable 5.2 89.3, Opus 5.5 87.2, Sonnet 5.5 83.9, Astra 79.5-80.9,
//   6.1 Sol 78.0, 6.1 Terra 74.2 (at max effort), Haiku 5.5 72.4. Full set partial credit: Opus 81.8, Sonnet 80.1;
//   strict: Opus 48.7, Sonnet 43.5. Epoch rates OSWorld 2.1 "Flawed" (grading errors), so gaps of a few points
//   are within the noise.
// - Grounding only (click accuracy), ScreenSpot-Pro (VR): Astra 92.7; no figure for any Claude 5.5, Sol or Terra.
// - The one independent GUI-only eval, Vals CUA-bench (IND, keyboard-and-mouse games): Astra 19.17, Opus 5.5 14.00.
// - OpenAI calls Terra good at "precise computer use" without a grounding number; on its own OSWorld 2.1 chart
//   Sol beats Terra at every effort level. Grok 4.7: no computer-use data at all, so never an executor here.
// - No source tests a planner/executor split, and none separates planning from clicking for a Claude model.
// So the default executor is Claude Sonnet 5.5 (near Opus end to end at half the price, fast); Opus executes when
// Sonnet is off; on GPT-only setups Astra (best GPT end to end, the only measured grounding) on Best result and Sol
// (near Astra at a fifth of the price) on Balanced; Cheapest: Haiku, then Terra. The planner is the strongest
// model for the difficulty from the routing table's computer-use row, Claude first (Opus for real multi-step work,
// Fable at the hardest tier only with "Use Fable for the hardest tasks").

export interface PairInput {
  /** Settings → Models → Computer use. */
  mode: CuaMode
  /** Settings → Models → Executor model: '' = Auto (evidence), or a model id. */
  executorSetting?: string
  /** Planner model override: '' = Auto. */
  plannerSetting?: string
  /** What Auto may use (Endpoints.usable()). */
  models: ModelInfo[]
  category: string
  difficulty: Tier
  /** The request text (for the multi-step check). */
  text: string
  /** The model the run would use on its own (Auto's routed pick or the chat's chosen model). */
  routed: string
  /** The chat's model is Auto ('auto' / 'auto:local' / 'auto:cloud'), or undefined when picked by name. */
  variant?: AutoVariant
  preference: AutoPreference
  fableForHardest: boolean
  /** Little monthly budget left (Auto routes as Cheapest; Auto mode stays single-model). */
  budgetTight?: boolean
}

export interface PairChoice {
  planner: string
  executor: string
  why: string
}

export type PairDecision = ({ pair: true } & PairChoice) | { pair: false; why: string }

const remote = (m: ModelInfo): boolean => m.note === 'remote' || m.note === 'added by you' || m.provider === 'anthropic' || m.provider === 'openai' || m.provider === 'openrouter'

const CLAUDE_SLOTS: Slot[] = ['fable', 'opus', 'sonnet', 'haiku']

/** Executor order by preference: the evidence above. */
export function executorSlots(preference: AutoPreference): Slot[] {
  if (preference === 'cheapest') return ['haiku', 'terra', 'sonnet', 'sol', 'opus', 'astra']
  if (preference === 'balanced') return ['sonnet', 'opus', 'sol', 'astra', 'terra', 'haiku']
  return ['sonnet', 'opus', 'astra', 'sol', 'terra', 'haiku']
}

/**
 * Planner order: the routing table's computer-use row at the tier the preference routes the difficulty to,
 * Claude slots first (the planner thinks; the evidence puts Claude ahead end to end), then GPT by strength.
 */
export function plannerSlots(difficulty: Tier, preference: AutoPreference, fableForHardest: boolean): Slot[] {
  const tier = routeTier('computer-use', difficulty, preference)
  const row = slotsFor('computer-use', tier, preference === 'cheapest' ? 'balanced' : preference, fableForHardest)
  const claude = row.filter((s) => CLAUDE_SLOTS.includes(s))
  // GPT: Astra plans at the hardest tier (a handful of calls), Sol below it.
  const gpt: Slot[] = tier === 3 ? ['astra', 'sol', 'terra'] : ['sol', 'astra', 'terra']
  return [...claude, ...CLAUDE_SLOTS.filter((s) => s !== 'fable' && !claude.includes(s)), ...gpt]
}

/**
 * Auto turns the pair on for multi-step computer use: several apps, forms, long flows ("open Mail, then write
 * to Ann…"). A single click or key stays single-model.
 */
export function multiStep(text: string): boolean {
  const t = text.toLowerCase()
  const verbs = t.match(/\b(open|click|type|fill|enter|send|go to|navigate|find|search|copy|paste|attach|save|export|select|choose|download|upload|book|log ?in|sign ?in|drag|move|rename|create|add|reply|forward|schedule|submit|check|compare|update|change|set|turn (on|off)|install)\b/g) ?? []
  const apps = new Set(t.match(/\b(mail|safari|chrome|finder|notes|calendar|messages|slack|numbers|pages|keynote|excel|word|powerpoint|preview|settings|reminders|music|spotify|photos|terminal|xcode|zoom|teams|outlook|figma|browser|website|site|portal)\b/g) ?? [])
  if (/\b(then|after that|and then|next,|finally|step \d|first\b.*\bthen)\b/.test(t)) return true
  if (/\b(form|application|checkout|wizard|every|each|all of|for each)\b/.test(t) && verbs.length >= 1) return true
  if (apps.size >= 2) return true
  if (new Set(verbs).size >= 3) return true
  return verbs.length >= 2 && t.length > 80
}

/** A model by id among the models Auto may use. */
const byId = (models: ModelInfo[], id: string | undefined): ModelInfo | undefined => (id ? models.find((m) => m.id === id) : undefined)

/** The newest usable model of a slot (cloud only; premium GPT never). */
function bySlot(models: ModelInfo[], slot: Slot): ModelInfo | undefined {
  return models.filter((m) => remote(m) && slotOf(m) === slot && !isPremiumOpenAI(m.id.replace(/^[\w-]+\//, '')) && m.tools !== false && m.installed !== false)
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))[0]
}

const label = (m: ModelInfo | undefined, id: string): string => m?.label || id

/** The planner and executor for a computer-use request, or why it stays single-model. */
export function choosePair(i: PairInput): PairDecision {
  if (i.mode === 'single') return { pair: false, why: 'Computer use is set to Single model' }
  if (i.category !== 'computer-use') return { pair: false, why: 'not a computer-use request' }
  const forced = i.mode === 'pair'
  if (!forced && i.budgetTight) return { pair: false, why: 'little cloud budget left this month' }
  if (!forced && !multiStep(i.text)) return { pair: false, why: 'a short computer-use step: one model is enough' }
  // Auto (local) pairs among local models, Auto (cloud) among cloud models; a model picked by name stays the executor.
  const pool = autoPool(i.variant ?? 'auto', i.models).filter((m) => m.installed !== false)
  const vision = (m: ModelInfo | undefined): boolean => !!m && m.vision !== false
  let executor = byId(pool, i.executorSetting) ?? (i.variant ? undefined : byId(i.models, i.routed))
  if (!executor && i.variant !== 'auto:local') {
    for (const s of executorSlots(i.budgetTight ? 'cheapest' : i.preference)) { const m = bySlot(pool, s); if (m) { executor = m; break } }
  }
  executor ??= byId(pool, i.routed) ?? byId(i.models, i.routed)
  if (!executor) return { pair: false, why: 'no executor model is available' }

  let planner = byId(pool, i.plannerSetting)
  if (!planner && i.variant !== 'auto:local') {
    for (const s of plannerSlots(i.difficulty, i.budgetTight ? 'cheapest' : i.preference, i.fableForHardest)) {
      if (s === 'fable' && !(i.fableForHardest && i.difficulty >= 2)) continue
      const m = bySlot(pool, s)
      if (m) { planner = m; break }
    }
  }
  // Local only (or nothing in the table): the strongest local model plans.
  if (!planner) planner = pick(pool, 3, { preferCloud: i.variant !== 'auto:local' })
  if (!planner) return { pair: false, why: 'no planner model is available' }
  if (!vision(executor) && !forced) return { pair: false, why: `${label(executor, executor.id)} can't see screenshots` }
  if (planner.id === executor.id && !forced) return { pair: false, why: `the strongest planner is the executor itself (${label(planner, planner.id)})` }
  // Auto: the planner must not be weaker than the executor (it decides disagreements).
  const pSlot = slotOf(planner), eSlot = slotOf(executor)
  if (!forced && pSlot && eSlot && strength(pSlot) < strength(eSlot)) return { pair: false, why: `${label(planner, planner.id)} would plan for a stronger executor` }
  const pl = label(planner, planner.id), ex = label(executor, executor.id)
  return { pair: true, planner: planner.id, executor: executor.id, why: `${pl} plans and checks; ${ex} executes${i.executorSetting && executor.id === i.executorSetting ? ' (your executor setting)' : i.variant ? ' (from the computer-use evidence)' : ' (the model this chat uses)'}${forced ? '; Computer use is set to Planner + executor' : ''}` }
}

/** Rough end-to-end computer-use strength per slot (OSWorld 2.1 offline, VR; for ordering only). */
const STRENGTH: Partial<Record<Slot, number>> = { fable: 89.3, opus: 87.2, sonnet: 83.9, astra: 80.9, sol: 78.0, terra: 74.2, haiku: 72.4 }
export const strength = (s: Slot): number => STRENGTH[s] ?? 0

