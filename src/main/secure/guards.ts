// Fill guards: every check that must pass before a saved value is typed into a page. Pure functions,
// so each rule is unit-tested; the browser layer gathers the facts (FIELD_FACTS runs in an isolated
// world, where page scripts can't fake what it reads) and refuses on the first problem.

import { isSecurePage, originMatches, originOfUrl, sameSiteUrls } from './origin'

export type FieldKind = 'password' | 'username' | 'id_number'

/** What the browser reads about a field right before typing into it (never its value). */
export interface FieldFacts {
  tag: string
  type: string
  autocomplete: string
  connected: boolean
  disabled: boolean
  readOnly: boolean
  width: number
  height: number
  /** display:none, visibility:hidden, opacity < 0.1 on it or an ancestor, or clipped to nothing. */
  hidden: boolean
  ariaHidden: boolean
  /** Where its form sends (resolved), or '' when it has no form. */
  action: string
  /** The URL of the frame the field is in. */
  frameUrl: string
  top: boolean
}

export class FillGuardError extends Error {
  constructor(message: string) { super(message); this.name = 'FillGuardError' }
}

/**
 * Runs with `this` = the element, in the isolated world. Reads attributes, layout and computed style
 * only (never the value).
 */
export const FIELD_FACTS = `function () {
  const el = this
  const out = { tag: String(el.tagName || '').toLowerCase(), type: String(el.getAttribute && el.getAttribute('type') || (el.tagName === 'INPUT' ? 'text' : '')).toLowerCase(),
    autocomplete: String(el.getAttribute && el.getAttribute('autocomplete') || '').toLowerCase(), connected: !!el.isConnected, disabled: !!el.disabled, readOnly: !!el.readOnly,
    width: 0, height: 0, hidden: false, ariaHidden: false, action: '', frameUrl: String(location.href), top: window.top === window }
  try {
    const r = el.getBoundingClientRect()
    out.width = r.width; out.height = r.height
    let n = el
    while (n && n.nodeType === 1) {
      const s = getComputedStyle(n)
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || Number(s.opacity) < 0.1 || s.clipPath === 'inset(50%)' || s.clip === 'rect(0px, 0px, 0px, 0px)') { out.hidden = true; break }
      const next = n.parentElement || (n.getRootNode && n.getRootNode().host) || null
      n = next
    }
    out.ariaHidden = !!(el.closest && el.closest('[aria-hidden="true"],[inert]'))
    if (r.right < 0 || r.bottom < 0 || r.left > Math.max(document.documentElement.scrollWidth, innerWidth) + 50) out.hidden = true
  } catch (e) { out.hidden = true }
  try {
    const f = el.form
    if (f) out.action = new URL(f.getAttribute('action') || location.href, location.href).href
  } catch (e) { out.action = 'invalid:' }
  return out
}`

/** Runs with `this` = the element: whether it (through open shadow roots) has keyboard focus. */
export const IS_FOCUSED = `function () {
  let a = document.activeElement
  while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement
  return a === this
}`

const TEXTY = new Set(['text', 'email', 'tel', '', 'search', 'url'])
const CARDISH = /\bcc-|one-time-code/

/** Why this field must not receive the value, or null when it's a real, visible field of the right kind. */
export function fieldProblem(f: FieldFacts, kind: FieldKind, pageUrl: string): string | null {
  if (!f.connected) return 'The field is no longer on the page.'
  if (f.tag !== 'input') return 'That element is not an input field.'
  if (f.disabled || f.readOnly) return 'The field is disabled or read-only.'
  if (f.hidden || f.ariaHidden || f.width < 4 || f.height < 4) return 'The field is hidden. Saved values are only typed into fields you can see.'
  if (!isSecurePage(f.frameUrl)) return 'The field is on a page that isn\'t secure (not HTTPS).'
  if (!sameSiteUrls(f.frameUrl, pageUrl)) return 'The field is inside a frame from another site.'
  if (f.action) {
    if (/^javascript:|^data:|^invalid:/i.test(f.action)) return 'The field\'s form sends to an address SahilBot can\'t check.'
    if (!isSecurePage(f.action) && /^http:/i.test(f.action)) return 'The field\'s form sends without encryption (http).'
    if (/^https?:/i.test(f.action) && !sameSiteUrls(f.action, pageUrl)) return `The field's form sends to another site (${originOfUrl(f.action)}).`
  }
  const ac = f.autocomplete
  if (kind === 'password') {
    const pw = f.type === 'password' || /\b(current|new)-password\b/.test(ac)
    if (!pw) return 'That is not a password field. Passwords only go into password fields.'
    if (CARDISH.test(ac)) return 'That field is marked for a card or one-time code, not a password.'
    return null
  }
  if (f.type === 'password' || /\b(current|new)-password\b/.test(ac)) return kind === 'username' ? 'That is a password field, not a username field.' : 'That is a password field.'
  if (!TEXTY.has(f.type) && !(kind === 'id_number' && f.type === 'number')) return `That field (type "${f.type}") can't take a ${kind === 'username' ? 'username' : 'document number'}.`
  if (CARDISH.test(ac)) return 'That field is marked for a card or one-time code.'
  return null
}

export interface FillRequest {
  /** Sites the item may be typed on. Empty: nowhere (IDs without an allow-list). */
  origins: string[]
  subdomains?: boolean
  pageUrl: string
  /** The site the step was approved for (the page may have changed since). */
  expectedOrigin?: string
  /** The user approved this exact call (an approval card), or a standing rule for this site allows it. */
  approved: boolean
}

/** Checks that don't need the page's DOM: site, HTTPS, approval. The first problem, or null. */
export function fillProblem(r: FillRequest, name: string): string | null {
  const page = originOfUrl(r.pageUrl) || 'this page'
  if (!r.origins.length) return `"${name}" has no site it may be typed on. Add one in Settings → Vault.`
  if (!r.origins.some((o) => originMatches(o, r.pageUrl, { subdomains: !!r.subdomains }))) return `"${name}" is saved for ${r.origins.join(', ')}, but this page is ${page}. It will only be typed on its own site.`
  if (!isSecurePage(r.pageUrl)) return `This page (${page}) isn't secure (not HTTPS), so nothing from the vault is typed into it.`
  if (r.expectedOrigin && r.expectedOrigin !== originOfUrl(r.pageUrl)) return `The page changed to ${page} since this step was approved for ${r.expectedOrigin}, so nothing was typed.`
  if (!r.approved) return 'This fill was not approved.'
  return null
}

/**
 * Whether a standing rule ("sign in here without asking") covers this page: only for logins, only on the
 * login's own site, only for its username and password.
 */
export function standingRuleAllows(meta: { autoFill?: boolean; origins?: string[]; subdomains?: boolean }, type: string, field: string, pageUrl: string): boolean {
  return type === 'login' && !!meta.autoFill && (field === 'username' || field === 'password') && (meta.origins ?? []).some((o) => originMatches(o, pageUrl, { subdomains: !!meta.subdomains }))
}
