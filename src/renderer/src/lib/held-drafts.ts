import type { Message } from '@shared/types'

/**
 * Answers being double-checked: the latest one stays on screen (held) until its replacement is fully written, and the
 * replacement stays out of view while it streams (waiting). No blank gap while it checks, never two copies.
 */
export function heldDrafts(messages: Message[]): { held: Set<string>; waiting: Set<string> } {
  const held = new Set<string>(), waiting = new Set<string>()
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'assistant' || !m.meta?.superseded || !m.meta?.checking || !m.content) continue
    let replacement: Message | undefined, later = false
    for (const x of messages.slice(i + 1)) {
      if (x.role === 'user' && !x.meta?.hidden && !x.meta?.aside) break
      if (x.role !== 'assistant' || !x.content || x.meta?.aside) continue
      if (x.meta?.superseded) { if (x.meta?.checking) later = true; continue }
      replacement = x
      break
    }
    if (later) continue
    if (!replacement) held.add(m.id)
    else if (replacement.status === 'streaming') { held.add(m.id); waiting.add(replacement.id) }
  }
  return { held, waiting }
}
