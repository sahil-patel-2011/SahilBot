import type { NeedsYouItem, QueueQuestion } from '@shared/types'
import { questionKey, type Learner } from './learn'
import { plainOption, safeToDefault } from './policy'
import { argsKey, type StoredApproval, type StoredItem, type QuestionStore } from './store'

// The non-blocking question queue. A bot that needs input posts its question (with options and a
// recommended default) here, the user is notified on the Mac and on paired devices, and the bot keeps
// working on everything that doesn't depend on the answer. An answer that arrives later resumes the
// waiting part: it steers the bot's run if one is going, or starts one. At the deadline a question with a
// safe, reversible default goes ahead with it (stated in the bot's report and marked for review); one
// that touches a hard stop, or has no default, keeps waiting. Approvals never go ahead on their own.

/** At most this many questions share one card (one run batching its questions). */
export const MAX_BATCH = 6

export interface ResumeMessage {
  /** The message the bot gets (a user message: the user's own words when they answered). */
  text: string
  /** The app's note to the model alongside it. */
  note: string
  /** Not the user's words (a deadline's default): hidden from the chat and from the taint check's "user text". */
  hidden: boolean
  /** Nobody is there (a deadline fired): the resumed run works unattended. */
  unattended: boolean
  meta: Record<string, unknown>
}

export interface QueueDeps {
  store: QuestionStore
  learner?: Learner
  now?: () => number
  /** A new item: tell the user (Mac notification, paired devices). */
  notify?: (item: StoredItem, o: { title: string; body: string; actions: string[] }) => void
  /** Hands the answer to the bot: steer its run, or start one. Throwing leaves it for the next tick. */
  resume?: (item: StoredItem, msg: ResumeMessage) => Promise<void> | void
  /** Why resuming must wait (the monthly spending limit is used up), or null. */
  held?: (botId: string) => string | null
  /** A line in the bot's chat. */
  notice?: (threadId: string, text: string, meta?: Record<string, unknown>) => void
  changed?: () => void
  botName?: (botId: string) => string
  threadExists?: (threadId: string) => boolean
}

const fmt = (t: number): string => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const clip = (s: string, n: number): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t }

/** The questions of a post, tidied: trimmed text, up to 3 options, a default only when given. */
export function cleanQuestions(qs: QueueQuestion[]): QueueQuestion[] {
  return qs.filter((q) => q && typeof q.question === 'string' && q.question.trim()).map((q) => ({
    question: clip(q.question, 500),
    ...(Array.isArray(q.options) && q.options.length ? { options: q.options.filter((o) => typeof o === 'string' && o.trim()).slice(0, 3).map((o) => clip(o, 160)) } : {}),
    ...(typeof q.default === 'string' && q.default.trim() ? { default: clip(q.default, 160) } : {}),
    ...(q.preference ? { preference: true } : {}),
    ...(q.safe === false ? { safe: false } : {})
  }))
}

/**
 * Why a deadline won't answer these questions on its own, or null when every one has a safe default.
 * Questions already answered (a reply typed in the chat) don't count.
 */
export function deadlineBlocker(qs: QueueQuestion[], answers: string[] = []): string | null {
  for (let i = 0; i < qs.length; i++) {
    if (answers[i]) continue
    const s = safeToDefault(qs[i], { declaredUnsafe: qs[i].safe === false })
    if (!s.ok) return qs.length > 1 ? `Question ${i + 1}: ${s.why}` : s.why
  }
  return null
}

/** What the bot is told when its questions are answered (by the user, or by a deadline's defaults). */
export function resumeMessage(x: Pick<StoredItem, 'id' | 'kind' | 'questions' | 'answers' | 'answeredBy' | 'approval' | 'deadline'>, o: { previous?: string[] } = {}): ResumeMessage {
  const meta = { questionAnswer: x.id }
  if (x.kind === 'approval') {
    const what = x.approval ? `${x.approval.label}${x.approval.summary ? `: ${x.approval.summary}` : ''}` : 'the action'
    if (x.answers[0] === 'approve') {
      return { text: `Approved: ${clip(what, 300)}`, hidden: false, unattended: false, meta, note: `[The user approved the action you queued earlier (${clip(what, 200)}). Make that exact call again now, with the same arguments: it won't ask again. Then carry on with the task.]` }
    }
    return { text: `Declined: ${clip(what, 300)}`, hidden: false, unattended: false, meta, note: `[The user declined the action you queued earlier (${clip(what, 200)}). Don't do it or work around it. Carry on without it, and say what is left undone.]` }
  }
  const pairs = x.questions.map((q, i) => ({ q: q.question, a: x.answers[i] ?? '' }))
  const lines = pairs.map((p, i) => `${pairs.length > 1 ? `${i + 1}. ` : ''}${p.q}\n   → ${p.a || '(no answer: use your best judgment and say what you assumed)'}`).join('\n')
  if (x.answeredBy === 'default') {
    return {
      text: `[From the app] Nobody answered your question${pairs.length > 1 ? 's' : ''} by the deadline${x.deadline ? ` (${fmt(x.deadline)})` : ''}, so go ahead with your recommended default${pairs.length > 1 ? 's' : ''}:\n${lines}`,
      note: '[Continue the part of the task that was waiting on this. In your report, say clearly that you assumed this because there was no answer, and that it is marked for the user\'s review (they can change it in Needs you).]',
      hidden: true, unattended: true, meta: { ...meta, questionDefault: x.id }
    }
  }
  if (o.previous) {
    const changed = pairs.map((p, i) => ({ ...p, was: o.previous![i] ?? '' })).filter((p) => p.a && p.a !== p.was)
    return {
      text: changed.length ? changed.map((p) => `For "${clip(p.q, 160)}": ${p.a} (instead of ${p.was || 'your default'})`).join('\n') : `Your assumption${pairs.length > 1 ? 's are' : ' is'} fine as they are.`,
      note: '[You went ahead with your default because nobody answered by the deadline. The user has now reviewed it. Update what you did to match their answer (redo the parts that used the old assumption), and say what you changed.]',
      hidden: false, unattended: false, meta: { ...meta, questionReview: x.id }
    }
  }
  return {
    text: pairs.length === 1 ? `Answer to "${clip(pairs[0].q, 160)}": ${pairs[0].a}` : `Answers to your questions:\n${pairs.map((p, i) => `${i + 1}. ${clip(p.q, 120)} → ${p.a}`).join('\n')}`,
    note: `[This answers the question${pairs.length > 1 ? 's' : ''} you posted earlier (Needs you):\n${lines}\nPick up the part of the task that was waiting on it. Don't redo work that is already done.]`,
    hidden: false, unattended: false, meta
  }
}

export class QuestionQueue {
  private now: () => number
  /** Items being delivered right now (a tick and an answer can't both deliver one). */
  private delivering = new Set<string>()

  constructor(private d: QueueDeps) {
    this.now = d.now ?? Date.now
  }

  get store(): QuestionStore {
    return this.d.store
  }

  /**
   * Posts questions. A second post from the same run while the first card is still unanswered joins that
   * card (one card, not a stream of them), up to MAX_BATCH questions.
   */
  postQuestions(o: { botId: string; threadId: string; runKey?: string | null; questions: QueueQuestion[]; deadlineMs: number; tainted?: boolean }): { item: StoredItem; merged: boolean } {
    const questions = cleanQuestions(o.questions)
    if (!questions.length) throw new Error('Give a question, or questions.')
    if (o.runKey) {
      const open = this.d.store.list({ status: ['open'], threadId: o.threadId }).find((x) => x.kind === 'question' && x.runKey === o.runKey && !x.expired && x.questions.length < MAX_BATCH)
      if (open) {
        const seen = new Set(open.questions.map((q) => q.question.toLowerCase()))
        const merged = this.d.store.update(open.id, (x) => {
          for (const q of questions) if (!seen.has(q.question.toLowerCase()) && x.questions.length < MAX_BATCH) x.questions.push(q)
          x.hardStop = deadlineBlocker(x.questions, x.answers)
          x.tainted ||= !!o.tainted
        })!
        this.d.changed?.()
        return { item: merged, merged: true }
      }
    }
    const item = this.d.store.insert({
      botId: o.botId, threadId: o.threadId, kind: 'question', questions, hardStop: deadlineBlocker(questions),
      deadline: this.now() + Math.max(60_000, o.deadlineMs), tainted: !!o.tainted, runKey: o.runKey ?? null
    })
    const first = questions[0]
    this.d.notify?.(item, {
      title: `${this.d.botName?.(o.botId) ?? 'Your bot'} has a question`,
      body: `${first.question}${questions.length > 1 ? ` (+${questions.length - 1} more)` : ''}`,
      actions: questions.length === 1 ? (first.options ?? []).map(plainOption) : []
    })
    this.d.changed?.()
    return { item, merged: false }
  }

  /** Posts an approval for one exact call. The same call already waiting is not posted twice. */
  postApproval(o: { botId: string; threadId: string; runKey?: string | null; tool: string; label: string; summary?: string; reason?: string; args: string; hardStop?: string | null; tainted?: boolean }): StoredItem {
    const key = argsKey(o.tool, o.args)
    const same = this.d.store.list({ status: ['open'], threadId: o.threadId }).find((x) => x.kind === 'approval' && x.approval?.argsKey === key)
    if (same) return same
    const approval: StoredApproval = { tool: o.tool, label: o.label, ...(o.summary ? { summary: clip(o.summary, 400) } : {}), ...(o.reason ? { reason: clip(o.reason, 300) } : {}), args: o.args.slice(0, 4000), argsKey: key }
    const item = this.d.store.insert({
      botId: o.botId, threadId: o.threadId, kind: 'approval', questions: [], approval,
      // Approvals never go ahead on their own: no deadline, and the reason it asked is why.
      hardStop: o.hardStop ?? o.reason ?? 'needs your OK', deadline: null, tainted: !!o.tainted, runKey: o.runKey ?? null
    })
    this.d.notify?.(item, { title: `${this.d.botName?.(o.botId) ?? 'Your bot'} needs your OK`, body: o.summary ?? `Use ${o.label}`, actions: ['approve', 'deny'] })
    this.d.changed?.()
    return item
  }

  /**
   * The user's answer (one per question, or 'approve' / 'deny'). Answering an assumption the bot made at a
   * deadline changes it: the bot is told to update its work. Answers to preference questions are learned.
   */
  async answer(id: string, answer: string[] | 'approve' | 'deny'): Promise<StoredItem | undefined> {
    const cur = this.d.store.get(id)
    if (!cur) return undefined
    if (cur.status === 'cancelled' || (cur.status === 'answered' && cur.answeredBy === 'user')) return cur
    let previous: string[] | undefined
    if (cur.kind === 'approval') {
      if (cur.status !== 'open') return cur
      const a = answer === 'approve' || (Array.isArray(answer) && /^(approve|allow|yes|once)/i.test(answer[0] ?? '')) ? 'approve' : 'deny'
      this.d.store.update(id, (x) => { x.status = 'answered'; x.answers = [a]; x.answeredBy = 'user'; x.answeredAt = this.now(); x.resumed = false })
    } else {
      const raw = Array.isArray(answer) ? answer : [answer === 'approve' ? 'Yes' : 'No']
      const answers = cur.questions.map((_q, i) => plainOption(String(raw[i] ?? '').slice(0, 2000)))
      if (cur.status === 'defaulted') previous = cur.answers
      this.d.store.update(id, (x) => { x.status = 'answered'; x.answers = answers; x.answeredBy = 'user'; x.answeredAt = this.now(); x.review = false; x.resumed = false })
      const botName = this.d.botName?.(cur.botId)
      cur.questions.forEach((q, i) => { if (answers[i]) this.d.learner?.learn(cur.botId, q, answers[i], { questionId: cur.id, tainted: cur.tainted, botName }) })
    }
    this.d.changed?.()
    await this.deliver(id, previous)
    return this.d.store.get(id)
  }

  /**
   * A reply the user typed in the bot's chat answers one question (matchTyped found it). The message itself
   * reaches the bot (it starts or steers the run), so nothing is resumed separately: once every question of
   * the card has an answer the card closes as answered. Preference answers are learned as usual.
   */
  answerTyped(id: string, index: number, text: string): StoredItem | undefined {
    const cur = this.d.store.get(id)
    if (!cur || cur.status !== 'open' || cur.kind !== 'question' || !cur.questions[index]) return cur
    const answer = text.replace(/\s+/g, ' ').trim().slice(0, 2000)
    if (!answer) return cur
    const next = this.d.store.update(id, (x) => {
      x.answers = x.questions.map((_q, i) => (i === index ? answer : x.answers[i] ?? ''))
      if (x.answers.every(Boolean)) { x.status = 'answered'; x.answeredBy = 'user'; x.answeredAt = this.now(); x.review = false; x.resumed = true }
      x.hardStop = deadlineBlocker(x.questions, x.answers)
    })
    this.d.learner?.learn(cur.botId, cur.questions[index], answer, { questionId: cur.id, tainted: cur.tainted, botName: this.d.botName?.(cur.botId) })
    this.d.changed?.()
    return next
  }

  /** "Looks good" on an assumption: it leaves the review list. */
  reviewed(id: string): void {
    this.d.store.update(id, (x) => { x.review = false })
    this.d.changed?.()
  }

  /** The chat is gone (or the run was stopped for good): its open items are cancelled. */
  cancelThread(threadId: string): void {
    for (const x of this.d.store.list({ status: ['open'], threadId })) this.d.store.update(x.id, (y) => { y.status = 'cancelled' })
    this.d.changed?.()
  }

  /** Deadlines, then anything answered that the bot hasn't been given yet (held by the budget, or a failed resume). */
  async tick(): Promise<void> {
    const now = this.now()
    for (const x of this.d.store.due(now)) {
      if (this.d.threadExists && !this.d.threadExists(x.threadId)) { this.d.store.update(x.id, (y) => { y.status = 'cancelled' }); continue }
      const blocker = x.kind === 'approval' ? (x.hardStop ?? 'needs your OK') : deadlineBlocker(x.questions, x.answers)
      if (blocker) {
        // No safe default (a hard stop, or nothing to go ahead with): it keeps waiting, and the user hears once.
        this.d.store.update(x.id, (y) => { y.expired = true; y.hardStop = blocker })
        this.d.notice?.(x.threadId, `Still waiting for you · ${clip(x.questions[0]?.question ?? x.approval?.summary ?? 'a question', 120)} (past its deadline; it won't go ahead on its own because ${blocker.replace(/^Question \d+: /, '')})`, { questionExpired: x.id })
        this.d.notify?.(this.d.store.get(x.id)!, { title: `${this.d.botName?.(x.botId) ?? 'Your bot'} is still waiting for you`, body: x.questions[0]?.question ?? 'A question is past its deadline', actions: [] })
        continue
      }
      const answers = x.questions.map((q, i) => { if (x.answers[i]) return x.answers[i]; const s = safeToDefault(q, { declaredUnsafe: q.safe === false }); return s.ok ? s.answer : '' })
      this.d.store.update(x.id, (y) => { y.status = 'defaulted'; y.answers = answers; y.answeredBy = 'default'; y.answeredAt = now; y.review = true; y.resumed = false })
      this.d.notice?.(x.threadId, `No answer by the deadline · going ahead with ${answers.map((a) => `"${clip(a, 60)}"`).join(', ')} (marked for your review in Needs you)`, { questionDefault: x.id })
      this.d.changed?.()
      await this.deliver(x.id)
    }
    await this.resumeWaiting()
  }

  /** Answered items the bot hasn't been given yet (at launch, and on every tick). */
  async resumeWaiting(): Promise<void> {
    for (const x of this.d.store.unresumed()) await this.deliver(x.id)
  }

  private async deliver(id: string, previous?: string[]): Promise<void> {
    if (this.delivering.has(id)) return
    const x = this.d.store.get(id)
    if (!x || x.resumed || (x.status !== 'answered' && x.status !== 'defaulted')) return
    if (this.d.threadExists && !this.d.threadExists(x.threadId)) { this.d.store.update(id, (y) => { y.resumed = true }); return }
    const held = this.d.held?.(x.botId) ?? null
    if (held) {
      if (x.heldFor !== held) {
        this.d.store.update(id, (y) => { y.heldFor = held })
        this.d.notice?.(x.threadId, `Answer saved · the bot picks this up once it can spend again (${held})`, { questionHeld: id })
      }
      return
    }
    this.delivering.add(id)
    try {
      await this.d.resume?.(x, resumeMessage(x, { previous }))
      this.d.store.update(id, (y) => { y.resumed = true; y.heldFor = null })
    } catch { /* busy or failed: the next tick tries again */ } finally {
      this.delivering.delete(id)
      this.d.changed?.()
    }
  }

  /**
   * One approved, unused grant for exactly this call in this chat: true once (it is used up). The bot
   * re-makes the call after the user approved it in Needs you.
   */
  takeGrant(threadId: string, tool: string, args: string): boolean {
    const g = this.d.store.grantFor(threadId, argsKey(tool, args))
    if (!g) return false
    this.d.store.update(g.id, (y) => { y.grantUsed = true })
    return true
  }

  /** Open items of one chat (the next run is told what is still waiting). */
  openFor(threadId: string): StoredItem[] {
    // In the order they were asked (the store lists newest first, ties broken by insertion order).
    return this.d.store.list({ status: ['open'], threadId }).reverse()
  }

  /** The inbox: everything open, plus assumptions waiting for review (newest first). */
  inbox(): NeedsYouItem[] {
    const rows = [...this.d.store.list({ status: ['open'] }), ...this.d.store.list({ status: ['defaulted'] }).filter((x) => x.review)]
    const out: NeedsYouItem[] = []
    for (const x of rows) {
      if (this.d.threadExists && !this.d.threadExists(x.threadId)) { this.d.store.update(x.id, (y) => { y.status = 'cancelled' }); continue }
      out.push(toNeedsYou(x, this.d.botName?.(x.botId) ?? 'Bot'))
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }
}

/** One unanswered question of an open card. */
export interface TypedSlot { itemId: string; index: number; question: string; options?: string[] }

export type TypedMatch = { kind: 'none' } | ({ kind: 'clear' } & TypedSlot) | { kind: 'ambiguous'; slots: TypedSlot[] }

const words = (t: string): Set<string> => new Set(questionKey(t).split(' ').filter(Boolean))

/**
 * Which open question a reply typed in the chat answers. One open question: that one. Several: the one
 * whose option the reply names (or, failing that, the only one it shares two or more significant words
 * with). Anything else is ambiguous, and the user is asked once.
 */
export function matchTyped(items: StoredItem[], text: string): TypedMatch {
  const slots: TypedSlot[] = items.filter((x) => x.kind === 'question' && x.status === 'open')
    .flatMap((x) => x.questions.map((q, index) => ({ itemId: x.id, index, question: q.question, ...(q.options?.length ? { options: q.options } : {}) })).filter((s) => !x.answers[s.index]))
  const t = text.replace(/\s+/g, ' ').trim()
  if (!slots.length || !t) return { kind: 'none' }
  if (slots.length === 1) return { kind: 'clear', ...slots[0] }
  const low = t.toLowerCase()
  const names = (o: string): boolean => {
    const p = plainOption(o).toLowerCase()
    if (!p) return false
    if (low === p) return true
    const at = low.indexOf(p)
    if (at < 0 || p.length < 3) return false
    const before = low[at - 1], after = low[at + p.length]
    return (!before || !/[a-z0-9]/.test(before)) && (!after || !/[a-z0-9]/.test(after))
  }
  const strong = slots.filter((s) => (s.options ?? []).some(names))
  if (strong.length === 1) return { kind: 'clear', ...strong[0] }
  if (strong.length > 1) return { kind: 'ambiguous', slots: strong }
  const mine = words(t)
  const weak = slots.filter((s) => [...words(s.question)].filter((w) => mine.has(w)).length >= 2)
  if (weak.length === 1) return { kind: 'clear', ...weak[0] }
  return { kind: 'ambiguous', slots: weak.length > 1 ? weak : slots }
}

export function toNeedsYou(x: StoredItem, botName: string): NeedsYouItem {
  return {
    id: x.id, source: 'queue', botId: x.botId, botName, threadId: x.threadId, kind: x.kind,
    ...(x.kind === 'question' ? { questions: x.questions } : {}),
    ...(x.approval ? { approval: { tool: x.approval.tool, label: x.approval.label, ...(x.approval.summary ? { summary: x.approval.summary } : {}), ...(x.approval.reason ? { reason: x.approval.reason } : {}) } } : {}),
    status: x.status,
    ...(x.hardStop ? { hardStop: x.hardStop } : {}),
    deadline: x.deadline,
    ...(x.expired ? { expired: true } : {}),
    ...(x.answers.length ? { answers: x.answers } : {}),
    ...(x.answeredBy ? { answeredBy: x.answeredBy } : {}),
    ...(x.review ? { review: true } : {}),
    createdAt: x.createdAt,
    ...(x.answeredAt ? { answeredAt: x.answeredAt } : {})
  }
}
