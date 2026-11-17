// Which chat events reach a paired phone as a notification (Phone access): an approval or question waiting
// in a chat, and a long task finishing. Bots' Needs-you items and digests already go out through the
// question queue (agent/questions/notify.ts). Bodies are lock-screen safe (needs-you.ts does the wording).

import type { ChatEvent } from '@shared/types'
import type { NotifyPayload } from '../notify'

/** A run at least this long counts as a long task (SAHILBOT_PHONE_LONG_RUN_MS overrides it for tests). */
export const LONG_RUN_MS = 60_000

export interface PhoneNoteContext {
  /** The bot's (or SahilBot's) name. */
  botName: string
  /** The chat's title (when the run's event has none). */
  title?: string
  /** The lock-screen-safe line for a waiting request. */
  requestLine?: string
  /** The bot wants notifications (its "Notify me" switch). */
  notify: boolean
  /** The user is reading this very chat on the Mac right now: no need to buzz the phone. */
  watchingOnMac: boolean
  /** When the run started (for 'run' events). */
  startedAt?: number
  now: number
  longRunMs?: number
  /** Runs that end with their own notification (routines, Quick Ask). */
  ownNote?: boolean
}

/** The notification for a chat event, or null. */
export function phoneNote(e: ChatEvent, c: PhoneNoteContext): NotifyPayload | null {
  if (!c.notify || c.watchingOnMac) return null
  if (e.type === 'pending') {
    const r = e.request
    const asks = r.kind === 'question' || r.kind === 'questions'
    const isPurchase = r.kind === 'purchase' || r.kind === 'otp'
    return {
      title: asks ? `${c.botName} has a question` : `${c.botName} needs you`,
      body: isPurchase ? 'A purchase or code is waiting for your OK on your Mac.' : c.requestLine ?? 'Waiting for you',
      threadId: e.threadId,
      tag: `needs-you:${e.threadId}`,
      kind: asks ? 'question' : 'needs-you'
    }
  }
  if (e.type === 'run' && (e.status === 'finished' || e.status === 'error') && !c.ownNote) {
    const long = c.longRunMs ?? LONG_RUN_MS
    if (c.startedAt === undefined || c.now - c.startedAt < long) return null
    const what = (e.title || c.title || 'Your task').slice(0, 120)
    return {
      title: e.status === 'error' ? `${c.botName} hit a problem` : `${c.botName} is done`,
      body: what,
      threadId: e.threadId,
      tag: `done:${e.threadId}`,
      kind: e.status === 'error' ? 'error' : 'done'
    }
  }
  return null
}
