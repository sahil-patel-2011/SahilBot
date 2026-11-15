import type { CouncilBoard, HeavyBoard, Message, SwarmBoard, TeamMember } from '@shared/types'

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
 * The mode flags a message goes out with. Heavy and Council replace the others (their members can't ask
 * questions or run the chat's team); Deep Research always brings the team; Swarm (bot chats) goes with Team,
 * Deep Research and Plan first.
 */
export function modeFlags(o: { team?: boolean; deep?: boolean; planFirst?: boolean; heavy?: boolean; swarm?: boolean; council?: true | string[] | null }): { team: boolean; deepResearch: boolean; planFirst: boolean; heavy?: true; swarm?: true; council?: true | string[] } {
  if (o.council) return { team: false, deepResearch: false, planFirst: false, council: o.council }
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

/** A notice that carries one of the swarm cards (swarm, council, ask_bot). */
export const isCardNotice = (m: Pick<Message, 'kind' | 'meta'>): boolean => !!(swarmOf(m) || councilOf(m) || askBotOf(m))

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
