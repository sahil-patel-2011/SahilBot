import type { BrainPromptAction, BrainPromptKind, BrainSettings, SourceChip } from '@shared/brain'
import type { GraphStore } from '../context-engine/store'
import { inQuietHours } from './settings'
import type { StoredCommitment } from './store'
import { roleOf } from './briefs'

// Agent mode: after a sync, SahilBot looks at new commitments, deadlines and gaps and reaches out with a
// few high-value prompts (Needs you, a notification, a phone push) instead of waiting to be asked. Every
// prompt is a proposal: nothing happens until the user clicks (Draft it starts a normal chat run under the
// normal permissions), except drafting when the user pre-approved it. Sending is never pre-approvable.
// Ranking: how soon it's due, how much it matters (clients first) and how the user answered that kind of
// prompt before (each dismissal lowers its kind; each accept raises it). At most N a day, none in quiet hours.

const DAY = 86_400_000
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export interface Candidate {
  kind: BrainPromptKind
  ref: string
  entityId?: string
  entityName?: string
  text: string
  detail?: string
  dueAt?: number
  actions: BrainPromptAction[]
  chips: SourceChip[]
  question?: boolean
  placeholder?: string
  /** 0–1 */
  urgency: number
  value: number
}

const midnight = (t: number): number => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }

/** "Friday", "tomorrow", "today", "Nov 30" (more than a week out), "yesterday" / "Mon" when it's past. */
export function dayWords(at: number, now: number): string {
  const days = Math.round((midnight(at) - midnight(now)) / DAY)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  if (days > 1 && days < 7) return WEEKDAY[new Date(at).getDay()]
  if (days < 0 && days > -7) return `last ${WEEKDAY[new Date(at).getDay()]}`
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** When "Remind me" brings it back: the morning of the day before it's due (or tomorrow morning). */
export function remindAt(dueAt: number | undefined, now: number): number {
  const morning = (t: number): number => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9).getTime() }
  if (dueAt) {
    const before = morning(dueAt - DAY)
    if (before > now + 2 * 3_600_000) return before
  }
  return morning(now + DAY)
}

export function remindLabel(dueAt: number | undefined, now: number): string {
  const at = remindAt(dueAt, now)
  const days = Math.round((midnight(at) - midnight(now)) / DAY)
  return days <= 1 ? 'Remind me tomorrow' : `Remind me ${WD[new Date(at).getDay()]}`
}

/** How soon: overdue or due today = 1, a week out ≈ 0; no date = 0.3. */
export function urgency(dueAt: number | undefined, now: number): number {
  if (!dueAt) return 0.3
  const days = (dueAt - now) / DAY
  if (days <= 0.5) return 1
  return Math.max(0, Math.min(1, 1 - days / 7))
}

/** The user's past answers for one kind, smoothed (no history: 0.5). */
export function acceptRate(o: { accepted: number; dismissed: number }): number {
  return (o.accepted + 1) / (o.accepted + o.dismissed + 2)
}

export function score(c: Pick<Candidate, 'urgency' | 'value'>, rate: number): number {
  return Math.round((0.55 * c.urgency + 0.45 * c.value) * (0.3 + rate) * 1000) / 1000
}

/** Commitments worth a prompt: the user owes it within a week (or it's overdue by up to 3 days), or they owe the user and it's late. */
export function commitmentCandidates(list: StoredCommitment[], graph: GraphStore, chips: (c: StoredCommitment) => SourceChip[], now: number): Candidate[] {
  const out: Candidate[] = []
  for (const c of list) {
    if (c.status !== 'open') continue
    const e = c.entityId ? graph.entity(c.entityId) : undefined
    const due = c.dueAt ?? undefined
    if (c.owner === 'user') {
      if (due && (due < now - 3 * DAY || due > now + 7 * DAY)) continue
      if (!due && now - c.createdAt > 5 * DAY) continue
    } else if (!due || due > now || due < now - 10 * DAY) continue
    const role = e ? roleOf(graph, e) : 'person'
    const value = role === 'client' || role === 'contact' ? 1 : Math.min(1, 0.35 + (e?.mentions ?? 0) / 12)
    const when = due ? dayWords(due, now) : ''
    const what = c.what.replace(/^(the|a|an)\s+/i, (m) => m.toLowerCase())
    const text = c.owner === 'user'
      ? `${c.who} asked for ${what}${when ? ` by ${when}` : ''}. Draft it now?`
      : `${c.who} said they’d send ${what}${when ? ` by ${when}` : ''}, and it hasn’t come. Draft a friendly nudge?`
    out.push({
      kind: 'commitment', ref: `commitment:${c.id}`, entityId: c.entityId ?? undefined, entityName: e?.name ?? c.who, text, dueAt: due,
      detail: [due && due < now ? 'Past due' : '', e ? graph.relationViews(e.id, null).find((r) => r.outgoing && r.rel === 'works_at')?.otherName ?? '' : '', role === 'client' || role === 'contact' ? 'client' : ''].filter(Boolean).join(' · ').replace(/^./, (x) => x.toUpperCase()) || undefined,
      actions: [{ id: 'draft', label: c.owner === 'user' ? 'Draft it' : 'Draft the nudge', primary: true }, { id: 'remind', label: remindLabel(due, now) }, { id: 'dismiss', label: 'Not needed' }],
      chips: chips(c), urgency: urgency(due, now), value
    })
  }
  return out
}

/** Gaps worth one question: a client organization with no main contact the brain knows of. */
export function gapCandidates(graph: GraphStore, now: number): Candidate[] {
  const out: Candidate[] = []
  for (const e of graph.entities({ type: 'organization' })) {
    if (e.scope !== null || roleOf(graph, e) !== 'client') continue
    const attrs = graph.attributes(e.id)
    if (attrs.some((a) => a.key === 'main_contact')) continue
    const people = graph.relationViews(e.id, null).filter((r) => !r.outgoing && r.rel === 'works_at')
    if (people.length) continue
    out.push({
      kind: 'gap', ref: `gap:main_contact:${e.id}`, entityId: e.id, entityName: e.name, text: `Who’s your main contact at ${e.name}?`,
      detail: 'So SahilBot knows who to draft for and who to follow up with.', question: true, placeholder: 'Their name (and email, if you know it)',
      actions: [{ id: 'answer', label: 'Save', primary: true }, { id: 'dismiss', label: 'Skip' }], chips: [], urgency: 0.15, value: Math.min(1, 0.6 + e.mentions / 20)
    })
    void now
  }
  return out
}

export interface PickInput {
  candidates: Candidate[]
  settings: Pick<BrainSettings, 'agentMode' | 'maxPromptsPerDay' | 'quietHours'>
  /** Prompts already shown today. */
  surfacedToday: number
  /** Refs the user already saw (any answer), so they're never asked twice. */
  known: (ref: string) => boolean
  rates: Record<BrainPromptKind, { accepted: number; dismissed: number }>
  now: number
}

/** Which candidates reach the user now, best first: none with Agent mode off or in quiet hours, and no more than the day's cap. */
export function pickPrompts(p: PickInput): Array<Candidate & { score: number }> {
  if (!p.settings.agentMode || inQuietHours(p.settings.quietHours, p.now)) return []
  const room = Math.max(0, p.settings.maxPromptsPerDay - p.surfacedToday)
  if (!room) return []
  return p.candidates
    .filter((c) => !p.known(c.ref))
    .map((c) => ({ ...c, score: score(c, acceptRate(p.rates[c.kind])) }))
    // Too weak to be worth interrupting for (a kind the user keeps dismissing sinks below this).
    .filter((c) => c.score >= 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, room)
}
