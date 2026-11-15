// Planner ⇄ Executor protocol for computer use (agent/cua). Pure: types, parsing and small rules, no I/O.
//
// The planner (a strong model, no tools) turns the goal into checkpoints with success criteria, reads the
// executor's compact reports (plus an occasional screenshot), and decides: go on, revise the plan, ask the
// user, or finish. The executor (the model running the agent loop) does the actual work with SahilBot's own
// computer / app / browser tools, toward one checkpoint at a time, and reports back with the checkpoint tool.
// When it believes a step is wrong, impossible, risky or already done, or the screen contradicts the plan, it
// stops and sends a structured disagreement instead of pushing on. The planner decides.
//
// Nothing the planner says is permission: every executor action still goes through the loop's permission
// path (approvals, hard stops, the purchase and one-time-code gates, taint). The planner has no tools at all.

export type CuaMode = 'single' | 'pair' | 'auto'
export const CUA_MODES: CuaMode[] = ['auto', 'single', 'pair']

export interface Checkpoint {
  id: number
  /** What to get done, in one line ("Mail has a new message to Ann open"). */
  goal: string
  /** How to tell it's done, checkable on screen ("To: ann@x.com, Subject: Q3, body drafted; not sent"). */
  success: string
  status: 'pending' | 'active' | 'done' | 'skipped'
  /** Planner notes for the executor (hints, pitfalls), short. */
  hint?: string
}

export interface CuaPlan {
  /** One sentence: the whole job. */
  summary: string
  checkpoints: Checkpoint[]
  /** Hard limits from the goal ("don't send", "don't pay"), repeated to the executor every time. */
  constraints: string[]
}

export type ReportStatus = 'done' | 'disagree' | 'blocked' | 'progress'
export const REPORT_STATUSES: ReportStatus[] = ['done', 'disagree', 'blocked', 'progress']

/** Why an executor disagrees (the protocol's reasons). */
export type DisagreeReason = 'wrong' | 'impossible' | 'risky' | 'already_done' | 'contradicts_screen' | 'other'
export const DISAGREE_REASONS: DisagreeReason[] = ['wrong', 'impossible', 'risky', 'already_done', 'contradicts_screen', 'other']

export interface ExecutorReport {
  status: ReportStatus
  checkpoint?: number
  /** What is on screen now, in a few lines (app, window, the relevant fields and values). */
  sees: string
  /** For done: how the success criteria are met. */
  evidence?: string
  /** For disagree / blocked: which kind, and why. */
  reason?: DisagreeReason
  why?: string
  /** For disagree / blocked: what the executor would do instead. */
  suggestion?: string
  /** The screenshot this report refers to (the latest one in the chat), filled in by the app. */
  screenshot?: string
}

export type PlannerAction = 'next' | 'continue' | 'revise' | 'ask_user' | 'finish' | 'stop'
export const PLANNER_ACTIONS: PlannerAction[] = ['next', 'continue', 'revise', 'ask_user', 'finish', 'stop']

export interface PlannerDecision {
  action: PlannerAction
  /** The instruction (or the reason) in the planner's words, for the executor. */
  message: string
  /** revise: the new plan (replaces the remaining checkpoints). */
  plan?: CuaPlan
  /** ask_user: the question for the user. */
  question?: string
  /** On a disagreement: did the planner accept the executor's view? */
  verdict?: 'agree' | 'disagree'
}

export type TimelineWho = 'planner' | 'executor' | 'app' | 'user'
export type TimelineKind = 'plan' | 'instruction' | 'report' | 'disagree' | 'revise' | 'ask' | 'answer' | 'stall' | 'budget' | 'check' | 'finish' | 'error'

export interface TimelineEntry {
  at: number
  who: TimelineWho
  kind: TimelineKind
  text: string
  checkpoint?: number
  /** A screenshot went with this message (the planner saw it). */
  image?: boolean
}

export interface CuaState {
  v: 1
  active: boolean
  planner: string
  executor: string
  plannerLabel?: string
  executorLabel?: string
  goal: string
  plan: CuaPlan
  /** The checkpoint the executor works on (an id from plan.checkpoints). */
  current: number
  timeline: TimelineEntry[]
  plannerCalls: number
  /** Executor tool calls since the last report (the per-checkpoint step budget). */
  actionsSince: number
  actionsTotal: number
  disagreements: number
  /** How many times the run tried to end before the planner's done check passed. */
  finishNudges: number
  /** The planner passed its final done check. */
  approvedFinish?: boolean
  finished?: 'done' | 'stopped' | 'asked' | 'failed'
  /** The timeline card's message id. */
  cardId?: string
  /** Why this pair was chosen (for the card's tooltip). */
  why?: string
  startedAt: number
  /** The last stall flagged (actionsTotal when it happened). */
  stallAt?: number
  /** The per-checkpoint step budget note went out (reset by each report). */
  budgetNudged?: boolean
  /** The whole-request wrap-up note went out. */
  wrapNudged?: boolean
}

const clip = (s: unknown, n: number): string => {
  const t = typeof s === 'string' ? s.replace(/\s+\n/g, '\n').trim() : ''
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/**
 * The first JSON object in a model's reply: bare, fenced (```json … ```) or with prose around it. Braces
 * inside strings are skipped. undefined when there is none or it doesn't parse.
 */
export function firstJson(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  for (const src of fenced ? [fenced, text] : [text]) {
    for (let start = src.indexOf('{'); start >= 0; start = src.indexOf('{', start + 1)) {
      let depth = 0
      let inStr = false
      let esc = false
      for (let i = start; i < src.length; i++) {
        const c = src[i]
        if (inStr) {
          if (esc) esc = false
          else if (c === '\\') esc = true
          else if (c === '"') inStr = false
          continue
        }
        if (c === '"') inStr = true
        else if (c === '{') depth++
        else if (c === '}' && --depth === 0) {
          try {
            const v = JSON.parse(src.slice(start, i + 1))
            if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
          } catch { /* try the next opening brace */ }
          break
        }
      }
    }
  }
  return undefined
}

const MAX_CHECKPOINTS = 12

/** A plan from the planner's JSON ({summary, checkpoints: [{goal, success, hint?}], constraints}). */
export function parsePlan(text: string): CuaPlan | undefined {
  const j = firstJson(text)
  return j ? planFrom(j) : undefined
}

export function planFrom(j: Record<string, unknown>, firstId = 1): CuaPlan | undefined {
  const raw = Array.isArray(j.checkpoints) ? j.checkpoints : Array.isArray(j.steps) ? j.steps : undefined
  if (!raw?.length) return undefined
  const checkpoints: Checkpoint[] = []
  for (const c of raw.slice(0, MAX_CHECKPOINTS)) {
    const o = (typeof c === 'string' ? { goal: c } : c) as Record<string, unknown>
    const goal = clip(o?.goal ?? o?.step ?? o?.title, 300)
    if (!goal) continue
    const success = clip(o.success ?? o.success_criteria ?? o.done_when ?? o.check, 400) || `${goal} (visible on screen)`
    const hint = clip(o.hint ?? o.notes, 300) || undefined
    checkpoints.push({ id: firstId + checkpoints.length, goal, success, status: 'pending', ...(hint ? { hint } : {}) })
  }
  if (!checkpoints.length) return undefined
  const constraints = (Array.isArray(j.constraints) ? j.constraints : []).map((c) => clip(c, 200)).filter(Boolean).slice(0, 8)
  return { summary: clip(j.summary ?? j.goal, 300) || checkpoints.map((c) => c.goal).join('; ').slice(0, 300), checkpoints, constraints }
}

/** The planner's decision, from its JSON ({action, message, plan?, question?, verdict?}). Unknown actions mean continue. */
export function parseDecision(text: string, nextId: number): PlannerDecision {
  const j = firstJson(text)
  if (!j) {
    const plain = clip(text, 1200)
    return { action: 'continue', message: plain || 'Carry on with the current checkpoint.' }
  }
  const a = String(j.action ?? j.decision ?? '').toLowerCase().replace(/[\s-]+/g, '_')
  const action: PlannerAction = (PLANNER_ACTIONS as string[]).includes(a) ? (a as PlannerAction) : a === 'done' || a === 'complete' ? 'finish' : a === 'advance' ? 'next' : a === 'replan' ? 'revise' : a === 'ask' ? 'ask_user' : 'continue'
  const message = clip(j.message ?? j.instruction ?? j.reason, 1500) || (action === 'finish' ? 'The task is done.' : 'Carry on.')
  const plan = action === 'revise' && j.plan && typeof j.plan === 'object' ? planFrom(j.plan as Record<string, unknown>, nextId) : undefined
  const question = clip(j.question, 500) || undefined
  const v = String(j.verdict ?? '').toLowerCase()
  const verdict = v === 'agree' || v === 'disagree' ? v : undefined
  // A revise without a usable plan keeps the old one (the message still guides the executor).
  return { action: action === 'revise' && !plan ? 'continue' : action === 'ask_user' && !question ? 'continue' : action, message, ...(plan ? { plan } : {}), ...(question ? { question } : {}), ...(verdict ? { verdict } : {}) }
}

/** The checkpoint by id. */
export const checkpointOf = (s: Pick<CuaState, 'plan'>, id: number): Checkpoint | undefined => s.plan.checkpoints.find((c) => c.id === id)

/** The next checkpoint not done or skipped after `after` (by order). */
export function nextOpen(plan: CuaPlan, after: number): Checkpoint | undefined {
  const i = plan.checkpoints.findIndex((c) => c.id === after)
  return plan.checkpoints.slice(i + 1).find((c) => c.status === 'pending' || c.status === 'active') ?? plan.checkpoints.find((c) => c.status === 'pending' || c.status === 'active')
}

/** Marks `id` done and makes the next open checkpoint current; returns it (undefined: all done). */
export function advance(s: CuaState, id: number): Checkpoint | undefined {
  const c = checkpointOf(s, id)
  if (c) c.status = 'done'
  const next = nextOpen(s.plan, id)
  if (next) { next.status = 'active'; s.current = next.id }
  return next
}

/** Replaces the plan's open checkpoints with a revised list; done ones stay (history). */
export function revise(s: CuaState, plan: CuaPlan): Checkpoint | undefined {
  const kept = s.plan.checkpoints.filter((c) => c.status === 'done' || c.status === 'skipped')
  const base = Math.max(0, ...s.plan.checkpoints.map((c) => c.id)) + 1
  const fresh: Checkpoint[] = plan.checkpoints.map((c, i) => ({ ...c, id: base + i, status: 'pending' }))
  s.plan = { summary: plan.summary || s.plan.summary, constraints: plan.constraints.length ? plan.constraints : s.plan.constraints, checkpoints: [...kept, ...fresh] }
  const first = fresh[0]
  if (first) { first.status = 'active'; s.current = first.id }
  return first
}

/** The plan as text for the executor: done ticks, the current one marked, constraints repeated. */
export function planText(s: Pick<CuaState, 'plan' | 'current'>): string {
  const lines = s.plan.checkpoints.map((c) => `${c.status === 'done' ? '[x]' : c.status === 'skipped' ? '[-]' : c.id === s.current ? '[>]' : '[ ]'} ${c.id}. ${c.goal}\n      done when: ${c.success}${c.hint && c.id === s.current ? `\n      hint: ${c.hint}` : ''}`)
  return `${s.plan.summary}\n${lines.join('\n')}${s.plan.constraints.length ? `\nNever: ${s.plan.constraints.join('; ')}` : ''}`
}

/** Normalizes the checkpoint tool's arguments into a report. */
export function reportFrom(a: Record<string, unknown>, current: number): ExecutorReport {
  const status = (REPORT_STATUSES as string[]).includes(String(a.status)) ? (a.status as ReportStatus) : 'progress'
  const reason = (DISAGREE_REASONS as string[]).includes(String(a.reason)) ? (a.reason as DisagreeReason) : status === 'disagree' ? 'other' : undefined
  const cp = typeof a.checkpoint === 'number' && Number.isInteger(a.checkpoint) ? a.checkpoint : current
  return {
    status, checkpoint: cp, sees: clip(a.sees, 1500) || '(not described)',
    ...(a.evidence ? { evidence: clip(a.evidence, 1000) } : {}),
    ...(reason ? { reason } : {}),
    ...(a.why ? { why: clip(a.why, 1000) } : {}),
    ...(a.suggestion ? { suggestion: clip(a.suggestion, 800) } : {})
  }
}

/** One line of a report for the timeline card. */
export function reportLine(r: ExecutorReport): string {
  if (r.status === 'done') return `Checkpoint ${r.checkpoint} done${r.evidence ? `: ${r.evidence}` : ''}`
  if (r.status === 'disagree') return `Disagrees (${(r.reason ?? 'other').replace('_', ' ')}): ${r.why ?? r.sees}${r.suggestion ? ` · suggests: ${r.suggestion}` : ''}`
  if (r.status === 'blocked') return `Blocked: ${r.why ?? r.sees}${r.suggestion ? ` · suggests: ${r.suggestion}` : ''}`
  return `Progress: ${r.sees}`
}

/** Short text with the plan's constraints, for the hidden reminders. */
export const constraintsLine = (p: CuaPlan): string => (p.constraints.length ? ` Never: ${p.constraints.join('; ')}.` : '')
