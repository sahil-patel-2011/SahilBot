import { app, BrowserWindow, ipcMain, screen, systemPreferences, type WebContents } from 'electron'
import { join } from 'node:path'
import { contains, type DisplayInfo, type Rect } from './geometry'
import { OverlayController, type Overlay, type OverlayFrame, type OverlayHost, type Point } from './overlay'

// The SahilBot cursor's windows: one transparent, click-through, non-focusable panel per display,
// covering the whole display (menu bar included) at screen-saver level, on every Space and over
// full-screen apps. They exist only once computer use starts and show only while it acts.
//
// Never in the model's screenshots, two ways: setContentProtection(true) (NSWindowSharingNone, which
// `screencapture` and CGWindowList honor) and, because newer macOS ScreenCaptureKit paths can ignore
// that flag, aroundCapture(): the windows go fully transparent while index.ts's captureScreen runs.
//
// The only interactive part is the status pill's Stop button: the window ignores the mouse
// (setIgnoreMouseEvents(true, {forward: true})) except while the pointer is over the pill.

const CHANNEL = 'overlay:action'
const STOP = 'overlay:stop'

type Slot = { win: BrowserWindow; display: DisplayInfo; ready: boolean; pending: unknown[] }

export interface OverlayWindowOptions {
  /** Stop pressed on the pill: stop the run (same as Ctrl+Option+Esc). */
  onStop: () => void
  /** The renderer dev server (ELECTRON_RENDERER_URL) in development. */
  rendererUrl?: string
}

export class OverlayWindows implements OverlayHost {
  private slots = new Map<number, Slot>()
  private active = false
  private pill: { displayId: number; rect: Rect } | null = null
  private hoverTimer: NodeJS.Timeout | null = null
  private hovering: number | null = null
  private hideTimer: NodeJS.Timeout | null = null
  private capturing = 0
  private disposed = false
  private readonly onDisplays = (): void => this.sync()
  private readonly onStopMsg = (e: Electron.IpcMainEvent): void => { if (this.ownsContents(e.sender)) this.o.onStop() }

  constructor(private o: OverlayWindowOptions) {
    ipcMain.on(STOP, this.onStopMsg)
    screen.on('display-added', this.onDisplays)
    screen.on('display-removed', this.onDisplays)
    screen.on('display-metrics-changed', this.onDisplays)
  }

  // ------------------------------------------------------------- OverlayHost

  displays(): DisplayInfo[] {
    try {
      const primary = screen.getPrimaryDisplay().id
      return screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, primary: d.id === primary }))
    } catch { return [] }
  }

  cursor(): Point | undefined {
    try { return screen.getCursorScreenPoint() } catch { return undefined }
  }

  reduceMotion(): boolean {
    try {
      const s = systemPreferences.getAnimationSettings()
      return !!s.prefersReducedMotion || !s.shouldRenderRichAnimation
    } catch { return false }
  }

  render(f: OverlayFrame): void {
    if (this.disposed) return
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null }
    this.sync()
    this.pill = f.pill
    for (const s of this.slots.values()) {
      this.send(s, { type: 'frame', frame: f, origin: { x: s.display.bounds.x, y: s.display.bounds.y }, displayId: s.display.id })
      if (!s.win.isVisible()) s.win.showInactive()
    }
    this.active = true
    this.startHover()
  }

  hide(): void {
    this.active = false
    this.pill = null
    this.stopHover()
    for (const s of this.slots.values()) this.send(s, { type: 'hide' })
    // Let the fade-out play, then take the windows off screen.
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null
      if (this.active) return
      for (const s of this.slots.values()) if (!s.win.isDestroyed() && s.win.isVisible()) s.win.hide()
    }, 220)
  }

  // ------------------------------------------------------------- for index.ts

  /** Creates the windows ahead of the first step (computer use is starting), so the page is loaded. */
  warm(): void {
    if (!this.disposed) this.sync()
  }

  /** An overlay window (SahilBot's "self" checks and window lists leave these out). */
  owns(w: BrowserWindow): boolean {
    for (const s of this.slots.values()) if (s.win === w) return true
    return false
  }

  private ownsContents(wc: WebContents): boolean {
    for (const s of this.slots.values()) if (!s.win.isDestroyed() && s.win.webContents === wc) return true
    return false
  }

  /** Runs a screen capture with the overlay invisible (belt and braces with content protection). */
  async aroundCapture<T>(fn: () => Promise<T>): Promise<T> {
    const shown = [...this.slots.values()].filter((s) => !s.win.isDestroyed() && s.win.isVisible())
    if (!shown.length) return fn()
    this.capturing++
    for (const s of shown) s.win.setOpacity(0)
    // One compositor frame or two so the window server has drawn the change.
    await new Promise((r) => setTimeout(r, 50))
    try {
      return await fn()
    } finally {
      if (--this.capturing === 0) for (const s of shown) if (!s.win.isDestroyed()) s.win.setOpacity(1)
    }
  }

  dispose(): void {
    this.disposed = true
    this.stopHover()
    if (this.hideTimer) clearTimeout(this.hideTimer)
    ipcMain.removeListener(STOP, this.onStopMsg)
    screen.removeListener('display-added', this.onDisplays)
    screen.removeListener('display-removed', this.onDisplays)
    screen.removeListener('display-metrics-changed', this.onDisplays)
    for (const s of this.slots.values()) if (!s.win.isDestroyed()) s.win.destroy()
    this.slots.clear()
  }

  // ------------------------------------------------------------- windows

  /** One window per display: new displays get one, removed ones lose theirs, moved/resized ones follow. */
  private sync(): void {
    if (this.disposed) return
    const ds = this.displays()
    const ids = new Set(ds.map((d) => d.id))
    for (const [id, s] of this.slots) {
      if (!ids.has(id) || s.win.isDestroyed()) {
        if (!s.win.isDestroyed()) s.win.destroy()
        this.slots.delete(id)
      }
    }
    for (const d of ds) {
      const s = this.slots.get(d.id)
      if (!s) { this.slots.set(d.id, this.create(d)); continue }
      const b = s.win.getBounds()
      if (b.x !== d.bounds.x || b.y !== d.bounds.y || b.width !== d.bounds.width || b.height !== d.bounds.height) s.win.setBounds(d.bounds)
      s.display = d
    }
  }

  private create(d: DisplayInfo): Slot {
    const win = new BrowserWindow({
      ...d.bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // An NSPanel: floats over full-screen apps without activating SahilBot.
      type: 'panel',
      // Cover the menu bar too (macOS otherwise keeps windows below it).
      enableLargerThanScreen: true,
      // The Stop button works on the first click even though the panel never becomes key.
      acceptFirstMouse: true,
      roundedCorners: false,
      title: '',
      webPreferences: {
        preload: join(__dirname, '../preload/overlay.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
        devTools: !app.isPackaged
      }
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    win.setIgnoreMouseEvents(true, { forward: true })
    win.setContentProtection(true)
    win.excludedFromShownWindowsMenu = true
    win.setBounds(d.bounds)
    win.on('page-title-updated', (e) => e.preventDefault())
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const slot: Slot = { win, display: d, ready: false, pending: [] }
    win.webContents.once('did-finish-load', () => {
      slot.ready = true
      // Only the latest frame matters (a step that played while loading is history).
      const last = slot.pending.at(-1)
      slot.pending = []
      if (last) win.webContents.send(CHANNEL, last)
    })
    if (this.o.rendererUrl) void win.loadURL(`${this.o.rendererUrl.replace(/\/$/, '')}/overlay.html`)
    else void win.loadFile(join(__dirname, '../renderer/overlay.html'))
    return slot
  }

  private send(s: Slot, msg: unknown): void {
    if (s.win.isDestroyed()) return
    if (!s.ready) { s.pending.push(msg); return }
    s.win.webContents.send(CHANNEL, msg)
  }

  // ------------------------------------------------------------- Stop pill hover

  /** While the pointer is over the pill its window takes clicks; everywhere else clicks fall through. */
  private startHover(): void {
    if (this.hoverTimer) return
    this.hoverTimer = setInterval(() => {
      const pill = this.pill
      const p = this.cursor()
      const over = pill && p && !this.capturing && contains(pill.rect, p.x, p.y) ? pill.displayId : null
      if (over === this.hovering) return
      for (const [id, s] of this.slots) {
        if (s.win.isDestroyed()) continue
        if (id === over) s.win.setIgnoreMouseEvents(false)
        else if (id === this.hovering) s.win.setIgnoreMouseEvents(true, { forward: true })
      }
      this.hovering = over
    }, 80)
  }

  private stopHover(): void {
    if (this.hoverTimer) { clearInterval(this.hoverTimer); this.hoverTimer = null }
    if (this.hovering !== null) {
      const s = this.slots.get(this.hovering)
      if (s && !s.win.isDestroyed()) s.win.setIgnoreMouseEvents(true, { forward: true })
      this.hovering = null
    }
  }
}

/**
 * The overlay for computer use. Hidden test runs (SAHILBOT_HIDDEN) get one that never makes a window
 * and resolves at once. Windows are created lazily (first step, or warm()).
 */
export function createOverlay(o: OverlayWindowOptions & { hidden: boolean }): { overlay: Overlay & { warm(): void }; windows: () => OverlayWindows | null } {
  if (o.hidden) return { overlay: { show: async () => undefined, hide: () => undefined, warm: () => undefined }, windows: () => null }
  let host: OverlayWindows | null = null
  const get = (): OverlayWindows => (host ??= new OverlayWindows(o))
  // The controller asks the host for everything; the windows appear on its first render.
  const lazy: OverlayHost = {
    render: (f) => get().render(f),
    hide: () => host?.hide(),
    cursor: () => get().cursor(),
    displays: () => get().displays(),
    reduceMotion: () => get().reduceMotion()
  }
  const ctl = new OverlayController(lazy)
  return {
    overlay: { show: (a) => ctl.show(a), hide: () => ctl.hide(), warm: () => get().warm() },
    windows: () => host
  }
}
