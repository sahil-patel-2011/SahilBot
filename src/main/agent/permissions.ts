import type { Decision, PermissionInput } from './types'

/**
 * The single place that decides whether a tool call runs, asks, or is refused.
 * Nothing a tool returns can change `mode`; only the user can, from the composer.
 */
export function decide(p: PermissionInput): Decision {
  // Never send a stored secret anywhere, in any mode, even if asked to.
  if (p.leaksSecret) return { verdict: 'deny', reason: 'The arguments contain a saved password. Secrets can only be typed with browser fill_secret.' }

  if (p.effect === 'read') return { verdict: 'allow' }

  if (p.hardStop && (p.mode !== 'bypass' || p.hardStopsEnabled)) {
    return { verdict: 'ask', reason: `Hard stop: ${p.hardStop}` }
  }

  switch (p.mode) {
    case 'bypass':
      return { verdict: 'allow' }
    case 'auto':
      if (p.effect === 'write_local') return { verdict: 'allow' }
      if (p.tainted) return { verdict: 'ask', reason: 'Uses details taken from a web page or email' }
      // Routine outside actions (sign in, next page, search, save draft) don't interrupt the user.
      if (p.effect === 'write_external' && p.consequential === false) return { verdict: 'allow' }
      if (p.alwaysAllowed && p.effect === 'write_external') return { verdict: 'allow' }
      return { verdict: 'ask', reason: p.effect === 'destructive' ? 'Destructive action' : 'Acts outside this Mac' }
    case 'ask':
    default:
      if (p.alwaysAllowed && !p.tainted && p.effect !== 'destructive') return { verdict: 'allow' }
      return { verdict: 'ask' }
  }
}

// ---------- hard-stop heuristics shared by tools ----------

/** Words that mark an action with real-world consequences. */
export const CONSEQUENTIAL = /\b(send|submit|post|publish|pay|buy|purchase|order|checkout|check out|book|reserve|confirm|place|transfer|share|invite|sign ?up|register|subscribe|apply|delete|remove|cancel|tweet|reply|comment|upload|forward|approve|decline|accept|merge|deploy|donate|bid)\b/i

const PAYMENT = /\b(checkout|check out|pay(ment)?|purchase|buy now|place (your )?order|billing|credit card|card number|cvv|transfer funds|wire|send money|subscribe)\b/i
const SECURITY = /\b(password|passcode|2fa|two-factor|mfa|security settings|account settings|recovery (email|phone)|delete (my )?account|api key|permissions?)\b/i
const SECURITY_URL = /\/(settings|security|account|password|billing|admin)(\/|$|\?)/i

export function looksLikePayment(...texts: Array<string | undefined>): boolean {
  return texts.some((t) => !!t && PAYMENT.test(t))
}

export function looksLikeSecurity(url?: string, ...texts: Array<string | undefined>): boolean {
  return (!!url && SECURITY_URL.test(url)) || texts.some((t) => !!t && SECURITY.test(t))
}

// ---------- taint: did these arguments come from fetched content? ----------

const ENTITY = /(https?:\/\/[^\s"'<>)]+|[\w.+-]+@[\w-]+\.[\w.-]+|\+?\d[\d\s().-]{7,}\d|\b\d{6,}\b)/g

function ngrams(text: string, n: number): Set<string> {
  const w = text.toLowerCase().split(/\s+/).filter(Boolean)
  const out = new Set<string>()
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '))
  return out
}

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out))
  return out
}

/**
 * True when an argument carries an address, number or 8-word run that appears in
 * untrusted tool output but nowhere in what the user typed. That's the signature
 * of a page or email steering the agent ("send the file to attacker@…").
 */
export function isTainted(args: unknown, untrusted: string[], userText: string): boolean {
  if (!untrusted.length) return false
  const corpus = untrusted.join('\n').toLowerCase()
  const user = userText.toLowerCase()
  for (const s of strings(args)) {
    for (const m of s.matchAll(ENTITY)) {
      const e = m[0].toLowerCase().trim()
      if (corpus.includes(e) && !user.includes(e)) return true
    }
    for (const g of ngrams(s, 8)) {
      if (corpus.includes(g) && !user.includes(g)) return true
    }
  }
  return false
}

export function containsSecret(args: unknown, secrets: string[]): boolean {
  const all = strings(args).join('\n')
  return secrets.some((s) => s.length >= 4 && all.includes(s))
}
