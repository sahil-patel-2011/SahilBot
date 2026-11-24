/**
 * The working line's words: what is stuck, else the step it's on, else "<Bot> is working". Never a canned "On it.":
 * the only messages in the chat are the bot's own (its opening line, then each message it sends as it goes).
 */
export function workingText(o: { slow?: string | null; label?: string | null; name?: string }): string {
  return o.slow ?? (o.label || (o.name ? `${o.name} is working` : 'Working on it'))
}
