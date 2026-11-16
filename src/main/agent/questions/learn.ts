import type { QueueQuestion } from '@shared/types'
import { PREFERENCE_QUESTION, decisionFromAnswer, saveDecision, type DecisionMemory } from '../../decisions'
import { hardStopText, looksInstructionLike, stem } from '../permissions'
import { autoMemoryOn } from '../prompt'
import { plainOption } from './policy'
import type { QuestionStore } from './store'

// Learning from answers: a preference the user answered once ("PDF or Word for the weekly report?") is
// kept, per bot, and saved as a decision memory the bot sees in every chat (decisions.ts). The next time
// the bot is about to ask the same thing, the saved answer is used instead. Answers to questions a run
// asked after reading outside content are never learned (a page could steer the question), and neither
// is anything with an address in it or that touches a hard stop.

const STOP = new Set(('a an the to for of on in at by with and or any me my mine i you your it its this that these those do does did ' +
  'should would will can could shall be is are was were am which what how when where who whom whose want like prefer please use using ' +
  'there here than then so if just also into about over from up out now next time one each').split(' '))

const PREFERENCE = PREFERENCE_QUESTION

/** A question's comparable key: its significant words, stemmed and sorted. */
export function questionKey(question: string): string {
  const words = question.toLowerCase().replace(/[“”"'’]/g, '').split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w))
  return [...new Set(words.map(stem))].sort().join(' ')
}

const jaccard = (a: string, b: string): number => {
  const x = new Set(a.split(' ').filter(Boolean)), y = new Set(b.split(' ').filter(Boolean))
  if (!x.size || !y.size) return 0
  let n = 0
  for (const w of x) if (y.has(w)) n++
  return n / (x.size + y.size - n)
}

/** The bot called it a preference, or it reads like one ("Which format do you prefer…?"). */
export function isPreference(q: QueueQuestion): boolean {
  return q.preference === true || PREFERENCE.test(q.question)
}

/** Whether an answer to this question may be remembered. */
export function learnable(q: QueueQuestion, answer: string, o: { tainted?: boolean } = {}): boolean {
  if (o.tainted || !answer.trim() || answer.length > 300) return false
  if (!isPreference(q)) return false
  if (hardStopText(q.question, answer)) return false
  // A question or answer with an address in it (or an answer that reads like an order) isn't a preference to replay.
  if (/(https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+\.[\w.-]+/i.test(`${q.question} ${answer}`)) return false
  if (looksInstructionLike(answer) && /\b(send|forward|upload|transfer|pay|wire|delete|install|run|execute)\b/i.test(answer)) return false
  return true
}

export interface LearnedAnswer { answer: string; question: string; at: number; questionId: string | null }

/** Where learned answers are remembered (the memory store). */
export type MemorySink = DecisionMemory

export class Learner {
  constructor(private store: QuestionStore, private memory?: MemorySink, _now: () => number = Date.now) {}

  /** A saved answer for this question in this bot: the same significant words, or nearly (≥ 75% overlap). */
  find(botId: string, q: QueueQuestion): LearnedAnswer | null {
    const key = questionKey(q.question)
    if (key.split(' ').filter(Boolean).length < 2) return null
    let best: { score: number; row: ReturnType<QuestionStore['learned']>[number] } | null = null
    for (const row of this.store.learned(botId)) {
      const score = row.key === key ? 1 : jaccard(row.key, key)
      if (score >= 0.75 && (!best || score > best.score)) best = { score, row }
    }
    if (!best) return null
    // A saved answer must still be one of the offered options when options are given.
    if (q.options?.length && !q.options.some((o) => plainOption(o).toLowerCase() === best!.row.answer.toLowerCase())) return null
    return { answer: best.row.answer, question: best.row.question, at: best.row.createdAt, questionId: best.row.questionId }
  }

  /**
   * Remembers the user's answer: any choice that generalizes becomes a decision memory for this bot (the
   * same question answered again replaces it), and a preference answer is also kept to answer the same
   * question next time without asking. Nothing from a tainted run (it read outside content).
   */
  learn(botId: string, q: QueueQuestion, answer: string, o: { questionId?: string | null; tainted?: boolean; botName?: string } = {}): { learned: boolean; memoryId?: string } {
    const clean = plainOption(answer)
    let memoryId: string | undefined
    const d = this.memory ? decisionFromAnswer(q, clean, { tainted: o.tainted }) : null
    if (d) {
      try { memoryId = saveDecision(this.memory!, d, botId, { auto: autoMemoryOn() })?.memory.id } catch { /* memory full: the learned answer below still works */ }
    }
    if (!learnable(q, clean, o)) return { learned: false, ...(memoryId ? { memoryId } : {}) }
    this.store.learn(botId, questionKey(q.question), q.question, clean, o.questionId ?? null, memoryId ?? null)
    return { learned: true, ...(memoryId ? { memoryId } : {}) }
  }
}
