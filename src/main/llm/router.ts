import type { Attachment, ModelInfo, Tier } from '@shared/types'
import { isPremiumClaude } from './claude-models'
import { isPremiumOpenAI } from './openai-models'
import { RECOMMENDED } from './catalog'

// Auto mode: decide how hard a request is, then send it to the cheapest model that is strong enough.
// Rules first (instant, free, predictable). When the rules don't clearly decide, it goes one tier UP:
// a slightly slower answer beats a wrong one.

export interface RouteInput {
  text: string
  attachments?: Attachment[]
  images?: number
  /** Tier used for the previous request in this conversation (follow-ups keep it). */
  previousTier?: Tier
  /** Real-time voice conversation: favor fast replies. */
  voice?: boolean
  /** The conversation already has an open plan (a task in progress). */
  openPlan?: boolean
}

export interface Route {
  tier: Tier
  confident: boolean
  why: string
}

const has = (re: RegExp, t: string): boolean => re.test(t)

const SMALL_TALK = /^(hi|hey|hello|yo|sup|hiya|thanks|thank you|thx|ty|ok|okay|k|cool|nice|great|awesome|perfect|lol|haha|good (morning|afternoon|evening|night)|gm|gn|bye|see you|how are you|what'?s up|got it|sounds good|no worries|np)\b[\s!.?,]*(foreman|buddy|man|dude|there)?[\s!.?]*$/i
const FOLLOW_UP = /^(yes|yeah|yep|sure|do it|go ahead|go for it|continue|keep going|carry on|proceed|try again|again|retry|fix (it|that|this)|that'?s wrong|no[,.]? |not quite|redo|make it (better|shorter|longer)|more|next)\b/i
/** Facts that change: needs a live lookup and careful citing. */
const LIVE_FACTS = /\b(latest|current(ly)?|today|tonight|tomorrow|yesterday|this (week|month|year)|right now|news|price|prices|cost of|stock|weather|score|schedule|release date|who (is|are) the (current|new)|recent(ly)?|202\d|up[- ]to[- ]date|look (it )?up|search|google|research|find out|sources?|cite)\b/i
const TASK = /\b(create|make|build|write|draft|generate|design|produce|prepare|put together|set up|setup|organi[sz]e|clean up|rename|move|convert|summari[sz]e (this|the|my)|fill( out| in)?|send|email|reply to|book|schedule|remind|log ?in|sign ?in|download|upload|post|order|buy|automate|install|deploy|fix|debug|refactor|implement|translate (this|the) (file|document))\b/i
/** Something a task acts on. A task verb without one ("move to a new city") is probably just conversation. */
const OBJECT = /\b(files?|folders?|documents?|docs?|pdfs?|emails?|e-mails?|inbox|messages?|calendar|events?|meetings?|reminders?|notes?|websites?|site|page|link|url|spreadsheets?|sheets?|slides?|decks?|photos?|images?|screenshots?|repo|codebase|tabs?|browser|account|tickets?|invoices?|drafts?|tweets?|forms?|cursor|desktop|downloads)\b|https?:\/\/|~\/|\/[\w-]+\//i
/** Verbs that are a task on their own. */
const SELF_TASK = /\b(remind me|set (a|an) (reminder|alarm|timer)|schedule (a|an|my)|email (\w+)|text (\w+) (that|to|saying)|log ?in|sign ?in|book (a|an|me)|order (a|an|me|some))\b/i
const ARTIFACT = /\b(report|document|doc|docx|pdf|presentation|deck|slides?|pptx|spreadsheet|excel|xlsx|csv|website|web ?site|landing page|app|script|program|database|resume|cv|contract|proposal|business plan|newsletter|itinerary|budget|invoice|email campaign)\b/i
const CODE = /```|\b(function|class|const|import|def|return|stack ?trace|traceback|exception|error:|TypeError|null pointer|segfault|compile|regex|sql|api|endpoint|repo|git|typescript|javascript|python|rust|swift|kotlin|react|node)\b|\.(ts|tsx|js|py|rs|go|swift|java|cpp|rb|php|sql)\b/i
const HARD = /\b(architecture|design (a|the) system|from scratch|end[- ]to[- ]end|entire|whole (app|codebase|project)|complex|complicated|in[- ]depth|thorough(ly)?|comprehensive|detailed analysis|step[- ]by[- ]step|prove|proof|derive|optimi[sz]e|trade-?offs?|strategy|legal|lawsuit|contract review|diagnos|medical|tax(es)?|financial (model|analysis)|investment|think (hard|carefully|deeply)|best possible|perfect(ly)?|carefully|multi-?step|compare .+ (and|vs\.?|versus) .+|pros and cons)\b/i
const MATH = /(\d+\s*[-+*/^]\s*\d+.*[-+*/^]|\b(integral|derivative|equation|probability|statistic|matrix|calculate|compute|solve for)\b)/i
const MULTI = /\b(and then|after that|then|also|plus|as well as|first|second|finally|step \d|\n\s*[-*\d]+[.)]?\s)/i

export function classify(input: RouteInput): Route {
  const t = input.text.trim()
  const words = t.split(/\s+/).filter(Boolean).length
  const sentences = t.split(/[.!?\n]+/).filter((x) => x.trim().length > 3).length
  const folders = (input.attachments ?? []).filter((a) => a.kind === 'folder').length
  const files = (input.attachments ?? []).filter((a) => a.kind !== 'folder' && a.kind !== 'image').length
  const images = (input.images ?? 0) + (input.attachments ?? []).filter((a) => a.kind === 'image').length

  // Follow-ups ("yes", "do it", "fix that") continue the previous work at the same strength.
  if (input.previousTier !== undefined && words <= 12 && FOLLOW_UP.test(t)) return { tier: input.previousTier, confident: true, why: 'follow-up to the last request' }
  if (input.openPlan && words <= 20) return { tier: Math.max(2, input.previousTier ?? 2) as Tier, confident: true, why: 'continuing a task in progress' }

  // Hard signals.
  if (folders) return { tier: 3, confident: true, why: 'works with a folder of files' }
  if (has(HARD, t) && (has(TASK, t) || has(CODE, t) || words > 25)) return { tier: 3, confident: true, why: 'complex task' }
  if (has(CODE, t) && (has(TASK, t) || words > 60)) return { tier: words > 150 || sentences > 6 ? 3 : 2, confident: words <= 150, why: 'coding' }
  if (has(TASK, t) && has(ARTIFACT, t)) return { tier: has(MULTI, t) || words > 60 ? 3 : 2, confident: true, why: 'makes a file or document' }
  if (has(TASK, t) && (has(OBJECT, t) || has(SELF_TASK, t)) && (has(MULTI, t) || sentences >= 3)) return { tier: 3, confident: false, why: 'multi-step task' }
  if (words > 250) return { tier: 3, confident: false, why: 'long, detailed request' }
  if (has(MATH, t) || has(HARD, t)) return { tier: 3, confident: false, why: 'needs careful reasoning' }

  // Middle: real work, but routine.
  if (files) return { tier: 2, confident: true, why: 'reads attached files' }
  if ((has(TASK, t) && has(OBJECT, t)) || has(SELF_TASK, t)) return { tier: 2, confident: true, why: 'a task with tools' }
  if (has(TASK, t)) return { tier: 1, confident: false, why: 'might be a task' }
  if (has(LIVE_FACTS, t)) return { tier: 2, confident: true, why: 'needs fresh facts from the web' }
  if (images) return { tier: 2, confident: true, why: 'looks at an image' }

  // Light: conversation and quick questions.
  if (SMALL_TALK.test(t) || (words <= 4 && !t.includes('?'))) return { tier: input.voice ? 0 : 0, confident: true, why: 'small talk' }
  if (words <= 25 && sentences <= 2) return { tier: 1, confident: words <= 15, why: 'quick question' }
  // Anything else: not sure.
  return { tier: 1, confident: false, why: 'general question' }
}

/** Uncertain → one tier up. Voice favors speed but never below what the request needs. */
export function decide(input: RouteInput): Route {
  const r = classify(input)
  const tier = (r.confident ? r.tier : Math.min(3, r.tier + 1)) as Tier
  return { ...r, tier, why: r.confident ? r.why : `${r.why} (not sure, so a stronger model)` }
}

/**
 * Auto's standing preference, refreshed from Settings by Endpoints.usable() (which the agent reads right
 * before every pick): 'cloud' sends each tier to the cloud model first (Claude Haiku for light requests,
 * Sonnet for standard ones, Opus for the hardest; with only an OpenAI key: GPT-6 Luna for small talk, 6.1
 * Terra for quick questions, 6.1 Sol for tasks, 6 Astra for the hardest), 'local' keeps free, private local
 * models first.
 */
export const routingPrefs: { preferCloud: boolean; fableForHardest: boolean } = { preferCloud: false, fableForHardest: false }

// ---------------------------------------------------------------------------------------------------
// Auto variants, stored as the model value of a chat, a bot or the default: 'auto' (best of both: local
// and cloud, in the order of the Auto prefers setting), 'auto:local' (only downloaded local models) and
// 'auto:cloud' (only keyed cloud models: Claude with an Anthropic key, GPT with an OpenAI key, OpenRouter
// models added by name with an OpenRouter key).
// ---------------------------------------------------------------------------------------------------

export type AutoVariant = 'auto' | 'auto:local' | 'auto:cloud'
export const AUTO_VARIANTS: AutoVariant[] = ['auto', 'auto:local', 'auto:cloud']

/** The Auto variant a model value means, or undefined for a concrete model ('' counts as Auto). */
export function autoVariant(id: string | null | undefined): AutoVariant | undefined {
  if (!id) return 'auto'
  return (AUTO_VARIANTS as string[]).includes(id) ? (id as AutoVariant) : undefined
}
export const isAuto = (id: string | null | undefined): boolean => autoVariant(id) !== undefined

const remoteModel = (m: ModelInfo): boolean => m.note === 'remote' || m.note === 'added by you' || m.provider === 'anthropic' || m.provider === 'openai' || m.provider === 'openrouter'

/** The models a variant may route among (from what Auto may use right now). */
export function autoPool(variant: AutoVariant, usable: ModelInfo[]): ModelInfo[] {
  if (variant === 'auto:local') return usable.filter((m) => !remoteModel(m))
  if (variant === 'auto:cloud') return usable.filter(remoteModel)
  return usable
}

/**
 * Why a variant has nothing to route to, in words for the picker and the chat (undefined: it's usable).
 * `cloud` says whether cloud models are on and which providers have a key.
 */
export function autoUnavailable(variant: AutoVariant, usable: ModelInfo[], cloud: { enabled: boolean; keyed: boolean }): string | undefined {
  if (autoPool(variant, usable).length) return undefined
  if (variant === 'auto:local') return 'No local models downloaded — open Settings → Models'
  if (variant === 'auto:cloud') return !cloud.enabled ? 'Cloud models are switched off — turn them on in Settings → General' : !cloud.keyed ? 'No cloud API key saved — add an Anthropic or OpenAI key in Settings → Models' : 'No cloud model is on — switch one on in Settings → Models'
  return 'No models are available — download one or add an API key in Settings → Models'
}

export interface PickOptions {
  /** Cloud models before local ones at the same tier (default: routingPrefs.preferCloud). */
  preferCloud?: boolean
  needsVision?: boolean
  /** Over the cloud budget: local models only. */
  localOnly?: boolean
  /** Explicit preference for a tier (e.g. the voice model setting). */
  prefer?: string
  /** "Use Fable for the hardest tasks": premium Claude first at the hardest tier (default: routingPrefs). */
  premiumHardest?: boolean
}

/**
 * The model for a tier: the best model AT that tier (local before cloud when equally good: free and
 * private, unless cloud is preferred); if none, the best one at the next tier up. Nothing strong enough:
 * the strongest available. Premium cloud models (Claude Fable/Mythos, priced well above Opus) come last
 * at their tier: Auto uses them only when nothing else is there; picking one by name always works.
 */
export function pick(models: ModelInfo[], tier: Tier, o: PickOptions = {}): ModelInfo | undefined {
  let pool = models.filter((m) => (!o.localOnly || m.note !== 'remote') && (!o.needsVision || m.vision))
  if (!pool.length && o.needsVision) pool = models.filter((m) => !o.localOnly || m.note !== 'remote')
  if (o.prefer) {
    const p = pool.find((m) => m.id === o.prefer)
    if (p && p.tier >= tier) return p
  }
  // Every run offers tools (even small talk can look things up), so prefer models that can call them.
  const capable = (m: ModelInfo): boolean => m.tools !== false
  const cloudFirst = o.preferCloud ?? routingPrefs.preferCloud
  const remote = (m: ModelInfo): number => Number(m.note === 'remote') * (cloudFirst ? -1 : 1)
  // Premium cloud models come last, except at the hardest tier when the user lets Auto use them there.
  const premiumFirst = tier === 3 && (o.premiumHardest ?? routingPrefs.fableForHardest)
  const premium = (m: ModelInfo): number => Number(m.note === 'remote' && isPremiumClaude(m.id)) * (premiumFirst ? -1 : 1)
  // OpenAI's pro models (GPT-5.5 Pro: $30 / $180) always come last: only picked by name.
  const pro = (m: ModelInfo): number => Number(isPremiumOpenAI(m.id))
  const best = (a: ModelInfo, b: ModelInfo): number =>
    pro(a) - pro(b) || premium(a) - premium(b) || remote(a) - remote(b) || (b.rank ?? 0) - (a.rank ?? 0) || (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0)
  // A light request with no model at its level goes up a tier: there, speed matters more than the last
  // bit of quality, so the fastest capable model wins (a mixture-of-experts with few active parameters).
  const speed = (m: ModelInfo): number => {
    const r = RECOMMENDED.find((x) => m.id === x.pull || m.id.startsWith(`${x.pull}-`))
    return r ? r.activeB ?? r.paramsB : (m.sizeBytes ?? 0) / 1e9 || Infinity
  }
  const fastest = (a: ModelInfo, b: ModelInfo): number => pro(a) - pro(b) || premium(a) - premium(b) || remote(a) - remote(b) || speed(a) - speed(b) || best(a, b)
  for (let t = tier; t <= 3; t++) {
    const at = pool.filter((m) => m.tier === t && capable(m) && !pro(m)).sort(t > tier && tier <= 1 ? fastest : best)
    if (at.length) return at[0]
  }
  const pool2 = pool.some(capable) ? pool.filter(capable) : pool
  return [...pool2].sort((a, b) => pro(a) - pro(b) || b.tier - a.tier || premium(a) - premium(b) || (b.rank ?? 0) - (a.rank ?? 0) || (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))[0]
}
