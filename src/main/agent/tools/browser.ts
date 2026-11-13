import type { ToolEffect } from '@shared/types'
import { safeUrl, type BrowserManager, type RefInfo } from '../../browser/manager'
import { MAX_MS, MAX_STEPS, stepDetails, stepsToText, SECRET } from '../../browser/teach'
import { originMatches, type Vault } from '../../vault'
import { CONSEQUENTIAL, looksLikePayment, looksLikeSecurity } from '../permissions'
import type { ToolDef } from '../types'

type Action = 'navigate' | 'snapshot' | 'click' | 'type' | 'select' | 'fill_secret' | 'scroll' | 'screenshot' | 'get_text' | 'tabs' | 'dialog' | 'fill_form' | 'recording'
interface Args {
  action: Action
  url?: string
  ref?: string
  text?: string
  submit?: boolean
  secret?: string
  field?: 'username' | 'password'
  direction?: 'up' | 'down'
  amount?: number
  /** tabs: list|new|switch|close; recording: start|stop|status */
  op?: 'list' | 'new' | 'switch' | 'close' | 'start' | 'stop' | 'status'
  index?: number
  option?: string
  accept?: boolean
  /** fill_form: several fields in one step (text for inputs, option for dropdowns), then optionally a submit click. */
  fields?: Array<{ ref: string; text?: string; option?: string }>
  submit_ref?: string
}

const DESTRUCTIVE = /\b(delete|remove|erase|destroy|discard|close account|deactivate|unsubscribe all|empty trash)\b/i
const BENIGN = /^(search|go|next|previous|prev|more|show|hide|expand|collapse|close|cancel|back|menu|filter|sort|open|view|load more|see (all|more)|read more|accept( all)?( cookies)?|reject( all)?|dismiss|ok|got it|skip|toggle|play|pause|zoom|×|x)\b/i
const NAV_ROLES = new Set(['link', 'tab'])
const LOCAL_ROLES = new Set(['checkbox', 'radio', 'option', 'combobox', 'listbox', 'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'slider', 'spinbutton'])

/** What a click on this element can do, judged from its role and label. */
export function clickEffect(r: RefInfo | undefined): ToolEffect {
  if (!r) return 'write_external'
  if (DESTRUCTIVE.test(r.name)) return 'destructive'
  if (NAV_ROLES.has(r.role)) return 'read'
  if (LOCAL_ROLES.has(r.role)) return 'write_local'
  if (BENIGN.test(r.name.trim())) return 'write_local'
  return 'write_external'
}

export function browserTool(b: BrowserManager, vault: Vault): ToolDef<Args> {
  const effect = (a: Args): ToolEffect => {
    switch (a.action) {
      case 'click': return clickEffect(b.refInfo(a.ref!))
      case 'type': {
        const r = b.refInfo(a.ref!)
        if (!a.submit) return 'write_local'
        return r?.role === 'searchbox' ? 'read' : 'write_external'
      }
      case 'fill_secret': return 'write_external'
      case 'select': return 'write_local'
      case 'fill_form': return a.submit_ref ? clickEffect(b.refInfo(a.submit_ref)) : 'write_local'
      case 'dialog': return a.accept && b.pendingDialog?.type !== 'alert' ? 'write_external' : 'read'
      case 'tabs': return a.op === 'close' ? 'write_local' : 'read'
      default: return 'read'
    }
  }

  const hardStop = (a: Args): string | null => {
    const r = a.ref ? b.refInfo(a.ref) : undefined
    const url = b.pageUrl()
    if (a.action === 'fill_secret') return `typing the saved login "${a.secret}" (${a.field ?? 'password'}) into ${safeHost(url)}`
    if (a.action === 'type' && r?.password) return 'typing into a password field'
    if (a.action === 'fill_form' && (a.fields ?? []).some((f) => b.refInfo(f.ref)?.password)) return 'typing into a password field'
    if (a.action === 'dialog' && a.accept && (looksLikePayment(b.pendingDialog?.message) || DESTRUCTIVE.test(b.pendingDialog?.message ?? ''))) return `confirming "${b.pendingDialog?.message.slice(0, 80)}"`
    if (a.action === 'click' || (a.action === 'type' && a.submit)) {
      if (looksLikePayment(r?.name, url)) return 'payment or checkout'
      if (DESTRUCTIVE.test(r?.name ?? '') && /\b(permanent|forever|account)\b/i.test(r?.name ?? '')) return 'permanent delete'
      if (looksLikeSecurity(url, r?.name) && clickEffect(r) !== 'read') return 'account or security settings'
    }
    return null
  }

  const describe = (a: Args): string => {
    const r = a.ref ? b.refInfo(a.ref) : undefined
    const el = r ? `${r.role} "${r.name.slice(0, 60)}"` : a.ref ?? ''
    const on = ` on ${safeHost(b.pageUrl())}`
    switch (a.action) {
      case 'click': return `Click ${el}${on}`
      case 'type': return `Type "${(a.text ?? '').slice(0, 80)}" into ${el}${a.submit ? ' and press Enter' : ''}${on}`
      case 'fill_secret': return `Type the saved ${a.field ?? 'password'} for "${a.secret}" into ${el}${on}`
      case 'navigate': return `Open ${a.url}`
      case 'select': return `Choose "${a.option}" in ${el}${on}`
      case 'dialog': return `${a.accept ? 'Accept' : 'Dismiss'} the page's ${b.pendingDialog?.type ?? 'dialog'}: "${b.pendingDialog?.message.slice(0, 120) ?? ''}"`
      case 'tabs': return `${a.op} tab${a.index ? ` ${a.index}` : ''}`
      case 'fill_form': return `Fill ${a.fields?.length ?? 0} fields${a.submit_ref ? ` and click "${b.refInfo(a.submit_ref)?.name ?? a.submit_ref}"` : ''}${on}`
      case 'recording': return a.op === 'start' ? 'Record what you do in the browser panel (Teach a task)' : a.op === 'stop' ? 'Stop recording and read the steps' : 'Check the Teach recording'
      default: return `${a.action}${on}`
    }
  }

  return {
    name: 'browser',
    label: 'Browser',
    group: 'Browser',
    effect,
    hardStop,
    describe,
    consequential: (a) => {
      const r = a.ref ? b.refInfo(a.ref) : undefined
      if (a.action === 'click') return !r || CONSEQUENTIAL.test(r.name)
      if (a.action === 'type') return false
      if (a.action === 'dialog') return CONSEQUENTIAL.test(b.pendingDialog?.message ?? '')
      if (a.action === 'fill_form') { const s = a.submit_ref ? b.refInfo(a.submit_ref) : undefined; return !!a.submit_ref && (!s || CONSEQUENTIAL.test(s.name)) }
      return true
    },
    untrusted: true,
    description: `Control the built-in web browser (persistent logins, visible to the user). Actions:
- navigate {url}: open a URL
- snapshot: page structure with element refs like e12 (call after every page change)
- click {ref}
- type {ref, text, submit?}: replace a field's text; submit presses Enter
- select {ref, option}: choose an option in a dropdown (snapshot lists them)
- dialog {accept, text?}: answer an alert/confirm/prompt the page opened
- fill_secret {ref, secret, field}: type a saved login's username or password; you never see it
- scroll {direction, amount?}: amount is in screens (default 1)
- screenshot: image of the visible page
- get_text: readable text of the page
- tabs {op: list|new|switch|close, index?, url?}
- fill_form {fields: [{ref, text} or {ref, option}], submit_ref?}: fill a whole form in one step (fastest), optionally click submit
- recording {op: start|stop|status, text?}: "Teach a task". start records what the USER does in the browser panel (text = what you asked them to show); stop returns their steps (secret values hidden). Use it when the user wants to show you a web workflow once so you can repeat it.
Speed: navigate already returns a snapshot; act by ref; use fill_form for forms; use get_text to read long pages. For CAPTCHAs or 2-factor codes, stop and ask the user to take over in the browser panel.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['navigate', 'snapshot', 'click', 'type', 'select', 'fill_secret', 'scroll', 'screenshot', 'get_text', 'tabs', 'dialog', 'fill_form'] },
        fields: { type: 'array', maxItems: 40, items: { type: 'object', properties: { ref: { type: 'string', pattern: '^e\\d+$' }, text: { type: 'string' }, option: { type: 'string' } }, required: ['ref'], additionalProperties: false } },
        submit_ref: { type: 'string', pattern: '^e\\d+$' },
        option: { type: 'string', description: 'For select: the option text' },
        accept: { type: 'boolean', description: 'For dialog: true = OK/accept, false = cancel' },
        url: { type: 'string' },
        ref: { type: 'string', pattern: '^e\\d+$' },
        text: { type: 'string' },
        submit: { type: 'boolean' },
        secret: { type: 'string', description: 'Name of a saved login' },
        field: { type: 'string', enum: ['username', 'password'] },
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: { type: 'number', minimum: 0.1, maximum: 10 },
        op: { type: 'string', enum: ['list', 'new', 'switch', 'close', 'start', 'stop', 'status'], description: 'tabs: list|new|switch|close; recording: start|stop|status' },
        index: { type: 'integer', minimum: 1, description: '1-based tab number' }
      },
      required: ['action'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { action: { const: 'navigate' } } }, then: { required: ['url'] } },
        { if: { properties: { action: { const: 'click' } } }, then: { required: ['ref'] } },
        { if: { properties: { action: { const: 'type' } } }, then: { required: ['ref', 'text'] } },
        { if: { properties: { action: { const: 'fill_secret' } } }, then: { required: ['ref', 'secret', 'field'] } },
        { if: { properties: { action: { const: 'scroll' } } }, then: { required: ['direction'] } },
        { if: { properties: { action: { const: 'tabs' } } }, then: { required: ['op'] } },
        { if: { properties: { action: { const: 'recording' } } }, then: { required: ['op'] } },
        { if: { properties: { action: { const: 'select' } } }, then: { required: ['ref', 'option'] } },
        { if: { properties: { action: { const: 'dialog' } } }, then: { required: ['accept'] } },
        { if: { properties: { action: { const: 'fill_form' } } }, then: { required: ['fields'] } }
      ]
    },
    async run(a, ctx) {
      if (a.action === 'recording') return recording(a, ctx?.threadId)
      const out = await act(a)
      // A CAPTCHA or "verify you are human" page: never solved by SahilBot. The user does it, then the agent continues.
      if (['navigate', 'click', 'snapshot', 'fill_form', 'type', 'get_text'].includes(a.action)) {
        const check = await b.humanCheck()
        if (check) {
          b.showToUser()
          return { ...out, text: `${out.text}\n\n[This page is showing a human check (${check}). Don't try to solve it or get around it. The browser panel is now open for the user: call ask_user with the question "Please complete the check in the browser panel, then press Done." and options ["Done", "Skip"]. After Done, take a snapshot and continue; after Skip, try another source.]`, display: `${out.display ?? ''} · waiting for you to pass a human check` }
        }
      }
      return out
    }
  }
  async function act(a: Args): Promise<import('../types').ToolOutput> {
    {
      switch (a.action) {
        case 'navigate': {
          const url = safeUrl(a.url!)
          return { text: await b.navigate(url), display: `opened ${safeHost(url)}`, sources: [{ title: safeHost(url), url }], read: true }
        }
        case 'snapshot':
          return { text: await b.snapshot(), display: `read ${safeHost(b.pageUrl())}` }
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
        case 'fill_secret': {
          const cred = vault.credential(a.secret!)
          if (!cred) {
            const names = vault.names().map((n) => `${n.name} (${n.origin})`).join(', ')
            throw new Error(`No saved login named "${a.secret}". Saved logins: ${names || 'none'}. Ask the user to add one in Settings > Passwords, or to sign in themselves in the browser panel.`)
          }
          const r = b.refInfo(a.ref!)
          if (!r) throw new Error(`Unknown ref "${a.ref}". Call snapshot again.`)
          if (!originMatches(cred.origin, b.pageUrl())) throw new Error(`The login "${a.secret}" is saved for ${cred.origin}, but this page is ${safeOrigin(b.pageUrl())}. It will only be typed on its own site.`)
          if (a.field === 'password' && !r.password) throw new Error(`Element ${a.ref} is not a password field. Passwords only go into password fields.`)
          if (a.field === 'username' && (r.password || !['textbox', 'combobox', 'searchbox'].includes(r.role))) throw new Error(`Element ${a.ref} is not a text field for a username.`)
          await b.fillSecretValue(a.ref!, a.field === 'password' ? cred.password : cred.username)
          return { text: `Filled the ${a.field} for "${a.secret}". (The value is hidden from you.)`, display: `filled ${a.field} for ${a.secret}` }
        }
        case 'scroll':
          return { text: await b.scroll(a.direction!, a.amount), display: `scrolled ${a.direction}` }
        case 'screenshot': {
          const img = await b.screenshot()
          return { text: `Screenshot of ${b.pageUrl()}`, images: [img], display: `screenshot of ${safeHost(b.pageUrl())}` }
        }
        case 'get_text':
          return { text: await b.getText(), display: `read text of ${safeHost(b.pageUrl())}` }
        case 'recording':
          return recording(a)
        case 'tabs': {
          if (a.op === 'new') {
            const url = a.url ? safeUrl(a.url) : undefined
            await b.control(async () => b.newTab(url))
            return { text: `Opened a new tab.${url ? ` Loading ${url}.` : ''}\n${b.listTabs()}`, display: 'new tab' }
          }
          // The bot's own tab changes aren't part of a lesson being recorded.
          if (a.op === 'switch') { quietly(() => b.switchTab((a.index ?? 1) - 1)); return { text: b.listTabs(), display: `tab ${a.index}` } }
          if (a.op === 'close') { quietly(() => b.closeTab((a.index ?? b.state().active + 1) - 1)); return { text: b.listTabs(), display: 'closed tab' } }
          return { text: b.listTabs(), display: 'listed tabs' }
        }
      }
    }
  }

  function quietly(fn: () => void): void {
    b.teach.hold()
    try { fn() } finally { b.teach.release() }
  }

  async function recording(a: Args, threadId?: string): Promise<import('../types').ToolOutput> {
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

function safeHost(u: string): string {
  try { return new URL(u).host } catch { return u.slice(0, 40) }
}
function safeOrigin(u: string): string {
  try { return new URL(u).origin } catch { return u }
}
