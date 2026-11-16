import type { Message } from '@shared/types'
import type { Db } from '../db'
import { isRelayed } from '../agent/loop'
import { approvalDecision, approvalKind, decisionFromAnswer, decisionFromPick, decisionsFromCorrection, saveDecision, type UserDecision } from '../decisions'
import type { Memory, MemoryStore } from '../memory'
import { chatHasUntrusted } from './extract'

// Watches the user's own answers, picks, corrections and approval clicks as they happen and remembers the
// decisions in them (decisions.ts: no model call). Wired in index.ts; the agent loop calls it when the user
// answers a question card, sends or steers a message, or answers an approval card. Never for a run that read
// outside content, a message a connected app or another bot sent, a routine, or a helper agent. Approval
// patterns are memories only: nothing here touches permissions, rules or "Always allow".

const STATS_KEY = 'decisions.approvals'
/** The same answer this many times in a row on one kind of action is a pattern worth remembering. */
export const APPROVAL_STREAK = 3
const KEEP = 10
const MAX_KINDS = 200

interface Stat { outcomes: Array<'a' | 'd'>; at: number; memoryId?: string }

export interface DecisionDeps {
  db: Db
  memory: MemoryStore
  /** "Remember things automatically" (Settings → Memory, on by default). */
  auto: () => boolean
  /** Saved vault values: never in a decision. */
  secretValues?: () => string[]
  /** A chat a connected app started. */
  isAppThread?: (threadId: string) => boolean
  now?: () => number
  /** A decision was saved (or updated). */
  onSaved?: (m: Memory, d: UserDecision) => void
}

export interface ApprovalEvent {
  tool: string
  args?: Record<string, unknown>
  label?: string
  summary?: string
  /** 'once' | 'always' | 'deny' (the card), or 'approve' | 'deny' (Needs you). */
  answer: string
  /** The run read outside content: its actions aren't counted. */
  tainted?: boolean
}

export class DecisionRecorder {
  constructor(private d: DecisionDeps) {
    // The user deleted an approval pattern: start counting that kind of action over.
    d.memory.onRemove((m) => {
      if (m.category !== 'decision') return
      const stats = this.stats()
      let hit = false
      for (const s of Object.values(stats)) if (s.memoryId === m.id) { s.outcomes = []; delete s.memoryId; hit = true }
      if (hit) this.d.db.setSetting(STATS_KEY, stats)
    })
  }

  private now(): number { return this.d.now?.() ?? Date.now() }

  /** Memory on and automatic memory on (the same switches every other memory follows). */
  private on(): boolean {
    return this.d.memory.enabled && this.d.auto()
  }

  /**
   * Where a decision made in this chat is kept: a bot's or project's own memories, or shared (the main bot,
   * groups). undefined: not recorded at all (no such chat, or a helper agent's thread).
   */
  private scopeOf(threadId: string, speakerId?: string): string | null | undefined {
    const thread = this.d.db.getThread(threadId)
    if (!thread || thread.parentId) return undefined
    if (this.d.isAppThread?.(threadId)) return undefined
    const space = (speakerId ? this.d.db.getSpace(speakerId) : undefined) ?? this.d.db.getSpace(thread.spaceId)
    if (!space) return null
    if (space.kind === 'project' || (space.kind === 'bot' && !space.isMain)) return space.id
    return null
  }

  private keep(list: UserDecision[], spaceId: string | null): Memory[] {
    const out: Memory[] = []
    for (const d of list) {
      try {
        const r = saveDecision(this.d.memory, d, spaceId, { auto: this.d.auto(), secretValues: this.d.secretValues?.() ?? [] })
        if (r) { out.push(r.memory); this.d.onSaved?.(r.memory, d) }
      } catch { /* a failed save never breaks the chat */ }
    }
    return out
  }

  /** The user answered the agent's question card(s) (ask_user in an attended chat). */
  answers(threadId: string, qs: Array<{ question: string; options?: string[]; preference?: boolean }>, answers: string[], o: { tainted?: boolean; speakerId?: string } = {}): Memory[] {
    if (!this.on() || o.tainted) return []
    const scope = this.scopeOf(threadId, o.speakerId)
    if (scope === undefined) return []
    const list = qs.map((q, i) => (answers[i] ? decisionFromAnswer(q, answers[i]) : null)).filter((x): x is UserDecision => !!x)
    return this.keep(list, scope)
  }

  /**
   * The user sent (or steered with) a message: a pick among the options the agent's last reply offered,
   * and corrections in their own words. Only messages the user typed in a chat they started.
   */
  userMessage(threadId: string, messageId: string, o: { speakerId?: string } = {}): Memory[] {
    if (!this.on()) return []
    const scope = this.scopeOf(threadId, o.speakerId)
    if (scope === undefined) return []
    const msgs = this.d.db.listMessages(threadId)
    const i = msgs.findIndex((m) => m.id === messageId)
    const m = msgs[i]
    if (!m || m.role !== 'user' || m.meta?.hidden || isRelayed(m) || m.meta?.scheduled || m.meta?.goalRun || m.meta?.routine || m.meta?.questionAnswer) return []
    // The agent's turn just before: from the previous message the user saw to this one.
    let start = i - 1
    while (start >= 0 && !(msgs[start].role === 'user' && !msgs[start].meta?.hidden)) start--
    const turn = msgs.slice(start + 1, i)
    // A chat another app or bot started is never the user's own.
    if (msgs.some((x) => x.role === 'user' && !x.meta?.hidden && isRelayed(x))) return []
    const reply = [...turn].reverse().find((x): x is Message => x.role === 'assistant' && x.kind === 'normal' && !x.meta?.hidden && !!x.content.trim())
    const list: UserDecision[] = []
    // Options the agent laid out after reading a page or email aren't the user's to pick from (they came from outside).
    if (reply && !chatHasUntrusted(turn)) {
      const pick = decisionFromPick(reply.content, m.content)
      if (pick) list.push(pick)
    }
    list.push(...decisionsFromCorrection(m.content, { afterReply: !!reply }))
    return this.keep(list, scope)
  }

  /** The changes the user asked for on a proposed plan, in their own words. */
  revision(threadId: string, text: string, o: { speakerId?: string } = {}): Memory[] {
    if (!this.on()) return []
    const scope = this.scopeOf(threadId, o.speakerId)
    if (scope === undefined) return []
    return this.keep(decisionsFromCorrection(text), scope)
  }

  /**
   * The user answered an approval card. Kept as a count per kind of action; a streak of the same answer
   * becomes (or updates) one shared decision memory ("When the agent wants to send an email → usually
   * declines…"). Never a rule or a permission. An approval streak on money or credentials isn't kept.
   */
  approval(threadId: string, a: ApprovalEvent): Memory | null {
    if (!this.on() || a.tainted) return null
    if (this.scopeOf(threadId) === undefined) return null
    const kind = approvalKind(a.tool, a.args ?? {}, { label: a.label, summary: a.summary })
    if (!kind) return null
    const allowed = /^(once|always|approve|allow|yes)/i.test(a.answer)
    if (!allowed && !/^(deny|no|decline)/i.test(a.answer)) return null
    if (allowed && kind.risky) return null
    const stats = this.stats()
    const cur = stats[kind.key] ?? { outcomes: [], at: 0 }
    cur.outcomes = [...cur.outcomes, allowed ? 'a' as const : 'd' as const].slice(-KEEP)
    cur.at = this.now()
    stats[kind.key] = cur
    let streak = 0
    for (let i = cur.outcomes.length - 1; i >= 0 && cur.outcomes[i] === cur.outcomes[cur.outcomes.length - 1]; i--) streak++
    let saved: Memory | null = null
    // At 3 in a row, then refreshed every 5 (the count in the text stays roughly right without churn).
    if (streak >= APPROVAL_STREAK && (streak === APPROVAL_STREAK || streak % 5 === 0)) {
      saved = this.keep([approvalDecision(kind, allowed, streak)], null)[0] ?? null
      if (saved) cur.memoryId = saved.id
    }
    // Only the most recent kinds are counted.
    const keys = Object.keys(stats)
    if (keys.length > MAX_KINDS) for (const k of keys.sort((x, y) => stats[x].at - stats[y].at).slice(0, keys.length - MAX_KINDS)) delete stats[k]
    this.d.db.setSetting(STATS_KEY, stats)
    return saved
  }

  private stats(): Record<string, Stat> {
    const v = this.d.db.getSetting<Record<string, Stat>>(STATS_KEY)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  }
}
