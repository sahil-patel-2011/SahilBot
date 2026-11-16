import { randomUUID } from 'node:crypto'
import type { CouncilBoard, Message, ModelInfo, PendingRequest, Settings, Space, SwarmBoard, Thread } from '@shared/types'
import type { Db } from '../../db'
import { autoVariant } from '../../llm/router'
import { classifyTask as classifyRoute } from '../../llm/task-classifier'
import { botMaxConfig, canSwarm, councilConfig } from './bot-config'
import { maxSessionFor } from '../max/session'
import type { ToolOutput, ThreadState } from '../types'
import { BOT_SWARM_LIMIT, rateLimitedRecently, runBotSwarm, swarmFit, type BotSwarmHost, type HelperResult, type SwarmArgs } from './bot-swarm'
import { isCloudInfo, swarmCapacity } from './capacity'
import { swarmConfig } from './config'
import { runCouncil, type CouncilHost } from './council'
import { SwarmLedger, threadCost } from './ledger'
import { councilMembers, providerOf, secondOpinionFor } from './models'

// The Agent's side of bot swarms and councils: what loop.ts hands over (AgentKit) and the hosts built on it,
// kept here so the loop only gains a few anchored lines.

export interface KitHelper {
  memberId: string; title: string; task: string; model: string; note: string; depth: number; rootCallId: string
  ledger: SwarmLedger; childId?: string; followUp?: string; onChild?: (id: string) => void
  /** Only these tools (swarm helpers: read-only). */
  toolAllow?: string[]
  /** Never looser than this (swarm helpers: 'ask', so anything that changes something is skipped). */
  modeCap?: 'ask'
  meta?: Record<string, unknown>
}

export interface AgentKit {
  db: Db
  thread: Thread
  space: Space | undefined
  settings: Settings
  /** The lead's model (resolved) and what the chat asked for (Auto variants). */
  lead: string
  requested: string
  usable: ModelInfo[]
  info(model: string): ModelInfo | undefined
  cloud(model: string): boolean
  label(model: string): string
  signal: AbortSignal
  unattended: boolean
  emit(threadId: string, message: Message): void
  notice(text: string): void
  ask(req: Omit<PendingRequest, 'id' | 'threadId'>): Promise<string>
  helper(o: KitHelper): Promise<HelperResult>
  think(model: string, system: string, user: string, ledger: SwarmLedger, memberId: string): Promise<{ text: string; usd: number }>
  final(model: string, prompt: string, ledger: SwarmLedger, meta: Record<string, unknown>): Promise<'finished' | 'stopped' | 'error'>
  /** Ids for Stop remaining and cancel (the Agent's maps). */
  groups: Map<string, Set<string>>
  cancelled: Set<string>
  /** Runs a registered tool for the lead after the user approved it (Cursor launches). */
  runTool?(name: string, args: Record<string, unknown>): Promise<ToolOutput>
}

/** Bots (not SahilBot's own chats) work across providers; normal agent chats stay with the lead's provider. */
export const crossProviderFor = (space: Pick<Space, 'kind' | 'isMain'> | undefined): boolean => !!space && space.kind === 'bot' && !space.isMain

/**
 * This run's Max and swarm state. The max tool is listed for leads (never helpers) unless the bot's Max setting
 * is Off; Max on for this request (the composer, the bot's Always) lists it whatever the setting. The swarm tool
 * is the max tool's older name: still runs for chats that call it (in-flight threads), listed only when loaded.
 */
export function applySwarmState(state: ThreadState, s: Settings, space: Space | undefined, helper: boolean, messages: () => Message[], load: (names: string[]) => void): void {
  if (helper || state.depth) { state.swarm = undefined; state.max = undefined; return }
  const last = [...messages()].reverse().find((m) => m.role === 'user' && !m.meta?.hidden)
  const mode = botMaxConfig(s, space?.id).mode
  const on = !!last?.meta?.max
  state.max = on ? 'on' : canSwarm(space) ? mode : 'auto'
  state.swarm = on ? (mode === 'off' ? 'auto' : mode) : canSwarm(space) && mode !== 'off' ? mode : undefined
  if (state.max !== 'off' && (on || last?.meta?.maxHint || last?.meta?.swarm || last?.meta?.swarmHint)) load(['max'])
}

/** The note and flags a message gets for swarms: the toggle or Always turn it on; Auto hints when it fits. */
export function swarmNote(s: Settings, space: Space | undefined, text: string, o: { swarm?: boolean; attachments?: number; unattended?: boolean }): { note?: string; meta?: Record<string, unknown> } {
  if (!canSwarm(space)) return {}
  const cfg = botMaxConfig(s, space!.id)
  if (cfg.mode === 'off') return {}
  const budget = o.unattended ? ` This runs unattended: the swarm must fit this bot's routine budget ($${cfg.routineUsd.toFixed(2)}) and never asks; it shrinks or is skipped if over.` : ''
  if (o.swarm || cfg.mode === 'always') {
    return { note: `[Swarm is on for this request: use the swarm tool. Pick the pattern (ideate: independent ideas from distinct angles; divide: many independent items, one slice per helper), size it to the task (how many items, how broad; up to ${cfg.maxHelpers}), give a complete, self-contained goal and context, then compile the results into one answer with [H#] credits.${budget}]`, meta: { swarm: true } }
  }
  const fit = swarmFit(text, o)
  if (!fit.fit) return {}
  return { note: `[A swarm could help here (${fit.why}): temporary helpers working in parallel (${fit.pattern === 'ideate' ? 'divergent ideation' : 'divide and conquer'}), then you compile. Use the swarm tool only if it clearly beats doing it yourself.${budget}]`, meta: { swarmHint: true } }
}

/** A card on a notice message in the lead's chat, updated in place. */
function card(kit: AgentKit, threadId: string, content: string, key: 'swarm' | 'council', idKey: 'swarmId' | 'councilId', id: string): (board: SwarmBoard | CouncilBoard) => void {
  let m: Message | undefined
  return (board) => {
    // A Max run shows one card: the swarm is a phase of it.
    const mx = key === 'swarm' ? maxSessionFor(threadId) : undefined
    if (mx) { mx.setSwarm(board as SwarmBoard); return }
    if (!m) m = kit.db.insertMessage({ threadId, role: 'assistant', content, kind: 'notice', status: 'done', meta: { [key]: board, [idKey]: id } })
    else { m.meta = { ...m.meta, [key]: board }; kit.db.updateMessage(m) }
    kit.emit(threadId, { ...m, meta: { ...m.meta } })
  }
}

/** Live cost, what it's doing and its text so far, from a helper's own messages. */
export function progressOf(kit: AgentKit, childId: string): { usd: number; tokens: number; detail?: string; text?: string } {
  const ms = kit.db.listMessages(childId)
  const last = [...ms].reverse().find((m) => m.role === 'tool' || (m.role === 'assistant' && m.content))
  const text = [...ms].reverse().find((m) => m.role === 'assistant' && m.content)?.content
  return { ...threadCost(ms, (m) => kit.cloud(m)), detail: last?.role === 'tool' ? String(last.meta?.display ?? last.toolName ?? '') : last?.content.replace(/\s+/g, ' ').slice(0, 90), text }
}

/** Runs the swarm tool for the lead. */
export async function runSwarmTool(kit: AgentKit, a: SwarmArgs, o: { callId: string; budgetChars?: number; max?: boolean }): Promise<ToolOutput> {
  const { thread, space } = kit
  const cfg = botMaxConfig(kit.settings, space?.id)
  // Max runs swarms anywhere (projects and SahilBot's chats too); the old swarm tool only in bots with Max on.
  const maxOn = o.max || !!maxSessionFor(thread.id)
  if (!maxOn && (!canSwarm(space) || cfg.mode === 'off')) throw new Error('Max is off for this bot (its Max setting). Do the work yourself.')
  if (thread.parentId) throw new Error('Helpers and council members can\'t start swarms. Do the work yourself, or split it with the agents tool.')
  const swarm = swarmConfig(kit.settings.swarm)
  const swarmId = `swarm-${o.callId.replace(/[^\w-]/g, '').slice(-6)}${randomUUID().slice(0, 4)}`
  const publish = card(kit, thread.id, `Swarm: ${a.goal?.slice(0, 80) ?? ''}`, 'swarm', 'swarmId', swarmId)
  const host: BotSwarmHost = {
    swarmId, threadId: thread.id, bot: { id: space?.id ?? thread.spaceId, name: space?.name ?? 'SahilBot' }, cfg, swarm,
    lead: kit.lead, usable: kit.usable, category: classifyRoute(a.goal ?? '').category,
    localOnly: autoVariant(kit.requested) === 'auto:local', crossProvider: crossProviderFor(space),
    cloud: kit.cloud, label: kit.label,
    capacity: (m) => {
      const c = swarmCapacity(kit.info(m), swarm)
      // A bot's own Max helpers rules its swarms on the cloud (up to 50); local models stay RAM-bound.
      return c.cloud || isCloudInfo(kit.info(m)) ? { maxAgents: BOT_SWARM_LIMIT, parallel: swarm.maxParallel } : c
    },
    unattended: kit.unattended, signal: kit.signal, rateLimitedRecently: rateLimitedRecently(),
    approve: async (summary, spend) => (await kit.ask({ kind: 'approval', tool: 'swarm', label: 'Swarm', effect: 'read', summary, reason: `no new helper starts past the $${spend.capUsd.toFixed(2)} cap`, spend })) !== 'deny',
    publish: (b) => {
      kit.groups.set(swarmId, new Set(b.helpers.filter((x) => x.status === 'queued' || x.status === 'working').map((x) => x.id)))
      publish(b)
    },
    helper: (x, h) => kit.helper({
      memberId: x.id, title: `Swarm H${x.n}: ${x.title}`.slice(0, 80), task: h.task, model: x.model, note: h.note, depth: 2, rootCallId: swarmId,
      ledger: h.ledger, childId: h.childId, followUp: h.followUp, onChild: h.onChild, toolAllow: h.tools.length ? h.tools : undefined, modeCap: 'ask', meta: { swarmHelper: x.n }
    }),
    progress: (cid) => progressOf(kit, cid),
    cancelled: (id) => kit.cancelled.has(id),
    compile: (model, system, user, ledger) => kit.think(model, system, user, ledger, `${swarmId}-compile`),
    budgetChars: o.budgetChars
  }
  try {
    const r = await runBotSwarm(host, a)
    return { text: r.text, display: r.display, meta: { swarmId } }
  } finally {
    kit.groups.delete(swarmId)
  }
}

export const COUNCIL_MEMBER_NOTE = (n: number, of: number): string => `

# You are a council member
You are member ${n} of ${of} on a council of AI models from different providers carrying out the user's request together. The message below is your part of the merged plan.
- Work fully with your tools. You may split a big step with the agents tool (cheaper helpers).
- Nobody can approve actions for you, and no other member can either: anything that needs the user's OK is skipped. List it under "Waiting for approval" with exactly what you would do; the user approves it in the chat.
- Reply with the "### Step n" sections your brief asks for, then "Waiting for approval" if anything is.`

/** Council for this request: true / [] = Auto members, ids = those. */
export async function runCouncilFor(kit: AgentKit, o: { request: string; context: string; chosen?: string[] }): Promise<'finished' | 'stopped' | 'error'> {
  const s = kit.settings
  const cfg = councilConfig({ ...s.council, ...(o.chosen?.length ? { members: o.chosen } : {}) })
  const picked = councilMembers(cfg.members, kit.usable, kit.lead)
  if (picked.members.length < 2) { kit.notice(picked.note ?? 'Council needs at least two cloud models.'); return 'error' }
  if (picked.note) kit.notice(`Council: ${picked.note}`)
  const councilId = `council-${randomUUID().slice(0, 8)}`
  const publish = card(kit, kit.thread.id, 'Council', 'council', 'councilId', councilId)
  // A second opinion from a third provider (Grok, say) only in bots, and only when the chair asks for it.
  const second = crossProviderFor(kit.space) ? secondOpinionFor(picked.members, kit.usable) : undefined
  const hasCursor = !!kit.runTool && !!(s as { hasCursorKey?: boolean }).hasCursorKey
  const host: CouncilHost = {
    councilId, members: picked.members, critics: picked.critics, secondOpinion: second, rounds: cfg.rounds,
    swarm: swarmConfig(s.swarm), request: o.request, context: o.context,
    cloud: kit.cloud, label: kit.label, provider: (m) => providerOf(kit.info(m) ?? m), signal: kit.signal,
    approve: async (summary, spend) => (await kit.ask({ kind: 'approval', tool: 'council', label: 'Council', effect: 'read', summary, reason: `nothing new starts past the $${spend.capUsd.toFixed(2)} cap`, spend })) !== 'deny',
    publish: (b) => {
      kit.groups.set(councilId, new Set(b.members.filter((m) => m.status === 'working').map((m) => m.id)))
      publish(b)
    },
    think: (model, system, user, ledger, memberId) => kit.think(model, system, user, ledger, memberId),
    execute: async (x) => {
      const r = await kit.helper({
        memberId: x.memberId, title: `Council member ${x.member + 1}`, task: x.task, model: x.model, note: COUNCIL_MEMBER_NOTE(x.member + 1, picked.members.length),
        depth: 1, rootCallId: councilId, ledger: x.ledger, childId: x.childId, followUp: x.followUp, meta: { councilMember: x.member + 1 }
      })
      return { ...r, usd: r.childId ? progressOf(kit, r.childId).usd : 0 }
    },
    askUser: kit.unattended ? undefined : (question, options) => kit.ask({ kind: 'question', question, options }),
    cursor: hasCursor ? async ({ instructions, repo }) => {
      // The one approval path: the user OKs the launch on the lead chat's card. No member can.
      const answer = await kit.ask({ kind: 'approval', tool: 'cursor', label: 'Cursor', effect: 'write_external', summary: `Council: start a Cursor cloud agent on ${repo} with the instructions the council wrote and reviewed`, args: instructions, reason: 'starts a cloud agent that opens a pull request' })
      if (answer === 'deny') return { ok: false, text: 'The user declined the Cursor launch. The instructions are ready if they want it later.' }
      const out = await kit.runTool!('cursor', { action: 'cloud_launch', repo, task: instructions, wait: true, minutes: 20 })
      return { ok: true, text: out.text }
    } : undefined,
    final: (model, prompt, ledger) => kit.final(model, prompt, ledger, { councilId }),
    notice: (t) => kit.notice(t)
  }
  try {
    return await runCouncil(host)
  } finally {
    kit.groups.delete(councilId)
  }
}
