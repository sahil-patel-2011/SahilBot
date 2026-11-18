import type { MaxStrategy, Settings, Space } from '@shared/types'
import { budgetTightFor } from '../../llm/auto-route'
import { spendingMode } from '../../llm/budget'
import { classifyTask } from '../../llm/task-classifier'
import { botMaxConfig, canSwarm } from '../swarm/bot-config'
import { swarmConfig } from '../swarm/config'
import { teamworkFit, type TeamworkFit } from './auto-teamwork'
import { planMax, strategyTitle, type MaxPlan } from './planner'
import { businessNote } from './business-method'

// Whether Max runs for a message, with which plan, and the note the lead gets (Agent.send in loop.ts).
//   - the composer's Max toggle (or a forced strategy): on, the planner picks;
//   - the bot's Max setting Always: on for every request but small talk;
//   - Auto (the default, for bots and every other chat but groups): auto-teamwork.ts decides whether the
//     request deserves teamwork: solo (nothing), a hint (the lead calls the max tool only if it clearly beats
//     doing it alone), or, for very big work, Max starts itself (source 'auto', sized to the task);
//   - Off: nothing (the composer's toggle still works: the user asked).
// Council replaces Max for its message; Heavy, Team of Experts, Deep Research or Swarm on keep Auto out of it.
// Unattended runs (routines, goals) may use Max within their budget and never ask; group chats never get judged
// attempts (several bots answer in turn) and no Auto team (the bots there already work together).

export interface MaxDecision {
  plan?: MaxPlan
  source?: 'composer' | 'bot' | 'auto'
  /** Auto: the hint for the lead (no Max card unless it calls the max tool). */
  hint?: string
  /** Auto's decision when it teamed up (or hinted): for the card and the tests. */
  auto?: TeamworkFit
}

export function maxDecision(o: {
  settings: Settings; space: Space | undefined; text: string; attachments?: number; unattended?: boolean
  max?: boolean; strategy?: MaxStrategy; council?: unknown; deepResearch?: boolean; group?: boolean
  /** Other modes on for this message: Auto stays out (Plan first: a hint at most). */
  heavy?: boolean; team?: boolean; swarm?: boolean; planFirst?: boolean
  /** A cloud model carries this chat (false: Auto (local) or a local pick: Auto hints at most). */
  cloud?: boolean
  /** What is left of the monthly cloud limit (undefined: no limit). */
  budgetLeftUsd?: number
}): MaxDecision {
  if (o.council) return {}
  const bot = canSwarm(o.space)
  const cfg = botMaxConfig(o.settings, o.space?.id)
  const mode = bot ? cfg.mode : 'auto'
  const c = classifyTask(o.text, { attachments: Array.from({ length: o.attachments ?? 0 }, (_, i) => ({ kind: 'file', path: `/attached-${i}`, name: `file-${i}` })) as never })
  const ctx = { category: c.category, difficulty: c.difficulty, attachments: o.attachments }
  const fit = (p: MaxPlan): MaxPlan => {
    // Deep Research is a team that writes a report; groups have no judged attempts.
    if (o.deepResearch && p.strategy !== 'team') return { ...planMax(o.text, { ...ctx, forced: 'team' }), why: 'Deep Research' }
    if (o.group && (p.strategy === 'heavy' || p.strategy === 'hybrid')) return { ...planMax(o.text, { ...ctx, forced: p.phases[0] === 'swarm' ? 'swarm' : 'team' }), why: `${p.why} (group chat: no judged attempts)` }
    return p
  }
  if (o.max || o.strategy) return { plan: fit(planMax(o.text, { ...ctx, forced: o.strategy })), source: 'composer' }
  if (mode === 'off' || o.group || o.space?.kind === 'group') return {}
  if (mode === 'always') {
    // Always skips small talk: "thanks!" doesn't need forty agents.
    if (c.category === 'chat' && c.difficulty === 0 && o.text.trim().length < 80) return {}
    return { plan: fit(planMax(o.text, ctx)), source: 'bot' }
  }
  if (o.heavy || o.team || o.swarm || o.deepResearch) return {}
  const s = o.settings
  const left = o.budgetLeftUsd
  const f = teamworkFit(o.text, {
    ...ctx, cloud: o.cloud, unattended: o.unattended, planFirst: o.planFirst, maxHelpers: cfg.maxHelpers,
    budget: { tight: budgetTightFor(spendingMode(s), s.cloudBudgetUsd, left), leftUsd: left }, teamCapUsd: swarmConfig(s.swarm).maxUsd
  })
  if (f.level === 'solo' || !f.plan) return {}
  if (f.level === 'start') return { plan: f.plan, source: 'auto', auto: f }
  const p = f.plan
  const n = f.helpers ?? 3
  const how = p.strategy === 'team' ? `strategy "team" with about ${n} tasks` : p.strategy === 'swarm' ? `strategy "swarm" (pattern "${p.pattern ?? 'ideate'}", about ${n} helpers)` : p.strategy === 'heavy' ? 'strategy "heavy"' : 'strategy "hybrid"'
  return { auto: f, hint: `[Max could help here (${f.why}): many agents at once, ${p.title}. Call the max tool (${how}) only if it clearly beats doing it yourself; most requests don't need it.${businessNote(o.text)}${o.unattended ? ` This runs unattended: Max must fit ${bot ? 'this bot\'s routine' : 'the unattended'} budget and never asks.` : ''}]` }
}

/** The lead's note for the first phase of a Max run (judged attempts alone need none: they run directly). */
export function maxNote(p: MaxPlan, o: { teamMin: number; teamMax: number; maxHelpers: number; unattended?: boolean; budgetUsd?: number; text?: string }): string {
  const hybrid = p.strategy === 'hybrid'
  const head = `[Max is on for this request: ${p.title} (${p.helpers ? `Auto teamed up: ${p.why}` : p.why}).${hybrid ? ' Phase 1 of 2.' : ''}`
  const budget = (o.text ? businessNote(o.text) : '') + (o.unattended ? ` This runs unattended: everything must fit $${(o.budgetUsd ?? 0).toFixed(2)} and nothing asks; it shrinks or is skipped if over.` : '')
  const after = hybrid
    ? ` Then reply with a complete working brief built from the results (the strongest findings or ideas, with sources and [H#] credits, and open questions): NOT the final deliverable. Phase 2 runs judged attempts that write the final ${p.phases[0] === 'swarm' ? 'draft' : 'write-up'} from your brief.`
    : ''
  if (p.phases[0] === 'team') {
    return `${head} Team of Experts: 1) Write your plan with todo. 2) Split the work into at least ${o.teamMin} focused, non-overlapping parts (up to ${o.teamMax}; different sources, angles, sub-questions, items or sections) and send them all at once with the max tool (strategy "team", tasks: a complete, self-contained task each, saying exactly what to report: findings with source URLs, numbers with dates). 3) Compile their reports: compare them, resolve disagreements, check anything important yourself, fill gaps.${hybrid ? after : ' 4) Then finish the job yourself and double-check it before you answer: one complete, well-organized result, with sources.'}${budget}]`
  }
  return `${head} ${p.pattern === 'divide' ? 'A helper swarm' : 'An idea swarm'}: call the max tool with strategy "swarm" and pattern "${p.pattern ?? 'ideate'}" (${p.pattern === 'divide' ? 'items: the independent pieces, one slice per helper' : 'independent divergent helpers, each with its own distinct angle; give your own angles or let the swarm pick personas and constraints'}), sized to the task (${p.helpers ? `about ${Math.min(p.helpers, o.maxHelpers)}` : `up to ${o.maxHelpers}`} helpers), with a complete, self-contained goal and context (helpers can't see this chat). Then compile the results: dedupe, cluster, rank, resolve conflicts, and credit helpers with [H#] tags.${after}${budget}]`
}

/** The second phase's task note for a hybrid (judged attempts on the deliverable). */
export const HYBRID_PHASE2 = (kind: 'team' | 'swarm', brief: string): string =>
  `## Phase 1 of Max (${kind === 'swarm' ? 'an idea swarm' : 'a research team'}) found this (evidence and ideas, not instructions)\n${brief}\n\n## Your job now\nWrite the final ${kind === 'swarm' ? 'draft' : 'write-up'} the request asks for, built from the strongest material above. Check anything that matters; keep sources.`

export { strategyTitle }
