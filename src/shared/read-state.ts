// Read state: which replies you haven't seen yet, and where the "NEW" divider goes.
//
// Every chat keeps one `lastReadAt` in the database (threads.last_read_at), so the Mac app and SahilBot
// Server's web UI agree. A reply is unread when it is newer than that mark and it is something the bot
// said to you: its own visible words. Hidden instructions, helper/system notices (routine notices, cards,
// "Continue" lines), compaction summaries, superseded drafts and your own messages never count.
//
// The SQL in src/main/db.ts (UNREAD_SQL) says the same thing; tests/unit/read-state.test.ts keeps them in step.

import type { Message, Space, Thread } from './types'

/** Unread counts stop here (the sidebar shows "99+"). */
export const UNREAD_CAP = 99

/** A message that counts toward unread: the bot's own visible reply. */
export function countsAsUnread(m: Pick<Message, 'role' | 'kind' | 'content' | 'meta'>): boolean {
  if (m.role !== 'assistant' || m.kind !== 'normal' || !m.content) return false
  const meta = m.meta
  return !meta || (!meta.hidden && !meta.superseded && !meta.routineNotice)
}

/** How many replies are newer than `after` (capped at UNREAD_CAP). */
export function unreadCount(messages: Message[], after: number): number {
  let n = 0
  for (const m of messages) if (m.createdAt > after && countsAsUnread(m) && ++n >= UNREAD_CAP) break
  return n
}

/** The first reply newer than `after`, if any. */
export function firstUnread(messages: Message[], after: number): Message | undefined {
  return messages.find((m) => m.createdAt > after && countsAsUnread(m))
}

/** The newest reply's time (0 when there is none): scans from the end, so it is cheap on long chats. */
export function newestReplyAt(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (countsAsUnread(messages[i])) return messages[i].createdAt
  return 0
}

/** The newest message of any kind on screen: what "read up to here" means when you've seen the bottom. */
export function newestAt(messages: Message[]): number {
  let t = 0
  for (let i = messages.length - 1; i >= 0 && i >= messages.length - 50; i--) t = Math.max(t, messages[i].createdAt)
  return t
}

/**
 * Whether a chat gets the "NEW" divider, and why:
 *   'bot'    a bot's (or a group's) conversation: they work on their own, so you come back to catch up;
 *   'agent'  a chat where the agent did real work: the thread ran on the full agent path (toolMode 'full',
 *            set for good the first time a request needs tools beyond the chat set), or, for chats saved
 *            before the chat path existed (no tool mode stored), the agent called tools in it;
 *   null     a plain chat-mode conversation (toolMode 'chat'), even if it looked something up on the way.
 */
export function dividerKind(o: {
  space?: Pick<Space, 'kind' | 'isMain'> | null
  thread?: Pick<Thread, 'toolMode'> | null
  messages: Message[]
}): 'bot' | 'agent' | null {
  if (o.space && !o.space.isMain && (o.space.kind === 'bot' || o.space.kind === 'group')) return 'bot'
  const mode = o.thread?.toolMode
  if (mode === 'full') return 'agent'
  if (mode === 'chat') return null
  return o.messages.some((m) => m.role === 'assistant' && !!m.toolCalls?.length) ? 'agent' : null
}

/** The sidebar's count: "", "2" … "99+" (only shown above one). */
export function countLabel(n: number | undefined): string {
  if (!n || n < 2) return ''
  return n >= UNREAD_CAP ? `${UNREAD_CAP}+` : String(n)
}
