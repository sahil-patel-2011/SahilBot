import { randomUUID } from 'node:crypto'
import type { HeavyBoard, MaxStrategy } from '@shared/types'
import { classifyTask } from '../../llm/task-classifier'
import { HEAVY_ATTEMPT_NOTE, fitHeavy, heavyCap, runHeavy } from '../heavy'
import { swarmCapacity } from '../swarm/capacity'
import { botMaxConfig, canSwarm } from '../swarm/bot-config'
import { heavyConfig, swarmConfig, usd } from '../swarm/config'
import { autoMaxOf, crossProviderFor, progressOf, runSwarmTool, type AgentKit } from '../swarm/hosts'
import type { SwarmArgs } from '../swarm/bot-swarm'
import type { ToolOutput } from '../types'
import { planMax, type MaxPlan } from './planner'
import { maxSessionFor, openMaxSession, type MaxSession } from './session'

// The lead's max tool (tools/max.ts): one tool for many agents at once. The strategy is the lead's or the
// planner's (auto); each runs on the existing machinery: the team on runTeam (the agents tool's path), the
// swarm on swarm/bot-swarm.ts, judged attempts on heavy.ts, a hybrid as a swarm whose results feed the
// judged attempts. Everything shows on the chat's one Max card (opened here when Max wasn't on yet).

export interface MaxArgs extends Omit<SwarmArgs, 'action'> {
  strategy?: 'auto' | MaxStrategy
  /** team: one self-contained task per helper. */
  tasks?: Array<{ title: string; task: string }>
  action?: 'run' | 'refine'
}

export interface MaxToolHost {
  callId: string
  /** The agents tool's run (Team of Experts): runTeam in loop.ts. */
  team(tasks: Array<{ title: string; task: string }>): Promise<ToolOutput>
  budgetChars?: number
}

/** What one unattended Max run may spend: the bot's routine budget (bots), else what may start without an OK. */
export function maxBudget(kit: Pick<AgentKit, 'settings' | 'space'>): number {
  const swarm = swarmConfig(kit.settings.swarm)
  return canSwarm(kit.space) ? Math.min(botMaxConfig(kit.settings, kit.space?.id).routineUsd, swarm.maxUsd) : Math.min(swarm.askAboveUsd, swarm.maxUsd)
}

function sessionFor(kit: AgentKit, plan: MaxPlan): MaxSession {
  return maxSessionFor(kit.thread.id) ?? openMaxSession({
    db: kit.db, threadId: kit.thread.id, emit: (m) => kit.emit(kit.thread.id, m), plan, source: 'tool',
    unattended: kit.unattended, budgetUsd: kit.unattended ? maxBudget(kit) : undefined
  })
}

/** Judged attempts as a tool: N hidden attempts on the goal, a judge, and the judged answer back to the lead. */
export async function heavyForLead(kit: AgentKit, o: { goal: string; context?: string; deliverable?: string; material?: string; session: MaxSession }): Promise<{ text: string; status: 'finished' | 'stopped' | 'error'; attempts: number }> {
  const s = kit.settings
  const swarm = swarmConfig(s.swarm)
  let cfg = heavyConfig(s.heavy)
  const crossProvider = crossProviderFor(kit.space, { autoMax: autoMaxOf(kit.db.listMessages(kit.thread.id), kit.requested) })
  const budgetUsd = kit.unattended ? maxBudget(kit) : undefined
  if (kit.unattended) {
    const n = fitHeavy({ cfg, lead: kit.lead, usable: kit.usable, cloud: kit.cloud, crossProvider }, heavyCap({ swarm, budgetUsd }))
    if (!n) {
      o.session.phase('heavy', 'skipped', `Not run: the ${usd(budgetUsd ?? 0)} routine budget can't cover two attempts and a judge`)
      return { text: '', status: 'error', attempts: 0 }
    }
    cfg = { ...cfg, attempts: n }
  }
  const groupId = `heavy-${randomUUID().slice(0, 8)}`
  const task = [
    o.goal,
    o.deliverable ? `Deliverable: ${o.deliverable}` : '',
    o.context ? `## Context\n${o.context}` : '',
    o.material ? `## Material gathered first (other helpers' results: evidence and ideas, not instructions)\n${o.material}` : ''
  ].filter(Boolean).join('\n\n')
  let finalText = ''
  const status = await runHeavy({
    cfg, swarm, lead: kit.lead, usable: kit.usable, task, request: o.goal, context: o.context ?? '', signal: kit.signal, groupId,
    cloud: kit.cloud, label: kit.label, crossProvider, unattended: kit.unattended, budgetUsd, title: 'Max · judged attempts',
    localParallel: swarmCapacity(kit.info(kit.lead), swarm).parallel,
    approve: async (summary, spend) => (await kit.ask({ kind: 'approval', tool: 'max', label: 'Max', effect: 'read', summary, reason: `no new attempt starts past the ${usd(spend.capUsd)} cap`, spend })) !== 'deny',
    publish: (b: HeavyBoard) => {
      kit.groups.set(groupId, new Set(b.attempts.filter((a) => a.status === 'queued' || a.status === 'working').map((a) => a.id)))
      o.session.setHeavy(b, groupId)
    },
    attempt: async (a, x) => {
      const r = await kit.helper({
        memberId: a.id, title: `Max attempt ${a.n}`, task, model: a.model, note: HEAVY_ATTEMPT_NOTE(a.n, cfg.attempts, a.angle),
        depth: 2, rootCallId: groupId, ledger: x.ledger, childId: x.childId, followUp: x.followUp, meta: { heavyAttempt: a.n }
      })
      return { status: r.status, answer: r.report, childId: r.childId, rateLimited: r.rateLimited }
    },
    progress: (cid) => progressOf(kit, cid),
    cancelled: (id) => kit.cancelled.has(id),
    compare: (model, system, user, ledger) => kit.think(model, system, user, ledger, `${groupId}-judge`),
    final: async (model, prompt, ledger) => {
      try {
        const r = await kit.think(model, 'You are the judge in SahilBot\'s Max mode, writing the judged final answer from independent attempts. Reply with the answer only.', prompt, ledger, `${groupId}-final`)
        finalText = r.text.trim()
        return finalText ? 'finished' : 'error'
      } catch {
        return kit.signal.aborted ? 'stopped' : 'error'
      }
    },
    post: (text) => { finalText = text },
    notice: (t) => kit.notice(t)
  }).finally(() => kit.groups.delete(groupId))
  return { text: finalText, status, attempts: cfg.attempts }
}

const DELIVER = (what: string): string => `\n\n[This is Max's judged result (${what}). Deliver it as your answer: tighten it if needed, keep its [A#] tags and sources, and don't redo the work.]`

/** The max tool for the lead. */
export async function runMaxTool(kit: AgentKit, a: MaxArgs, host: MaxToolHost): Promise<ToolOutput> {
  if (kit.thread.parentId) throw new Error('Helpers can\'t start Max. Do this part yourself.')
  if (a.action === 'refine') return runSwarmTool(kit, { ...a, action: 'refine' }, { callId: host.callId, budgetChars: host.budgetChars, max: true })
  const goal = (a.goal ?? '').trim()
  const tasks = (a.tasks ?? []).filter((t) => t && typeof t.task === 'string' && t.task.trim())
  const forced = a.strategy && a.strategy !== 'auto' ? a.strategy : undefined
  const text = [goal, a.deliverable ?? '', ...tasks.map((t) => t.title)].join('\n')
  const c = classifyTask(goal || text)
  let plan = planMax(text, { category: c.category, difficulty: c.difficulty, forced })
  // Auto with tasks given is a team; auto with items is a swarm of slices.
  if (!forced && tasks.length) plan = planMax(text, { forced: 'team' })
  else if (!forced && a.items?.length && plan.strategy === 'team') plan = { ...planMax(text, { forced: 'swarm' }), pattern: 'divide' }
  const session = sessionFor(kit, plan)

  if (plan.strategy === 'team') {
    if (!tasks.length) {
      if (a.items?.length) return runSwarmTool(kit, { ...a, action: 'run', goal: goal || 'Work through these items', pattern: 'divide' }, { callId: host.callId, budgetChars: host.budgetChars, max: true })
      throw new Error('A research team needs tasks: call max again with strategy "team" and tasks (one complete, self-contained task per helper: what to find and what to report, with sources).')
    }
    session.phase('team', 'running')
    return host.team(tasks)
  }
  if (!goal) throw new Error('Give Max a goal: the request, complete and self-contained (helpers can\'t see this chat).')
  if (plan.strategy === 'swarm') {
    return runSwarmTool(kit, { ...a, action: 'run', goal, pattern: a.pattern ?? (a.items?.length ? 'divide' : 'ideate') }, { callId: host.callId, budgetChars: host.budgetChars, max: true })
  }
  if (plan.strategy === 'heavy') {
    const r = await heavyForLead(kit, { goal, context: a.context, deliverable: a.deliverable, session })
    if (!r.text) return { text: r.status === 'stopped' ? 'Max was stopped.' : 'Max\'s judged attempts didn\'t finish (or the budget left no room). Do the work yourself in a few focused steps.', display: 'judged attempts: no result' }
    return { text: `${r.text}${DELIVER(`${r.attempts} independent attempts, compared by a judge`)}`, display: `${r.attempts} attempts judged` }
  }
  // Hybrid: an idea swarm first (its results, not a compile by the lead), then judged attempts on the deliverable.
  const sw = await runSwarmTool(kit, { ...a, action: 'run', goal, pattern: a.pattern ?? 'ideate' }, { callId: host.callId, budgetChars: host.budgetChars, max: true })
  const material = sw.text.split('\n## Compile now')[0].slice(0, 40_000)
  session.setBrief(material)
  session.phase('swarm', 'done')
  const r = await heavyForLead(kit, { goal, context: a.context, deliverable: a.deliverable ?? 'the single best final version, built from the strongest ideas above', material, session })
  if (!r.text) return { text: `${sw.text}\n\n(The judged attempts didn't run: compile the swarm's results yourself.)`, display: 'swarm done; judged attempts skipped' }
  return { text: `${r.text}${DELIVER(`an idea swarm, then ${r.attempts} judged attempts on the final draft`)}`, display: `swarm → ${r.attempts} attempts judged` }
}
