import type { Tier } from '@shared/types'
import { autoEffort } from './auto-effort'
import { CATEGORY_LABEL, TASK_CATEGORIES, type TaskCategory, type TaskClass, type TaskKind } from './task-classifier'

// An optional tie-breaker for Auto's low-confidence decisions: one tiny call to the cheapest fast cloud model
// (Claude Haiku 5.5 or GPT-6 Luna) with a strict JSON answer, a 1.5 s timeout and one answer cached per message.
// It is off unless a cloud key is saved, the month has budget left and the spend limit isn't None.
//
// Status: built and tested with fakes, NOT wired into the agent (docs/model-routing.md "Tie-breaker"). The eval
// can't show it clearly helps without paid calls, and the repo's own latency data (routing-table.ts: first
// token at low effort, Haiku 5.5 6.26 s, Luna 1.57 s) says neither model reliably answers inside 1.5 s, so on
// most unsure requests it would add up to 1.5 s and then time out. Wire it (loop.ts chooseModel, after
// classifyTask) only after measuring real answers and latency.

export const TIEBREAK_TIMEOUT_MS = 1500

/** The strict schema the model must answer in. */
export const TIEBREAK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'kind', 'difficulty'],
  properties: {
    category: { type: 'string', enum: TASK_CATEGORIES },
    kind: { type: 'string', enum: ['chat', 'agent'] },
    difficulty: { type: 'integer', minimum: 0, maximum: 3 }
  }
} as const

/** The tiny prompt: the categories in a line each, the request, JSON only. */
export function tiebreakPrompt(text: string): { system: string; user: string } {
  return {
    system: `Classify a request to an AI assistant on a Mac. Answer with JSON only: {"category","kind","difficulty"}.\ncategory: ${TASK_CATEGORIES.map((c) => `${c} (${CATEGORY_LABEL[c]})`).join(', ')}.\nkind: agent if it needs tools, files, apps, the screen or several steps; else chat.\ndifficulty: 0 small talk, 1 quick, 2 standard task, 3 hardest. Unsure: the higher one.`,
    user: text.slice(0, 2000)
  }
}

export interface TiebreakAnswer { category: TaskCategory; kind: TaskKind; difficulty: Tier }

/** The model's reply, strictly: exactly the schema's fields and values, else undefined. */
export function parseTiebreak(reply: string): TiebreakAnswer | undefined {
  const m = reply.trim().match(/\{[\s\S]*\}/)
  if (!m) return undefined
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>
    if (Object.keys(j).some((k) => !['category', 'kind', 'difficulty'].includes(k))) return undefined
    if (!TASK_CATEGORIES.includes(j.category as TaskCategory)) return undefined
    if (j.kind !== 'chat' && j.kind !== 'agent') return undefined
    if (!Number.isInteger(j.difficulty) || (j.difficulty as number) < 0 || (j.difficulty as number) > 3) return undefined
    return { category: j.category as TaskCategory, kind: j.kind, difficulty: j.difficulty as Tier }
  } catch { return undefined }
}

export interface TiebreakGate {
  /** A cloud key for the cheap model is saved and cloud models are on. */
  cloudKey: boolean
  /** The model to ask (Haiku 5.5 / GPT-6 Luna), when one is usable. */
  model?: string
  /** The monthly spend limit in USD: 0 or undefined = None (no cloud spending at all). */
  spendLimitUsd?: number
  /** Budget left this month (undefined: unknown). */
  budgetLeftUsd?: number
}

/** Whether a tie-breaker may be asked for this decision. */
export function tiebreakAllowed(d: Pick<TaskClass, 'confident' | 'category'>, g: TiebreakGate): boolean {
  if (d.confident || d.category === 'voice') return false
  if (!g.cloudKey || !g.model) return false
  if (!g.spendLimitUsd || g.spendLimitUsd <= 0) return false
  if (g.budgetLeftUsd !== undefined && g.budgetLeftUsd <= 0) return false
  return true
}

/**
 * The decision with the answer folded in. Upward bias, like the rest of Auto: the higher difficulty of the two,
 * agent if either says agent; the model's category replaces the rules' (they were unsure). Effort is redone.
 */
export function mergeTiebreak(d: TaskClass, a: TiebreakAnswer): TaskClass {
  const difficulty = Math.max(d.difficulty, a.difficulty) as Tier
  const kind: TaskKind = d.kind === 'agent' || a.kind === 'agent' ? 'agent' : 'chat'
  const category = a.category
  const effort = autoEffort({ category, difficulty, task: kind === 'agent' && difficulty >= 2, stakes: d.signals.stakes, deliverable: d.signals.deliverable, longOutput: d.signals.longOutput, explicit: d.signals.explicit })
  return { ...d, category, difficulty, kind, kindWhy: kind === d.kind ? d.kindWhy : 'the tie-breaker says it needs tools', effort, why: `${CATEGORY_LABEL[category]} · tie-breaker`, rule: `${d.rule}+tiebreak`, confident: true }
}

/** One answer per message (message id → answer, or null for "asked, no usable answer"). */
export class TiebreakCache {
  private m = new Map<string, TiebreakAnswer | null>()
  constructor(private cap = 200) {}
  get(id: string): TiebreakAnswer | null | undefined { return this.m.get(id) }
  set(id: string, a: TiebreakAnswer | null): void {
    if (this.m.size >= this.cap) this.m.delete(this.m.keys().next().value as string)
    this.m.set(id, a)
  }
}

export type TiebreakAsk = (o: { model: string; system: string; user: string; schema: typeof TIEBREAK_SCHEMA; signal: AbortSignal }) => Promise<string>

/**
 * The decision, possibly corrected by the tie-breaker. Never throws and never waits past the timeout: an error,
 * a timeout or an answer outside the schema leaves the rules' decision as it was.
 */
export async function tiebreak(o: { messageId: string; text: string; decision: TaskClass; gate: TiebreakGate; ask: TiebreakAsk; cache: TiebreakCache; timeoutMs?: number }): Promise<{ decision: TaskClass; asked: boolean; ms: number }> {
  const start = Date.now()
  if (!tiebreakAllowed(o.decision, o.gate)) return { decision: o.decision, asked: false, ms: 0 }
  const cached = o.cache.get(o.messageId)
  if (cached !== undefined) return { decision: cached ? mergeTiebreak(o.decision, cached) : o.decision, asked: false, ms: 0 }
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((res) => { timer = setTimeout(() => { ctrl.abort(); res(undefined) }, o.timeoutMs ?? TIEBREAK_TIMEOUT_MS) })
  const { system, user } = tiebreakPrompt(o.text)
  const reply = await Promise.race([o.ask({ model: o.gate.model!, system, user, schema: TIEBREAK_SCHEMA, signal: ctrl.signal }).catch(() => undefined), timeout])
  if (timer) clearTimeout(timer)
  const answer = reply ? parseTiebreak(reply) : undefined
  o.cache.set(o.messageId, answer ?? null)
  return { decision: answer ? mergeTiebreak(o.decision, answer) : o.decision, asked: true, ms: Date.now() - start }
}
