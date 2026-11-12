import { BrowserWindow, WebContentsView, session as electronSession, type Rectangle, type Session, type WebContents } from 'electron'
import type { BrowserState } from '@shared/types'
import { readable } from '../agent/tools/web'

/** Size the page renders at while the panel is closed (a typical laptop viewport). */
const PARK = { width: 1280, height: 860 }

export interface RefInfo {
  backendNodeId: number
  role: string
  name: string
  password?: boolean
  inputType?: string
}

interface AXValue { value?: unknown }
interface AXNode {
  nodeId: string
  ignored?: boolean
  role?: AXValue
  name?: AXValue
  value?: AXValue
  properties?: Array<{ name: string; value: AXValue }>
  childIds?: string[]
  backendDOMNodeId?: number
}

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'switch', 'slider', 'option', 'listbox', 'spinbutton', 'textfield', 'TextField', 'PopUpButton'
])
const SKIP = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'RootWebArea', 'WebArea', 'group', 'Section', 'paragraph', 'div', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell'])
const CONTROL_CSS = 'html { outline: 3px solid #ff6a1a !important; outline-offset: -3px !important; }'
const MAX_LINES = 600

// Page dialogs never block or get auto-accepted: confirm/prompt answer Cancel unless the agent
// explicitly accepted the next one (after the permission check); everything is reported back.
const DIALOG_SHIM = `(() => {
  if (window.__fmDialogs) return
  window.__fmDialogs = []
  window.__fmNext = null
  const take = () => { const n = window.__fmNext; window.__fmNext = null; return n }
  window.alert = (m) => { window.__fmDialogs.push({ type: 'alert', message: String(m ?? '') }) }
  window.confirm = (m) => { const n = take(); window.__fmDialogs.push({ type: 'confirm', message: String(m ?? ''), answered: n ? n.accept : false }); return n ? !!n.accept : false }
  window.prompt = (m, d) => { const n = take(); window.__fmDialogs.push({ type: 'prompt', message: String(m ?? ''), answered: n ? n.accept : false }); return n && n.accept ? (n.text ?? d ?? '') : null }
})()`

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Tabs are WebContentsViews on a persistent session, attached to the right panel.
 * Agent actions go through the Chrome DevTools Protocol on each tab's debugger.
 */
/** Only web pages open in a tab; anything else (file:, javascript:, app schemes) is refused. about:blank stays allowed. */
export function safeUrl(url: string): string {
  if (url === 'about:blank') return url
  const u = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`
  if (!/^https?:\/\//i.test(u)) throw new Error('Only http and https URLs can be opened.')
  return u
}

export class BrowserManager {
  private tabs: WebContentsView[] = []
  private active = -1
  private bounds: Rectangle | null = null
  private refs = new Map<string, RefInfo>()
  private controlCssKey: string | null = null
  private controlTimer: NodeJS.Timeout | null = null
  private ses: Session
  /** backendNodeIds seen in the previous snapshot of the same document, to mark new elements. */
  private prevIds = new Set<number>()
  private prevUrl = ''
  private dialog: { type: string; message: string; defaultPrompt?: string } | null = null
  controlling = false
  takenOver = false

  constructor(private win: () => BrowserWindow | null, private emit: (s: BrowserState) => void, private requestOpen?: () => void) {
    this.ses = electronSession.fromPartition('persist:foreman-browser')
    // Sites don't get the camera, mic, location or notifications, and nothing downloads silently.
    this.ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    this.ses.on('will-download', (e) => e.preventDefault())
  }

  // ------------------------------------------------------------- tabs & view

  private get view(): WebContentsView | undefined {
    return this.tabs[this.active]
  }

  wc(): WebContents {
    if (!this.view) this.newTab()
    return this.view!.webContents
  }

  newTab(url?: string): number {
    if (url) url = safeUrl(url)
    const view = new WebContentsView({ webPreferences: { session: this.ses, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    const wc = view.webContents
    wc.setWindowOpenHandler(({ url: u }) => {
      try { this.newTab(u) } catch { /* not a web page */ }
      return { action: 'deny' }
    })
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) {
      wc.on(ev as 'did-stop-loading', () => this.publish())
    }
    // A new document drops inserted CSS; forget the key so the outline is re-applied on the next action.
    wc.on('did-navigate', () => {
      if (this.view?.webContents === wc) this.controlCssKey = null
    })
    try {
      wc.debugger.attach('1.3')
      void wc.debugger.sendCommand('Page.enable').catch(() => undefined)
      void wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: DIALOG_SHIM }).catch(() => undefined)
    } catch {
      /* already attached */
    }
    // Page dialogs (alert/confirm/prompt) wait for the agent or the user; never auto-accepted.
    wc.debugger.on('message', (_e, method, params: { type?: string; message?: string; defaultPrompt?: string }) => {
      if (method === 'Page.javascriptDialogOpening') this.dialog = { type: params.type ?? 'alert', message: params.message ?? '', defaultPrompt: params.defaultPrompt }
      if (method === 'Page.javascriptDialogClosed') this.dialog = null
    })
    this.tabs.push(view)
    this.switchTab(this.tabs.length - 1)
    if (url) void wc.loadURL(url).catch(() => undefined)
    return this.tabs.length - 1
  }

  switchTab(i: number): void {
    if (!this.tabs[i]) throw new Error(`No tab ${i + 1}`)
    if (this.view) this.detach(this.view)
    this.active = i
    this.refs.clear()
    this.attach()
    this.publish()
  }

  closeTab(i: number): void {
    const t = this.tabs[i]
    if (!t) throw new Error(`No tab ${i + 1}`)
    if (this.view) this.detach(this.view)
    t.webContents.close()
    this.tabs.splice(i, 1)
    if (i < this.active) this.active--
    this.active = Math.max(0, Math.min(this.active, this.tabs.length - 1))
    if (!this.tabs.length) this.active = -1
    this.refs.clear()
    this.attach()
    this.publish()
  }

  /** Bounds of the panel area from the renderer; null hides the view (panel closed, modal open). */
  setBounds(b: Rectangle | null): void {
    this.bounds = b
    this.attach()
  }

  /**
   * With the panel open the page sits in it. With the panel closed it lives in a window that is never
   * shown: invisible to you, but still rendering and taking real clicks, so the agent can keep working
   * and take screenshots without the browser popping open. (A view parked past the window's edge
   * renders, but Chromium drops mouse input outside the window.)
   */
  private attach(): void {
    const v = this.view
    if (!v || this.disposed) return
    const w = this.win()
    const inPanel = !!(w && !w.isDestroyed() && this.bounds && this.bounds.width > 0)
    const host = inPanel ? w! : this.park()
    for (const h of [w, this.parking]) if (h && h !== host && !h.isDestroyed() && h.contentView.children.includes(v)) h.contentView.removeChildView(v)
    if (!host.contentView.children.includes(v)) host.contentView.addChildView(v)
    v.setBounds(inPanel ? this.bounds! : { x: 0, y: 0, width: PARK.width, height: PARK.height })
  }

  private parking: BrowserWindow | null = null
  private park(): BrowserWindow {
    if (!this.parking || this.parking.isDestroyed()) {
      this.parking = new BrowserWindow({ show: false, ...PARK, skipTaskbar: true, focusable: false, paintWhenInitiallyHidden: true, title: 'SahilBot browser' })
    }
    return this.parking
  }

  private detach(v: WebContentsView): void {
    for (const h of [this.win(), this.parking]) if (h && !h.isDestroyed() && h.contentView.children.includes(v)) h.contentView.removeChildView(v)
  }

  /** The main window was resized or replaced: re-seat the page. */
  reflow(): void {
    this.attach()
  }

  private disposed = false
  /** Quitting: never create the parking window again (it would keep the app alive). */
  dispose(): void {
    this.disposed = true
    if (this.parking && !this.parking.isDestroyed()) this.parking.destroy()
    this.parking = null
  }

  state(): BrowserState {
    return {
      tabs: this.tabs.map((t, i) => ({ index: i, url: t.webContents.getURL(), title: t.webContents.getTitle() || 'New tab', loading: t.webContents.isLoading() })),
      active: this.active,
      canGoBack: !!this.view?.webContents.navigationHistory.canGoBack(),
      canGoForward: !!this.view?.webContents.navigationHistory.canGoForward(),
      controlling: this.controlling,
      takenOver: this.takenOver
    }
  }

  private publish(): void {
    this.emit(this.state())
  }

  // ------------------------------------------------------------- user control

  userNavigate(url: string): void {
    const u = /^[a-z]+:\/\//i.test(url) ? url : /\s/.test(url) || !url.includes('.') ? `https://duckduckgo.com/?q=${encodeURIComponent(url)}` : `https://${url}`
    void this.wc().loadURL(u).catch(() => undefined)
  }

  back(): void { this.view?.webContents.navigationHistory.goBack() }
  forward(): void { this.view?.webContents.navigationHistory.goForward() }
  reload(): void { this.view?.webContents.reload() }

  takeOver(on: boolean): void {
    this.takenOver = on
    if (on) void this.endControl()
    this.publish()
  }

  // ------------------------------------------------------------- agent control

  /** Every agent action goes through here: opens the panel, shows the control outline, honors take-over. */
  async control<T>(fn: (wc: WebContents) => Promise<T>): Promise<T> {
    if (this.takenOver) throw new Error('The user has taken over the browser. Ask them to click "Hand back" when they are done, or continue without the browser.')
    // The browser works in the background; the user opens the panel from the globe button to watch.
    const wc = this.wc()
    if (!this.controlling) {
      this.controlling = true
      this.publish()
    }
    if (this.controlTimer) clearTimeout(this.controlTimer)
    try {
      if (!this.controlCssKey && !wc.isLoading()) this.controlCssKey = await wc.insertCSS(CONTROL_CSS).catch(() => null)
      return await fn(wc)
    } finally {
      this.controlTimer = setTimeout(() => void this.endControl(), 2500)
    }
  }

  private async endControl(): Promise<void> {
    if (this.controlCssKey && this.view) await this.view.webContents.removeInsertedCSS(this.controlCssKey).catch(() => undefined)
    this.controlCssKey = null
    if (this.controlling) {
      this.controlling = false
      this.publish()
    }
  }

  private cdp<T = any>(wc: WebContents, method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    return wc.debugger.sendCommand(method, params) as Promise<T>
  }

  /** Waits for a navigation the action may have started, then for the page to stop loading. */
  /** Waits for navigation to finish, then for the DOM to go quiet (no fixed sleeps beyond that). */
  private async settle(wc: WebContents, ms = 10_000): Promise<void> {
    await sleep(120)
    const deadline = Date.now() + ms
    while (wc.isLoading() && Date.now() < deadline) await sleep(80)
    const quietBy = Date.now() + 1500
    let last = -1
    while (Date.now() < quietBy && !this.dialog) {
      const n = await this.mutations(wc)
      if (n === last) break
      last = n
      await sleep(150)
    }
  }

  /** Installs (once per document) a MutationObserver counting real changes; returns the count. */
  private async mutations(wc: WebContents): Promise<number> {
    if (this.dialog) return -2
    const r = await this.cdp<{ result: { value: number } }>(wc, 'Runtime.evaluate', {
      expression: `(() => {
        ${DIALOG_SHIM}
        if (!window.__fm) {
          window.__fm = { n: 0, doc: Math.random().toString(36).slice(2) }
          new MutationObserver((ms) => { for (const m of ms) if (m.type !== 'attributes' || m.oldValue !== m.target.getAttribute(m.attributeName)) { window.__fm.n++; break } })
            .observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true })
          addEventListener('input', () => window.__fm.n++, true)
        }
        return window.__fm.n
      })()`,
      returnByValue: true
    }).catch(() => ({ result: { value: -1 } }))
    return r.result.value
  }

  private async docId(wc: WebContents): Promise<string> {
    const r = await this.cdp<{ result: { value?: string } }>(wc, 'Runtime.evaluate', { expression: 'window.__fm ? window.__fm.doc : ""', returnByValue: true }).catch(() => ({ result: { value: '' } }))
    return r.result.value ?? ''
  }

  /** Runs an action and reports what it did to the page: navigated, page changed, or no change. */
  private async observe(wc: WebContents, act: () => Promise<void>): Promise<string> {
    const beforeUrl = wc.getURL()
    const beforeN = await this.mutations(wc)
    const beforeDoc = await this.docId(wc)
    await act()
    await this.settle(wc)
    const asked = await this.cdp<{ result: { value?: Array<{ type: string; message: string; answered?: boolean }> } }>(wc, 'Runtime.evaluate', {
      expression: '(() => { const d = window.__fmDialogs || []; window.__fmDialogs = []; return d })()', returnByValue: true
    }).catch(() => ({ result: { value: [] } }))
    const d = asked.result.value?.at(-1)
    if (d) {
      this.dialog = { type: d.type, message: d.message }
      if (d.type === 'alert') { this.dialog = null; return `The page showed an alert: "${d.message.slice(0, 300)}".` }
      if (!d.answered) return `The page asked to ${d.type} "${d.message.slice(0, 300)}" and it was answered Cancel (the safe default). To say OK instead, call the dialog action with accept=true, then repeat the same action.`
      this.dialog = null
      return `The page asked to ${d.type} "${d.message.slice(0, 200)}" and it was answered OK as you chose.`
    }
    const afterUrl = wc.getURL()
    if (afterUrl !== beforeUrl || (beforeDoc && (await this.docId(wc)) !== beforeDoc)) {
      this.refs.clear()
      return `Navigated to ${afterUrl}. Refs are now stale: snapshot to see the new page.`
    }
    const afterN = await this.mutations(wc)
    return afterN > beforeN ? 'The page changed. Snapshot to see the result.' : 'No visible change on the page. If you expected one, snapshot and check the element, or try another one.'
  }

  get pendingDialog(): { type: string; message: string } | null {
    return this.dialog
  }

  async answerDialog(accept: boolean, text?: string): Promise<string> {
    return this.control(async (wc) => {
      const d = this.dialog
      if (!d) return 'No dialog is waiting.'
      if (!accept) {
        this.dialog = null
        return `Left the ${d.type} "${d.message.slice(0, 120)}" cancelled.`
      }
      await this.cdp(wc, 'Runtime.evaluate', { expression: `window.__fmNext = ${JSON.stringify({ accept: true, text })}` })
      this.dialog = null
      return `The next ${d.type} on this page ("${d.message.slice(0, 120)}") will be answered OK. Now repeat the action that opened it.`
    })
  }

  async navigate(url: string): Promise<string> {
    return this.control(async (wc) => {
      this.refs.clear()
      try {
        await wc.loadURL(url)
      } catch (e) {
        // Redirects and aborted sub-loads reject loadURL but still land on a page.
        if (!wc.getURL() || wc.getURL() === 'about:blank') throw new Error(`Could not open ${url}: ${(e as Error).message}`)
      }
      await this.settle(wc)
      return `Opened ${wc.getURL()} — "${wc.getTitle()}".`
    }).then(async (head) => {
      // Saves a step: the start of the page comes back with the navigation.
      const snap = await this.snapshot()
      const lines = snap.split('\n')
      return `${head}\n${lines.slice(0, 80).join('\n')}${lines.length > 80 ? `\n[… ${lines.length - 80} more lines: call snapshot for the full page]` : ''}`
    })
  }

  refInfo(ref: string): RefInfo | undefined {
    return this.refs.get(ref)
  }

  pageUrl(): string {
    return this.view?.webContents.getURL() ?? ''
  }

  async snapshot(): Promise<string> {
    return this.control(async (wc) => {
      await this.cdp(wc, 'Accessibility.enable')
      const { nodes } = await this.cdp<{ nodes: AXNode[] }>(wc, 'Accessibility.getFullAXTree')
      const byId = new Map(nodes.map((n) => [n.nodeId, n]))
      this.refs.clear()
      const ids = new Set<number>()
      const samePage = this.prevUrl === wc.getURL()
      const lines: string[] = []
      let n = 0
      const textboxes: Array<{ ref: string; id: number }> = []

      const walk = (node: AXNode, depth: number): void => {
        if (lines.length > MAX_LINES) return
        const role = String(node.role?.value ?? '')
        const name = String(node.name?.value ?? '').replace(/\s+/g, ' ').trim()
        const kids = (node.childIds ?? []).map((id) => byId.get(id)).filter((x): x is AXNode => !!x)
        const passthrough = node.ignored || (SKIP.has(role) && !INTERACTIVE.has(role))
        if (passthrough) {
          kids.forEach((k) => walk(k, depth))
          return
        }
        if (role === 'StaticText') {
          if (name && !lines.at(-1)?.includes(`"${name}"`)) lines.push(`${'  '.repeat(depth)}- text "${name.slice(0, 300)}"`)
          return
        }
        const props = new Map((node.properties ?? []).map((p) => [p.name, p.value?.value]))
        let line = `${'  '.repeat(depth)}- ${role}${name ? ` "${name.slice(0, 160)}"` : ''}`
        if (INTERACTIVE.has(role) && node.backendDOMNodeId && !props.get('hidden')) {
          const ref = `e${++n}`
          this.refs.set(ref, { backendNodeId: node.backendDOMNodeId, role, name })
          ids.add(node.backendDOMNodeId)
          // * marks elements that weren't on the page at the previous snapshot (e.g. a menu that just opened).
          if (samePage && this.prevIds.size && !this.prevIds.has(node.backendDOMNodeId)) line = line.replace(/- /, '- *')
          line += ` [ref=${ref}]`
          if (role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton') textboxes.push({ ref, id: node.backendDOMNodeId })
        }
        if (props.get('level')) line += ` [level ${props.get('level')}]`
        if (props.has('checked')) line += ` [checked=${props.get('checked')}]`
        if (props.get('disabled')) line += ' [disabled]'
        if (props.get('required')) line += ' [required]'
        if (props.get('focused')) line += ' [focused]'
        const value = node.value?.value
        if (value !== undefined && value !== '' && INTERACTIVE.has(role)) line += ` value="{{${node.backendDOMNodeId}}}"`
        lines.push(line)
        // Interactive leaves: their text is already in the name.
        if (!(INTERACTIVE.has(role) && role !== 'listbox' && role !== 'combobox')) kids.forEach((k) => walk(k, depth + 1))
        else if (role === 'combobox' || role === 'listbox') kids.forEach((k) => walk(k, depth + 1))
      }

      const root = nodes.find((x) => !x.ignored && (x.role?.value === 'RootWebArea' || x.role?.value === 'WebArea')) ?? nodes[0]
      if (root) walk(root, 0)

      // Mark password fields and never show what they contain.
      const valueOf = new Map<number, string>()
      for (const node of nodes) if (node.backendDOMNodeId && node.value?.value !== undefined) valueOf.set(node.backendDOMNodeId, String(node.value.value))
      for (const t of textboxes) {
        try {
          const { node } = await this.cdp<{ node: { attributes?: string[] } }>(wc, 'DOM.describeNode', { backendNodeId: t.id })
          const attrs = node.attributes ?? []
          const type = attrs[attrs.indexOf('type') + 1]
          const info = this.refs.get(t.ref)!
          info.inputType = attrs.includes('type') ? type : 'text'
          if (type === 'password') info.password = true
        } catch {
          /* node went away */
        }
      }
      const out = lines.map((l) => l.replace(/value="\{\{(\d+)\}\}"/, (_m, id: string) => {
        const ref = [...this.refs.entries()].find(([, r]) => r.backendNodeId === Number(id))
        if (ref?.[1].password) return 'value="••••••" (password)'
        return `value="${(valueOf.get(Number(id)) ?? '').slice(0, 120)}"`
      })).map((l) => {
        const m = l.match(/\[ref=(e\d+)\]/)
        return m && this.refs.get(m[1])?.password && !l.includes('(password)') ? `${l} (password field)` : l
      })
      // Clickable things with no accessible role (div onclick, cursor:pointer) still get refs.
      const extra = await this.clickables(wc, ids)
      for (const x of extra) {
        const ref = `e${++n}`
        this.refs.set(ref, { backendNodeId: x.id, role: 'clickable', name: x.name })
        ids.add(x.id)
        out.push(`- ${samePage && this.prevIds.size && !this.prevIds.has(x.id) ? '*' : ''}clickable "${x.name}" [ref=${ref}]`)
      }
      // Native <select> lists its options so the model can use the select action.
      for (const [ref, r] of this.refs) {
        if (r.role !== 'combobox') continue
        const opts = await this.selectOptions(wc, r.backendNodeId)
        if (opts) {
          const i = out.findIndex((l) => l.includes(`[ref=${ref}]`))
          if (i >= 0) out[i] += ` options: ${opts}`
        }
      }
      this.prevIds = ids
      this.prevUrl = wc.getURL()
      const dlg = this.dialog ? `\nA ${this.dialog.type} dialog is open: "${this.dialog.message.slice(0, 200)}". Answer it with the dialog action.` : ''
      const head = `Page: "${wc.getTitle()}" ${wc.getURL()}${dlg}\nRefs are valid until the page changes. * = new since the last snapshot.\n`
      return head + (out.length ? out.join('\n') : '(page has no accessible content yet)') + (lines.length > MAX_LINES ? '\n[… snapshot cut at 600 lines; scroll or use get_text]' : '')
    })
  }

  private async clickables(wc: WebContents, known: Set<number>): Promise<Array<{ id: number; name: string }>> {
    try {
      const { result } = await this.cdp<{ result: { objectId?: string } }>(wc, 'Runtime.evaluate', {
        expression: `Array.from(document.querySelectorAll('body *')).filter((el) => {
          if (el.closest('a,button,input,select,textarea,[role]')) return false
          const st = getComputedStyle(el)
          if (st.visibility === 'hidden' || st.display === 'none' || !el.checkVisibility?.({ checkOpacity: true })) return false
          const clickable = el.hasAttribute('onclick') || (el.tabIndex >= 0 && el.hasAttribute('tabindex')) || el.isContentEditable ||
            (st.cursor === 'pointer' && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== 'pointer'))
          return clickable && (el.innerText || el.getAttribute('aria-label') || el.title || '').trim().length > 0
        }).slice(0, 40)`
      })
      if (!result.objectId) return []
      const { result: props } = await this.cdp<{ result: Array<{ name: string; value?: { objectId?: string } }> }>(wc, 'Runtime.getProperties', { objectId: result.objectId, ownProperties: true })
      const out: Array<{ id: number; name: string }> = []
      for (const pr of props) {
        if (!/^\d+$/.test(pr.name) || !pr.value?.objectId) continue
        const { node } = await this.cdp<{ node: { backendNodeId: number } }>(wc, 'DOM.describeNode', { objectId: pr.value.objectId })
        if (known.has(node.backendNodeId)) continue
        const t = await this.cdp<{ result: { value: string } }>(wc, 'Runtime.callFunctionOn', {
          objectId: pr.value.objectId, returnByValue: true,
          functionDeclaration: 'function () { return (this.getAttribute("aria-label") || this.title || this.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 80) }'
        })
        out.push({ id: node.backendNodeId, name: t.result.value })
      }
      return out
    } catch {
      return []
    }
  }

  private async selectOptions(wc: WebContents, backendNodeId: number): Promise<string | null> {
    try {
      const { object } = await this.cdp<{ object: { objectId: string } }>(wc, 'DOM.resolveNode', { backendNodeId })
      const r = await this.cdp<{ result: { value: string | null } }>(wc, 'Runtime.callFunctionOn', {
        objectId: object.objectId, returnByValue: true,
        functionDeclaration: 'function () { if (this.tagName !== "SELECT") return null; const o = Array.from(this.options).map((x) => (x.selected ? "[x] " : "") + x.text.trim()); return o.slice(0, 8).join(" | ") + (o.length > 8 ? " | … " + (o.length - 8) + " more" : "") }'
      })
      return r.result.value
    } catch {
      return null
    }
  }

  async select(ref: string, option: string): Promise<string> {
    return this.control(async (wc) => {
      const r = this.node(ref)
      const { object } = await this.cdp<{ object: { objectId: string } }>(wc, 'DOM.resolveNode', { backendNodeId: r.backendNodeId })
      const res = await this.cdp<{ result: { value: string } }>(wc, 'Runtime.callFunctionOn', {
        objectId: object.objectId, returnByValue: true, arguments: [{ value: option }],
        functionDeclaration: `function (want) {
          if (this.tagName !== 'SELECT') return 'ERR:not a dropdown'
          const w = want.toLowerCase().trim()
          const opts = Array.from(this.options)
          const hit = opts.find((o) => o.text.trim().toLowerCase() === w || o.value.toLowerCase() === w) || opts.find((o) => o.text.toLowerCase().startsWith(w))
          if (!hit) return 'ERR:' + opts.map((o) => o.text.trim()).join(' | ')
          this.value = hit.value
          this.dispatchEvent(new Event('input', { bubbles: true }))
          this.dispatchEvent(new Event('change', { bubbles: true }))
          return hit.text.trim()
        }`
      })
      const v = res.result.value
      if (v.startsWith('ERR:not')) throw new Error(`${ref} is not a dropdown. Click it instead.`)
      if (v.startsWith('ERR:')) throw new Error(`No option "${option}". Options: ${v.slice(4)}`)
      return `Selected "${v}" in ${r.role} "${r.name}".`
    })
  }

  private node(ref: string): RefInfo {
    const r = this.refs.get(ref)
    if (!r) throw new Error(`Unknown ref "${ref}". Refs change when the page changes: call snapshot again and use a ref from it.`)
    return r
  }

  private async center(wc: WebContents, backendNodeId: number): Promise<{ x: number; y: number }> {
    await this.cdp(wc, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined)
    const { model } = await this.cdp<{ model: { content: number[] } }>(wc, 'DOM.getBoxModel', { backendNodeId })
    const q = model.content
    return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 }
  }

  async click(ref: string): Promise<string> {
    return this.control(async (wc) => {
      const r = this.node(ref)
      const { x, y } = await this.center(wc, r.backendNodeId)
      // Don't click through an overlay: name what covers the target instead.
      const { object } = await this.cdp<{ object: { objectId: string } }>(wc, 'DOM.resolveNode', { backendNodeId: r.backendNodeId })
      const hit = await this.cdp<{ result: { value: string } }>(wc, 'Runtime.callFunctionOn', {
        objectId: object.objectId, returnByValue: true, arguments: [{ value: x }, { value: y }],
        functionDeclaration: `function (x, y) {
          if (this.disabled) return 'disabled'
          const el = document.elementFromPoint(x, y)
          if (!el || el === this || this.contains(el) || el.contains(this)) return 'ok'
          const label = (el.getAttribute('aria-label') || el.innerText || el.tagName).replace(/\\s+/g, ' ').trim().slice(0, 60)
          return 'covered:' + (el.closest('[role=dialog],dialog') ? 'a dialog "' + label + '"' : el.tagName.toLowerCase() + ' "' + label + '"')
        }`
      })
      if (hit.result.value === 'disabled') throw new Error(`${r.role} "${r.name}" is disabled; nothing was clicked. Fill in what the form needs first.`)
      if (hit.result.value.startsWith('covered:')) throw new Error(`${r.role} "${r.name}" is covered by ${hit.result.value.slice(8)}; nothing was clicked. Close or answer that first.`)
      const outcome = await this.observe(wc, async () => {
        await this.cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
        await this.cdp(wc, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
        await this.cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      })
      return `Clicked ${r.role} "${r.name}". ${outcome}`
    })
  }

  private async setText(wc: WebContents, backendNodeId: number, text: string, submit: boolean): Promise<void> {
    await this.cdp(wc, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined)
    await this.cdp(wc, 'DOM.focus', { backendNodeId })
    const { object } = await this.cdp<{ object: { objectId: string } }>(wc, 'DOM.resolveNode', { backendNodeId })
    await this.cdp(wc, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () {
        if ('value' in this) { this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })) }
        else if (this.isContentEditable) { this.textContent = '' }
      }`
    })
    await this.cdp(wc, 'Input.insertText', { text })
    if (submit) {
      const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
      await this.cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' })
      await this.cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key })
      await this.settle(wc)
    }
  }

  async type(ref: string, text: string, submit = false): Promise<string> {
    return this.control(async (wc) => {
      const r = this.node(ref)
      if (submit) {
        const outcome = await this.observe(wc, () => this.setText(wc, r.backendNodeId, text, true))
        return `Typed into ${r.role} "${r.name}" and pressed Enter. ${outcome}`
      }
      await this.setText(wc, r.backendNodeId, text, false)
      // Report what the field shows now (autocomplete and masks can change it).
      const { object } = await this.cdp<{ object: { objectId: string } }>(wc, 'DOM.resolveNode', { backendNodeId: r.backendNodeId })
      const v = await this.cdp<{ result: { value: string } }>(wc, 'Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true, functionDeclaration: 'function () { return String(this.value ?? this.textContent ?? "") }' }).catch(() => ({ result: { value: text } }))
      const shown = v.result.value
      return `Typed into ${r.role} "${r.name}".${shown !== text && !r.password ? ` The field now shows "${shown.slice(0, 120)}".` : ''}`
    })
  }

  /** Types a vault value. The caller has already checked the field and origin; the value never leaves this method. */
  async fillSecretValue(ref: string, value: string): Promise<void> {
    await this.control(async (wc) => {
      const r = this.node(ref)
      await this.setText(wc, r.backendNodeId, value, false)
    })
  }

  async scroll(direction: 'up' | 'down', amount = 1): Promise<string> {
    return this.control(async (wc) => {
      const px = Math.round(600 * amount) * (direction === 'up' ? -1 : 1)
      const pos = await this.cdp<{ result: { value: string } }>(wc, 'Runtime.evaluate', {
        expression: `window.scrollBy(0, ${px}); JSON.stringify([Math.round(scrollY), Math.round(document.documentElement.scrollHeight - innerHeight)])`,
        returnByValue: true
      })
      const [y, max] = JSON.parse(pos.result.value) as number[]
      return `Scrolled ${direction}. Position ${y} of ${max}px${y >= max ? ' (bottom)' : y <= 0 ? ' (top)' : ''}.`
    })
  }

  async screenshot(): Promise<string> {
    return this.control(async (wc) => {
      if (this.controlCssKey) {
        await wc.removeInsertedCSS(this.controlCssKey).catch(() => undefined)
        this.controlCssKey = null
      }
      const img = await wc.capturePage()
      if (img.isEmpty()) throw new Error('The page has not drawn yet. Wait a moment, or use snapshot or get_text instead.')
      const { width } = img.getSize()
      const sized = width > 1280 ? img.resize({ width: 1280 }) : img
      return `data:image/jpeg;base64,${sized.toJPEG(70).toString('base64')}`
    })
  }

  async getText(): Promise<string> {
    return this.control(async (wc) => {
      const r = await this.cdp<{ result: { value: string } }>(wc, 'Runtime.evaluate', { expression: 'document.documentElement ? document.documentElement.outerHTML : (document.body ? document.body.outerHTML : "")', returnByValue: true })
      const { title, text } = readable(r.result.value ?? '', wc.getURL())
      return `# ${title}\n${wc.getURL()}\n\n${text}`
    })
  }

  /**
   * A human check (CAPTCHA, "verify you are human") on the page, if any. SahilBot never solves these:
   * the browser comes forward so the user can, and the agent waits.
   */
  async humanCheck(): Promise<string | null> {
    const wc = this.view?.webContents
    if (!wc || wc.isDestroyed()) return null
    try {
      const r = await this.cdp<{ result: { value: string | null } }>(wc, 'Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => {
          const srcs = [...document.querySelectorAll('iframe')].map((f) => f.src || '').join(' ').toLowerCase()
          if (srcs.includes('recaptcha')) return 'reCAPTCHA'
          if (srcs.includes('hcaptcha')) return 'hCaptcha'
          if (srcs.includes('challenges.cloudflare.com') || srcs.includes('turnstile') || document.querySelector('.cf-turnstile, #challenge-form, #cf-challenge-running')) return 'Cloudflare check'
          if (srcs.includes('arkoselabs') || srcs.includes('funcaptcha')) return 'Arkose check'
          const t = (document.title + ' ' + (document.body ? document.body.innerText.slice(0, 3000) : '')).toLowerCase()
          const phrases = ['verify you are human', 'verify that you are human', 'verify you are a human', "i'm not a robot", 'i am not a robot', 'are you a robot', 'complete the security check', 'press and hold', 'unusual traffic from your computer']
          if (phrases.some((p) => t.includes(p))) return 'human check'
          return null
        })()`
      })
      return r.result.value
    } catch {
      return null
    }
  }

  /** Bring the browser panel forward for the user (e.g. to complete a human check). */
  showToUser(): void {
    this.requestOpen?.()
  }

  listTabs(): string {
    const s = this.state()
    if (!s.tabs.length) return 'No tabs open.'
    return s.tabs.map((t) => `${t.index + 1}. ${t.index === s.active ? '(active) ' : ''}${t.title} — ${t.url}`).join('\n')
  }
}
