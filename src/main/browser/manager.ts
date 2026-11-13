import { existsSync, mkdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { BrowserWindow, WebContentsView, session as electronSession, type Rectangle, type Session, type WebContents } from 'electron'
import type { BrowserState, TeachStep } from '@shared/types'
import { readable } from '../agent/tools/web'
import { TeachRecorder } from './teach'
import { COMMERCE_FN, COOKIE_SCRIPT, PAGE_LIB, SHOT_MASK_CSS, cardValuesFor, countryNames, fillAddressScript, fillCardScript, isProcessorHost, locateCardScript, maskScript, pickTotal, regionNames, splitItem, type CardValues, type Money } from './checkout'

/** Size the page renders at while the panel is closed (a typical laptop viewport). */
const PARK = { width: 1280, height: 860 }

export interface RefInfo {
  backendNodeId: number
  role: string
  name: string
  password?: boolean
  inputType?: string
  /** A card field (number, cvc, exp, month, year, name): its value is never shown. */
  payment?: string
  /** The element's tag (links: whether it's a real <a>). */
  tag?: string
  /** Links: the resolved href. */
  href?: string
  /** Links: a real <a href> to another http(s) page (plain navigation). False for "#", "javascript:", non-<a>. */
  navLink?: boolean
}

/** Where a value may be typed: the tab (webContents id) and page origin seen when the step was decided. */
export interface Expected { tab: number; origin: string }

/** One frame to run a helper in: its CDP frame id, URL, and the session that owns it (OOPIF frames). */
interface FrameTarget { frameId: string; url: string; sessionId?: string; top: boolean }

/** What the page holds for a purchase decision, read from the live DOM (never from the model). */
export interface PageCommerce {
  url: string
  title: string
  total: Money | null
  items: Array<{ name: string; price?: string }>
  payFields: number
  payFilled: boolean
  payFrames: string[]
  target: { label: string; tag: string; type: string; submit: boolean; inPayForm: boolean; formFilled: boolean; cardField: string; navLink?: boolean } | null
}

/** A download a page offered: never saved without the user's OK. */
export interface OfferedDownload { url: string; filename: string; size: number; mime: string; host: string; at: number }

interface AXValue { value?: unknown }
interface AXNode {
  nodeId: string
  ignored?: boolean
  role?: AXValue
  name?: AXValue
  value?: AXValue
  description?: AXValue
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

/** Card fields stay dots in screenshots (a card the user typed, or one SahilBot filled). */
const MASK_CSS = SHOT_MASK_CSS
/** Helper scripts run in this isolated world: page scripts can't see or hook anything in it. */
const WORLD = 'sahilbot-helpers'

/** All visible text, including inside open shadow roots (web components). */
const DEEP_TEXT = `(() => {
  let t = document.body ? document.body.innerText : ''
  const visit = (r) => r.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) { t += '\\n' + (el.shadowRoot.textContent || '').replace(/\\s+/g, ' '); visit(el.shadowRoot) } })
  if (document.body) visit(document.body)
  return t
})()`

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
  /** Refs from the snapshot before the current one (and refs dropped by a navigation), to find a stale ref again. */
  private stale = new Map<string, RefInfo>()
  /** Card fields and totals seen on the current page (for the synchronous purchase check). */
  private commerceCache: { url: string; payFields: number; payFilled: boolean } | null = null
  /** Saved card numbers (digits). Set by main; used by the guard that keeps them from leaving without an approved purchase. */
  cardNumbers: () => string[] = () => []
  /** Until when an approved purchase step may send card details (ms since epoch), and to which merchant. */
  private purchaseUntil = 0
  private purchaseOrigin = ''
  /** Tabs where SahilBot put a saved card into the page (until that tab navigates): webContents id → page origin. */
  private cardInDom = new Map<number, string>()
  /** Card numbers seen leaving over a WebSocket (can't be stopped once the socket is open; reported). */
  private wsLeaks: string[] = []
  /** Last real user input (mouse/key) per tab, for telling user-opened popups from script-opened ones. */
  private userInputAt = new Map<number, number>()
  /** CDP sessions of out-of-process frames (payment iframes) per tab: sessionId → targetId. */
  private frameSessions = new Map<number, Map<string, string>>()
  /** Isolated-world execution contexts per tab: "sessionId|frameId" → contextId. */
  private worlds = new Map<number, Map<string, number>>()
  private lastAgentAt = 0
  private blockedCard: string[] = []
  /** Downloads pages offered (newest last); none is saved until the user approves it. */
  private offered: OfferedDownload[] = []
  private allowDownload: { url: string; path: string; done: (state: string) => void } | null = null
  /** One-time codes typed recently: hidden from every result for 10 minutes. */
  private codes: Array<{ value: string; until: number }> = []
  /** Requests in flight per tab (for "network idle"). */
  private inflight = new Map<number, Map<string, number>>()
  /** "Teach a task": records the user's own steps in the browser panel. */
  readonly teach = new TeachRecorder(() => this.publish(), (wc) => this.tabs.findIndex((t) => t.webContents === wc) + 1)

  constructor(private win: () => BrowserWindow | null, private emit: (s: BrowserState) => void, private requestOpen?: () => void) {
    this.ses = electronSession.fromPartition('persist:foreman-browser')
    // Sites don't get the camera, mic, location or notifications, and nothing downloads silently.
    this.ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    this.ses.on('will-download', (e, item, wc) => {
      // The one download the user approved (downloads op=save) goes to the path they saw.
      const allowed = this.allowDownload
      if (allowed && item.getURL() === allowed.url) {
        this.allowDownload = null
        item.setSavePath(allowed.path)
        item.once('done', (_ev, state) => allowed.done(state))
        return
      }
      // A recording notes the download (still blocked) as a step.
      if (this.teach.recording) { try { this.teach.download(wc, item.getFilename(), item.getURL()) } catch { /* item gone */ } }
      try {
        const url = item.getURL()
        this.offered = [...this.offered.filter((d) => d.url !== url), { url, filename: item.getFilename(), size: item.getTotalBytes(), mime: item.getMimeType(), host: hostOf(url), at: Date.now() }].slice(-10)
      } catch { /* item gone */ }
      e.preventDefault()
    })
    // Saved card numbers never leave this browser while SahilBot is acting, unless the user approved
    // that purchase step on a Purchase card (see checkout.ts). The user's own typing is never blocked.
    this.ses.webRequest.onBeforeRequest((d, cb) => {
      let cancel = false
      try { cancel = this.carriesCard(d) } catch { cancel = false }
      if (cancel) this.blockedCard.push(hostOf(d.url))
      cb(cancel ? { cancel: true } : {})
    })
  }

  /** Card details may go to the merchant whose purchase step was approved, and to payment processors. */
  private cardDestinationOk(url: string, merchant: string): boolean {
    const host = hostOf(url).replace(/:\d+$/, '')
    if (host && isProcessorHost(host)) return true
    const o = originOf(url.replace(/^ws(s?):/i, 'http$1:'))
    return !!merchant && o === merchant
  }

  private carriesCard(d: Electron.OnBeforeRequestListenerDetails): boolean {
    if (this.takenOver) return false
    const now = Date.now()
    const inWindow = now < this.purchaseUntil
    const agentActive = this.controlling || now - this.lastAgentAt <= 5000
    const domOrigin = d.webContentsId !== undefined ? this.cardInDom.get(d.webContentsId) : undefined
    if (!inWindow && !agentActive && !domOrigin) return false
    const merchant = inWindow ? this.purchaseOrigin : domOrigin ?? ''
    // A new WebSocket while a saved card sits in the page: only to the merchant or a payment processor.
    if (d.resourceType === 'webSocket') return !!(domOrigin || inWindow) && !this.cardDestinationOk(d.url, merchant || domOrigin || '')
    if (d.method === 'GET' && d.url.length < 40) return false
    const numbers = this.cardNumbers()
    if (!numbers.length) return false
    const body = (d.uploadData ?? []).map((u) => (u.bytes ? Buffer.from(u.bytes).toString('latin1') : '')).join('')
    if (!containsCard(`${d.url}\n${body}`, numbers)) return false
    // During an approved step (or the user's own submit after SahilBot filled the card): the merchant
    // and payment processors only. While SahilBot is acting outside an approved step: nowhere.
    if (inWindow) return !this.cardDestinationOk(d.url, this.purchaseOrigin)
    if (agentActive) return true
    return !this.cardDestinationOk(d.url, domOrigin ?? '')
  }

  /** An approved purchase step is running: card details may be sent until shortly after it ends. */
  openPurchaseWindow(merchantOrigin?: string): void {
    this.purchaseUntil = Date.now() + 10 * 60_000
    this.purchaseOrigin = merchantOrigin ?? originOf(this.pageUrl())
  }

  closePurchaseWindow(graceMs = 20_000): void {
    this.purchaseUntil = Date.now() + graceMs
  }

  /** Hosts the card guard stopped since the last call. */
  takeBlockedCard(): string[] {
    const out = [...new Set(this.blockedCard)]
    this.blockedCard = []
    return out
  }

  /** Hosts a saved card number went to over an already-open WebSocket (seen, but not stoppable), since the last call. */
  takeCardLeaks(): string[] {
    const out = [...new Set(this.wsLeaks)]
    this.wsLeaks = []
    return out
  }

  /** Identifies the active tab (purchase bookkeeping per tab). */
  tabKey(): number {
    return this.view?.webContents.id ?? -1
  }

  // ------------------------------------------------------------- tabs & view

  private get view(): WebContentsView | undefined {
    return this.tabs[this.active]
  }

  wc(): WebContents {
    if (!this.view) this.newTab()
    return this.view!.webContents
  }

  /** SahilBot is acting in the browser right now (or just was). */
  private agentActing(): boolean {
    return this.controlling || Date.now() - this.lastAgentAt < 2500
  }

  newTab(url?: string, o: { background?: boolean } = {}): number {
    if (url) url = safeUrl(url)
    const view = new WebContentsView({ webPreferences: { session: this.ses, sandbox: true, contextIsolation: true, backgroundThrottling: false } })
    const wc = view.webContents
    wc.setWindowOpenHandler(({ url: u }) => {
      // A popup only takes over the active tab when the user just clicked or typed in this tab and
      // SahilBot isn't acting. Script-opened popups (no gesture), and any popup while the agent works,
      // open as background tabs: a page can't swap the tab a code or card is about to be typed into.
      const gesture = Date.now() - (this.userInputAt.get(wc.id) ?? 0) < 1500 && !this.agentActing()
      try { this.newTab(u, { background: !gesture }) } catch { /* not a web page */ }
      return { action: 'deny' }
    })
    wc.on('input-event', (_e, input) => {
      if (/^(mouseDown|keyDown|rawKeyDown|char|gestureTap)$/.test(String(input.type)) && !this.agentActing()) this.userInputAt.set(wc.id, Date.now())
    })
    // A new document: the card SahilBot filled (and isolated worlds) are gone with the old one.
    wc.on('did-navigate', () => {
      this.cardInDom.delete(wc.id)
      this.worlds.delete(wc.id)
    })
    wc.on('did-frame-navigate', () => this.worlds.delete(wc.id))
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
      // Requests in flight, for waiting until the network goes quiet after an action.
      void wc.debugger.sendCommand('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }).catch(() => undefined)
      // Out-of-process frames (payment providers' iframes) get their own sessions, for helper scripts.
      void wc.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined)
    } catch {
      /* already attached */
    }
    const id = wc.id
    const live = new Map<string, number>()
    this.inflight.set(id, live)
    const sessions = new Map<string, string>()
    this.frameSessions.set(id, sessions)
    const sockets = new Map<string, string>()
    wc.once('destroyed', () => { this.inflight.delete(id); this.frameSessions.delete(id); this.worlds.delete(id); this.cardInDom.delete(id); this.userInputAt.delete(id) })
    // Page dialogs (alert/confirm/prompt) wait for the agent or the user; never auto-accepted.
    wc.debugger.on('message', (_e, method, params: { type?: string; message?: string; defaultPrompt?: string; requestId?: string; sessionId?: string; targetInfo?: { type?: string; targetId?: string }; url?: string; response?: { payloadData?: string } }, sessionId?: string) => {
      if (method === 'Target.attachedToTarget' && params.sessionId && params.targetInfo?.type === 'iframe') {
        sessions.set(params.sessionId, params.targetInfo.targetId ?? '')
        // Nested out-of-process frames attach to their parent frame's session.
        void wc.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, params.sessionId).catch(() => undefined)
        return
      }
      if (method === 'Target.detachedFromTarget' && params.sessionId) { sessions.delete(params.sessionId); this.worlds.get(id)?.forEach((_v, k) => { if (k.startsWith(`${params.sessionId}|`)) this.worlds.get(id)?.delete(k) }); return }
      // Card numbers over an already-open WebSocket can't be stopped, only seen and reported.
      if (method === 'Network.webSocketCreated' && params.requestId) sockets.set(params.requestId, hostOf(params.url ?? ''))
      if (method === 'Network.webSocketFrameSent' && this.cardInDom.has(id)) {
        const payload = String(params.response?.payloadData ?? '')
        if (payload && containsCard(payload, this.cardNumbers())) this.wsLeaks.push(sockets.get(params.requestId ?? '') || 'a WebSocket')
      }
      if (sessionId) return
      if (method === 'Page.javascriptDialogOpening') this.dialog = { type: params.type ?? 'alert', message: params.message ?? '', defaultPrompt: params.defaultPrompt }
      if (method === 'Page.javascriptDialogClosed') this.dialog = null
      if (method === 'Network.requestWillBeSent' && params.requestId && (params as { type?: string }).type !== 'EventSource' && (params as { type?: string }).type !== 'WebSocket') live.set(params.requestId, Date.now())
      if ((method === 'Network.loadingFinished' || method === 'Network.loadingFailed') && params.requestId) live.delete(params.requestId)
    })
    this.tabs.push(view)
    if (this.teach.recording) {
      // The first tab opening is just the browser starting; later ones are steps.
      if (this.tabs.length > 1) this.teach.record(null, { kind: 'tab', op: 'new', tab: this.tabs.length, url: url ?? 'about:blank', at: 0 })
      void this.teach.attach(wc)
    }
    // A background tab (a popup the page opened by itself) never becomes the active tab on its own.
    if (o.background && this.view) this.publish()
    else this.switchTab(this.tabs.length - 1, true)
    if (url) void wc.loadURL(url).catch(() => undefined)
    return this.tabs.length - 1
  }

  switchTab(i: number, quiet = false): void {
    if (!this.tabs[i]) throw new Error(`No tab ${i + 1}`)
    if (this.view) this.detach(this.view)
    if (!quiet && i !== this.active) this.teach.record(null, { kind: 'tab', op: 'switch', tab: i + 1, title: this.tabs[i].webContents.getTitle(), at: 0 })
    this.active = i
    this.dropRefs()
    this.attach()
    this.publish()
  }

  closeTab(i: number): void {
    const t = this.tabs[i]
    if (!t) throw new Error(`No tab ${i + 1}`)
    this.teach.record(null, { kind: 'tab', op: 'close', tab: i + 1, at: 0 })
    this.teach.forget(t.webContents)
    if (this.view) this.detach(this.view)
    t.webContents.close()
    this.tabs.splice(i, 1)
    if (i < this.active) this.active--
    this.active = Math.max(0, Math.min(this.active, this.tabs.length - 1))
    if (!this.tabs.length) this.active = -1
    this.dropRefs()
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
      takenOver: this.takenOver,
      teach: this.teach.state()
    }
  }

  private publish(): void {
    this.emit(this.state())
  }

  // ------------------------------------------------------------- user control

  userNavigate(url: string): void {
    const u = /^[a-z]+:\/\//i.test(url) ? url : /\s/.test(url) || !url.includes('.') ? `https://duckduckgo.com/?q=${encodeURIComponent(url)}` : `https://${url}`
    const wc = this.wc()
    this.teach.record(wc, { kind: 'navigate', cause: 'address', url: u, at: 0 })
    void wc.loadURL(u).catch(() => undefined)
  }

  private history(op: 'back' | 'forward' | 'reload'): void {
    if (this.view) this.teach.record(this.view.webContents, { kind: 'history', op, at: 0 })
  }

  back(): void { this.history('back'); this.view?.webContents.navigationHistory.goBack() }
  forward(): void { this.history('forward'); this.view?.webContents.navigationHistory.goForward() }
  reload(): void { this.history('reload'); this.view?.webContents.reload() }

  // ------------------------------------------------------------- teach a task

  /** Starts recording the user's steps in every open tab (and tabs opened while it runs). */
  async teachStart(by: 'user' | 'agent' = 'user', o: { name?: string; threadId?: string } = {}): Promise<void> {
    await this.teach.start({ by, tabs: this.tabs.map((t) => t.webContents).filter((wc) => !wc.isDestroyed()), ...o })
    // Where the lesson starts: the page that's open now.
    const wc = this.view?.webContents
    if (wc && !wc.isDestroyed() && /^https?:/i.test(wc.getURL())) this.teach.record(wc, { kind: 'navigate', cause: 'address', url: wc.getURL(), at: 0 })
  }

  teachStop(): { steps: number; text: string } {
    const r = this.teach.stop()
    return { steps: r.steps.length, text: r.text }
  }

  /** For the bot: stops and returns the steps themselves. */
  teachSteps(): TeachStep[] {
    return this.teach.stop().steps
  }

  teachCancel(): void {
    this.teach.cancel()
  }

  teachCompose(name: string, goal?: string): { text: string; note: string; threadId?: string } {
    return this.teach.compose(name, goal)
  }

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
    this.lastAgentAt = Date.now()
    // The bot's own clicks and typing aren't part of a lesson being recorded.
    this.teach.hold()
    try {
      if (!this.controlCssKey && !wc.isLoading()) this.controlCssKey = await wc.insertCSS(CONTROL_CSS).catch(() => null)
      return await fn(wc)
    } finally {
      this.lastAgentAt = Date.now()
      this.teach.release()
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

  private cdp<T = any>(wc: WebContents, method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    return (sessionId ? wc.debugger.sendCommand(method, params, sessionId) : wc.debugger.sendCommand(method, params)) as Promise<T>
  }

  // ------------------------------------------------------------- helper scripts in isolated worlds
  // Card filling, the purchase read-out, the overlay check and code filling run in an isolated world
  // (Page.createIsolatedWorld) of each frame: they share the page's DOM but none of its JavaScript, so a
  // page can't hook a setter, elementFromPoint or a prototype to watch or steer them.

  /** Every frame of a tab: the top document, same-process frames, and out-of-process frames via their sessions. */
  private async frameTargets(wc: WebContents): Promise<FrameTarget[]> {
    type Tree = { frame: { id: string; url: string; urlFragment?: string }; childFrames?: Tree[] }
    const out = new Map<string, FrameTarget>()
    const walk = (t: Tree, sessionId: string | undefined, top: boolean): void => {
      out.set(t.frame.id, { frameId: t.frame.id, url: t.frame.url + (t.frame.urlFragment ?? ''), sessionId, top })
      for (const c of t.childFrames ?? []) walk(c, sessionId, false)
    }
    try {
      const { frameTree } = await this.cdp<{ frameTree: Tree }>(wc, 'Page.getFrameTree')
      walk(frameTree, undefined, true)
    } catch { /* page gone */ }
    // Frames in other processes: their own session owns them (and their same-process children).
    for (const sid of this.frameSessions.get(wc.id)?.keys() ?? []) {
      try {
        const { frameTree } = await this.cdp<{ frameTree: Tree }>(wc, 'Page.getFrameTree', {}, sid)
        walk(frameTree, sid, false)
      } catch { /* detached */ }
    }
    return [...out.values()]
  }

  /** The isolated world's execution context in a frame (created once per document). */
  private async worldOf(wc: WebContents, t: Pick<FrameTarget, 'frameId' | 'sessionId'>, fresh = false): Promise<number> {
    const cache = this.worlds.get(wc.id) ?? new Map<string, number>()
    this.worlds.set(wc.id, cache)
    const key = `${t.sessionId ?? ''}|${t.frameId}`
    if (!fresh && cache.has(key)) return cache.get(key)!
    const { executionContextId } = await this.cdp<{ executionContextId: number }>(wc, 'Page.createIsolatedWorld', { frameId: t.frameId, worldName: WORLD, grantUniveralAccess: false }, t.sessionId)
    cache.set(key, executionContextId)
    return executionContextId
  }

  /** Evaluates an expression in a frame's isolated world. Null if the frame can't run it. */
  private async isoEval<T>(wc: WebContents, t: Pick<FrameTarget, 'frameId' | 'sessionId'>, expression: string): Promise<T | null> {
    for (const fresh of [false, true]) {
      try {
        const contextId = await this.worldOf(wc, t, fresh)
        const r = await this.cdp<{ result: { value?: T }; exceptionDetails?: unknown }>(wc, 'Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true }, t.sessionId)
        if (r.exceptionDetails) return null
        return (r.result.value ?? null) as T | null
      } catch {
        // A stale context (the frame navigated): make a new world once.
      }
    }
    return null
  }

  /** The top document's frame id. */
  private async mainFrameId(wc: WebContents): Promise<string> {
    const { frameTree } = await this.cdp<{ frameTree: { frame: { id: string } } }>(wc, 'Page.getFrameTree')
    return frameTree.frame.id
  }

  /** An element (by backendNodeId, top document) as an object in the isolated world. */
  private async isoNode(wc: WebContents, backendNodeId: number): Promise<string> {
    const frameId = await this.mainFrameId(wc)
    for (const fresh of [false, true]) {
      try {
        const executionContextId = await this.worldOf(wc, { frameId }, fresh)
        const { object } = await this.cdp<{ object: { objectId: string } }>(wc, 'DOM.resolveNode', { backendNodeId, executionContextId })
        return object.objectId
      } catch (e) {
        if (fresh) throw e
      }
    }
    throw new Error('element is gone')
  }

  /** Calls a function with `this` = the element, in the isolated world. */
  private async isoCall<T>(wc: WebContents, backendNodeId: number, functionDeclaration: string, args: Array<{ value?: unknown; objectId?: string }> = []): Promise<T> {
    const objectId = await this.isoNode(wc, backendNodeId)
    const r = await this.cdp<{ result: { value: T }; exceptionDetails?: { text?: string } }>(wc, 'Runtime.callFunctionOn', { objectId, functionDeclaration, arguments: args, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'helper failed')
    return r.result.value
  }

  /** Refuses when the active tab or its site changed since the step was decided (a popup took focus, a redirect). */
  private checkExpected(wc: WebContents, e?: Expected): void {
    if (!e) return
    if (wc.id !== e.tab || originOf(wc.getURL()) !== e.origin) {
      throw new Error(`The active tab changed (now ${originOf(wc.getURL()) || 'another page'}, expected ${e.origin}), so nothing was typed. Snapshot and check which tab is open before trying again.`)
    }
  }

  /** The tab and origin a value may go to, as of now (for fills decided before an approval card). */
  expectation(): Expected {
    return { tab: this.tabKey(), origin: originOf(this.pageUrl()) }
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
    // Then for the network to go quiet (XHR after a click), briefly: long polls don't hold it up.
    const netBy = Date.now() + 2500
    while (Date.now() < netBy && !this.dialog && this.busyRequests(wc) > 0) await sleep(100)
  }

  /** Requests still loading on a tab (ignoring ones open for over 8s: streams and long polls). */
  private busyRequests(wc: WebContents): number {
    const live = this.inflight.get(wc.id)
    if (!live) return 0
    const now = Date.now()
    let n = 0
    for (const [k, t] of live) { if (now - t > 8000) live.delete(k); else n++ }
    return n
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
    const tabsBefore = this.tabs.length
    const offeredBefore = this.offered.at(-1)?.at ?? 0
    const outcome = await this.observeOne(wc, act, tabsBefore)
    const extra: string[] = []
    const dl = this.offered.filter((d) => d.at > offeredBefore)
    if (dl.length) extra.push(`The page offered ${dl.length === 1 ? 'a download' : `${dl.length} downloads`}: ${dl.map((d) => `"${d.filename}"${d.size > 0 ? ` (${fmtBytes(d.size)})` : ''}`).join(', ')}. Nothing was saved. To keep it, use the downloads action (op "save"); the user approves first.`)
    return [outcome, ...extra].join(' ')
  }

  private async observeOne(wc: WebContents, act: () => Promise<void>, tabsBefore: number): Promise<string> {
    const beforeUrl = wc.getURL()
    const beforeN = await this.mutations(wc)
    const beforeDoc = await this.docId(wc)
    await act()
    await this.settle(wc)
    // A link or script opened a new tab (popups open as tabs). While SahilBot acts they open in the
    // background: the active tab stays this one until the agent switches on purpose.
    if (this.tabs.length > tabsBefore) {
      if (this.view && this.view.webContents !== wc) {
        const nw = this.view.webContents
        await this.settle(nw)
        return `The page opened a new tab (tab ${this.active + 1}: ${nw.getURL() || 'loading'}), and it's now the active tab. Snapshot to see it; tabs op=switch goes back.`
      }
      const i = this.tabs.length - 1
      const nw = this.tabs[i].webContents
      await this.settle(nw, 4000)
      return `The page opened a new tab in the background (tab ${i + 1}: ${nw.getURL() || 'loading'}). This tab is still the active one; use tabs op=switch index=${i + 1} to look at it.`
    }
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
      this.dropRefs()
      const cookies = await this.dismissCookies(wc)
      return `Navigated to ${afterUrl}. Refs are now stale: snapshot to see the new page.${cookies}`
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

  /** Forgets the current refs, keeping them to find a stale ref's element again. */
  private dropRefs(): void {
    if (this.refs.size) this.stale = new Map(this.refs)
    this.refs.clear()
  }

  async navigate(url: string): Promise<string> {
    return this.control(async (wc) => {
      this.dropRefs()
      try {
        await wc.loadURL(url)
      } catch (e) {
        // Redirects and aborted sub-loads reject loadURL but still land on a page.
        if (!wc.getURL() || wc.getURL() === 'about:blank') throw new Error(`Could not open ${url}: ${(e as Error).message}`)
      }
      await this.settle(wc)
      const cookies = await this.dismissCookies(wc)
      return `Opened ${wc.getURL()} — "${wc.getTitle()}".${cookies}`
    }).then(async (head) => {
      // Saves a step: the start of the page comes back with the navigation.
      const snap = await this.snapshot()
      const lines = snap.split('\n')
      return `${head}\n${lines.slice(0, 80).join('\n')}${lines.length > 80 ? `\n[… ${lines.length - 80} more lines: call snapshot for the full page]` : ''}`
    })
  }

  /** The element a ref names: from the current snapshot, or (if the page moved on) the one before it. */
  refInfo(ref: string): RefInfo | undefined {
    return this.refs.get(ref) ?? this.stale.get(ref)
  }

  /**
   * A ref that still points at a live element. A stale one (the page re-rendered or navigated) is found
   * again by role and name in a fresh snapshot, once, and the note says so.
   */
  async ensureRef(ref: string): Promise<{ ref: string; note?: string }> {
    const cur = this.refs.get(ref)
    if (cur && (await this.alive(cur.backendNodeId))) return { ref }
    const info = cur ?? this.stale.get(ref)
    if (!info) throw new Error(`Unknown ref "${ref}". Refs change when the page changes: call snapshot again and use a ref from it.`)
    await this.snapshot()
    const hits = [...this.refs].filter(([, x]) => x.role === info.role && x.name === info.name)
    if (hits.length !== 1) throw new Error(`Ref ${ref} (${info.role} "${info.name.slice(0, 60)}") is gone from the page${hits.length > 1 ? ' and matches several elements now' : ''}. Call snapshot and use a ref from it.`)
    return { ref: hits[0][0], note: `(${ref} was stale, so a fresh snapshot was taken and ${hits[0][0]}, the same ${info.role} "${info.name.slice(0, 60)}", was used. Other refs changed too: snapshot before using them.)` }
  }

  private async alive(backendNodeId: number): Promise<boolean> {
    const wc = this.view?.webContents
    if (!wc || wc.isDestroyed()) return false
    try {
      const { object } = await this.cdp<{ object: { objectId: string } }>(wc, 'DOM.resolveNode', { backendNodeId })
      const r = await this.cdp<{ result: { value: boolean } }>(wc, 'Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true, functionDeclaration: 'function () { return this.isConnected }' })
      return !!r.result.value
    } catch {
      return false
    }
  }

  pageUrl(): string {
    return this.view?.webContents.getURL() ?? ''
  }

  async snapshot(): Promise<string> {
    return this.control(async (wc) => {
      await this.cdp(wc, 'Accessibility.enable')
      const { nodes } = await this.cdp<{ nodes: AXNode[] }>(wc, 'Accessibility.getFullAXTree')
      const byId = new Map(nodes.map((n) => [n.nodeId, n]))
      this.dropRefs()
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
        if (props.has('pressed')) line += ` [pressed=${props.get('pressed')}]`
        if (props.has('expanded')) line += ` [${props.get('expanded') ? 'expanded' : 'collapsed'}]`
        if (props.get('selected')) line += ' [selected]'
        if (props.get('disabled')) line += ' [disabled]'
        if (props.get('readonly')) line += ' [read-only]'
        if (props.get('required')) line += ' [required]'
        if (props.get('invalid') && props.get('invalid') !== 'false') line += ' [invalid]'
        if (props.get('haspopup') && props.get('haspopup') !== 'false' && role !== 'combobox') line += ` [opens ${props.get('haspopup') === 'true' ? 'menu' : props.get('haspopup')}]`
        if (props.get('focused')) line += ' [focused]'
        const desc = String(node.description?.value ?? '').replace(/\s+/g, ' ').trim()
        if (desc && desc !== name && INTERACTIVE.has(role)) line += ` (${desc.slice(0, 100)})`
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
          const attr = (k: string): string => (attrs.includes(k) ? String(attrs[attrs.indexOf(k) + 1] ?? '') : '')
          const type = attr('type')
          const info = this.refs.get(t.ref)!
          info.inputType = attrs.includes('type') ? type : 'text'
          if (type === 'password') info.password = true
          const pay = cardFieldKind(attr('autocomplete'), [attr('name'), attr('id'), attr('placeholder'), attr('aria-label'), info.name].join(' '), attrs.includes('data-sb-pay'))
          if (pay && type !== 'password') info.payment = pay
          if (/one-time-code/i.test(attr('autocomplete')) || attrs.includes('data-sb-otp')) info.payment = 'one-time code'
        } catch {
          /* node went away */
        }
      }
      // Links: whether each is a real <a href> to another page (plain navigation) or acts like a button.
      const here = wc.getURL()
      await Promise.all([...this.refs.values()].filter((r) => r.role === 'link').map(async (info) => {
        try {
          const { node } = await this.cdp<{ node: { nodeName?: string; attributes?: string[] } }>(wc, 'DOM.describeNode', { backendNodeId: info.backendNodeId })
          const attrs = node.attributes ?? []
          let href: string | undefined
          for (let i = 0; i + 1 < attrs.length; i += 2) if (attrs[i].toLowerCase() === 'href') href = attrs[i + 1]
          info.tag = String(node.nodeName ?? '').toLowerCase()
          info.href = href
          info.navLink = navLinkOf(info.tag, href, here)
        } catch {
          info.navLink = false
        }
      }))
      const out = lines.map((l) => l.replace(/value="\{\{(\d+)\}\}"/, (_m, id: string) => {
        const ref = [...this.refs.entries()].find(([, r]) => r.backendNodeId === Number(id))
        if (ref?.[1].password) return 'value="••••••" (password)'
        if (ref?.[1].payment === 'one-time code') return 'value="••••" (code hidden)'
        if (ref?.[1].payment && ref[1].payment !== 'name') return 'value="••••" (card details hidden)'
        return `value="${(valueOf.get(Number(id)) ?? '').slice(0, 120)}"`
      })).map((l) => {
        const m = l.match(/\[ref=(e\d+)\]/)
        const r = m ? this.refs.get(m[1]) : undefined
        if (r?.password && !l.includes('(password)')) return `${l} (password field)`
        if (r?.payment === 'one-time code') return l.includes('(code hidden)') ? l : `${l} (one-time code field: use fill_otp)`
        if (r?.payment && !l.includes('(card details hidden)')) return `${l} (card field: ${r.payment === 'cvc' ? 'security code' : r.payment === 'number' ? 'card number' : r.payment})`
        if (r && r.inputType && !['text', 'search', ''].includes(r.inputType) && !r.password && (r.role === 'textbox' || r.role === 'spinbutton')) return `${l} [${r.inputType}]`
        return l
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
      // Card fields: on the page, or inside a payment provider's frame the snapshot can't see into.
      const cards = [...this.refs.values()].filter((r) => r.payment)
      const frames = await this.processorFrames(wc)
      this.commerceCache = { url: wc.getURL(), payFields: cards.length + frames.length, payFilled: (this.commerceCache?.url === wc.getURL() && this.commerceCache.payFilled) || cards.some((r) => r.payment === 'number' && valueOf.has(r.backendNodeId) && (valueOf.get(r.backendNodeId) ?? '').replace(/\D/g, '').length >= 12) }
      const pay = cards.length || frames.length ? `\nThis page takes card details${frames.length ? ` (in a secure frame from ${[...new Set(frames)].join(', ')})` : ''}: use fill_payment with a saved card; never type card numbers.` : ''
      const head = `Page: "${wc.getTitle()}" ${wc.getURL()}${dlg}${pay}\nRefs are valid until the page changes. * = new since the last snapshot.\n`
      return head + (out.length ? out.join('\n') : '(page has no accessible content yet)') + (lines.length > MAX_LINES ? '\n[… snapshot cut at 600 lines; scroll or use get_text]' : '')
    })
  }

  private async clickables(wc: WebContents, known: Set<number>): Promise<Array<{ id: number; name: string }>> {
    try {
      const { result } = await this.cdp<{ result: { objectId?: string } }>(wc, 'Runtime.evaluate', {
        expression: `(() => { const all = []; const visit = (r) => { r.querySelectorAll('*').forEach((el) => { all.push(el); if (el.shadowRoot) visit(el.shadowRoot) }) }; if (document.body) visit(document.body); return all })().filter((el) => {
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
      // Don't click through an overlay: name what covers the target instead. The hit test is CDP's
      // (DOM.getNodeForLocation, compared by backendNodeId) and the comparison runs in the isolated
      // world, so a page can't fake elementFromPoint to make a covered target look clickable.
      const hit = { result: { value: await this.hitTest(wc, r.backendNodeId, x, y) } }
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

  /** 'ok', 'disabled', or 'covered:<what>' for a click at (x, y) on the element. */
  private async hitTest(wc: WebContents, backendNodeId: number, x: number, y: number): Promise<string> {
    const COMPARE = `function (other) {
      if (this.disabled) return 'disabled'
      let o = other
      if (o && o.nodeType === 3) o = o.parentNode
      if (!o) return 'ok'
      // Inside or around the target, across open shadow roots.
      const within = (a, b) => { for (let n = a; n; n = n.parentNode || n.host) if (n === b) return true; return false }
      if (o === this || within(o, this) || within(this, o)) return 'ok'
      const el = o.nodeType === 1 ? o : o.parentElement
      if (!el) return 'ok'
      const label = (el.getAttribute('aria-label') || el.innerText || el.tagName).replace(/\\s+/g, ' ').trim().slice(0, 60)
      return 'covered:' + (el.closest('[role=dialog],dialog') ? 'a dialog "' + label + '"' : el.tagName.toLowerCase() + ' "' + label + '"')
    }`
    // CDP's hit test, by backendNodeId (tried in viewport and in document coordinates, since which one
    // Chromium expects has varied). A match means nothing covers the target.
    const scroll = await this.isoCall<{ x: number; y: number }>(wc, backendNodeId, 'function () { return { x: window.scrollX, y: window.scrollY } }').catch(() => ({ x: 0, y: 0 }))
    const points = [{ x, y }, ...(scroll.x || scroll.y ? [{ x: x + scroll.x, y: y + scroll.y }] : [])]
    for (const pt of points) {
      let hitId: number | undefined
      for (let attempt = 0; attempt < 2 && hitId === undefined; attempt++) {
        try {
          hitId = (await this.cdp<{ backendNodeId: number }>(wc, 'DOM.getNodeForLocation', { x: Math.round(pt.x), y: Math.round(pt.y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false })).backendNodeId
        } catch {
          if (attempt === 0) await this.cdp(wc, 'DOM.enable').catch(() => undefined)
        }
      }
      if (hitId === undefined) continue
      if (hitId === backendNodeId) return this.isoCall<string>(wc, backendNodeId, 'function () { return this.disabled ? "disabled" : "ok" }')
      const other = await this.isoNode(wc, hitId).catch(() => undefined)
      const v = other ? await this.isoCall<string>(wc, backendNodeId, COMPARE, [{ objectId: other }]).catch(() => '') : ''
      if (v === 'ok' || v === 'disabled') return v
    }
    // Otherwise the isolated world's own elementFromPoint decides (and names the cover): the page's
    // scripts can't replace it there.
    return this.isoCall<string>(wc, backendNodeId, `function (x, y) { return (${COMPARE}).call(this, document.elementFromPoint(x, y)) }`, [{ value: x }, { value: y }])
  }

  private async setText(wc: WebContents, backendNodeId: number, text: string, submit: boolean): Promise<void> {
    await this.cdp(wc, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined)
    await this.cdp(wc, 'DOM.focus', { backendNodeId })
    await this.isoCall(wc, backendNodeId, `function () {
        if ('value' in this) { this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })) }
        else if (this.isContentEditable) { this.textContent = '' }
      }`)
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

  /** Presses Enter in a field (the text is already typed): a separate step so a purchase can be checked in between. */
  async pressEnter(ref: string): Promise<string> {
    return this.control(async (wc) => {
      const r = this.node(ref)
      const outcome = await this.observe(wc, async () => {
        await this.cdp(wc, 'DOM.focus', { backendNodeId: r.backendNodeId })
        const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
        await this.cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' })
        await this.cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key })
      })
      return `Pressed Enter in ${r.role} "${r.name}". ${outcome}`
    })
  }

  /** Types a vault value. The caller has already checked the field and origin; the value never leaves this method. */
  async fillSecretValue(ref: string, value: string, expected?: Expected): Promise<void> {
    await this.control(async (wc) => {
      this.checkExpected(wc, expected)
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
      // Card and one-time-code fields show as dots: marked and masked in every frame (payment iframes too).
      const mask = await wc.insertCSS(MASK_CSS).catch(() => null)
      const frames = await this.frameTargets(wc).catch(() => [] as FrameTarget[])
      await Promise.all(frames.map((t) => this.isoEval(wc, t, maskScript()).catch(() => null)))
      await sleep(80)
      const img = await wc.capturePage().finally(() => {
        if (mask) void wc.removeInsertedCSS(mask).catch(() => undefined)
        for (const t of frames) void this.isoEval(wc, t, maskScript(true)).catch(() => null)
      })
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
      // Web components keep their text in shadow roots, which the page's HTML leaves out.
      const shadow = await this.cdp<{ result: { value?: string } }>(wc, 'Runtime.evaluate', {
        expression: `(() => { let t = ''; const visit = (r) => r.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) { t += ' ' + (el.shadowRoot.textContent || ''); visit(el.shadowRoot) } }); if (document.body) visit(document.body); return t.replace(/\\s+/g, ' ').trim().slice(0, 6000) })()`,
        returnByValue: true
      }).catch(() => ({ result: { value: '' } }))
      const extra = shadow.result.value && !text.includes(shadow.result.value.slice(0, 60)) ? `\n\n[Text inside page components]\n${shadow.result.value}` : ''
      return `# ${title}\n${wc.getURL()}\n\n${text}${extra}`
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
          if (/3d[s_-]?secure|three[_-]?d[_-]?secure|\\/3ds|3ds2|cardinalcommerce|securecode|verifiedbyvisa|hooks\\.stripe\\.com\\/(3d_secure|redirect)|\\/acs[\\/?]/.test(srcs)) return 'bank verification (3-D Secure)'
          const t = (document.title + ' ' + (document.body ? document.body.innerText.slice(0, 3000) : '')).toLowerCase()
          const phrases = ['verify you are human', 'verify that you are human', 'verify you are a human', "i'm not a robot", 'i am not a robot', 'are you a robot', 'complete the security check', 'press and hold', 'unusual traffic from your computer']
          if (phrases.some((p) => t.includes(p))) return 'human check'
          const visibleInput = (i) => i.getClientRects().length && /^(text|tel|number|)$/.test(i.type || '') && !/cc-/.test(i.autocomplete || '')
          const otp = document.querySelector('input[autocomplete="one-time-code"]')
          if (otp && otp.getClientRects().length) return 'verification code'
          const codes = ['verification code', 'one-time code', 'one-time password', 'one time passcode', 'one-time passcode', 'enter the code', 'authentication code', 'two-factor', '2-step verification', 'two-step verification', 'we sent a code', 'sent you a code', 'authenticate this payment', 'confirm this payment with your bank', 'approve this payment in your banking app']
          if (codes.some((p) => t.includes(p)) && [...document.querySelectorAll('input')].some(visibleInput)) return 'verification code'
          return null
        })()`
      })
      return r.result.value
    } catch {
      return null
    }
  }

  // ------------------------------------------------------------- shopping, files, waiting

  /** What the last snapshot or fill saw on this page, for the synchronous purchase check. */
  commerce(): { payFields: boolean; payFilled: boolean } {
    const c = this.commerceCache
    return c && c.url === this.pageUrl() ? { payFields: c.payFields > 0, payFilled: c.payFilled } : { payFields: false, payFilled: false }
  }

  private markPaymentFilled(): void {
    const url = this.pageUrl()
    this.commerceCache = { url, payFields: Math.max(1, this.commerceCache?.url === url ? this.commerceCache.payFields : 1), payFilled: true }
  }

  /** Payment-provider frames on the page (Stripe, Adyen, Braintree…), by host. */
  private async processorFrames(wc: WebContents): Promise<string[]> {
    try {
      return wc.mainFrame.framesInSubtree.map((f) => hostOf(f.url)).filter((h) => h && isProcessorHost(h))
    } catch {
      return []
    }
  }

  /**
   * The page as a purchase sees it: total, order lines, card fields, and (with a ref) the element's own
   * label and form. Read from the live DOM for the Purchase card and its re-check before the click.
   */
  async purchaseContext(ref?: string): Promise<PageCommerce> {
    return this.control(async (wc) => {
      type Raw = { title?: string; totals?: Array<{ label: string; text: string }>; items?: string[]; pay?: { fields: number; filled: boolean; frames: string[] }; target?: PageCommerce['target'] }
      let v: Raw = {}
      const r = ref ? this.refs.get(ref) : undefined
      // Read in the isolated world: the page's own scripts can't fake the total or the button.
      try {
        if (r) v = (await this.isoCall<Raw>(wc, r.backendNodeId, COMMERCE_FN)) ?? {}
        else throw new Error('no target')
      } catch {
        const frameId = await this.mainFrameId(wc).catch(() => '')
        v = (frameId ? await this.isoEval<Raw>(wc, { frameId }, `(${COMMERCE_FN}).call(null)`) : null) ?? {}
      }
      const frames = [...new Set([...(v.pay?.frames ?? []), ...(await this.processorFrames(wc))])]
      const url = wc.getURL()
      const cached = this.commerceCache?.url === url && this.commerceCache.payFilled
      const button = v.target && !/^(input|textarea|select)$/.test(v.target.tag) ? v.target.label : undefined
      return {
        url,
        title: v.title ?? wc.getTitle(),
        total: pickTotal(v.totals ?? [], button),
        items: (v.items ?? []).map(splitItem).filter((x) => x.name).slice(0, 8),
        payFields: (v.pay?.fields ?? 0) + frames.length,
        payFilled: !!v.pay?.filled || cached,
        payFrames: frames,
        target: v.target ?? null
      }
    })
  }

  /**
   * Types a saved card into the page's card fields: the page itself, same-site frames, and payment
   * providers' frames. Frames from any other site are skipped (and reported). First every eligible frame
   * is asked, without any card values, which card fields it has; then only those frames get values, and
   * only the ones their fields need. When a payment provider's frames hold the fields, the page's own
   * frames get nothing. Everything runs in isolated worlds. Returns field kinds only.
   */
  async fillCard(v: CardValues, expected?: Expected): Promise<{ filled: string[]; found: string[]; unreachable: string[] }> {
    return this.control(async (wc) => {
      this.checkExpected(wc, expected)
      const page = originOf(wc.getURL())
      const filled = new Set<string>()
      const found = new Set<string>()
      const unreachable: string[] = []
      const located: Array<{ t: FrameTarget; proc: boolean; kinds: string[] }> = []
      for (const t of await this.frameTargets(wc)) {
        const host = hostOf(t.url)
        const proc = !t.top && isProcessorHost(host.replace(/:\d+$/, ''))
        if (!t.top && originOf(t.url) !== page && !proc) {
          if (/card|pay|checkout|secure|hosted|field|vault/i.test(t.url)) unreachable.push(host)
          continue
        }
        const kinds = (await this.isoEval<string[]>(wc, t, locateCardScript(proc))) ?? []
        if (kinds.length) located.push({ t, proc, kinds })
      }
      const inProcessor = located.filter((x) => x.proc)
      const targets = inProcessor.length ? inProcessor : located
      // The tab didn't change while frames were being looked at.
      this.checkExpected(wc, expected)
      for (const { t, proc, kinds } of targets) {
        kinds.forEach((k) => found.add(k))
        const r = await this.isoEval<{ found?: string[]; filled?: string[] }>(wc, t, fillCardScript(cardValuesFor(kinds, v), proc))
        r?.filled?.forEach((k) => filled.add(k))
      }
      if (filled.has('number')) {
        this.markPaymentFilled()
        this.cardInDom.set(wc.id, page)
      }
      await this.settle(wc)
      return { filled: [...filled], found: [...found], unreachable: [...new Set(unreachable)] }
    })
  }

  /** Types a saved address into the page's shipping (or billing) fields, on this site only. */
  async fillAddress(a: { name: string; line1: string; line2?: string; city: string; region?: string; postal: string; country: string; phone?: string; email?: string }, section: 'shipping' | 'billing', expected?: Expected): Promise<{ filled: string[] }> {
    return this.control(async (wc) => {
      this.checkExpected(wc, expected)
      const page = originOf(wc.getURL())
      const filled = new Set<string>()
      const values = { ...a, countryNames: countryNames(a.country).join('|'), regionNames: a.region ? regionNames(a.region).join('|') : '' }
      for (const t of await this.frameTargets(wc)) {
        if (!t.top && originOf(t.url) !== page) continue
        const r = await this.isoEval<{ filled?: string[] }>(wc, t, fillAddressScript(values, section))
        r?.filled?.forEach((k) => filled.add(k))
      }
      await this.settle(wc)
      return { filled: [...filled] }
    })
  }

  /** Puts files into a file field (the one at the ref, or the one its button or label belongs to). */
  async upload(ref: string, files: string[]): Promise<string> {
    return this.control(async (wc) => {
      const r = this.node(ref)
      const { object } = await this.cdp<{ object: { objectId: string } }>(wc, 'DOM.resolveNode', { backendNodeId: r.backendNodeId })
      const found = await this.cdp<{ result: { objectId?: string } }>(wc, 'Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function () {
          if (this.tagName === 'INPUT' && this.type === 'file') return this
          if (this.control && this.control.type === 'file') return this.control
          let p = this
          for (let i = 0; i < 5 && p && p !== document.body; i++, p = p.parentElement) { const x = p.querySelector && p.querySelector('input[type=file]'); if (x) return x }
          const all = document.querySelectorAll('input[type=file]')
          return all.length === 1 ? all[0] : null
        }`
      })
      if (!found.result.objectId) throw new Error(`No file field near ${r.role} "${r.name}". Snapshot and use the upload button or file field's ref.`)
      const { node } = await this.cdp<{ node: { backendNodeId: number } }>(wc, 'DOM.describeNode', { objectId: found.result.objectId })
      const outcome = await this.observe(wc, async () => { await this.cdp(wc, 'DOM.setFileInputFiles', { files, backendNodeId: node.backendNodeId }) })
      return `Attached ${files.map((f) => `"${basename(f)}"`).join(', ')} to ${r.role} "${r.name}". ${outcome}`
    })
  }

  offeredDownloads(): OfferedDownload[] {
    return [...this.offered]
  }

  /** Saves one offered download (after the user approved it) into `dir`. */
  async saveDownload(index: number, dir: string): Promise<{ path: string; state: string }> {
    const d = this.offered[index]
    if (!d) throw new Error(`No download ${index + 1}. Use downloads op=list.`)
    mkdirSync(dir, { recursive: true })
    const path = uniquePath(dir, safeName(d.filename))
    const wc = this.wc()
    const state = await new Promise<string>((resolve) => {
      const t = setTimeout(() => { this.allowDownload = null; resolve('timed out') }, 120_000)
      this.allowDownload = { url: d.url, path, done: (st) => { clearTimeout(t); resolve(st) } }
      wc.downloadURL(d.url)
    })
    if (state === 'completed') this.offered = this.offered.filter((x) => x !== d)
    return { path, state }
  }

  /** Waits for text to appear, the address to change, or (neither given) the page to go idle. */
  async waitFor(o: { text?: string; url?: string; timeoutMs: number }): Promise<string> {
    return this.control(async (wc) => {
      if (!o.text && !o.url) {
        await this.settle(wc, o.timeoutMs)
        return `The page is idle: "${wc.getTitle()}" ${wc.getURL()}`
      }
      const deadline = Date.now() + o.timeoutMs
      const want = (o.text ?? '').toLowerCase()
      while (Date.now() < deadline) {
        if (o.url && wc.getURL().includes(o.url)) return `The address now contains "${o.url}": ${wc.getURL()}`
        if (want) {
          const r = await this.cdp<{ result: { value?: string } }>(wc, 'Runtime.evaluate', { expression: DEEP_TEXT, returnByValue: true }).catch(() => ({ result: { value: '' } }))
          if ((r.result.value ?? '').toLowerCase().replace(/\s+/g, ' ').includes(want.replace(/\s+/g, ' '))) {
            this.dropRefs()
            return `"${o.text}" is on the page now. Snapshot to act on it.`
          }
        }
        await sleep(250)
      }
      throw new Error(`Waited ${Math.round(o.timeoutMs / 1000)}s: ${o.text ? `"${o.text}" did not appear` : `the address did not change to include "${o.url}"`}. Snapshot to see what the page shows.`)
    })
  }

  /** Scrolls an element into view. */
  async scrollTo(ref: string): Promise<string> {
    return this.control(async (wc) => {
      const r = this.node(ref)
      await this.cdp(wc, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: r.backendNodeId })
      return `Scrolled ${r.role} "${r.name.slice(0, 60)}" into view.`
    })
  }

  /** Values that must never appear in a result (recent one-time codes). */
  hiddenValues(): string[] {
    const now = Date.now()
    this.codes = this.codes.filter((c) => c.until > now)
    return this.codes.map((c) => c.value)
  }

  /**
   * Types a one-time code into the page's code field(s): autocomplete="one-time-code", a field labelled
   * as a code, or a row of one-digit boxes. Same-site frames only. The code is never returned.
   */
  async fillOtp(code: string, expected?: Expected): Promise<{ filled: boolean }> {
    this.codes.push({ value: code, until: Date.now() + 10 * 60_000 })
    return this.control(async (wc) => {
      this.checkExpected(wc, expected)
      const page = originOf(wc.getURL())
      let filled = false
      for (const t of await this.frameTargets(wc)) {
        if (!t.top && originOf(t.url) !== page) continue
        const r = await this.isoEval<boolean>(wc, t, `(() => {
          ${PAGE_LIB}
          const code = ${JSON.stringify(code)}
          const ins = deepAll(document, 'input').filter((el) => shown(el) && !el.disabled && !el.readOnly && /^(text|tel|number|password|)$/.test(el.type || '') && !ccKind(el, false))
          let hits = ins.filter((el) => /one-time-code/i.test(el.getAttribute('autocomplete') || ''))
          if (!hits.length) hits = ins.filter((el) => /one ?time|\\botp\\b|verification|verify|2fa|two ?factor|auth\\w* ?code|passcode|security ?code|\\bcode\\b|\\btoken\\b|\\bpin\\b/.test(hintOf(el)) && !/coupon|promo|gift|discount|zip|postal|search|referral|country/.test(hintOf(el)))
          const boxes = ins.filter((el) => el.maxLength === 1)
          if (boxes.length >= 4 && (!hits.length || hits.every((h) => h.maxLength === 1))) {
            boxes.slice(0, code.length).forEach((el, i) => { setValue(el, code[i]); el.setAttribute('data-sb-otp', '1') })
            return true
          }
          if (!hits.length) return false
          setValue(hits[0], code)
          hits[0].setAttribute('data-sb-otp', '1')
          return true
        })()`)
        if (r) { filled = true; break }
      }
      await this.settle(wc)
      return { filled }
    })
  }

  /** Declines a cookie banner when it offers a privacy-preserving choice; says what happened. */
  private async dismissCookies(wc: WebContents): Promise<string> {
    try {
      const r = await this.cdp<{ result: { value?: { done?: string; acceptOnly?: boolean } } }>(wc, 'Runtime.evaluate', { expression: COOKIE_SCRIPT, returnByValue: true })
      const v = r.result.value ?? {}
      if (v.done) {
        await sleep(250)
        await this.settle(wc, 3000)
        return ` Declined a cookie banner (chose "${v.done}").`
      }
      if (v.acceptOnly) return ' A cookie banner is showing with no reject option; it was left alone.'
    } catch { /* page went away */ }
    return ''
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

export function hostOf(u: string): string {
  try { return new URL(u).host } catch { return '' }
}
function originOf(u: string): string {
  try { return new URL(u).origin } catch { return '' }
}
function fmtBytes(n: number): string {
  return n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`
}
function safeName(name: string): string {
  const n = basename(String(name || 'download')).replace(/[\u0000-\u001f/\\:*?"<>|]+/g, '_').replace(/^\.+/, '').slice(0, 120)
  return n || 'download'
}
function uniquePath(dir: string, name: string): string {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let p = join(dir, name)
  for (let i = 2; existsSync(p) && i < 1000; i++) p = join(dir, `${stem} (${i})${ext}`)
  return p
}

/**
 * Whether an input is a card field, from its autocomplete token and its name/id/label words (the same
 * rules the page scripts use). Card fields never show their value in a snapshot.
 */
export function cardFieldKind(autocomplete: string, hint: string, marked = false): string | undefined {
  const ac = String(autocomplete ?? '').toLowerCase()
  const m = /\bcc-(number|csc|exp-month|exp-year|exp|name|given-name|family-name)\b/.exec(ac)
  if (m) return ({ number: 'number', csc: 'cvc', 'exp-month': 'month', 'exp-year': 'year', exp: 'exp', name: 'name', 'given-name': 'name', 'family-name': 'name' } as Record<string, string>)[m[1]]
  if (!marked && /\b(shipping|billing|street|address|postal|country|tel|email|organization|username|one-time-code)\b/.test(ac)) return undefined
  const h = String(hint ?? '').toLowerCase().replace(/[_-]+/g, ' ')
  if (/name on card|card ?holder|holder ?name|\bcc ?name|nameoncard/.test(h)) return 'name'
  if (/one ?time|\botp\b|2fa|two ?factor|verification code|sign ?in code|code we sent/.test(h)) return marked ? 'card' : undefined
  if (/\bcvc|\bcvv|\bcsc\b|\bcvn\b|security ?code|card ?code|card ?verification/.test(h)) return 'cvc'
  if (/(exp|expir)\w*\s*(date\s*)?month|card ?month/.test(h)) return 'month'
  if (/(exp|expir)\w*\s*(date\s*)?year|card ?year/.test(h)) return 'year'
  if (/\bexp(iry|iration|ires)?\b|\bexp date|mm ?\/ ?yy|valid ?(thru|through)/.test(h)) return 'exp'
  if (/card ?num|\bcc ?num|cardnumber|credit ?card|debit ?card|card ?no\b|number on (the )?card/.test(h)) return 'number'
  return marked ? 'card' : undefined
}

/** A real <a href> to another http(s) page: plain navigation. "#", "javascript:", the same page, or no <a> are not. */
export function navLinkOf(tag: string | undefined, href: string | undefined, pageUrl: string): boolean {
  if (tag !== 'a' || href === undefined || href === null) return false
  try {
    const u = new URL(href, pageUrl || undefined)
    if (!/^https?:$/.test(u.protocol)) return false
    const here = new URL(pageUrl)
    return u.origin + u.pathname + u.search !== here.origin + here.pathname + here.search
  } catch {
    return false
  }
}

/**
 * Whether text carries one of the saved card numbers: in plain digits however they're separated or
 * split across fields (all digits in order), URL-encoded, or inside base64 / base64url tokens.
 */
export function containsCard(text: string, numbers: string[]): boolean {
  const nums = numbers.filter((n) => n.length >= 12)
  if (!nums.length || !text) return false
  const src = text.length > 4_000_000 ? text.slice(0, 4_000_000) : text
  const variants: string[] = [src]
  try { variants.push(decodeURIComponent(src.replace(/\+/g, ' '))) } catch { /* not URL-encoded */ }
  let n = 0
  for (const tok of src.match(/[A-Za-z0-9+/_-]{16,}={0,2}/g) ?? []) {
    if (++n > 400) break
    if (tok.length > 400_000) continue
    try { variants.push(Buffer.from(tok.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1')) } catch { /* not base64 */ }
  }
  return variants.some((v) => { const digits = v.replace(/\D+/g, ''); return nums.some((x) => digits.includes(x)) })
}
