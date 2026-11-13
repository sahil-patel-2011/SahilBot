import type { WebContents } from 'electron'
import type { TeachState, TeachStep } from '@shared/types'
import { slug } from '../skills'

// "Teach a task": the user does a web workflow once in the browser panel while SahilBot records it,
// then the bot turns the steps into a reusable skill. A listener script runs in an isolated world in
// every page and frame (the page can't see or forge it) and reports clicks, typing, choices and keys
// through a CDP binding; navigations, tab switches and downloads come from the browser itself.
// Values of password, card, one-time-code and secret-looking fields are never recorded.

export const MAX_STEPS = 300
export const MAX_MS = 10 * 60_000
export const SECRET = '‹secret›'

const WORLD = 'sbTeach'
const BINDING = 'sbTeachEmit'

/** Labels, names and ids of fields whose values are never recorded. */
export const SECRET_FIELD = /pass(word|code|phrase|wd)|\bpass\b|\bpwd\b|passport|\botp\b|totp|one.?time|verification|\b2fa\b|\bmfa\b|security.?code|\bcvv|\bcvc|\bcsc\b|card.?(number|num|no)|cc.?(num|number|csc|exp)|\bssn\b|social.?security|tax.?id|secret|api.?key|token|\bpin\b|auth.?code|recovery.?code|backup.?code/i
const SECRET_AUTOCOMPLETE = /(^|\s)(cc-|one-time-code|current-password|new-password)/i
const SECRET_PARAM = /(^|[_-])(token|code|key|apikey|secret|sig|signature|auth|session|sessionid|sid|password|passwd|pass|pwd|otp|nonce|jwt|ticket|state|credential)s?$/i
const SECRET_VALUES = [
  /\bsk-[A-Za-z0-9_-]{16,}/, /\bsk-ant-/, /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bAIza[0-9A-Za-z_-]{30,}/, /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/, /\bnpm_[A-Za-z0-9]{30,}/, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, /-----BEGIN [A-Z ]*PRIVATE KEY-----/
]

function luhn(d: string): boolean {
  let sum = 0
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i])
    if (i % 2) { n *= 2; if (n > 9) n -= 9 }
    sum += n
  }
  return sum % 10 === 0
}

/** Text that looks like a key, token, card number or other secret, whatever field it was typed in. */
export function looksLikeSecret(s: string | undefined): boolean {
  const t = (s ?? '').trim()
  if (!t) return false
  if (SECRET_VALUES.some((r) => r.test(t))) return true
  if (/\b(password|passwd|passcode|api[_ -]?key|secret|token)\s*[:=]\s*\S+/i.test(t)) return true
  const digits = t.replace(/[\s-]/g, '')
  if (/^\d{13,19}$/.test(digits) && luhn(digits)) return true
  if (/^\d{3}-\d{2}-\d{4}$/.test(t)) return true
  // A long unbroken run of letters and digits: keys, hashes, session ids.
  if (/^[A-Za-z0-9_\-+=]{24,}$/.test(t) && /[A-Za-z]/.test(t) && (t.match(/\d/g) ?? []).length >= 4) return true
  return false
}

/** Whether a field's own markings say its value is secret (password, card, one-time code, key...). */
export function isSecretField(f: { inputType?: string; autocomplete?: string; name?: string; selector?: string }): boolean {
  if ((f.inputType ?? '').toLowerCase() === 'password') return true
  if (SECRET_AUTOCOMPLETE.test(f.autocomplete ?? '')) return true
  return SECRET_FIELD.test(`${f.name ?? ''} ${f.selector ?? ''}`)
}

/** URLs keep their shape, but tokens, codes and keys in the query, fragment or path become ‹secret›. */
export function redactUrl(u: string | undefined): string {
  if (!u) return ''
  let url: URL
  try { url = new URL(u) } catch { return u.slice(0, 300) }
  if (!/^https?:$/.test(url.protocol)) return u.slice(0, 300)
  const params = (q: string): string => q.split('&').map((kv) => {
    const i = kv.indexOf('=')
    if (i < 0) return kv
    const k = kv.slice(0, i)
    let v = kv.slice(i + 1)
    try { v = decodeURIComponent(v.replace(/\+/g, ' ')) } catch { /* keep raw */ }
    return SECRET_PARAM.test(k) || looksLikeSecret(v) ? `${k}=${SECRET}` : kv
  }).join('&')
  const path = url.pathname.split('/').map((seg) => (looksLikeSecret(decodeSafe(seg)) ? SECRET : seg)).join('/')
  const frag = url.hash.slice(1)
  return `${url.protocol}//${url.host}${path}${url.search ? `?${params(url.search.slice(1))}` : ''}${frag ? `#${frag.includes('=') ? params(frag) : frag}` : ''}`.slice(0, 500)
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

const clip = (s: string | undefined, n: number): string | undefined => (s === undefined ? undefined : s.replace(/\s+/g, ' ').trim().slice(0, n))

/** Caps lengths and removes anything secret before a step is stored. */
export function sanitizeStep(raw: TeachStep): TeachStep {
  const s: TeachStep = { ...raw }
  s.name = clip(s.name, 80)
  s.title = clip(s.title, 80)
  s.filename = clip(s.filename, 120)
  if (s.url !== undefined) s.url = redactUrl(s.url)
  if (s.selector !== undefined) {
    s.selector = s.selector.replace(/href="([^"]*)"/, (_m, h: string) => `href="${/^https?:/i.test(h) ? redactUrl(h) : h.replace(/([?&#][^=&#]+)=([^&#]*)/g, (m2, k: string) => (SECRET_PARAM.test(k.slice(1)) ? `${k}=${SECRET}` : m2))}"`).slice(0, 140)
  }
  if (s.kind === 'type' || s.kind === 'select') {
    const otp = /^\d{4,8}$/.test((s.text ?? '').trim()) && /\bcode\b|\bpin\b/i.test(s.name ?? '') && !/zip|postal|promo|coupon|discount|area|country|referral/i.test(s.name ?? '')
    if (s.secret || isSecretField(s) || looksLikeSecret(s.text) || otp) { s.secret = true; s.text = SECRET }
    else s.text = (s.text ?? '').slice(0, 300)
  } else if (s.text !== undefined) s.text = looksLikeSecret(s.text) ? SECRET : s.text.slice(0, 300)
  return s
}

const TEXTY = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton'])
const TOGGLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'])
const sameField = (a: TeachStep, b: TeachStep): boolean => a.tab === b.tab && a.frame === b.frame && (a.selector || a.name || '') === (b.selector || b.name || '')

/**
 * Adds a step, collapsing noise: keystrokes into one "type" per field, the click that focused a field,
 * redirects into one navigation, double clicks, a held key. Mutates steps.
 */
export function pushStep(steps: TeachStep[], raw: TeachStep): 'added' | 'merged' | 'dropped' | 'full' {
  const s = sanitizeStep(raw)
  const last = steps.at(-1)
  const replaceLast = (): 'merged' => { steps[steps.length - 1] = s; return 'merged' }
  if (last) {
    switch (s.kind) {
      case 'type':
        if (last.kind === 'type' && sameField(last, s)) return replaceLast()
        if (last.kind === 'click' && sameField(last, s) && (TEXTY.has(last.role ?? '') || last.secret)) return replaceLast()
        break
      case 'select':
        if ((last.kind === 'select' || last.kind === 'click') && sameField(last, s)) return replaceLast()
        break
      case 'navigate':
        if (last.kind === 'navigate' && last.tab === s.tab && (last.url === s.url || s.at - last.at < 5000)) {
          last.url = s.url
          last.at = s.at
          return 'merged'
        }
        if (last.kind === 'history' && last.tab === s.tab && s.at - last.at < 5000) { last.url = s.url; return 'merged' }
        if (last.kind === 'tab' && last.op === 'new' && last.tab === s.tab) { last.url = s.url; return 'merged' }
        // Search-as-you-type and similar pages rewrite the URL while you type: not a step of their own.
        if (s.inPage && last.kind === 'type') return 'dropped'
        if (s.cause === 'page' && ['click', 'key', 'select'].includes(last.kind) && s.at - last.at < 4000) s.cause = 'action'
        break
      case 'click':
        if (last.kind === 'click' && sameField(last, s) && last.role === s.role && s.at - last.at < 700) {
          if (TOGGLES.has(s.role ?? '')) return replaceLast()
          return 'dropped'
        }
        break
      case 'key':
        if (last.kind === 'key' && last.key === s.key && s.at - last.at < 250) return 'dropped'
        break
      case 'tab':
        if (s.op === 'switch' && last.kind === 'tab' && last.op === 'switch') return replaceLast()
        if (s.op === 'switch' && last.kind === 'tab' && last.op === 'new' && last.tab === s.tab) return 'dropped'
        break
    }
  }
  if (steps.length >= MAX_STEPS) return 'full'
  steps.push(s)
  return 'added'
}

function shortUrl(u: string | undefined): string {
  if (!u || u === 'about:blank') return 'a blank page'
  const t = u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
  return t.length > 90 ? `${t.slice(0, 89)}…` : t
}

const ROLE_WORD: Record<string, string> = {
  link: 'link', button: 'button', checkbox: 'checkbox', radio: 'option', switch: 'switch', tab: 'tab', menuitem: 'menu item',
  menuitemcheckbox: 'menu item', menuitemradio: 'menu item', option: 'option', textbox: 'field', searchbox: 'search box',
  combobox: 'field', spinbutton: 'field', slider: 'slider', treeitem: 'item', gridcell: 'cell', heading: 'heading', img: 'image'
}

/** One step in plain words, for the chat and the Teach bar. */
export function stepToText(s: TeachStep): string {
  const where = s.frame ? ` (inside the embedded ${s.frame} frame)` : ''
  const label = s.name ? `"${s.name}"` : ''
  switch (s.kind) {
    case 'navigate':
      if (s.cause === 'address') return `Go to ${shortUrl(s.url)}`
      if (s.cause === 'action') return `The page opens ${shortUrl(s.url)}`
      return `Open ${shortUrl(s.url)}`
    case 'history':
      return s.op === 'back' ? 'Go back' : s.op === 'forward' ? 'Go forward' : 'Reload the page'
    case 'click': {
      const word = ROLE_WORD[s.role ?? ''] ?? ''
      const what = label ? `${word ? `the ${word} ` : ''}${label}` : `the ${word || 'element'}${s.selector ? ` (${s.selector})` : ''}`
      const state = TOGGLES.has(s.role ?? '') && s.checked !== undefined ? (s.checked ? ' (turns it on)' : ' (turns it off)') : ''
      return `Click ${what}${state}${where}`
    }
    case 'type': {
      const field = label ? `the ${label} field` : 'the field'
      if (s.secret) return `Type ${SECRET} into ${field}${where}`
      if (!s.text) return `Clear ${field}${where}`
      return `Type "${s.text.length > 120 ? `${s.text.slice(0, 119)}…` : s.text}" into ${field}${where}`
    }
    case 'select':
      return `Choose "${s.secret ? SECRET : s.text}"${label ? ` in ${label}` : ''}${where}`
    case 'key':
      return `Press ${s.key}${label ? ` in ${label}` : ''}${where}`
    case 'tab':
      if (s.op === 'new') return s.url && s.url !== 'about:blank' ? `A new tab opens ${shortUrl(s.url)}` : 'Open a new tab'
      if (s.op === 'close') return `Close tab ${s.tab}`
      return `Switch to tab ${s.tab}${s.title ? ` ("${s.title}")` : ''}`
    case 'download':
      return `Download "${s.filename || 'a file'}"${s.url ? ` from ${shortUrl(s.url).split('/')[0]}` : ''}`
  }
}

export const stepsToText = (steps: TeachStep[]): string => steps.map((s, i) => `${i + 1}. ${stepToText(s)}`).join('\n')

/** The technical side of each step (role, selector hint, URL), for the model only. */
export function stepDetails(steps: TeachStep[]): string {
  return steps.map((s, i) => {
    const parts = [`${i + 1}. ${s.kind}${s.op ? `:${s.op}` : ''}`]
    if (s.tab) parts.push(`tab=${s.tab}`)
    if (s.role) parts.push(`role=${s.role}`)
    if (s.name) parts.push(`name=${JSON.stringify(s.name)}`)
    if (s.selector) parts.push(`selector=${s.selector}`)
    if (s.text !== undefined) parts.push(`value=${s.secret ? SECRET : JSON.stringify(s.text)}`)
    if (s.key) parts.push(`key=${s.key}`)
    if (s.url) parts.push(`url=${s.url}`)
    if (s.frame) parts.push(`frame=${s.frame}`)
    if (s.cause) parts.push(`cause=${s.cause}`)
    parts.push(`t=${Math.round(s.at / 1000)}s`)
    return parts.join(' ')
  }).join('\n')
}

function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`
}

export const TEACH_INSTRUCTION = "Turn this into a reusable skill with memory(action='save_skill'): inputs, steps (using browser actions and refs, not coordinates), checks, and when to ask me. Then try it once to confirm it works, and offer to schedule it as a routine."

/** The chat message for a finished recording: readable text for the bubble, details for the model. */
export function teachMessage(o: { name: string; goal?: string; steps: TeachStep[]; ms: number }): { text: string; note: string } {
  const name = o.name.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled task'
  const goal = o.goal?.replace(/\s+/g, ' ').trim().slice(0, 300)
  const secrets = o.steps.some((s) => s.secret || s.text === SECRET)
  const text = [
    `Teach: ${name}`,
    ...(goal ? [`Goal: ${goal}`] : []),
    '',
    o.steps.length
      ? `I just showed you how to do this in the browser (${o.steps.length} step${o.steps.length === 1 ? '' : 's'}, ${duration(o.ms)}):\n${stepsToText(o.steps)}`
      : 'I started recording but no steps were captured.',
    '',
    `${TEACH_INSTRUCTION}${slug(name).length > 1 ? ` Name the skill "${slug(name)}".` : ''}`
  ].join('\n')
  const note = [
    '[Teach recording details. Selector hints and names are for re-finding elements: at run time take a snapshot and act by ref. Values typed by the user are examples; make the ones that change per run into inputs.',
    ...(secrets ? [`Values shown as ${SECRET} were hidden on purpose. Never put them in the skill: use a saved login with browser fill_secret, or ask the user at run time.`] : []),
    stepDetails(o.steps),
    ']'
  ].join('\n')
  return { text, note }
}

// ------------------------------------------------------------------ the in-page listener

/** Runs in an isolated world in every frame. Reports trusted user input only; never secret values. */
export function listenerScript(token: string): string {
  return `(() => {
  const TOKEN = ${JSON.stringify(token)}
  const g = globalThis
  if (g.__sbTeach === TOKEN) return
  g.__sbTeach = TOKEN
  const SECRET_RE = new RegExp(${JSON.stringify(SECRET_FIELD.source)}, 'i')
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
  const emit = (ev) => {
    try {
      if (g.__sbTeach !== TOKEN) return
      ev.t = TOKEN
      ev.top = window === window.top
      if (!ev.top) ev.frame = location.host
      g.${BINDING}(JSON.stringify(ev))
    } catch (e) { /* binding gone: recording stopped */ }
  }
  const textOf = (ids) => ids.split(/\\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent : '' }).join(' ')
  const labelOf = (el) => {
    let t = el.getAttribute('aria-label') || ''
    if (!t && el.getAttribute('aria-labelledby')) t = textOf(el.getAttribute('aria-labelledby'))
    if (!t && el.labels && el.labels.length) t = el.labels[0].innerText || el.labels[0].textContent
    if (!t) t = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || ''
    return clean(t)
  }
  const nameOf = (el) => {
    const tag = el.tagName.toLowerCase()
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (['button', 'submit', 'reset'].includes((el.type || '').toLowerCase())) return clean(el.getAttribute('aria-label') || el.value)
      return labelOf(el)
    }
    if (el.isContentEditable) return labelOf(el)
    let t = el.getAttribute('aria-label') || ''
    if (!t && el.getAttribute('aria-labelledby')) t = textOf(el.getAttribute('aria-labelledby'))
    if (!t) t = el.innerText || el.textContent || ''
    if (!clean(t)) { const img = el.querySelector && el.querySelector('img[alt],svg[aria-label]'); t = el.getAttribute('title') || (img ? img.getAttribute('alt') || img.getAttribute('aria-label') : '') }
    return clean(t)
  }
  const roleOf = (el) => {
    const r = el.getAttribute('role')
    if (r) return r.split(' ')[0]
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase()
      return ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', range: 'slider', number: 'spinbutton', search: 'searchbox', file: 'button' })[t] || 'textbox'
    }
    if (el.isContentEditable) return 'textbox'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'img') return 'img'
    return 'generic'
  }
  const stable = (s) => !!s && s.length < 60 && !/\\d{4,}|[a-f0-9]{10,}|^[:\\d]|__/i.test(s) && !/^(ember|react|radix|headlessui|mui|rc-|r-|:r)/i.test(s)
  const q = (v) => JSON.stringify(clean(v).slice(0, 60))
  const selectorOf = (el) => {
    const tag = el.tagName.toLowerCase()
    for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy']) { const v = el.getAttribute(a); if (v) return '[' + a + '=' + q(v) + ']' }
    if (el.id && stable(el.id)) return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id)
    const n = el.getAttribute('name'); if (n && stable(n)) return tag + '[name=' + q(n) + ']'
    const al = el.getAttribute('aria-label'); if (al) return tag + '[aria-label=' + q(al) + ']'
    const href = el.getAttribute('href')
    if (tag === 'a' && href && !/^javascript:/i.test(href) && href.length < 120) return 'a[href="' + href.replace(/"/g, '%22') + '"]'
    const ph = el.getAttribute('placeholder'); if (ph) return tag + '[placeholder=' + q(ph) + ']'
    const txt = clean(el.innerText || '').slice(0, 40)
    return txt && !el.isContentEditable ? tag + ':has-text(' + JSON.stringify(txt) + ')' : tag
  }
  const isSecret = (el) => {
    if (!el || el.nodeType !== 1) return false
    if ((el.getAttribute('type') || '').toLowerCase() === 'password') return true
    if (/(^|\\s)(cc-|one-time-code|current-password|new-password)/i.test(el.getAttribute('autocomplete') || '')) return true
    return SECRET_RE.test([el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), labelOf(el)].join(' '))
  }
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[role=treeitem],[role=gridcell],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]'
  const first = (e) => { const p = e.composedPath ? e.composedPath() : []; return p[0] || e.target }
  const targetOf = (e) => {
    const p = e.composedPath ? e.composedPath() : [e.target]
    for (const n of p) {
      if (n === document.body || n === document.documentElement || n === document) break
      if (n && n.nodeType === 1 && n.matches && n.matches(INTERACTIVE)) return n
    }
    const t = p[0]
    return t && t.nodeType === 1 ? t : t && t.parentElement
  }
  const editableRoot = (el) => (el && el.isContentEditable && el.closest ? el.closest('[contenteditable]:not([contenteditable=false])') || el : el)
  addEventListener('click', (e) => {
    if (!e.isTrusted) return
    const el = targetOf(e)
    if (!el || !el.tagName) return
    const tag = el.tagName.toLowerCase()
    if (tag === 'label' && el.control) return
    if (tag === 'select' || tag === 'option') return
    const ev = { type: 'click', role: roleOf(el), name: nameOf(el), selector: selectorOf(el) }
    if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) ev.checked = !!el.checked
    else if (el.getAttribute('aria-checked')) ev.checked = el.getAttribute('aria-checked') !== 'true'
    if (isSecret(el)) ev.secret = true
    emit(ev)
  }, true)
  addEventListener('input', (e) => {
    if (!e.isTrusted) return
    const el = editableRoot(first(e))
    if (!el || el.nodeType !== 1) return
    const tag = el.tagName.toLowerCase()
    if (tag === 'select') return
    const type = tag === 'input' ? (el.type || 'text').toLowerCase() : tag
    if (['checkbox', 'radio', 'range', 'color', 'file', 'submit', 'button'].includes(type)) return
    const secret = isSecret(el)
    const value = secret ? '' : String(el.isContentEditable ? el.innerText : el.value || '').slice(0, 500)
    emit({ type: 'input', role: roleOf(el), name: labelOf(el), selector: selectorOf(el), secret, value, inputType: type, autocomplete: el.getAttribute('autocomplete') || '' })
  }, true)
  addEventListener('change', (e) => {
    if (!e.isTrusted) return
    const el = first(e)
    if (!el || el.tagName !== 'SELECT') return
    const secret = isSecret(el)
    const value = secret ? '' : Array.from(el.selectedOptions || []).map((o) => clean(o.text)).join(', ')
    emit({ type: 'select', role: roleOf(el), name: labelOf(el), selector: selectorOf(el), secret, value, autocomplete: el.getAttribute('autocomplete') || '' })
  }, true)
  addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.repeat) return
    const el = editableRoot(first(e))
    const isEl = el && el.nodeType === 1 && el !== document.body && el !== document.documentElement
    const tag = isEl ? el.tagName.toLowerCase() : ''
    const mods = (e.metaKey ? 'Cmd+' : '') + (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '')
    const k = e.key
    let key = null
    if (k === 'Enter') { if (tag === 'textarea' && !mods && !e.shiftKey) return; key = mods + (e.shiftKey ? 'Shift+' : '') + 'Enter' }
    else if (k === 'Escape') key = 'Escape'
    else if ((k === 'ArrowDown' || k === 'ArrowUp') && isEl && (el.getAttribute('aria-autocomplete') || el.getAttribute('role') === 'combobox' || el.getAttribute('aria-expanded') !== null)) key = k
    else if (mods && k && k.length === 1 && !/^[cvxazy]$/i.test(k)) key = mods + (e.shiftKey ? 'Shift+' : '') + k.toUpperCase()
    if (!key) return
    emit({ type: 'key', key, role: isEl ? roleOf(el) : '', name: isEl ? (tag === 'input' || tag === 'textarea' || el.isContentEditable ? labelOf(el) : nameOf(el)) : '', selector: isEl ? selectorOf(el) : '' })
  }, true)
})()`
}

interface InPageEvent {
  t?: string; type?: string; top?: boolean; frame?: string; role?: string; name?: string; selector?: string
  value?: string; secret?: boolean; checked?: boolean; key?: string; inputType?: string; autocomplete?: string
}

/** Turns a listener report into a step (or null for anything unexpected). Exported for tests. */
export function fromPage(ev: InPageEvent): Omit<TeachStep, 'at' | 'tab'> | null {
  const str = (v: unknown, n: number): string | undefined => (typeof v === 'string' ? v.slice(0, n) : undefined)
  const base = { role: str(ev.role, 40), name: str(ev.name, 120), selector: str(ev.selector, 200), frame: ev.top === false ? str(ev.frame, 100) : undefined }
  switch (ev.type) {
    case 'click': return { kind: 'click', ...base, secret: ev.secret === true || undefined, checked: typeof ev.checked === 'boolean' ? ev.checked : undefined }
    case 'input': return { kind: 'type', ...base, text: ev.secret ? '' : str(ev.value, 500) ?? '', secret: ev.secret === true || undefined, inputType: str(ev.inputType, 20), autocomplete: str(ev.autocomplete, 60) }
    case 'select': return { kind: 'select', ...base, text: ev.secret ? '' : str(ev.value, 300) ?? '', secret: ev.secret === true || undefined, autocomplete: str(ev.autocomplete, 60) }
    case 'key': return typeof ev.key === 'string' && ev.key ? { kind: 'key', ...base, key: ev.key.slice(0, 30) } : null
    default: return null
  }
}

// ------------------------------------------------------------------ the recorder

interface Attached { scriptId?: string; off: () => void }
interface Session {
  token: string
  by: 'user' | 'agent'
  startedAt: number
  stoppedAt?: number
  status: 'recording' | 'stopped'
  limit?: 'time' | 'steps'
  steps: TeachStep[]
  name?: string
  threadId?: string
  timer?: NodeJS.Timeout
  wcs: Map<WebContents, Attached>
}

export class TeachRecorder {
  private s: Session | null = null
  private held = 0
  private quietUntil = 0

  /** onChange: publish the browser state. tabOf: 1-based tab number of a page (0 if unknown). */
  constructor(private onChange: () => void, private tabOf: (wc: WebContents) => number = () => 0) {}

  get recording(): boolean {
    return this.s?.status === 'recording'
  }

  state(): TeachState | undefined {
    const s = this.s
    if (!s) return undefined
    return {
      status: s.status, by: s.by, startedAt: s.startedAt, stoppedAt: s.stoppedAt, steps: s.steps.length,
      recent: s.steps.slice(-3).map(stepToText), limit: s.limit, name: s.name, threadId: s.threadId
    }
  }

  /** Starts recording on the given pages (and any opened later, via attach). Replaces a finished one. */
  async start(o: { by: 'user' | 'agent'; tabs: WebContents[]; name?: string; threadId?: string }): Promise<TeachState> {
    if (this.s?.status === 'recording') throw new Error('Already recording. Press Done or Cancel in the Teach bar first.')
    this.clear()
    const s: Session = {
      token: Math.random().toString(36).slice(2) + Date.now().toString(36), by: o.by, startedAt: Date.now(), status: 'recording',
      steps: [], name: o.name?.slice(0, 80), threadId: o.threadId, wcs: new Map()
    }
    this.s = s
    s.timer = setTimeout(() => this.stop('time'), MAX_MS)
    await Promise.all(o.tabs.map((wc) => this.attach(wc)))
    this.onChange()
    return this.state()!
  }

  /** Starts listening on one page: an isolated-world script on every new document, plus the current one. */
  async attach(wc: WebContents): Promise<void> {
    const s = this.s
    if (!s || s.status !== 'recording' || s.wcs.has(wc) || wc.isDestroyed()) return
    const send = <T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
      return wc.debugger.sendCommand(method, params) as Promise<T>
    }
    const onMessage = (_e: unknown, method: string, params: { name?: string; payload?: string }): void => {
      if (method === 'Runtime.bindingCalled' && params.name === BINDING) this.fromBinding(wc, params.payload ?? '')
    }
    const onNav = (_e: unknown, url: string): void => this.record(wc, { kind: 'navigate', url, cause: 'page', at: 0 })
    const onInPage = (_e: unknown, url: string, isMainFrame: boolean): void => { if (isMainFrame) this.record(wc, { kind: 'navigate', url, cause: 'page', inPage: true, at: 0 }) }
    wc.debugger.on('message', onMessage)
    wc.on('did-navigate', onNav)
    wc.on('did-navigate-in-page', onInPage)
    const entry: Attached = {
      off: () => {
        wc.debugger.removeListener('message', onMessage)
        wc.removeListener('did-navigate', onNav)
        wc.removeListener('did-navigate-in-page', onInPage)
      }
    }
    s.wcs.set(wc, entry)
    const src = listenerScript(s.token)
    try {
      await send('Runtime.enable')
      await send('Runtime.addBinding', { name: BINDING, executionContextName: WORLD })
      const { identifier } = await send<{ identifier: string }>('Page.addScriptToEvaluateOnNewDocument', { source: src, worldName: WORLD })
      entry.scriptId = identifier
      // The page that's already open, and its frames (cross-site frames may refuse: skipped).
      const { frameTree } = await send<{ frameTree: FrameTree }>('Page.getFrameTree')
      for (const id of frameIds(frameTree)) {
        try {
          const { executionContextId } = await send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: id, worldName: WORLD })
          await send('Runtime.evaluate', { expression: src, contextId: executionContextId })
        } catch { /* frame not reachable */ }
      }
    } catch { /* page closed or debugger busy: navigations are still recorded */ }
  }

  private detach(wc: WebContents, a: Attached): void {
    a.off()
    if (wc.isDestroyed() || !wc.debugger.isAttached()) return
    if (a.scriptId) void wc.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: a.scriptId }).catch(() => undefined)
    void wc.debugger.sendCommand('Runtime.removeBinding', { name: BINDING }).catch(() => undefined)
    void wc.debugger.sendCommand('Runtime.disable').catch(() => undefined)
  }

  /** A tab closed: forget it. */
  forget(wc: WebContents): void {
    const a = this.s?.wcs.get(wc)
    if (!a) return
    a.off()
    this.s!.wcs.delete(wc)
  }

  private fromBinding(wc: WebContents, payload: string): void {
    let ev: InPageEvent
    try { ev = JSON.parse(payload) as InPageEvent } catch { return }
    // Listeners from an earlier recording in the same page report with an old token: ignored.
    if (!this.s || ev.t !== this.s.token) return
    const step = fromPage(ev)
    if (step) this.record(wc, { ...step, at: 0 })
  }

  /** While the bot acts in the browser, nothing is recorded (its own clicks aren't the lesson). */
  hold(): void {
    this.held++
  }

  release(): void {
    this.held = Math.max(0, this.held - 1)
    this.quietUntil = Date.now() + 500
  }

  /** Adds a step from a page (wc) or from the browser chrome (null: tab comes with the step). */
  record(wc: WebContents | null, raw: TeachStep): void {
    const s = this.s
    if (!s || s.status !== 'recording') return
    if (this.held > 0 || Date.now() < this.quietUntil) return
    const step: TeachStep = { ...raw, at: Date.now() - s.startedAt, tab: raw.tab ?? (wc ? this.tabOf(wc) || undefined : undefined) }
    const r = pushStep(s.steps, step)
    if (r === 'full') { this.stop('steps'); return }
    if (r !== 'dropped') this.onChange()
    if (s.steps.length >= MAX_STEPS) this.stop('steps')
  }

  download(wc: WebContents | null | undefined, filename: string, url: string): void {
    if (wc && this.s && !this.s.wcs.has(wc)) return
    this.record(wc ?? null, { kind: 'download', filename, url, at: 0 })
  }

  /** Stops listening; the steps stay until compose, cancel or a new recording. */
  stop(limit?: 'time' | 'steps'): { steps: TeachStep[]; text: string } {
    const s = this.s
    if (!s) return { steps: [], text: '' }
    if (s.status === 'recording') {
      s.status = 'stopped'
      s.stoppedAt = Date.now()
      if (limit) s.limit = limit
      if (s.timer) clearTimeout(s.timer)
      for (const [wc, a] of s.wcs) this.detach(wc, a)
      s.wcs.clear()
      this.onChange()
    }
    return { steps: [...s.steps], text: stepsToText(s.steps) }
  }

  /** The chat message for the stopped recording; clears it. */
  compose(name: string, goal?: string): { text: string; note: string; threadId?: string } {
    const s = this.s
    if (!s) throw new Error('There is no recording to send.')
    if (s.status === 'recording') this.stop()
    const msg = teachMessage({ name: name || s.name || '', goal, steps: s.steps, ms: (s.stoppedAt ?? Date.now()) - s.startedAt })
    const threadId = s.threadId
    this.clear()
    this.onChange()
    return { ...msg, threadId }
  }

  cancel(): void {
    if (!this.s) return
    this.clear()
    this.onChange()
  }

  /** Who started the current recording, if any. */
  get by(): 'user' | 'agent' | undefined {
    return this.s?.by
  }

  private clear(): void {
    const s = this.s
    if (!s) return
    if (s.timer) clearTimeout(s.timer)
    for (const [wc, a] of s.wcs) this.detach(wc, a)
    this.s = null
  }
}

interface FrameTree { frame: { id: string }; childFrames?: FrameTree[] }
function frameIds(t: FrameTree): string[] {
  return [t.frame.id, ...(t.childFrames ?? []).flatMap(frameIds)]
}
