import type { Effort, ModelInfo, Tier } from '@shared/types'
import { CATEGORY_LABEL, TASK_CATEGORIES, type TaskCategory, type TaskClass, type TaskKind } from './task-classifier'
import { slotOf, windowOf, type AutoPreference, type Slot } from './routing-table'

// Auto's brain: before each request, the fastest cheap model the user has (GPT-6 Luna, GPT-6.1 Terra or Claude
// Haiku 5.5) reads the whole request with the conversation so far and decides what it is, how hard it is, how
// much to think, which model does it best for what it costs, and whether models should work on it together:
//   solo           one model does it;
//   plan           a strong planner (Fable, Opus, GPT-6.2 Astra) writes the plan, the executor carries it out;
//   review         the executor works, a second model reviews the draft before the user sees it;
//   plan+review    both.
// The rules (task-classifier.ts) stay the safety net: their decision is the fallback when the brain is slow,
// fails or answers outside the schema, and hard limits (keys, budget, vision, window, Grok, premium models)
// are checked here before any pick is used. Every model gets the whole conversation either way.

export const BRAIN_TIMEOUT_MS = 4000
/** Cheap brains, fastest first. The read runs without thinking (Haiku with adaptive thinking took 6.26 s to start). */
export const BRAIN_SLOTS: Slot[] = ['luna', 'terra', 'haiku']
/** How long the request waits for the read, by brain: a slower one gets longer instead of always losing to the rules. */
const BRAIN_WAIT: Partial<Record<Slot, number>> = { luna: 4000, terra: 4500, haiku: 6000 }
export const brainTimeout = (m: ModelInfo): number => BRAIN_WAIT[slotOf(m) as Slot] ?? BRAIN_TIMEOUT_MS
/** A read that misses the wait still finishes this long, so the same request's later turns use it. */
const BRAIN_LATE_MS = 25_000

export type TeamPlan = 'solo' | 'pair' | 'plan' | 'review' | 'plan+review' | 'debate'
const TEAMS: TeamPlan[] = ['solo', 'pair', 'plan', 'review', 'plan+review', 'debate']
/** What a request needs from a model. */
export const NEEDS = ['reasoning', 'coding', 'see-images', 'make-images', 'ideas', 'writing', 'research', 'computer-use', 'apps', 'quick'] as const
export type Need = (typeof NEEDS)[number]
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export interface BrainAnswer {
  category: TaskCategory
  kind: TaskKind
  difficulty: Tier
  effort: Effort
  study: boolean
  image: boolean
  model: string
  team: TeamPlan
  planner?: string
  reviewer?: string
  /** What it needs from a model (steers the pick; see-images makes vision a hard rule). */
  needs: Need[]
  /** With team "pair": the second model that works on it alongside. */
  partner?: string
  /** Parallel helpers for a job that splits into independent parts (0: none). */
  fanout: number
  /** The model the helpers run on. */
  helper?: string
  why: string
}

/**
 * What each model is for, in a line (the brain picks from these; the evidence is in docs/model-routing.md "The
 * models" and "Routing by task", plus this app's live runs of 2026-11-17: quick requests on Luna / Haiku, Astra
 * kept for the hardest work, Sonnet for routine coding, Opus for hard agentic coding and computer use, Sol for
 * routine research and reasoning).
 */
const STRENGTH: Record<Slot, string> = {
  fable: 'the strongest model: hardest reasoning, research synthesis and planning; premium price',
  opus: 'best at hard agentic coding, computer use, tool-heavy work with apps, writing and office documents',
  sonnet: 'fast flagship: routine coding, writing and everyday agent work at half Opus\' price',
  haiku: 'cheap and quick: school help, explanations, simple questions, light tool use',
  astra: 'OpenAI\'s strongest: only the hardest math, deep high-stakes research and very long documents (difficulty 3); 4x Sol\'s price',
  sol: 'everyday research, reasoning, math and images, near Astra on code at a quarter of its price',
  terra: 'quick and cheap: simple code questions, short writing, light tasks',
  luna: 'cheapest and fastest: small talk, quick facts, simple school questions',
  grok: 'documents and finance; slow to start, not for computer use or voice'
}

const price = (m: ModelInfo): string => (m.price ? `$${m.price.input}/$${m.price.output} per M` : m.note === 'remote' ? 'paid' : 'free (this Mac)')
const isCloud = (m: ModelInfo): boolean => m.note === 'remote' || m.note === 'added by you' || ['anthropic', 'openai', 'openrouter', 'xai', 'chatgpt'].includes(m.provider as string)

/** The fastest cheap cloud model that can run the brain (undefined: none, so the rules decide). */
export function brainModel(usable: ModelInfo[]): ModelInfo | undefined {
  for (const slot of BRAIN_SLOTS) {
    const m = usable.find((x) => isCloud(x) && slotOf(x) === slot && x.provider !== 'chatgpt')
    if (m) return m
  }
  return undefined
}

export interface BrainInput {
  text: string
  /** The conversation before this request, oldest first: who said what (tool steps as one line each). */
  history: Array<{ role: 'user' | 'assistant' | 'step'; text: string }>
  attachments: string[]
  images: number
  /** The bot answering: its name and job. */
  role?: string
  preference: AutoPreference
  /** Models Auto may use now. */
  models: ModelInfo[]
  /** The rules' first read (a hint the brain may overrule). */
  rules: TaskClass
  /** "claude-opus-5-5: 14/15 verified on coding" lines from this Mac's own outcomes. */
  outcomes?: string[]
  budgetTight?: boolean
}

/** The brain's prompt: the job, the models it can pick, the conversation, the request; JSON only. */
export function brainPrompt(i: BrainInput): { system: string; user: string } {
  const menu = i.models.map((m) => {
    const slot = slotOf(m)
    return `- ${m.id}: ${m.label ?? m.id} · ${price(m)} · ${Math.round(windowOf(m) / 1000)}K window${m.vision ? ' · sees images' : ''}${slot ? ` · ${STRENGTH[slot]}` : isCloud(m) ? '' : ' · runs on this Mac, weaker'}`
  }).join('\n')
  const pref = i.preference === 'best' ? 'the strongest model for the job' : i.preference === 'cheapest' ? 'the cheapest model that can still do it well' : 'the cheapest model that does it excellently (pay more only when it clearly matters)'
  const system = `You are Auto, the router inside SahilBot, an AI assistant on the user's Mac with tools (web, browser, files, terminal, the user's apps and connected accounts, documents, images). Read the whole request and the conversation, then decide how to handle it. You never answer or carry out the request yourself: another model does the work. Answer with one JSON object only, no prose.

Fields:
- needs: what this request needs from a model, from: ${NEEDS.join(', ')}. Match the model to the needs and the difficulty:
  reasoning, math, logic: GPT-6.2 Sol (GPT-6.2 Astra only at difficulty 3, Fable 5.2 only for the very hardest); coding: Sonnet 5.5 for routine work, Opus 5.5 for hard multi-file or agentic work; see-images: Opus 5.5 or GPT-6.2 Sol; make-images: any capable model (the image tool draws); ideas and creative writing: Opus 5.5 or Sonnet 5.5; research: GPT-6.2 Sol or Sonnet 5.5 (GPT-6.2 Astra only for deep, high-stakes research at difficulty 3); computer-use and apps: Opus 5.5 or Sonnet 5.5 (never Grok); quick: GPT-6 Luna, Haiku 5.5 or Terra.
- category: one of ${TASK_CATEGORIES.join(', ')} (${TASK_CATEGORIES.map((c) => `${c} = ${CATEGORY_LABEL[c]}`).join('; ')}).
- kind: "agent" if it needs tools, files, apps, the web, the screen or several steps; else "chat".
- difficulty: 0 small talk, 1 quick answer, 2 a standard task, 3 the hardest (multi-step, high stakes, long output, big code changes). Judge it by what the work really takes, never by the words used: how many separate things are asked, how many steps and tools, how much must be exactly right, how much there is to read, the expertise needed, and what a mistake costs. A short request can be hard ("why does this deadlock?", "prove it") and a long, chatty one easy.
- effort: how hard the model should think: low, medium, high, xhigh or max. Low for small talk, medium for explanations, high for real tasks, xhigh/max only for the hardest.
- study: true for school work (homework, studying, a class, a test, a school subject).
- image: true if the user wants a picture made or edited.
- model: the id of the model that should do the work, from the list. Prefer ${pref}. Size it to the work first, then the kind: difficulty 0-1 (a quick answer, a short email or message, a conversion, a translation, a simple fact, sum or lookup, even with a quick web search) gets a quick model whatever the category; save Opus, Sonnet, Astra and Sol for difficulty 2-3. School work and simple questions: a cheap fast model. Hard coding, computer use and agent work with apps: the strongest coding/agent model. Math and deep research: the strongest reasoning model.
- team: "solo" when one model can do it well. "pair" when two models together give a clearly better result at little extra cost: ideas, creative work, a tricky explanation, a plan worth a second opinion. Pair at the request's own level: two quick models (GPT-6 Luna with Claude Haiku 5.5) for light work, two strong ones (Claude Opus 5.5 with GPT-6.2 Astra) for hard work, from different providers when both are listed. "plan" when a hard multi-step task (difficulty 3) gains from a stronger model planning first. "review" when a deliverable with stakes gains from a second model checking it. "plan+review" only for the hardest, highest-stakes work. "debate" when the hard part is reasoning, not doing: a decision with real trade-offs, a strategy, a proof, the root cause of a tricky problem, where several models working in parallel and challenging each other's thinking gives a better answer.
- partner: with "pair", the second model's id (not the main model).
- planner / reviewer: model ids from the list, only with those teams. The planner should be the strongest reasoner (it writes a plan only); the reviewer a strong model from a different provider than the executor when one is listed.
- fanout: 0 for almost everything. For a big job that splits into independent parts that can be built or researched at the same time (a whole game, an app with several screens or systems, a report with several sections, comparing many options), the number of parallel helper agents, 2 to 8.
- helper: with fanout, the model id the helpers run on: a fast, capable model (Sonnet 5.5, GPT-6.2 Sol or Terra) unless the parts are hard.
- why: under 12 words.${i.budgetTight ? '\nLittle of the monthly budget is left: prefer cheaper models and "solo".' : ''}

Models:
${menu}${i.outcomes?.length ? `\n\nHow models did on this Mac lately:\n${i.outcomes.join('\n')}` : ''}`
  const convo = i.history.slice(-10).map((h) => `${h.role === 'user' ? 'User' : h.role === 'assistant' ? 'Assistant' : 'Step'}: ${h.text.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')
  const user = `${i.role ? `Bot: ${i.role}\n` : ''}${convo ? `Conversation so far:\n${convo}\n\n` : ''}${i.attachments.length || i.images ? `Attached: ${[...i.attachments, ...(i.images ? [`${i.images} image(s)`] : [])].join(', ')}\n` : ''}${i.rules.contextTokens && i.rules.contextTokens > 2000 ? `To read with it: about ${Math.round(i.rules.contextTokens / 1000)}K tokens\n` : ''}\nThe request to route (read it; do NOT answer it or do it):\n<request>\n${i.text.slice(0, 8000)}\n</request>\n\nReply with the JSON object only, like {"needs":["quick"],"category":"chat","kind":"chat","difficulty":1,"effort":"low","study":false,"image":false,"model":"<an id from the list>","team":"solo","fanout":0,"why":"<under 12 words>"}`
  return { system, user }
}

/**
 * The JSON object in a reply: the object itself (fenced or with a little prose around it), or the same fields
 * written as `key: value` lines (fast models sometimes drop the braces). Undefined when there is neither.
 */
function readObject(reply: string): Record<string, unknown> | undefined {
  const t = reply.trim().replace(/^```(?:json)?\s*|```$/g, '')
  // The widest {...} that parses (prose after it may hold braces of its own).
  const start = t.indexOf('{')
  if (start >= 0) {
    for (let end = t.lastIndexOf('}'); end > start; end = t.lastIndexOf('}', end - 1)) {
      try { return JSON.parse(t.slice(start, end + 1)) as Record<string, unknown> } catch { /* a shorter span */ }
    }
  }
  const out: Record<string, unknown> = {}
  for (const line of t.split('\n')) {
    const kv = line.match(/^\s*"?([a-z]+)"?\s*:\s*(.+?)\s*,?\s*$/i)
    if (!kv) continue
    try { out[kv[1]] = JSON.parse(kv[2]) } catch { out[kv[1]] = kv[2].replace(/^["']|["']$/g, '') }
  }
  return 'category' in out && 'model' in out ? out : undefined
}

/** The brain's reply, strictly checked: every field valid, every model id one it was offered. */
export function parseBrain(reply: string, models: ModelInfo[]): BrainAnswer | undefined {
  const j = readObject(reply)
  if (!j) return undefined
  const ids = new Set(models.map((x) => x.id))
  const id = (v: unknown): string | undefined => (typeof v === 'string' && ids.has(v) ? v : undefined)
  if (!TASK_CATEGORIES.includes(j.category as TaskCategory)) return undefined
  if (j.kind !== 'chat' && j.kind !== 'agent') return undefined
  if (!Number.isInteger(j.difficulty) || (j.difficulty as number) < 0 || (j.difficulty as number) > 3) return undefined
  if (!EFFORTS.includes(j.effort as Effort)) return undefined
  const model = id(j.model)
  if (!model) return undefined
  const team: TeamPlan = TEAMS.includes(j.team as TeamPlan) ? j.team as TeamPlan : 'solo'
  return {
    category: j.category as TaskCategory, kind: j.kind, difficulty: j.difficulty as Tier, effort: j.effort as Effort,
    study: j.study === true, image: j.image === true, model, team,
    planner: team.includes('plan') ? id(j.planner) : undefined,
    reviewer: team.includes('review') ? id(j.reviewer) : undefined,
    needs: Array.isArray(j.needs) ? (j.needs as unknown[]).filter((x): x is Need => NEEDS.includes(x as Need)).slice(0, 6) : [],
    partner: team === 'pair' ? id(j.partner) : undefined,
    fanout: Number.isInteger(j.fanout) && (j.fanout as number) >= 2 ? Math.min(8, j.fanout as number) : 0,
    helper: id(j.helper),
    why: typeof j.why === 'string' ? j.why.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
  }
}

/** Categories whose work is never light (the classifier's own floor). */
const FLOOR2: ReadonlySet<TaskCategory> = new Set<TaskCategory>(['coding', 'computer-use', 'long-context'])

/**
 * The decision with the brain's read folded in. The brain replaces the rules' category, difficulty and effort
 * (it read the whole thing), within the rules' hard floors: agent work never becomes a chat, coding and computer
 * use stay at difficulty 2 or more, attached folders keep the hardest tier, and a mode's floor stays.
 */
export function applyBrain(d: TaskClass, a: BrainAnswer, brainLabel: string): TaskClass {
  const forced = /attach|folder|is on|Plan first|Deep Research|team task|Heavy|Council/.test(`${d.why} ${d.kindWhy}`)
  let difficulty = a.difficulty
  if ((FLOOR2.has(a.category) || FLOOR2.has(d.category)) && difficulty < 2) difficulty = 2
  if (forced && difficulty < d.difficulty) difficulty = d.difficulty
  const kind: TaskKind = d.kind === 'agent' || a.kind === 'agent' || a.image || a.needs.includes('make-images') || a.needs.includes('computer-use') ? 'agent' : 'chat'
  const voice = a.category === 'voice' || d.category === 'voice'
  const effort: Effort = voice ? (difficulty >= 3 ? 'medium' : 'low') : a.effort
  return {
    ...d, category: voice ? 'voice' : a.category, difficulty: difficulty as Tier, kind, effort,
    kindWhy: kind === d.kind ? d.kindWhy : 'read by Auto: needs tools',
    // School work if either read says so; stakes the rules found always stay (the brain can't clear them).
    signals: { ...d.signals, study: a.study || d.signals.study || undefined, stakes: d.signals.stakes },
    why: `${CATEGORY_LABEL[voice ? 'voice' : a.category]} · read by ${brainLabel}${a.why ? `: ${a.why}` : ''}`,
    rule: `${d.rule}+brain`, confident: true, confidence: Math.max(d.confidence, 0.9),
    needsVision: d.needsVision || a.needs.includes('see-images')
  }
}

export interface PickLimits {
  /** Models that pass every hard rule for this request (usable, sees images, fits, allowed by the budget). */
  allowed: ModelInfo[]
  /** The routing table's pick for the same request. */
  tablePick: ModelInfo
  preference: AutoPreference
  difficulty: Tier
  fableOn: boolean
}

const cost = (m: ModelInfo): number => (m.price ? (3 * m.price.input + m.price.output) / 4 : 0)

/**
 * Whether the brain's model is used instead of the table's: it must pass every hard rule, never be a premium
 * model without the Fable setting, never be GPT Astra below difficulty 3 unless the table picked Astra itself (live,
 * 2026-11-17: a 120-word blurb ran 33 Astra requests), never cost over 4x the table's pick for a light request
 * (difficulty 0-1), and on Cheapest never cost more than the table's pick.
 */
export function acceptBrainModel(id: string, l: PickLimits): ModelInfo | undefined {
  const m = l.allowed.find((x) => x.id === id)
  if (!m) return undefined
  if (slotOf(m) === 'fable' && !l.fableOn && slotOf(l.tablePick) !== 'fable') return undefined
  if (slotOf(m) === 'astra' && l.difficulty < 3 && slotOf(l.tablePick) !== 'astra') return undefined
  if (l.difficulty <= 1 && cost(m) > 4 * Math.max(cost(l.tablePick), 0.05)) return undefined
  if (l.preference === 'cheapest' && cost(m) > cost(l.tablePick) + 1e-9) return undefined
  return m
}

export interface TeamPick { planner?: ModelInfo; reviewer?: ModelInfo; fanout?: { n: number; helper: ModelInfo }; debate?: boolean; partner?: ModelInfo }

/**
 * The helpers a team gets: only for agent work at difficulty 2+ (planning at 3), never on a tight budget, never
 * the executor itself. A planner must be at least as strong as the executor; Fable plans only the hardest tasks.
 */
export function teamFor(a: BrainAnswer, executor: ModelInfo, l: { allowed: ModelInfo[]; difficulty: Tier; kind: TaskKind; budgetTight?: boolean; fableOn: boolean }): TeamPick {
  if (l.budgetTight) return {}
  // A pair works at any level above small talk: Luna with Haiku for light work, Opus with Astra for hard work.
  if (a.team === 'pair') {
    const partner = a.partner && a.partner !== executor.id ? l.allowed.find((m) => m.id === a.partner && isCloud(m) && slotOf(m) !== 'fable') : undefined
    return partner && l.difficulty >= 1 && partner.tier >= executor.tier - 1 ? { partner } : {}
  }
  if (l.difficulty < 2) return {}
  // Several models reasoning together (Council): hard thinking, with at least two cloud models to sit.
  if (a.team === 'debate') return l.allowed.filter(isCloud).length >= 2 ? { debate: true } : {}
  if (l.kind !== 'agent') return {}
  // Parallel helpers: on a capable model the hard rules allow (never premium), the executor's own when none is named.
  const helper = a.fanout >= 2 ? (l.allowed.find((m) => m.id === a.helper && isCloud(m) && slotOf(m) !== 'fable' && m.tier >= 1) ?? executor) : undefined
  const fanout = helper ? { fanout: { n: a.fanout, helper } } : {}
  if (a.team === 'solo') return fanout
  const find = (id?: string): ModelInfo | undefined => (id && id !== executor.id ? l.allowed.find((m) => m.id === id && isCloud(m)) : undefined)
  let planner = a.team.includes('plan') && l.difficulty >= 3 ? find(a.planner) : undefined
  if (planner && (planner.tier < executor.tier || (slotOf(planner) === 'fable' && l.difficulty < 3))) planner = undefined
  const reviewer = a.team.includes('review') ? find(a.reviewer) : undefined
  return { ...(planner ? { planner } : {}), ...(reviewer ? { reviewer } : {}), ...fanout }
}

/** One brain answer per message (null: asked, no usable answer). */
export class BrainCache {
  private m = new Map<string, BrainAnswer | null>()
  private inflight = new Map<string, Promise<BrainAnswer | null>>()
  constructor(private cap = 300) {}
  get(id: string): BrainAnswer | null | undefined { return this.m.get(id) }
  set(id: string, a: BrainAnswer | null): void {
    this.inflight.delete(id)
    if (this.m.size >= this.cap) this.m.delete(this.m.keys().next().value as string)
    this.m.set(id, a)
  }
  pending(id: string): Promise<BrainAnswer | null> | undefined { return this.inflight.get(id) }
  reading(id: string, p: Promise<BrainAnswer | null>): void { this.inflight.set(id, p) }
}

export type BrainAsk = (o: { model: string; system: string; user: string; signal: AbortSignal }) => Promise<string>

/**
 * The brain's answer for a message. Never throws and never waits past the timeout: an error, a timeout or an
 * answer outside the schema returns undefined (the rules decide).
 */
export async function askBrain(o: { messageId: string; input: BrainInput; model: string; ask: BrainAsk; cache: BrainCache; timeoutMs?: number; lateMs?: number; signal?: AbortSignal }): Promise<{ answer?: BrainAnswer; ms: number; cached: boolean; late?: boolean }> {
  const start = Date.now()
  const hit = o.cache.get(o.messageId)
  if (hit !== undefined) return { answer: hit ?? undefined, ms: 0, cached: true }
  // Still reading this message (a turn that didn't wait for it): wait for that read instead of asking twice.
  let read = o.cache.pending(o.messageId)
  if (!read) {
    const ctrl = new AbortController()
    const late = setTimeout(() => ctrl.abort(), o.lateMs ?? BRAIN_LATE_MS)
    const { system, user } = brainPrompt(o.input)
    read = o.ask({ model: o.model, system, user, signal: ctrl.signal })
      .then((reply) => parseBrain(reply, o.input.models) ?? null, () => null)
      .then((a) => { clearTimeout(late); o.cache.set(o.messageId, a); return a })
    o.cache.reading(o.messageId, read)
  }
  // The run stopping only stops the wait; the read itself is cheap and serves the next turn.
  let timer: ReturnType<typeof setTimeout> | undefined
  const stopped = new Promise<'late'>((res) => {
    timer = setTimeout(() => res('late'), o.timeoutMs ?? BRAIN_TIMEOUT_MS)
    if (o.signal?.aborted) res('late')
    else o.signal?.addEventListener('abort', () => res('late'), { once: true })
  })
  const got = await Promise.race([read, stopped])
  if (timer) clearTimeout(timer)
  if (got === 'late') return { ms: Date.now() - start, cached: false, late: true }
  return { answer: got ?? undefined, ms: Date.now() - start, cached: false }
}

/** The quick, cheap models (the instant row's slots): what an obviously quick ask should land on. */
export const QUICK_SLOTS: ReadonlySet<Slot> = new Set<Slot>(['luna', 'haiku', 'terra'])
export const isQuickModel = (m: ModelInfo | undefined): boolean => !!m && (QUICK_SLOTS.has(slotOf(m) as Slot) || (!isCloud(m) && m.tier <= 1))

/**
 * No read needed (the rules' pick stands):
 *   - voice (replies must start at once);
 *   - small talk the rules read with confidence ("thanks so much, that was really helpful!", "hi", "tell me a
 *     joke"), or any confident instant request of a few words;
 *   - a short "yes, do it" / "continue" that carries on the request before it (the chat keeps its model and level);
 *   - an obviously quick ask (task-classifier.ts quickAsk: a sum, a unit conversion, a sentence to translate, a
 *     typo fix) when the rules already route it to a quick model (`quickPick`): the read could only confirm it.
 * Never with something attached.
 */
export const skipBrain = (text: string, d: Pick<TaskClass, 'difficulty' | 'category' | 'confident'> & { rule?: string; signals?: Pick<TaskClass['signals'], 'quick' | 'explicit'> }, attachments: number, o: { quickPick?: boolean } = {}): boolean => {
  const words = text.trim().split(/\s+/).length
  if (d.category === 'voice') return true
  if (attachments !== 0) return false
  if (d.confident && d.difficulty === 0 && (words <= 4 || d.rule === 'small-talk' || d.rule === 'empty')) return true
  if (d.rule === 'follow-up' && words <= 5) return true
  return !!d.signals?.quick && !d.signals.explicit && d.difficulty <= 1 && !!o.quickPick
}

/** How much a model costs to run, in one word, for the "Why this model" line. */
export type CostClass = 'quick' | 'standard' | 'premium'
const PREMIUM_SLOTS: ReadonlySet<Slot> = new Set<Slot>(['fable', 'opus', 'astra'])
export function costClass(m: ModelInfo | undefined): CostClass {
  if (!m) return 'standard'
  const slot = slotOf(m) as Slot | undefined
  if (slot) return QUICK_SLOTS.has(slot) ? 'quick' : PREMIUM_SLOTS.has(slot) ? 'premium' : 'standard'
  if (!isCloud(m)) return 'quick'
  const c = cost(m)
  return c <= 1 ? 'quick' : c >= 7 ? 'premium' : 'standard'
}

/** Who worked with the run's model on this request (Routed.team in agent/loop.ts). */
export interface TeamIds { planner?: string; reviewer?: string; fanout?: { n: number; helper: string }; debate?: boolean; partner?: string }

/**
 * The "Why this model" line shown on the model chip's hover: why Auto picked it (the brain's read, or the rule
 * that decided), who it teamed up with, and what it costs to run (quick / standard / premium). Short: one line.
 */
export function explainPick(o: { model?: ModelInfo; reason: string; team?: TeamIds; labelOf: (id: string) => string }): string {
  const t = o.team
  const parts = t ? [
    t.partner ? `with ${o.labelOf(t.partner)}` : '',
    t.planner ? `${o.labelOf(t.planner)} plans` : '',
    t.reviewer ? `${o.labelOf(t.reviewer)} reviews` : '',
    t.fanout ? `${t.fanout.n} helpers on ${o.labelOf(t.fanout.helper)}` : '',
    t.debate ? 'several models reason it out together' : ''
  ].filter(Boolean) : []
  const reason = o.reason.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '').slice(0, 140)
  return `Why this model: ${reason || 'the best fit Auto could find'}${parts.length ? ` · teamed up: ${parts.join(', ')}` : ''} · cost: ${costClass(o.model)}`
}
