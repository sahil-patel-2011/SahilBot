import { looksLikeSecret, scrubSecrets, SECRET } from '../browser/teach'
import { registrableDomain } from '../psl'

// What may go into a site playbook. Playbooks are read back into future runs, so anything stored here
// must be safe to show the model again: no secrets (passwords, keys, tokens, card numbers, one-time
// codes), no personal data (emails, phone numbers, long numbers such as order or account ids), and no
// page text that reads like instructions. When in doubt a string is dropped, never stored redacted.

const EMAIL = /[^\s@"'<>()]+@[^\s@"'<>()]+\.[a-z]{2,}/i
const PHONE = /(?:\+|\b)\d[\d\s().-]{7,}\d\b/
/** Order numbers, account numbers, ZIP codes, codes: any run of 5+ digits (prices like 1,299.00 are not). */
const LONG_DIGITS = /\d{5,}/
const URLISH = /(https?:\/\/|www\.)\S+/i
const SSN = /\b\d{3}-\d{2}-\d{4}\b/
/** Words page text uses to talk to an assistant ("Note to AI: ignore previous instructions"). */
const INSTRUCTIONY = /\b(ignore|disregard|assistant|assistants|a\.?i\.?|llm|chatgpt|gpt|claude|prompt|instructions?|override|you must|system notice|already (been )?approved|no confirmation)\b/i
const SECRETISH_WORD = /\b(password|passcode|api ?key|token|secret)\s*[:=]/i

/** Any of these values (saved passwords, card numbers, recent codes) inside the text. */
function carries(s: string, secrets: string[]): boolean {
  if (secrets.some((x) => x.length >= 4 && s.includes(x))) return true
  const digits = s.replace(/[\s.\- _/]+/g, '')
  return secrets.some((x) => /^\d{12,19}$/.test(x) && digits.includes(x))
}

/** Text with a secret or personal detail in it (or that a secret detector would change). */
export function unsafeText(s: string, secrets: string[] = []): boolean {
  if (!s) return false
  if (carries(s, secrets)) return true
  if (s.includes(SECRET) || scrubSecrets(s) !== s || looksLikeSecret(s)) return true
  return EMAIL.test(s) || PHONE.test(s) || LONG_DIGITS.test(s) || SSN.test(s) || SECRETISH_WORD.test(s)
}

const squash = (s: string | undefined): string => String(s ?? '').replace(/\s+/g, ' ').trim()

/**
 * An element's accessible name as a locator label, or null when it can't be kept: too long to be a
 * control's name (that's page text), secret or personal, an address, or instruction-like.
 */
export function safeLabel(s: string | undefined, secrets: string[] = [], max = 60): string | null {
  const t = squash(s).replace(/["“”]/g, "'")
  if (!t || t.length > max) return null
  if (unsafeText(t, secrets) || URLISH.test(t) || INSTRUCTIONY.test(t)) return null
  return t
}

/** Free text the user or the model wants kept (notes, a purpose, a pitfall): rejected, not trimmed, when unsafe. */
export function checkNote(s: string, secrets: string[] = [], max = 400): string {
  const t = squash(s)
  if (!t) throw new Error('The text is empty.')
  if (t.length > max) throw new Error(`Keep it under ${max} characters.`)
  if (carries(t, secrets) || t.includes(SECRET) || scrubSecrets(t) !== t || SECRETISH_WORD.test(t)) throw new Error('That looks like it contains a password, key, card number or code: playbooks never store secrets.')
  if (EMAIL.test(t) || PHONE.test(t) || SSN.test(t)) throw new Error('That contains an email address or phone number: playbooks never store personal details.')
  return t
}

/** One path segment that is an id, a token or personal (numbers, hashes, uuids, emails): shown as *. */
function idLike(seg: string): boolean {
  let d = seg
  try { d = decodeURIComponent(seg) } catch { /* raw */ }
  return d.length > 40 || /\d{3,}/.test(d) || /^[a-f0-9-]{8,}$/i.test(d) || /@/.test(d) || looksLikeSecret(d) || /^[A-Za-z0-9_-]{16,}$/.test(d) && /\d/.test(d)
}

/**
 * The path of a page, for a playbook: no query, no fragment (tokens and searches live there), and id-like
 * segments as * ("/orders/8812-221/invoice" → "/orders/*\/invoice"). Empty for non-web addresses.
 */
export function safePath(url: string | undefined): string {
  let u: URL
  try { u = new URL(String(url ?? '')) } catch { return '' }
  if (!/^https?:$/.test(u.protocol)) return ''
  const path = u.pathname.split('/').map((seg) => (seg && idLike(seg) ? '*' : seg)).join('/')
  return (path || '/').slice(0, 80)
}

/**
 * Hosts where anyone's site lives under a path rather than its own subdomain (subdomain platforms such
 * as github.io are split by the Public Suffix List already): each site gets its own playbook, keyed by
 * host + its first path segments, so one site's labels and flows never show up on another's.
 * segs: how many path segments name the site.
 */
const PATH_HOSTED: Array<{ host: RegExp; segs: (path: string[]) => number }> = [
  // sites.google.com/view/<site>, /site/<site>, /<domain>/<site>, /a/<domain>/<site>
  { host: /^sites\.google\.com$/, segs: (p) => (p[0] === 'a' ? 3 : 2) },
  // S3 path-style buckets: s3.amazonaws.com/<bucket>, s3.<region>.amazonaws.com/<bucket>, s3-<region>.amazonaws.com/<bucket>
  { host: /^s3([.-][a-z0-9-]+)*\.amazonaws\.com(\.cn)?$/, segs: () => 1 },
  { host: /^storage\.(cloud\.)?googleapis\.com$/, segs: () => 1 },
  { host: /^[a-z0-9-]+\.blob\.core\.windows\.net$/, segs: () => 1 },
  { host: /^raw\.githubusercontent\.com$/, segs: () => 2 },
  { host: /^gist\.github(usercontent)?\.com$/, segs: () => 1 }
]

/** Pages anyone can author on a shared host (forms, published docs): never learned at all. */
const NEVER_LEARNED: Array<{ host: RegExp; path: RegExp }> = [
  { host: /^docs\.google\.com$/, path: /^\/forms\/|^\/(document|spreadsheets|presentation)\/d\/e\// },
  { host: /^forms\.gle$/, path: /^\// },
  { host: /^forms\.(office|microsoft)\.com$/, path: /^\// }
]

/**
 * The registrable domain a page belongs to (eTLD+1 by the Public Suffix List; IPs and localhost whole).
 * On path-hosted platforms it is host + the site's path ("sites.google.com/view/acme"); '' for pages
 * anyone can author on a shared host (Google Forms) and for a platform's bare host.
 */
export function domainOf(url: string | undefined): string {
  let u: URL
  try { u = new URL(String(url ?? '')) } catch { return '' }
  if (!/^https?:$/.test(u.protocol) || !u.hostname) return ''
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (NEVER_LEARNED.some((x) => x.host.test(host) && x.path.test(u.pathname))) return ''
  const ph = PATH_HOSTED.find((x) => x.host.test(host))
  if (ph) {
    const segs = u.pathname.split('/').filter(Boolean).map((p) => p.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'))
    const n = ph.segs(segs)
    return segs.length >= n && segs.slice(0, n).every(Boolean) ? `${host}/${segs.slice(0, n).join('/')}` : ''
  }
  return registrableDomain(host) || host
}

export function hostOf(url: string | undefined): string {
  try { return new URL(String(url ?? '')).hostname.toLowerCase() } catch { return '' }
}

const TITLE_SEP = /\s+(?:[·|•—–]|-|::)\s+/

/** A page title split into the page's own name and the site's name ("Contact · Acme Portal"). */
export function splitTitle(title: string | undefined, secrets: string[] = []): { page: string | null; site: string | null } {
  const parts = squash(title).split(TITLE_SEP).map((p) => p.trim()).filter(Boolean)
  if (!parts.length) return { page: null, site: null }
  const page = safeLabel(parts[0], secrets, 50)
  const site = parts.length > 1 ? safeLabel(parts[parts.length - 1], secrets, 40) : null
  return { page, site }
}

/** Shown in the note as `role "label"`: the playbook's way of naming an element (never a CSS selector). */
export function elementText(role: string, label: string): string {
  const r = role === 'clickable' ? 'element' : role === 'StaticText' ? 'text' : role
  return `${r} "${label}"`
}

/** Safe a provider of secret values: never throws. */
export function secretsOf(fn?: () => string[]): string[] {
  try { return (fn?.() ?? []).filter((x) => typeof x === 'string' && x.length >= 4) } catch { return [] }
}
