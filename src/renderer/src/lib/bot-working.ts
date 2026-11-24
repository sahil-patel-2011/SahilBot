import type { Message } from '@shared/types'
import { awaitingFinal } from './held-drafts'

/**
 * The working line's words: what is stuck, else the step it's on, else "On it." once nothing has come for a moment
 * (in the working line, never a chat bubble that would vanish when the run ends), else "<Bot> is working".
 */
export function workingText(o: { slow?: string | null; label?: string | null; ack: boolean; late: boolean; name?: string }): string {
  return o.slow ?? (o.label || (o.ack && o.late ? 'On it.' : o.name ? `${o.name} is working` : 'Working on it'))
}

/** The bot already said something since your latest message (then no "On it." is needed). */
export function repliedSince(ms: Message[]): boolean {
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i]
    if (m.role === 'user' && !m.meta?.hidden) return false
    // (An answer written out of sight until it's checked isn't said yet.)
    if (m.role === 'assistant' && m.content?.trim() && !m.meta?.superseded && !awaitingFinal(m)) return true
  }
  return false
}
