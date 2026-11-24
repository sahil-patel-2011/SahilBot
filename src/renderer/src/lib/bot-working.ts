import type { Message } from '@shared/types'

/** The bot already said something since your latest message (then no "On it." is needed). */
export function repliedSince(ms: Message[]): boolean {
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i]
    if (m.role === 'user' && !m.meta?.hidden) return false
    if (m.role === 'assistant' && m.content?.trim() && !m.meta?.superseded && !m.meta?.provisional) return true
  }
  return false
}
