import type { MaxPhaseKind, MaxStrategy } from '@shared/types'
import type { TaskCategory } from '../../llm/task-classifier'

// Max's strategy planner: which orchestration fits this request. Local rules over the request's words and the
// task classifier's category and difficulty, so it costs nothing and decides instantly (no model call: the
// rules are clear-cut for the requests where Max matters, and a wrong pick still runs many strong agents).
//
//   team    divide and conquer across parallel helpers (the Team of Experts path): broad research, many
//           items, many sources or files, comparisons across many options.
//   swarm   independent divergent helpers, then a compile (ideate): brainstorming, options, names, slogans,
//           strategy alternatives. Each helper gets its own angle, so the ideas don't converge.
//   heavy   N independent full attempts plus a judge that merges or picks the best: hard single-answer
//           problems (tricky code, math, a proof), a critical document, a decision.
//   hybrid  explore first, then judged attempts on the deliverable: an idea swarm then a judged final draft
//           ("brainstorm names, then pick the best"), or a research team then a judged write-up ("research
//           the market and write the recommendation memo").
//
// Scores: each family of signals adds points; the highest wins, ties go to the category's natural fit. A request
// that explores (swarm or team) AND names a single deliverable to produce from it becomes a hybrid.

export interface PlanContext {
  /** The task classifier's category and difficulty (0-3) for the request, when known. */
  category?: TaskCategory
  difficulty?: number
  /** Files and folders attached to the message. */
  attachments?: number
  /** Skip the rules: the user (or the max tool) named the strategy. */
  forced?: MaxStrategy
}

export interface MaxPlan {
  strategy: MaxStrategy
  /** The phases in order: one, or two for a hybrid (explore, then heavy). */
  phases: MaxPhaseKind[]
  /** Swarm phases: ideation, or slices of many items. */
  pattern?: 'ideate' | 'divide'
  /** "idea swarm → judged final draft". */
  title: string
  /** Why, in a few words ("brainstorming, then one pick"). */
  why: string
  scores: { team: number; swarm: number; heavy: number; deliverable: number }
}

type Rule = [RegExp, number, string]

// Divergent ideation: many independent ideas, options or alternatives.
const SWARM: Rule[] = [
  [/\bbrainstorm(?:s|ing|ed)?\b/, 4, 'brainstorming'],
  [/\bideat(?:e|ion|ing)\b/, 4, 'ideation'],
  [/\b(?:\d+|some|a few|several|many|lots of|a bunch of|fresh|new|creative|wild|more|good|better|startup|business|gift|content|campaign|marketing|product|party|blog|video|post)\s+ideas?\b/, 3, 'ideas'],
  [/\bideas?\s+(?:for|to|on|about|of)\b/, 3, 'ideas'],
  [/\b(?:names?|naming)\s+(?:for|ideas|options)\b|\bname (?:my|our|a|the)\b|\bcome up with (?:a |some )?names?\b/, 4, 'naming'],
  [/\b(?:slogans?|taglines?|catchphrases?|headlines?|hooks?|titles? for|subject lines?)\b/, 3, 'copy options'],
  [/\bcome up with\b|\bthink of\b|\bdream up\b|\bspitball\b/, 2, 'generating options'],
  [/\b(?:creative|different|novel|unusual|unconventional|alternative|new)\s+(?:ways?|approaches|angles|strategies|options|directions|concepts|takes)\b/, 3, 'alternatives'],
  [/\bways to\b/, 2, 'ways to do it'],
  [/\b(?:alternatives?|options|possibilities|concepts|angles|variations|directions)\b/, 1, 'options'],
  [/\bstrateg(?:y|ies)\s+(?:alternatives|options|ideas)\b|\b(?:possible|potential|candidate)\s+(?:strategies|approaches|directions)\b/, 3, 'strategy alternatives'],
  [/\bwhat (?:are|could be) some\b|\bgive me (?:\d+|some|a list of|a bunch of)\b/, 2, 'a list of options'],
  [/\b(?:pitch|campaign|marketing|content|growth|launch)\s+(?:ideas|angles|concepts)\b/, 2, 'marketing ideas']
]

// Divide and conquer: breadth across sources, items or files.
const TEAM: Rule[] = [
  [/\bresearch(?:es|ing)?\b/, 3, 'research'],
  [/\b(?:investigate|look into|dig into|deep dive|find out)\b/, 2, 'investigation'],
  [/\b(?:market|competitive|industry|vendor|tool|landscape)\s+(?:landscape|analysis|research|map|scan|overview|size|sizing)\b|\blandscape\b/, 3, 'a landscape'],
  [/\bcompetitors?\b|\bcompetition\b/, 2, 'competitors'],
  [/\b(?:sources?|citations?|references|literature|papers|studies|evidence)\b/, 2, 'many sources'],
  [/\bcompare\b|\bcomparison\b|\bversus\b|\bvs\.?\b/, 1, 'a comparison'],
  [/\b(?:all|every|each)\s+(?:of\s+)?(?:the\s+|these\s+|those\s+|my\s+)?(?:\w+\s+)?(?:companies|vendors|tools|products|options|providers|states|countries|cities|schools|files|documents|papers|apps|competitors|candidates|platforms|frameworks|libraries|models|suppliers|plans|brands|sites|websites|articles|reviews|items|listings)\b/, 4, 'many items'],
  [/\b(?:top|the best|leading|biggest)\s+\d{1,3}\b|\b\d{2,3}\s+(?:companies|vendors|tools|products|options|providers|states|countries|cities|schools|files|documents|papers|apps|competitors|candidates|platforms|startups|brands|sites|items|listings)\b/, 4, 'many items'],
  [/\b(?:go through|review|summari[sz]e|analy[sz]e|audit|read)\s+(?:all|every|each|these|the)\s+(?:\w+\s+)?(?:files|documents|pdfs|papers|reports|emails|contracts|transcripts|pages|sheets)\b/, 4, 'many files'],
  [/\b(?:comprehensive|thorough|exhaustive|in-depth|broad|full)\s+(?:research|review|report|overview|survey|analysis|guide|list)\b/, 3, 'a broad survey'],
  [/\b(?:state of the art|state of|latest (?:news|developments|research)|what's new in|trends in)\b/, 2, 'what is current'],
  [/\b(?:survey|census|catalog(?:ue)?|inventory|directory|database) of\b/, 2, 'a survey'],
  [/\bacross\s+(?:\d+|many|several|multiple|all|the)\b/, 2, 'many angles'],
  [/\b(?:pricing|prices|features|reviews|specs)\s+(?:of|for|across)\b/, 1, 'facts per item'],
  [/\bfind (?:all|every|the best|me (?:the best|all|every))\b/, 3, 'finding many']
]

// One hard answer: correctness matters more than breadth.
const HEAVY: Rule[] = [
  [/\b(?:prove|proof|derive|derivation|theorem|lemma)\b/, 4, 'a proof'],
  [/\b(?:solve|calculate|compute|integral|derivative|equation|probability|expected value|optimi[sz]ation problem|combinatorics|closed form)\b/, 3, 'a calculation'],
  [/\b(?:debug|bug|crash(?:es|ing)?|stack trace|traceback|segfault|race condition|deadlock|memory leak|flaky|regression|off-by-one)\b/, 3, 'a tricky bug'],
  [/\b(?:fix|why does|why is|root cause)\b/, 1, 'a fix'],
  [/\b(?:algorithm|complexity|big-o|data structure|concurren(?:t|cy)|lock-free|edge cases?)\b/, 2, 'tricky code'],
  [/\b(?:implement|refactor|optimi[sz]e|rewrite)\s+(?:this|the|my|a)\b/, 2, 'code to get right'],
  [/\b(?:should (?:i|we)|which (?:one|option|should)|decide|decision|choose between|pick between|is it worth|go or no-go|verdict|trade-?offs?)\b/, 3, 'a decision'],
  [/\b(?:recommend(?:ation)?|the best (?:one|choice|option)|pick (?:one|the best)|which is better)\b/, 2, 'one recommendation'],
  [/\b(?:contract|agreement|nda|terms|legal|lawsuit|compliance|policy|clause)\b/, 2, 'a critical document'],
  [/\b(?:cover letter|resume|cv|proposal|grant|application essay|personal statement|investor update|pitch deck|press release|board memo|memo|speech|eulogy|wedding toast)\b/, 3, 'a critical document'],
  [/\b(?:critical|important|high[- ]stakes|get (?:this|it) right|no mistakes|double[- ]check|carefully|exact(?:ly)?|precise(?:ly)?|airtight|bulletproof|flawless|perfect)\b/, 2, 'getting it right'],
  [/\b(?:final (?:draft|version|answer)|polish(?:ed)?|definitive)\b/, 1, 'a final version']
]

// The explore phase leads to ONE deliverable built from it (a hybrid's second phase).
const DELIVERABLE: Rule[] = [
  [/\b(?:then|and then|after that|afterwards|finally)\b[^.?!]{0,40}\b(?:write|draft|pick|choose|select|recommend|decide|turn|build|make|create|produce|rank|narrow|finali[sz]e|compile)\b/, 4, 'then one deliverable'],
  [/\b(?:pick|choose|select|recommend|identify|narrow (?:it |them )?down to)\s+(?:the|a|one|our|my)?\s*(?:single |one |1 |top |final )?(?:best|winner|winning|strongest|favorite|top|one|final)\b/, 4, 'one pick'],
  [/\b(?:and|then)\s+(?:write|draft|produce|prepare|put together|create)\s+(?:a|an|the|my|our|up)\s+(?:\w+\s+){0,2}(?:report|memo|brief|proposal|plan|recommendation|strategy|summary|post|article|essay|email|deck|one-pager|white ?paper|business case|launch plan)\b/, 4, 'a write-up'],
  [/\b(?:into|as) (?:a|an|one) (?:single |final |polished )?(?:report|memo|brief|proposal|plan|recommendation|deck|one-pager|business case)\b/, 3, 'a write-up'],
  [/\b(?:final (?:recommendation|plan|draft|pick|decision|report)|shortlist and|and a recommendation|with a recommendation)\b/, 3, 'a final pick']
]

const score = (t: string, rules: Rule[]): { points: number; why: string[] } => {
  let points = 0
  const why: string[] = []
  for (const [re, p, w] of rules) if (re.test(t)) { points += p; if (!why.includes(w)) why.push(w) }
  return { points, why }
}

export const PHASE_LABEL: Record<MaxPhaseKind, string> = { team: 'Research team', swarm: 'Idea swarm', heavy: 'Judged attempts' }

/** The card's headline for a strategy ("idea swarm → judged final draft"). */
export function strategyTitle(strategy: MaxStrategy, phases: MaxPhaseKind[], pattern?: 'ideate' | 'divide'): string {
  if (strategy === 'hybrid') return phases[0] === 'swarm' ? 'idea swarm → judged final draft' : 'research team → judged write-up'
  if (strategy === 'swarm') return pattern === 'divide' ? 'helper swarm, one slice each' : 'idea swarm'
  if (strategy === 'team') return 'research team'
  return 'competing attempts + judge'
}

const phasesOf = (s: MaxStrategy, explore: 'team' | 'swarm' = 'swarm'): MaxPhaseKind[] => (s === 'hybrid' ? [explore, 'heavy'] : [s])

/** Many attached files read best as slices. */
const manyFiles = (n: number | undefined): boolean => (n ?? 0) >= 4

/** Picks Max's strategy for one request. */
export function planMax(text: string, ctx: PlanContext = {}): MaxPlan {
  const t = ` ${text.toLowerCase().replace(/[’']/g, '\'').replace(/\s+/g, ' ')} `
  const sw = score(t, SWARM)
  const tm = score(t, TEAM)
  const hv = score(t, HEAVY)
  const dl = score(t, DELIVERABLE)
  const cat = ctx.category
  // The classifier's view: research reads as a team, math and coding as judged attempts, writing as a document.
  if (cat === 'research' || cat === 'long-context') tm.points += 2
  if (cat === 'math') hv.points += 3
  if (cat === 'coding' || cat === 'code-quick') hv.points += 2
  if ((ctx.difficulty ?? 0) >= 3) hv.points += 1
  if (manyFiles(ctx.attachments)) { tm.points += (ctx.attachments ?? 0) >= 6 ? 5 : 3; tm.why.unshift(`${ctx.attachments} files`) }
  // An explicit count of ideas ("20 names") is ideation, not a list of items to research.
  if (/\b\d{1,3}\s+(?:ideas|names|slogans|taglines|headlines|titles|concepts|options|ways|angles|hooks)\b/.test(t)) { sw.points += 2; tm.points = Math.max(0, tm.points - 3) }
  const scores = { team: tm.points, swarm: sw.points, heavy: hv.points, deliverable: dl.points }

  const plan = (strategy: MaxStrategy, why: string, explore: 'team' | 'swarm' = 'swarm', pattern?: 'ideate' | 'divide'): MaxPlan => {
    const phases = phasesOf(strategy, explore)
    const pat = phases.includes('swarm') ? pattern ?? 'ideate' : undefined
    return { strategy, phases, pattern: pat, title: strategyTitle(strategy, phases, pat), why, scores }
  }
  const words = (xs: string[], n = 2): string => xs.slice(0, n).join(', ')

  if (ctx.forced) {
    const explore = ctx.forced === 'hybrid' ? (tm.points > sw.points ? 'team' : 'swarm') : undefined
    return plan(ctx.forced, 'chosen for this request', explore)
  }

  // Hybrid: it explores (ideas or research) and then has to land one deliverable from that.
  const explore: 'team' | 'swarm' = sw.points >= tm.points ? 'swarm' : 'team'
  const exploreScore = Math.max(sw.points, tm.points)
  if (exploreScore >= 3 && dl.points >= 3) {
    const first = explore === 'swarm' ? words(sw.why, 1) : words(tm.why, 1)
    return plan('hybrid', `${first}, then ${dl.why[0]}`, explore)
  }

  const best = Math.max(sw.points, tm.points, hv.points)
  if (best === 0) {
    // Nothing stands out: the category's natural fit; otherwise competing attempts (the best single answer).
    if (cat === 'research' || cat === 'long-context') return plan('team', 'research request')
    return plan('heavy', 'one answer, checked by several attempts')
  }
  // Ties: a hard single answer (math, code) keeps judged attempts; research keeps the team; ideas the swarm.
  const order: Array<'swarm' | 'team' | 'heavy'> = cat === 'math' || cat === 'coding' || cat === 'code-quick'
    ? ['heavy', 'swarm', 'team']
    : cat === 'research' || cat === 'long-context' ? ['team', 'swarm', 'heavy'] : ['swarm', 'team', 'heavy']
  const top = order.find((k) => scores[k] === best)!
  if (top === 'swarm') return plan('swarm', words(sw.why))
  if (top === 'team') {
    // Many independent files or items with no research angle: a swarm of slices reads them fastest.
    return plan('team', words(tm.why))
  }
  return plan('heavy', words(hv.why))
}

/**
 * Auto (a bot's Max setting): whether the request clearly benefits from Max, and how. Stricter than planMax:
 * it needs a strong signal (swarmFit's ideation and many-items rules, a broad research ask, or a hard
 * single-answer problem), so ordinary requests stay with one agent.
 */
export function maxFit(text: string, ctx: PlanContext & { swarmFit?: { fit: boolean; pattern?: 'ideate' | 'divide'; why?: string } } = {}): { fit: boolean; plan?: MaxPlan; why?: string } {
  const plan = planMax(text, ctx)
  const s = plan.scores
  if (ctx.swarmFit?.fit) return { fit: true, plan: ctx.swarmFit.pattern === 'divide' && plan.strategy === 'swarm' ? { ...plan, strategy: 'team', phases: ['team'], title: strategyTitle('team', ['team']) } : plan, why: ctx.swarmFit.why ?? plan.why }
  const strong = plan.strategy === 'hybrid' ? Math.max(s.swarm, s.team) >= 4 && s.deliverable >= 3
    : plan.strategy === 'swarm' ? s.swarm >= 6
      : plan.strategy === 'team' ? s.team >= 7
        : s.heavy >= 6 && (ctx.difficulty ?? 0) >= 2
  return strong ? { fit: true, plan, why: plan.why } : { fit: false }
}
