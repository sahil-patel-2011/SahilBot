import type { ModelInfo, Tier } from '@shared/types'
import { fallbackNotice } from '../agent/choices'
import { isPremiumClaude } from './claude-models'
import { type AutoVariant, autoPool, autoVariant, pick, routingPrefs } from './router'
import { type AutoPreference, type RoutePick, payPerUse, routeTask, windowOf } from './routing-table'
import { CATEGORY_LABEL, type TaskCategory, type TaskClass } from './task-classifier'
import { type FailureKind, type ModelHealth, KIND_WORDS, failureKind, modelHealth, scopeOf } from './model-health'

// Auto's whole per-request decision in one pure function (no model call, no I/O), shared by the agent loop
// (loop.ts chooseModel) and the simulator (tests/unit/auto-matrix.test.ts), so what is simulated is what runs:
//   1. a model picked by name (or the voice model setting in a voice chat) is used exactly;
//   2. models cooling down after a failure (model-health.ts: out of credit, rate limited…) are skipped;
//   3. voice on Balanced / Cheapest / Local first: a small local model answers (no network round trip);
//   4. otherwise the routing table (routing-table.ts routeTask), which keeps the chat's previous Auto model on
//      follow-ups when it is still as good a choice (prompt cache stays warm).

export interface AutoRouteInput {
  /** The model value in force: 'auto' / 'auto:local' / 'auto:cloud', or a model id picked by name. */
  requested: string
  /** What Auto may use now (Endpoints.usable()). */
  usable: ModelInfo[]
  task: TaskClass
  preference: AutoPreference
  /** Less than 10% of the monthly limit left: route as Cheapest. */
  budgetTight?: boolean
  /** A real-time voice conversation. */
  voice?: boolean
  /** Settings → Models → Voice model ('' = Auto). */
  voiceModel?: string
  /** The chat's previous Auto pick and what that request was (follow-ups keep the model when it is as good). */
  previous?: { model: string; category?: TaskCategory }
  /** Failure cooldowns (default: the app's shared registry). */
  health?: ModelHealth
  now?: number
  /** Defaults: routingPrefs (set from Settings by Endpoints.usable()). */
  preferCloud?: boolean
  fableForHardest?: boolean
}

export interface AutoRouteResult {
  model: string
  /** Picked by name (or the voice model setting): used exactly, never re-routed. */
  manual: boolean
  variant?: AutoVariant
  pick?: RoutePick
  /** "Claude Sonnet 5.5 · coding" */
  label: string
  /** Why, in words (the label's tooltip). */
  why: string
  tier: Tier
}

const name = (m: ModelInfo): string => m.label || m.id
const remote = (m: ModelInfo): boolean => m.note === 'remote' || m.note === 'added by you' || m.provider === 'anthropic' || m.provider === 'openai' || m.provider === 'openrouter' || m.provider === 'xai'

/** Auto's pick for one request (or the model picked by name). Throws with a readable message when nothing can run. */
export function autoRoute(i: AutoRouteInput): AutoRouteResult {
  const task = i.task
  const variant = autoVariant(i.requested)
  const cat = CATEGORY_LABEL[task.category]
  if (i.voice && i.voiceModel && variant) return { model: i.voiceModel, manual: true, variant, label: `${i.voiceModel} · ${cat}`, why: `${task.why} · your voice model`, tier: task.difficulty }
  if (!variant) return { model: i.requested, manual: true, label: `${i.requested} · ${cat}`, why: `${task.why} · picked by you`, tier: task.difficulty }
  const now = i.now ?? Date.now()
  const health = i.health ?? modelHealth
  // Models cooling down after a failure are skipped; if that leaves nothing, the soft cooldowns (rate limits,
  // overloads, dropped connections) are tried anyway, never the hard ones (out of credit, key refused, gone).
  const usable = health.filter(i.usable, now)
  const pool = autoPool(variant, usable)
  if (!pool.length) {
    const blocked = health.explain(i.usable, now)
    if (blocked) throw Object.assign(new Error(`Auto has no model to use right now: ${blocked}.`), { health: true })
    if (variant !== 'auto') throw new Error(`${variant === 'auto:local' ? 'Auto (local)' : 'Auto (cloud)'} has no model to use.`)
  }
  const cloudVoice = i.preference === 'best' && (i.preferCloud ?? routingPrefs.preferCloud) && !i.budgetTight
  // Voice off the cloud: a small, fast local model so replies start right away (unless the request is hard). It
  // must still see the images and hold the prompt.
  if (i.voice && !cloudVoice && task.difficulty <= 2 && variant !== 'auto:cloud') {
    const need = task.contextTokens > 0 ? task.contextTokens + 16_000 : 0
    const light = pool.filter((m) => !remote(m) && m.tier <= 1 && (!task.needsVision || m.vision) && (!need || windowOf(m) >= need))
    const fast = pick(light, 0)
    if (fast) return { model: fast.id, manual: false, variant, label: `${name(fast)} · ${cat}`, why: `${task.why} · a fast local model for voice`, tier: task.difficulty }
  }
  const routed = routeTask(pool, task, { preference: i.preference, variant, budgetTight: i.budgetTight, previous: i.previous, preferCloud: i.preferCloud, fableForHardest: i.fableForHardest })
  if (!routed) throw new Error('No models are available. Start Ollama or LM Studio, or add an API key in Settings → Models.')
  return { model: routed.model.id, manual: false, variant, pick: routed, label: routed.label, why: routed.why, tier: task.difficulty }
}

// ---------------------------------------------------------------------------------------------------
// The monthly limit, Balanced's close calls.
// ---------------------------------------------------------------------------------------------------

/**
 * Little monthly budget left (a specific amount with less than 10% of it left): Auto routes as Cheapest to make
 * the rest last. Only when something pay-per-use could still be picked: with the limit at None or Unlimited, or
 * when only the ChatGPT plan and local models are left (nothing to save), the preference stands.
 */
export function budgetTightFor(mode: 'amount' | 'unlimited' | 'none', cap: number, left: number | undefined, pool?: ModelInfo[]): boolean {
  if (mode !== 'amount' || !(cap > 0) || left === undefined || !(left < cap * 0.1)) return false
  return !pool || pool.some(payPerUse)
}

export { CLOSE_CALL_PRICE, TTFT_S, closeCall, closeCallLatency, slotPrice, slotTtft } from './routing-table'

// ---------------------------------------------------------------------------------------------------
// Fallback after a failed call.
// ---------------------------------------------------------------------------------------------------

export interface FallbackInput {
  usable: ModelInfo[]
  task: TaskClass
  /** The model that failed. */
  current: ModelInfo | string
  err: unknown
  /** Models already tried in this run (never tried twice: no loop between two failing models). */
  tried: Set<string>
  preference: AutoPreference
  /** The chat's Auto variant (a model picked by name falls back among everything Auto may use). */
  variant?: AutoVariant
  budgetTight?: boolean
  /** The run is under way (steps done on this model): the same provider first for a model-only failure. */
  midRun?: boolean
  health?: ModelHealth
  now?: number
}

export interface FallbackPlan {
  kind: FailureKind
  /** The model to carry on with (undefined: none can). */
  model?: ModelInfo
  /** The one chat note: which model answers instead, and why. */
  note?: string
  label?: string
}

/**
 * Where a run goes after its model failed (retries already spent, or an error retrying can't fix). Out of
 * credit, a refused key, a dropped connection to the provider or the ChatGPT plan's limit rule out that
 * provider; a context-too-long error needs a bigger window; a content-policy refusal stops (trying other
 * providers until one says yes would be shopping around a safety decision); the spending limit leaves only the
 * ChatGPT plan and local models. Then the
 * routing table picks for the same task, so the next-best candidate answers (the same provider first, mid-run,
 * for a failure of that one model: the run's history keeps its provider-specific parts, such as Claude's
 * thinking blocks and compaction, or OpenAI's reasoning items). Never a model already tried.
 */
export function planFallback(i: FallbackInput): FallbackPlan {
  const kind = failureKind(i.err)
  // A content-policy refusal is an answer, not an outage: no fallback, the user sees why.
  if (kind === 'refusal') {
    const from = typeof i.current === 'string' ? i.current : name(i.current)
    return { kind, note: `${from} declined this request under its usage policy, so SahilBot stopped here rather than asking another model. Rephrase it, or say what you need it for.` }
  }
  const curId = typeof i.current === 'string' ? i.current : i.current.id
  const cur = typeof i.current === 'string' ? i.usable.find((m) => m.id === i.current) : i.current
  const provider = cur?.provider
  const health = i.health ?? modelHealth
  const now = i.now ?? Date.now()
  let pool = i.usable.filter((m) => m.id !== curId && !i.tried.has(m.id) && m.tools !== false && m.installed !== false && !health.blocked(m, now))
  const scope = provider ? scopeOf(kind, provider) : 'model'
  if (provider && scope === 'provider') pool = pool.filter((m) => m.provider !== provider)
  if (kind === 'budget') pool = pool.filter((m) => !payPerUse(m))
  if (kind === 'context' && cur) pool = pool.filter((m) => windowOf(m) > windowOf(cur))
  // A premium model (Fable, GPT Pro) only takes over from one.
  if (!cur || !isPremiumClaude(cur.id)) pool = pool.filter((m) => !isPremiumClaude(m.id))
  const route = (ms: ModelInfo[]): RoutePick | undefined => {
    if (!ms.length) return undefined
    try { return routeTask(ms, i.task, { preference: i.preference, variant: i.variant ?? 'auto', budgetTight: i.budgetTight }) } catch { return undefined }
  }
  const sameFirst = !!i.midRun && !!provider && scope === 'model'
  const r = (sameFirst ? route(pool.filter((m) => m.provider === provider)) : undefined) ?? route(pool)
  const from = cur ? name(cur) : curId
  if (!r) return { kind, note: `${from} is ${KIND_WORDS[kind]}, and no other model Auto may use can take over.` }
  return { kind, model: r.model, label: `${name(r.model)} · ${CATEGORY_LABEL[i.task.category]}`, note: fallbackNotice(from, name(r.model), i.err as Error, { rest: true }) }
}
