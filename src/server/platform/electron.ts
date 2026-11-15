// The `electron` module on SahilBot Server: the part of Electron's main-process API that SahilBot uses,
// implemented for a headless Node process. The server build aliases `electron` to this file, so the Mac
// app's main process (src/main/index.ts and everything it loads) runs unchanged.
//
//   ipcMain          → the RPC registry (src/main/rpc.ts), served to paired browsers over the WebSocket
//   the main window  → every connected browser (webContents.send reaches them; focus = a visible tab)
//   safeStorage      → AES-256-GCM under the server's master key (../secrets.ts)
//   Notification     → paired devices (in-page, queued for offline ones, Web Push)
//   shell.openExternal → asks the browser to open the link (never opens anything on the server)
//   shell.trashItem  → moves into <data>/trash (recoverable), never deletes
//   dialogs, screen, Touch ID, accessibility, global shortcuts, the tray, the menu → "not here" answers
// Anything not listed answers with a harmless no-op, so a rarely used Mac-only call can't crash the server.

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { registerHandler, unregisterHandler, type RpcContext } from '../../main/rpc'
import { host } from '../host'

export const SERVER_ONLY_MESSAGE = 'This needs the SahilBot Mac app; it is not available on SahilBot Server.'

/** A function-shaped no-op: calls return undefined, and any property is another no-op (never a thenable). */
function inert(): any {
  const fn = function () { return undefined }
  return new Proxy(fn, {
    get: (_t, p) => (p === 'then' || p === Symbol.toPrimitive || p === Symbol.iterator ? undefined : p === 'toString' ? () => '' : inert()),
    apply: () => undefined,
    construct: () => inert()
  })
}

/** An object whose unknown members are no-ops (known ones behave). */
function lenient<T extends object>(o: T): T {
  return new Proxy(o, {
    get: (t, p, r) => (p in t || typeof p === 'symbol' || p === 'then' ? Reflect.get(t, p, r) : inert())
  })
}

// ------------------------------------------------------------------ app

const paths = new Map<string, string>()
let readyResolve: () => void = () => undefined
const readyPromise = new Promise<void>((r) => { readyResolve = r })
let isReadyFlag = false
let appName = 'SahilBot'

class App extends EventEmitter {
  isPackaged = false
  dock = undefined
  commandLine = lenient({ appendSwitch: () => undefined, hasSwitch: () => false, getSwitchValue: () => '' })
  whenReady(): Promise<void> { return readyPromise }
  isReady(): boolean { return isReadyFlag }
  getPath(name: string): string {
    const set = paths.get(name)
    if (set) return set
    const data = host.dataDir || join(homedir(), '.sahilbot-server')
    switch (name) {
      case 'home': return homedir()
      case 'appData': return join(data, 'appData')
      case 'userData': return data
      case 'sessionData': return join(data, 'session')
      case 'temp': return tmpdir()
      case 'logs': return join(data, 'logs')
      case 'crashDumps': return join(data, 'crashes')
      case 'downloads': return existsSync(join(homedir(), 'Downloads')) ? join(homedir(), 'Downloads') : join(data, 'downloads')
      case 'desktop': return join(homedir(), 'Desktop')
      case 'documents': return join(homedir(), 'Documents')
      case 'exe': return process.execPath
      case 'module': return process.execPath
      default: return join(data, name)
    }
  }
  setPath(name: string, p: string): void { paths.set(name, p) }
  getName(): string { return appName }
  setName(n: string): void { appName = n }
  getVersion(): string { return host.version }
  getLocale(): string { return (process.env.LANG ?? 'en-US').split('.')[0].replace('_', '-') || 'en-US' }
  getSystemLocale(): string { return this.getLocale() }
  getPreferredSystemLanguages(): string[] { return [this.getLocale()] }
  requestSingleInstanceLock(): boolean { return true }
  releaseSingleInstanceLock(): void { /* the server holds its own lock */ }
  quit(): void { host.quit() }
  exit(code = 0): void { process.exit(code) }
  relaunch(): void { /* systemd / launchd / Docker restart the service */ }
  focus(): void { /* no screen */ }
  hide(): void { /* no screen */ }
  show(): void { /* no screen */ }
  getAppMetrics(): Array<{ pid: number; type: string; cpu: { percentCPUUsage: number }; memory: { workingSetSize: number } }> {
    return [{ pid: process.pid, type: 'Browser', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: Math.round(process.memoryUsage().rss / 1024) } }]
  }
  getLoginItemSettings(): { openAtLogin: boolean; wasOpenedAtLogin: boolean; status: 'not-registered' } { return { openAtLogin: false, wasOpenedAtLogin: false, status: 'not-registered' } }
  setLoginItemSettings(): void { /* the service manager starts the server */ }
  setAsDefaultProtocolClient(): boolean { return false }
  isDefaultProtocolClient(): boolean { return false }
  removeAsDefaultProtocolClient(): boolean { return false }
  setAboutPanelOptions(): void { /* no menu */ }
  setAppUserModelId(): void { /* Windows only */ }
  getGPUFeatureStatus(): Record<string, string> { return {} }
  disableHardwareAcceleration(): void { /* no GPU work */ }
}

export const app = lenient(new App())

/** Called by the server once its own pieces are up: main-process code waiting on whenReady() starts. */
export function markReady(): void {
  isReadyFlag = true
  host.ready = true
  readyResolve()
}

// ------------------------------------------------------------------ web contents and windows

const defaultSession: any = lenient({
  setPermissionRequestHandler: () => undefined,
  setPermissionCheckHandler: () => undefined,
  setDevicePermissionHandler: () => undefined,
  setDisplayMediaRequestHandler: () => undefined,
  setProxy: () => Promise.resolve(),
  clearCache: () => Promise.resolve(),
  clearStorageData: () => Promise.resolve(),
  setUserAgent: () => undefined,
  getUserAgent: () => 'SahilBot-Server',
  setSpellCheckerEnabled: () => undefined,
  on: () => undefined,
  once: () => undefined,
  removeListener: () => undefined,
  webRequest: lenient({ onBeforeRequest: () => undefined, onHeadersReceived: () => undefined, onBeforeSendHeaders: () => undefined }),
  protocol: lenient({ handle: () => undefined, unhandle: () => undefined, isProtocolHandled: () => false }),
  cookies: lenient({ get: () => Promise.resolve([]), set: () => Promise.resolve(), remove: () => Promise.resolve(), flushStore: () => Promise.resolve() }),
  fetch: (input: any, init?: any) => netFetch(input, init)
})


let nextId = 1

class WebContentsShim extends EventEmitter {
  readonly id = nextId++
  private destroyed = false
  /** Messages reach the paired browsers (only the main app window's page lives there). */
  ui = false
  readonly mainFrame = lenient({ url: '', frames: [], send: () => undefined })
  readonly session = defaultSession
  readonly debugger = lenient({ attach: () => undefined, detach: () => undefined, isAttached: () => false, sendCommand: () => Promise.reject(new Error(SERVER_ONLY_MESSAGE)), on: () => undefined })
  readonly navigationHistory = lenient({ canGoBack: () => false, canGoForward: () => false })
  send(channel: string, ...args: unknown[]): void { if (this.ui && !this.destroyed) host.ui.send(channel, args) }
  isDestroyed(): boolean { return this.destroyed }
  isLoading(): boolean { return false }
  isCrashed(): boolean { return false }
  isFocused(): boolean { return this.ui && host.ui.focused() }
  getURL(): string { return '' }
  getTitle(): string { return 'SahilBot' }
  loadURL(): Promise<void> { return Promise.resolve() }
  loadFile(): Promise<void> { return Promise.resolve() }
  executeJavaScript(): Promise<never> { return Promise.reject(new Error(SERVER_ONLY_MESSAGE)) }
  printToPDF(): Promise<never> { return Promise.reject(new Error(`Making PDFs and page previews needs a browser engine: ${SERVER_ONLY_MESSAGE} Create a Word (.docx) or Markdown document instead.`)) }
  capturePage(): Promise<never> { return Promise.reject(new Error(SERVER_ONLY_MESSAGE)) }
  setWindowOpenHandler(): void { /* links open in the user's own browser */ }
  setUserAgent(): void { /* no page */ }
  getUserAgent(): string { return 'SahilBot-Server' }
  setAudioMuted(): void { /* no page */ }
  setZoomFactor(): void { /* no page */ }
  focus(): void { /* no page */ }
  stop(): void { /* no page */ }
  reload(): void { /* no page */ }
  close(): void { this.destroy() }
  destroy(): void { if (!this.destroyed) { this.destroyed = true; this.emit('destroyed') } }
  openDevTools(): void { /* no page */ }
  closeDevTools(): void { /* no page */ }
  setBackgroundThrottling(): void { /* no page */ }
  insertCSS(): Promise<string> { return Promise.resolve('') }
  postMessage(): void { /* no page */ }
}

const windows = new Set<BrowserWindowShim>()

class BrowserWindowShim extends EventEmitter {
  readonly id = nextId++
  readonly webContents: WebContentsShim
  readonly contentView = lenient({ addChildView: () => undefined, removeChildView: () => undefined, children: [] as unknown[] })
  private destroyed = false
  private bounds = { x: 0, y: 0, width: 1320, height: 860 }
  private title = 'SahilBot'
  private shown = false

  constructor(opts: Record<string, any> = {}) {
    super()
    this.webContents = lenient(new WebContentsShim())
    if (opts.width) this.bounds.width = opts.width
    if (opts.height) this.bounds.height = opts.height
    if (opts.title) this.title = opts.title
    windows.add(this)
    setImmediate(() => { this.emit('ready-to-show'); this.webContents.emit('did-finish-load') })
  }

  static getAllWindows(): BrowserWindowShim[] { return [...windows].filter((w) => !w.isDestroyed()) }
  static getFocusedWindow(): BrowserWindowShim | null { return [...windows].find((w) => w.isFocused()) ?? null }
  static fromWebContents(wc: unknown): BrowserWindowShim | null { return [...windows].find((w) => w.webContents === wc) ?? null }
  static fromId(id: number): BrowserWindowShim | null { return [...windows].find((w) => w.id === id) ?? null }

  /** The app's own page (renderer/index.html, not Quick Ask) is what the paired browsers show. */
  loadFile(file: string, o?: { hash?: string }): Promise<void> {
    if (/renderer[\\/]index\.html$/.test(String(file)) && !o?.hash) this.webContents.ui = true
    return Promise.resolve()
  }
  loadURL(url: string): Promise<void> {
    if (/\/index\.html$|:\d+\/?$/.test(String(url)) && !String(url).includes('#')) this.webContents.ui = true
    return Promise.resolve()
  }
  isDestroyed(): boolean { return this.destroyed }
  destroy(): void { this.close() }
  close(): void {
    if (this.destroyed) return
    this.emit('close', { preventDefault: () => undefined })
    this.destroyed = true
    windows.delete(this)
    this.webContents.destroy()
    this.emit('closed')
  }
  show(): void { this.shown = true; this.emit('show') }
  showInactive(): void { this.show() }
  hide(): void { this.shown = false; this.emit('hide') }
  focus(): void { /* the browser decides */ }
  blur(): void { /* the browser decides */ }
  isVisible(): boolean { return this.webContents.ui ? host.ui.connected() : this.shown }
  isFocused(): boolean { return this.webContents.ui && host.ui.focused() }
  isMinimized(): boolean { return false }
  isMaximized(): boolean { return false }
  isFullScreen(): boolean { return false }
  isAlwaysOnTop(): boolean { return false }
  restore(): void { /* no screen */ }
  minimize(): void { /* no screen */ }
  maximize(): void { /* no screen */ }
  getBounds(): { x: number; y: number; width: number; height: number } { return { ...this.bounds } }
  getContentBounds(): { x: number; y: number; width: number; height: number } { return { ...this.bounds } }
  setBounds(b: Partial<{ x: number; y: number; width: number; height: number }>): void { this.bounds = { ...this.bounds, ...b } }
  getSize(): [number, number] { return [this.bounds.width, this.bounds.height] }
  getContentSize(): [number, number] { return this.getSize() }
  setSize(width: number, height: number): void { this.bounds = { ...this.bounds, width, height } }
  getPosition(): [number, number] { return [this.bounds.x, this.bounds.y] }
  setPosition(x: number, y: number): void { this.bounds = { ...this.bounds, x, y } }
  getTitle(): string { return this.title }
  setTitle(t: string): void { this.title = t }
  getNativeWindowHandle(): Buffer { return Buffer.alloc(8) }
  getMediaSourceId(): string { return '' }
}

export const BrowserWindow = BrowserWindowShim

class WebContentsViewShim {
  readonly webContents = lenient(new WebContentsShim())
  setBounds(): void { /* no screen */ }
  getBounds(): { x: number; y: number; width: number; height: number } { return { x: 0, y: 0, width: 0, height: 0 } }
  setVisible(): void { /* no screen */ }
  setBackgroundColor(): void { /* no screen */ }
  setBorderRadius(): void { /* no screen */ }
}
export const WebContentsView = new Proxy(WebContentsViewShim, { construct: (T) => lenient(new T()) })
export const BrowserView = WebContentsView

// ------------------------------------------------------------------ ipcMain → the RPC registry

/** What a handler registered on ipcMain sees as the event: the paired browser is the main window's page. */
function eventFor(ctx: RpcContext): Record<string, unknown> {
  const ui = [...windows].find((w) => w.webContents.ui && !w.isDestroyed())
  const sender = (ctx.transport === 'ws' && ui) ? ui.webContents : lenient(new WebContentsShim())
  return { sender, senderFrame: sender.mainFrame, frameId: 0, processId: 0, deviceId: ctx.deviceId, returnValue: undefined, reply: () => undefined }
}

const directOn = new EventEmitter()
host.sends = directOn

export const ipcMain = lenient({
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void {
    registerHandler(channel, (ctx, ...args) => fn(eventFor(ctx), ...args))
  },
  handleOnce(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void {
    registerHandler(channel, (ctx, ...args) => { unregisterHandler(channel); return fn(eventFor(ctx), ...args) })
  },
  removeHandler(channel: string): void { unregisterHandler(channel) },
  on(channel: string, fn: (...a: any[]) => void) { directOn.on(channel, fn); return ipcMain },
  once(channel: string, fn: (...a: any[]) => void) { directOn.once(channel, fn); return ipcMain },
  removeListener(channel: string, fn: (...a: any[]) => void) { directOn.removeListener(channel, fn); return ipcMain },
  off(channel: string, fn: (...a: any[]) => void) { directOn.removeListener(channel, fn); return ipcMain },
  removeAllListeners(channel?: string) { directOn.removeAllListeners(channel); return ipcMain },
  emit: (channel: string, ...args: unknown[]) => directOn.emit(channel, ...args)
})

// ------------------------------------------------------------------ sessions, protocols, network

export const session = lenient({ defaultSession, fromPartition: () => defaultSession, fromPath: () => defaultSession })
export const protocol = lenient({
  registerSchemesAsPrivileged: () => undefined,
  handle: (scheme: string, fn: (req: Request) => Response | Promise<Response>) => { host.protocols.set(scheme, fn) },
  unhandle: (scheme: string) => { host.protocols.delete(scheme) },
  isProtocolHandled: (scheme: string) => host.protocols.has(scheme)
})

/** Electron's net.fetch also reads file: URLs (the attachment protocol serves files through it). */
async function netFetch(input: any, init?: any): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? '')
  if (url.startsWith('file:')) {
    const { fileURLToPath } = await import('node:url')
    const { createReadStream, statSync } = await import('node:fs')
    const { Readable } = await import('node:stream')
    const p = fileURLToPath(url)
    const st = statSync(p)
    return new Response(Readable.toWeb(createReadStream(p)) as unknown as ReadableStream, { status: 200, headers: { 'Content-Length': String(st.size) } })
  }
  return fetch(input, init)
}
export const net = lenient({ fetch: netFetch, isOnline: () => true, online: true })

// ------------------------------------------------------------------ secrets

export const safeStorage = {
  isEncryptionAvailable: (): boolean => host.safeStorage.isEncryptionAvailable(),
  encryptString: (s: string): Buffer => host.safeStorage.encryptString(s),
  decryptString: (b: Buffer): string => host.safeStorage.decryptString(b),
  isAsyncEncryptionAvailable: (): Promise<boolean> => Promise.resolve(host.safeStorage.isEncryptionAvailable()),
  getSelectedStorageBackend: (): string => host.safeStorage.getSelectedStorageBackend(),
  setUsePlainTextEncryption: (): void => undefined
}

// ------------------------------------------------------------------ notifications

class NotificationShim extends EventEmitter {
  static isSupported(): boolean { return true }
  constructor(private o: { title?: string; body?: string; subtitle?: string } = {}) { super() }
  show(): void {
    const title = String(this.o.title ?? 'SahilBot')
    const kind = /question/i.test(title) ? 'question' : /needs you/i.test(title) ? 'needs-you' : /problem/i.test(title) ? 'error' : /done/i.test(title) ? 'done' : 'info'
    const threadId = host.noteThread
    host.ui.notify('all', { title, body: this.o.body ?? this.o.subtitle, kind, threadId, tag: threadId ? `${kind}:${threadId}` : undefined })
    this.emit('show')
  }
  close(): void { this.emit('close') }
}
export const Notification = NotificationShim

// ------------------------------------------------------------------ shell, clipboard, dialogs

let clip = ''
export const clipboard = lenient({
  readText: (): string => clip,
  writeText: (t: string): void => { clip = String(t) },
  clear: (): void => { clip = '' },
  readHTML: (): string => '',
  writeHTML: (): void => undefined,
  readImage: () => nativeImage.createEmpty(),
  availableFormats: (): string[] => (clip ? ['text/plain'] : [])
})

export const shell = lenient({
  /** Links the server would open go to the user's browser instead (http, https and mailto only). */
  openExternal: async (url: string): Promise<void> => {
    if (/^(https?:|mailto:)/i.test(String(url))) host.ui.send('server:open-url', [String(url)])
  },
  openPath: async (): Promise<string> => SERVER_ONLY_MESSAGE,
  showItemInFolder: (): void => undefined,
  /** Recoverable: moved into the data folder's trash, never deleted. */
  trashItem: async (p: string): Promise<void> => {
    const dir = join(host.dataDir || tmpdir(), 'trash')
    mkdirSync(dir, { recursive: true })
    renameSync(p, join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${basename(p)}`))
  },
  beep: (): void => undefined,
  readShortcutLink: () => ({}),
  writeShortcutLink: () => false
})

export const dialog = lenient({
  showOpenDialog: async (): Promise<{ canceled: true; filePaths: string[] }> => ({ canceled: true, filePaths: [] }),
  showOpenDialogSync: (): undefined => undefined,
  showSaveDialog: async (): Promise<{ canceled: true; filePath: undefined }> => ({ canceled: true, filePath: undefined }),
  showSaveDialogSync: (): undefined => undefined,
  /** Answers with the cancel button (or the default), as if the user dismissed it. */
  showMessageBox: async (a: any, b?: any): Promise<{ response: number; checkboxChecked: boolean }> => {
    const o = (b ?? a ?? {}) as { cancelId?: number; defaultId?: number }
    return { response: o.cancelId ?? o.defaultId ?? 0, checkboxChecked: false }
  },
  showMessageBoxSync: (a: any, b?: any): number => { const o = (b ?? a ?? {}) as { cancelId?: number; defaultId?: number }; return o.cancelId ?? o.defaultId ?? 0 },
  showErrorBox: (title: string, content: string): void => { console.error(`[dialog] ${title}: ${content}`) },
  showCertificateTrustDialog: async (): Promise<void> => undefined
})

// ------------------------------------------------------------------ images

interface ImageShim {
  isEmpty(): boolean
  toDataURL(): string
  toPNG(): Buffer
  toJPEG(): Buffer
  toBitmap(): Buffer
  getSize(): { width: number; height: number }
  resize(o: unknown): ImageShim
  crop(o: unknown): ImageShim
  getAspectRatio(): number
  setTemplateImage(v: boolean): void
  isTemplateImage(): boolean
  addRepresentation(o: unknown): void
}

/** Images: PNG and JPEG bytes pass through untouched (no resizing on the server). */
function imageOf(buf: Buffer | null, mime = 'image/png'): ImageShim {
  const size = (): { width: number; height: number } => {
    if (!buf || buf.length < 24) return { width: 0, height: 0 }
    if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    return { width: 0, height: 0 }
  }
  const self: ImageShim = {
    isEmpty: () => !buf || buf.length === 0,
    toDataURL: () => (buf ? `data:${mime};base64,${buf.toString('base64')}` : 'data:image/png;base64,'),
    toPNG: () => (buf && mime === 'image/png' ? buf : Buffer.alloc(0)),
    toJPEG: () => (buf && mime === 'image/jpeg' ? buf : Buffer.alloc(0)),
    toBitmap: () => Buffer.alloc(0),
    getSize: size,
    resize: () => self,
    crop: () => self,
    getAspectRatio: () => { const s = size(); return s.height ? s.width / s.height : 1 },
    setTemplateImage: () => undefined,
    isTemplateImage: () => false,
    addRepresentation: () => undefined
  }
  return self
}

const sniff = (b: Buffer): string | null => (b.length > 4 && b.readUInt32BE(0) === 0x89504e47 ? 'image/png' : b.length > 3 && b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : null)

export const nativeImage = lenient({
  createEmpty: (): ImageShim => imageOf(null),
  createFromBuffer: (b: Buffer): ImageShim => { const m = sniff(Buffer.from(b)); return m ? imageOf(Buffer.from(b), m) : imageOf(null) },
  createFromPath: (p: string): ImageShim => {
    try {
      const b = readFileSync(p)
      const m = sniff(b)
      return m ? imageOf(b, m) : imageOf(null)
    } catch { return imageOf(null) }
  },
  createFromDataURL: (u: string): ImageShim => {
    const m = /^data:(image\/(?:png|jpeg));base64,(.*)$/.exec(String(u))
    return m ? imageOf(Buffer.from(m[2], 'base64'), m[1]) : imageOf(null)
  },
  createThumbnailFromPath: async (): Promise<ImageShim> => imageOf(null)
})

// ------------------------------------------------------------------ the machine: screen, power, preferences

const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, workAreaSize: { width: 1920, height: 1080 }, scaleFactor: 1, rotation: 0, internal: false, touchSupport: 'unknown', label: 'none' }
const screenEvents = new EventEmitter()
export const screen = lenient(Object.assign(screenEvents, {
  getPrimaryDisplay: () => display,
  getAllDisplays: () => [display],
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: () => display,
  getDisplayMatching: () => display,
  screenToDipPoint: (p: unknown) => p,
  dipToScreenPoint: (p: unknown) => p
}))

const powerEvents = new EventEmitter()
export const powerMonitor = lenient(Object.assign(powerEvents, {
  getSystemIdleTime: (): number => 0,
  getSystemIdleState: (): string => 'active',
  isOnBatteryPower: (): boolean => false,
  onBatteryPower: false,
  getCurrentThermalState: (): string => 'nominal'
}))

let blockerId = 0
const blockers = new Set<number>()
export const powerSaveBlocker = lenient({
  // A server doesn't sleep; nothing to block.
  start: (): number => { const id = ++blockerId; blockers.add(id); return id },
  stop: (id: number): boolean => blockers.delete(id),
  isStarted: (id: number): boolean => blockers.has(id)
})

export const systemPreferences = lenient({
  isTrustedAccessibilityClient: (): boolean => false,
  getMediaAccessStatus: (): string => 'denied',
  askForMediaAccess: async (): Promise<boolean> => false,
  canPromptTouchID: (): boolean => false,
  promptTouchID: async (): Promise<never> => { throw new Error('Touch ID is not available on SahilBot Server.') },
  getAnimationSettings: () => ({ shouldRenderRichAnimation: false, scrollAnimationsEnabledBySystem: false, prefersReducedMotion: true }),
  getUserDefault: (): undefined => undefined,
  getAccentColor: (): string => 'ff6a1aff',
  getColor: (): string => '#000000',
  getSystemColor: (): string => '#000000',
  on: (): void => undefined,
  subscribeNotification: (): number => 0,
  unsubscribeNotification: (): void => undefined
})

export const nativeTheme = lenient(Object.assign(new EventEmitter(), { shouldUseDarkColors: false, themeSource: 'system', shouldUseHighContrastColors: false, shouldUseInvertedColorScheme: false }))

export const globalShortcut = lenient({
  register: (): boolean => false,
  registerAll: (): void => undefined,
  unregister: (): void => undefined,
  unregisterAll: (): void => undefined,
  isRegistered: (): boolean => false
})

// ------------------------------------------------------------------ menus and the tray (nothing to show)

class MenuShim {
  items: unknown[] = []
  static buildFromTemplate(t: unknown[]): MenuShim { const m = new MenuShim(); m.items = t; return m }
  static setApplicationMenu(): void { /* no menu bar */ }
  static getApplicationMenu(): null { return null }
  popup(): void { /* no screen */ }
  closePopup(): void { /* no screen */ }
  append(i: unknown): void { this.items.push(i) }
  getMenuItemById(): null { return null }
}
export const Menu = MenuShim
export class MenuItem { constructor(readonly options: unknown) {} }

class TrayShim extends EventEmitter {
  setImage(): void { /* no menu bar */ }
  setPressedImage(): void { /* no menu bar */ }
  setToolTip(): void { /* no menu bar */ }
  setTitle(): void { /* no menu bar */ }
  setContextMenu(): void { /* no menu bar */ }
  popUpContextMenu(): void { /* no menu bar */ }
  closeContextMenu(): void { /* no menu bar */ }
  destroy(): void { /* no menu bar */ }
  isDestroyed(): boolean { return false }
  getBounds(): { x: number; y: number; width: number; height: number } { return { x: 0, y: 0, width: 0, height: 0 } }
}
export const Tray = new Proxy(TrayShim, { construct: (T) => lenient(new T()) })

// ------------------------------------------------------------------ renderer-side names (never used in main)

export const contextBridge = lenient({ exposeInMainWorld: () => undefined })
export const ipcRenderer = inert()
export const webUtils = lenient({ getPathForFile: () => '' })
export const webFrame = inert()
export const crashReporter = lenient({ start: () => undefined })
export const autoUpdater = lenient(new EventEmitter())
export const desktopCapturer = lenient({ getSources: async () => [] })
export const utilityProcess = lenient({ fork: () => { throw new Error(SERVER_ONLY_MESSAGE) } })
export const inAppPurchase = inert()
export const TouchBar = inert()
export const pushNotifications = inert()
export const ShareMenu = inert()

const electron = {
  app, BrowserWindow, BrowserView, WebContentsView, ipcMain, session, protocol, net, safeStorage, Notification,
  clipboard, shell, dialog, nativeImage, screen, powerMonitor, powerSaveBlocker, systemPreferences, nativeTheme,
  globalShortcut, Menu, MenuItem, Tray, contextBridge, ipcRenderer, webUtils, webFrame, crashReporter, autoUpdater,
  desktopCapturer, utilityProcess, inAppPurchase, TouchBar, pushNotifications, ShareMenu
}
export default electron
