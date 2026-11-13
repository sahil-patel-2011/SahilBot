import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, Notification, screen, session, shell, systemPreferences } from 'electron'
import { execFileSync } from 'node:child_process'
import { tmpdir, totalmem } from 'node:os'
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import type { BotShape, ChatEvent, PendingRequest, SendInput, Settings, Space } from '@shared/types'
import { Attachments, registerScheme } from './attachments'
import { INTRO } from './agent/prompt'
import { updateBotTool } from './agent/tools/bots'
import { PROVIDERS } from './llm/providers'
import { Budget } from './llm/budget'
import { collectText, isLocal, spendHooks, streamChat } from './llm/client'
import { ConnectorIcons, Connectors, PRESETS } from './connectors'
import { addTemplate, loadTemplates } from './templates'
import { VoiceService } from './voice/service'
import { Scheduler } from './scheduler'
import { buildMenu, setupApp, windowState } from './shell'
import { scheduleTool } from './agent/tools/schedule'
import { ResultStore } from './agent/context'
import { Agent } from './agent/loop'
import { ToolRegistry } from './agent/registry'
import { browserTool } from './agent/tools/browser'
import { coreTools } from './agent/tools/core'
import { fileTools } from './agent/tools/files'
import { exportPagePdf, guardFrames, isPagePath, openPageWindow, PagePanel, pageInfo, pageThumbnail, pageTools, type PanelBounds } from './agent/tools/pages'
import { memoryTool } from './agent/tools/memory'
import { webTools } from './agent/tools/web'
import { Db } from './db'
import { providerModels, root, teamCapacity, wiredLimitMB } from './llm/models'
import { Endpoints } from './llm/endpoints'
import { samplingFor } from './llm/catalog'
import { MemoryStore } from './memory'
import { appRoot, dataDir, sub } from './paths'
import { SkillStore } from './skills'
import { docxText, pdfText, pptxText } from './docs/read'
import { RuleStore } from './rules'
import { cursorTool, macAppsTool } from './agent/tools/apps'
import { shellTool } from './agent/tools/shell'
import { researchTool } from './agent/tools/research'
import { agentsTool } from './agent/tools/agents'
import { handoffTool } from './agent/tools/handoff'
import { computerTool } from './agent/tools/computer'
import { consultTool } from './agent/tools/consult'
import { Secrets } from './secrets'
import { SettingsStore, type SettingsPatch } from './settings'
import { SpaceFiles } from './spaces'
import { BrowserManager } from './browser/manager'
import { Vault } from './vault'
import { findOllamaBinary, setupOllama, startOllama, stopOllama } from './ollama-setup'
import { needsYouBody } from './needs-you'

/** Set by the automated tests: run without ever showing a window. */
const HIDDEN = !!process.env.SAHILBOT_HIDDEN
if (HIDDEN) app.whenReady().then(() => app.dock?.hide()).catch(() => undefined)

// Tests and side-by-side profiles keep everything (including browser cookies) in their own folder.
// Otherwise the data folder keeps its original name (Foreman) so chats, memory and keys carry over.
if (process.env.FOREMAN_DATA_DIR) app.setPath('userData', process.env.FOREMAN_DATA_DIR)
else app.setPath('userData', join(app.getPath('appData'), 'Foreman'))

registerScheme()

// One SahilBot at a time: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => {
  if (!app.isReady()) return
  const w = showMain()
  if (w?.isMinimized()) w.restore()
})

const SPACE_COLORS = ['#FF4D4F', '#1F1F1F', '#7C5CFF', '#13A10E', '#F59E0B', '#0EA5E9', '#EC4899', '#A0612F', '#14B8A6']
const SHAPES: BotShape[] = ['blob', 'drop', 'square', 'pebble', 'star', 'triangle', 'circle', 'hex']
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]

let win: BrowserWindow | null = null
/** Recreates the main window if it was closed (macOS keeps running); set once the app is ready. */
let reopen: () => BrowserWindow | null = () => null

/** Messages to the main window; dropped while it's closed. */
function toWin(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args)
}

/** Shows a chat in the main window; a just-recreated window gets it once its page has loaded. */
function openThread(threadId: string): void {
  const w = showMain()
  if (w?.webContents.isLoading()) w.webContents.once('did-finish-load', () => toWin('open-thread', threadId))
  else toWin('open-thread', threadId)
}

/** Brings the main window forward, creating it again if it was closed. */
function showMain(): BrowserWindow | null {
  if (!win || win.isDestroyed()) win = reopen()
  if (win && !HIDDEN) { win.show(); win.focus() }
  return win
}

function chip(): string {
  try {
    return execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string']).toString().trim()
  } catch {
    return process.arch
  }
}

function applyTheme(theme: Settings['theme']): void {
  nativeTheme.themeSource = theme
}

function createWindow(bounds: Partial<Electron.Rectangle> = {}): BrowserWindow {
  const w = new BrowserWindow({
    width: 1320,
    height: 860,
    ...bounds,
    title: 'SahilBot',
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161616' : '#FFFFFF',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Chromium's PDF viewer for document previews.
      plugins: true
    }
  })
  // Automated test runs stay invisible: no window, no Dock icon, no stealing focus.
  if (!HIDDEN) w.once('ready-to-show', () => w.show())
  // Links in chat open in the user's browser, never inside the app shell.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  // Frames in the app window (PDF previews) can't navigate off to the web. Pages never load here.
  guardFrames(w.webContents)
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void w.loadFile(join(__dirname, '../renderer/index.html'))
  return w
}

/** Quick Ask: a small floating bar over any app (⌥Space by default). Same page, '#quick' view. */
function createQuickWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 720, height: 132, show: false, frame: false, resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, hasShadow: true,
    transparent: true, vibrancy: 'popover', visualEffectState: 'active', backgroundColor: '#00000000',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  w.setAlwaysOnTop(true, 'floating')
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void w.loadURL(`${process.env.ELECTRON_RENDERER_URL}#quick`)
  else void w.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'quick' })
  return w
}

app.whenReady().then(() => {
  setupApp()
  const db = new Db(join(dataDir(), 'foreman.db'))
  db.sweepStreaming()
  const secrets = new Secrets(db)
  const settings = new SettingsStore(db, secrets)
  const spaces = new SpaceFiles()
  // Cloud spending cap: enforced inside the model client for every paid request (chat, agent, voice, summaries).
  const budget = new Budget(db, () => settings.get().cloudBudgetUsd)
  spendHooks.before = (_req, est, maxOutput, pricedAs) => budget.check(pricedAs, est, maxOutput)
  spendHooks.after = (req, input, output, served) => {
    budget.record(new URL(req.baseUrl).host, served, input, output)
    toWin('budget:changed')
  }

  const memory = new MemoryStore(db)
  const results = new ResultStore(sub('results'))
  const docsDir = join(appRoot(), 'docs')
  // Pages (create_page) live in the workspace's "pages" folder; the app manual in docsDir is read-only.
  const pagesDir = (): string => join(settings.get().workspaceDir, 'pages')
  const listeners = new Set<(e: ChatEvent) => void>()
  /** Screenshot of the main display, scaled so one image pixel = one screen point. */
  const captureScreen = async (file: string): Promise<{ dataUrl: string; width: number; height: number }> => {
    await new Promise<void>((ok, fail) => execFile('screencapture', ['-x', '-C', '-t', 'png', file], { timeout: 15_000 }, (e) => (e ? fail(e) : ok())))
    const d = screen.getPrimaryDisplay()
    const img = nativeImage.createFromPath(file).resize({ width: d.size.width, height: d.size.height })
    if (img.isEmpty()) throw new Error('could not create image (Screen Recording permission)')
    return { dataUrl: img.toDataURL(), width: d.size.width, height: d.size.height }
  }

  // Computer use: while SahilBot controls the Mac it shrinks to a small window in the top-right corner
  // (always on top, with Stop), and comes back when the task ends.
  let mini: { bounds: Electron.Rectangle; threadId: string } | null = null
  const exitMini = (): void => {
    globalShortcut.unregister('Control+Option+Escape')
    if (!mini || !win || win.isDestroyed()) { mini = null; return }
    win.setAlwaysOnTop(false)
    win.setMinimumSize(900, 600)
    win.setBounds(mini.bounds, true)
    mini = null
    toWin('mini', { on: false })
  }
  const enterMini = (threadId: string): void => {
    if (mini || !win || win.isDestroyed()) return
    mini = { bounds: win.getBounds(), threadId }
    const { workArea } = screen.getPrimaryDisplay()
    win.setMinimumSize(260, 150)
    win.setAlwaysOnTop(true, 'floating')
    win.setBounds({ x: workArea.x + workArea.width - 300 - 14, y: workArea.y + 14, width: 300, height: 176 }, true)
    toWin('mini', { on: true, threadId })
    // A way out that works whatever app is in front.
    globalShortcut.register('Control+Option+Escape', () => { const id = mini?.threadId; if (id) void chat.stop(id); exitMini() })
  }
  // The Quick Ask bar (created on first use); it follows the same chat events as the main window.
  let quick: BrowserWindow | null = null
  /** Runs started from Quick Ask answer in the bar itself, so they don't notify. */
  const quickRuns = new Set<string>()
  /** Bot details → "Notify me when this bot finishes or needs me" (on unless switched off). */
  const botNotifies = (spaceId: string | undefined): boolean => !spaceId || db.getSpace(spaceId)?.notify !== false

  // ---------------------------------------------------------------- needs you: notifications + Dock badge
  /** The chat open in the main window (the window asks for a chat's open requests whenever it shows one). */
  let viewingThread: string | null = null
  /** Open requests (approvals, questions, plans, connects) per chat. */
  const waiting = new Map<string, Set<string>>()
  /** Last "needs you" notification per chat: at most one a minute. */
  const lastNeedsYou = new Map<string, number>()
  /** Routine runs end with the routine's own notification instead of the generic "done". */
  const scheduledRuns = new Set<string>()
  /** Quick Ask chats were read in the bar: they don't count toward the badge. */
  const quickSeen = new Set<string>()
  /** Recent notifications, held so their click handlers survive garbage collection. */
  const notes: Notification[] = []
  const showNote = (n: Notification, threadId: string): void => {
    n.on('click', () => openThread(threadId))
    notes.push(n)
    if (notes.length > 30) notes.shift()
    n.show()
  }
  const botName = (spaceId: string | undefined): string => {
    const sp = spaceId ? db.getSpace(spaceId) : undefined
    return !sp || sp.isMain ? 'SahilBot' : sp.name
  }
  const mainFocused = (): boolean => !!win && !win.isDestroyed() && win.isFocused()
  /** One short line for a request, safe for the lock screen (see needsYouBody). */
  const needsYouText = (r: PendingRequest): string => {
    let passwords: string[] = []
    try { passwords = vault.passwords() } catch { /* vault locked */ }
    return needsYouBody(r, passwords)
  }
  /** Dock badge: chats waiting on you + unread chats (top-level, not hidden bots, not the one you're reading). */
  let badgeTimer: ReturnType<typeof setTimeout> | null = null
  const refreshBadge = (): void => {
    if (badgeTimer || HIDDEN) return
    badgeTimer = setTimeout(() => {
      badgeTimer = null
      try {
        if (!app.dock) return
        const reading = mainFocused() ? viewingThread : null
        const need = new Set([...waiting].filter(([, ids]) => ids.size).map(([t]) => t))
        const hidden = new Set(db.listSpaces().filter((x) => x.hidden).map((x) => x.id))
        for (const t of db.listThreads()) if (t.unread && t.id !== reading && !hidden.has(t.spaceId) && !quickSeen.has(t.id)) need.add(t.id)
        app.dock.setBadge(need.size ? String(need.size) : '')
      } catch { /* no Dock, or the database is closing */ }
    }, 200)
  }
  const needsYou = (e: ChatEvent): void => {
    if (e.type === 'pending') {
      waiting.set(e.threadId, (waiting.get(e.threadId) ?? new Set()).add(e.request.id))
      refreshBadge()
      if (HIDDEN || !Notification.isSupported() || quickRuns.has(e.threadId)) return
      if (mainFocused() && viewingThread === e.threadId) return
      const thread = db.getThread(e.threadId)
      if (!thread || !botNotifies(thread.spaceId)) return
      const now = Date.now()
      if (now - (lastNeedsYou.get(e.threadId) ?? 0) < 60_000) return
      lastNeedsYou.set(e.threadId, now)
      showNote(new Notification({ title: `${botName(thread.spaceId)} needs you`, body: needsYouText(e.request), silent: false }), e.threadId)
    } else if (e.type === 'resolved') {
      waiting.get(e.threadId)?.delete(e.id)
      refreshBadge()
    } else if (e.type === 'run' && e.status !== 'started') {
      waiting.delete(e.threadId)
      if (quickRuns.has(e.threadId)) quickSeen.add(e.threadId)
      refreshBadge()
    } else if (e.type === 'thread') refreshBadge()
  }

  const emit = (e: ChatEvent): void => {
    toWin('chat:event', e)
    if (quick && !quick.isDestroyed()) quick.webContents.send('chat:event', e)
    for (const l of listeners) l(e)
    try { needsYou(e) } catch { /* notifications are best-effort */ }
    if (e.type === 'run' && e.status !== 'started' && mini?.threadId === e.threadId) exitMini()
    const fromQuick = e.type === 'run' && e.status !== 'started' && quickRuns.delete(e.threadId)
    const fromRoutine = e.type === 'run' && e.status !== 'started' && scheduledRuns.delete(e.threadId)
    // A chat finished while you were in another app: a quiet notification.
    if (e.type === 'run' && (e.status === 'finished' || e.status === 'error') && !fromQuick && !fromRoutine && !(quick && !quick.isDestroyed() && quick.isVisible()) &&
      !(win && !win.isDestroyed() && win.isFocused()) && !HIDDEN && Notification.isSupported() && botNotifies(e.spaceId ?? db.getThread(e.threadId)?.spaceId)) {
      const n = new Notification({ title: e.status === 'error' ? 'SahilBot hit a problem' : 'SahilBot is done', body: (e.title ?? 'Your task').slice(0, 120), silent: false })
      n.on('click', () => openThread(e.threadId))
      n.show()
    }
  }

  const vault = new Vault(db, secrets)
  const browser = new BrowserManager(
    () => win,
    (state) => toWin('browser:state', state),
    () => toWin('browser:open')
  )

  // Built-in packs of skills and rules ship in packs/; yours live in the data folder.
  const skills = new SkillStore(sub('skills'), join(appRoot(), 'packs', 'skills'))
  const rules = new RuleStore(sub('rules'), join(appRoot(), 'packs', 'rules'))
  const registry = new ToolRegistry()
  registry.register(
    ...coreTools(results),
    ...fileTools(() => settings.get().workspaceDir, docsDir),
    ...pageTools(pagesDir),
    ...webTools(() => ({ ...settings.get().search, braveKey: secrets.get('braveKey') })),
    memoryTool(memory, db, skills, rules),
    // Built in and always available (connector tools are found with find_tools).
    { ...browserTool(browser, vault), core: true },
    { ...cursorTool(() => secrets.get('cursorKey')), core: true },
    { ...macAppsTool(), core: true },
    shellTool(),
    researchTool(),
    agentsTool(),
    computerTool({
      enterMini: (id) => enterMini(id),
      trusted: (prompt) => systemPreferences.isTrustedAccessibilityClient(prompt),
      capture: (file) => captureScreen(file)
    }),
    consultTool({
      advisor: () => endpoints.advisor(),
      isCloud: (m) => !isLocal(endpoints.for(m).baseUrl),
      maxPerRequest: () => settings.get().cloud.maxConsultsPerRequest,
      ask: async (model, system, user, signal) => {
        const ep = endpoints.for(model)
        return collectText(streamChat({ baseUrl: ep.baseUrl, apiKey: ep.apiKey, model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], sampling: samplingFor(model, settings.get().sampling), maxTokens: 2000, effort: 'medium', signal }))
      }
    }),
    updateBotTool(db, spaces, () => emit({ threadId: '', type: 'spaces' }))
  )

  const registerQuickKeyRef = { current: (): void => undefined }
  // Every model server that's on; the last list tells the agent how much context each model can hold.
  const endpoints = new Endpoints(settings)
  const fitWindow = (model: string, window: number): number => {
    const m = endpoints.last?.models.find((x) => x.id === model)
    if (!m || m.note === 'remote') return window
    // Never below 16k; otherwise the largest window this Mac's memory allows with this model.
    return Math.max(16384, Math.min(window, m.maxFittingWindow || 32768))
  }

  const connectors = new Connectors(db, secrets, registry, () => toWin('connectors:changed'))

  const chat = new Agent({
    connectors,
    db, settings, endpoints, spaces, memory, skills, rules, registry, results, docsDir, emit, fitWindow,
    secretValues: () => vault.passwords()
  })
  // Bot-to-bot handoffs need the agent itself (to start or steer the other bot's run).
  registry.register(handoffTool(() => chat.handoffHost()))

  if (db.listSpaces().length === 0) db.createSpace('SahilBot', '#1F1F1F', { isMain: true, shape: 'mascot' })
  const attachments = new Attachments(() => win, () => settings.get().workspaceDir, docsDir)
  attachments.registerProtocol()
  // Pages run only in their own session (the side-panel view, their window, PDF/thumbnail renderers).
  const pagePanel = new PagePanel(() => win, pagesDir)
  applyTheme(settings.get().theme)

  /** Calls that change what's unread refresh the Dock badge. */
  const BADGE_IPC = new Set(['threads:update', 'threads:remove', 'spaces:markUnread', 'spaces:update', 'spaces:remove'])
  const handle = <A extends unknown[], R>(ch: string, fn: (...args: A) => R | Promise<R>): void => {
    if (BADGE_IPC.has(ch)) ipcMain.handle(ch, async (_e, ...args) => { try { return await fn(...(args as A)) } finally { refreshBadge() } })
    else ipcMain.handle(ch, (_e, ...args) => fn(...(args as A)))
  }

  handle('system:info', () => ({
    totalGB: Math.round(totalmem() / 1024 ** 3),
    chip: chip(),
    platform: process.platform,
    // In development app.getVersion() is Electron's own version; read SahilBot's.
    appVersion: (() => { try { return (JSON.parse(readFileSync(join(appRoot(), 'package.json'), 'utf8')) as { version: string }).version } catch { return app.getVersion() } })()
  }))

  handle('settings:get', () => settings.get())
  handle('settings:set', (patch: SettingsPatch) => {
    const s = settings.set(patch)
    if (patch.quickKey !== undefined) registerQuickKeyRef.current()
    if (patch.theme) applyTheme(s.theme)
    return s
  })

  handle('mini:exit', () => exitMini())

  // ---------------------------------------------------------------- Quick Ask (⌥Space)
  const showQuick = (): void => {
    if (HIDDEN) return
    if (!quick || quick.isDestroyed()) quick = createQuickWindow()
    if (quick.isVisible()) { quick.hide(); return }
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const [w] = quick.getSize()
    quick.setPosition(Math.round(d.workArea.x + (d.workArea.width - w) / 2), Math.round(d.workArea.y + d.workArea.height * 0.2))
    quick.show()
    quick.focus()
    quick.webContents.send('quick:shown')
  }
  let quickKey = ''
  const registerQuickKey = (): void => {
    if (quickKey) globalShortcut.unregister(quickKey)
    quickKey = ''
    const key = settings.get().quickKey
    if (HIDDEN || !key) return
    try { if (globalShortcut.register(key, showQuick)) quickKey = key } catch { /* taken by another app */ }
  }
  registerQuickKey()
  registerQuickKeyRef.current = registerQuickKey
  handle('quick:hide', () => { quick?.hide() })
  handle('quick:resize', (h: number) => { if (quick && !quick.isDestroyed()) { const [w] = quick.getSize(); quick.setSize(w, Math.max(96, Math.min(640, Math.round(h)))) } })
  handle('quick:ask', async (text: string, opts: { screen?: boolean; clipboard?: boolean }) => {
    const main = db.listSpaces().find((sp) => sp.isMain)
    if (!main) throw new Error('No main bot.')
    const t = db.createThread(main.id, 'auto', null)
    quickRuns.add(t.id)
    const images: string[] = []
    if (opts.screen) {
      // Hide the bar so it isn't in the picture.
      quick?.hide()
      const dir = mkdtempSync(join(tmpdir(), 'sb-quick-'))
      try { images.push((await captureScreen(join(dir, 's.png'))).dataUrl) } finally { rmSync(dir, { recursive: true, force: true }); quick?.show() }
    }
    const clip = opts.clipboard ? String(await clipboard.readText()).slice(0, 20_000) : ''
    // Answer quickly and briefly: it's a floating bar.
    await chat.send({ threadId: t.id, text, images, note: `[Asked from Quick Ask, a small floating bar: answer briefly and directly; the user can open the full chat for more.]${clip ? `\n[The user's clipboard:\n${clip}]` : ''}`, meta: { quick: true } })
    return t.id
  })
  handle('quick:open', (threadId: string) => {
    quick?.hide()
    openThread(threadId)
  })
  handle('models:list', () => endpoints.list())
  handle('models:setupPicks', async () => { await endpoints.list().catch(() => undefined); return endpoints.setupPicks() })
  // Let the GPU use up to 90% of memory (macOS caps it at about 75%). macOS asks for an admin password;
  // it lasts until restart unless kept with a small LaunchDaemon (also only with the user's password).
  handle('gpu:status', () => ({ totalGB: Math.round(totalmem() / 1024 ** 3), limitMB: wiredLimitMB(true) }))
  handle('gpu:setLimit', async (percent: number, keep: boolean) => {
    const mb = percent > 0 ? Math.floor((totalmem() / 1024 ** 2) * Math.min(0.92, percent / 100)) : 0
    const plist = '/Library/LaunchDaemons/app.sahilbot.gpu-memory.plist'
    const daemon = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>app.sahilbot.gpu-memory</string><key>ProgramArguments</key><array><string>/usr/sbin/sysctl</string><string>iogpu.wired_limit_mb=${mb}</string></array><key>RunAtLoad</key><true/></dict></plist>`
    const script = [`/usr/sbin/sysctl iogpu.wired_limit_mb=${mb}`, keep && mb > 0 ? `printf %s '${daemon}' > ${plist} && chmod 644 ${plist}` : `rm -f ${plist}`].join(' && ')
    await new Promise<void>((ok, fail) => execFile('osascript', ['-e', `do shell script "${script.replace(/"/g, '\\"')}" with administrator privileges with prompt "SahilBot wants to let local AI models use more of your Mac's memory."`], (e) => (e ? fail(new Error(/-128|User canceled/i.test(e.message) ? 'Cancelled.' : e.message)) : ok())))
    wiredLimitMB(true)
    void endpoints.list()
    return { limitMB: wiredLimitMB() }
  })

  // Team of Experts: how many helper agents this Mac can run with a model.
  handle('agents:capacity', (model: string) => {
    const id = model === 'auto' ? endpoints.usable().sort((a, b) => b.tier - a.tier || (b.rank ?? 0) - (a.rank ?? 0))[0]?.id : model
    return teamCapacity(endpoints.last?.models.find((m) => m.id === id))
  })

  handle('models:test', async (baseUrl: string, apiKey?: string) => {
    const r = await providerModels('custom', 'Test', baseUrl, apiKey || settings.keyFor(baseUrl), settings.get().contextWindow || 32768)
    return r.ok ? { ok: true, count: r.models.length } : { ok: false, count: 0, error: r.error }
  })

  // One-click downloads of recommended models through Ollama, with progress.
  const pulling = new Set<string>()
  // One click: install Ollama if needed (verified, no admin password) and run it in the background.
  handle('ollama:setup', () => setupOllama(settings.providers().ollama.baseUrl, (e) => toWin('ollama:setup', e)))
  handle('ollama:installed', () => !!findOllamaBinary())

  handle('models:pull', async (tag: string) => {
    if (!/^[\w.\-/]+(:[\w.\-]+)?$/.test(tag) || pulling.has(tag)) return
    pulling.add(tag)
    const send = (e: Record<string, unknown>): void => toWin('models:pull', { tag, ...e })
    try {
      // Installed but not running (e.g. after a restart): start it rather than failing.
      await startOllama(settings.providers().ollama.baseUrl)
      const res = await fetch(`${root(settings.providers().ollama.baseUrl)}/api/pull`, { method: 'POST', body: JSON.stringify({ model: tag, stream: true }) })
      if (!res.ok || !res.body) throw new Error(`Ollama answered ${res.status}`)
      const dec = new TextDecoder()
      let buf = ''
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!line) continue
          const j = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string }
          if (j.error) throw new Error(j.error)
          send({ status: j.status ?? '', completed: j.completed, total: j.total })
        }
      }
      send({ status: 'done', done: true })
    } catch (e) {
      send({ status: 'error', done: true, error: (e as Error).message.includes('fetch failed') ? 'Ollama isn\'t running. Use "Set up local models" in Settings → Models, or open the Ollama app, then try again.' : (e as Error).message })
    } finally {
      pulling.delete(tag)
    }
  })

  handle('spaces:list', () => db.listSpaces())
  handle('spaces:create', (input: { name?: string; color?: string; shape?: BotShape; kind?: 'bot' | 'group' | 'project'; members?: string[]; intro?: boolean; folder?: string }) => {
    const kind = input.kind ?? 'bot'
    const name = input.name?.trim() || (kind === 'group' ? 'Group chat' : kind === 'project' ? 'New project' : 'New Bot')
    if (kind === 'project') {
      // Only folders the user picked in this session can become project folders.
      if (!input.folder || !attachments.accept([input.folder]).length) throw new Error('Choose the project folder with the folder picker.')
      attachments.allow(input.folder)
    }
    const space = db.createSpace(name, input.color ?? pick(SPACE_COLORS.slice(2)), { kind, shape: input.shape ?? pick(SHAPES), members: input.members ?? [], folder: input.folder })
    const thread = db.createThread(space.id, 'auto', null)
    db.updateThread(thread.id, { title: name })
    if (kind === 'bot' && input.intro !== false) {
      // The new bot greets the user and asks what to focus on; it can rename itself afterwards.
      const state = db.getState(thread.id)
      state.loaded = ['update_bot']
      db.setState(thread.id, state)
      chat.intro(thread.id, INTRO)
    }
    return { space, threadId: thread.id }
  })
  handle('spaces:update', (id: string, patch: Partial<Pick<Space, 'name' | 'color' | 'shape' | 'pinned' | 'hidden' | 'members' | 'model' | 'label' | 'notify'>>) => {
    const s = db.updateSpace(id, patch)
    // Keep a bot's one conversation titled after it.
    if (patch.name && s.kind === 'bot' && !s.isMain) for (const t of db.listThreads(id)) db.updateThread(t.id, { title: s.name })
    return s
  })
  handle('spaces:markUnread', (id: string) => {
    const t = db.listThreads(id)[0]
    if (t) db.updateThread(t.id, { unread: true })
  })
  handle('spaces:remove', (id: string) => {
    if (db.getSpace(id)?.isMain) throw new Error("The main bot can't be deleted.")
    for (const t of db.listThreads(id)) chat.stop(t.id)
    db.deleteSpace(id)
    for (const g of db.listSpaces().filter((x) => x.kind === 'group' && x.members.includes(id))) db.updateSpace(g.id, { members: g.members.filter((m) => m !== id) })
  })
  handle('spaces:getPrompt', (id: string) => spaces.getPrompt(id))
  handle('spaces:setPrompt', (id: string, text: string) => spaces.setPrompt(id, text))
  handle('spaces:promptPath', (id: string) => spaces.path(id))
  // Bot details → Library: files this bot made (that still exist) and links from its chats.
  handle('spaces:library', (id: string) => db.spaceLibrary(id).filter((x) => x.kind !== 'file' || (!!x.path && existsSync(x.path))))

  handle('threads:list', (spaceId?: string) => db.listThreads(spaceId))
  handle('threads:search', (q: string) => db.searchThreads(q))
  handle('threads:create', (spaceId: string) => db.createThread(spaceId, 'auto', null))
  handle('threads:update', (id: string, patch: Parameters<Db['updateThread']>[1]) => db.updateThread(id, patch))
  handle('threads:remove', (id: string) => {
    chat.stop(id)
    db.deleteThread(id)
  })
  handle('threads:messages', (id: string) => db.listMessages(id))
  handle('threads:react', (messageId: string, emoji: string | null) => {
    const m = db.react(messageId, 'user', emoji)
    emit({ threadId: m.threadId, type: 'message', message: m })
    return m
  })

  // Attachments must be ones the user picked or dropped in this session.
  handle('chat:send', async (input: SendInput) => {
    const ok = new Set(attachments.accept((input.attachments ?? []).map((a) => a.path)))
    await chat.send({ ...input, attachments: (input.attachments ?? []).filter((a) => ok.has(a.path)) })
  })
  handle('files:pick', (kind: 'files' | 'folder') => attachments.pick(kind))
  handle('files:register', (paths: string[]) => attachments.register(paths))
  handle('files:preview', (path: string) => attachments.preview(path))
  // Pages open in their own locked-down window, never in the default browser.
  handle('files:open', async (path: string) => { if (isPagePath(pagesDir(), path)) openPageWindow(pagesDir, path, { show: !HIDDEN }); else await attachments.open(path) })
  handle('pages:info', (path: string) => pageInfo(pagesDir(), path))
  handle('pages:openWindow', (path: string) => { openPageWindow(pagesDir, path, { show: !HIDDEN }) })
  handle('pages:exportPdf', (path: string) => exportPagePdf(pagesDir, path))
  handle('pages:show', (path: string | null, rev?: string, bounds?: PanelBounds | null) => { if (path) return pagePanel.show(path, String(rev ?? ''), bounds ?? null); pagePanel.close(); return null })
  handle('pages:thumbnail', (path: string) => pageThumbnail(pagesDir, path))
  // The first lines of a document, for file thumbnails (only files SahilBot made).
  handle('files:snippet', async (path: string) => {
    if (!db.recentFiles(500).some((f) => f.path === path) || !existsSync(path)) return ''
    try {
      const text = /\.pdf$/i.test(path) ? (await pdfText(path)).text : /\.docx$/i.test(path) ? await docxText(path) : /\.pptx$/i.test(path) ? await pptxText(path) : ''
      return text.slice(0, 800)
    } catch { return '' }
  })
  // Files SahilBot made, for Home and the Files page (only ones that still exist).
  handle('files:recent', (limit?: number) => db.recentFiles(limit ?? 60).filter((f) => existsSync(f.path)).map((f) => ({ ...f, name: basename(f.path), size: statSync(f.path).size })))
  handle('files:reveal', (path: string) => attachments.reveal(path))
  handle('providers', () => PROVIDERS)
  handle('budget', () => budget.summary())
  // Zero setup: find model servers already running on this Mac and the best model that fits.
  handle('detectProviders', async () => {
    const local = PROVIDERS.filter((p) => !p.needsKey)
    const found = await Promise.all(local.map(async (p) => {
      const list = await providerModels(p.id as 'ollama', p.name, p.baseUrl, undefined, settings.get().contextWindow || 32768)
      if (!list.ok) return null
      const fits = list.models.filter((m) => m.fits || m.maxFittingWindow >= 16384)
      // Prefer the largest model that fits (by size on disk, else required memory).
      const best = [...fits].sort((a, b) => (b.sizeBytes ?? b.requiredGB * 1e9) - (a.sizeBytes ?? a.requiredGB * 1e9))[0]
      return { id: p.id, name: p.name, baseUrl: p.baseUrl, models: list.models.length, best: best?.id ?? null }
    }))
    return found.filter((x): x is NonNullable<typeof x> => !!x)
  })
  handle('connectors:presets', () => PRESETS)
  handle('connectors:list', () => ({ configs: connectors.list(), statuses: connectors.statuses() }))
  handle('connectors:save', (c: Parameters<Connectors['save']>[0] & { headerValue?: string; clientSecret?: string }) => {
    const { headerValue, clientSecret, ...rest } = c
    const saved = connectors.save(rest)
    if (headerValue) secrets.set(`mcp:${saved.id}:header`, headerValue)
    if (clientSecret) secrets.set(`mcp:${saved.id}:clientSecret`, clientSecret)
    return saved
  })
  handle('connectors:remove', (id: string) => connectors.remove(id))
  handle('connectors:connectPreset', (id: string) => connectors.connectPreset(id))
  handle('connectors:connect', (id: string) => connectors.connect(id, true))
  handle('connectors:disconnect', (id: string) => connectors.disconnect(id))
  // App icons: cached files come back at once; missing ones are fetched in the background.
  const connectorIcons = new ConnectorIcons(sub('connector-icons'), PRESETS, () => toWin('connectors:icons'))
  handle('connectors:icons', () => connectorIcons.all())
  handle('connectors:setToolEnabled', (id: string, tool: string, on: boolean) => connectors.setToolEnabled(id, tool, on))
  void connectors.connectAll()

  // ---------------------------------------------------------------- scheduled tasks
  const scheduler = new Scheduler(db, async (task) => {
    const space = db.getSpace(task.spaceId)
    if (!space) return 'error: its bot was deleted'
    // Bots get reminders in their one conversation; SahilBot and projects keep a thread per task.
    let threadId = space.isMain || space.kind === 'project' ? task.threadId : db.listThreads(space.id)[0]?.id ?? null
    if (!threadId || !db.getThread(threadId)) {
      const t = db.createThread(space.id, 'auto', null)
      db.updateThread(t.id, { title: space.isMain || space.kind === 'project' ? `⏰ ${task.title}` : space.name })
      threadId = t.id
      scheduler.setThread(task.id, threadId)
    }
    if (chat.isRunning(threadId)) return { status: 'skipped: the chat was busy', threadId }
    const startedAt = Date.now()
    scheduledRuns.add(threadId)
    let status: Awaited<Awaited<ReturnType<typeof chat.send>>['done']>
    try {
      const { done } = await chat.send({ threadId, text: `⏰ ${task.title}\n\n${task.prompt}`, meta: { scheduled: task.id } }, { unattended: true })
      status = await done
    } finally { scheduledRuns.delete(threadId) }
    const after = db.listMessages(threadId).filter((m) => m.createdAt >= startedAt)
    const last = [...after].reverse().find((m) => m.role === 'assistant' && m.content && m.kind === 'normal')
    // The routine's own notification (the generic "done" one is skipped for routine runs). Click opens the chat.
    if (space.notify !== false && !HIDDEN && Notification.isSupported() && !(mainFocused() && viewingThread === threadId)) {
      const body = status === 'error' ? 'The routine hit a problem. Click to see what happened.' : (last?.content ?? 'Done').replace(/\s+/g, ' ').trim().slice(0, 140)
      showNote(new Notification({ title: `${space.isMain ? 'SahilBot' : space.name}: ${task.title.replace(/^⏰\s*/, '')}`, body }), threadId)
    }
    if (status === 'finished') return { status: 'done', threadId }
    // Why it failed: the run's own error line, when it left one.
    const why = [...after].reverse().find((m) => m.kind === 'notice' || m.kind === 'error' || m.status === 'error')?.content.replace(/^(Run failed|Something went wrong):\s*/i, '')
    return { status: status === 'error' ? `error: ${why || 'Something went wrong'}` : status, threadId }
  }, () => toWin('schedules:changed'))
  // System lines in the bot's chat when its routines change or a run fails.
  scheduler.events = (ev) => {
    const space = db.getSpace(ev.task.spaceId)
    if (!space) return
    const own = ev.threadId ?? ev.task.threadId
    const threadId = own && db.getThread(own) ? own : db.listThreads(space.id)[0]?.id
    if (!threadId) return
    const verb = { created: 'Created', paused: 'Paused', resumed: 'Resumed', deleted: 'Deleted', changed: 'Changed', failed: 'Routine failed' }[ev.type]
    const text = ev.type === 'failed' ? `Routine failed · ${ev.task.title}${ev.reason ? `: ${ev.reason}` : ''}` : `${verb} routine · ${ev.task.title}`
    const m = db.insertMessage({ threadId, role: 'assistant', content: text, kind: 'notice', status: 'done', meta: { routineNotice: ev.type, routine: ev.task.id } })
    emit({ threadId, type: 'message', message: m })
  }
  registry.register({ ...scheduleTool(scheduler, db), core: true })
  scheduler.start()
  // Dock badge: right from launch (unread chats carry over), and again whenever SahilBot comes forward.
  refreshBadge()
  app.on('browser-window-focus', () => refreshBadge())
  handle('schedules:list', () => scheduler.list())
  handle('schedules:create', (t: Parameters<Scheduler['create']>[0]) => scheduler.create(t))
  handle('schedules:update', (id: string, patch: Parameters<Scheduler['update']>[1]) => scheduler.update(id, patch))
  handle('schedules:remove', (id: string) => scheduler.remove(id))
  // Test: starts the run and returns at once; progress arrives as schedules:changed + schedules:runs.
  handle('schedules:runNow', (id: string) => {
    if (!scheduler.get(id)) throw new Error('That routine no longer exists.')
    scheduler.test(id)
  })

  // ---------------------------------------------------------------- bot templates
  const templatesDir = join(appRoot(), 'packs', 'templates')
  handle('templates:list', () => loadTemplates(templatesDir))
  handle('templates:add', (id: string) => {
    const t = loadTemplates(templatesDir).find((x) => x.id === id)
    if (!t) throw new Error('That template is no longer available.')
    return addTemplate(t, {
      createBot: (name, color, shape) => {
        const space = db.createSpace(name, color, { kind: 'bot', shape })
        const thread = db.createThread(space.id, 'auto', null)
        db.updateThread(thread.id, { title: name })
        // Lets the bot rename itself or refine its job from its first reply.
        const state = db.getState(thread.id)
        state.loaded = ['update_bot']
        db.setState(thread.id, state)
        return { spaceId: space.id, threadId: thread.id }
      },
      setPrompt: (spaceId, text) => spaces.setPrompt(spaceId, text),
      // Suggested routines start paused; the bot offers to turn them on.
      createRoutine: (r) => {
        const input: Parameters<Scheduler['create']>[0] = { ...r, enabled: false } as Parameters<Scheduler['create']>[0]
        const made = scheduler.create(input)
        if (made.enabled) scheduler.update(made.id, { enabled: false })
      },
      postAssistant: (threadId, text) => { db.insertMessage({ threadId, role: 'assistant', content: text, kind: 'normal', status: 'done' }) },
      changed: () => emit({ threadId: '', type: 'spaces' })
    })
  })
  handle('schedules:runs', (taskId: string) => scheduler.runs(taskId))
  handle('pickFolder', async () => {
    const r = win ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }) : { canceled: true, filePaths: [] }
    if (r.canceled || !r.filePaths[0]) return null
    attachments.register([r.filePaths[0]])
    attachments.accept([r.filePaths[0]])
    return r.filePaths[0]
  })
  // Project folders are previewable and usable by their chats.
  for (const sp of db.listSpaces()) if (sp.kind === 'project' && sp.folder) attachments.allow(sp.folder)

  // ---------------------------------------------------------------- voice
  let voiceThread: string | null = null
  const voice = new VoiceService({
    emit: (e) => toWin('voice:event', e),
    respond: (text, signal, onText) => new Promise<void>((resolve, reject) => {
      const tid = voiceThread
      if (!tid) return reject(new Error('No voice conversation'))
      const off = (): void => { listeners.delete(l) }
      const l = (e: ChatEvent): void => {
        if (e.threadId !== tid) return
        if (e.type === 'delta' && e.content) onText(e.content)
        if (e.type === 'run' && e.status !== 'started') { off(); resolve() }
      }
      listeners.add(l)
      signal.addEventListener('abort', () => { chat.stop(tid); off(); resolve() })
      chat.send({ threadId: tid, text, voice: true }).catch((err: Error) => { off(); reject(err) })
    })
  })
  handle('voice:status', () => voice.status())
  handle('voice:download', (kind: 'whisper' | 'vad' | 'kokoro') => voice.download(kind))
  handle('voice:setVoice', (v: string) => voice.setVoice(v))
  handle('voice:start', async (threadId: string | null, spaceId: string) => {
    if (!threadId) {
      const t = db.createThread(spaceId, 'auto', null)
      db.updateThread(t.id, { title: `Voice chat · ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` })
      threadId = t.id
    }
    const st = db.getState(threadId)
    st.voice = true
    db.setState(threadId, st)
    voiceThread = threadId
    await voice.startVoice()
    return threadId
  })
  handle('voice:stop', () => { voice.stop(); voiceThread = null })
  handle('voice:speak', (text: string) => voice.speak(String(text).slice(0, 20_000)))
  handle('voice:stopSpeaking', () => voice.stopSpeaking())
  handle('voice:dictateStart', () => voice.startDictation())
  handle('voice:dictateStop', () => voice.stopDictation())
  ipcMain.on('voice:frame', (_e, buf: Float32Array) => voice.frame(buf))
  app.on('before-quit', () => { voice.dispose(); scheduler.stop(); browser.dispose(); stopOllama() })
  // Local models just work after a restart: start Ollama in the background if it's installed and not running.
  if (!process.env.FOREMAN_BASE_URL) void startOllama(settings.providers().ollama.baseUrl).catch(() => undefined)

  // The app's own window may use the microphone (voice); websites in the browser panel may not.
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media' && wc === win?.webContents))
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === 'media' && wc === win?.webContents)
  handle('chat:stop', (threadId: string) => chat.stop(threadId))
  handle('chat:steer', (threadId: string, text: string) => chat.steer(threadId, String(text).slice(0, 20_000)))
  handle('chat:respond', (threadId: string, id: string, answer: string) => chat.respond(threadId, id, answer))
  // The main window asks for a chat's open requests whenever it opens that chat: that's how main knows what you're reading.
  handle('chat:allPending', () => chat.allPending())
  ipcMain.handle('chat:pending', (ev, threadId: string) => {
    if (win && !win.isDestroyed() && ev.sender === win.webContents) { viewingThread = threadId; refreshBadge() }
    return chat.pending(threadId)
  })
  handle('chat:retry', (threadId: string) => chat.retry(threadId))
  handle('chat:editLast', (threadId: string, text: string) => chat.editLast(threadId, text))
  handle('chat:export', async (threadId: string) => {
    const t = db.getThread(threadId)
    if (!t) return null
    const r = win ? await dialog.showSaveDialog(win, { defaultPath: `${t.title.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80)}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] }) : { canceled: true }
    if (r.canceled || !('filePath' in r) || !r.filePath) return null
    const lines = [`# ${t.title}`, '', `_Exported from SahilBot on ${new Date().toLocaleString()}_`, '']
    for (const m of db.listMessages(threadId)) {
      if (m.meta?.hidden || m.kind !== 'normal' || m.role === 'tool' || !m.content.trim() || m.meta?.superseded) continue
      lines.push(m.role === 'user' ? `**You:** ${m.content}` : `**${(m.meta?.botName as string) ?? 'SahilBot'}:** ${m.content}`, '')
    }
    writeFileSync(r.filePath, lines.join('\n'))
    return r.filePath
  })

  handle('vault:list', () => vault.list())
  handle('vault:set', (e: Parameters<Vault['set']>[0]) => { vault.set(e); return vault.list() })
  handle('vault:remove', (name: string) => { vault.remove(name); return vault.list() })

  handle('browser:state', () => browser.state())
  handle('browser:setBounds', (b: Electron.Rectangle | null) => browser.setBounds(b && { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }))
  handle('browser:navigate', (url: string) => browser.userNavigate(url))
  handle('browser:back', () => browser.back())
  handle('browser:forward', () => browser.forward())
  handle('browser:reload', () => browser.reload())
  handle('browser:newTab', () => void browser.newTab('about:blank'))
  handle('browser:switchTab', (i: number) => browser.switchTab(i))
  handle('browser:closeTab', (i: number) => browser.closeTab(i))
  handle('browser:takeOver', (on: boolean) => browser.takeOver(on))
  handle('browser:teachStart', () => browser.teachStart('user'))
  handle('browser:teachStop', () => browser.teachStop())
  handle('browser:teachCancel', () => browser.teachCancel())
  handle('browser:teachCompose', (name: string, goal?: string) => browser.teachCompose(String(name ?? ''), goal ? String(goal) : undefined))

  handle('memory:list', () => memory.list())
  handle('memory:remove', (id: string) => void memory.remove(id))
  handle('memory:add', (content: string, spaceId: string | null, category?: string) => memory.add(content, spaceId ?? null, category))
  handle('memory:update', (id: string, content: string, patch?: { category?: string; spaceId?: string | null }) => void memory.update(id, content, patch ?? {}))
  handle('memory:importPreview', (text: string) => memory.importPreview(String(text ?? '').slice(0, 200_000)))
  handle('memory:importCommit', (items: Array<{ content: string; category?: string }>) => memory.importCommit(Array.isArray(items) ? items : []))
  handle('memory:getEnabled', () => memory.enabled)
  handle('memory:setEnabled', (on: boolean) => memory.setEnabled(!!on))
  handle('rules:list', () => rules.list())
  handle('rules:save', (r: { name: string; text: string; scope?: string; category?: string }) => rules.save(r))
  handle('rules:setEnabled', (name: string, on: boolean) => rules.setEnabled(name, on))
  handle('rules:remove', (name: string) => rules.remove(name))
  handle('skills:list', () => skills.list())
  handle('skills:save', (sk: { name: string; description: string; body: string }) => skills.save({ ...sk, source: 'you' }))
  handle('skills:remove', (name: string) => void skills.remove(name))

  // Bypass resets on every launch.
  db.sql.prepare(`UPDATE threads SET permission_mode = 'auto' WHERE permission_mode = 'bypass'`).run()

  const ws = windowState(db)
  const open = (): BrowserWindow => {
    const w = createWindow(ws.bounds)
    ws.track(w)
    // Move the page out of a closing window so it (and the agent's work in it) survives.
    w.on('close', () => { browser.setBounds(null); pagePanel.close() })
    w.on('resize', () => browser.reflow())
    w.on('closed', () => {
      if (win === w) win = null
      if (process.platform !== 'darwin') app.quit()
    })
    return w
  }
  reopen = () => { const w = open(); win = w; browser.reflow(); return w }
  win = open()
  buildMenu((action) => toWin('menu', action))
  app.on('activate', () => {
    // The browser's hidden parking window doesn't count as an open window.
    if (!win || win.isDestroyed()) reopen()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
