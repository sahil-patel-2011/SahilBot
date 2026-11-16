import type { MaxStrategy } from '@shared/types'
import { classifyTask, type TaskCategory } from '../../llm/task-classifier'
import { planMax, strategyTitle, type MaxPlan } from './planner'

// Auto's "does this deserve teamwork?" (Max's Auto, in bots and every other chat). Teams cost several times a
// solo run and add minutes, so Auto is strict on small work and generous on big deliverables. Local rules, no
// model call: a size score from the request's own words, the classifier's difficulty and the attachments.
//
//   size  = deliverable (report, analysis, deck, whitepaper, due diligence…; the biggest one counts)
//         + breadth (N items, "all/every X", competitors, sources, a multi-part ask, many ideas)
//         + length (N pages / slides / words, comprehensive, detailed, sections) + files attached
//         + difficulty (3: +2, 0-1: -3) + a long request
//         - brevity (quick, short, brief, tl;dr, one line, just) - one small object ("this typo", "these 3 files")
//   stakes (judged attempts only) = the planner's heavy score + difficulty + "rigorous / exactly right / critical"
//
// Levels, calibrated on tests/unit/auto-teamwork.test.ts (80+ realistic prompts: small ones all land ≤ 4, a
// medium report 7-9, a broad market report or a 20-item comparison 10+):
//   solo   size < 7 (stakes < 9): one agent, nothing said.
//   hint   size ≥ 7 (stakes ≥ 9): the lead is told Max could help and calls the max tool only if it clearly
//          beats doing it alone.
//   start  size ≥ 10 (stakes ≥ 12): Auto turns Max on itself (as the composer's toggle would; source 'auto').
// Never more than a hint for code, computer use and the screen (parallel edits and clicks collide), on local
// models only, unattended runs (the lead decides within the routine budget), Plan first, or a tight budget.
// Under 10% of the monthly limit left, or less than $1: solo. Less than one team's cap left: a hint, ≤ 3 helpers.
// Helpers scale with the size (3 for a medium report, up to 8 for a very broad one; a third of the items or files,
// up to 10), never "max out"; the bot's Max helpers caps them.

export const HINT_AT = 7
export const START_AT = 10
export const HEAVY_HINT_AT = 9
export const HEAVY_START_AT = 12

export type TeamworkLevel = 'solo' | 'hint' | 'start'

export interface TeamworkContext {
  category?: TaskCategory
  difficulty?: number
  attachments?: number
  /** A cloud model carries the run (false: Auto (local) or a local model picked; a hint at most). */
  cloud?: boolean
  unattended?: boolean
  /** Plan first is on: the lead plans before anything runs (a hint at most). */
  planFirst?: boolean
  /** The monthly limit: tight = under 10% left (auto-route budgetTightFor); leftUsd undefined = no limit. */
  budget?: { tight?: boolean; leftUsd?: number }
  /** What one team may spend (Settings → swarm.maxUsd). */
  teamCapUsd?: number
  /** The most helpers allowed (the bot's Max helpers). */
  maxHelpers?: number
}

export interface TeamworkFit {
  level: TeamworkLevel
  /** The size score (or the stakes score for judged attempts). */
  size: number
  plan?: MaxPlan
  /** Helpers (team, swarm) or attempts (judged). */
  helpers?: number
  /** "big report → research team of 4" (the Max card and the lead's hint). */
  why: string
  signals: string[]
}

const NOUN = '(?:companies|vendors|tools|products|options|providers|states|countries|cities|schools|files|documents|pdfs|papers|apps|competitors|candidates|platforms|frameworks|libraries|models|suppliers|plans|brands|sites|websites|pages|articles|reviews|items|listings|practices|clinics|hospitals|startups|services|stocks|funds|universities|colleges|programs|modules|repos|repositories|contracts|reports|emails|transcripts|sheets|markets|regions|players|providers|cars|laptops|phones|cameras|hotels|restaurants|neighborhoods|jobs|roles|libraries|apis|integrations|features|stores|shops|agencies|firms|banks|lenders|insurers|plans|policies|laws|regulations|rules|grants|journals|studies|trials|drugs|treatments|devices|people|customers|leads|accounts|categories|segments|channels|keywords|domains)'
const IDEA = '(?:ideas|names|slogans|taglines|headlines|titles|concepts|options|ways|angles|hooks|captions|tweets|posts|prompts|questions|jokes|puns|themes|topics|subject lines)'

// The deliverable: the biggest one named counts (not their sum).
const DELIVERABLES: Array<[RegExp, number, string]> = [
  [/\b(market research|research (?:the|a|this) market|market (?:analysis|study|sizing|map)|competitive (?:analysis|landscape|intelligence|review)|competitor (?:analysis|research|review)|industry (?:report|analysis|overview)|due diligence|white ?paper|literature review|systematic review|research (?:report|paper|brief)|investment (?:memo|thesis)|business plan|feasibility study|go-to-market (?:plan|strategy)|strategy (?:report|document|deck))\b/, 5, ''],
  [/\b(landscape|dossier|playbook|handbook|e-?book|curriculum)\b/, 4, ''],
  [/\b(report|analysis|whitepaper|proposal|deck|slide deck|presentation|memo|business case|guide)\b/, 3, ''],
  [/\b(briefing|overview|survey|roadmap|(?:marketing|launch|content|strategic|project) plan)\b/, 2, '']
]
const DELIVERABLE_LABEL: Array<[RegExp, string]> = [
  [/\bbusiness plan\b/, 'business plan'], [/\bdue diligence\b/, 'due diligence'], [/\bwhite ?paper\b/, 'whitepaper'], [/\b(?:literature|systematic) review\b/, 'literature review'],
  [/\bmarket (?:research|analysis|study|sizing|map)\b|\bresearch (?:the|a|this) market\b/, 'market research'], [/\bcompetit\w+ (?:analysis|landscape|intelligence|review|research)\b/, 'competitive analysis'],
  [/\blandscape\b/, 'landscape'], [/\b(?:slide )?deck|presentation\b/, 'deck'], [/\bproposal\b/, 'proposal'],
  [/\breport\b/, 'report'], [/\bmemo\b/, 'memo'], [/\banalysis\b/, 'analysis'], [/\b(?:guide|handbook|playbook)\b/, 'guide']
]
const BREVITY = /\b(quick(?:ly)?|short(?!-term)|brief(?:ly)?|tl;?dr|one[- ]liner|one[- ]line|one sentence|a sentence|in a nutshell|a few words|a couple (?:of )?lines|at a glance|real quick|skim)\b/
const JUST = /\b(?:just|only|simply)\b/
const SMALL_OBJECT = /\b(?:this|that|my|the) (?:typo|sentence|paragraph|line|word|phrase|function|method|variable|class name|email|message|reply|tweet|caption|title|subject line|file|bug|error|query|regex|snippet|commit|cell|formula|bullet)\b/
const LENGTHY = /\b(comprehensive|exhaustive|thorough|in-depth|in depth|deep dive|detailed|extensive|long-form|full-length|end-to-end|complete)\b/g
const SECTIONS = /\b(sections?|chapters?|executive summary|table of contents|appendix|appendices|with citations|footnotes|covering|covers)\b/
// A mechanical operation on many things (rename, move, sort…) is one agent's loop, not a team's research.
const MECHANICAL = /^(?:please |can you |could you )?(?:rename|move|delete|remove|sort|resize|compress|zip|unzip|copy|archive|organi[sz]e|tag|label|mark|format|backup|back up)\b/

const num = (s: string): number => Number(s.replace(/,/g, ''))

/** The ask itself: an instruction followed by pasted material ("Summarize this: <article>") is scored on the instruction. */
function askOf(text: string): string {
  const t = text.replace(/[’']/g, '\'').trim()
  const cut = t.slice(0, 240).search(/[:\n]/)
  if (cut > 0 && t.length - cut > 240) return t.slice(0, cut)
  return t.slice(0, 1200)
}

/** Size of the work, with the signals that made it (for the tests and the card's label). */
export function teamworkSize(text: string, ctx: Pick<TeamworkContext, 'category' | 'difficulty' | 'attachments'> = {}): { size: number; signals: string[]; label: string; items: number; ideas: number } {
  const ask = askOf(text)
  const t = ` ${ask.toLowerCase().replace(/\s+/g, ' ')} `
  const words = ask.split(/\s+/).filter(Boolean).length
  const sig: string[] = []
  let size = 0
  const add = (n: number, why: string): void => { if (n) { size += n; sig.push(`${why} ${n > 0 ? '+' : ''}${n}`) } }

  // Deliverable.
  const del = DELIVERABLES.find(([re]) => re.test(t))
  if (del) add(del[1], 'deliverable')
  const delLabel = DELIVERABLE_LABEL.find(([re]) => re.test(t))?.[1]

  // Breadth: items, ideas, all/every, entities, sources, a multi-part ask.
  let items = 0
  let itemNoun = ''
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,3}(?:,\\d{3})?)\\s+(?:[a-z-]+\\s+){0,3}?(${NOUN})\\b`, 'g'))) if (num(m[1]) > items) { items = num(m[1]); itemNoun = m[2] }
  let ideas = 0
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,3})\\s+(?:[a-z-]+\\s+){0,3}?${IDEA}\\b`, 'g'))) ideas = Math.max(ideas, num(m[1]))
  if (ideas >= items) items = 0
  const compare = /\b(compare|comparison|versus|vs\.?|side[- ]by[- ]side|rank(?:ing|ed)?|benchmark)\b/.test(t)
  if (items >= 30) add(7, `${items} items`)
  else if (items >= 15) add(6, `${items} items`)
  else if (items >= 8) add(4, `${items} items`)
  else if (items >= 2 && items <= 5) add(-2, `${items} items`)
  if (items >= 8 && compare) add(2, 'many-item comparison')
  if (ideas >= 100) add(9, `${ideas} ideas`)
  else if (ideas >= 40) add(8, `${ideas} ideas`)
  else if (ideas >= 20) add(7, `${ideas} ideas`)
  else if (ideas >= 10) add(4, `${ideas} ideas`)
  else if (ideas >= 1) add(-3, `${ideas} ideas`)
  const every = new RegExp(`\\b(?:all|every|each)\\s+(?:of\\s+)?(?:the\\s+|these\\s+|those\\s+|my\\s+|our\\s+|\\d+\\s+)?(?:[a-z-]+\\s+){0,2}?(?:${NOUN}|[a-z]+'s)\\b`).exec(t)
  const everyNoun = every ? (every[0].split(' ').pop() ?? '').replace(/'s$/, '').replace(/([^s])$/, '$1s') : ''
  if (every) add(5, 'all / every')
  if (every && compare && items < 8) add(2, 'comparing all of them')
  if (/\b(competitors?|competition|key players|market share|incumbents)\b/.test(t)) add(2, 'competitors')
  if (/\b(sources|citations|cite|references|bibliography|peer[- ]reviewed|literature review|systematic review)\b/.test(t)) add(2, 'sources')
  if (/\b(research|investigate|deep dive|dig into|look into|survey of)\b/.test(t)) add(2, 'research')
  if (/\bacross\b/.test(t)) add(1, 'across')
  if (/\b(brainstorm\w*|ideat\w*)\b/.test(t)) add(2, 'brainstorm')
  if (/\b(lots of|tons of|loads of|as many as|a long list|dozens of|hundreds of)\b/.test(t)) add(2, 'many')
  // A multi-part ask ("market size, growth, key brands and regulations"): the list itself, not pasted prose.
  const commas = (t.match(/,/g) ?? []).length
  const parts = commas ? commas + (/,[^,]{1,40}\b(?:and|or)\b/.test(t) ? 2 : 1) : 0
  if (parts >= 5) add(3, `${parts} parts`)
  else if (parts >= 3) add(2, `${parts} parts`)

  // Length.
  const pages = /\b(\d{1,3})[- ](?:page|pages|pg)\b/.exec(t)
  const slides = /\b(\d{1,3})[- ](?:slide|slides)\b/.exec(t)
  const wordsAsked = /\b(\d{1,2},?\d{3}|\d{3,5}|\d+k)[- ]words?\b/.exec(t)
  if (pages) add(num(pages[1]) >= 5 ? 4 : num(pages[1]) >= 2 ? 1 : -2, `${pages[1]} pages`)
  if (slides) add(num(slides[1]) >= 10 ? 3 : 0, `${slides[1]} slides`)
  if (wordsAsked) {
    const n = /k$/.test(wordsAsked[1]) ? num(wordsAsked[1]) * 1000 : num(wordsAsked[1])
    add(n >= 2000 ? 4 : n >= 1000 ? 1 : -2, `${wordsAsked[1]} words`)
  }
  const lengthy = new Set(t.match(LENGTHY) ?? [])
  if (lengthy.size) add(Math.min(4, lengthy.size * 2), [...lengthy][0])
  if (SECTIONS.test(t)) add(2, 'sections')

  // Files, difficulty, a long ask.
  const files = ctx.attachments ?? 0
  if (files >= 10) add(10, `${files} files`)
  else if (files >= 6) add(8, `${files} files`)
  else if (files >= 4) add(5, `${files} files`)
  else if (files >= 2) add(1, `${files} files`)
  const d = ctx.difficulty ?? 2
  // Breadth the classifier can't see (many ideas, items or files) isn't light work, whatever the category says.
  const broad = ideas >= 10 || items >= 8 || files >= 4 || !!every || (!!del && (parts >= 3 || lengthy.size > 0 || SECTIONS.test(t)))
  if (d >= 3) add(2, 'hard')
  else if (d <= 1 && !broad) add(-3, 'light')
  if ((ctx.category === 'code-quick' || ctx.category === 'chat') && !broad) add(-2, ctx.category)
  if (words > 80) add(2, 'long request')
  else if (words > 40) add(1, 'long request')

  // Brevity and one small object.
  if (BREVITY.test(t)) add(-5, 'brevity')
  if (JUST.test(t)) add(-2, 'just')
  if (SMALL_OBJECT.test(t)) add(-3, 'one small thing')
  if (MECHANICAL.test(t.trim()) && !del) add(-4, 'a mechanical operation')

  const label = files >= 4 ? `${files} files`
    : ideas >= 10 ? `${ideas} ideas`
      : items >= 8 ? (compare ? `${items}-item comparison` : `${items} ${itemNoun}`)
        : delLabel ? `big ${delLabel}`
          : every ? `all ${everyNoun}`
            : /\bbrainstorm/.test(t) ? 'a big brainstorm' : 'a big task'
  return { size, signals: sig, label: label.replace(/^big (market research|due diligence|competitive analysis|literature review|business plan)$/, '$1'), items: Math.max(items, every ? 12 : 0), ideas }
}

/** The stakes of a single hard answer (judged attempts are worth it only for the hardest, highest-stakes ones). */
export function teamworkStakes(text: string, plan: MaxPlan, ctx: Pick<TeamworkContext, 'difficulty'> = {}): number {
  const t = ` ${askOf(text).toLowerCase()} `
  let s = plan.scores.heavy
  s += (ctx.difficulty ?? 2) >= 3 ? 2 : -4
  if (/\b(rigorous(?:ly)?|carefully|exactly right|must be (?:correct|right|exact)|high[- ]stakes|critical|get (?:this|it) right|no mistakes|airtight|bulletproof|double[- ]check|verify every)\b/.test(t)) s += 2
  if (BREVITY.test(t)) s -= 5
  if (JUST.test(t)) s -= 2
  return s
}

const HEAVY_LABEL: Record<string, string> = {
  'a proof': 'hard proof', 'a calculation': 'hard problem', 'a tricky bug': 'tricky bug', 'tricky code': 'tricky code', 'a decision': 'big decision',
  'a critical document': 'critical document', 'getting it right': 'high-stakes answer', 'code to get right': 'tricky code', 'one recommendation': 'big decision'
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(n)))

/** Auto's decision for one request: solo, a hint for the lead, or start Max itself, with the plan sized to the task. */
export function teamworkFit(text: string, ctx: TeamworkContext = {}): TeamworkFit {
  const c = ctx.category === undefined || ctx.difficulty === undefined
    ? classifyTask(text, { files: ctx.attachments })
    : undefined
  const category = ctx.category ?? c!.category
  const difficulty = ctx.difficulty ?? c!.difficulty
  const solo = (why: string, size = 0, signals: string[] = []): TeamworkFit => ({ level: 'solo', size, why, signals })
  // Small talk and short light questions never team up.
  if (!text.trim() || (category === 'chat' && (difficulty === 0 || (difficulty <= 1 && !/\b\d{2,}\b/.test(text) && text.split(/\s+/).length <= 8)) && (ctx.attachments ?? 0) < 4)) return solo('small talk or a quick question')

  const sz = teamworkSize(text, { category, difficulty, attachments: ctx.attachments })
  let plan = planMax(text, { category, difficulty, attachments: ctx.attachments })
  const explore = plan.strategy === 'hybrid' ? plan.phases[0] : plan.strategy
  let score = sz.size
  let hintAt = HINT_AT
  let startAt = START_AT
  if (plan.strategy === 'heavy') {
    const stakes = teamworkStakes(text, plan, { difficulty })
    if (stakes >= HEAVY_HINT_AT) { score = stakes; hintAt = HEAVY_HINT_AT; startAt = HEAVY_START_AT }
    // A big document the planner read as "one critical answer": its sections divide across a team instead.
    else if (sz.size >= HINT_AT) plan = planMax(text, { category, difficulty, attachments: ctx.attachments, forced: plan.scores.deliverable >= 3 ? 'hybrid' : 'team' }), score += plan.strategy === 'hybrid' ? 1 : 0
    else return solo('one answer, not worth judged attempts', stakes, sz.signals)
  } else if (plan.strategy === 'hybrid') {
    // A hybrid is an explore phase plus judged attempts on the deliverable: worth it only when the exploring is.
    score = sz.size + 1
  }
  if (plan.strategy === 'swarm' && explore === 'swarm' && sz.ideas === 0 && sz.items >= 8) plan = { ...plan, pattern: 'divide', title: strategyTitle('swarm', ['swarm'], 'divide') }
  if (score < hintAt) return solo('small enough for one agent', score, sz.signals)

  // How many: a medium team of 3, more with size; a third of the items or files; ideas need a wide swarm.
  const strat: MaxStrategy = plan.strategy
  const first = plan.phases[0]
  const files = ctx.attachments ?? 0
  let helpers = first === 'heavy'
    ? (score >= HEAVY_START_AT + 2 ? 4 : 3)
    : first === 'swarm' && plan.pattern !== 'divide'
      ? clamp(sz.ideas ? sz.ideas / 8 : score - 4, 4, 10)
      : Math.max(score >= START_AT + 6 ? 8 : score >= START_AT + 3 ? 6 : score >= START_AT ? 4 : 3, files >= 4 ? clamp(files / 3, 3, 10) : 0, sz.items >= 8 ? clamp(sz.items / 3, 3, 10) : 0)

  // Cost: the monthly limit and the team cap.
  const left = ctx.budget?.leftUsd
  const cap = ctx.teamCapUsd ?? 5
  if (ctx.budget?.tight || (left !== undefined && left < 1)) return solo('little monthly budget left', score, sz.signals)
  const lowBudget = left !== undefined && left < cap
  if (lowBudget) helpers = Math.min(helpers, 3)
  if (ctx.maxHelpers) helpers = Math.min(helpers, first === 'heavy' ? 8 : ctx.maxHelpers)
  helpers = Math.max(first === 'heavy' ? 2 : 2, helpers)

  // Who may start it: never code or the screen (a hint), local models, unattended, Plan first, or a low budget.
  const mayStart = score >= startAt && ctx.cloud !== false && !ctx.unattended && !ctx.planFirst && !lowBudget
    && category !== 'coding' && category !== 'code-quick' && category !== 'computer-use'

  const kindLabel = first === 'heavy' ? HEAVY_LABEL[plan.why.split(',')[0]] ?? 'hard answer' : sz.label
  const team = first === 'heavy' ? `${helpers} judged attempts`
    : first === 'swarm' ? `${plan.pattern === 'divide' ? 'helper' : 'idea'} swarm of ${helpers}`
      : `research team of ${helpers}`
  const tail = strat === 'hybrid' ? (first === 'swarm' ? ' → judged pick' : ' → judged write-up') : ''
  const why = `${kindLabel} → ${team}${tail}`
  return { level: mayStart ? 'start' : 'hint', size: score, plan: { ...plan, why, helpers }, helpers, why, signals: sz.signals }
}

/** Whether a request clearly benefits from Max (a hint or more), and how: teamworkFit, as a yes / no. */
export function maxFit(text: string, ctx: TeamworkContext = {}): { fit: boolean; plan?: MaxPlan; why?: string } {
  const f = teamworkFit(text, ctx)
  return f.level === 'solo' ? { fit: false } : { fit: true, plan: f.plan, why: f.why }
}
