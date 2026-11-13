import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { ChatEvent, OtpInfo, PendingRequest, PurchaseInfo } from '@shared/types'
import { senderKey as senderKeyOf } from '../otp'

/**
 * Purchases in the built-in browser.
 *
 * A purchase step is any action that would place an order or pay: clicking Place order / Buy now / Pay,
 * submitting a form that holds card details, accepting a payment dialog, or putting a saved card into a
 * page. Each one waits for a NEW click on a Purchase card that main builds from the live page (merchant
 * = the page's host, total and items parsed from the page, card and address = vault nicknames). Nothing
 * the model writes reaches that card, and nothing can pre-approve it: not Bypass, not "Always allow",
 * not an Allow rule, not the hard-stops setting. Runs with nobody watching (routines, helper agents,
 * another bot's handoff) are refused outright. An approval is single-use and bound to the page URL, the
 * total and the element: if any of them changed by the time the click runs, the card asks again.
 */

// ------------------------------------------------------------------ money

export interface Money { amount: number; currency: string; display: string }

const SYMBOLS: Array<[string, string]> = [
  ['US$', 'USD'], ['CA$', 'CAD'], ['C$', 'CAD'], ['AU$', 'AUD'], ['A$', 'AUD'], ['NZ$', 'NZD'], ['HK$', 'HKD'], ['S$', 'SGD'],
  ['R$', 'BRL'], ['MX$', 'MXN'], ['CN¥', 'CNY'], ['Fr.', 'CHF'], ['zł', 'PLN'], ['kr', 'SEK'], ['Rs.', 'INR'], ['Rs', 'INR'],
  ['$', 'USD'], ['€', 'EUR'], ['£', 'GBP'], ['¥', 'JPY'], ['₹', 'INR'], ['₩', 'KRW'], ['₽', 'RUB'], ['₺', 'TRY'], ['₪', 'ILS'],
  ['₫', 'VND'], ['฿', 'THB'], ['₱', 'PHP'], ['元', 'CNY']
]
const CODES = 'USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|RMB|INR|BRL|MXN|SEK|NOK|DKK|PLN|NZD|SGD|HKD|KRW|ZAR|TRY|ILS|AED|SAR|CZK|HUF|RON|THB|PHP|IDR|MYR|TWD|VND|RUB'
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'IDR', 'HUF', 'TWD'])
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SYM = SYMBOLS.map(([s]) => esc(s)).join('|')
// After the number only symbols that are written there ("12,50 €", "100 kr"); never "$", so "× 2 $24" isn't "2 $".
const POST_SYM = SYMBOLS.filter(([s]) => !s.includes('$') && s !== 'Rs' && s !== 'Rs.').map(([s]) => esc(s)).join('|')
const NUM = String.raw`\d{1,3}(?:[.,'   ]\d{2,3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`
// Currency before ("$1,234.56", "USD 12", "€ 9,99") or after ("12,50 €", "1.234,56 EUR", "100 kr").
const MONEY = new RegExp(String.raw`(?:(?<pre>${SYM}|\b(?:${CODES})\b)\s?(?<n1>-?(?:${NUM}))|(?<n2>-?(?:${NUM}))\s?(?<post>${POST_SYM}|\b(?:${CODES})\b))`, 'g')

/** "1,234.56" / "1.234,56" / "1 234,56" / "1'234.50" / "₹1,23,456.00" → a number. */
export function parseAmount(raw: string, currency?: string): number | null {
  let s = raw.replace(/[  ' ]/g, '')
  const neg = s.startsWith('-')
  s = s.replace(/^-/, '')
  const dots = (s.match(/\./g) ?? []).length
  const commas = (s.match(/,/g) ?? []).length
  if (dots && commas) {
    // The last separator is the decimal one.
    if (s.lastIndexOf('.') > s.lastIndexOf(',')) s = s.replace(/,/g, '')
    else s = s.replace(/\./g, '').replace(',', '.')
  } else if (commas) {
    const tail = s.split(',').at(-1)!
    s = commas === 1 && tail.length <= 2 && !ZERO_DECIMAL.has(currency ?? '') ? s.replace(',', '.') : s.replace(/,/g, '')
  } else if (dots) {
    const tail = s.split('.').at(-1)!
    if (dots > 1 || (tail.length === 3 && (ZERO_DECIMAL.has(currency ?? '') || currency === 'EUR'))) s = s.replace(/\./g, '')
  }
  const n = Number(s)
  return Number.isFinite(n) ? (neg ? -n : n) : null
}

function currencyOf(token: string): string {
  const t = token.trim()
  if (/^[A-Z]{3}$/i.test(t)) return t.toUpperCase() === 'RMB' ? 'CNY' : t.toUpperCase()
  return SYMBOLS.find(([s]) => s === t)?.[1] ?? 'USD'
}

/** Every amount of money in a text, in order. */
export function findMoney(text: string): Array<Money & { index: number }> {
  const out: Array<Money & { index: number }> = []
  for (const m of String(text ?? '').matchAll(MONEY)) {
    const g = m.groups ?? {}
    const cur = currencyOf((g.pre ?? g.post ?? '$') as string)
    const amount = parseAmount((g.n1 ?? g.n2) as string, cur)
    if (amount === null) continue
    out.push({ amount, currency: cur, display: m[0].replace(/\s+/g, ' ').trim(), index: m.index ?? 0 })
  }
  return out
}

export function parseMoney(text: string): Money | null {
  const m = findMoney(text)[0]
  return m ? { amount: m.amount, currency: m.currency, display: m.display } : null
}

const TOTAL_STRONG = /\b(grand total|order total|total due|amount due|total to pay|you(?:'ll| will)? pay|total payable|balance due|amount to pay|total charge|estimated total|total \(\w{3}\)|payment total|total price)\b/i
const TOTAL_WORD = /\btotal\b/i
const NOT_TOTAL = /\b(sub-?total|total savings|you save|total items|items? total|before tax|total discount|total weight|merchandise total)\b/i

/**
 * The order total from candidate rows the page script found ({label, text}), plus the clicked button's
 * own label ("Pay $42.10"). Strongest label wins ("Order total" over "Total"); ties go to the last one
 * on the page (the bottom of an order summary). Null when nothing looks like a total.
 */
export function pickTotal(cands: Array<{ label: string; text: string }>, button?: string): Money | null {
  const scored: Array<{ w: number; i: number; m: Money }> = []
  cands.forEach((c, i) => {
    const label = String(c.label ?? '')
    if (NOT_TOTAL.test(label) && !TOTAL_STRONG.test(label)) return
    const w = TOTAL_STRONG.test(label) ? 3 : /^\s*total\b/i.test(label) ? 2 : TOTAL_WORD.test(label) ? 1 : 0
    if (!w) return
    const text = String(c.text ?? '')
    // The amount after the label ("Total $42.10"), else the last one before it ("$42.10 total").
    const lower = text.toLowerCase()
    const key = (TOTAL_STRONG.exec(text)?.[0] ?? 'total').toLowerCase()
    const at = lower.lastIndexOf(key)
    const all = findMoney(text)
    const after = all.find((m) => m.index >= at + key.length - 1)
    const pick = after ?? [...all].reverse().find((m) => m.index < at) ?? all.at(-1)
    if (pick && pick.amount >= 0) scored.push({ w, i, m: { amount: pick.amount, currency: pick.currency, display: pick.display } })
  })
  if (button) {
    const m = parseMoney(button)
    if (m && m.amount > 0) scored.push({ w: 2.5, i: cands.length, m })
  }
  if (!scored.length) return null
  scored.sort((a, b) => b.w - a.w || b.i - a.i)
  return scored[0].m
}

/** "$42.10" from an item row's text, and the rest as its name. */
export function splitItem(text: string): { name: string; price?: string } {
  const t = clean(text, 160)
  const m = findMoney(t).at(-1)
  if (!m) return { name: t.slice(0, 80) }
  const name = (t.slice(0, m.index) + t.slice(m.index + m.display.length)).replace(/\s+/g, ' ').replace(/[\s·•|:–—-]+$/, '').trim()
  return { name: name.slice(0, 80) || 'Item', price: m.display }
}

// ------------------------------------------------------------------ what counts as a purchase

/** Labels that place an order or pay, wherever they appear. */
const STRONG = /^(place (?:my |your |the )?order|place order and pay|buy\b|purchase\b|pay\b|order now|pre-?order|donate\b|rent now|checkout and pay|proceed to pay(?:ment)?\b|make (?:a )?payment|authori[sz]e (?:the )?payment|submit (?:my |your )?(?:order|payment)|complete (?:my |your |the )?(?:purchase|order|payment|checkout|booking|transaction)|confirm (?:and|&) (?:pay|buy|purchase|order)|confirm (?:my |your |the )?(?:payment|purchase|order|booking|subscription|swap|transfer|trade|withdrawal|deposit|bet|send)|(?:1|one)-?click (?:buy|purchase|order)|book and pay|reserve and pay|subscribe and pay|swap now|send (?:money|payment|funds)|transfer (?:money|funds|now)|tip\b|top ?up\b|add (?:funds|money)\b|place (?:a )?(?:bet|wager)|deposit\b)|\b(place (?:your )?order|buy now|buy it now|pay now|complete (?:your )?purchase|(?:buy|order) with 1-?click)\b/i
/**
 * The same in other languages (de, fr, es, it, nl, pt, ru, pl, sv, tr). Whole words only, so "Weiter
 * einkaufen" (continue shopping) and "Ordina per prezzo" (sort by price) don't count.
 */
const MULTI_STRONG = /(?:^|[^\p{L}])(jetzt kaufen|kaufen|bestellen|zahlungspflichtig bestellen|kostenpflichtig bestellen|jetzt bezahlen|bezahlen|zahlen|kauf abschlie(?:ß|ss)en|bestellung (?:abschicken|absenden|aufgeben)|acheter|commander|payer|passer (?:la )?commande|valider (?:la |ma )?commande|confirmer (?:la commande|le paiement|l'achat)|comprar|pagar|finalizar (?:compra|pedido)|realizar pedido|tramitar pedido|confirmar (?:compra|pedido|pago|pagamento)|fazer pedido|acquista|compra ora|ordina(?! per)|paga|conferma (?:ordine|acquisto|pagamento)|procedi al pagamento|kopen|koop nu|betalen|bestelling plaatsen|afrekenen|купить|оплатить|заказать|kup teraz|zapłać|kupuję|zamawiam|köp|betala|satın al|öde)(?=$|[^\p{L}])/iu
/** Japanese, Chinese and Korean buy / order / pay words (not "order history" or "payment method"). */
const CJK_STRONG = /(購入|注文|支払|決済|购买|購買|支付|下单|下單|付款|结算|結帳|结账|提交订单|구매|결제|주문)(?!履歴|历史|歷史|記錄|记录|履歷|내역|方法|情報|信息|資訊|방법|정보)/u
/** Labels that commit to a charge when the page is a checkout or holds payment details. */
const CONTEXT = /^(subscribe\b|start (?:my |your |a |the |free )?(?:subscription|membership|trial|free trial|plan)|start trial|try (?:it )?free|upgrade\b|join now|book(?: now)?$|reserve(?: now)?$|renew\b|activate (?:subscription|plan|membership)|get$|install$|finalizar$|finish order|confirm$)/i
/** Generic submit labels: a purchase on a checkout page (or once card details are on the page). */
const WEAK = /^(continue|next|submit|confirm|review|proceed|done|finish|save|ok|go|checkout|check out|complete|send|weiter|continuer|continuar|continua|doorgaan|volgende|suivant|siguiente|avanti)\b/i
/** Never a purchase on their own. */
const NOT_PURCHASE = /^(add to (?:cart|bag|basket|wish ?list|list)|view (?:cart|bag|basket)|edit|change|remove|delete|update (?:cart|quantity)|apply(?: (?:coupon|code|promo|discount|gift card))?|continue shopping|back\b|cancel|save for later|sign in|log in|create account|show|hide|close|use (?:a )?different|add (?:a )?(?:new )?(?:card|address|payment method)|select|choose|learn more|details)\b/i
const CHECKOUT_URL = /\/(checkouts?|check-out|payments?|pay|billing|purchases?|orders?|carts?|basket|bag|subscribe|subscriptions?|upgrade|donate|donations?|bookings?|buy|plans?|pricing|spc)(\b|[/_?#-]|$)/i
/** Pages that move money or assets: wallets, swaps, transfers, exchanges, betting. */
const FINANCE_URL = /(^|[./-])(wallet|swap|send|transfer|bridge|stake|exchange|trade|trading|crypto|remit|payout|withdraw|deposit|bet|casino)([./?#-]|$)/i
const FINANCE_ACT = /^(send|confirm|swap|transfer|bridge|stake|withdraw|deposit|sell|trade|approve|sign|bet)\b/i
/** App and extension stores, where "Get" or "Install" can start a purchase. */
const STORE_HOST = /(^|\.)(apps?|store|play|marketplace)\./i
const PAY_DIALOG = /\b(pay|payment|purchase|buy|order|charge|charged|subscribe|subscription|checkout|billing)\b|[$€£¥₹]\s?\d/i

export interface PurchaseSignals {
  kind: 'click' | 'enter' | 'dialog' | 'fill_payment' | 'type_card'
  label?: string
  role?: string
  url?: string
  /** The target submits a form (submit button, Enter in a field). */
  submit?: boolean
  /** The target's form holds card fields (or a payment-processor frame). */
  inPayForm?: boolean
  /** Card details are already in the page (or SahilBot filled a card into this tab). */
  payFilled?: boolean
  /** The page has card fields at all. */
  payFields?: boolean
  /** The page shows an order total (or the target names an amount). */
  hasTotal?: boolean
  /**
   * For links: true only for a real <a href> to another http(s) page (plain navigation); false for
   * "#", "javascript:", role=link on something that isn't an <a>, and links to the same page.
   */
  navLink?: boolean
  dialogText?: string
}

export function isCheckoutUrl(url?: string): boolean {
  try { const u = new URL(url ?? ''); return CHECKOUT_URL.test(u.pathname + (u.hash || '')) } catch { return false }
}

/** A page that moves money or assets (wallet, swap, transfer, exchange). */
export function isFinanceUrl(url?: string): boolean {
  try { const u = new URL(url ?? ''); return FINANCE_URL.test(u.hostname) || FINANCE_URL.test(u.pathname) } catch { return false }
}

/** Purchase or payment wording in any supported language. */
export function purchaseWording(label?: string): boolean {
  const l = clean(label ?? '', 120)
  return !!l && (STRONG.test(l) || MULTI_STRONG.test(l) || CJK_STRONG.test(l))
}

/** The label names an amount of money ("Tip $20", "Pay €12,50", "¥1,200で購入"). */
export function labelHasPrice(label?: string): boolean {
  return findMoney(clean(label ?? '', 120)).some((m) => m.amount > 0)
}

/** Clearly harmless click labels (no outside effect worth asking about). */
const BENIGN_CLICK = /^(add to (?:cart|bag|basket|wish ?list|list)|view (?:cart|bag|basket|details|more|all)|continue shopping|sign in|log in|login|next|previous|prev|back|search|go|more|show|hide|expand|collapse|close|cancel|menu|filter|sort|open|view|load more|see (?:all|more)|read more|learn more|details|accept(?: all)?(?: cookies)?|reject(?: all)?(?: cookies)?|dismiss|ok|got it|skip|toggle|play|pause|zoom|×|x|edit|select|choose|apply(?: filters?)?|clear(?: filters?)?|home|help|settings|profile|account|sign up|register|create account|forgot password\??|show password|hide password)$/i

/** A click whose label clearly has no outside consequence (no money, no sending, no commitment). */
export function benignClickLabel(label?: string): boolean {
  const l = clean(label ?? '', 120)
  if (!l || purchaseWording(l) || labelHasPrice(l)) return false
  return BENIGN_CLICK.test(l)
}

/** Whether an action is a purchase step, and why (in words for the card). */
export function classifyPurchase(s: PurchaseSignals): { purchase: boolean; reasons: string[] } {
  const label = clean(s.label ?? '', 120)
  const no = { purchase: false, reasons: [] as string[] }
  const yes = (r: string): { purchase: boolean; reasons: string[] } => ({ purchase: true, reasons: [r] })
  if (s.kind === 'fill_payment') return yes('Puts a saved card into the page')
  if (s.kind === 'type_card') return yes('Types a card number into a payment field')
  if (s.kind === 'dialog') return PAY_DIALOG.test(s.dialogText ?? '') ? yes('Confirms a payment dialog on the page') : no
  const context = !!(s.payFields || s.payFilled || s.hasTotal || isCheckoutUrl(s.url))
  const finance = isFinanceUrl(s.url)
  let store = false
  try { store = STORE_HOST.test(new URL(s.url ?? '').hostname) } catch { /* no url */ }
  const strong = purchaseWording(label)
  const price = labelHasPrice(label)
  // "Add to cart", "Apply coupon"…: not a purchase, unless it names an amount on a checkout page.
  if (label && NOT_PURCHASE.test(label) && !strong && !(price && context)) return no
  // Links get no exemption: "Buy now" is a purchase whether it's a <button> or an <a>.
  if (strong) return yes(`"${label.slice(0, 60)}" places an order or pays`)
  if (price) return yes(`"${label.slice(0, 60)}" names an amount of money`)
  if (label && CONTEXT.test(label) && (context || finance || store)) return yes(`"${label.slice(0, 60)}" on a checkout page`)
  if (label && finance && FINANCE_ACT.test(label)) return yes(`"${label.slice(0, 60)}" on a page that moves money`)
  if (s.payFilled && (s.submit || s.inPayForm || s.kind === 'enter' || (label && WEAK.test(label)))) return yes('Submits a form that holds card details')
  if (context) {
    const link = s.role === 'link'
    if (s.kind === 'enter') return yes('Presses Enter in a form on a checkout page')
    if (s.submit) return yes('Submits a form on a checkout page')
    if (!label) return yes('An unlabeled (icon) button on a checkout page')
    if (link && s.navLink === true) return no
    if (WEAK.test(label)) return yes(`"${label.slice(0, 60)}" on a checkout page`)
    if (link && s.navLink === false) return yes(`"${label.slice(0, 60)}" (a link that acts like a button) on a checkout page`)
  }
  return no
}

// ------------------------------------------------------------------ redaction

/**
 * Hides saved card numbers in any text (snapshots, page text, tool results): "4242 4242 4242 4242",
 * "4242-4242-…" and "4242424242424242" all become "•••• 4242".
 */
export function redactCards(text: string, numbers: string[]): string {
  let out = String(text ?? '')
  for (const n of numbers) {
    const d = n.replace(/\D/g, '')
    if (d.length < 12) continue
    const re = new RegExp(d.split('').join('[\\s.\\-\\u00a0]?'), 'g')
    out = out.replace(re, `•••• ${d.slice(-4)}`)
  }
  return out
}

/** Page text for the card: no control or direction-override characters (spoofing), one line, capped. */
export function clean(s: string, max = 80): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

// ------------------------------------------------------------------ payment processors

/** Hosts whose card iframes SahilBot may type into (they're where the card is meant to go). */
export const PROCESSOR_HOST = /(^|\.)(stripe\.com|stripe\.network|braintreegateway\.com|braintree-api\.com|adyen\.com|adyenpayments\.com|checkout\.com|squareup\.com|squarecdn\.com|authorize\.net|recurly\.com|chargebee\.com|spreedly\.com|paddle\.com|shopifycs\.com|shopifyinc\.com|worldpay\.com|cybersource\.com|globalpay\.com|globalpayments\.com|paypal\.com|klarna\.com|mollie\.com|razorpay\.com|bluesnap\.com|2checkout\.com|nmi\.com|cardinalcommerce\.com|chase\.com|paymentus\.com|fiserv\.com|clover\.com|payfort\.com|checkoutshopper-live\.adyen\.com)$/i

export function isProcessorHost(host: string): boolean {
  return PROCESSOR_HOST.test(String(host ?? '').toLowerCase())
}

// ------------------------------------------------------------------ page scripts

/**
 * Helpers every page script shares: deep queries through open shadow roots, visibility, a field's
 * label text, and what kind of card or address field an element is.
 */
export const PAGE_LIB = String.raw`
const deepAll = (root, sel) => {
  const out = []
  const visit = (r) => {
    try { r.querySelectorAll(sel).forEach((e) => out.push(e)) } catch (e) {}
    try { r.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) visit(el.shadowRoot) }) } catch (e) {}
  }
  visit(root)
  return out
}
const shown = (el) => {
  if (!el || !el.isConnected || el.type === 'hidden') return false
  if (!el.getClientRects().length) return false
  const st = getComputedStyle(el)
  return st.visibility !== 'hidden' && st.display !== 'none'
}
const labelText = (el) => {
  let t = ''
  try { if (el.labels) for (const l of el.labels) t += ' ' + l.innerText } catch (e) {}
  const ids = el.getAttribute('aria-labelledby')
  if (ids) for (const id of ids.split(/\s+/)) { const root = el.getRootNode(); const x = root.getElementById ? root.getElementById(id) : document.getElementById(id); if (x) t += ' ' + x.innerText }
  return t
}
const hintOf = (el) => [el.name, el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('data-fieldtype'), el.getAttribute('data-elements-stable-field-name'), el.getAttribute('autocomplete'), el.title, labelText(el)]
  .filter(Boolean).join(' ').toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ')
const ccKind = (el, proc) => {
  if (!el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return null
  const type = (el.type || '').toLowerCase()
  if (/^(hidden|submit|button|checkbox|radio|image|file|reset|password|email)$/.test(type)) return null
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase()
  const m = /\bcc-(number|csc|exp-month|exp-year|exp|name|given-name|family-name|type)\b/.exec(ac)
  if (m) return { 'number': 'number', 'csc': 'cvc', 'exp-month': 'month', 'exp-year': 'year', 'exp': 'exp', 'name': 'name', 'given-name': 'given', 'family-name': 'family', 'type': 'type' }[m[1]]
  if (/\b(shipping|billing|street|address|postal|country|tel|email|organization|given-name|family-name|one-time-code|username)\b/.test(ac)) return null
  const h = hintOf(el)
  if (/one ?time|\botp\b|2fa|two ?factor|sign ?in code|login code|code we sent|sent (you )?a code/.test(h)) return null
  if (/name on card|card ?holder|holder ?name|\bcc ?name|nameoncard|card name/.test(h)) return 'name'
  if (/\bcvc|\bcvv|\bcsc\b|\bcvn\b|security ?code|card ?code|verification ?(value|number)|encryptedsecuritycode|card ?verification/.test(h)) return 'cvc'
  if (/(exp|expir)\w*\s*(date\s*)?month|\bcc ?month|card ?month|^\s*mm\s*$|exp ?mm\b/.test(h)) return 'month'
  if (/(exp|expir)\w*\s*(date\s*)?year|\bcc ?year|card ?year|^\s*yy(yy)?\s*$|exp ?yy/.test(h)) return 'year'
  if (/\bexp(iry|iration|ires)?\b|\bexp date|mm ?\/ ?yy|valid ?(thru|through|until)|encryptedexpirydate/.test(h)) return 'exp'
  if (/card ?num|\bcc ?num|cardnumber|credit ?card|debit ?card|card ?no\b|encryptedcardnumber|\bpan\b|number on (the )?card/.test(h)) return 'number'
  if (proc && /^(number|card|ccnumber|pan|cc)$/.test(String(el.name || el.id || '').toLowerCase())) return 'number'
  if (proc && /postal|zip/.test(h)) return 'postal'
  return null
}
const addrKind = (el) => {
  if (!el || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return null
  const type = (el.type || '').toLowerCase()
  if (/^(hidden|submit|button|checkbox|radio|image|file|reset|password)$/.test(type)) return null
  if (ccKind(el, false)) return null
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase()
  const m = /\b(name|given-name|additional-name|family-name|organization|street-address|address-line1|address-line2|address-line3|address-level1|address-level2|postal-code|country|country-name|tel|tel-national|email)\b/.exec(ac)
  if (m) return { 'name': 'name', 'given-name': 'given', 'additional-name': null, 'family-name': 'family', 'organization': 'org', 'street-address': 'street', 'address-line1': 'line1', 'address-line2': 'line2', 'address-line3': null, 'address-level1': 'region', 'address-level2': 'city', 'postal-code': 'postal', 'country': 'country', 'country-name': 'country', 'tel': 'phone', 'tel-national': 'phone', 'email': 'email' }[m[1]]
  if (/\b(username|current-password|new-password|one-time-code)\b/.test(ac)) return null
  const h = hintOf(el)
  if (type === 'email' || /e ?mail/.test(h)) return 'email'
  if (type === 'tel' || /phone|mobile|\btel\b|telephone/.test(h)) return 'phone'
  if (/search|coupon|promo|discount|gift|user ?name|login|password/.test(h)) return null
  if (/first ?name|given ?name|\bfname\b|forename/.test(h)) return 'given'
  if (/last ?name|family ?name|surname|\blname\b/.test(h)) return 'family'
  if (/company|organi[sz]ation|business name/.test(h)) return 'org'
  if (/address ?(line)? ?2|\bapt\b|apartment|suite|\bunit\b|address2|street2|addr2|building|floor/.test(h)) return 'line2'
  if (/\bzip|postal|post ?code|postcode|pin ?code|pincode/.test(h)) return 'postal'
  if (/\bcity\b|\btown\b|locality|suburb/.test(h)) return 'city'
  if (/\bstate\b|province|region|county|prefecture|territory/.test(h)) return 'region'
  if (/country/.test(h)) return 'country'
  if (/address ?(line)? ?1|street|address1|addr1|\baddress\b/.test(h)) return el.tagName === 'TEXTAREA' ? 'street' : 'line1'
  if (/full ?name|^\s*name\s*$|\bname\b|recipient/.test(h) && !/user|company|card|bot|nick/.test(h)) return 'name'
  return null
}
const sectionOf = (el) => {
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase()
  if (/\bshipping\b/.test(ac)) return 'shipping'
  if (/\bbilling\b/.test(ac)) return 'billing'
  const h = hintOf(el)
  if (/ship|deliver/.test(h)) return 'shipping'
  if (/bill/.test(h)) return 'billing'
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (!/^(FIELDSET|SECTION|FORM|DIV)$/.test(p.tagName)) continue
    const tag = ((p.id || '') + ' ' + (typeof p.className === 'string' ? p.className : '') + ' ' + (p.querySelector(':scope > legend, :scope > h2, :scope > h3')?.innerText || '')).toLowerCase()
    if (/ship|deliver/.test(tag)) return 'shipping'
    if (/bill/.test(tag)) return 'billing'
  }
  return ''
}
const setValue = (el, v) => {
  v = String(v)
  try { el.scrollIntoView({ block: 'center' }) } catch (e) {}
  try { el.focus() } catch (e) {}
  if (el.tagName === 'SELECT') return false
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  let ok = false
  try { if (typeof el.select === 'function') el.select(); ok = document.execCommand('insertText', false, v) } catch (e) { ok = false }
  const digits = (x) => String(x).replace(/\D/g, '')
  if (!ok || (el.value !== v && digits(el.value) !== digits(v))) {
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  el.dispatchEvent(new Event('change', { bubbles: true }))
  try { el.dispatchEvent(new FocusEvent('blur')); el.blur() } catch (e) {}
  return true
}
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const pickOption = (sel, wants) => {
  const opts = Array.from(sel.options || [])
  const w = wants.filter((x) => x !== undefined && x !== null && String(x) !== '').map((x) => norm(x))
  let hit = null
  for (const x of w) { hit = opts.find((o) => norm(o.value) === x || norm(o.text) === x); if (hit) break }
  if (!hit) for (const x of w) { if (x.length < 3) continue; hit = opts.find((o) => norm(o.text).startsWith(x)); if (hit) break }
  if (!hit) return false
  sel.value = hit.value
  sel.dispatchEvent(new Event('input', { bubbles: true }))
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return true
}
const PROC = ${PROCESSOR_HOST.toString()}
const hostOf = (u) => { try { return new URL(u, location.href).hostname } catch (e) { return '' } }
`

/**
 * Runs with `this` = the target element (or nothing) and returns what's needed to judge and describe
 * a purchase: candidate total rows, order lines, card fields on the page, and the target's form.
 */
export const COMMERCE_FN = String.raw`function () {
  ${PAGE_LIB}
  const MONEY = /(?:[$€£¥₹₩₽₺₪₫฿₱]|\b(?:USD|EUR|GBP|JPY|CAD|AUD|CHF|INR|CNY|SEK|NOK|DKK|PLN|BRL|MXN|NZD|SGD|HKD|KRW|ZAR)\b|zł)\s?-?\d|\d[\d.,'\s]*\s?(?:[€£¥₹₩₽₺₪₫฿₱]|zł|kr\b|\b(?:USD|EUR|GBP|JPY|CAD|AUD|CHF|INR|CNY|SEK|NOK|DKK|PLN|BRL|MXN|NZD|SGD|HKD|KRW|ZAR)\b)/i
  const TOTAL = /\btotal\b|amount due|you('ll| will)? pay|balance due|amount to pay/i
  const totals = []
  for (const el of deepAll(document, 'th,td,dt,dd,span,div,p,li,strong,b,label,h1,h2,h3,h4,h5,tr,output')) {
    if (totals.length > 40) break
    const own = (el.innerText || '').trim()
    if (!own || own.length > 60 || !TOTAL.test(own) || !shown(el)) continue
    let row = el
    let text = own
    for (let i = 0; i < 4 && row && !MONEY.test(text); i++) { row = row.parentElement; if (!row) break; text = (row.innerText || '').trim(); if (text.length > 240) break }
    if (!MONEY.test(text) && el.nextElementSibling) text = own + ' ' + (el.nextElementSibling.innerText || '')
    totals.push({ label: own.replace(/\s+/g, ' ').slice(0, 60), text: text.replace(/\s+/g, ' ').slice(0, 240) })
  }
  const NOT_ITEM = /\b(sub-?total|total|tax|vat|gst|shipping|delivery|discount|coupon|promo|fee|savings|you save|estimated)\b/i
  const rows = []
  const seen = new Set()
  for (const c of deepAll(document, '[class*="summary" i],[id*="summary" i],[class*="cart" i],[id*="cart" i],[class*="order" i],[id*="order" i],[class*="review" i],[class*="basket" i],[class*="bag" i]').slice(0, 30)) {
    for (const r of c.querySelectorAll('li,tr,[class*="item" i],[class*="line" i],[class*="product" i]')) {
      if (seen.has(r) || !shown(r)) continue
      seen.add(r)
      const t = (r.innerText || '').replace(/\s+/g, ' ').trim()
      if (!t || t.length > 160 || !MONEY.test(t) || NOT_ITEM.test(t)) continue
      // The innermost row with a price is the line item.
      if (Array.from(r.querySelectorAll('li,tr,[class*="item" i],[class*="line" i],[class*="product" i]')).some((x) => x !== r && MONEY.test(x.innerText || '') && !NOT_ITEM.test(x.innerText || ''))) continue
      if (!rows.includes(t)) rows.push(t)
      if (rows.length >= 12) break
    }
  }
  const fields = deepAll(document, 'input,select,textarea').filter((x) => ccKind(x, false))
  const numberField = fields.find((x) => ccKind(x, false) === 'number')
  const filled = fields.some((x) => x.hasAttribute('data-sb-pay')) || (!!numberField && String(numberField.value || '').replace(/\D/g, '').length >= 12)
  const frames = deepAll(document, 'iframe').map((f) => hostOf(f.src)).filter((h) => h && PROC.test(h))
  let target = null
  const el = this && this.nodeType === 1 ? this : null
  if (el) {
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    const form = el.form || el.closest('form')
    // A text field's label, never what's typed in it (that could be a card number).
    const typed = /^(input|textarea|select)$/.test(tag) && !/^(submit|button|image|reset)$/.test(type)
    const label = (typed ? (el.getAttribute('aria-label') || labelText(el) || el.getAttribute('placeholder') || el.name || '') : (el.getAttribute('aria-label') || el.innerText || (tag === 'input' ? el.value : '') || el.title || '')).replace(/\s+/g, ' ').trim().slice(0, 120)
    const submit = (tag === 'button' && (type === '' || type === 'submit') && !!form) || (tag === 'input' && /^(submit|image)$/.test(type)) || (/^(input|textarea)$/.test(tag) && !!form && !/^(button|checkbox|radio)$/.test(type))
    const fp = form ? Array.from(form.querySelectorAll('input,select')).filter((x) => ccKind(x, false)) : []
    const ff = form ? Array.from(form.querySelectorAll('iframe')).some((f) => PROC.test(hostOf(f.src))) : false
    // A real <a href> to another http(s) page is plain navigation; "#", "javascript:" and role=link on
    // something else act like buttons.
    let navLink = false
    if (tag === 'a' && el.hasAttribute('href')) {
      try {
        const u = new URL(el.getAttribute('href'), location.href)
        const here = new URL(location.href)
        navLink = /^https?:$/.test(u.protocol) && (u.origin + u.pathname + u.search) !== (here.origin + here.pathname + here.search)
      } catch (e) { navLink = false }
    }
    target = { label, tag, type, submit, inPayForm: fp.length > 0 || ff, formFilled: fp.some((x) => x.hasAttribute('data-sb-pay') || String(x.value || '').replace(/\D/g, '').length >= 12), cardField: ccKind(el, false) || '', navLink }
  }
  return { title: document.title, totals, items: rows, pay: { fields: fields.length, filled, frames }, target }
}`

export interface CardValues { number: string; cvc: string; month: number; year: number; holder: string; brand: string; postal?: string }

/**
 * Finds card fields in one frame WITHOUT any card values: which kinds (number, cvc, month, year, exp,
 * name, postal…) are there. The values are only sent afterwards, to the frames that have such fields.
 */
export function locateCardScript(proc: boolean): string {
  return `(() => {
  ${PAGE_LIB}
  const proc = ${proc ? 'true' : 'false'}
  const all = deepAll(document, 'input,select,textarea').filter((el) => !el.disabled && !el.readOnly)
  let fields = all.map((el) => ({ el, k: ccKind(el, proc) })).filter((f) => f.k)
  const visible = fields.filter((f) => shown(f.el))
  if (visible.length) fields = visible
  return Array.from(new Set(fields.map((f) => f.k)))
})()`
}

/** Only the values a frame's fields need (a frame with just the security code gets just that). */
export function cardValuesFor(kinds: string[], v: CardValues): CardValues {
  const k = new Set(kinds)
  const exp = k.has('month') || k.has('year') || k.has('exp')
  return {
    number: k.has('number') ? v.number : '',
    cvc: k.has('cvc') ? v.cvc : '',
    month: exp ? v.month : 0,
    year: exp ? v.year : 0,
    holder: k.has('name') || k.has('given') || k.has('family') ? v.holder : '',
    brand: k.has('type') ? v.brand : '',
    postal: k.has('postal') ? v.postal : undefined
  }
}

/**
 * Marks fields whose value must never show in a screenshot (card fields, one-time-code fields) and adds
 * the masking style, in one frame. `undo` removes both again after the capture.
 */
export function maskScript(undo = false): string {
  if (undo) return `(() => { try { document.querySelectorAll('[data-sb-mask]').forEach((e) => e.removeAttribute('data-sb-mask')); const s = document.getElementById('sb-shot-mask'); if (s) s.remove() } catch (e) {} return true })()`
  return `(() => {
  ${PAGE_LIB}
  for (const el of deepAll(document, 'input,textarea')) {
    if (ccKind(el, true) || /one-time-code/i.test(el.getAttribute('autocomplete') || '') || el.hasAttribute('data-sb-otp') || el.hasAttribute('data-sb-pay')) el.setAttribute('data-sb-mask', '1')
  }
  if (!document.getElementById('sb-shot-mask')) {
    const st = document.createElement('style')
    st.id = 'sb-shot-mask'
    st.textContent = ${JSON.stringify(SHOT_MASK_CSS)}
    ;(document.head || document.documentElement).appendChild(st)
  }
  return true
})()`
}

/** Masking for screenshots: card fields, one-time-code fields, and fields SahilBot marked. */
export const SHOT_MASK_CSS = 'input[autocomplete*="cc-number" i], input[autocomplete*="cc-csc" i], input[autocomplete*="cc-exp" i], input[autocomplete~="one-time-code" i], [data-sb-otp], [data-sb-pay], [data-sb-mask] { -webkit-text-security: disc !important; }'

/** Fills card fields in one frame. Values arrive as JSON; the script returns only which kinds it filled. */
export function fillCardScript(v: CardValues, proc: boolean): string {
  return `(() => {
  ${PAGE_LIB}
  const V = ${JSON.stringify(v)}
  const proc = ${proc ? 'true' : 'false'}
  const all = deepAll(document, 'input,select,textarea').filter((el) => !el.disabled && !el.readOnly)
  let fields = all.map((el) => ({ el, k: ccKind(el, proc) })).filter((f) => f.k)
  const visible = fields.filter((f) => shown(f.el))
  if (visible.length) fields = visible
  if (!fields.length) return { found: [], filled: [] }
  const mm = String(V.month).padStart(2, '0')
  const yyyy = String(V.year)
  const yy = yyyy.slice(-2)
  const filled = []
  const mark = (el) => { el.setAttribute('data-sb-pay', '1') }
  const numbers = fields.filter((f) => f.k === 'number')
  if (V.number && numbers.length > 1 && numbers.every((f) => (f.el.maxLength > 0 && f.el.maxLength <= 6))) {
    let at = 0
    for (const f of numbers) { const n = f.el.maxLength; setValue(f.el, V.number.slice(at, at + n)); at += n; mark(f.el) }
    filled.push('number')
  } else if (numbers.length && V.number) { setValue(numbers[0].el, V.number); mark(numbers[0].el); filled.push('number') }
  for (const f of fields) {
    const el = f.el
    if (f.k === 'number') continue
    if (f.k === 'name' && V.holder) { setValue(el, V.holder); filled.push('name') }
    else if (f.k === 'given' && V.holder) { setValue(el, V.holder.split(/\\s+/).slice(0, -1).join(' ') || V.holder); filled.push('name') }
    else if (f.k === 'family' && V.holder) { setValue(el, V.holder.split(/\\s+/).slice(-1)[0]); filled.push('name') }
    else if (f.k === 'cvc' && V.cvc) { setValue(el, V.cvc); mark(el); filled.push('cvc') }
    else if (f.k === 'month' && V.month) {
      const ok = el.tagName === 'SELECT' ? pickOption(el, [mm, String(V.month), new Date(2000, V.month - 1, 1).toLocaleString('en', { month: 'long' }), new Date(2000, V.month - 1, 1).toLocaleString('en', { month: 'short' }), mm + ' - ' + new Date(2000, V.month - 1, 1).toLocaleString('en', { month: 'long' })]) : setValue(el, el.maxLength === 1 ? String(V.month) : mm)
      if (ok) { mark(el); filled.push('expiry') }
    } else if (f.k === 'year' && V.year) {
      const ok = el.tagName === 'SELECT' ? pickOption(el, [yyyy, yy]) : setValue(el, (el.maxLength > 0 && el.maxLength <= 2) || /\\byy\\b(?!yy)/i.test(el.placeholder || '') && !/yyyy/i.test(el.placeholder || '') ? yy : yyyy)
      if (ok) { mark(el); filled.push('expiry') }
    } else if (f.k === 'exp' && V.month && V.year) {
      const ph = (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '')
      let val = mm + '/' + yy
      if ((el.type || '') === 'month') val = yyyy + '-' + mm
      else if (/yyyy/i.test(ph) || el.maxLength >= 9) val = mm + (/ \\/ /.test(ph) ? ' / ' : '/') + yyyy
      else if (/ \\/ /.test(ph)) val = mm + ' / ' + yy
      else if (/mmyy/i.test(ph.replace(/\\s/g, '')) && !/\\//.test(ph)) val = mm + yy
      setValue(el, val); mark(el); filled.push('expiry')
    } else if (f.k === 'type' && V.brand && el.tagName === 'SELECT') { if (pickOption(el, [V.brand, V.brand === 'amex' ? 'American Express' : V.brand])) filled.push('type') }
    else if (f.k === 'postal' && V.postal) { setValue(el, V.postal); filled.push('postal') }
  }
  if (!document.getElementById('sb-pay-mask')) {
    const st = document.createElement('style')
    st.id = 'sb-pay-mask'
    st.textContent = '[data-sb-pay]{-webkit-text-security:disc!important}'
    ;(document.head || document.documentElement).appendChild(st)
  }
  return { found: fields.map((f) => f.k), filled: Array.from(new Set(filled)) }
})()`
}

/** Fills address fields (shipping or billing section) in one frame. */
export function fillAddressScript(a: Record<string, string | undefined>, section: 'shipping' | 'billing'): string {
  return `(() => {
  ${PAGE_LIB}
  const A = ${JSON.stringify(a)}
  const want = ${JSON.stringify(section)}
  const all = deepAll(document, 'input,select,textarea').filter((el) => !el.disabled && !el.readOnly && shown(el))
  const fields = all.map((el) => ({ el, k: addrKind(el), s: sectionOf(el) })).filter((f) => f.k)
  if (!fields.length) return { found: 0, filled: [] }
  const explicit = fields.filter((f) => f.s === want)
  const use = explicit.length ? explicit : fields.filter((f) => !f.s)
  const parts = String(A.name || '').trim().split(/\\s+/)
  const vals = {
    name: A.name, given: parts.length > 1 ? parts.slice(0, -1).join(' ') : A.name, family: parts.length > 1 ? parts.slice(-1)[0] : '',
    org: '', street: [A.line1, A.line2].filter(Boolean).join('\\n'), line1: A.line1, line2: A.line2, city: A.city, region: A.region,
    postal: A.postal, country: A.country, phone: A.phone, email: A.email
  }
  const filled = []
  for (const f of use) {
    const v = vals[f.k]
    if (!v) continue
    if (f.el.tagName === 'SELECT') {
      const ok = f.k === 'country' ? pickOption(f.el, A.countryNames ? A.countryNames.split('|') : [v]) : f.k === 'region' ? pickOption(f.el, A.regionNames ? A.regionNames.split('|') : [v]) : pickOption(f.el, [v])
      if (ok) filled.push(f.k)
    } else {
      setValue(f.el, f.k === 'street' && f.el.tagName !== 'TEXTAREA' ? String(v).replace(/\\n/g, ', ') : v)
      filled.push(f.k)
    }
  }
  return { found: use.length, filled: Array.from(new Set(filled)) }
})()`
}

/**
 * Cookie banners: picks the privacy-preserving choice (Reject all / Only necessary) when the banner
 * offers one. A banner with only Accept is left alone and reported.
 */
export const COOKIE_SCRIPT = String.raw`(() => {
  ${PAGE_LIB}
  const REJECT = /^(reject( all)?( cookies)?|decline( all)?( cookies)?|deny( all)?( cookies)?|refuse( all)?( cookies)?|disagree|i disagree|i do not agree|do not agree|do not accept|i do not accept|no,? thanks|only (necessary|essential|required)( cookies)?|(use |allow |accept )?(only )?(strictly )?(necessary|essential|required)( cookies)?( only)?|reject (non-essential|optional|additional|unnecessary)( cookies)?|continue without (accepting|agreeing)|necessary cookies only|essential cookies only)$/i
  const known = ['#onetrust-reject-all-handler', '#CybotCookiebotDialogBodyButtonDecline', '#didomi-notice-disagree-button', 'button[data-testid="uc-deny-all-button"]', '.cc-deny', '#truste-consent-required', '.fc-cta-do-not-consent', 'button[mode="secondary"]']
  for (const sel of known) {
    const b = deepAll(document, sel).find((x) => shown(x) && (sel !== 'button[mode="secondary"]' || REJECT.test((x.innerText || '').trim())))
    if (b) { const t = (b.innerText || b.value || 'Reject').trim().slice(0, 40); b.click(); return { done: t } }
  }
  const boxes = deepAll(document, '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[id*="gdpr" i],[class*="gdpr" i],[id*="cmp" i],[aria-label*="cookie" i],[aria-label*="consent" i],[aria-label*="privacy" i],[role="dialog"],[role="alertdialog"]').filter(shown)
  let acceptOnly = false
  for (const box of boxes) {
    const text = (box.innerText || '').toLowerCase()
    if (!/cookie|consent|privacy|tracking/.test(text) || text.length > 4000) continue
    const buttons = deepAll(box, 'button,[role="button"],a,input[type="button"],input[type="submit"]').filter(shown)
    const b = buttons.find((x) => REJECT.test((x.innerText || x.value || x.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()))
    if (b) { const t = (b.innerText || b.value || '').trim().slice(0, 40); b.click(); return { done: t } }
    if (buttons.some((x) => /accept|agree|allow|got it|ok/i.test(x.innerText || x.value || ''))) acceptOnly = true
  }
  return { acceptOnly }
})()`

// ------------------------------------------------------------------ addresses: country and state names

const COUNTRIES: Record<string, string[]> = {
  US: ['United States', 'United States of America', 'USA', 'US', 'U.S.', 'America'],
  CA: ['Canada', 'CA'], GB: ['United Kingdom', 'UK', 'Great Britain', 'GB', 'England'], AU: ['Australia', 'AU'],
  DE: ['Germany', 'Deutschland', 'DE'], FR: ['France', 'FR'], IN: ['India', 'IN'], JP: ['Japan', 'JP'], MX: ['Mexico', 'MX'],
  ES: ['Spain', 'ES'], IT: ['Italy', 'IT'], NL: ['Netherlands', 'NL', 'Holland'], IE: ['Ireland', 'IE'], NZ: ['New Zealand', 'NZ'],
  SG: ['Singapore', 'SG'], BR: ['Brazil', 'BR'], CH: ['Switzerland', 'CH'], SE: ['Sweden', 'SE'], CN: ['China', 'CN']
}
const US_STATES = 'AL Alabama|AK Alaska|AZ Arizona|AR Arkansas|CA California|CO Colorado|CT Connecticut|DE Delaware|DC District of Columbia|FL Florida|GA Georgia|HI Hawaii|ID Idaho|IL Illinois|IN Indiana|IA Iowa|KS Kansas|KY Kentucky|LA Louisiana|ME Maine|MD Maryland|MA Massachusetts|MI Michigan|MN Minnesota|MS Mississippi|MO Missouri|MT Montana|NE Nebraska|NV Nevada|NH New Hampshire|NJ New Jersey|NM New Mexico|NY New York|NC North Carolina|ND North Dakota|OH Ohio|OK Oklahoma|OR Oregon|PA Pennsylvania|RI Rhode Island|SC South Carolina|SD South Dakota|TN Tennessee|TX Texas|UT Utah|VT Vermont|VA Virginia|WA Washington|WV West Virginia|WI Wisconsin|WY Wyoming'
  .split('|').map((x) => [x.slice(0, 2), x.slice(3)] as const)

/** The names a country or state goes by, for matching a dropdown ("CA" ↔ "California"). */
export function countryNames(c: string): string[] {
  const q = c.trim().toLowerCase()
  const hit = Object.entries(COUNTRIES).find(([code, names]) => code.toLowerCase() === q || names.some((n) => n.toLowerCase() === q))
  return hit ? [c, hit[0], ...hit[1]] : [c]
}
export function regionNames(r: string): string[] {
  const q = r.trim().toLowerCase()
  const hit = US_STATES.find(([code, name]) => code.toLowerCase() === q || name.toLowerCase() === q)
  return hit ? [r, hit[0], hit[1]] : [r]
}

// ------------------------------------------------------------------ the approval gate

export const PURCHASES_NEED_YOU = 'Purchases need you'
/** Minimum time a Purchase card is on screen before an approval counts. */
export const READY_MS = 700
/** An unanswered card expires (and counts as "don't buy"). */
export const TTL_MS = 15 * 60_000

export interface GateDeps {
  emit(e: ChatEvent): void
  /** The run working in a chat right now: helpers and scheduled runs are unattended. */
  runInfo(threadId: string): { helper?: boolean; unattended?: boolean } | undefined
  /** Whether the run was started by another bot's handoff (or a routine) rather than the user. */
  startedByHandoff(threadId: string): boolean
  /** Sites (origins) the user allowed to fill one-time codes without asking (persisted). */
  otpGrants?: { get(): string[]; set(sites: string[]): void }
  /**
   * Whether the run was started by automation rather than the user typing in this chat: another bot's
   * handoff, an app (MCP), a routine, a goal, a helper task. Chat grants for one-time codes don't count there.
   */
  automated?(threadId: string): boolean
  /** Message senders the user confirmed for a site's one-time codes, per origin ("Always" on a code card; persisted). */
  otpSenders?: { get(): Record<string, string[]>; set(v: Record<string, string[]>): void }
}

/** A grant key: the origin (scheme + host[:port]). A bare host from older versions means its https origin. */
export function otpSiteKey(site: string): string {
  const t = String(site ?? '').trim().toLowerCase()
  if (!t) return ''
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(t) ? t : `https://${t}`).origin } catch { return t }
}

type Answer = 'approve' | 'deny' | 'always'
interface Open { request: PendingRequest; done: (a: Answer) => void }

/**
 * Owns Purchase cards. The only way to approve one is `respond` with that card's id and nonce, which
 * index.ts calls solely from a click in the main window. Approving resolves exactly one `request` call.
 */
export class PurchaseGate {
  private open = new Map<string, Open>()
  constructor(private deps: GateDeps) {}

  /** Why this run may not make a purchase at all, or null. */
  refusal(threadId: string): string | null {
    const info = this.deps.runInfo(threadId)
    const tail = 'Do not retry or work around it. Tell the user what you were about to buy (store, items, total) so they can do it from a chat they are watching.'
    if (!info) return `${PURCHASES_NEED_YOU}: nobody is here to approve this purchase. ${tail}`
    if (info.helper) return `${PURCHASES_NEED_YOU}: helper agents can't buy anything. ${tail}`
    if (info.unattended) return `${PURCHASES_NEED_YOU}: routines and scheduled runs never buy anything. ${tail}`
    if (this.deps.startedByHandoff(threadId)) return `${PURCHASES_NEED_YOU}: a purchase can't be started from another bot's handoff. ${tail}`
    return null
  }

  /** Shows a Purchase card and waits for the user's click (or Stop, or expiry: both mean don't buy). */
  async request(threadId: string, info: Omit<PurchaseInfo, 'nonce' | 'readyAt' | 'expiresAt'>, signal: AbortSignal, now = Date.now()): Promise<'approve' | 'deny'> {
    const purchase: PurchaseInfo = { ...info, nonce: randomBytes(16).toString('hex'), readyAt: now + READY_MS, expiresAt: now + TTL_MS }
    const a = await this.show({ id: randomUUID(), threadId, kind: 'purchase', tool: 'browser', label: 'Purchase', purchase }, signal)
    // A purchase can never be remembered: anything but a plain approval is "don't buy".
    return a === 'approve' ? 'approve' : 'deny'
  }

  // ---------------------------------------------------------------- one-time codes

  /** Sites (origins) allowed for one-time codes in each chat (until the app quits). */
  private chatGrants = new Map<string, Set<string>>()
  /** Senders confirmed for a site's codes in each chat: thread → origin → sender keys. */
  private chatSenders = new Map<string, Map<string, Set<string>>>()

  /** A run the user is watching and started themselves (not a helper, routine, goal, handoff or app). */
  attended(threadId: string): boolean {
    const info = this.deps.runInfo(threadId)
    if (!info || info.helper || info.unattended) return false
    if (this.deps.startedByHandoff(threadId)) return false
    if (this.deps.automated?.(threadId)) return false
    return true
  }

  /**
   * Whether a code may be filled on a site without asking. A permanent per-site grant counts anywhere;
   * a chat grant only in an attended run the user started (never a handoff, app, routine or goal run).
   */
  otpAllowed(threadId: string, site: string): boolean {
    const key = otpSiteKey(site)
    if (this.permanent().includes(key)) return true
    return this.attended(threadId) && !!this.chatGrants.get(threadId)?.has(key)
  }

  permanent(): string[] {
    return [...new Set((this.deps.otpGrants?.get() ?? []).map(otpSiteKey).filter(Boolean))]
  }

  revokeOtp(site: string): string[] {
    const key = otpSiteKey(site)
    const left = this.permanent().filter((s) => s !== key)
    this.deps.otpGrants?.set(left)
    for (const g of this.chatGrants.values()) g.delete(key)
    const senders = { ...(this.deps.otpSenders?.get() ?? {}) }
    if (senders[key]) { delete senders[key]; this.deps.otpSenders?.set(senders) }
    for (const m of this.chatSenders.values()) m.delete(key)
    return left
  }

  /**
   * Why a one-time code may not be used in this run, or null. Checked first, before any grant: runs the
   * user isn't watching (or didn't start: handoffs, apps, routines, goals, helpers) may only use a site
   * the user granted permanently.
   */
  otpRefusal(threadId: string, site: string): string | null {
    const key = otpSiteKey(site)
    if (this.permanent().includes(key)) return null
    const info = this.deps.runInfo(threadId)
    const tail = 'Do not retry. Tell the user the sign-in needs a one-time code, so they can allow it ("Always for this site") or sign in themselves.'
    if (!info) return `One-time codes need you: nobody is here to approve using one on ${key}. ${tail}`
    if (!this.attended(threadId)) return `One-time codes need you: this run has nobody to approve using one on ${key}, and the site isn't allowed permanently. ${tail}`
    return null
  }

  /** Senders confirmed for this site's codes: in this chat (attended runs only) and permanently. */
  confirmedSenders(threadId: string, site: string): string[] {
    const key = otpSiteKey(site)
    const out = [...(this.deps.otpSenders?.get()?.[key] ?? [])]
    if (this.attended(threadId)) out.push(...(this.chatSenders.get(threadId)?.get(key) ?? []))
    return [...new Set(out)]
  }

  /** Asks to use a one-time code on a site: once for this chat, always for this site, or not. */
  async requestOtp(threadId: string, info: Omit<OtpInfo, 'nonce' | 'readyAt' | 'expiresAt'>, signal: AbortSignal, now = Date.now()): Promise<Answer> {
    const key = otpSiteKey(info.site)
    const otp: OtpInfo = { ...info, site: key, nonce: randomBytes(16).toString('hex'), readyAt: now + READY_MS, expiresAt: now + TTL_MS }
    const a = await this.show({ id: randomUUID(), threadId, kind: 'otp', tool: 'browser', label: 'One-time code', otp }, signal)
    if (a === 'approve' || a === 'always') {
      const g = this.chatGrants.get(threadId) ?? new Set<string>()
      g.add(key)
      this.chatGrants.set(threadId, g)
      if (a === 'always' && !this.permanent().includes(key)) this.deps.otpGrants?.set([...this.permanent(), key])
      // The user saw who sent the message and approved it: that sender is confirmed for this site.
      if (info.sender && info.unverifiedSender) {
        const sk = senderKeyOf(info.sender)
        const m = this.chatSenders.get(threadId) ?? new Map<string, Set<string>>()
        m.set(key, new Set([...(m.get(key) ?? []), sk]))
        this.chatSenders.set(threadId, m)
        if (a === 'always') {
          const all = { ...(this.deps.otpSenders?.get() ?? {}) }
          all[key] = [...new Set([...(all[key] ?? []), sk])]
          this.deps.otpSenders?.set(all)
        }
      }
    }
    return a
  }

  private show(request: PendingRequest, signal: AbortSignal): Promise<Answer> {
    const { id, threadId } = request
    return new Promise((resolve) => {
      if (signal.aborted) return resolve('deny')
      const timer = setTimeout(() => done('deny'), TTL_MS)
      const onAbort = (): void => done('deny')
      const done = (a: Answer): void => {
        if (!this.open.delete(id)) return
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        this.deps.emit({ threadId, type: 'resolved', id })
        resolve(a)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.open.set(id, { request, done })
      this.deps.emit({ threadId, type: 'pending', request })
    })
  }

  /** The user's click. Anything but the matching nonce, in time, for an open card, is refused. */
  respond(threadId: string, id: string, nonce: string, answer: string, now = Date.now()): { ok: boolean; error?: string } {
    const p = this.open.get(id)
    if (!p || p.request.threadId !== threadId) return { ok: false, error: 'This request is no longer open.' }
    const info = (p.request.purchase ?? p.request.otp)!
    if (answer === 'deny') { p.done('deny'); return { ok: true } }
    // "Always" exists only for one-time codes; a purchase is always a fresh, single approval.
    if (answer !== 'approve' && !(answer === 'always' && p.request.kind === 'otp')) return { ok: false, error: p.request.kind === 'purchase' ? 'Purchases can only be approved one at a time.' : 'Unknown answer.' }
    const a = Buffer.from(String(nonce ?? '')), b = Buffer.from(info.nonce)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: 'This approval does not match the purchase card.' }
    if (now > info.expiresAt) { p.done('deny'); return { ok: false, error: 'This purchase request expired.' } }
    if (now < info.readyAt) return { ok: false, error: 'Read the purchase card first, then approve.' }
    p.done(answer as Answer)
    return { ok: true }
  }

  pending(threadId: string): PendingRequest[] {
    return [...this.open.values()].filter((o) => o.request.threadId === threadId).map((o) => o.request)
  }

  threads(): string[] {
    return [...new Set([...this.open.values()].map((o) => o.request.threadId))]
  }
}
