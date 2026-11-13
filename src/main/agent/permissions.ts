import type { Decision, PermissionInput } from './types'

/**
 * The single place that decides whether a tool call runs, asks, or is refused.
 * Nothing a tool returns can change `mode`; only the user can, from the composer.
 */
export function decide(p: PermissionInput): Decision {
  // Never send a stored secret anywhere, in any mode, even if asked to.
  if (p.leaksSecret) return { verdict: 'deny', reason: 'The arguments contain a saved password. Secrets can only be typed with browser fill_secret.' }

  // A read that opens an address steered by fetched content can leak data in the URL itself.
  if (p.effect === 'read') return p.tainted && p.mode !== 'bypass' ? { verdict: 'ask', reason: 'Opens an address taken from a web page or email' } : { verdict: 'allow' }

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

/**
 * A URL steered by fetched content: its host appears in untrusted output but not in what the user typed,
 * and the URL itself is not a link copied verbatim from that output (so the agent built it, e.g. by
 * appending private data to a query string).
 */
export function urlTainted(url: string, untrusted: string[], userText: string): boolean {
  if (!untrusted.length) return false
  let host: string
  let parsed: URL
  try { parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`); host = parsed.hostname.toLowerCase().replace(/^www\./, '') } catch { return false }
  // Only a URL that can carry data out matters: a query, or a long path segment. Plain pages on a site
  // (its /login, /form) are ordinary browsing.
  const carries = parsed.search.length > 24 || parsed.pathname.split('/').some((p) => p.length > 40)
  if (!carries) return false
  const corpus = untrusted.join('\n').toLowerCase()
  const user = userText.toLowerCase()
  if (!host || user.includes(host) || !corpus.includes(host)) return false
  const u = url.toLowerCase().replace(/\/+$/, '')
  return !corpus.includes(u) && !user.includes(u)
}

/** Tools whose read calls load a URL the agent chose. */
const URL_READS: Record<string, (args: any) => string | undefined> = {
  fetch_page: (a) => a?.url,
  browser: (a) => (a?.action === 'navigate' || (a?.action === 'tabs' && a?.op === 'new') ? a?.url : undefined)
}

/** Whether a call's arguments were steered by fetched content, for decide()'s `tainted`. */
export function checkTaint(tool: string, effect: string, args: unknown, untrusted: string[], userText: string): boolean {
  if (effect === 'write_external' || effect === 'destructive') return isTainted(args, untrusted, userText)
  if (effect !== 'read') return false
  const url = URL_READS[tool]?.(args)
  return !!url && urlTainted(url, untrusted, userText)
}

// ---------- the user's own approval rules ----------

/** Rule limits: per kind (allow / ask) and per rule text. */
export const RULE_LIMIT = 20
export const RULE_MAX_CHARS = 1000

/** Filler words a rule can contain without narrowing what it matches. */
const STOPWORDS = new Set(('a an the to for of on in at by with and or any anything something someone somebody me my mine i ' +
  'it its this that these those want wants wanted wanting when whenever if sahilbot should be is are was were am from into onto ' +
  'about please some all every do does use uses using used via can could would will just thing things stuff action actions try tries').split(' '))

/** Irregular forms, so "sent" matches "send" and "ran" matches "run". */
const IRREGULAR: Record<string, string> = {
  sent: 'send', ran: 'run', bought: 'buy', paid: 'pay', wrote: 'write', written: 'write', made: 'make', sold: 'sell',
  took: 'take', taken: 'take', gave: 'give', given: 'give', went: 'go', gone: 'go', got: 'get', gotten: 'get', chose: 'choose',
  chosen: 'choose', did: 'do', done: 'do', put: 'put', read: 'read', left: 'leave', kept: 'keep', found: 'find', told: 'tell',
  goes: 'go', said: 'say', saw: 'see', seen: 'see', spent: 'spend', built: 'build', began: 'begin', begun: 'begin'
}

/** A light stemmer: send / sends / sending, delete / deleted, reply / replies / replied all meet in one form. */
export function stem(word: string): string {
  let w = word.toLowerCase()
  if (IRREGULAR[w]) w = IRREGULAR[w]
  if (w.length <= 3 || /^\d/.test(w)) return w
  const undouble = (x: string): string => (/([b-df-hj-kmnp-rtv-z])\1$/.test(x) ? x.slice(0, -1) : x)
  // Plurals first, then verb endings, so "strings" and "string", "settings" and "set" agree.
  if (/ies$/.test(w) && w.length > 4) w = `${w.slice(0, -3)}y`
  else if (/(s|x|z|ch|sh)es$/.test(w)) w = w.slice(0, -2)
  else if (/s$/.test(w) && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1)
  if (/ied$/.test(w) && w.length > 4) w = `${w.slice(0, -3)}y`
  else if (/ing$/.test(w) && w.length >= 6) w = undouble(w.slice(0, -3))
  else if (/ed$/.test(w) && w.length >= 5 && !/eed$/.test(w)) w = undouble(w.slice(0, -2))
  if (/e$/.test(w) && w.length >= 4) w = w.slice(0, -1)
  return w
}

/** Lowercase words of a text: camelCase, snake_case, paths and URLs all split into their parts. */
function words(text: string): string[] {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

interface ParsedRule { tools: RegExp[]; stems: string[]; phrases: string[] }

/** "tool:run_command", quoted "exact phrases", and plain words (stopwords dropped, stemmed). */
export function parseRule(when: string): ParsedRule {
  const text = String(when ?? '').slice(0, RULE_MAX_CHARS)
  const tools: RegExp[] = []
  const phrases: string[] = []
  let rest = text.replace(/\btool:\s*([\w.*-]+)/gi, (_m, name: string) => {
    tools.push(new RegExp(`^${name.toLowerCase().replace(/[.+?^${}()|[\]\\-]/g, '\\$&').replace(/\*/g, '.*')}$`))
    return ' '
  })
  rest = rest.replace(/["\u201c\u201d]([^"\u201c\u201d]+)["\u201c\u201d]/g, (_m, p: string) => {
    const t = p.trim().toLowerCase().replace(/\s+/g, ' ')
    if (t) phrases.push(t)
    return ' '
  })
  const stems = [...new Set(words(rest).filter((w) => !STOPWORDS.has(w)).map(stem))]
  return { tools, stems, phrases }
}

/** Whether one rule matches an action. A rule with nothing significant in it matches nothing. */
export function ruleMatches(when: string, action: { tool: string; label?: string; summary?: string; args: string }): boolean {
  const r = parseRule(when)
  if (!r.tools.length && !r.stems.length && !r.phrases.length) return false
  const tool = String(action.tool ?? '').toLowerCase()
  if (r.tools.length && !r.tools.some((t) => t.test(tool))) return false
  const all = [action.tool, action.label, action.summary, action.args].filter(Boolean).join('\n')
  const have = new Set(words(all).map(stem))
  if (!r.stems.every((s) => have.has(s))) return false
  const flat = all.toLowerCase().replace(/\s+/g, ' ')
  return r.phrases.every((p) => flat.includes(p))
}

/**
 * The user's custom rules for one action: 'ask' if any Ask-first rule matches, else 'allow' if an
 * Allow rule matches, else null (normal permissions apply). Contract shared by the approvals UI and
 * the agent loop.
 *
 * Matching is case-insensitive: every significant word of the rule (filler words dropped, simple
 * stemming so "send" also matches "sends" / "sending" / "sent") must appear somewhere in the tool
 * name, label, summary or arguments. "tool:run_command" pins a rule to one tool (* is a wildcard), and
 * "quoted text" must appear as written. At most RULE_LIMIT rules of each kind are considered.
 */
export function ruleVerdict(rules: import('@shared/types').CustomRule[] | undefined, action: { tool: string; label?: string; summary?: string; args: string }): 'allow' | 'ask' | null {
  if (!Array.isArray(rules) || !rules.length) return null
  const valid = rules.filter((r) => r && typeof r.when === 'string' && (r.action === 'ask' || r.action === 'allow'))
  const of = (kind: 'ask' | 'allow') => valid.filter((r) => r.action === kind).slice(0, RULE_LIMIT)
  if (of('ask').some((r) => ruleMatches(r.when, action))) return 'ask'
  if (of('allow').some((r) => ruleMatches(r.when, action))) return 'allow'
  return null
}
