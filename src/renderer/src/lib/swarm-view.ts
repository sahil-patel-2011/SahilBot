import type { CouncilBoard, HeavyBoard, MaxBoard, Message, SwarmBoard, TeamMember } from '@shared/types'

// Pure helpers for the Team board, the Heavy card and the composer's mode chips (kept out of the
// components so they can be tested without a window).

export type MemberGroup = { status: TeamMember['status']; label: string; members: TeamMember[] }

const ORDER: Array<[TeamMember['status'], string]> = [['working', 'Working'], ['queued', 'Queued'], ['done', 'Done'], ['failed', 'Failed'], ['stopped', 'Stopped']]

/** A team's helpers grouped by status, busiest first; empty groups left out. */
export function groupMembers(members: TeamMember[]): MemberGroup[] {
  return ORDER.map(([status, label]) => ({ status, label, members: members.filter((m) => m.status === status) })).filter((g) => g.members.length)
}

/** Cost and tokens of the whole team so far. */
export function teamTotals(members: Array<Pick<TeamMember, 'usd' | 'tokens'>>): { usd: number; tokens: number } {
  return members.reduce<{ usd: number; tokens: number }>((t, m) => ({ usd: t.usd + (m.usd ?? 0), tokens: t.tokens + (m.tokens ?? 0) }), { usd: 0, tokens: 0 })
}

/** "$0.42", "<$0.01", "" for nothing spent. */
export function money(n: number | undefined): string {
  if (!n) return ''
  if (n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}

/** "12.3k tok", "1.2M tok", "" for none. */
export function tokenCount(n: number | undefined): string {
  if (!n) return ''
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M tok`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`
  return `${n} tok`
}

/** The Heavy card a notice message carries (meta.heavy), if it does. */
export function heavyOf(m: Pick<Message, 'kind' | 'meta'>): { board: HeavyBoard; id: string } | undefined {
  const b = m.meta?.heavy as HeavyBoard | undefined
  if (m.kind !== 'notice' || !b || !Array.isArray(b.attempts) || !b.judge) return undefined
  return { board: b, id: String(m.meta?.heavyId ?? '') }
}

/**
 * The mode flags a message goes out with. Council replaces the others (its members can't ask questions or run the
 * chat's team); Max goes with Plan first and Deep Research (it then researches with a team); Deep Research always
 * brings the team. heavy / swarm / team are the older modes' flags (Max covers them; kept for queued messages).
 */
export function modeFlags(o: { team?: boolean; deep?: boolean; planFirst?: boolean; heavy?: boolean; swarm?: boolean; max?: boolean; council?: true | string[] | null }): { team: boolean; deepResearch: boolean; planFirst: boolean; heavy?: true; swarm?: true; max?: true; council?: true | string[] } {
  if (o.council) return { team: false, deepResearch: false, planFirst: false, council: o.council }
  if (o.max) return { team: !!o.deep, deepResearch: !!o.deep, planFirst: !!o.planFirst, max: true }
  if (o.heavy) return { team: false, deepResearch: false, planFirst: false, heavy: true }
  return { team: !!(o.team || o.deep), deepResearch: !!o.deep, planFirst: !!o.planFirst, ...(o.swarm ? { swarm: true as const } : {}) }
}

/** The swarm card a notice carries (meta.swarm), if it does. */
export function swarmOf(m: Pick<Message, 'kind' | 'meta'>): { board: SwarmBoard; id: string } | undefined {
  const b = m.meta?.swarm as SwarmBoard | undefined
  if (m.kind !== 'notice' || !b || !Array.isArray(b.helpers)) return undefined
  return { board: b, id: String(m.meta?.swarmId ?? b.swarmId ?? '') }
}

/** The Council card a notice carries (meta.council), if it does. */
export function councilOf(m: Pick<Message, 'kind' | 'meta'>): { board: CouncilBoard; id: string } | undefined {
  const b = m.meta?.council as CouncilBoard | undefined
  if (m.kind !== 'notice' || !b || !Array.isArray(b.members)) return undefined
  return { board: b, id: String(m.meta?.councilId ?? b.councilId ?? '') }
}

export interface AskBotView { bot: string; botId: string; color?: string; shape?: string; from?: string; question: string; status: 'asking' | 'answered' | 'failed' | 'stopped'; answer?: string; usd?: number; childId?: string }

/** The "Asked <bot>" card a notice carries (meta.askBot), if it does. */
export function askBotOf(m: Pick<Message, 'kind' | 'meta'>): AskBotView | undefined {
  const v = m.meta?.askBot as AskBotView | undefined
  return m.kind === 'notice' && v && typeof v.bot === 'string' ? v : undefined
}

/** The Max card a notice carries (meta.max), if it does. */
export function maxOf(m: Pick<Message, 'kind' | 'meta'>): MaxBoard | undefined {
  const b = m.meta?.max as MaxBoard | undefined
  return m.kind === 'notice' && b && Array.isArray(b.phases) && typeof b.strategy === 'string' ? b : undefined
}

/** Team calls (agents / max) shown inside a Max card: their own Team card is left out of the chat. */
export function maxTeamCalls(messages: Array<Pick<Message, 'kind' | 'meta'>>): Set<string> {
  const ids = new Set<string>()
  for (const m of messages) for (const t of maxOf(m)?.teams ?? []) ids.add(t.callId)
  return ids
}

/** Everything a Max run spent and how many agents it ran, across its phases. */
export function maxTotals(b: MaxBoard): { usd: number; agents: number; done: number } {
  const team = (b.teams ?? []).flatMap((t) => t.members)
  const usd = teamTotals(team).usd + (b.swarm?.spentUsd ?? 0) + (b.heavy?.spentUsd ?? 0)
  const agents = team.length + (b.swarm?.helpers.length ?? 0) + (b.heavy?.attempts.length ?? 0)
  const done = team.filter((m) => m.status === 'done').length + (b.swarm?.helpers.filter((h) => h.status === 'done').length ?? 0) + (b.heavy?.attempts.filter((a) => a.status === 'done').length ?? 0)
  return { usd, agents, done }
}

/** A notice that carries one of the swarm cards (Max, swarm, council, ask_bot). */
export const isCardNotice = (m: Pick<Message, 'kind' | 'meta'>): boolean => !!(maxOf(m) || swarmOf(m) || councilOf(m) || askBotOf(m))

/** Swarm progress for the card's header: done of total, ideas so far, the top-credited helpers. */
export function swarmStats(b: SwarmBoard): { done: number; total: number; ideas: number; working: number; top: Array<{ n: number; count: number }> } {
  const done = b.helpers.filter((h) => h.status === 'done').length
  const working = b.helpers.filter((h) => h.status === 'working').length
  const ideas = b.ideas?.total ?? b.helpers.reduce((s, h) => s + (h.ideas?.length ?? 0), 0)
  const top = [...(b.compiled?.credits ?? [])].sort((x, y) => y.count - x.count || x.n - y.n).slice(0, 5)
  return { done, total: b.helpers.length, ideas, working, top }
}

/** Live: some members haven't finished. */
export const unfinished = (members: Array<Pick<TeamMember, 'status'>>): number => members.filter((m) => m.status === 'working' || m.status === 'queued').length
