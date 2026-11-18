import type { ModelInfo, SpendingMode } from '@shared/types'
import { cost, priceFor } from '../llm/budget'
import { isPlanModel } from '../llm/codex/ids'
import { pick } from '../llm/router'
import { premiumModel, slotOf, type Slot } from '../llm/routing-table'

// Model routing for brain work, explicit and separate from a chat's Auto pick:
//   extract  (classifying and pulling facts from batches of items) → the cheapest capable model: a local
//            model when the user turned local models on, else GPT-6 Luna, Claude Haiku 5.5, GPT-6.1 Terra;
//   brief    (the "Written for you" paragraphs) → a standard model the way Auto's Balanced preference
//            routes writing: Claude Sonnet 5.5 or GPT-6.2 Sol, falling back to the cheap ones (and to them
//            first when today's brain budget is nearly spent).
// Never premium (Fable, Mythos, Opus, GPT-6.2 Astra): brain jobs aren't worth it. The ChatGPT plan only
// with "Use my ChatGPT plan for the brain" on, and pay-per-use models never under the None limit.

export type BrainJob = 'extract' | 'brief'

export interface RouteContext {
  models: ModelInfo[]
  isLocal: (id: string) => boolean
  /** Local models are on (Settings → Models). */
  localAllowed: boolean
  /** "Use my ChatGPT plan for the brain". */
  planAllowed: boolean
  mode: SpendingMode
  /** Today's brain budget is mostly used: briefs drop to the cheap models. */
  tight?: boolean
}

export type BrainRoute = { model: string; local: boolean; free: boolean; slot?: Slot; why: string } | { blocked: string }

const CHEAP: Slot[] = ['luna', 'haiku', 'terra']
const STANDARD: Slot[] = ['sonnet', 'sol']
const NEVER: Slot[] = ['fable', 'opus', 'astra']

/** Price per 1M tokens, input plus a quarter of output (what a brain batch roughly spends). */
const unitPrice = (id: string): number => { const p = priceFor(id); return p.input + p.output * 0.25 }

export function brainRoute(job: BrainJob, c: RouteContext): BrainRoute {
  const usable = c.models.filter((m) => m.enabled !== false && m.installed !== false)
  const local = c.localAllowed ? usable.filter((m) => c.isLocal(m.id)) : []
  const cloud = usable.filter((m) => !c.isLocal(m.id)).filter((m) => {
    if (premiumModel(m.id)) return false
    const s = slotOf(m)
    if (s && NEVER.includes(s)) return false
    const plan = isPlanModel(m.id) || m.provider === 'chatgpt'
    if (plan) return c.planAllowed
    return c.mode !== 'none'
  })
  const bySlot = (slots: Slot[]): ModelInfo | undefined => {
    for (const s of slots) {
      const hit = cloud.filter((m) => slotOf(m) === s && !isPlanModel(m.id)).sort((a, b) => unitPrice(a.id) - unitPrice(b.id))[0]
      if (hit) return hit
    }
    return undefined
  }
  const plan = cloud.filter((m) => isPlanModel(m.id) || m.provider === 'chatgpt')
  const out = (m: ModelInfo, why: string): BrainRoute => {
    const isLoc = c.isLocal(m.id)
    return { model: m.id, local: isLoc, free: isLoc || isPlanModel(m.id) || m.provider === 'chatgpt', slot: slotOf(m), why }
  }
  const cheapestOther = (): ModelInfo | undefined => cloud.filter((m) => !isPlanModel(m.id) && priceFor(m.id).known).sort((a, b) => unitPrice(a.id) - unitPrice(b.id))[0]

  if (job === 'extract') {
    const loc = pick(local, 1) ?? pick(local, 0)
    if (loc) return out(loc, 'a model on this Mac (free)')
    if (plan.length && c.planAllowed) return out(pick(plan, 1) ?? plan[0], 'your ChatGPT plan (allowed for the brain)')
    const cheap = bySlot(CHEAP)
    if (cheap) return out(cheap, 'the cheapest capable cloud model')
    const other = cheapestOther()
    if (other) return out(other, 'the cheapest model you have on (no Luna or Haiku)')
  } else {
    if (!c.tight) {
      const std = bySlot(STANDARD)
      if (std) return out(std, 'a standard model, as Auto routes writing on Balanced')
    }
    if (plan.length && c.planAllowed) return out(pick(plan, 2) ?? plan[0], 'your ChatGPT plan (allowed for the brain)')
    const cheap = bySlot(CHEAP)
    if (cheap) return out(cheap, c.tight ? 'a cheaper model: today’s brain budget is nearly used' : 'a cheaper model (no Sonnet or Sol on)')
    const loc = pick(local, 2) ?? pick(local, 1) ?? pick(local, 0)
    if (loc) return out(loc, 'a model on this Mac (free)')
    const other = cheapestOther()
    if (other) return out(other, 'the cheapest model you have on')
  }
  if (c.mode === 'none' && !local.length) return { blocked: 'Pay-per-use spending is off (monthly limit: None) and no local model or allowed ChatGPT plan is available.' }
  return { blocked: 'No model is available for the brain. Add a cloud key or turn on a local model.' }
}

/** Worst-case dollars for one request (0 for free models). */
export function worstCost(r: { model: string; free: boolean }, input: number, maxOutput: number): number {
  return r.free ? 0 : cost(r.model, input, maxOutput)
}
