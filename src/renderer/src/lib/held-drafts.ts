import type { Message } from '@shared/types'

/** The double-check's "nothing to fix" reply ("✓"): the answer already written stands, swapped in by the app. */
const KEEP_DRAFT = /^(✓|✔|✔️|ok|lgtm|all good|no changes?( needed)?)[.!]?$/i

/**
 * Post once (Grok Bot's way): an answer the app may still check or send back (meta.provisional, set before
 * the model writes it) stays out of view until the app accepts it and clears the flag. A step that ends in tool calls shows its words as
 * usual, and an error or a stopped reply always shows. Only while the run works: afterwards everything left stands.
 */
export function awaitingFinal(m: Message): boolean {
  return m.role === 'assistant' && !!m.meta?.provisional && !m.toolCalls?.length && !m.meta?.aside
    && m.status !== 'error' && m.status !== 'stopped'
}

/**
 * Answers being double-checked: the latest one stays on screen (held) until its replacement is fully written, and the
 * replacement stays out of view while it streams (waiting). No blank gap while it checks, never two copies.
 * A step's opening words that come with tool calls ("Let me re-check the hotel link.") are not the replacement.
 */
export function heldDrafts(messages: Message[]): { held: Set<string>; waiting: Set<string> } {
  const held = new Set<string>(), waiting = new Set<string>()
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    // (A draft written out of sight, provisional, was never on screen: nothing to hold.)
    if (m.role !== 'assistant' || !m.meta?.superseded || !m.meta?.checking || !m.content || m.meta?.provisional) continue
    let replacement: Message | undefined, later = false
    for (const x of messages.slice(i + 1)) {
      if (x.role === 'user' && !x.meta?.hidden && !x.meta?.aside) break
      if (x.role !== 'assistant' || !x.content || x.meta?.aside || x.toolCalls?.length) continue
      if (x.meta?.superseded) { if (x.meta?.checking) later = true; continue }
      replacement = x
      break
    }
    if (later) continue
    if (!replacement) held.add(m.id)
    // Still being written, or only the check's "✓" before the app swaps the kept answer in: the draft stays.
    else if (replacement.status === 'streaming' || (KEEP_DRAFT.test(replacement.content.trim()) && !replacement.meta?.keptDraft)) { held.add(m.id); waiting.add(replacement.id) }
  }
  return { held, waiting }
}
