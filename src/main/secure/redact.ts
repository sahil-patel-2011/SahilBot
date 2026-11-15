// The last line of defence: if a saved secret ever shows up in text bound for the model (a tool result,
// page text, an error message), it is masked here first. Filling never puts values in tool output; this
// catches the cases nobody planned for (a page that echoes the password back, a site that prints the card).

export const MASK = '[hidden by vault]'

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Values shorter than this aren't masked in free text (too many false hits); the leak check still blocks them in tool arguments. */
export const MIN_REDACT = 6

/**
 * Masks every saved value in `text`. Card numbers (12–19 digits) are matched however they're grouped
 * (spaces, dashes, dots, no-break spaces) and keep their last four digits so the model can still tell
 * which card a page shows.
 */
export function redactSecrets(text: string, values: Iterable<string>): string {
  let out = String(text ?? '')
  if (!out) return out
  const list = [...new Set([...values].filter((v) => typeof v === 'string' && v.length >= MIN_REDACT))]
  // Longest first, so a password that contains another saved value is masked whole.
  list.sort((a, b) => b.length - a.length)
  for (const v of list) {
    if (/^\d{12,19}$/.test(v)) {
      const re = new RegExp(`(?<!\\d)${v.split('').join('[\\s.\\-\\u00a0]?')}(?!\\d)`, 'g')
      out = out.replace(re, `•••• ${v.slice(-4)}`)
      continue
    }
    if (!out.includes(v)) {
      // Case-insensitive only for long values (an authenticator key pasted in lower case).
      if (v.length >= 16 && out.toLowerCase().includes(v.toLowerCase())) out = out.replace(new RegExp(escapeRe(v), 'gi'), MASK)
      continue
    }
    out = out.split(v).join(MASK)
  }
  return out
}

/** Whether any saved value appears in the text (for tests and the IPC reply scan). */
export function containsAny(text: string, values: Iterable<string>): boolean {
  const t = String(text ?? '')
  const digits = t.replace(/[\s.\- ]+/g, '')
  for (const v of values) {
    if (!v || v.length < 4) continue
    if (t.includes(v)) return true
    if (/^\d{12,19}$/.test(v) && digits.includes(v)) return true
  }
  return false
}
