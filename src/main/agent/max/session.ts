import { randomUUID } from 'node:crypto'
import type { HeavyBoard, MaxBoard, MaxPhase, MaxPhaseKind, Message, SwarmBoard, TeamMember } from '@shared/types'
import type { Db } from '../../db'
import { creditsOf } from '../swarm/bot-swarm'
import { PHASE_LABEL, type MaxPlan } from './planner'

// One live Max card per running request. While a Max session is open for a chat, the team, swarm and Heavy
// boards that would each have shown their own card publish into it instead (loop.ts runTeam and heavy(),
// swarm/hosts.ts card()), so the chat shows ONE card: the strategy and why, then each phase (helpers with
// model, status and cost; attempts with the judge's notes), then the compiled result with its credits.

const live = new Map<string, MaxSession>()

/** The open Max session of a chat (its root thread), if any. */
export const maxSessionFor = (threadId: string | undefined): MaxSession | undefined => (threadId ? live.get(threadId) : undefined)

/** Open sessions (tests). */
export const openMaxSessions = (): number => live.size

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** [A2] / [A1, A3] tags in a judged answer, counted per attempt. */
export function attemptCredits(text: string, max = 8): Array<{ n: number; count: number }> {
  const counts = new Map<number, number>()
  for (const m of text.matchAll(/\[(A\d(?:\s*[,;/&]\s*A?\d)*)\]/g)) {
    for (const d of m[1].matchAll(/\d/g)) {
      const n = Number(d[0])
      if (n >= 1 && n <= max) counts.set(n, (counts.get(n) ?? 0) + 1)
    }
  }
  return [...counts].map(([n, count]) => ({ n, count })).sort((a, b) => a.n - b.n)
}

const teamStatus = (ms: TeamMember[]): MaxPhase['status'] =>
  ms.some((m) => m.status === 'working' || m.status === 'queued') ? 'running' : ms.some((m) => m.status === 'done') ? 'done' : ms.every((m) => m.status === 'stopped') ? 'stopped' : 'failed'
const swarmStatus = (b: SwarmBoard): MaxPhase['status'] =>
  b.phase === 'done' ? 'done' : b.phase === 'failed' ? 'failed' : b.phase === 'stopped' ? 'stopped' : 'running'
const heavyStatus = (b: HeavyBoard): MaxPhase['status'] =>
  b.judge.status === 'done' ? 'done' : b.judge.status === 'failed' ? 'failed' : b.judge.status === 'stopped' ? 'stopped' : 'running'

export class MaxSession {
  readonly board: MaxBoard
  private message?: Message

  constructor(private o: { db: Db; threadId: string; emit: (m: Message) => void; plan: MaxPlan; source: MaxBoard['source']; unattended?: boolean; budgetUsd?: number }) {
    const p = o.plan
    this.board = {
      maxId: `max-${randomUUID().slice(0, 8)}`, strategy: p.strategy, title: p.title, why: p.why, source: o.source,
      phases: p.phases.map((kind) => ({ kind, label: PHASE_LABEL[kind], status: 'waiting' as const })),
      status: 'running', unattended: o.unattended || undefined, budgetUsd: o.budgetUsd, startedAt: Date.now()
    }
    if (this.board.phases[0]) this.board.phases[0].status = 'running'
  }

  get id(): string { return this.board.maxId }
  get threadId(): string { return this.o.threadId }

  publish(): void {
    const { db, threadId } = this.o
    const meta = { max: JSON.parse(JSON.stringify(this.board)) as MaxBoard, maxId: this.board.maxId }
    if (!this.message) this.message = db.insertMessage({ threadId, role: 'assistant', content: `Max · ${this.board.title}`, kind: 'notice', status: 'done', meta })
    else { this.message.meta = { ...this.message.meta, ...meta }; db.updateMessage(this.message) }
    this.o.emit({ ...this.message, meta: { ...this.message.meta } })
  }

  /** The phase of this kind (the first not finished, else the last), created when the plan didn't have it. */
  private phaseOf(kind: MaxPhaseKind): MaxPhase {
    const all = this.board.phases.filter((p) => p.kind === kind)
    const open = all.find((p) => p.status === 'running' || p.status === 'waiting')
    if (open) return open
    if (all.length) return all[all.length - 1]
    const p: MaxPhase = { kind, label: PHASE_LABEL[kind], status: 'running' }
    this.board.phases.push(p)
    return p
  }

  phase(kind: MaxPhaseKind, status: MaxPhase['status'], note?: string): void {
    const p = this.phaseOf(kind)
    p.status = status
    if (note !== undefined) p.note = note
    // The next waiting phase starts when one finishes.
    if (status === 'done') { const next = this.board.phases.find((x) => x.status === 'waiting'); if (next && next.kind !== kind) next.status = 'running' }
    this.publish()
  }

  setTeam(callId: string, members: TeamMember[]): void {
    const teams = this.board.teams ?? (this.board.teams = [])
    const t = teams.find((x) => x.callId === callId)
    if (t) t.members = members.map((m) => ({ ...m }))
    else teams.push({ callId, members: members.map((m) => ({ ...m })) })
    const p = this.phaseOf('team')
    p.status = teamStatus(teams.flatMap((x) => x.members))
    this.publish()
  }

  setSwarm(b: SwarmBoard): void {
    this.board.swarm = b
    const p = this.phaseOf('swarm')
    // A swarm's compile is the lead's answer: in a hybrid the phase is done once the lead has the results.
    p.status = b.phase === 'compiling' && this.board.strategy === 'hybrid' ? 'running' : swarmStatus(b)
    this.publish()
  }

  setHeavy(b: HeavyBoard, heavyId: string): void {
    this.board.heavy = b
    this.board.heavyId = heavyId
    const p = this.phaseOf('heavy')
    p.status = heavyStatus(b)
    this.publish()
  }

  /** A hybrid's first phase result, as handed to the judged attempts. */
  setBrief(text: string): void {
    this.board.brief = clip(text.trim(), 1600)
    this.publish()
  }

  note(kind: MaxPhaseKind, text: string): void {
    this.phaseOf(kind).note = text
    this.publish()
  }

  /** The request's run ended: its last answer is the result; credits from [H#] and [A#] tags. */
  finish(answer: string, status: 'finished' | 'stopped' | 'error'): void {
    const text = answer.trim()
    if (text) {
      const credits = [
        ...creditsOf(text, this.board.swarm?.helpers.length ?? 50).map((c) => ({ tag: `H${c.n}`, count: c.count })),
        ...attemptCredits(text, this.board.heavy?.attempts.length ?? 8).map((c) => ({ tag: `A${c.n}`, count: c.count }))
      ]
      this.board.result = { excerpt: clip(text, 900), credits }
    }
    for (const p of this.board.phases) {
      if (p.status === 'running') p.status = status === 'finished' ? 'done' : status === 'stopped' ? 'stopped' : 'failed'
      else if (p.status === 'waiting') p.status = 'skipped'
    }
    this.board.status = status === 'finished' && text ? 'done' : status === 'stopped' ? 'stopped' : 'failed'
    this.board.endedAt = Date.now()
    this.publish()
    if (live.get(this.o.threadId) === this) live.delete(this.o.threadId)
  }

  close(): void {
    if (live.get(this.o.threadId) === this) live.delete(this.o.threadId)
  }
}

/** Opens (and shows) the Max card for a chat's request; replaces one left open by an earlier run. */
export function openMaxSession(o: ConstructorParameters<typeof MaxSession>[0]): MaxSession {
  live.get(o.threadId)?.close()
  const s = new MaxSession(o)
  live.set(o.threadId, s)
  s.publish()
  return s
}

/** The run ended: the open session (if any) records the answer and closes. */
export function finishMax(threadId: string, answer: string, status: 'finished' | 'stopped' | 'error'): void {
  live.get(threadId)?.finish(answer, status)
}
