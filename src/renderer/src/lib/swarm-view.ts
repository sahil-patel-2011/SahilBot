import type { HeavyBoard, Message, TeamMember } from '@shared/types'

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
 * The mode flags a message goes out with. Heavy replaces the others (its attempts can't ask questions
 * or run teams); Deep Research always brings the team.
 */
export function modeFlags(o: { team?: boolean; deep?: boolean; planFirst?: boolean; heavy?: boolean }): { team: boolean; deepResearch: boolean; planFirst: boolean; heavy?: true } {
  if (o.heavy) return { team: false, deepResearch: false, planFirst: false, heavy: true }
  return { team: !!(o.team || o.deep), deepResearch: !!o.deep, planFirst: !!o.planFirst }
}

/** Live: some members haven't finished. */
export const unfinished = (members: Array<Pick<TeamMember, 'status'>>): number => members.filter((m) => m.status === 'working' || m.status === 'queued').length
