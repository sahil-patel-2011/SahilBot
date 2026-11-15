// "Save login to Vault?": notices when the user signs in or pays by hand in the browser panel.
// A listener runs in its own isolated world on every page (page scripts can't see it, call its binding
// or fake its events) and, on a form the user submitted with their own click or Enter key, reports the
// form's sign-in or card fields to main over a CDP binding that exists only in that world. Main checks
// the page (HTTPS or loopback, same site as the tab, SahilBot not acting) and holds the values in
// secure/offers.ts until the user clicks Save; the window only gets the site and a masked username.

import type { WebContents } from 'electron'
import { isSecurePage, sameSiteUrls } from '../secure/origin'
import type { BrowserCapture } from '../secure/offers'

export const SAVE_WORLD = 'sahilbot-save'
export const SAVE_BINDING = '__sahilbotSaveOffer'

/**
 * The in-page listener (isolated world). Reads input values only at the moment the user submits a form
 * that holds a password or a card number, and only after a trusted (real) click or key press.
 */
export function saveListenerScript(token: string): string {
  return String.raw`(() => {
  if (globalThis.__sbSaveWatch) return
  globalThis.__sbSaveWatch = true
  const TOKEN = ${JSON.stringify(token)}
  const BIND = ${JSON.stringify(SAVE_BINDING)}
  let trustedAt = 0
  const mark = (e) => { if (e.isTrusted) trustedAt = Date.now() }
  addEventListener('pointerdown', mark, true)
  addEventListener('mousedown', mark, true)
  addEventListener('keydown', mark, true)
  addEventListener('touchstart', mark, true)
  const attr = (el, n) => String((el.getAttribute && el.getAttribute(n)) || '').toLowerCase()
  const hint = (el) => [attr(el, 'name'), attr(el, 'id'), attr(el, 'placeholder'), attr(el, 'aria-label'), attr(el, 'data-testid')].join(' ')
  const shown = (el) => {
    try {
      if (el.disabled) return false
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return el.type === 'password' && !!el.value
      const s = getComputedStyle(el)
      return s.display !== 'none' && s.visibility !== 'hidden'
    } catch (e) { return false }
  }
  const inputsOf = (root) => {
    const out = []
    const visit = (r) => { r.querySelectorAll('input').forEach((i) => out.push(i)); r.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) visit(el.shadowRoot) }) }
    try { visit(root) } catch (e) { /* detached */ }
    return out.filter(shown)
  }
  const TEXTY = /^(text|email|tel|search|url|)$/
  const digits = (s) => String(s || '').replace(/\D+/g, '')
  const luhn = (d) => { if (d.length < 12 || d.length > 19) return false; let sum = 0; for (let i = 0; i < d.length; i++) { let n = +d[d.length - 1 - i]; if (i % 2) { n *= 2; if (n > 9) n -= 9 } sum += n } return sum % 10 === 0 }
  const isCardNumber = (i) => /cc-number/.test(attr(i, 'autocomplete')) || /card.?num|cardnumber|ccnum|cc-num|credit.?card|card_no|cardno/.test(hint(i))
  const login = (inputs) => {
    const pws = inputs.filter((i) => String(i.type).toLowerCase() === 'password' && i.value)
    if (!pws.length) return null
    const isNew = (i) => /new-password/.test(attr(i, 'autocomplete')) || /new|confirm|repeat|again|verify/.test(hint(i))
    const cur = pws.find((i) => /current-password/.test(attr(i, 'autocomplete'))) || pws.find((i) => !isNew(i)) || null
    const fresh = pws.filter(isNew)
    // A sign-up or change form: the new password (confirm fields agree with it).
    let newPassword = ''
    if (fresh.length) newPassword = fresh[0].value
    else if (pws.length >= 2 && pws[pws.length - 1].value === pws[pws.length - 2].value && pws[0] !== pws[pws.length - 2]) newPassword = pws[pws.length - 1].value
    const first = cur || pws[0]
    const before = inputs.slice(0, inputs.indexOf(first)).reverse()
    const user = before.find((i) => TEXTY.test(String(i.type).toLowerCase()) && i.value && (/username|email/.test(attr(i, 'autocomplete')) || /user|mail|login|account|phone/.test(hint(i))))
      || before.find((i) => TEXTY.test(String(i.type).toLowerCase()) && i.value && !isCardNumber(i))
    const password = cur && cur.value !== newPassword ? cur.value : (newPassword ? '' : first.value)
    return { kind: 'login', username: user ? String(user.value).trim() : '', password, newPassword }
  }
  const card = (inputs) => {
    const num = inputs.find((i) => isCardNumber(i) && luhn(digits(i.value)))
    if (!num) return null
    const ac = (re) => inputs.find((i) => re.test(attr(i, 'autocomplete')))
    const by = (re) => inputs.find((i) => re.test(hint(i)))
    let expMonth = 0, expYear = 0
    const exp = ac(/cc-exp(\s|$)/) || by(/exp(iry|iration)?(?!.*(month|year))/)
    const m = exp && /^\s*(\d{1,2})\s*[\/\-. ]\s*(\d{2,4})\s*$/.exec(exp.value)
    if (m) { expMonth = +m[1]; expYear = +m[2] }
    const mo = ac(/cc-exp-month/) || by(/exp.?month|month/)
    const yr = ac(/cc-exp-year/) || by(/exp.?year|year/)
    if (!expMonth && mo) expMonth = +digits(mo.value)
    if (!expYear && yr) expYear = +digits(yr.value)
    const name = ac(/cc-name/) || by(/card.?holder|name.?on.?card|cardname|cc-name/)
    const cvc = ac(/cc-csc/) || by(/cvc|cvv|csc|security.?code/)
    return { kind: 'card', number: digits(num.value), expMonth, expYear, holder: name ? String(name.value).trim() : '', cvc: cvc ? digits(cvc.value) : '' }
  }
  let last = ''
  let lastAt = 0
  const report = (root) => {
    if (Date.now() - trustedAt > 4000) return
    const inputs = inputsOf(root || document)
    const found = login(inputs) || card(inputs)
    if (!found) return
    const key = JSON.stringify(found)
    if (key === last && Date.now() - lastAt < 30000) return
    last = key
    lastAt = Date.now()
    try { globalThis[BIND](JSON.stringify(Object.assign({ t: TOKEN, url: String(location.href), top: window.top === window }, found))) } catch (e) { /* binding gone */ }
  }
  const scope = (el) => (el && (el.form || (el.closest && el.closest('form')))) || document
  addEventListener('submit', (e) => { if (e.isTrusted || Date.now() - trustedAt < 1500) report(e.target) }, true)
  const SUBMITTY = /^(log ?in|sign ?in|sign ?up|continue|next|submit|save|update|change|register|create account|pay|pay now|place order|buy|buy now|confirm|complete( purchase| order)?|checkout|done)\b/i
  addEventListener('click', (e) => {
    if (!e.isTrusted) return
    const b = e.target && e.target.closest && e.target.closest('button, input[type=submit], input[type=button], [role=button]')
    if (!b) return
    const type = attr(b, 'type')
    const text = String(b.innerText || b.value || attr(b, 'aria-label') || '').trim()
    if (type === 'submit' || (b.tagName === 'BUTTON' && !type && b.form) || SUBMITTY.test(text)) setTimeout(() => report(scope(b)), 0)
  }, true)
  addEventListener('keydown', (e) => {
    if (!e.isTrusted || e.key !== 'Enter') return
    const t = e.target
    if (t && t.tagName === 'INPUT') setTimeout(() => report(scope(t)), 0)
  }, true)
})()`
}

/** Checks and parses one report from the listener; null for anything malformed or out of place. */
export function parseSaveReport(payload: string, token: string, tabUrl: string): BrowserCapture | null {
  let ev: Record<string, unknown>
  try { ev = JSON.parse(payload) as Record<string, unknown> } catch { return null }
  if (!ev || ev.t !== token) return null
  const url = String(ev.url ?? '')
  // Only from a secure page on the tab's own site (not a frame from another site).
  if (!isSecurePage(url) || !sameSiteUrls(url, tabUrl)) return null
  const str = (v: unknown, n: number): string => (typeof v === 'string' ? v.slice(0, n) : '')
  if (ev.kind === 'login') {
    const password = str(ev.password, 512)
    const newPassword = str(ev.newPassword, 512)
    if (!password && !newPassword) return null
    return { kind: 'login', url, username: str(ev.username, 200).trim(), password, ...(newPassword ? { newPassword } : {}) }
  }
  if (ev.kind === 'card') {
    const number = str(ev.number, 19).replace(/\D+/g, '')
    if (number.length < 12) return null
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined)
    return { kind: 'card', url, number, expMonth: num(ev.expMonth), expYear: num(ev.expYear), holder: str(ev.holder, 80).trim(), cvc: str(ev.cvc, 4).replace(/\D+/g, '') }
  }
  return null
}

/**
 * Starts the listener on one tab: on every new document (all frames of its process) and on the page
 * already open. `onReport` gets the raw binding payloads (parse them with parseSaveReport).
 */
export async function watchForSaves(wc: WebContents, token: string, onReport: (payload: string) => void): Promise<void> {
  const send = <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> => wc.debugger.sendCommand(method, params) as Promise<T>
  wc.debugger.on('message', (_e, method: string, params: { name?: string; payload?: string }, sessionId?: string) => {
    if (sessionId) return
    if (method === 'Runtime.bindingCalled' && params.name === SAVE_BINDING) onReport(params.payload ?? '')
  })
  const src = saveListenerScript(token)
  try {
    await send('Runtime.enable')
    await send('Runtime.addBinding', { name: SAVE_BINDING, executionContextName: SAVE_WORLD })
    await send('Page.addScriptToEvaluateOnNewDocument', { source: src, worldName: SAVE_WORLD })
    // The page that's already loading (its first document may have started before the script was
    // registered): the listener goes into its frames too. The guard keeps it to one per world.
    const { frameTree } = await send<{ frameTree: FrameTree }>('Page.getFrameTree')
    for (const id of frameIds(frameTree)) {
      try {
        const { executionContextId } = await send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: id, worldName: SAVE_WORLD })
        await send('Runtime.evaluate', { expression: src, contextId: executionContextId })
      } catch { /* frame gone or not reachable */ }
    }
  } catch { /* the tab closed or has no debugger: no offers there */ }
}

interface FrameTree { frame: { id: string }; childFrames?: FrameTree[] }
const frameIds = (t: FrameTree): string[] => [t.frame.id, ...(t.childFrames ?? []).flatMap(frameIds)]
