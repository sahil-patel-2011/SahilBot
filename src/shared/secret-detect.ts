// Finds secrets the user typed or pasted into the chat composer (passwords, API keys, card numbers,
// ID numbers) so main can take them out of the message before anything is stored, logged or sent to a
// model. Pure functions: tests/unit/vault-save-offers.test.ts covers every pattern.
//
// Card numbers must pass the Luhn check (a phone or order number rarely does); passwords need a cue
// ("password: …", "my pw is …"); API keys are matched by their vendors' published prefixes, or by a
// cue ("api key: …") followed by a long token. Values found here are replaced by [redacted]; the
// "Save to Vault?" card next to the message can then store them, and the model sees only
// [saved to vault: <name>].

import { cardBrand, digitsOnly, luhn, BRAND_NAME, type CardBrand } from '@shared/cards'

export type FoundKind = 'password' | 'api_key' | 'card' | 'id_number'

export interface FoundSecret {
  kind: FoundKind
  /** Where the value is in the text (the value only, not its cue). */
  start: number
  end: number
  value: string
  /** "Visa ending 4242", "OpenAI API key", "Password", "Social Security number". */
  label: string
  /** A name for the vault item, editable on the card ("GitHub", "OpenAI API key"). */
  name: string
  /** A guess at the site it belongs to ("https://github.com"), or ''. */
  site: string
  /** Logins: a username or email named next to it. */
  username?: string
  /** Cards. */
  brand?: CardBrand
  last4?: string
  expMonth?: number
  expYear?: number
  /** IDs: 'ssn' | 'passport' | 'license' | 'tax_id'. */
  idKind?: string
}

/** The placeholder the model sees for a value that wasn't saved. */
export const REDACTED = '[redacted]'
export const savedPlaceholder = (name: string): string => `[saved to vault: ${String(name).replace(/[\]\r\n]/g, ' ').slice(0, 60)}]`
/** Every placeholder this module writes, in order (for replacing the nth one after a save). */
export const PLACEHOLDER_RX = /\[redacted\]|\[saved to vault: [^\]]*\]/g

interface KeyRule { re: RegExp; label: string; site: string }

/** Vendors' published key prefixes. Order matters: the most specific first. */
const KEY_RULES: KeyRule[] = [
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, label: 'Anthropic API key', site: 'https://console.anthropic.com' },
  { re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g, label: 'OpenAI API key', site: 'https://platform.openai.com' },
  { re: /\bsk-or-v1-[A-Za-z0-9]{32,}/g, label: 'OpenRouter API key', site: 'https://openrouter.ai' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{40,}/g, label: 'GitHub token', site: 'https://github.com' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g, label: 'GitHub token', site: 'https://github.com' },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/g, label: 'GitLab token', site: 'https://gitlab.com' },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, label: 'AWS access key', site: 'https://console.aws.amazon.com' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, label: 'Google API key', site: 'https://console.cloud.google.com' },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, label: 'Slack token', site: 'https://api.slack.com' },
  { re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}/g, label: 'Stripe key', site: 'https://dashboard.stripe.com' },
  { re: /\bhf_[A-Za-z0-9]{30,}/g, label: 'Hugging Face token', site: 'https://huggingface.co' },
  { re: /\bnpm_[A-Za-z0-9]{36}\b/g, label: 'npm token', site: 'https://www.npmjs.com' },
  { re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, label: 'SendGrid key', site: 'https://app.sendgrid.com' },
  { re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g, label: 'Private key', site: '' }
]

/** "api key: abc…", "token = …", "secret is …" followed by a long token. */
const KEY_CUE = /\b(?:api[ _-]?key|api[ _-]?token|access[ _-]?token|auth[ _-]?token|bearer|secret[ _-]?key|client[ _-]?secret|token|secret)\b(?:\s+for\s+[\w.-]+)?\s*(?:[:=]|\bis\b)?\s*["'`]?([A-Za-z0-9_\-.~+/]{20,}={0,2})["'`]?/gi

/** "password: …", "my pw is …", "passcode = …", "the password for github is …". */
const PASSWORD_CUE = /\b(?:password|passwd|passcode|passphrase|pwd|pw|pass)\b(?:\s+(?:for|on|to)\s+(?:my\s+)?([\w.-]+(?:\.[a-z]{2,})?))?(?:\s+(?:account|login))?\s*(?:[:=]|\bis\b|\bwould be\b|-)\s*(?:"([^"\n]{4,128})"|'([^'\n]{4,128})'|`([^`\n]{4,128})`|(\S{4,128}))/gi

/** Words that follow "password is" without being a password. */
const NOT_A_PASSWORD = new Set(['wrong', 'incorrect', 'invalid', 'expired', 'correct', 'right', 'required', 'missing', 'not', 'too', 'the', 'my', 'your', 'their', 'his', 'her', 'a', 'an', 'still', 'also', 'now', 'set', 'reset', 'changed', 'saved', 'stored', 'in', 'on', 'at', 'for', 'same', 'different', 'weak', 'strong', 'secure', 'long', 'short', 'blank', 'empty', 'there', 'here', 'what', 'which', 'something', 'it', 'this', 'that', 'protected', 'needed', 'case-sensitive', 'hidden', 'locked', 'forgotten', 'forgot', 'unknown', 'manager', 'managers', 'redacted', '[redacted]', 'being', 'going', 'getting', 'working', 'broken', 'fine', 'ok', 'okay', 'good', 'bad'])

/** "username: …", "user …", "login …", "email …" near a password. */
const USERNAME_CUE = /\b(?:username|user name|user|login|email|e-mail|account)\b\s*(?:[:=]|\bis\b)?\s*["']?([\w.+-]+@[\w-]+(?:\.[\w-]+)+|[\w.@+-]{3,64})["']?/i
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/

/** Expiry next to a card: "exp 12/29", "12/2029", "expires 08-27". */
const EXPIRY = /\b(?:exp(?:iry|ires|iration)?\.?\s*(?:date)?\s*[:=]?\s*)?(0?[1-9]|1[0-2])\s*[/-]\s*(\d{4}|\d{2})\b/i

const SSN = /\b(?!000|666|9\d\d)(\d{3})-(?!00)(\d{2})-(?!0000)(\d{4})\b/g
const SSN_CUE = /\b(?:ssn|social security(?: number| no\.?| #)?)\s*(?:[:=#]|\bis\b)?\s*(\d{3}[- ]?\d{2}[- ]?\d{4})\b/gi
const PASSPORT_CUE = /\bpassport(?:\s+(?:number|no\.?|#))?\s*(?:[:=#]|\bis\b)?\s*([A-Z0-9]{6,9})\b/gi
const LICENSE_CUE = /\bdriver'?s?\s+licen[cs]e(?:\s+(?:number|no\.?|#))?\s*(?:[:=#]|\bis\b)?\s*([A-Z0-9-]{5,20})\b/gi
const TAX_CUE = /\b(?:ein|tax id|itin|tin)(?:\s+(?:number|no\.?|#))?\s*(?:[:=#]|\bis\b)?\s*(\d{2}-\d{7}|\d{3}-\d{2}-\d{4}|\d{9})\b/gi

/** Well-known sites named in the text, for guessing where a password belongs. */
const SITE_NAMES: Record<string, string> = {
  github: 'https://github.com', gitlab: 'https://gitlab.com', google: 'https://accounts.google.com', gmail: 'https://accounts.google.com',
  apple: 'https://appleid.apple.com', icloud: 'https://www.icloud.com', amazon: 'https://www.amazon.com', netflix: 'https://www.netflix.com',
  facebook: 'https://www.facebook.com', instagram: 'https://www.instagram.com', twitter: 'https://x.com', linkedin: 'https://www.linkedin.com',
  microsoft: 'https://login.live.com', outlook: 'https://outlook.live.com', dropbox: 'https://www.dropbox.com', slack: 'https://slack.com',
  spotify: 'https://accounts.spotify.com', paypal: 'https://www.paypal.com', reddit: 'https://www.reddit.com', notion: 'https://www.notion.so',
  openai: 'https://platform.openai.com', chatgpt: 'https://chatgpt.com', anthropic: 'https://console.anthropic.com', stripe: 'https://dashboard.stripe.com',
  shopify: 'https://accounts.shopify.com', zoom: 'https://zoom.us', discord: 'https://discord.com', figma: 'https://www.figma.com', vercel: 'https://vercel.com'
}

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

function siteFrom(word: string | undefined): { site: string; name: string } {
  const w = String(word ?? '').trim().toLowerCase().replace(/[.,;:!?)]+$/, '')
  if (!w) return { site: '', name: '' }
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(w)) {
    const host = w.replace(/^www\./, '')
    return { site: `https://${w}`, name: cap(host.split('.').slice(-2, -1)[0] ?? host) }
  }
  const known = SITE_NAMES[w]
  return known ? { site: known, name: cap(w === 'gmail' ? 'Google' : w) } : { site: '', name: cap(w) }
}

/** A site named anywhere in the text: a domain, or a well-known service's name. */
function siteInText(text: string): { site: string; name: string } {
  const dom = /\b((?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|co|app|dev|edu|gov|us|uk|ca|de|so|me|tv|us))\b/i.exec(text.replace(EMAIL, ' '))
  if (dom) return siteFrom(dom[1])
  const low = text.toLowerCase()
  for (const k of Object.keys(SITE_NAMES)) if (new RegExp(`\\b${k}\\b`).test(low)) return siteFrom(k)
  return { site: '', name: '' }
}

const trimTail = (v: string): string => v.replace(/[.,;:!?)\]}>]+$/, '')

function passwordish(v: string): boolean {
  const w = v.toLowerCase()
  if (v.length < 4 || NOT_A_PASSWORD.has(w)) return false
  if (/^(https?:|www\.)/i.test(v)) return false
  // A plain lowercase word is only a password when it's long ("correcthorsebattery"); anything with a
  // digit, symbol or mixed case counts from 4 characters.
  return /[^a-z]/.test(v) || v.length >= 10
}

/** Overlap check: the first finding of a span wins. */
function overlaps(list: FoundSecret[], s: number, e: number): boolean {
  return list.some((f) => s < f.end && e > f.start)
}

/**
 * Every secret-looking value in `text`, in order of position. Values are exact substrings of the text
 * (start/end index them), so redaction can replace them in place.
 */
export function findSecrets(text: string): FoundSecret[] {
  const t = String(text ?? '')
  if (!t || t.length > 200_000) return []
  const out: FoundSecret[] = []
  const add = (f: FoundSecret): void => { if (f.value && !overlaps(out, f.start, f.end)) out.push(f) }

  // API keys by prefix.
  for (const r of KEY_RULES) {
    for (const m of t.matchAll(r.re)) {
      const v = m[0]
      add({ kind: 'api_key', start: m.index!, end: m.index! + v.length, value: v, label: r.label, name: r.label, site: r.site })
    }
  }

  // Card numbers: 13 to 19 digits, grouped by spaces or dashes, passing Luhn.
  for (const m of t.matchAll(/(?<![\d.-])\d(?:[ -]?\d){12,18}(?![\d])/g)) {
    const raw = m[0]
    const d = digitsOnly(raw)
    if (d.length < 13 || d.length > 19 || /^(\d)\1+$/.test(d) || !luhn(d)) continue
    // Mixed separators ("1234-5678 9012") or groups of one are a list of numbers, not a card.
    const seps = new Set(raw.replace(/\d/g, ''))
    if (seps.size > 1) continue
    const brand = cardBrand(d)
    const label = `${BRAND_NAME[brand] ?? 'Card'} ending ${d.slice(-4)}`
    const around = t.slice(m.index! + raw.length, m.index! + raw.length + 40)
    const exp = EXPIRY.exec(around)
    const f: FoundSecret = { kind: 'card', start: m.index!, end: m.index! + raw.length, value: d, label, name: label, site: '', brand, last4: d.slice(-4) }
    if (exp) { const mo = Number(exp[1]); let y = Number(exp[2]); if (y < 100) y += 2000; f.expMonth = mo; f.expYear = y }
    add(f)
  }

  // ID numbers (by cue, then the SSN shape on its own).
  const idRule = (re: RegExp, idKind: string, label: string): void => {
    for (const m of t.matchAll(re)) {
      const v = m[1]
      const start = m.index! + m[0].lastIndexOf(v)
      add({ kind: 'id_number', start, end: start + v.length, value: v, label, name: label, site: '', idKind })
    }
  }
  idRule(SSN_CUE, 'ssn', 'Social Security number')
  idRule(PASSPORT_CUE, 'passport', 'Passport number')
  idRule(LICENSE_CUE, 'license', "Driver's license number")
  idRule(TAX_CUE, 'tax_id', 'Tax ID')
  for (const m of t.matchAll(SSN)) add({ kind: 'id_number', start: m.index!, end: m.index! + m[0].length, value: m[0], label: 'Social Security number', name: 'Social Security number', site: '', idKind: 'ssn' })

  // Keys named by a cue ("api key: …").
  for (const m of t.matchAll(KEY_CUE)) {
    const v = trimTail(m[1])
    if (v.length < 20 || !/\d/.test(v) || !/[A-Za-z]/.test(v)) continue
    const start = m.index! + m[0].lastIndexOf(m[1])
    const s = siteInText(t)
    add({ kind: 'api_key', start, end: start + v.length, value: v, label: 'API key', name: s.name ? `${s.name} API key` : 'API key', site: s.site })
  }

  // Passwords named by a cue.
  for (const m of t.matchAll(PASSWORD_CUE)) {
    const quoted = m[2] ?? m[3] ?? m[4]
    // Unquoted: a sentence's full stop or comma isn't part of it ("!" and "?" may be).
    const v = quoted ?? (m[5] ?? '').replace(/[.,;:)\]}>]+$/, '')
    if (!v || (!quoted && !passwordish(v))) continue
    const rel = m[0].lastIndexOf(v)
    const start = m.index! + rel
    const named = siteFrom(m[1])
    const s = named.site || named.name ? named : siteInText(t)
    const user = USERNAME_CUE.exec(t.slice(0, m.index!) + ' ' + t.slice(m.index! + m[0].length))?.[1] ?? EMAIL.exec(t)?.[0]
    const username = user && user !== v && !/^(is|for|and|name|the)$/i.test(user) ? trimTail(user) : undefined
    add({ kind: 'password', start, end: start + v.length, value: v, label: 'Password', name: s.name || 'Login', site: s.site, ...(username ? { username } : {}) })
  }

  return out.sort((a, b) => a.start - b.start)
}

/** The text with each found value replaced by [redacted] (positions from findSecrets). */
export function redactFound(text: string, found: FoundSecret[]): string {
  let out = ''
  let at = 0
  for (const f of [...found].sort((a, b) => a.start - b.start)) {
    if (f.start < at) continue
    out += text.slice(at, f.start) + REDACTED
    at = f.end
  }
  return out + text.slice(at)
}

/** Replaces the nth placeholder (0-based, counting [redacted] and [saved to vault: …]) with another. */
export function replacePlaceholder(text: string, ordinal: number, next: string): string {
  let i = -1
  return String(text ?? '').replace(PLACEHOLDER_RX, (m) => (++i === ordinal ? next : m))
}

/** "sa•••@example.test" / "jo•••": what the UI may show of a username. */
export function maskUsername(u: string | undefined): string {
  const s = String(u ?? '').trim()
  if (!s) return ''
  const at = s.indexOf('@')
  if (at > 0) return `${s.slice(0, Math.min(2, at))}•••${s.slice(at)}`
  return s.length <= 3 ? '•••' : `${s.slice(0, 2)}•••`
}
