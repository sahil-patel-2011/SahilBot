import type { ModelInfo, Tier } from '@shared/types'
import { CLAUDE, claudeFamily, isPremiumClaude } from './claude-models'
import { OPENAI, isPremiumOpenAI, openaiInfo } from './openai-models'
import { type AutoVariant, autoPool, pick, routingPrefs } from './router'
import { CATEGORY_LABEL, type TaskCategory, type TaskClass } from './task-classifier'
import { xaiInfo } from './xai-models'
import { isPlanModel } from './codex/ids'

// Auto's routing table: for each kind of request (task-classifier.ts) and difficulty, the cloud models to try
// in order, across Anthropic, OpenAI and xAI (Grok: docs/grok.md; placed by its measured strengths per category). The evidence behind each row is in docs/model-routing.md (vendor
// announcements and docs, plus independent leaderboards, read 2026-11-15); the comment on each row names
// the deciding numbers. A row names model *slots* (Claude family or GPT role), resolved to the newest model
// of that slot the user has on, so a newer Opus or Sol takes over its row without a table change.
//
// Routing is pure and local (no model call). Preferences:
//   best     (default) one tier up from the difficulty: the strongest model for the task;
//   balanced the difficulty's own tier: the cheapest model that's strong enough (SahilBot's old Auto);
//   cheapest one tier down, cheapest slot of the row first, free local models first when strong enough.
// Then the constraints: the variant (auto / auto:local / auto:cloud), local-first vs cloud-first (Local first is for
// light work: agent work goes to the cloud whenever a cloud model is on), Fable only
// with "Use Fable for the hardest tasks", the budget (usable() drops what it can't pay for; a nearly spent
// budget routes as cheapest while something pay-per-use is left), never Grok for computer use or voice, the
// ChatGPT plan for computer use only when nothing else can see the screen, vision, and the context window the
// request needs. Balanced takes Best result's pick on a close call (closeCall); a follow-up keeps the chat's
// previous model when it is as good a choice (keepPrevious). All of it is simulated over every setup × the eval
// set in tests/unit/auto-matrix.test.ts (docs/model-routing.md "Simulated guarantees").

export type Slot = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'astra' | 'sol' | 'terra' | 'luna' | 'grok'
export type AutoPreference = 'best' | 'balanced' | 'cheapest'
export const AUTO_PREFERENCES: AutoPreference[] = ['best', 'balanced', 'cheapest']
export const PREFERENCE_LABEL: Record<AutoPreference, string> = { best: 'Best result', balanced: 'Balanced', cheapest: 'Cheapest' }

export interface CategoryRoute {
  /** Ordered slots per tier (0 instant, 1 light, 2 standard, 3 hardest). */
  tiers: [Slot[], Slot[], Slot[], Slot[]]
  /** Fable leads the hardest row when "Use Fable for the hardest tasks" is on (only where the evidence puts it first). */
  fable?: boolean
  /** Highest tier the Best result preference may lift this category to (voice and chat stay quick). */
  maxTier?: Tier
  /**
   * The hardest row on Balanced, where Best result's first choice costs several times a near-equal runner-up
   * (GPT-6 Astra at $10 / $50 against GPT-6.1 Sol at $2 / $10).
   */
  balancedHardest?: Slot[]
  /**
   * Slots whose measured quality for this category is within the benchmarks' noise (the deciding numbers are
   * on the row's comment). A follow-up keeps the chat's previous model over a tied one (prompt cache stays warm).
   */
  ties?: Slot[][]
}

/**
 * The table. Sources and dates: docs/model-routing.md. VR = vendor-reported (Anthropic / OpenAI announcements
 * and docs), IND = independent (Artificial Analysis "AA", arena.ai, Snorkel Terminal-Bench 4.0 "TB4", Vals,
 * Scale Labs, ARC Prize, Epoch), all read 2026-11-15. Speed (AA): output tok/s Haiku 5.5 255, Sonnet 5.5 143,
 * Opus 5.5 114, Luna 103, Terra 71, Sol 49, Astra 40; first answer token at low effort Luna 1.57s (no
 * reasoning), Terra 1.96s, Sonnet 2.50s, Sol 3.22s, Astra 3.82s, Opus 5.32s, Haiku 6.26s.
 */
export const ROUTING_TABLE: Record<TaskCategory, CategoryRoute> = {
  // Agentic, multi-file coding. TB4 (IND): Opus 5.5 64.8, Sonnet 5.5 61.8, Astra 58.2, 6.1 Sol 58.2, Terra 51.8,
  // Haiku 40.0, Luna 16.4. arena WebDev (IND): Fable 5.2 #1, Opus #2, Sonnet #3, Astra #5, Sol #6. Scale SWE Atlas
  // (IND): Fable 5.2 80.5, Opus 77.4. DeepSWE (VR, OpenAI's): 6.1 Sol 75.2, Astra 74.8, Sonnet 71.0 → GPT runner-up.
  // Grok 4.7 (IND): TB4 37.6 (#16, below Haiku 40.0), arena WebDev #24 (1641; Terra #14, Haiku #39), Vals SWE-bench
  // Multimodal 42.9 (#15/22), AA cost per Index task $7.77 (Sol $1.27, Haiku $0.41) → the last fallback of each row.
  coding: {
    tiers: [['haiku', 'terra', 'sonnet'], ['sonnet', 'terra', 'haiku', 'sol', 'grok'], ['sonnet', 'opus', 'sol', 'astra', 'grok'], ['opus', 'sonnet', 'astra', 'sol', 'grok']],
    fable: true,
    // TB4: Astra 58.2, 6.1 Sol 58.2.
    ties: [['astra', 'sol']]
  },
  // A quick question about code: fast first token and good-enough skill. Terra TB4 51.8 at $1/$5 and 1.96s to the
  // first token; Haiku TB4 40.0; Sonnet TB4 61.8 and the fastest flagship (143 tok/s).
  // Grok 4.7: first answer token 9.9s at low effort (AA, IND; slowest here) → only a last fallback at tiers 2-3.
  'code-quick': {
    tiers: [['haiku', 'terra', 'luna'], ['terra', 'haiku', 'sonnet', 'luna'], ['sonnet', 'sol', 'opus', 'terra', 'grok'], ['opus', 'sonnet', 'astra', 'sol', 'grok']],
    maxTier: 2
  },
  // Computer use / browser automation. OSWorld 2.1 (VR): Fable 5.2 89.3, Opus 5.5 81.8-87.2, Sonnet 5.5 80.1-83.9,
  // Astra 79.5-80.9, 6.1 Sol 78.0, Terra 74.2, Haiku 72.4 (Epoch rates OSWorld 2.1 "Flawed"). Grounding only,
  // ScreenSpot-Pro (VR): Astra 92.7, no Claude 5.5 / Sol / Terra figure. Vals CUA-bench (IND, 2026-10-13): Astra 19.17,
  // Opus 5.5 14.00. No independent OSWorld for the newest models. So GPT's hardest row has Astra before Sol.
  // In SahilBot Claude also drives the screen through its native computer toolset. Multi-step tasks can run as
  // Planner + executor (agent/cua/pair.ts picks the pair from this row and the same evidence).
  // Grok: no computer-use result anywhere (OSWorld boards have no Grok entry) → not routed here.
  'computer-use': {
    tiers: [['haiku', 'sonnet', 'terra'], ['sonnet', 'haiku', 'terra', 'sol'], ['sonnet', 'opus', 'sol', 'terra'], ['opus', 'sonnet', 'astra', 'sol']],
    fable: true,
    // OSWorld 2.1 gaps of a few points are within its noise (Epoch: "Flawed"): Opus 87.2 / Sonnet 83.9, Astra 80.9 / Sol 78.0.
    ties: [['opus', 'sonnet'], ['astra', 'sol']]
  },
  // Deep research with citations. arena Search (IND): Astra 1231, 6.1 Sol 1230, Opus 5.5 1213. BrowseComp (VR):
  // Astra 91.5 (no Claude 5.5 figure). HLE: Fable 5.2 74.3 (AA, IND), Scale HLE Astra 60.6 > Opus 55.0 (IND); HLE
  // with tools (VR) Opus 67.7. GDPval-AA (IND, synthesis-heavy knowledge work): Opus #1. Sol: $1.27 per AA task.
  // Grok 4.7: not on arena Search (only Grok 4.5, #13 1216), SimpleQA Verified 56% (Epoch, IND), AA-Omniscience
  // hallucination 29% (AA launch article) → last fallback.
  research: {
    tiers: [['haiku', 'terra', 'luna'], ['sonnet', 'sol', 'terra', 'haiku', 'grok'], ['sol', 'opus', 'sonnet', 'astra', 'grok'], ['astra', 'opus', 'sol', 'sonnet', 'grok']],
    // arena Search: Sol 1230 vs Astra 1231, at a fifth of the price.
    balancedHardest: ['sol', 'opus', 'astra', 'sonnet', 'grok'],
    fable: true,
    ties: [['astra', 'sol']]
  },
  // 500K+ tokens. MRCR v2 8-needle 512K-1M (VR): Astra 96.3; no Claude 5.5 or independent figure (AA-LCR shows
  // neither family). Price at 600K in: Claude bills the 1M window at standard rates (Sonnet $2/M, Haiku $0.50/M
  // past 100K), OpenAI doubles input past 272K (Sol $4/M, Astra $20/M).
  // Grok 4.7: 500K window (half the others'), AA-LCR down 3.7 points from Grok 4.6, no absolute figure → last fallback.
  'long-context': {
    tiers: [['haiku', 'sonnet', 'luna'], ['sonnet', 'haiku', 'sol', 'terra'], ['sonnet', 'sol', 'opus', 'astra', 'grok'], ['astra', 'opus', 'sonnet', 'sol', 'grok']],
    // Past 272K Astra costs $20 / $75 per M; Opus stays $4 / $20 across its 1M window.
    balancedHardest: ['opus', 'astra', 'sol', 'sonnet', 'grok'],
    fable: true
  },
  // Writing and editing. arena Creative Writing (IND): Opus 5.5 #2 (1517), Fable 5 #4 (1501), Fable 5.1 #8 (1490),
  // Sonnet 5.5 #29 (1464), Astra #40 (1451), 6.1 Sol #43 (1449), Luna #98. Opus beats Fable here: no Fable.
  // Grok 4.7: arena Creative Writing #85 (1421), above only Luna (#98) → last fallback.
  writing: {
    tiers: [['haiku', 'sonnet', 'terra'], ['sonnet', 'haiku', 'terra', 'sol', 'grok'], ['opus', 'sonnet', 'astra', 'sol', 'grok'], ['opus', 'sonnet', 'astra', 'sol', 'grok']],
    fable: false,
    // arena Creative Writing: Astra 1451, 6.1 Sol 1449.
    ties: [['astra', 'sol']]
  },
  // Office documents, spreadsheets, data analysis. GDPval-AA v2.1 (IND, AA): Opus 5.5 #1 (1866), Sonnet 5.5 #4 (1838),
  // Fable 5.2 #6 (1831), Haiku #32 (1629), 6.1 Sol #41 (1607), Astra #48 (1587). Vals Finance Agent: Opus #2.
  // Opus is above Fable here: no Fable.
  // Grok 4.7 (its relative strength): GDPval-AA 1695 on AA's launch chart, where Astra had 1542 and Fable 5.1 1735
  // (an older board than v2.1 above: compared within its own chart only); Snorkel Underwrite 2.0 #1 (30.5%) and
  // Finance 2.0 #3 (IND); Vals Legal Index #10/38 but Finance Agent #26/40 → after Opus / Sonnet, ahead of GPT.
  office: {
    tiers: [['haiku', 'sonnet', 'terra'], ['sonnet', 'haiku', 'grok', 'sol', 'terra'], ['sonnet', 'opus', 'grok', 'sol', 'astra'], ['opus', 'sonnet', 'grok', 'sol', 'astra']],
    fable: false,
    // GDPval-AA v2.1: 6.1 Sol 1607, Astra 1587.
    ties: [['astra', 'sol']]
  },
  // Math and careful reasoning. ARC-AGI-2 (IND, ARC Prize): Astra 95.0, 6.1 Sol 94.2, Fable 5.2 93.8, Opus 93.3;
  // ARC-AGI-3: Fable 5.2 81.2, Astra 62.7, Sol 52.7. GPQA Diamond: Astra 96.3 (IND, The Batch); FrontierMath Tier 4
  // (VR): Astra 97.6; FrontierMath Erdős (IND, Epoch): 6.1 Sol leads. Sol: near-Astra at a fifth of the price.
  // Grok 4.7: ARC-AGI-2 61.4 (Haiku 61.3, Sol 94.2), ARC-AGI-3 1.8, FrontierMath Tier 4 17% (Epoch), Vals ProofBench
  // 26% (#39/53), GPQA Diamond 93 (Epoch) → last fallback.
  math: {
    // Standard math (worked steps) needs Sol or Sonnet, not the most expensive models: those lead the hardest row.
    tiers: [['terra', 'haiku', 'luna'], ['sol', 'terra', 'sonnet', 'haiku', 'grok'], ['sol', 'sonnet', 'astra', 'opus', 'grok'], ['astra', 'sol', 'opus', 'sonnet', 'grok']],
    // ARC-AGI-2: Sol 94.2 vs Astra 95.0, at a fifth of the price.
    balancedHardest: ['sol', 'astra', 'opus', 'sonnet', 'grok'],
    fable: true,
    ties: [['astra', 'sol']]
  },
  // Images and screenshots. arena Vision (IND): Fable 5 #1, Opus 5.5 #6 (1295), 6.1 Sol #12 (1293), Astra #21
  // (1283), Sonnet 5.5 #43 (1263), Luna #68. MMMU-Pro (VR): Astra 86.7, Sol 86.3, Terra 85.5 (Terra is positioned
  // for visual reasoning).
  // Grok 4.7: arena Vision #55 (1249; Sonnet #43 1263, Luna #68 1235) → last fallback.
  vision: {
    tiers: [['terra', 'haiku', 'luna'], ['terra', 'sol', 'sonnet', 'haiku', 'grok'], ['sol', 'opus', 'terra', 'sonnet', 'grok'], ['opus', 'sol', 'astra', 'sonnet', 'grok']],
    fable: true,
    // arena Vision: Opus 1295, 6.1 Sol 1293.
    ties: [['opus', 'sol']]
  },
  // Tool-heavy agent work with connectors. arena Agent (IND): Fable 5.2 30.5, Opus 5.5 19.5, Sonnet 5.5 16.1, Astra
  // 14.6, 6.1 Sol 12.4, Terra 12.0. AutomationBench (VR): Fable 5.2 51.4, Opus 40.0, 6.1 Sol 35.4. No 5.5 / GPT-6
  // entry in the top 3 of MCP Atlas or tau2-bench (IND).
  // Grok 4.7: no tau-bench, MCP Atlas or arena Agent entry → only a last fallback at tiers 2-3.
  'agent-tools': {
    tiers: [['haiku', 'sonnet', 'terra'], ['sonnet', 'haiku', 'terra', 'sol'], ['sonnet', 'opus', 'sol', 'terra', 'grok'], ['opus', 'sonnet', 'sol', 'astra', 'grok']],
    fable: true
  },
  // Small talk and simple questions. arena Text (IND): Opus 5.5 #4 (1507), 6.1 Sol #30 (1481), Astra #42, Sonnet 5.5
  // #47 (1473), Luna #99 (1441), Haiku 5.5 #133 (1421). First token: Luna 1.57s, Terra 1.96s, Sonnet 2.50s, Haiku
  // 6.26s (AA, low effort). AA Index: Sonnet 55, Terra 51, Haiku 36, Luna 28.
  // Grok 4.7: arena Text #92 (1443, level with Luna 1441, above Haiku 1421) but 9.9s to the first token at low effort
  // and $2 / $6 → after every faster model of equal quality.
  chat: {
    tiers: [['luna', 'haiku', 'terra'], ['sonnet', 'terra', 'haiku', 'luna', 'grok'], ['sonnet', 'sol', 'opus', 'terra', 'grok'], ['opus', 'sol', 'sonnet', 'astra', 'grok']],
    maxTier: 2,
    // arena Text: 6.1 Sol 1481, Sonnet 5.5 1473; Luna 1441 and Haiku 1421 at the same price.
    ties: [['sonnet', 'sol'], ['luna', 'haiku']]
  },
  // Voice: the first token matters most (AA, low effort): Luna 1.57s, Terra 1.96s, Sonnet 2.50s, Sol 3.22s, Haiku
  // 6.26s. (OpenAI's speech-to-speech models, gpt-live-1 / gpt-realtime-2.1, aren't chat models in SahilBot.)
  // Grok: 9.9s to the first token at low effort (AA) → not routed for voice.
  voice: {
    tiers: [['luna', 'terra', 'sonnet', 'haiku'], ['terra', 'sonnet', 'luna', 'haiku'], ['sonnet', 'terra', 'sol', 'haiku'], ['sonnet', 'sol', 'opus']],
    maxTier: 1
  },
  // CAD and mechanical design (Onshape / FreeCAD tools: long, exact tool chains over a feature tree, plus spatial
  // reasoning). No CAD benchmark covers these models, so the row follows the nearest evidence: agentic tool use
  // (arena Agent, AutomationBench: Opus > Sonnet > Sol) and coding (TB4: Opus 64.8, Sonnet 61.8, Sol 58.2), with
  // vision for drawings and renders (MMMU-Pro: Sol 86.3). Quick questions (tolerances, materials) go light.
  cad: {
    tiers: [['haiku', 'sonnet', 'terra'], ['sonnet', 'terra', 'haiku', 'sol'], ['sonnet', 'opus', 'sol', 'astra'], ['opus', 'sonnet', 'sol', 'astra']],
    fable: true
  }
}

const SLOT_FAMILY: Partial<Record<Slot, string[]>> = { fable: ['fable', 'mythos'], opus: ['opus'], sonnet: ['sonnet'], haiku: ['haiku'] }

/**
 * The monthly spending limit's mode (set from Settings by Endpoints.usable()). 'none': pay-per-use API spending
 * is off, so Auto routes only to the ChatGPT plan (via Codex) and local models.
 */
export const spendingPrefs: { mode: 'amount' | 'unlimited' | 'none' } = { mode: 'amount' }

/** Why Auto had nothing to route to under the None limit. */
export const NONE_ROUTE_MESSAGE = 'Auto has no model to use: pay-per-use API spending is turned off (Settings → Models & Keys → Monthly spending limit: None), so only your ChatGPT plan (via Codex) and local models can run, and neither is available right now. Connect the ChatGPT plan in Settings → Models, start a local model, or set a monthly limit.'

/** A model billed per token (a cloud API), as opposed to local or covered by the ChatGPT plan. */
export const payPerUse = (m: ModelInfo): boolean => remote(m) && !isPlanModel(m.id) && m.provider !== 'chatgpt'

/** A model id without an OpenRouter-style vendor prefix, Claude dots as dashes ("anthropic/claude-sonnet-5.5"). */
function bareId(id: string): string {
  const bare = id.replace(/^[\w-]+\//, '').toLowerCase()
  return /^claude-/.test(bare) ? bare.replace(/\./g, '-') : bare
}

const remote = (m: ModelInfo): boolean => m.note === 'remote' || m.note === 'added by you' || m.provider === 'anthropic' || m.provider === 'openai' || m.provider === 'openrouter' || m.provider === 'xai'

/** Which slot a model fills (undefined: neither a current Claude family nor a GPT role this table routes). */
export function slotOf(m: ModelInfo | string): Slot | undefined {
  const id = bareId(typeof m === 'string' ? m : m.id)
  const fam = claudeFamily(id)
  if (fam) return (Object.keys(SLOT_FAMILY) as Slot[]).find((s) => SLOT_FAMILY[s]!.includes(fam))
  // Grok: the newest general model fills one slot (not the multi-agent model, where effort means agent count).
  const g = xaiInfo(id)
  if (g) return g.special ? undefined : 'grok'
  const o = openaiInfo(id)
  if (!o || o.premium) return undefined
  return o.role === 'astra' || o.role === 'sol' || o.role === 'terra' || o.role === 'luna' ? o.role : undefined
}

/** A slot's price per 1M output tokens (current lineup), for the Cheapest preference. */
export function slotCost(slot: Slot): number {
  // Grok's $2 / $6 understates it: it spends ~81K output tokens per AA Index task (Astra ~27K), so its cost per
  // task is $7.77 against Sol's $1.27 (AA, IND). Cheapest keeps it just behind the $2 / $10 models.
  if (slot === 'grok') return 12.5
  const fams = SLOT_FAMILY[slot]
  const spec = fams ? CLAUDE.find((c) => fams.includes(c.family) && c.current && c.price) : OPENAI.find((o) => o.role === slot && o.current)
  return spec?.price ? spec.price.input + spec.price.output : 100
}

/** The model's usable prompt window in tokens: its real window (cloud) or what fits this Mac (local). */
export function windowOf(m: ModelInfo): number {
  if (remote(m)) return m.contextTokens ?? 128_000
  return m.maxFittingWindow || 0
}

/** Room kept for the reply when checking a window fits. */
const REPLY_ROOM = 16_000

export interface RouteOptions {
  /** Best result (default) / Balanced / Cheapest. */
  preference?: AutoPreference
  variant?: AutoVariant
  /** Cloud before local (default: routingPrefs.preferCloud, set from Settings by Endpoints.usable()). */
  preferCloud?: boolean
  /** "Use Fable for the hardest tasks" (default: routingPrefs.fableForHardest). */
  fableForHardest?: boolean
  /** Little budget left this month: route as Cheapest (only while a pay-per-use model could be picked). */
  budgetTight?: boolean
  /** The chat's previous Auto pick and the kind of request it answered (stability: keepPrevious). */
  previous?: { model: string; category?: TaskCategory }
  /** Internal: Balanced's look at Best result's pick for a close call (no further look, no stickiness). */
  noCloseCall?: boolean
}

export interface RoutePick {
  model: ModelInfo
  category: TaskCategory
  /** The request's difficulty (what effort and tool mode go by). */
  difficulty: Tier
  /** The tier routed at after the preference. */
  tier: Tier
  preference: AutoPreference
  /** "Claude Sonnet 5.5 · coding" */
  label: string
  /** Why, in words, for the label's tooltip. */
  why: string
  /**
   * 'table' (a slot from the routing table), 'local' (a local model strong enough), 'fallback' (pick()),
   * 'sticky' (the chat's previous model, kept: keepPrevious), 'close-call' (Balanced took Best result's pick).
   */
  source: 'table' | 'local' | 'fallback' | 'sticky' | 'close-call'
}

/** The tier a preference routes a difficulty at. */
export function routeTier(category: TaskCategory, difficulty: Tier, preference: AutoPreference): Tier {
  const max = ROUTING_TABLE[category].maxTier ?? 3
  if (preference === 'best') return Math.max(difficulty, Math.min(max, difficulty + 1)) as Tier
  if (preference === 'cheapest') return Math.max(0, difficulty - 1) as Tier
  return difficulty
}

/** The ordered slots for a category at a tier, under a preference and the Fable setting. */
export function slotsFor(category: TaskCategory, tier: Tier, preference: AutoPreference, fableForHardest: boolean): Slot[] {
  const route = ROUTING_TABLE[category]
  let row = [...(tier === 3 && preference === 'balanced' && route.balancedHardest ? route.balancedHardest : route.tiers[tier])]
  if (tier === 3 && fableForHardest && route.fable === true && preference !== 'cheapest') row = ['fable', ...row.filter((s) => s !== 'fable')]
  if (preference === 'cheapest') row = row.map((s, i) => ({ s, i })).sort((a, b) => slotCost(a.s) - slotCost(b.s) || a.i - b.i).map((x) => x.s)
  return row
}

const name = (m: ModelInfo): string => m.label || m.id

// ---------------------------------------------------------------------------------------------------
// What no Auto pick may be (hard rules, on top of the keys, the budget, vision and the window).
// ---------------------------------------------------------------------------------------------------

/**
 * Grok is never Auto's pick for computer use (no computer-use result on any board) or voice (9.9 s to the
 * first token at low effort, AA). Picked by name it is used as picked.
 */
export const noGrokFor = (task: Pick<TaskClass, 'category' | 'lowLatency'>): boolean => task.category === 'computer-use' || task.category === 'voice' || !!task.lowLatency
const isXai = (m: ModelInfo): boolean => m.provider === 'xai' || !!xaiInfo(bareId(m.id))

/** Why Auto has nothing for computer use or voice when only Grok is on. */
export const GROK_ONLY_MESSAGE = (cat: TaskCategory): string => cat === 'computer-use'
  ? 'Auto won\'t use Grok for computer use: xAI publishes no computer-use results for it, and it isn\'t tuned to drive a screen. Add a Claude or OpenAI key (or turn on local models), or pick Grok by name for this chat.'
  : 'Auto won\'t use Grok for voice: it takes about 10 seconds to start a reply (Artificial Analysis), too slow for a spoken conversation. Add a Claude or OpenAI key, turn on local models, or choose Grok as the voice model in Settings → Models.'

/** The ChatGPT plan (Codex) passes images that tools return back to the model as text only (docs/chatgpt-plan.md). */
const PLAN_BLIND = 'the ChatGPT plan can\'t pass screenshots back to the model, so it works from page text'

// ---------------------------------------------------------------------------------------------------
// Balanced's close calls, and stability across a conversation.
// ---------------------------------------------------------------------------------------------------

/**
 * A close call: the classifier isn't sure of the request (confidence below CONFIDENT: it may well be a tier
 * harder), or it has stakes (legal, medical, money, production) at difficulty 1 or more. On Balanced, a close
 * call takes Best result's pick when that costs at most CLOSE_CALL_PRICE (2x) as much, blended at 3 input : 1
 * output tokens, and its first token comes at most 1 s later for speed-sensitive requests (chat, quick code
 * questions, voice) or 3 s later for everything else (TTFT_S below). Otherwise Balanced keeps its own pick.
 */
export const closeCall = (t: Pick<TaskClass, 'confident' | 'difficulty' | 'signals'>): boolean => !t.confident || (!!t.signals?.stakes && t.difficulty >= 1)
export const CLOSE_CALL_PRICE = 2
export const closeCallLatency = (speedSensitive: boolean): number => (speedSensitive ? 1 : 3)
const SPEEDY = new Set<TaskCategory>(['chat', 'code-quick', 'voice'])

/** Seconds to the first answer token at low effort (AA, IND, read 2026-11-15; Fable has no figure: Opus's). */
export const TTFT_S: Record<Slot, number> = { luna: 1.57, terra: 1.96, sonnet: 2.5, sol: 3.22, astra: 3.82, opus: 5.32, fable: 5.32, haiku: 6.26, grok: 9.9 }
export const slotTtft = (s: Slot): number => TTFT_S[s]

/** $ per 1M tokens, blended 3 input : 1 output (the ChatGPT plan and local models: 0). */
export function slotPrice(m: ModelInfo): number {
  if (!payPerUse(m)) return 0
  const p = m.price ?? priceOfSlot(slotOf(m))
  return p ? (3 * p.input + p.output) / 4 : Infinity
}
function priceOfSlot(slot: Slot | undefined): { input: number; output: number } | undefined {
  if (!slot) return undefined
  if (slot === 'grok') return xaiInfo('grok-4.7')?.price
  const fams = SLOT_FAMILY[slot]
  const spec = fams ? CLAUDE.find((c) => fams.includes(c.family) && c.current && c.price) : OPENAI.find((o) => o.role === slot && o.current)
  return spec?.price
}

/** Requests that belong to the same piece of work (a code question inside a coding session, a report's prose). */
const RELATED: ReadonlyArray<[TaskCategory, TaskCategory]> = [['coding', 'code-quick'], ['office', 'writing'], ['research', 'long-context']]
const related = (a: TaskCategory, b: TaskCategory): boolean => a === b || RELATED.some(([x, y]) => (x === a && y === b) || (x === b && y === a))

/**
 * Whether a follow-up keeps the chat's previous model instead of the fresh pick (prompt caches are per model:
 * a switch re-sends the whole history uncached and, across providers, drops the provider-specific parts of it).
 * Kept when the request continues the same work (a follow-up, the same or a related category, or a light chat
 * turn: chat at difficulty 0-1) and the previous model is as good a choice for it:
 *   - light chat: the previous model is at least the fresh pick's tier;
 *   - otherwise: it is at least as strong for this category (no later in the category's hardest row on Best
 *     result, which orders the models by measured quality), or tied with the fresh pick there (ties);
 *   - a local model stays for light chat, or when the fresh pick is local too, if it is strong enough for the
 *     tier (no second model to load); a pay-per-use model never keeps a light chat turn from a free local one
 *     (Local first);
 *   - on Cheapest, only when it costs no more than the fresh pick.
 * Only among models that pass every hard rule above.
 */
export function keepPrevious(prev: ModelInfo, fresh: ModelInfo, task: TaskClass, prevCategory: TaskCategory | undefined, tier: Tier, fableOn: boolean, preference: AutoPreference = 'best'): boolean {
  const lightChat = task.category === 'chat' && task.difficulty <= 1
  if (!(task.rule === 'follow-up' || lightChat || (prevCategory && related(prevCategory, task.category)))) return false
  if (preference === 'cheapest' && slotPrice(prev) > slotPrice(fresh)) return false
  if (!remote(prev)) return prev.tier >= tier && (lightChat || !remote(fresh))
  if (!remote(fresh)) return lightChat && !payPerUse(prev)
  // A light turn never stays on a model that costs much more than the fresh pick (one hard turn on Opus
  // shouldn't keep "thanks!" there).
  if (lightChat) return prev.tier >= fresh.tier && slotPrice(prev) <= CLOSE_CALL_PRICE * slotPrice(fresh) + 1e-9
  const ps = slotOf(prev), fs = slotOf(fresh)
  if (!ps || !fs) return prev.tier >= fresh.tier && (prev.rank ?? 0) >= (fresh.rank ?? 0)
  const hardest = slotsFor(task.category, 3, 'best', fableOn)
  const order = [...hardest, ...(['fable', 'opus', 'astra', 'sonnet', 'sol', 'grok', 'terra', 'haiku', 'luna'] as Slot[]).filter((s) => !hardest.includes(s))]
  if (order.indexOf(ps) <= order.indexOf(fs)) return true
  return !!ROUTING_TABLE[task.category].ties?.some((g) => g.includes(ps) && g.includes(fs))
}

/**
 * The model for a classified request, from the models Auto may use (Endpoints.usable()). undefined: nothing
 * to route to. Never calls a model.
 */
export function routeTask(models: ModelInfo[], task: TaskClass, o: RouteOptions = {}): RoutePick | undefined {
  const variant = o.variant ?? 'auto'
  let pool = autoPool(variant, models).filter((m) => m.installed !== false)
  // Monthly limit None: no pay-per-use model at all (the ChatGPT plan and local models only), and say why.
  if (spendingPrefs.mode === 'none') {
    pool = pool.filter((m) => !payPerUse(m))
    if (!pool.length) throw Object.assign(new Error(NONE_ROUTE_MESSAGE), { spending: 'none' })
  }
  if (!pool.length) return undefined
  // Little budget left routes as Cheapest, to make it last: only while something pay-per-use could be picked.
  const tight = !!o.budgetTight && pool.some(payPerUse)
  // School work (homework, studying, a school subject) needs a fast, low-cost model, not the strongest one:
  // the cheapest strong-enough model, and only a mid-tier one for the biggest assignments (a paper, a project).
  // (A "Best result" the user chose is kept as chosen.)
  const asked: AutoPreference = o.preference ?? 'best'
  const study = asked !== 'best' && isStudy(task)
  const preference: AutoPreference = tight || (study && asked === 'cheapest') ? 'cheapest' : study ? (task.difficulty >= 3 ? 'balanced' : 'cheapest') : asked
  const cloudFirst = variant === 'auto:cloud' || (variant === 'auto' && (o.preferCloud ?? routingPrefs.preferCloud))
  const fableOn = o.fableForHardest ?? routingPrefs.fableForHardest
  const notes: string[] = []

  // Hard rules: never Grok for computer use or voice; premium models (Fable without its setting, GPT Pro) only
  // when nothing else is on; the ChatGPT plan for computer use only when nothing else can see the screen.
  if (noGrokFor(task)) {
    const rest = pool.filter((m) => !isXai(m))
    if (!rest.length) throw Object.assign(new Error(GROK_ONLY_MESSAGE(task.category === 'computer-use' ? 'computer-use' : 'voice')), { grokOnly: true })
    pool = rest
  }
  const premium = (m: ModelInfo): boolean => isPremiumOpenAI(bareId(m.id)) || (!fableOn && isPremiumClaude(bareId(m.id)))
  if (pool.some((m) => !premium(m))) pool = pool.filter((m) => !premium(m))
  if (task.category === 'computer-use') {
    const seeing = pool.filter((m) => !isPlanModel(m.id) && m.provider !== 'chatgpt')
    if (seeing.length) pool = seeing
    else notes.push(PLAN_BLIND)
  }
  // It must see the images, and the prompt must fit its window (if none fits, the biggest).
  if (task.needsVision && pool.some((m) => m.vision)) pool = pool.filter((m) => m.vision)
  const need = task.contextTokens > 0 ? task.contextTokens + REPLY_ROOM : 0
  if (need) {
    const fit = pool.filter((m) => windowOf(m) >= need)
    if (fit.length) pool = fit
    else {
      const most = Math.max(...pool.map(windowOf))
      pool = pool.filter((m) => windowOf(m) === most)
    }
  }

  const tier = study && task.difficulty >= 3 && !tight ? 2 : routeTier(task.category, task.difficulty, preference)
  const cat = CATEGORY_LABEL[task.category]
  const result = (model: ModelInfo, source: RoutePick['source'], note?: string): RoutePick => ({
    model, category: task.category, difficulty: task.difficulty, tier, preference, source,
    label: `${name(model)} · ${cat}`,
    why: [task.why, note, ...notes, study ? 'school work' : preference !== 'best' ? PREFERENCE_LABEL[preference].toLowerCase() : undefined, tight ? 'little of the monthly limit left' : undefined].filter(Boolean).join(' · ')
  })

  const cloud = pool.filter(remote)
  // Within a slot the newest model wins; the same model on the ChatGPT plan before the pay-per-use API (no
  // per-token charge).
  const bySlot = (slot: Slot, from: ModelInfo[] = cloud): ModelInfo | undefined => from
    .filter((m) => slotOf(m) === slot && !isPremiumOpenAI(bareId(m.id)) && m.tools !== false)
    .sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0) || (slot === 'grok' ? (xaiInfo(bareId(b.id))?.gen ?? 0) - (xaiInfo(bareId(a.id))?.gen ?? 0) : 0) || Number(payPerUse(a)) - Number(payPerUse(b)))[0]
  const fresh = ((): RoutePick | undefined => {
    const local = pool.filter((m) => !remote(m))
    // Local first (Auto (local), Local first, or Cheapest): a free local model when one is strong enough.
    // Agent work goes to the cloud whenever a cloud model is on, even on Local first: heavy agentic runs need
    // the strongest model (small local ones are for quick chats and light work). Cheapest still tries local.
    const agentWork = task.difficulty >= 2 && task.category !== 'chat' && task.category !== 'voice'
    const localFirst = variant === 'auto' && local.length > 0 && (preference === 'cheapest' || (!cloudFirst && !(agentWork && cloud.length)))
    if (variant === 'auto:local' || localFirst) {
      const p = pick(local, tier, { preferCloud: false })
      if (p && (variant === 'auto:local' || p.tier >= tier || !cloud.length)) return result(p, 'local', variant === 'auto:local' ? undefined : 'free and private')
    }
    // The table: each slot in order, then the same category's rows above, then below.
    const order: Tier[] = [tier, ...([1, 2, 3].map((d) => tier + d).filter((t) => t <= 3) as Tier[]), ...([1, 2, 3].map((d) => tier - d).filter((t) => t >= 0) as Tier[])]
    for (const t of order) {
      // Premium Claude (Fable) is only in a row when the setting puts it there (the hardest tier).
      for (const slot of slotsFor(task.category, t, preference, fableOn)) {
        if (study && STUDY_SKIPS.has(slot)) continue
        const m = bySlot(slot)
        if (m) return result(m, 'table')
      }
    }
    // Nothing the table names (OpenRouter models by name, only local models…): the tier-based pick.
    const p = pick(pool, tier, { preferCloud: cloudFirst, premiumHardest: fableOn })
    return p ? result(p, 'fallback') : undefined
  })()
  if (!fresh) return undefined

  // Stability: the chat's previous model when it is as good a choice (keepPrevious); else, rather than a switch
  // of provider, a model of the previous one's provider from this row that is as good a choice.
  if (o.previous && o.previous.model !== fresh.model.id) {
    const prev = pool.find((m) => m.id === o.previous!.model && m.tools !== false)
    if (prev && keepPrevious(prev, fresh.model, task, o.previous.category, tier, fableOn, preference)) return result(prev, 'sticky', 'same model as the last reply (its prompt cache stays warm)')
    const provider = (prev ?? models.find((m) => m.id === o.previous!.model))?.provider
    if (provider && remote(fresh.model) && fresh.model.provider !== provider) {
      const mine = cloud.filter((m) => m.provider === provider)
      const alt = slotsFor(task.category, tier, preference, fableOn).map((slot) => bySlot(slot, mine)).find((m) => m && keepPrevious(m, fresh.model, task, o.previous!.category, tier, fableOn, preference))
      if (alt) return result(alt, 'sticky', 'same provider as the last reply')
    }
  }

  // Balanced, close call: Best result's pick when it costs at most 2x and isn't much slower (closeCall).
  if (preference === 'balanced' && !study && !o.noCloseCall && closeCall(task) && remote(fresh.model)) {
    const best = routeTask(pool, task, { ...o, preference: 'best', budgetTight: false, previous: undefined, noCloseCall: true })
    const bs = best && remote(best.model) ? slotOf(best.model) : undefined
    const fs = slotOf(fresh.model)
    if (best && bs && fs && best.model.id !== fresh.model.id && slotPrice(best.model) <= CLOSE_CALL_PRICE * slotPrice(fresh.model) + 1e-9 &&
      slotTtft(bs) <= slotTtft(fs) + closeCallLatency(SPEEDY.has(task.category) || !!task.lowLatency)) {
      return result(best.model, 'close-call', `close call: the stronger model for at most ${CLOSE_CALL_PRICE}x the price`)
    }
  }
  return fresh
}

/** Whether a model is one Auto treats as premium (priced well above the rest). */
export const premiumModel = (id: string): boolean => isPremiumClaude(bareId(id)) || isPremiumOpenAI(bareId(id))

/** The Auto prefers setting (Settings → Models), Balanced by default: the cheapest model strong enough for the request. */
export function autoPreference(s: { cloud?: { autoPrefers?: string } }): AutoPreference {
  const v = s.cloud?.autoPrefers
  return v === 'best' || v === 'cheapest' ? v : 'balanced'
}

/** The most expensive models, never needed for school work (the table falls through to the next slot). */
const STUDY_SKIPS: ReadonlySet<Slot> = new Set<Slot>(['fable', 'opus', 'astra'])

/** School work routed as such: not code, the screen or CAD, and nothing at stake. */
export const isStudy = (task: Pick<TaskClass, 'category' | 'signals'>): boolean =>
  !!task.signals?.study && !task.signals.stakes && task.category !== 'coding' && task.category !== 'code-quick' && task.category !== 'computer-use' && task.category !== 'cad' && task.category !== 'voice'
