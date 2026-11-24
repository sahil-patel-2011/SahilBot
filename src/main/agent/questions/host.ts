import type { QueueQuestion, Settings } from '@shared/types'
import type { Db } from '../../db'
import type { LearnedAnswer, Learner } from './learn'
import { ATTENDED_GRACE_MS, botAutonomyConfig, isAlwaysOnBot, plainOption, recommendedDefault } from './policy'
import { deadlineBlocker, matchTyped, type QuestionQueue, type TypedMatch } from './queue'
import type { StoredItem } from './store'

// What the agent loop (loop.ts) uses for always-on bots: whether a chat is one, its "Always ask for…"
// exceptions and question deadline, saved answers, and the queue itself. Without a host (tests, the main
// chat, groups, projects) the loop asks as it always did.

export interface BotQuestionConfig {
  botId: string
  botName: string
  /** An attended run shows the card this long before moving it to the queue (0 = queue right away). */
  graceMs: number
  deadlineMs: number
  alwaysAsk: string[]
}

export interface QuestionHost {
  config(threadId: string): BotQuestionConfig | null
  learned(botId: string, q: QueueQuestion): LearnedAnswer | null
  learn(botId: string, q: QueueQuestion, answer: string, o: { tainted: boolean; questionId?: string }): void
  postQuestions(o: Parameters<QuestionQueue['postQuestions']>[0]): { item: StoredItem; merged: boolean }
  postApproval(o: Parameters<QuestionQueue['postApproval']>[0]): StoredItem
  takeGrant(threadId: string, tool: string, args: string): boolean
  openFor(threadId: string): StoredItem[]
  /** Which open question a reply typed in the chat answers (none, one clearly, or ambiguous). */
  matchTyped(threadId: string, text: string): TypedMatch
  /** Closes one question with the typed reply (the reply itself reaches the bot). */
  answerTyped(itemId: string, index: number, text: string): StoredItem | undefined
}

export function createQuestionHost(d: { db: Db; settings: { get(): Settings }; queue: QuestionQueue; learner: Learner; grace?: (threadId: string) => number }): QuestionHost {
  return {
    config(threadId) {
      const t = d.db.getThread(threadId)
      // Helper and ask_bot chats (a parent) answer to another run, never to the queue; a routine run beside the bot's
      // busy chat is the bot's own work (its hard stops and Needs you apply, as when it runs in the chat itself).
      if (!t || (t.parentId && !d.db.getState(t.id).routineHost)) return null
      const space = d.db.getSpace(t.spaceId)
      if (!space || !isAlwaysOnBot(space)) return null
      const cfg = botAutonomyConfig(d.settings.get(), space.id)
      const env = process.env.FOREMAN_ASK_GRACE_MS
      const graceMs = env !== undefined && env !== '' && Number.isFinite(Number(env)) ? Math.max(0, Number(env)) : d.grace ? d.grace(threadId) : ATTENDED_GRACE_MS
      return { botId: space.id, botName: space.name, graceMs, deadlineMs: Math.round(cfg.deadlineHours * 3_600_000), alwaysAsk: cfg.alwaysAsk }
    },
    learned: (botId, q) => d.learner.find(botId, q),
    learn: (botId, q, answer, o) => { d.learner.learn(botId, q, answer, { tainted: o.tainted, questionId: o.questionId ?? null, botName: d.db.getSpace(botId)?.name }) },
    postQuestions: (o) => d.queue.postQuestions(o),
    postApproval: (o) => d.queue.postApproval(o),
    takeGrant: (threadId, tool, args) => d.queue.takeGrant(threadId, tool, args),
    openFor: (threadId) => d.queue.openFor(threadId),
    matchTyped: (threadId, text) => matchTyped(d.queue.openFor(threadId), text),
    answerTyped: (itemId, index, text) => d.queue.answerTyped(itemId, index, text)
  }
}

const when = (t: number): string => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** The tool result for questions that went to the queue: don't wait, keep working, here's what happens next. */
export function queuedQuestionText(item: StoredItem, o: { merged: boolean; learned?: string[] }): string {
  const blocker = deadlineBlocker(item.questions)
  const defaults = item.questions.map((q) => recommendedDefault(q)).map((a) => (a ? plainOption(a) : ''))
  const next = !item.deadline ? 'It waits for the user.'
    : blocker ? `If nobody answers by ${when(item.deadline)} it keeps waiting (${blocker.replace(/^Question \d+: /, '')}), so plan around it.`
      : `If nobody answers by ${when(item.deadline)}, you'll be told to go ahead with your recommended default${defaults.length > 1 ? 's' : ''} (${defaults.map((a) => `"${a}"`).join(', ')}).`
  return [
    ...(o.learned?.length ? [`Answered from the user's saved preferences:\n${o.learned.join('\n')}`] : []),
    `${o.merged ? 'Added to the question card you already posted' : 'Posted to the user\'s Needs-you inbox'} (question ${item.id}); the user was notified. Nobody has answered yet.`,
    'Don\'t wait and don\'t ask again: keep working on every part of the task that doesn\'t depend on the answer (research, drafts, other items, other queued work).',
    next,
    'When the answer arrives you get a message, and you pick up the waiting part then. If nothing else can be done now, finish your turn with a short summary: what is done, and what is waiting on the answer.'
  ].join('\n')
}

/** The tool result for an approval that went to the queue. */
export function queuedApprovalText(item: StoredItem): string {
  return `Not done yet: this needs the user's OK, and it is on their Needs-you list (approval ${item.id}; they were notified). It never goes ahead on its own. Don't retry it or work around it. Keep working on everything that doesn't depend on it. If they approve, you get a message and make this exact call again (it won't ask twice).`
}

/** Answers that came from saved preferences, as the tool shows them. */
export function learnedLine(q: QueueQuestion, l: LearnedAnswer): string {
  return `- ${q.question} → ${l.answer} (the user answered this on ${new Date(l.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}; if this case is different, ask a more specific question)`
}

/** Added to an always-on bot's system prompt: questions don't block it, and how it works on its own. */
export const ALWAYS_ON_PROMPT = `

# Working on your own (always-on bot)
The user may be away (traveling, asleep) while you work, so you run with more autonomy than a regular chat:
- Questions don't block you. Before asking, look for the answer yourself: memory (search it), the knowledge base and notes (knowledge_search), your own files and library, and the connected apps (find_tools). Ask only what truly blocks progress or is the user's preference to make, all in one ask_user call: short questions, 2-3 options each, your recommended default first or in "default". Mark taste questions preference:true (the answer is remembered) and set safe:false when going ahead without the user would be risky or hard to undo.
- ask_user posts to the user's Needs-you inbox and returns at once. Keep working on everything that doesn't depend on the answer; the answer comes back as a message later. If nobody answers by the deadline you are told to use your default: then say clearly in your report what you assumed.
- Money, purchases, passwords and codes, deleting the user's data, sending to many people, and public posts always wait for the user. Never work around them.
- Plan your next steps, schedule follow-ups for later checks (follow_up, routines), keep standing goals moving, and stay inside the spending limit; if you are near it, do the cheapest useful thing and say what is left.
- Before you deliver anything, review it against what was asked and fix what's wrong.`
