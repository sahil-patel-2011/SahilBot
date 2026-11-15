import type { Effort, EffortChoice, Tier } from '@shared/types'
import { claudeEffort } from './claude-models'
import { openaiEffort, openaiInfo } from './openai-models'
import type { TaskCategory } from './task-classifier'
import { isGrok, xaiEffort } from './xai-models'

// Auto effort: how hard the model thinks, picked per request from the task (task-classifier.ts), the way Auto
// picks the model. It follows the effort rubric in docs/model-routing.md ("Rubrics") and leans high, because
// the user would "rather slightly more than too little":
//   base     the difficulty: instant Low, light Medium, standard High, hardest Extra; conversation (chat) one
//            step lighter from standard up (a lookup is not hard thinking), voice Low (Medium when hardest);
//   floors   stakes (legal, medical, money, production), an expected deliverable, a long piece of output, deep
//            tool work, a task run, Council: never below the floor; Heavy at the hardest tier: Max; words that
//            ask for it ("think as hard as you can"): at least that level;
//   mid-run  escalateEffort(): one level up, once, when the run keeps failing or its plan grows long.
// A level chosen by hand (for a chat, a bot or the default) is used exactly as chosen: no floors, no
// escalation. Each provider then maps the level onto what the model accepts (supportedEffort).

const LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const EFFORT_CHOICES: EffortChoice[] = ['auto', ...LEVELS]
export const isEffortChoice = (v: unknown): v is EffortChoice => typeof v === 'string' && (EFFORT_CHOICES as string[]).includes(v)
export const EFFORT_LABEL: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' }

const at = (e: Effort): number => LEVELS.indexOf(e)
const atLeast = (e: Effort, floor: Effort): Effort => (at(e) >= at(floor) ? e : floor)

export interface AutoEffortInput {
  category?: TaskCategory | string
  /** The request's difficulty (0 instant … 3 hardest). */
  difficulty?: Tier
  /** A task run: tier 2+, Plan first, Deep Research, a team, an open plan, coding or CAD tools loaded. */
  task?: boolean
  voice?: boolean
  /** Heavy mode (Deep Research too, for callers that pass it here): Max at the hardest tier. */
  heavy?: boolean
  /** Council: several models answer and compare: each thinks at Extra at least. */
  council?: boolean
  /** Legal, medical, money, production or security stakes in the request. */
  stakes?: boolean
  /** A deliverable is expected (a file, a document, a change to code or data). */
  deliverable?: boolean
  /** A long piece of output (a long essay, a comprehensive report, a whole feature). */
  longOutput?: boolean
  /** Expected tool depth: 0 none, 1 one call, 2 a few, 3 many steps. */
  toolDepth?: number
  /** A level the request asks for in words ("think as hard as you can" = max, "think carefully" = high). */
  explicit?: Effort
}

/** The effort Auto picks for a request (the effort rubric). */
export function autoEffort(o: AutoEffortInput): Effort {
  const d = o.difficulty ?? 1
  const c = o.category as TaskCategory | undefined
  // Voice: replies must start fast, whatever the words ask.
  if (o.voice || c === 'voice') return d >= 3 ? 'medium' : 'low'
  let e: Effort
  if (d === 0) e = 'low'
  else if (c === 'chat' || c === undefined) e = d >= 3 ? 'high' : 'medium'
  else e = LEVELS[Math.min(3, d)]
  // Floors: what the request is for, not only how hard it reads.
  if (o.task) e = atLeast(e, 'high')
  if (o.stakes && d >= 1) e = atLeast(e, 'high')
  if (o.deliverable && d >= 2) e = atLeast(e, 'high')
  if (o.longOutput) e = atLeast(e, 'high')
  if ((o.toolDepth ?? 0) >= 3 && d >= 2) e = atLeast(e, 'xhigh')
  if (o.council) e = atLeast(e, 'xhigh')
  if (o.heavy && d >= 3) e = 'max'
  if (o.explicit) e = atLeast(e, o.explicit)
  return e
}

/** A chosen level is used exactly; Auto (or nothing chosen) picks one for the request. */
export function resolveEffort(choice: EffortChoice | null | undefined, o: AutoEffortInput): Effort {
  return choice && choice !== 'auto' ? choice : autoEffort(o)
}

/**
 * Whose effort choice applies, most specific first, like the model: the chat's own, the bot speaking (in a
 * group), the chat's bot or project, then the app default (Settings → Models). 'auto' when nothing is set.
 */
export function effortChoice(...from: Array<EffortChoice | null | undefined>): EffortChoice {
  for (const c of from) if (isEffortChoice(c)) return c
  return 'auto'
}

/**
 * The level a model really runs at for `effort`: the level itself when the model accepts it, else the nearest
 * accepted one below (above when none is below), as each provider's client sends it. undefined: the model takes
 * no effort setting (older models, most local ones), so the level is only a hint.
 */
export function supportedEffort(model: string, effort: Effort): Effort | undefined {
  if (/^(anthropic\/)?claude-/i.test(model)) return claudeEffort(model.replace(/^anthropic\//i, '').replace(/\./g, '-'), effort)
  if (isGrok(model)) return xaiEffort(model, effort) as Effort | undefined
  const bare = model.replace(/^openai\//i, '')
  if (openaiInfo(bare)) { const e = openaiEffort(bare, effort); return e === 'none' ? undefined : (e as Effort | undefined) }
  return undefined
}

// ---------------------------------------------------------------------------------------------------
// Mid-run escalation: Auto picked the level before the run knew how it would go. When the agent keeps hitting
// failures, or its plan grows past PLAN_STEPS items, it thinks one level harder for the rest of the run: once,
// only on Auto (a chosen level is never changed), only up to what the model accepts, and with a visible note.
// ---------------------------------------------------------------------------------------------------

/** Failed tool calls (errors and invalid calls) in one run that count as "keeps failing". */
export const FAIL_STEPS = 3
/** A plan longer than this is a bigger task than the request read as. */
export const PLAN_STEPS = 8

export interface EscalationInput {
  /** The chosen effort: 'auto' (or nothing) is the only one that escalates. */
  choice: EffortChoice | null | undefined
  /** The level this run is at now. */
  current: Effort
  /** Already bumped this run. */
  bumped: boolean
  failures: number
  planSteps: number
  /** The model the run uses (its accepted levels cap the bump). */
  model?: string
}

/** The bump to make now, or undefined: { level, note } with the note for the chat. */
export function escalateEffort(o: EscalationInput): { level: Effort; note: string } | undefined {
  if (o.bumped || (o.choice && o.choice !== 'auto')) return undefined
  const why = o.failures >= FAIL_STEPS ? `${o.failures} steps failed` : o.planSteps > PLAN_STEPS ? `the plan grew to ${o.planSteps} steps` : undefined
  if (!why) return undefined
  const i = at(o.current)
  if (i >= at('max')) return undefined
  // Max stays for Heavy and explicit asks: a bump goes up to Extra.
  const want = LEVELS[Math.min(at('xhigh'), i + 1)]
  if (at(want) <= i) return undefined
  // The model's accepted levels: a bump it can't take changes nothing, so nothing is said.
  const real = o.model ? supportedEffort(o.model, want) : want
  const now = o.model ? supportedEffort(o.model, o.current) : o.current
  if (o.model && real !== undefined && now !== undefined && at(real) <= at(now)) return undefined
  const level = real ?? want
  return { level, note: `Thinking raised to ${EFFORT_LABEL[level]} for the rest of this task: ${why}.` }
}
