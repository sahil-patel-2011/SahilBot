import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { PurchaseInfo, ToolEffect } from '@shared/types'
import { benignClickLabel, classifyPurchase, clean, isCheckoutUrl, labelHasPrice, PAGE_NAME, purchaseWording, PURCHASES_NEED_YOU, redactCards, type PurchaseGate, type PurchaseSignals } from '../../browser/checkout'
import { safeUrl, type BrowserManager, type Expected, type OfferedDownload, type PageCommerce, type RefInfo } from '../../browser/manager'
import { routineDownload } from '../../browser/download-policy'
import { MAX_MS, MAX_STEPS, stepDetails, stepsToText, SECRET } from '../../browser/teach'
import { codeCandidate, codeSnippet, pickCode, senderDomain, type CodeMessage } from '../../otp'
import type { SiteEvent } from '../../sites/learn'
import { domainOf } from '../../sites/safe'
import type { SiteStore } from '../../sites/store'
import { originMatches, type Vault } from '../../vault'
import { fillProblem, standingRuleAllows } from '../../secure/guards'
import { isSecurePage } from '../../secure/origin'
import { browsingLabel, CONSEQUENTIAL, looksLikePayAction, looksLikePayment, looksLikeSecurity, OTP_STOP, PURCHASE_STOP } from '../permissions'
import type { ToolContext, ToolDef, ToolOutput } from '../types'
import { resolvePath } from './files'

type Action = 'navigate' | 'snapshot' | 'click' | 'type' | 'select' | 'fill_secret' | 'fill_payment' | 'fill_address' | 'fill_otp' | 'wallet' | 'upload' | 'downloads' | 'wait' | 'wait_for_signin'
  | 'scroll' | 'screenshot' | 'get_text' | 'tabs' | 'dialog' | 'fill_form' | 'recording' | 'find' | 'extract' | 'expand' | 'next_page' | 'key' | 'back' | 'forward' | 'hover'
  /** Internal only (never in the schema): Enter in a field whose text was already typed. */
  | 'enter'
interface Args {
  action: Action
  url?: string
  ref?: string
  text?: string
  submit?: boolean
  /** key: one or more presses, e.g. "Escape", "ArrowDown ArrowDown", "shift+Tab". */
  keys?: string
  secret?: string
  field?: 'username' | 'password' | 'id_number'
  direction?: 'up' | 'down'
  amount?: number
  /** tabs: list|new|switch|close; recording: start|stop|status; downloads: list|save */
  op?: 'list' | 'new' | 'switch' | 'close' | 'start' | 'stop' | 'status' | 'save'
  index?: number
  option?: string
  accept?: boolean
  /** fill_form: several fields in one step (text for inputs, option for dropdowns), then optionally a submit click. */
  fields?: Array<{ ref: string; text?: string; option?: string }>
  submit_ref?: string
  /** fill_payment: a saved card's nickname (or "Visa ending 4242"). */
  card?: string
  /** fill_address: a saved address's nickname; section picks shipping or billing fields. */
  address?: string
  section?: 'shipping' | 'billing'
  /** fill_otp: where the code comes from. */
  source?: 'authenticator' | 'email' | 'sms'
  /** upload: files from the workspace or the chat's attached folders. */
  paths?: string[]
  /** wait: seconds (default 10). */
  timeout?: number
  /** find: what to look for, in plain words ("the search box", "Export CSV button"). */
  query?: string
  /** extract: what to pull out (auto picks tables, then cards, then lists); max rows/items. */
  kind?: 'auto' | 'table' | 'list' | 'cards'
  max?: number
  /** snapshot: every line, not just the visible area of a long page. */
  full?: boolean
  /** expand: the first hidden line to show (paging through a long list). */
  start?: number
}

/** A button that makes a new API key or access token (not one that deletes, rotates or changes account security). */
const CREATES_KEY = /^(\+\s*)?(create|generate|new|add)\b.{0,30}\b(api[ -]?keys?|api tokens?|access tokens?|personal access tokens?|secret keys?)\b/i
/** Key buttons that change account security: never exempt (security / recovery / SSH / deploy keys, passkeys, 2FA). */
const SECURITY_KEY = /\b(security|recovery|backup|ssh|gpg|signing|deploy|passkeys?|2fa|two[- ]factor|mfa|authenticator)\b/i

export interface BrowserDeps {
  /** Purchase and one-time-code cards. Without one, purchases and codes are refused (fail closed). */
  gate?: PurchaseGate
  /** Recent emails (the Gmail connector, else Mail.app) for codes sent by email; `site` ranks that site's mail first. */
  email?: (minutes: number, site?: string) => Promise<CodeMessage[]>
  /** Recent text messages (Messages) for codes sent by SMS. */
  sms?: (sinceMs: number) => Promise<CodeMessage[]>
  /** Site playbooks: learns from each call, and adds what it knows when a known site opens. */
  sites?: SiteStore
}

const DESTRUCTIVE = /\b(delete|remove|erase|destroy|discard|close account|deactivate|unsubscribe all|empty trash)\b/i
const BENIGN = /^(search|go|next|previous|prev|more|show|hide|expand|collapse|close|cancel|back|menu|filter|sort|open|view|load more|see (all|more)|read more|accept( all)?( cookies)?|reject( all)?|dismiss|ok|got it|skip|toggle|play|pause|zoom|×|x)\b/i
const LOCAL_ROLES = new Set(['checkbox', 'radio', 'option', 'combobox', 'listbox', 'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'slider', 'spinbutton'])
const REF_ACTIONS = new Set<Action>(['click', 'type', 'select', 'fill_secret', 'upload', 'scroll'])

/** Words of money or consequence in a label: such a click is never a plain read. */
function weighty(name: string): boolean {
  return looksLikePayment(name) || CONSEQUENTIAL.test(name) || purchaseWording(name) || labelHasPrice(name)
}

/**
 * What a click on this element can do, judged from its role and label. Only a real <a href> to another
 * http(s) page is plain navigation (a read); "#", "javascript:", role=link on something else, and any
 * link or tab whose label speaks of paying, ordering, sending… or names a price, are outside actions.
 */
export function clickEffect(r: RefInfo | undefined): ToolEffect {
  if (!r) return 'write_external'
  if (DESTRUCTIVE.test(r.name)) return 'destructive'
  const heavy = weighty(r.name)
  const money = looksLikePayment(r.name) || purchaseWording(r.name) || labelHasPrice(r.name)
  // A real link to another page only opens it: "Check out the docs", or a product's title with its price (checkout.ts
  // classifyPurchase: reading prices is research; a price link on a checkout page has the Purchase card).
  if (r.role === 'link') {
    if (r.navLink !== true) return 'write_external'
    const label = browsingLabel(r.name)
    // (A page's name, "Billing" or "Purchase history", only opens it: only a paying action is one.)
    return looksLikePayAction(label) || ((CONSEQUENTIAL.test(label) || purchaseWording(label)) && !PAGE_NAME.test(label.trim())) ? 'write_external' : 'read'
  }
  if (r.role === 'tab') return heavy ? 'write_external' : 'read'
  if (LOCAL_ROLES.has(r.role)) return money ? 'write_external' : 'write_local'
  if (BENIGN.test(r.name.trim()) && !money) return 'write_local'
  return 'write_external'
}

export function browserTool(b: BrowserManager, vault: Vault, deps: BrowserDeps = {}): ToolDef<Args> {
  /** Per tab: the card and address SahilBot filled, for the Purchase card's "Pay with" / "Ship to". */
  const filled = new Map<number, { host: string; card?: string; address?: string }>()
  /** The tab and site an approved fill was decided for (set when the permission check sees it). */
  const decidedFor = new WeakMap<object, Expected>()
  const downloads = new WeakMap<Args, { expected: OfferedDownload; page?: string }>()
  const expectNow = (): Expected | undefined => { try { return b.expectation?.() } catch { return undefined } }
  /** Purchase steps the user declined (the submit after them doesn't run). */
  const declined = new WeakSet<ToolOutput>()
  /**
   * Sites (per chat) where SahilBot typed, filled, signed in or went to buy: a human check there is the user's to pass.
   * Anywhere else it is a bot wall in plain research: move on to another source, no hand-over and no card.
   */
  const actedOn = new Set<string>()
  const siteKey = (ctx: ToolContext | undefined, url: string): string => `${ctx?.threadId ?? ''}|${safeHost(url)}`

  const effect = (a: Args): ToolEffect => {
    switch (a.action) {
      case 'click': return clickEffect(b.refInfo(a.ref!))
      case 'type': {
        const r = b.refInfo(a.ref!)
        if (!a.submit) return 'write_local'
        return r?.role === 'searchbox' && !isCheckoutUrl(b.pageUrl()) ? 'read' : 'write_external'
      }
      case 'enter': return 'write_external'
      case 'fill_secret': case 'fill_payment': case 'fill_address': case 'fill_otp': case 'upload': return 'write_external'
      case 'downloads': return a.op === 'save' ? 'write_local' : 'read'
      case 'select': case 'key': return 'write_local'
      case 'fill_form': return a.submit_ref ? clickEffect(b.refInfo(a.submit_ref)) : 'write_local'
      case 'dialog': return a.accept && b.pendingDialog?.type !== 'alert' ? 'write_external' : 'read'
      case 'tabs': return a.op === 'close' ? 'write_local' : 'read'
      // Starting a recording captures what the user clicks and types, across tabs, for up to 10 minutes:
      // treated as an outside action so it never starts silently (stop and status only read).
      case 'recording': return a.op === 'start' ? 'write_external' : 'read'
      default: return 'read'
    }
  }

  /** The purchase signals an action carries, judged without touching the page (for the permission check). */
  const quickSignals = (a: Args): PurchaseSignals | null => {
    if (!['fill_payment', 'dialog', 'type', 'fill_form', 'click', 'enter'].includes(a.action)) return null
    const url = b.pageUrl()
    const page = b.commerce()
    const tracked = filled.get(b.tabKey())
    const payFilled = page.payFilled || (!!tracked?.card && tracked.host === safeHost(url))
    if (a.action === 'fill_payment') return { kind: 'fill_payment', url }
    if (a.action === 'dialog') return a.accept ? { kind: 'dialog', dialogText: b.pendingDialog?.message, url } : null
    if (a.action === 'type' || a.action === 'fill_form') {
      const refs = a.action === 'type' ? [a.ref!] : (a.fields ?? []).filter((f) => f.text !== undefined).map((f) => f.ref)
      if (refs.some((x) => b.refInfo(x)?.payment === 'number')) return { kind: 'type_card', url }
    }
    if (a.action === 'click' || a.action === 'fill_form') {
      const ref = a.action === 'click' ? a.ref : a.submit_ref
      if (!ref) return null
      const r = b.refInfo(ref)
      return { kind: 'click', label: r?.name, role: r?.role, url, payFields: page.payFields, payFilled, navLink: r?.navLink }
    }
    if ((a.action === 'type' && a.submit) || a.action === 'enter') {
      const r = b.refInfo(a.ref!)
      return { kind: 'enter', label: r?.name, role: r?.role, url, payFields: page.payFields, payFilled, inPayForm: !!r?.payment }
    }
    return null
  }

  const purchaseStop = (a: Args): string | null => {
    const sig = quickSignals(a)
    if (!sig) return null
    const c = classifyPurchase(sig)
    return c.purchase ? `${PURCHASE_STOP}${c.reasons[0]} on ${safeHost(b.pageUrl())}` : null
  }

  const hardStop = (a: Args): string | null => {
    const r = a.ref ? b.refInfo(a.ref) : undefined
    const url = b.pageUrl()
    // A login, address or code goes only to the tab and site the user saw when this was decided.
    if (['fill_secret', 'fill_address', 'fill_otp', 'fill_payment'].includes(a.action) && a && typeof a === 'object') { const e = expectNow(); if (e) decidedFor.set(a, e) }
    // Purchases and one-time codes ask with their own cards inside run() (see checkout.ts).
    const p = purchaseStop(a)
    if (p) return p
    if (a.action === 'fill_otp') return `${OTP_STOP}from ${a.source ?? 'authenticator'} on ${safeHost(url)}`
    // The agent starting a recording always asks (the user's own Teach button doesn't go through here).
    if (a.action === 'recording' && a.op === 'start') return `recording what you click and type in the browser for up to ${MAX_MS / 60_000} minutes`
    if (a.action === 'fill_secret') {
      // A standing rule the user set for this login's own site ("sign in here without asking").
      if (standingRule(a, url)) return null
      // The bot signs in by itself with a saved login on that login's own secure site. Any other site (a look-alike
      // page, a link from an email) still asks, and a saved ID's number always does.
      if (ownSite(a, url)) return null
      return a.field === 'id_number' ? `typing the saved ID "${a.secret}" (document number) into ${safeHost(url)}` : `typing the saved login "${a.secret}" (${a.field ?? 'password'}) into ${safeHost(url)}`
    }
    if (a.action === 'fill_address') return `typing your saved address "${a.address}" into ${safeHost(url)}`
    if (a.action === 'upload') return `uploading ${(a.paths ?? []).map((x) => `"${x.split(/[\\/]/).pop()}"`).join(', ')} to ${safeHost(url)}`
    if (a.action === 'downloads' && a.op === 'save') {
      const item = b.offeredDownloads()[(a.index ?? 1) - 1]
      if (!item) return null
      const routine = routineDownload(item, url)
      downloads.set(a, { expected: item, ...(routine ? { page: url } : {}) })
      return routine ? null : `saving a download ("${item.filename}") from ${item.host} into your workspace`
    }
    if (a.action === 'type' && r?.password) return 'typing into a password field'
    if (a.action === 'fill_form' && (a.fields ?? []).some((f) => b.refInfo(f.ref)?.password)) return 'typing into a password field'
    if (a.action === 'dialog' && a.accept && (looksLikePayment(b.pendingDialog?.message) || DESTRUCTIVE.test(b.pendingDialog?.message ?? ''))) return `confirming "${b.pendingDialog?.message.slice(0, 80)}"`
    if (a.action === 'click' || (a.action === 'type' && a.submit) || a.action === 'enter') {
      // The label is judged, and the page only by its structured checkout address, never for plain navigation
      // (github.com/actions/checkout, docs about billing).
      if (clickEffect(r) !== 'read' && (looksLikePayAction(browsingLabel(r?.name ?? '')) || isCheckoutUrl(url))) return 'payment or checkout'
      if (DESTRUCTIVE.test(r?.name ?? '') && /\b(permanent|forever|account)\b/i.test(r?.name ?? '')) return 'permanent delete'
      // Making an API key or token the user asked for is ordinary work (the key goes to the user, who can save it
      // to the vault); every other change on a security or account page still asks.
      if (looksLikeSecurity(url, r?.name) && clickEffect(r) !== 'read' && !(CREATES_KEY.test(r?.name ?? '') && !SECURITY_KEY.test(r?.name ?? ''))) return 'account or security settings'
    }
    return null
  }

  /** The login's "sign in here without asking" rule covers this call (its own site, username or password). */
  const standingRule = (a: Args, url = b.pageUrl()): boolean => {
    const t = safeCall(() => vault.fillTarget(a.secret ?? '', a.field ?? 'password'), undefined)
    return !!t && standingRuleAllows(t, t.type, a.field ?? 'password', url)
  }
  const ownSite = (a: Args, url = b.pageUrl()): boolean => {
    const field = a.field ?? 'password'
    if (field !== 'username' && field !== 'password') return false
    const t = safeCall(() => vault.fillTarget(a.secret ?? '', field), undefined)
    return !!t && t.type === 'login' && isSecurePage(url) && t.origins.some((o) => originMatches(o, url, { subdomains: !!t.subdomains }))
  }
  /** True only while an approved Purchase card's step runs (card numbers are filled nowhere else). */
  let purchaseApproved = false

  const describe = (a: Args): string => {
    const r = a.ref ? b.refInfo(a.ref) : undefined
    const el = r ? `${r.role} "${r.name.slice(0, 60)}"` : a.ref ?? ''
    const on = ` on ${safeHost(b.pageUrl())}`
    switch (a.action) {
      case 'click': return `Click ${el}${on}`
      case 'type': return `Type "${(a.text ?? '').slice(0, 80)}" into ${el}${a.submit ? ' and press Enter' : ''}${on}`
      case 'fill_secret': return `Type the saved ${a.field ?? 'password'} for "${a.secret}" into ${el}${on}`
      case 'fill_payment': return `Fill the saved card "${a.card}" into the payment form${on}`
      case 'fill_address': return `Fill the saved address "${a.address}" into the ${a.section ?? 'shipping'} fields${on}`
      case 'fill_otp': return `Fill a one-time code from ${a.source ?? 'the authenticator'}${on}`
      case 'upload': return `Upload ${(a.paths ?? []).join(', ')} into ${el}${on}`
      case 'downloads': return a.op === 'save' ? `Save download ${a.index ?? 1} into the workspace` : 'List offered downloads'
      case 'wait': return `Wait for ${a.text ? `"${a.text}"` : a.url ? `the address to contain "${a.url}"` : 'the page to settle'}`
      case 'wait_for_signin': return 'Wait for you to sign in'
      case 'wallet': return 'List saved cards and addresses (nicknames only)'
      case 'navigate': return `Open ${a.url}`
      case 'select': return `Choose "${a.option}" in ${el}${on}`
      case 'dialog': return `${a.accept ? 'Accept' : 'Dismiss'} the page's ${b.pendingDialog?.type ?? 'dialog'}: "${b.pendingDialog?.message.slice(0, 120) ?? ''}"`
      case 'tabs': return `${a.op} tab${a.index ? ` ${a.index}` : ''}${a.text ? ` matching "${a.text.slice(0, 40)}"` : ''}`
      case 'fill_form': return `Fill ${a.fields?.length ?? 0} fields${a.submit_ref ? ` and click "${b.refInfo(a.submit_ref)?.name ?? a.submit_ref}"` : ''}${on}`
      case 'recording': return a.op === 'start' ? `Record what you do in the browser for up to ${MAX_MS / 60_000} minutes (Teach a task)` : a.op === 'stop' ? 'Stop recording and read the steps' : 'Check the Teach recording'
      case 'find': return `Find "${(a.query ?? a.text ?? '').slice(0, 60)}"${on}`
      case 'extract': return `Read ${a.kind && a.kind !== 'auto' ? `the ${a.kind === 'cards' ? 'cards' : `${a.kind}s`}` : 'the data'}${on}`
      case 'expand': return `Show the rest of a collapsed list${on}`
      case 'key': return `Press ${(a.keys ?? '').trim().slice(0, 40)}${a.ref ? ` in ${el}` : ''}${on}`
      case 'back': case 'forward': return `Go ${a.action} a page${on}`
      case 'hover': return `Point at ${el}${on}`
      case 'next_page': return `Find the next-page control${on}`
      default: return `${a.action}${on}`
    }
  }

  /** Card numbers and recent one-time codes never appear in anything the model reads. */
  const redact = (text: string): string => {
    let t = redactCards(text, safeCall(() => vault.cardNumbers(), []))
    for (const c of b.hiddenValues()) if (c.length >= 4) t = t.replace(new RegExp(`(?<!\\d)${c}(?!\\d)`, 'g'), '••••')
    // Every other saved value (passwords, authenticator keys, ID numbers) the page might echo back.
    const masked = t
    return safeCall(() => vault.redact(masked), masked)
  }

  return {
    name: 'browser',
    label: 'Browser',
    group: 'Browser',
    effect,
    hardStop,
    describe,
    // A click counts as consequential unless its label is clearly harmless ("Sign in", "Next", "Search"…);
    // pressing Enter to submit a form does too.
    consequential: (a) => {
      const r = a.ref ? b.refInfo(a.ref) : undefined
      // A same-site navigation link with no money or commit words is just browsing (found live: "Small Residential Storage").
      if (a.action === 'click') return !r || (!(r.role === 'link' && r.navLink === true && !weighty(r.name)) && !benignClickLabel(r.name))
      if (a.action === 'type' || a.action === 'enter') return a.action === 'enter' || !!a.submit
      if (a.action === 'recording') return a.op === 'start'
      if (a.action === 'fill_secret') return !standingRule(a)
      if (a.action === 'dialog') return CONSEQUENTIAL.test(b.pendingDialog?.message ?? '')
      if (a.action === 'fill_form') { const s = a.submit_ref ? b.refInfo(a.submit_ref) : undefined; return !!a.submit_ref && (!s || !benignClickLabel(s.name)) }
      if (a.action === 'wait' || a.action === 'wait_for_signin' || a.action === 'wallet' || (a.action === 'downloads' && a.op !== 'save') || ['find', 'extract', 'expand', 'next_page', 'snapshot', 'get_text', 'screenshot'].includes(a.action)) return false
      return true
    },
    untrusted: true,
    description: `Control SahilBot's built-in web browser. It works in the background and the user can open it at any time. Actions:
- navigate {url}: open a URL (declines cookie banners when there's a reject option)
- snapshot {full?}: page structure with element refs like e12. navigate, click, type and Enter already return what they changed (new elements marked *, or the new page's start), and a ref stays the same for the same element while the page is the same, so snapshot only to read the whole page. Long pages show the visible area first; long lists show a few items and [expand=g3]; full=true shows all
- find {query}: elements matching a description ("the search box"), with refs
- extract {kind?: auto|table|list|cards, ref?, max?}: tables, lists, product cards as JSON, and the next page
- expand {ref: "g3", start?}: the rest of a collapsed list
- next_page: the next-page / Load more control's ref
- click {ref}
- hover {ref}: point at an element (menus that open on hover)
- key {keys, ref?}: press keys: "Escape" closes a popup, "ArrowDown" moves in a menu or date picker, "Tab" / "shift+Tab" between fields, "cmd+a"; several as "ArrowDown ArrowDown". Enter: type with submit=true
- back / forward: the tab's previous or next page
- type {ref, text, submit?}: replace a field's text; submit presses Enter
- select {ref, option}: choose an option in a dropdown (snapshot lists them)
- dialog {accept, text?}: answer an alert/confirm/prompt the page opened
- fill_secret {ref, secret, field}: type a saved login's username or password (or a saved ID's document number: field "id_number", secret = the ID's name); you never see it. If the vault is locked, the user is asked to unlock it
- fill_otp {secret?, source}: type a one-time sign-in code: source "authenticator" (the saved login's authenticator key; secret = login name), "email" or "sms" (a code the site just sent). You never see the code. The user approves using codes on each site.
- wallet: nicknames of the user's saved cards and addresses
- fill_payment {card}: put a saved card (nickname, or "Visa ending 4242") into the page's card fields; you never see it. The user approves it on a Purchase card.
- fill_address {address, section?}: put a saved address into the shipping (default) or billing fields
- upload {ref, paths}: attach files from the workspace or attached folders to a file field
- downloads {op: list|save, index?}: view offered files or save one. Auto can save small same-site HTTPS text, CSV, and raster image files into Downloads. Other downloads need approval.
- wait {text?, url?, timeout?}: wait for text to appear, the address to change, or the page to settle
- wait_for_signin: the page needs the user's own sign-in and there is no saved login for fill_secret. Opens the page for the user and waits (up to 10 minutes) until the sign-in form is gone, then carries on by itself: don't end your turn or ask the user to say when they're done.
- scroll {direction, amount?} or {ref}: amount is in screens (default 1); ref scrolls that element into view
- screenshot: image of the visible page
- get_text: readable text of the page
- tabs {op: list|new|switch|close, index?, url?, text?}: text = part of a tab's title or address
- fill_form {fields: [{ref, text} or {ref, option}], submit_ref?}: fill a whole form in one step (fastest), optionally click submit
- recording {op: start|stop|status, text?}: "Teach a task". start records what the USER does in the browser panel (text = what you asked them to show); stop returns their steps (secret values hidden). Use it when the user wants to show you a web workflow once so you can repeat it.
Buying: go all the way to the final Place order / Pay button and click it. SahilBot then shows the user a Purchase card with the store, items and total, and only their click there lets it go through; nothing you write can approve it, and if they decline, stop. Never type card numbers yourself.
Speed: navigate already returns a snapshot; act by ref; use fill_form for forms, find for an element, extract for data, get_text for long text. A known site's navigate adds "What I know about <site>": hints from past runs; check them against the page.
CAPTCHAs and "are you human" checks during a sign-in, form or purchase are the user's (the panel hands them over); in plain research the step returns a bot-wall note: use another source.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['navigate', 'snapshot', 'click', 'type', 'select', 'fill_secret', 'fill_payment', 'fill_address', 'fill_otp', 'wallet', 'upload', 'downloads', 'wait', 'wait_for_signin', 'scroll', 'screenshot', 'get_text', 'tabs', 'dialog', 'fill_form', 'recording', 'find', 'extract', 'expand', 'next_page', 'key', 'back', 'forward', 'hover'] },
        query: { type: 'string' },
        kind: { type: 'string', enum: ['auto', 'table', 'list', 'cards'] },
        max: { type: 'integer', minimum: 1, maximum: 200 },
        full: { type: 'boolean' },
        start: { type: 'integer', minimum: 0 },
        fields: { type: 'array', maxItems: 40, items: { type: 'object', properties: { ref: { type: 'string', pattern: '^e\\d+$' }, text: { type: 'string' }, option: { type: 'string' } }, required: ['ref'], additionalProperties: false } },
        submit_ref: { type: 'string', pattern: '^e\\d+$' },
        option: { type: 'string', description: 'For select: the option text' },
        accept: { type: 'boolean', description: 'For dialog: true = OK/accept, false = cancel' },
        url: { type: 'string' },
        ref: { type: 'string', pattern: '^[eg]\\d+$' },
        text: { type: 'string' },
        keys: { type: 'string', description: 'key: e.g. "Escape", "ArrowDown ArrowDown", "shift+Tab", "cmd+a"' },
        submit: { type: 'boolean' },
        secret: { type: 'string', description: 'Name of a saved login' },
        field: { type: 'string', enum: ['username', 'password', 'id_number'] },
        card: { type: 'string', description: 'fill_payment: saved card nickname' },
        address: { type: 'string', description: 'fill_address: saved address nickname' },
        section: { type: 'string', enum: ['shipping', 'billing'] },
        source: { type: 'string', enum: ['authenticator', 'email', 'sms'], description: 'fill_otp: where the code comes from' },
        paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10, description: 'upload: workspace-relative paths or files in attached folders' },
        timeout: { type: 'number', minimum: 1, maximum: 60, description: 'wait: seconds' },
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'number', minimum: 0.1, maximum: 10 },
        op: { type: 'string', enum: ['list', 'new', 'switch', 'close', 'start', 'stop', 'status', 'save'], description: 'tabs: list|new|switch|close; recording: start|stop|status; downloads: list|save' },
        index: { type: 'integer', minimum: 1, description: '1-based tab or download number' }
      },
      required: ['action'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { action: { const: 'navigate' } } }, then: { required: ['url'] } },
        { if: { properties: { action: { const: 'click' } } }, then: { required: ['ref'] } },
        { if: { properties: { action: { const: 'type' } } }, then: { required: ['ref', 'text'] } },
        { if: { properties: { action: { const: 'fill_secret' } } }, then: { required: ['ref', 'secret', 'field'] } },
        { if: { properties: { action: { const: 'fill_payment' } } }, then: { required: ['card'] } },
        { if: { properties: { action: { const: 'fill_address' } } }, then: { required: ['address'] } },
        { if: { properties: { action: { const: 'upload' } } }, then: { required: ['ref', 'paths'] } },
        { if: { properties: { action: { const: 'downloads' } } }, then: { required: ['op'] } },
        { if: { properties: { action: { const: 'tabs' } } }, then: { required: ['op'] } },
        { if: { properties: { action: { const: 'recording' } } }, then: { required: ['op'] } },
        { if: { properties: { action: { const: 'select' } } }, then: { required: ['ref', 'option'] } },
        { if: { properties: { action: { const: 'dialog' } } }, then: { required: ['accept'] } },
        { if: { properties: { action: { const: 'fill_form' } } }, then: { required: ['fields'] } },
        { if: { properties: { action: { const: 'find' } } }, then: { required: ['query'] } },
        { if: { properties: { action: { const: 'expand' } } }, then: { required: ['ref'] } }
      ]
    },
    async run(input, ctx) {
      const before = { url: b.pageUrl(), title: safeCall(() => b.pageTitle(), '') }
      const targets = targetsOf(input)
      const seen: { check?: string } = {}
      if (ACTING.has(input.action) || (input.action === 'click' && ACTING_CLICK.test(targets.target?.name ?? '')) || purchaseStop(input)) actedOn.add(siteKey(ctx, before.url))
      try {
        let out = await runInner(input, ctx, seen)
        out = withSiteNote(input, out, before.url, ctx)
        learn(input, ctx, before, targets, out, seen)
        return out
      } catch (e) {
        learn(input, ctx, before, targets, null, seen, e as Error)
        throw e
      }
    }
  }

  async function runInner(input: Args, ctx: ToolContext, seen: { check?: string }): Promise<ToolOutput> {
    if (input.action === 'recording') return recording(input, ctx?.threadId)
    if (input.action === 'wallet') return wallet()
    if ((input.action as string) === 'enter') throw new Error('Unknown action enter.')
    // The tab and site this step was decided for (fills only go there).
    const expected = decidedFor.get(input) ?? expectNow()
    const notes: string[] = []
    const a = await freshRefs(input, notes)
    let out: ToolOutput
    if (a.action === 'fill_otp') out = await fillOtp(a, ctx, expected)
    else if ((a.action === 'fill_form' && a.submit_ref) || (a.action === 'type' && a.submit)) out = await typeThenSubmit(input, a, ctx, expected)
    // Judged before stale refs are re-found too: a purchase as the permission check saw it stays one.
    else out = await step(a, ctx, !!purchaseStop(input), expected)
    const blocked = b.takeBlockedCard()
    if (blocked.length) notes.push(`SahilBot stopped ${blocked.join(', ')} from receiving your saved card details: that only happens during a purchase step the user approved.`)
    const leaks = b.takeCardLeaks?.() ?? []
    if (leaks.length) notes.push(`Warning: the page sent your saved card number over an already-open connection to ${leaks.join(', ')}. Stop here and tell the user, so they can check the card with their bank.`)
    out = { ...out, text: redact([out.text, ...notes].filter(Boolean).join('\n')), display: out.display ? redact(out.display) : out.display }
    // CAPTCHAs, 2-factor screens and bank checks (3-D Secure): never solved or worked around by SahilBot.
    if (['navigate', 'click', 'snapshot', 'fill_form', 'type', 'get_text', 'fill_payment', 'fill_address', 'fill_secret', 'wait'].includes(a.action)) {
      const check = await b.humanCheck()
      if (check) {
        seen.check = check
        const code = check === 'verification code'
        // Plain research (nothing typed, filled or bought on this site): a bot wall, not the user's job.
        if (!code && !actedOn.has(siteKey(ctx, b.pageUrl()))) {
          return { ...out, text: `${out.text}\n\n[This site shows a ${check}: a bot wall. Don't wait or ask the user; use another result from web_search or another reputable site, and say in one sentence which site blocked you.]`, display: `${out.display ?? ''} · ${check}: trying another source` }
        }
        if (!code) b.showToUser()
        const tail = code
          ? `\n\n[This page asks for a verification code. If it's for the user's own sign-in, use fill_otp (source "authenticator" with the saved login, or "email" / "sms" for a code the site just sent). Never guess codes. If none of those works, open the panel and call ask_user with "Please enter the code in the browser panel, then press Done." and options ["Done", "Skip"].]`
          : ''
        if (code) return { ...out, text: `${out.text}${tail}`, display: `${out.display ?? ''} · needs a sign-in code` }
        // A human check is the user's to pass: hand it over right here (the panel is open and the
        // "needs you" notification fires), then carry on. SahilBot never solves or gets around it.
        // Watched, not just asked: once the check is gone the run carries on by itself.
        const answer = ctx.waitForUser
          ? await ctx.waitForUser(`This page is showing a ${check}. Please complete it in the browser panel; SahilBot continues by itself when it's done.`, async () => !(await b.humanCheck()), { options: ['Done', 'Skip'] })
          : await ctx.askUser(`This page is showing a ${check}. Please complete it in the browser panel, then press Done.`, ['Done', 'Skip'])
        const still = /^done/i.test(answer) ? await b.humanCheck() : check
        const after = /^done/i.test(answer)
          ? still
            ? `\n\n[The user pressed Done but the page still shows a ${still}. Ask them once more with ask_user, or try another source.]`
            : '\n\n[The user completed the check. Take a snapshot and continue the task.]'
          : /^skip/i.test(answer)
            ? `\n\n[The user skipped the ${check}. Don't retry this page; try another source or tell the user what you couldn't reach.]`
            : `\n\n[Nobody could complete the ${check} now (it needs the user). Skip this page, note it in your summary, and continue with what you can do.]`
        return { ...out, text: `${out.text}${after}`, display: `${out.display ?? ''} · ${!still && /^done/i.test(answer) ? 'you passed the check' : `${check}: handed to you`}` }
      }
    }
    return out
  }

  /** The elements an action targets, as they were before it ran (refs drop when the page changes). */
  function targetsOf(a: Args): Pick<SiteEvent, 'target' | 'fields' | 'submitTarget'> {
    const info = (ref?: string): SiteEvent['target'] => {
      const r = ref ? b.refInfo(ref) : undefined
      return r ? { role: r.role, name: r.name, ...(r.password ? { password: true } : {}), ...(r.payment ? { payment: r.payment } : {}), ...(r.navLink !== undefined ? { navLink: r.navLink } : {}) } : undefined
    }
    try {
      if (a.action === 'fill_form') {
        const fields: NonNullable<SiteEvent['fields']> = []
        for (const f of a.fields ?? []) {
          const r = b.refInfo(f.ref)
          if (r) fields.push({ role: r.role, name: r.name, ...(f.option !== undefined ? { select: true } : {}), ...(r.password || r.payment ? { secret: true } : {}) })
        }
        return { fields, submitTarget: info(a.submit_ref) }
      }
      return a.ref && /^e\d+$/.test(a.ref) ? { target: info(a.ref) } : {}
    } catch {
      return {}
    }
  }

  /** What a call's result says happened, as tags the playbook learns from. */
  function tagsOf(text: string, title: string, err?: Error): string[] {
    const t: string[] = []
    const has = (re: RegExp): boolean => re.test(text)
    if (has(/Navigated to |^Opened /)) t.push('navigated')
    if (has(/The page changed/)) t.push('changed')
    if (has(/No visible change on the page/)) t.push('nochange')
    if (has(/opened a new tab/)) t.push('newtab')
    if (has(/The page (asked to|showed an alert)/)) t.push('dialog')
    if (has(/The page offered (a download|\d+ downloads)/)) t.push('download')
    if (has(/Declined a cookie banner/)) t.push('cookie-declined')
    if (has(/cookie banner is showing with no reject option/)) t.push('cookie-acceptonly')
    if (has(/The user approved this purchase step/)) t.push('purchase-approved')
    if (has(/did not approve this purchase step/)) t.push('purchase-declined')
    if (has(/was stale, so a fresh snapshot was taken/)) t.push('stale')
    if (/\b(too many requests|rate[ -]limit(ed)?|you('| a)re being rate limited)\b/i.test(`${title}\n${text.split('\n').slice(0, 4).join(' ').slice(0, 400)}`)) t.push('rate-limit')
    const msg = err?.message ?? ''
    const cov = /is covered by (.+?); nothing was clicked/.exec(msg)
    if (cov) t.push(`covered:${cov[1].replace(/"/g, '').slice(0, 80)}`)
    if (/is disabled; nothing was clicked/.test(msg)) t.push('disabled')
    return t
  }

  /** Reports the call to the site playbooks (never typed values: only what was acted on, and how it went). */
  function learn(a: Args, ctx: ToolContext, before: { url: string; title: string }, targets: Pick<SiteEvent, 'target' | 'fields' | 'submitTarget'>, out: ToolOutput | null, seen: { check?: string }, err?: Error): void {
    const sites = deps.sites
    if (!sites || !ctx?.threadId || ['wallet', 'recording', 'screenshot', 'find', 'expand', 'next_page', 'wait', 'scroll'].includes(a.action)) return
    try {
      const after = b.pageUrl()
      const title = safeCall(() => b.pageTitle(), '')
      const tags = tagsOf(out?.text ?? '', title, err)
      if (seen.check) tags.push(`human:${seen.check}`)
      // A declined purchase step or a refused code isn't a step that worked.
      const refused = !!out && /^(The user did not approve|The user didn't allow)/.test(out.text)
      const ev: SiteEvent = {
        at: Date.now(), action: a.action, url: before.url, after, title, titleBefore: before.title, ...targets, ok: !err && !refused, tags,
        ...(err ? { error: err.message.slice(0, 300) } : {}),
        ...((a.action === 'type' && a.submit) || (a.action === 'fill_form' && a.submit_ref) ? { submit: true } : {}),
        ...(a.action === 'fill_secret' ? { login: a.secret, field: a.field } : {}),
        ...(a.action === 'fill_otp' ? { otp: a.source ?? 'authenticator' } : {}),
        ...(a.action === 'fill_address' ? { section: a.section ?? 'shipping' } : {}),
        ...(a.op ? { op: a.op } : {})
      }
      sites.record(ctx.threadId, ev)
    } catch { /* learning never breaks a call */ }
  }

  /** The first time a run opens a site SahilBot knows: what it learned there, right after the first line. */
  function withSiteNote(a: Args, out: ToolOutput, beforeUrl: string, ctx: ToolContext): ToolOutput {
    const sites = deps.sites
    if (!sites || !ctx?.threadId) return out
    try {
      const after = b.pageUrl()
      const crossed = /Navigated to |it's now the active tab/.test(out.text) && domainOf(after) !== domainOf(beforeUrl)
      if (a.action !== 'navigate' && !(a.action === 'tabs' && (a.op === 'new' || a.op === 'switch')) && !crossed) return out
      const note = sites.noteFor(after, ctx.threadId)
      if (!note) return out
      const i = out.text.indexOf('\n')
      const text = i < 0 ? `${out.text}\n${redact(note)}` : `${out.text.slice(0, i)}\n${redact(note)}${out.text.slice(i)}`
      return { ...out, text, display: `${out.display ?? ''} · knows this site` }
    } catch {
      return out
    }
  }

  /** One step: a purchase goes through the Purchase card; anything else runs (after the commerce check). */
  async function step(a: Args, ctx: ToolContext, sticky: boolean, expected?: Expected, typed?: PurchaseInfo['typed']): Promise<ToolOutput> {
    const sig = await liveSignals(a)
    const verdict = sig ? classifyPurchase(sig.signals) : { purchase: false, reasons: [] }
    if (sticky || verdict.purchase) {
      return gated(a, ctx, sig?.page, verdict.reasons.length ? verdict.reasons : [purchaseStop(a)?.replace(PURCHASE_STOP, '') ?? 'Looks like a purchase step'], expected, typed)
    }
    await commerceGuard(a, ctx, sig?.page)
    return act(a, ctx, expected)
  }

  /**
   * fill_form with a submit button, or type + Enter: the typing happens first (typing isn't a purchase;
   * a card number still asks on its own card), then the submit is judged on the page as it is AFTER the
   * typing, so the Purchase card shows the real total and what was typed, and is re-checked right
   * before the click or Enter.
   */
  async function typeThenSubmit(input: Args, a: Args, ctx: ToolContext, expected?: Expected): Promise<ToolOutput> {
    const typing: Args = a.action === 'fill_form' ? { ...a, submit_ref: undefined } : { ...a, submit: false }
    const typingInput: Args = input.action === 'fill_form' ? { ...input, submit_ref: undefined } : { ...input, submit: false }
    const first = await step(typing, ctx, !!purchaseStop(typingInput), expected)
    if (declined.has(first)) return first
    const submit: Args = a.action === 'fill_form' ? { action: 'click', ref: a.submit_ref } : { action: 'enter', ref: a.ref }
    const submitInput: Args = input.action === 'fill_form' ? { action: 'click', ref: input.submit_ref } : { action: 'enter', ref: input.ref }
    const second = await step(submit, ctx, !!purchaseStop(submitInput) || !!purchaseStop(submit), expected, typedFields(typing))
    return { ...second, text: `${first.text}\n${second.text}`, display: [first.display, second.display].filter(Boolean).join(' · ') }
  }

  /** What was typed in a step, for the Purchase card: field names and values, secrets as dots. */
  function typedFields(a: Args): PurchaseInfo['typed'] {
    const rows = a.action === 'fill_form' ? (a.fields ?? []).map((f) => ({ ref: f.ref, value: f.option ?? f.text ?? '' })) : a.ref ? [{ ref: a.ref, value: a.text ?? '' }] : []
    return rows.slice(0, 12).map(({ ref, value }) => {
      const r = b.refInfo(ref)
      const secret = !!r?.password || !!r?.payment || /\d[\d\s-]{11,}\d/.test(value) || b.hiddenValues().some((c) => c.length >= 4 && value.includes(c))
      return { field: clean(r?.name || ref, 40) || ref, value: secret ? '••••' : clean(value, 60) }
    })
  }

  /**
   * Runs nobody is watching, or didn't start (routines, helpers, handoffs, apps): no outside click or
   * Enter at all on a page with shopping signs (a cart or checkout address, a total, card fields, items).
   */
  async function commerceGuard(a: Args, ctx: ToolContext, page?: PageCommerce): Promise<void> {
    const target = a.action === 'click' || a.action === 'enter' ? a.ref : undefined
    if (!target) return
    if (a.action === 'click' && clickEffect(b.refInfo(target)) === 'read') return
    const refuse = deps.gate ? deps.gate.refusal(ctx.threadId) : `${PURCHASES_NEED_YOU}: nobody can approve purchases here.`
    if (!refuse) return
    let p = page
    if (!p) { try { p = await b.purchaseContext(target) } catch { p = undefined } }
    const url = p?.url ?? b.pageUrl()
    const shop = isCheckoutUrl(url) || !!p?.total || (p?.payFields ?? 0) > 0 || (p?.items.length ?? 0) > 0 || b.commerce().payFields
    if (shop) throw new Error(`${refuse.split(':')[0]}: this run can't click or submit on a shopping or payment page (${safeHost(url)}) because nobody is here to approve a purchase. Do not retry or work around it. Tell the user what you were about to do so they can do it from a chat they are watching.`)
  }

  /** Re-finds refs that went stale (the page re-rendered) by role and name, once. */
  async function freshRefs(a: Args, notes: string[]): Promise<Args> {
    const fix = async (ref: string): Promise<string> => {
      const r = await b.ensureRef(ref)
      if (r.note) notes.push(r.note)
      return r.ref
    }
    let out = a
    if (a.ref && /^e\d+$/.test(a.ref) && (REF_ACTIONS.has(a.action) || a.action === 'extract')) out = { ...out, ref: await fix(a.ref) }
    if (a.action === 'fill_form') {
      const fields: NonNullable<Args['fields']> = []
      for (const f of a.fields ?? []) fields.push({ ...f, ref: await fix(f.ref) })
      out = { ...out, fields, ...(a.submit_ref ? { submit_ref: await fix(a.submit_ref) } : {}) }
    }
    return out
  }

  /** The purchase signals of an action, read from the live page (its total, card fields, the target's form). */
  async function liveSignals(a: Args): Promise<{ signals: PurchaseSignals; page: PageCommerce } | null> {
    const url = b.pageUrl()
    const tracked = filled.get(b.tabKey())
    const mine = !!tracked?.card && tracked.host === safeHost(url)
    if (a.action === 'fill_payment') return { signals: { kind: 'fill_payment', url }, page: await b.purchaseContext() }
    if (a.action === 'dialog') {
      if (!a.accept || !b.pendingDialog) return null
      const signals: PurchaseSignals = { kind: 'dialog', dialogText: b.pendingDialog.message, url }
      return classifyPurchase(signals).purchase ? { signals, page: await b.purchaseContext() } : null
    }
    if (a.action === 'type' || a.action === 'fill_form') {
      const refs = a.action === 'type' ? [a.ref!] : (a.fields ?? []).filter((f) => f.text !== undefined).map((f) => f.ref)
      if (refs.some((x) => b.refInfo(x)?.payment === 'number')) return { signals: { kind: 'type_card', url }, page: await b.purchaseContext() }
    }
    const target = a.action === 'click' || a.action === 'enter' ? a.ref : a.action === 'fill_form' ? a.submit_ref : a.action === 'type' && a.submit ? a.ref : undefined
    if (!target) return null
    const page = await b.purchaseContext(target)
    const t = page.target
    const r = b.refInfo(target)
    return {
      page,
      signals: {
        kind: a.action === 'type' || a.action === 'enter' ? 'enter' : 'click',
        label: t?.label || r?.name, role: r?.role, url: page.url,
        submit: !!t?.submit, inPayForm: !!t?.inPayForm,
        payFilled: page.payFilled || !!t?.formFilled || mine, payFields: page.payFields > 0,
        hasTotal: !!page.total,
        navLink: t?.navLink ?? r?.navLink
      }
    }
  }

  /**
   * A purchase step: shows the Purchase card (built from the live page and the vault), waits for the
   * user's click, re-reads the page, and runs the action once only if URL, total and target are
   * unchanged. Otherwise it asks again.
   */
  async function gated(a: Args, ctx: ToolContext, page0: PageCommerce | undefined, reasons: string[], expected?: Expected, typed?: PurchaseInfo['typed']): Promise<ToolOutput> {
    const gate = deps.gate
    const refuse = gate ? gate.refusal(ctx.threadId) : `${PURCHASES_NEED_YOU}: purchases can't be approved here. Tell the user what you were about to buy.`
    if (refuse) throw new Error(refuse)
    const target = a.action === 'click' || a.action === 'enter' || (a.action === 'type' && a.submit) ? a.ref : a.action === 'fill_form' ? a.submit_ref : undefined
    const tab = b.tabKey()
    let card: ReturnType<Vault['findCardMeta']>
    if (a.action === 'fill_payment') {
      // Metadata only: nothing is decrypted before the user approves (the vault may still be locked).
      card = vault.findCardMeta(a.card!)
      if (!card) throw new Error(noCard(a.card!))
    }
    let page = page0 ?? (await b.purchaseContext(target))
    let changed = false
    for (let attempt = 0; attempt < 3; attempt++) {
      const info = { ...cardInfo(a, page, reasons, changed, card?.label), ...(typed?.length ? { typed } : {}) }
      if (!info.total) b.showToUser()
      const answer = await gate!.request(ctx.threadId, info, ctx.signal)
      if (answer !== 'approve') {
        const no: ToolOutput = { text: 'The user did not approve this purchase step, so nothing was clicked, filled or sent. Do not retry it or look for another way to buy. Ask what they would like instead.', display: 'purchase not approved' }
        declined.add(no)
        return no
      }
      // A popup or script switched tabs while the card was open: nothing runs on the other tab.
      if (b.tabKey() !== tab) throw new Error('The active tab changed while the Purchase card was open, so nothing was clicked or filled. Snapshot and check the page.')
      // Bound to what the card showed, re-read right before the click: same address, same total, same button.
      const now = await b.purchaseContext(target)
      if (samePurchase(page, now) && b.tabKey() === tab) return run(a, ctx, info, { tab, origin: safeOrigin(now.url) })
      page = now
      changed = true
    }
    throw new Error('The page kept changing (address or total) while waiting for approval, so nothing was bought. Snapshot and check the page.')
  }

  async function run(a: Args, ctx: ToolContext, info: Omit<PurchaseInfo, 'nonce' | 'readyAt' | 'expiresAt'>, expected: Expected): Promise<ToolOutput> {
    // Card details may go to this merchant and payment processors only, for this step.
    b.openPurchaseWindow(expected.origin)
    let out: ToolOutput
    purchaseApproved = true
    try {
      out = await act(a, ctx, expected)
    } finally {
      purchaseApproved = false
      b.closePurchaseWindow()
    }
    // A submitted order consumes the card bookkeeping: the next order fills (and asks) again.
    if (info.step === 'submit') filled.delete(b.tabKey())
    const total = info.total ? ` (total ${info.total.display})` : ''
    return { ...out, text: `The user approved this purchase step on ${info.merchant}${total}.\n${out.text}` }
  }

  function cardInfo(a: Args, page: PageCommerce, reasons: string[], changed: boolean, cardLabel?: string): Omit<PurchaseInfo, 'nonce' | 'readyAt' | 'expiresAt'> {
    const host = safeHost(page.url)
    const tracked = filled.get(b.tabKey())
    const mine = tracked && tracked.host === host ? tracked : undefined
    const label = clean(page.target?.label ?? '', 60)
    const action = a.action === 'fill_payment' ? `Put ${cardLabel} into the payment form`
      : a.action === 'dialog' ? `Answer OK to the page's question "${clean(b.pendingDialog?.message ?? '', 80)}"`
        : (a.action === 'type' && a.submit) || a.action === 'enter' ? 'Press Enter in the form (submits it)'
          : a.action === 'type' || (a.action === 'fill_form' && !a.submit_ref) ? 'Type a card number into the payment form'
            : `Click "${label || 'the button'}"`
    return {
      step: a.action === 'fill_payment' || a.action === 'type' || (a.action === 'fill_form' && !a.submit_ref) ? 'fill' : 'submit',
      merchant: host || 'this page',
      url: page.url,
      secure: page.url.startsWith('https:'),
      action,
      items: page.items.map((i) => ({ name: clean(i.name, 80), price: i.price ? clean(i.price, 24) : undefined })),
      total: page.total,
      payment: cardLabel ?? mine?.card ?? 'Not filled by SahilBot (check the page)',
      shipping: mine?.address ?? 'Not filled by SahilBot (check the page)',
      reasons: reasons.map((r) => clean(r, 120)),
      ...(changed ? { changed: true } : {})
    }
  }

  async function fillOtp(a: Args, ctx: ToolContext, expected?: Expected): Promise<ToolOutput> {
    const url = b.pageUrl()
    // Grants and cards are per origin (scheme + host): http://bank.test is not https://bank.test.
    const site = safeOrigin(url)
    const host = safeHostname(url)
    const source = a.source ?? 'authenticator'
    if (!host || !/^https?:/.test(site)) throw new Error('Open the sign-in page first.')
    const gate = deps.gate
    if (!gate) throw new Error('One-time codes need you: they can\'t be approved here. Ask the user for the code.')
    const tid = ctx.threadId
    // First: may this run use a code at all? (Runs the user didn't start only with a permanent grant.)
    const refuse = gate.otpRefusal(tid, site)
    if (refuse) throw new Error(refuse)
    const canAsk = gate.attended(tid)
    const notAllowed = (): ToolOutput => ({ text: `The user didn't allow a one-time code on ${site}. Ask them to enter it in the browser panel, or continue without signing in.`, display: 'code not allowed' })
    let code: string | null = null
    let from = ''
    if (source === 'authenticator') {
      if (!gate.otpAllowed(tid, site)) {
        if (!canAsk) throw new Error(`One-time codes need you: this run can't ask about ${site}. Tell the user the sign-in needs a code.`)
        const answer = await gate.requestOtp(tid, { site, source, ...(a.secret ? { login: a.secret } : {}) }, ctx.signal)
        if (answer === 'deny') return notAllowed()
      }
      const name = a.secret ?? vault.names().find((n) => originMatches(n.origin, url, { subdomains: !!n.subdomains }))?.name
      if (!name) throw new Error(`No saved login for ${host} has an authenticator key. Ask the user to add one in Settings > Vault, or use source "email" / "sms".`)
      if (!vault.names().some((n) => n.name === name)) throw new Error(`No saved login named "${name}".`)
      await vault.ensureUnlocked(`type a sign-in code for "${name}" on ${host}`, canAsk)
      const cred = vault.credential(name)
      if (!cred) throw new Error(`No saved login named "${name}".`)
      if (!originMatches(cred.origin, url, { subdomains: !!cred.subdomains })) throw new Error(`The login "${name}" is saved for ${cred.origin}, but this page is ${site}. Its codes are only typed on its own site.`)
      let t = vault.totpCode(name)
      if (!t) throw new Error(`The login "${name}" has no authenticator key. Ask the user to add one in Settings > Vault (Authenticator key), or use source "email" / "sms".`)
      // A code about to expire: wait for the next one rather than race the clock.
      if (t.remaining < 5) { await new Promise((r) => setTimeout(r, t!.remaining * 1000 + 300)); t = vault.totpCode(name) ?? t }
      code = t.code
      from = 'the authenticator key saved with that login'
    } else {
      const since = Date.now() - 10 * 60_000
      const getter = source === 'email' ? deps.email && (() => deps.email!(10, host)) : deps.sms && (() => deps.sms!(since))
      if (!getter) throw new Error(`Reading codes from ${source === 'email' ? 'email' : 'text messages'} isn't available on this Mac. Ask the user for the code.`)
      const msgs = await getter()
      // Only a message from the site's own domain (Public Suffix List), or a sender the user confirmed for it.
      const picked = pickCode(msgs, host, since, gate.confirmedSenders(tid, site))
      let use: { code: string; from: string } | null = picked && gate.otpAllowed(tid, site) ? picked : null
      if (!use) {
        const cand = picked ?? codeCandidate(msgs, host, since)
        if (!cand) throw new Error(`No ${source === 'email' ? 'email' : 'text message'} from the last 10 minutes has a code for ${host}. Wait a moment and try again, or ask the user for the code.`)
        if (!canAsk) throw new Error(`One-time codes need you: the newest code isn't from ${host}'s own domain or a sender the user confirmed for it, and nobody is here to check it. Tell the user the sign-in needs a code.`)
        // The card shows who sent it and a snippet (code hidden), so the user can tell a real one from a lookalike.
        const answer = await gate.requestOtp(tid, { site, source, sender: clean(cand.from, 80) || (source === 'sms' ? 'unknown number' : 'unknown sender'), snippet: codeSnippet(cand.text, cand.code), ...(picked ? {} : { unverifiedSender: true }) }, ctx.signal)
        if (answer === 'deny') return notAllowed()
        use = cand
      }
      code = use.code
      from = source === 'email' ? `an email from ${senderDomain(use.from) || use.from.replace(/<.*>/, '').trim().slice(0, 40)}` : `a text message${use.from ? ` from ${use.from.slice(0, 20)}` : ''}`
    }
    const r = await b.fillOtp(code, expected)
    code = null
    if (!r.filled) {
      b.showToUser()
      return { text: `Couldn't find the code field on ${host}. The browser panel is open: call ask_user with "Please enter the sign-in code in the browser panel, then press Done." and options ["Done", "Skip"].`, display: 'code field not found' }
    }
    safeCall(() => vault.recordFill('ok', { item: a.secret ?? source, site, detail: `one-time code from ${source}` }), undefined)
    return { text: `Filled a one-time code from ${from} into ${host}. (The code is hidden from you.) Now submit the form if the page didn't do it by itself.`, display: `code filled on ${host}` }
  }

  function wallet(): ToolOutput {
    const cards = safeCall(() => vault.cardNames(), [])
    const addrs = safeCall(() => vault.addressNames(), [])
    return {
      text: `Saved cards: ${cards.map((c) => c.label).join('; ') || 'none'}.\nSaved addresses: ${addrs.join('; ') || 'none'}.\nUse fill_payment {card} and fill_address {address} with these names. Details stay hidden from you.`,
      display: 'read saved cards and addresses'
    }
  }

  async function act(a: Args, ctx?: ToolContext, expected?: Expected): Promise<ToolOutput> {
    switch (a.action) {
      case 'navigate': {
        const url = safeUrl(a.url!)
        const opened = await b.navigate(url)
        return { text: opened, display: `opened ${safeHost(url)}`, sources: pageSource(b) ?? [{ title: safeHost(url), url }], read: true }
      }
      case 'snapshot':
        return { text: await b.snapshot({ full: !!a.full }), display: `read ${safeHost(b.pageUrl())}`, sources: pageSource(b), read: true }
      case 'find': {
        const q = (a.query ?? a.text ?? '').trim()
        if (!q) throw new Error('Say what to find, e.g. query "the search box".')
        return { text: await b.find(q, { prefer: safeCall(() => deps.sites?.locators(b.pageUrl()) ?? [], []) }), display: `found "${q.slice(0, 30)}"` }
      }
      case 'extract':
        return { text: await b.extract({ kind: a.kind, ref: a.ref, max: a.max }), display: `read data on ${safeHost(b.pageUrl())}`, sources: pageSource(b), read: true }
      case 'expand':
        return { text: b.expand(a.ref!, a.start), display: 'expanded a list' }
      case 'next_page':
        return { text: await b.nextPage(), display: 'found the next page' }
      case 'select': {
        const r = b.refInfo(a.ref!)
        return { text: await b.select(a.ref!, a.option!), display: `chose "${a.option}" in "${(r?.name || a.ref!).slice(0, 30)}"` }
      }
      case 'dialog':
        return { text: await b.answerDialog(!!a.accept, a.text), display: `${a.accept ? 'accepted' : 'dismissed'} a dialog` }
      case 'fill_form': {
        const done: string[] = []
        for (const f of a.fields ?? []) {
          const r = b.refInfo(f.ref)
          const label = (r?.name || f.ref).slice(0, 30)
          if (f.option !== undefined) { await b.select(f.ref, f.option); done.push(`chose "${f.option}" in "${label}"`) }
          else { await b.type(f.ref, f.text ?? ''); done.push(`typed into "${label}"`) }
        }
        const tail = a.submit_ref ? await b.click(a.submit_ref) : await b.snapshot()
        return { text: `${done.join('; ')}.\n${tail}`, display: `filled ${done.length} fields${a.submit_ref ? ' and submitted' : ''}` }
      }
      case 'click': {
        const r = b.refInfo(a.ref!)
        return { text: await b.click(a.ref!), display: `clicked "${(r?.name || a.ref!).slice(0, 40)}"` }
      }
      case 'type': {
        const r = b.refInfo(a.ref!)
        return { text: await b.type(a.ref!, a.text!, a.submit), display: `typed in "${(r?.name || a.ref!).slice(0, 30)}"${a.submit ? ' + Enter' : ''}` }
      }
      case 'enter': {
        const r = b.refInfo(a.ref!)
        return { text: await b.pressEnter(a.ref!), display: `pressed Enter in "${(r?.name || a.ref!).slice(0, 30)}"` }
      }
      case 'fill_secret': {
        const field = a.field ?? 'password'
        const what = field === 'id_number' ? 'document number' : field
        const t = safeCall(() => vault.fillTarget(a.secret!, field), undefined)
        if (!t) {
          const names = vault.names().map((n) => `${n.name} (${n.origin})`).join(', ')
          throw new Error(field === 'id_number'
            ? `No saved ID named "${a.secret}". Ask the user to add it in Settings > Vault > IDs (with this site allowed).`
            : `No saved login named "${a.secret}". Saved logins: ${names || 'none'}. Ask the user to add one in Settings > Vault, or to sign in themselves in the browser panel.`)
        }
        const r = b.refInfo(a.ref!)
        if (!r) throw new Error(`Unknown ref "${a.ref}". Call snapshot again.`)
        const url = b.pageUrl()
        const host = safeHost(url)
        // The tab and site this value may go to: fixed now, so a tab switch while unlocking types nothing.
        const target: Expected = expected ?? { tab: b.tabKey(), origin: safeOrigin(url) }
        const blocked = (msg: string): never => {
          vault.recordFill('blocked', { item: t.name, site: safeOrigin(b.pageUrl()), detail: `${what}: ${msg}` })
          throw new Error(msg)
        }
        // 1. Site, HTTPS and the page the step was approved for (src/main/secure/guards.ts).
        const pre = fillProblem({ origins: t.origins, subdomains: t.subdomains, pageUrl: url, expectedOrigin: expected?.origin, approved: true }, t.name)
        if (pre) blocked(pre.replace(`"${t.name}" is saved for`, `The ${t.type === 'identity' ? 'ID' : 'login'} "${t.name}" is saved for`))
        // 2. The field kind, from the snapshot (checked again in the page right before typing).
        if (field === 'password' && !r.password) blocked(`Element ${a.ref} is not a password field. Passwords only go into password fields.`)
        if (field !== 'password' && (r.password || !['textbox', 'combobox', 'searchbox', 'spinbutton'].includes(r.role) || (field === 'username' && r.role === 'spinbutton'))) blocked(`Element ${a.ref} is not a text field for a ${field === 'username' ? 'username' : 'document number'}.`)
        // 3. The user's approval: the approval card for this exact call, or their standing rule for this site.
        //    Text on a web page can't approve anything: only the user's click or their own rule does.
        const rule = standingRuleAllows(t, t.type, field, url)
        // Auto signs in by itself with a login on that login's own secure site (checked above and here); a saved ID,
        // another site, Ask mode or a run that read outside content still needs the user.
        const own = t.type === 'login' && (field === 'username' || field === 'password') && !!ctx?.autoRun && ownSite(a, url)
        let approved = !!ctx?.approved || rule || own
        const attended = !!ctx && (deps.gate ? deps.gate.attended(ctx.threadId) : false)
        if (!approved && ctx && attended) {
          const answer = await ctx.askUser(`Type your saved ${what} for "${t.name}" into ${host}? SahilBot types it itself; the assistant never sees it.`, ['Allow once', "Don't allow"])
          approved = /^allow/i.test(answer)
        }
        if (!approved) blocked(`You didn't approve typing the saved ${what} for "${t.name}", so nothing was typed. Ask the user, or let them sign in themselves in the browser panel.`)
        // 4. Unlocked (Touch ID or the master password), and re-confirmed for IDs (and passwords, if set).
        await vault.ensureUnlocked(`type your saved ${what} for "${t.name}" on ${host}`, attended)
        if (t.type === 'identity' || (field === 'password' && vault.prefs().reauthPasswords)) {
          await vault.reauth(t.type === 'identity' ? 'identity' : 'password', `type your ${t.type === 'identity' ? 'ID number' : 'password'} for "${t.name}" on ${host}`, attended)
        }
        const again = fillProblem({ origins: t.origins, subdomains: t.subdomains, pageUrl: b.pageUrl(), expectedOrigin: target.origin, approved: true }, t.name)
        if (again) blocked(again)
        // 5. Typed by the browser layer into the verified, focused field (manager.fillSecretValue).
        let value: string | null = vault.fillValue(t.id, field)
        try {
          await b.fillSecretValue(a.ref!, value, target, field)
        } catch (e) {
          blocked((e as Error).message)
        } finally {
          value = null
        }
        vault.recordFill('ok', { item: t.name, site: safeOrigin(url), detail: `${what}${rule && !ctx?.approved ? ' (your standing rule for this site)' : ''}` })
        return { text: `Filled the ${what} for "${t.name}". (The value is hidden from you.)`, display: `filled ${what} for ${t.name}` }
      }
      case 'fill_payment': {
        const meta = vault.findCardMeta(a.card!)
        if (!meta) throw new Error(noCard(a.card!))
        const payUrl = b.pageUrl()
        const payHost = safeHost(payUrl)
        const refuse = (msg: string): never => { vault.recordFill('blocked', { item: meta.label, site: safeOrigin(payUrl), detail: `card: ${msg}` }); throw new Error(msg) }
        // Only inside a step the user approved on the Purchase card, on a secure page of that merchant.
        if (!purchaseApproved) refuse('Card details are only filled during a purchase step the user approved on a Purchase card.')
        if (!isSecurePage(payUrl)) refuse(`This page (${safeOrigin(payUrl)}) isn't secure (not HTTPS), so the card wasn't filled.`)
        const payAttended = !!ctx && (deps.gate ? deps.gate.attended(ctx.threadId) : false)
        await vault.ensureUnlocked(`put ${meta.label} into the payment form on ${payHost}`, payAttended)
        // Re-authentication right before a card goes into a page (Touch ID or the master password).
        await vault.reauth('card', `put ${meta.label} into the payment form on ${payHost}`, payAttended)
        if (expected && expected.origin !== safeOrigin(b.pageUrl())) refuse(`The page changed to ${safeOrigin(b.pageUrl())} since the purchase step was approved for ${expected.origin}, so the card wasn't filled.`)
        const card = vault.findCard(a.card!)
        if (!card) throw new Error(noCard(a.card!))
        const billing = card.billing ? vault.addresses().find((x) => x.id === card.billing) : undefined
        const r = await b.fillCard({ number: card.number, cvc: card.cvc, month: card.expMonth, year: card.expYear, holder: card.holder, brand: card.brand, postal: billing?.postal }, expected)
        if (!r.filled.includes('number')) {
          b.showToUser()
          const where = r.unreachable.length ? ` The card fields seem to be inside a frame from ${r.unreachable.join(', ')}, which SahilBot doesn't type into.` : ''
          return { text: `Couldn't find card fields to fill on ${safeHost(b.pageUrl())}.${where} The browser panel is open: call ask_user with "Please enter your card in the browser panel, then press Done." and options ["Done", "Skip"].`, display: 'card fields not found' }
        }
        const host = safeHost(b.pageUrl())
        const prev = filled.get(b.tabKey())
        filled.set(b.tabKey(), { host, card: card.label, address: prev?.host === host ? prev.address : undefined })
        vault.recordFill('ok', { item: card.label, site: safeOrigin(b.pageUrl()), detail: `card: ${r.filled.join(', ')}` })
        const cvcNote = r.found.includes('cvc') && !r.filled.includes('cvc') ? ' The security code (CVV) isn\'t saved: ask the user to type it in the browser panel before placing the order.' : ''
        const billNote = billing ? ` Its billing address is saved as "${billing.nickname}" (fill_address with section "billing" if the form asks).` : ''
        return { text: `Filled ${card.label}: ${r.filled.join(', ')}. (The card details are hidden from you.)${cvcNote}${billNote}`, display: `filled ${card.label}` }
      }
      case 'fill_address': {
        const known = vault.addressNames().some((n) => n.toLowerCase() === String(a.address ?? '').trim().toLowerCase()) || vault.addresses().some((x) => x.id === a.address)
        if (known) await vault.ensureUnlocked(`fill your saved address "${a.address}" on ${safeHost(b.pageUrl())}`, !!ctx && (deps.gate ? deps.gate.attended(ctx.threadId) : false))
        const addr = vault.findAddress(a.address!)
        if (!addr) throw new Error(`No saved address named "${a.address}". Saved addresses: ${vault.addressNames().join(', ') || 'none'}. Ask the user to add one in Settings > Vault > Addresses.`)
        const section = a.section ?? 'shipping'
        const r = await b.fillAddress(addr, section, expected)
        if (r.filled.length) safeCall(() => vault.recordFill('ok', { item: addr.nickname, site: safeOrigin(b.pageUrl()), detail: `${section} address` }), undefined)
        if (!r.filled.length) throw new Error(`Couldn't find ${section} address fields on this page. Snapshot and fill them with type or fill_form instead.`)
        const host = safeHost(b.pageUrl())
        if (section === 'shipping') {
          const prev = filled.get(b.tabKey())
          filled.set(b.tabKey(), { host, card: prev?.host === host ? prev.card : undefined, address: addr.nickname })
        }
        return { text: `Filled the ${section} address "${addr.nickname}": ${r.filled.join(', ')}. Snapshot to check the fields.`, display: `filled address ${addr.nickname}` }
      }
      case 'upload': {
        if (!ctx) throw new Error('Uploads need a chat.')
        const files = (a.paths ?? []).map((p) => {
          const full = resolvePath(p, ctx.workspaceDir, ctx.state.roots ?? [])
          let st
          try { st = statSync(full) } catch { throw new Error(`"${p}" doesn't exist.`) }
          if (!st.isFile()) throw new Error(`"${p}" is not a file.`)
          return full
        })
        return { text: await b.upload(a.ref!, files), display: `uploaded ${files.length} file${files.length === 1 ? '' : 's'}` }
      }
      case 'downloads': {
        const list = b.offeredDownloads()
        if (a.op === 'save') {
          if (!ctx) throw new Error('Saving needs a chat.')
          const decision = downloads.get(a)
          if (!decision) throw new Error('List the available downloads and choose one to save.')
          const r = await b.saveDownload((a.index ?? 1) - 1, join(ctx.workspaceDir, 'Downloads'), { ...decision, signal: ctx.signal })
          if (r.state !== 'completed') throw new Error(`The download ${r.state}.`)
          return { text: `Saved to ${r.path}.`, display: 'saved a download', path: r.path }
        }
        return { text: list.length ? list.map((d, i) => `${i + 1}. "${d.filename}" from ${d.host}${d.size > 0 ? `, ${Math.round(d.size / 1024)} KB` : ''}`).join('\n') : 'No downloads were offered.', display: 'listed downloads' }
      }
      case 'wait':
        return { text: await b.waitFor({ text: a.text, url: a.url, timeoutMs: Math.round((a.timeout ?? 10) * 1000) }), display: 'waited' }
      case 'wait_for_signin': {
        if (!(await b.signInShown())) return { text: 'No sign-in form is showing on this page. Take a snapshot and continue.', display: 'no sign-in needed' }
        b.showToUser()
        const question = `Please sign in on ${safeHost(b.pageUrl()) || 'this page'} in the browser panel. SahilBot continues by itself once you're signed in.`
        if (!ctx) throw new Error('wait_for_signin needs a chat to wait in.')
        const answer = ctx.waitForUser ? await ctx.waitForUser(question, async () => !(await b.signInShown()), { options: ['Done', 'Skip'] }) : await ctx.askUser(question, ['Done', 'Skip'])
        if (/^done/i.test(answer) && !(await b.signInShown())) return { text: 'The user signed in. Take a snapshot and continue the task.', display: 'you signed in' }
        if (/^skip/i.test(answer)) return { text: 'The user skipped signing in. Continue with what you can do without it and say what needed the sign-in.', display: 'sign-in skipped' }
        return { text: 'The sign-in form is still showing. Continue with what you can do and tell the user this site still needs them to sign in.', display: 'still waiting for sign-in' }
      }
      case 'scroll':
        if (a.ref) return { text: await b.scrollTo(a.ref), display: 'scrolled into view' }
        return { text: await b.scroll(a.direction ?? 'down', a.amount), display: `scrolled ${a.direction ?? 'down'}` }
      case 'key':
        if (!a.keys?.trim()) throw new Error('key needs keys, e.g. "Escape" or "ArrowDown".')
        return { text: await b.pressKeys(a.keys, a.ref), display: `pressed ${a.keys.trim().slice(0, 30)}` }
      case 'back': case 'forward':
        return { text: await b.go(a.action), display: `went ${a.action}` }
      case 'hover':
        if (!a.ref) throw new Error('hover needs a ref.')
        return { text: await b.hover(a.ref), display: 'hovered' }
      case 'screenshot': {
        const img = await b.screenshot()
        return { text: `Screenshot of ${b.pageUrl()}`, images: [img], display: `screenshot of ${safeHost(b.pageUrl())}` }
      }
      case 'get_text':
        return { text: await b.getText(), display: `read text of ${safeHost(b.pageUrl())}`, sources: pageSource(b), read: true }
      case 'tabs': {
        if (a.op === 'new') {
          const url = a.url ? safeUrl(a.url) : undefined
          await b.control(async () => b.newTab(url))
          return { text: `Opened a new tab.${url ? ` Loading ${url}.` : ''}\n${b.listTabs()}`, display: 'new tab' }
        }
        // A tab by part of its title or address (text), or by number.
        const pick = (): number => {
          if (!a.text) return (a.index ?? (a.op === 'close' ? b.state().active + 1 : 1)) - 1
          const i = b.tabMatching(a.text)
          if (i < 0) throw new Error(`No tab's title or address contains "${a.text}". Open tabs:\n${b.listTabs()}`)
          return i
        }
        // The bot's own tab changes aren't part of a lesson being recorded.
        if (a.op === 'switch') { const i = pick(); quietly(() => b.switchTab(i)); return { text: `Switched to tab ${i + 1}. Snapshot to see it.\n${b.listTabs()}`, display: `tab ${i + 1}` } }
        if (a.op === 'close') { const i = pick(); quietly(() => b.closeTab(i)); return { text: b.listTabs(), display: 'closed tab' } }
        return { text: b.listTabs(), display: 'listed tabs' }
      }
      default:
        return { text: `Unknown action ${a.action}.`, display: 'unknown action' }
    }
  }

  function noCard(name: string): string {
    const names = safeCall(() => vault.cardNames().map((c) => c.label), [] as string[])
    return `No saved card "${name}". Saved cards: ${names.join(', ') || 'none'}. Ask the user to add one in Settings > Vault > Cards, or to enter it themselves in the browser panel.`
  }

  function quietly(fn: () => void): void {
    b.teach.hold()
    try { fn() } finally { b.teach.release() }
  }

  async function recording(a: Args, threadId?: string): Promise<ToolOutput> {
    const st = b.teach.state()
    if (a.op === 'start') {
      if (st?.status === 'recording') return { text: `Already recording (${st.steps} steps so far, started by ${st.by === 'user' ? 'the user' : 'you'}). Call recording op=stop when the user is done.`, display: 'already recording' }
      await b.teachStart('agent', { name: a.text?.slice(0, 80), threadId })
      b.showToUser()
      return {
        text: `Recording started (up to ${MAX_MS / 60_000} minutes or ${MAX_STEPS} steps). The browser panel is open with a red Teach bar.\nTell the user: "Show me once: do the task in the browser panel, then press Done in the Teach bar." Then end your turn: their recorded steps arrive as their next message. If they tell you in chat that they're done instead, call recording op=stop to get the steps. Don't use the browser yourself while they record.`,
        display: 'recording your steps'
      }
    }
    if (a.op === 'stop') {
      if (!st) return { text: 'Nothing is being recorded. Start with recording op=start.', display: 'not recording' }
      if (st.by === 'user') return { text: `The user is recording a lesson themselves (${st.steps} steps so far). They'll press Done in the Teach bar and send it to you; don't stop it.`, display: 'user is recording' }
      const steps = b.teachSteps()
      b.teachCancel()
      // What the user showed also teaches the site's playbook.
      if (steps.length) safeCall(() => deps.sites?.learnTeach(steps, st.name), [])
      if (!steps.length) return { text: 'Recording stopped. No steps were captured: ask the user to try again in the browser panel.', display: 'no steps recorded' }
      const secrets = steps.some((x) => x.secret)
      return {
        text: `Recording stopped: ${steps.length} step${steps.length === 1 ? '' : 's'}${st.limit ? ` (stopped at the ${st.limit === 'time' ? 'time' : 'step'} limit)` : ''}.\n${stepsToText(steps)}\n\nDetails (selector hints are for cross-checking; act by snapshot refs):\n${stepDetails(steps)}${secrets ? `\n\nValues shown as ${SECRET} were hidden on purpose: never put them in a skill; use fill_secret with a saved login, or ask the user.` : ''}`,
        display: `recorded ${steps.length} steps`
      }
    }
    if (!st) return { text: 'Not recording.', display: 'not recording' }
    const latest = st.recent.length ? `\nLatest:\n${st.recent.map((r) => `- ${r}`).join('\n')}` : ''
    return { text: `${st.status === 'recording' ? 'Recording' : 'Stopped'} (started by ${st.by === 'user' ? 'the user' : 'you'}): ${st.steps} steps, ${Math.round(((st.stoppedAt ?? Date.now()) - st.startedAt) / 1000)}s.${latest}`, display: 'checked recording' }
  }
}

/** Same page, same total, same target: the approval still describes what will happen. */
export function samePurchase(a: Pick<PageCommerce, 'url' | 'total' | 'target'>, b: Pick<PageCommerce, 'url' | 'total' | 'target'>): boolean {
  if (a.url !== b.url) return false
  const t = (x: PageCommerce['total']): string => (x ? `${x.currency}:${x.amount.toFixed(2)}` : 'none')
  if (t(a.total) !== t(b.total)) return false
  return (a.target?.label ?? '') === (b.target?.label ?? '')
}

function safeCall<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}
/** Steps that act on a site for the user (typing, filling, signing in): a human check after them is theirs to pass. */
const ACTING = new Set(['type', 'fill_form', 'fill_secret', 'fill_payment', 'fill_address', 'fill_otp', 'wait_for_signin', 'upload', 'select'])
/** A click that signs in, registers, books or buys. */
const ACTING_CLICK = /\b(sign ?in|log ?in|sign ?up|register|check ?out|buy|pay|place order|add to (cart|bag|basket)|book|reserve|submit|continue to (payment|checkout))\b/i

function safeHost(u: string): string {
  try { return new URL(u).host } catch { return u.slice(0, 40) }
}
function safeHostname(u: string): string {
  try { return new URL(u).hostname } catch { return '' }
}
function safeOrigin(u: string): string {
  try { return new URL(u).origin } catch { return u }
}

/** The page the browser is on, as a source the answer can show under it (web pages only, with their title). */
function pageSource(b: { pageUrl(): string; pageTitle?: () => string }): Array<{ title: string; url: string }> | undefined {
  let url = ''
  try { url = b.pageUrl() } catch { return undefined }
  if (!/^https?:\/\//i.test(url)) return undefined
  let title = ''
  try { title = (b.pageTitle?.() ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) } catch { /* no title */ }
  return [{ title: title || safeHost(url), url }]
}
