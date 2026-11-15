import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, Notification, powerMonitor, powerSaveBlocker, screen, session, shell, systemPreferences } from 'electron'
import { autoPool, autoVariant } from './llm/router'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir, totalmem } from 'node:os'
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { copyFileSync, mkdirSync } from 'node:fs'
import type { AlwaysOnStatus, BotShape, ChatEvent, CheckinSettings, NeedsYouItem, PendingRequest, PermissionMode, SendInput, Settings, Space, UsageRow } from '@shared/types'
import type { GoalPatch } from '@shared/types'
import { Attachments, registerScheme } from './attachments'
// Cloud first, local opt-in (shared/local-mode.ts); attached folders are counted and indexed (knowledge/folder-scan.ts).
import { localOff, localOn } from '@shared/local-mode'
import { hasLocalModels } from './local-detect'
import { scanFolder } from './knowledge/folder-scan'
import { OpenAITtsEngine } from './voice/tts'
import { DEFAULT_TRANSCRIBE_MODEL, speechUsd, transcribe as openaiTranscribe, transcribeUsd } from './apis/openai'
import { OpenAISttEngine } from './voice/stt'
import { hookSpend } from './apis/spend'
import { INTRO } from './agent/prompt'
import { updateBotTool } from './agent/tools/bots'
import { PROVIDERS } from './llm/providers'
import { Budget, budgetLeftFor, spendingMode } from './llm/budget'
import { SPEED_SENSITIVE, fastHooks, fastSupport, fastTierFor, fastTradeoff } from './llm/fast-mode'
import { isAuto } from './llm/router'
import { automationStatus, fileProbe, permissionsStatus, settingsUrl } from './permissions-center'
import { collectText, isLocal, spendHooks, streamChat, usageDetails } from './llm/client'
import { ConnectorIcons, Connectors, PRESETS } from './connectors'
import { addTemplate, loadTemplates, type TemplateDeps } from './templates'
import { BOT_FILE_EXT, BOT_FILE_MAX_BYTES, botFileFor, duplicateBot, importPreview, importTemplate, parseBotFile, PendingImports } from './bot-share'
import { getCheckin, overviewTool, setCheckin } from './checkin'
import { aggregateUsage, providerOf, usageDashboard, usageDetailCsv, usageGlance, usageRows, usageScope, windowStart } from './usage'
import { VoiceService } from './voice/service'
import { Scheduler } from './scheduler'
import { buildMenu, setupApp, windowState } from './shell'
import { scheduleTool } from './agent/tools/schedule'
import { ResultStore } from './agent/context'
import { Agent } from './agent/loop'
import { ToolRegistry } from './agent/registry'
import { browserTool } from './agent/tools/browser'
import { sitesTool } from './agent/tools/sites'
import { SiteStore } from './sites/store'
import { setSiteHintProvider } from './sites/hint'
import { coreTools } from './agent/tools/core'
import { fileTools } from './agent/tools/files'
import { officeTool, reviewDocumentTool } from './agent/tools/office'
import { exportPagePdf, guardFrames, isPagePath, openPageWindow, PagePanel, pageInfo, pageThumbnail, pageTools, type PanelBounds } from './agent/tools/pages'
// Docs: live two-way documents beside the chat.
import { DocStore } from './docspace/store'
import { exportDoc } from './docspace/export'
import { docTools } from './agent/tools/docspace'
import { memoryTool } from './agent/tools/memory'
import { webTools } from './agent/tools/web'
import { Db } from './db'
import { machine, providerModels, root, teamCapacity, wiredLimitMB } from './llm/models'
import { Endpoints } from './llm/endpoints'
import { chatgptPlan, closeAll as closeCodexRuns, CODEX_INSTALL_URL } from './llm/codex'
import { autoWindow, samplingFor } from './llm/catalog'
import { Warmup, lastUsedModel, warmupAllowed } from './llm/warmup'
import { MemoryStore, similar, type ImportItemIn } from './memory'
import { IMPORT_MAX_CHARS, ruleName } from './memory-import'
import { MEMORY_IMPORT_PROMPT } from '@shared/memory-import'
import { appRoot, dataDir, isPackaged, sub } from './paths'
import { SkillStore } from './skills'
import { docxText, pdfText, pptxText } from './docs/read'
import { RuleStore } from './rules'
import { cursorTool, macAppsTool } from './agent/tools/apps'
import { appHelpTool, appTool } from './computer/apps/tool'
import { shellTool } from './agent/tools/shell'
import { jobsTool } from './agent/tools/jobs'
import { jobs } from './jobs/manager'
import { installQuitGuard } from './jobs/quit'
import { runUsage } from './run-usage'
import { isPermissionMode, modeChangeAllowed } from './agent/permissions'
import { codeTool, gitTool } from './agent/tools/code'
import { researchTool } from './agent/tools/research'
import { phiTool } from './agent/tools/phi'
import { agentsTool, swarmTool } from './agent/tools/agents'
import { askBotTool } from './agent/tools/ask-bot'
import { handoffTool } from './agent/tools/handoff'
import { computerTool } from './agent/tools/computer'
import { createOverlay } from './computer/overlay-window'
import { consultTool } from './agent/tools/consult'
import { checkpointTool, createCua } from './agent/cua'
import { frcCodeTool } from './agent/tools/frc_code'
import { frcMechTool } from './agent/tools/frc_mech'
import { onshapeTool, testOnshapeKeys } from './agent/tools/onshape'
import { freecadTool } from './agent/tools/freecad'
import { findFreecadCmd } from './cad/freecad'
import { cadDesignTool } from './cad/design-tool'
import { Secrets } from './secrets'
import { SettingsStore, type SettingsPatch } from './settings'
import { SpaceFiles, botAutonomyConfig, botLevel, isAlwaysOnBot, migrateBotAutonomy } from './spaces'
import { ATTENDED_GRACE_MS, Learner, QuestionQueue, QuestionStore, createQuestionHost, notifyDevices as notifyQuestionDevices, toNeedsYou } from './agent/questions'
import { DigestRunner } from './goals/digest'
import { BrowserManager } from './browser/manager'
import { Vault } from './vault'
import { VaultAuth } from './secure/auth'
import { vaultHandlers } from './secure/ipc'
import { electronTouchId, electronVaultFiles, protectSender, registerVaultIpc, startAutoLock } from './secure/electron'
import { PurchaseGate } from './browser/checkout'
import { recentEmail, recentTexts, setEmailCodeSource } from './otp'
import { mailTool } from './agent/tools/mail'
import { gmailCodeSource } from './mail/gmail'
import { findOllamaBinary, setupOllama, startOllama, stopOllama } from './ollama-setup'
import { needsYouBody } from './needs-you'
import { MenuBarIcon, type TrayItem } from './tray'
import { KeepAwake, RESUME_NEXT_NOTE, RESUME_NOTE, WorkTracker, wantAwake } from './resume'
import type { MenuAction } from './shell'
import { getWatchlist, setWatchlist } from './watchlist'
import { MarketData } from './markets/data'
import { Markets, type AlertState } from './markets/service'
import { alertFromPrompt, usMarketOpen } from './markets/alerts'
import { stockTools } from './agent/tools/stocks'
import { KnowledgeService } from './knowledge/service'
import { LearningService } from './learning/service'
import { knowledgeTools, resolveScope } from './agent/tools/knowledge'
import { vaultTool } from './agent/tools/vault'
import { VaultService } from './vault/service'
import { ContextEngine } from './context-engine/service'
import { aboutTool } from './agent/tools/about'
import { activityLearningAllowed, activityTimelineForLearning } from './activity'
import { GoalManager, withGoalsOverview } from './goals'
import { opensDirectly } from './knowledge/ignore'
import { followUpTool, goalTool } from './agent/tools/goals'
import { captureOpenUrls, registerProtocolClient, setupMcpServer, urlHandler } from './mcp-server/app'
import { setupActivity } from './activity/app'
// Media, vision and batch tools on the user's own OpenAI / Anthropic keys (src/main/apis).
import { apiAccess } from './apis/keys'
import { mediaTools } from './agent/tools/media'
import { readDocumentImageTool, readReceipt } from './agent/tools/vision'
import { BatchManager, batchTool } from './agent/tools/batch'
import { embeddingProvider } from './knowledge/embeddings'
import { OPENAI_URL } from './llm/providers'
import { fromWav } from './voice/audio'
import { swarmSpend } from './agent/swarm/ledger'
import { mark, TIMING } from './timing'
// Channels and events go through a transport-agnostic registry (src/main/rpc.ts): Electron IPC here, a WebSocket on SahilBot Server.
import { addAdapter, broadcast, registerHandler } from './rpc'
import { electronAdapter } from './rpc-electron'
import { setupRemoteServer } from './remote-server'

// SAHILBOT_TIMING=1: launch phases in the log (src/main/timing.ts).
mark('main module loaded')

/** Set by the automated tests: run without ever showing a window. */
const HIDDEN = !!process.env.SAHILBOT_HIDDEN
/**
 * Hidden runs make no notifications and leave the Dock badge alone. Tests of those set
 * SAHILBOT_TEST_NOTIFY=1 (and stub Notification#show and dock.setBadge); it only applies to hidden runs.
 */
const QUIET = HIDDEN && process.env.SAHILBOT_TEST_NOTIFY !== '1'
if (HIDDEN) app.whenReady().then(() => app.dock?.hide()).catch(() => undefined)

// Tests and side-by-side profiles keep everything (including browser cookies) in their own folder.
// Otherwise the data folder keeps its original name (Foreman) so chats, memory and keys carry over.
if (process.env.FOREMAN_DATA_DIR) app.setPath('userData', process.env.FOREMAN_DATA_DIR)
else app.setPath('userData', join(app.getPath('appData'), 'Foreman'))

registerScheme()
// sahilbot:// links (Shortcuts, Raycast, Alfred): caught from launch on, handled once the window exists.
const openUrls = captureOpenUrls()

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
  broadcast(channel, ...args)
}
// In the Mac app, Electron IPC carries every channel and event to the main window. SahilBot Server runs this
// same file under Node with its own transport attached instead (src/server/hub.ts).
if (process.versions.electron) addAdapter(electronAdapter(ipcMain, () => (win && !win.isDestroyed() && !win.webContents.isDestroyed() ? [win.webContents] : [])))

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
  if (TIMING) {
    mark('window created')
    w.once('ready-to-show', () => mark('window ready to show'))
    w.webContents.once('did-finish-load', () => mark('renderer page loaded'))
    // The renderer's own first paint of the app (see main.tsx); no preload bridge needed for a log line.
    w.webContents.on('console-message', (e) => { const m = /^\[sb-timing\] (.*)$/.exec(e.message); if (m) mark(`renderer: ${m[1]}`) })
  }
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
  mark('app ready')
  setupApp()
  const db = new Db(join(dataDir(), 'foreman.db'))
  mark('database open')
  db.sweepStreaming()
  // ---------------------------------------------------------------- always on: runs cut off last time
  // Before anything can run: chats whose run was cut off by a quit or crash get a notice with Continue.
  const work = new WorkTracker(db)
  const recovered = work.recover()
  /** The menu bar icon (created once the window and Quick Ask exist; never in hidden test runs). */
  let menuBar: MenuBarIcon | null = null
  const secrets = new Secrets(db)
  const settings = new SettingsStore(db, secrets)
  /** The Onshape API key pair from the Keychain (main process only; never sent to the renderer or the model). */
  /** Tests (dev builds only): a fake Onshape server stands in for cad.onshape.com. */
  const onshapeTestOrigin = !isPackaged() && process.env.FOREMAN_ONSHAPE_URL ? process.env.FOREMAN_ONSHAPE_URL : undefined
  const onshapeKeys = (): { accessKey: string; secretKey: string } | undefined => {
    const accessKey = secrets.get('onshapeAccessKey'), secretKey = secrets.get('onshapeSecretKey')
    return accessKey && secretKey ? { accessKey, secretKey } : undefined
  }
  const spaces = new SpaceFiles()
  // Cloud spending cap: enforced inside the model client for every paid request (chat, agent, voice, summaries).
  // The limit is monthly, in one of three modes (a specific amount, Unlimited, None: llm/budget.ts spendingMode).
  const budget = new Budget(db, () => settings.get().cloudBudgetUsd, () => spendingMode(settings.get()))
  spendHooks.before = (_req, est, maxOutput, pricedAs) => budget.check(pricedAs, est, maxOutput)
  spendHooks.after = (req, input, output, served) => {
    // Tagged with the bot whose run made it, with the providers' token detail (Settings → Usage).
    let host = ''
    try { host = new URL(req.baseUrl).host } catch { host = req.baseUrl }
    const d = usageDetails.get(req) ?? {}
    budget.record(host, served, input, output, usageScope.getStore()?.spaceId ?? null, { ...d, provider: providerOf(served, host) })
    toWin('budget:changed')
  }
  // Fast mode (llm/fast-mode.ts): what the request in progress runs at. Auto's own rule applies when the chat's
  // model is Auto (the chat's, then its bot's, then the default); speed-sensitive = voice, small talk, quick code.
  fastHooks.resolve = (model) => {
    const s = settings.get()
    const threadId = usageScope.getStore()?.threadId
    if (!threadId) return fastTierFor(model, s)
    const thread = db.getThread(threadId)
    const chosen = thread?.model || (thread ? db.getSpace(thread.spaceId)?.model : undefined) || s.defaultModel
    const state = db.getState(threadId)
    return fastTierFor(model, s, { auto: isAuto(chosen), speedSensitive: !!state.voice || SPEED_SENSITIVE.has(state.lastCategory ?? '') })
  }

  const memory = new MemoryStore(db)
  const results = new ResultStore(sub('results'))
  const docsDir = join(appRoot(), 'docs')
  // Pages (create_page) live in the workspace's "pages" folder; the app manual in docsDir is read-only.
  const pagesDir = (): string => join(settings.get().workspaceDir, 'pages')
  const listeners = new Set<(e: ChatEvent) => void>()
  /**
   * Screenshot. Default: the main display, scaled so one image pixel = one screen point. With rect
   * (global points, any display): that area (screencapture -R), resized to width×height pixels.
   */
  // The SahilBot cursor (computer use): click-through windows that show each step; Stop on its pill (or
  // Ctrl+Option+Esc) stops the run. Made on first use; hidden test runs never make them.
  const cursorOverlay = createOverlay({
    hidden: HIDDEN,
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    onStop: () => { const id = mini?.threadId; if (id) void chat.stop(id); exitMini(); cursorOverlay.overlay.hide() }
  })
  app.on('before-quit', () => cursorOverlay.windows()?.dispose())
  const captureScreen = async (file: string, opts?: { rect?: Electron.Rectangle; width?: number; height?: number }): Promise<{ dataUrl: string; width: number; height: number }> => {
    const r = opts?.rect
    const area = r ? ['-R', `${Math.round(r.x)},${Math.round(r.y)},${Math.max(1, Math.round(r.width))},${Math.max(1, Math.round(r.height))}`] : []
    const shoot = (): Promise<void> => new Promise<void>((ok, fail) => execFile('screencapture', ['-x', '-C', ...area, '-t', 'png', file], { timeout: 15_000 }, (e) => (e ? fail(e) : ok())))
    // The SahilBot cursor is never in the model's screenshots (content protection, and invisible while capturing).
    const ov = cursorOverlay.windows()
    await (ov ? ov.aroundCapture(shoot) : shoot())
    const d = screen.getPrimaryDisplay()
    const width = opts?.width ?? (r ? Math.round(r.width) : d.size.width)
    const height = opts?.height ?? (r ? Math.round(r.height) : d.size.height)
    const img = nativeImage.createFromPath(file).resize({ width, height, quality: 'best' })
    if (img.isEmpty()) throw new Error('could not create image (Screen Recording permission)')
    return { dataUrl: img.toDataURL(), width, height }
  }

  // Computer use: while SahilBot controls the Mac it shrinks to a small window in the top-right corner
  // (always on top, with Stop), and comes back when the task ends.
  let mini: { bounds: Electron.Rectangle; threadId: string } | null = null
  const exitMini = (): void => {
    globalShortcut.unregister('Control+Option+Escape')
    cursorOverlay.overlay.hide()
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
    cursorOverlay.overlay.warm()
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
  /** Chats with a bot's question or approval waiting in Needs you (set once the queue exists). */
  const openQuestionThreads: { current: () => string[] } = { current: () => [] }
  /** Dock badge: chats waiting on you + unread chats (top-level, not hidden bots, not the one you're reading). */
  let badgeTimer: ReturnType<typeof setTimeout> | null = null
  const refreshBadge = (): void => {
    if (badgeTimer || QUIET) return
    badgeTimer = setTimeout(() => {
      badgeTimer = null
      try {
        if (!app.dock) return
        const reading = mainFocused() ? viewingThread : null
        const need = new Set([...waiting].filter(([, ids]) => ids.size).map(([t]) => t))
        const hidden = new Set(db.listSpaces().filter((x) => x.hidden).map((x) => x.id))
        for (const t of db.listThreads()) if (t.unread && t.id !== reading && !hidden.has(t.spaceId) && !quickSeen.has(t.id)) need.add(t.id)
        // Bots' questions and approvals waiting in Needs you (agent/questions) count too.
        for (const id of openQuestionThreads.current()) need.add(id)
        app.dock.setBadge(need.size ? String(need.size) : '')
      } catch { /* no Dock, or the database is closing */ }
    }, 200)
  }
  const needsYou = (e: ChatEvent): void => {
    if (e.type === 'pending') {
      waiting.set(e.threadId, (waiting.get(e.threadId) ?? new Set()).add(e.request.id))
      refreshBadge()
      if (QUIET || !Notification.isSupported() || quickRuns.has(e.threadId)) return
      if (mainFocused() && viewingThread === e.threadId) return
      const thread = db.getThread(e.threadId)
      if (!thread || !botNotifies(thread.spaceId)) return
      const now = Date.now()
      if (now - (lastNeedsYou.get(e.threadId) ?? 0) < 60_000) return
      lastNeedsYou.set(e.threadId, now)
      showNote(new Notification({ title: e.request.kind === 'question' || e.request.kind === 'questions' ? `${botName(thread.spaceId)} has a question` : `${botName(thread.spaceId)} needs you`, body: needsYouText(e.request), silent: false }), e.threadId)
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
    // Always on: which chats are running (resume after a quit, keep awake, menu bar icon).
    if (e.type === 'run' && e.threadId) { if (e.status === 'started') work.started(e.threadId); else work.ended(e.threadId) }
    if (e.type === 'run' || e.type === 'pending' || e.type === 'resolved' || e.type === 'thread') menuBar?.refresh()
    if (e.type === 'run' && e.status !== 'started' && mini?.threadId === e.threadId) exitMini()
    const fromQuick = e.type === 'run' && e.status !== 'started' && quickRuns.delete(e.threadId)
    const fromRoutine = e.type === 'run' && e.status !== 'started' && scheduledRuns.delete(e.threadId)
    // A chat finished while you were in another app: a quiet notification.
    if (e.type === 'run' && (e.status === 'finished' || e.status === 'error') && !fromQuick && !fromRoutine && !(quick && !quick.isDestroyed() && quick.isVisible()) &&
      !(win && !win.isDestroyed() && win.isFocused()) && !QUIET && Notification.isSupported() && botNotifies(e.spaceId ?? db.getThread(e.threadId)?.spaceId)) {
      const n = new Notification({ title: e.status === 'error' ? 'SahilBot hit a problem' : 'SahilBot is done', body: (e.title ?? 'Your task').slice(0, 120), silent: false })
      n.on('click', () => openThread(e.threadId))
      n.show()
    }
  }

  // The secrets vault (src/main/secure): envelope encryption, locked until Touch ID / master password,
  // auto-locks when idle, on sleep, on the lock screen and on quit. Old Keychain-only entries migrate on start.
  const vault = new Vault(db, secrets)
  try { vault.start() } catch (e) { console.error('[vault]', (e as Error).message) }
  vault.auth = new VaultAuth({
    core: vault.core,
    touch: electronTouchId(HIDDEN),
    ui: {
      available: () => !!win && !win.isDestroyed(),
      show: (req) => { if (!HIDDEN) showMain(); toWin('vault:auth', req) },
      done: (id) => toWin('vault:auth', { id, done: true })
    }
  })
  vault.core.onChange = () => toWin('vault:changed')
  const stopAutoLock = startAutoLock(vault)
  app.on('before-quit', () => { stopAutoLock(); vault.auth?.cancelAll(); vault.lock('quit') })
  const browser = new BrowserManager(
    () => win,
    (state) => toWin('browser:state', state),
    () => toWin('browser:open')
  )
  // A saved password typed while teaching a task is never recorded, whichever field it went into.
  browser.teach.secretValues = () => vault.secretValues()
  // Saved card numbers never leave the browser unless the user approved that purchase step.
  browser.cardNumbers = () => { try { return vault.cardNumbers() } catch { return [] } }
  // Site playbooks: what SahilBot learns about each website from its browser runs and Teach recordings
  // (never secrets: saved passwords, cards and recent codes are checked against everything stored).
  const sites = new SiteStore(sub('sites'), () => { try { return [...vault.secretValues(), ...browser.hiddenValues()] } catch { return [] } })
  browser.onTeach = (r) => { sites.learnTeach(r.steps, r.name) }
  setSiteHintProvider((url) => sites.hintFor(url))
  listeners.add((e) => {
    if (e.type !== 'run' || !e.threadId) return
    if (e.status === 'started') sites.startRun(e.threadId)
    else sites.endRun(e.threadId, e.status)
  })
  // Purchase and one-time-code cards: approved only by a click in the main window (purchase:respond).
  const purchases = new PurchaseGate({
    emit: (e) => emit(e),
    runInfo: (t) => chat.handoffHost().runInfo(t),
    startedByHandoff: (t) => {
      const last = [...db.listMessages(t)].reverse().find((m) => m.role === 'user' && !m.meta?.hidden)
      return !!(last?.meta?.handoff || last?.meta?.helperTask || last?.meta?.scheduled)
    },
    // Runs the user didn't start by typing in this chat: one-time-code chat grants don't count there.
    automated: (t) => {
      const last = [...db.listMessages(t)].reverse().find((m) => m.role === 'user' && !m.meta?.hidden)
      return !!(last?.meta?.handoff || last?.meta?.helperTask || last?.meta?.scheduled || last?.meta?.goalRun || last?.meta?.fromApp || last?.meta?.mcpClientId)
    },
    otpGrants: { get: () => db.getSetting<string[]>('otp:grants') ?? [], set: (sites) => db.setSetting('otp:grants', sites) },
    otpSenders: { get: () => db.getSetting<Record<string, string[]>>('otp:senders') ?? {}, set: (v) => db.setSetting('otp:senders', v) }
  })

  // Built-in packs of skills and rules ship in packs/; yours live in the data folder.
  const skills = new SkillStore(sub('skills'), join(appRoot(), 'packs', 'skills'))
  const rules = new RuleStore(sub('rules'), join(appRoot(), 'packs', 'rules'))
  const registry = new ToolRegistry()
  // The context engine (People & Places), set up with the knowledge vault below; the memory tool's "about" uses it.
  const worldRef: { current?: ContextEngine } = {}
  registry.register(
    ...coreTools(results),
    ...fileTools(() => settings.get().workspaceDir, docsDir),
    // Office: review_document (core; every new document gets checked) and the office tool (find_tools("office"/"excel"/"pdf")):
    // spreadsheets read/edited in place, PDF forms, merge/split, batch file jobs, receipts, meeting notes.
    reviewDocumentTool({ getWorkspace: () => settings.get().workspaceDir }),
    officeTool({ getWorkspace: () => settings.get().workspaceDir, markdownToPdf: async (md, title) => (await import('./docs/create')).renderPdf(md, { title }),
      // Receipts without a text layer: Claude vision when an Anthropic key is saved and cloud is on.
      visionReceipt: (file, signal) => readReceipt({ access: apiAccess(settings), workspace: () => settings.get().workspaceDir }, file, signal) }),
    ...pageTools(pagesDir),
    ...webTools(() => ({ ...settings.get().search, braveKey: secrets.get('braveKey') })),
    memoryTool(memory, db, skills, rules, () => worldRef.current),
    // Built in and always available (connector tools are found with find_tools).
    { ...browserTool(browser, vault, { gate: purchases, email: (min, site) => recentEmail(min, site), sms: (since) => recentTexts(since), sites }), core: true },
    sitesTool(sites),
    { ...cursorTool(() => secrets.get('cursorKey'), () => settings.get().workspaceDir), core: true },
    { ...macAppsTool(), core: true },
    // Email through Apple Mail (every account in Mail; drafts by default, sending and bulk changes ask).
    { ...mailTool(), core: false, group: 'Email' },
    // Mac apps through their own scripting (Finder, browsers, Office, iWork, Messages, Slack, Music, Xcode, System Settings…).
    appTool(() => settings.get().workspaceDir),
    appHelpTool(),
    // Terminal commands, and background jobs (dev servers, watchers) with the jobs tool to manage them.
    shellTool({ rootsOf: (threadId) => db.getState(threadId).roots ?? [], workspace: () => settings.get().workspaceDir }),
    jobsTool(),
    // Coding: search, symbols, exact edits, patches, tests/type checks/lint with parsed failures; git with a secret scan.
    codeTool({ getWorkspace: () => settings.get().workspaceDir }),
    gitTool(),
    researchTool(),
    // Patient data: find and redact the 18 HIPAA identifiers before text goes anywhere (local, read-only).
    phiTool(),
    agentsTool(),
    // Bot swarms: temporary read-only helpers, then the bot compiles (listed by the bot's Swarm setting).
    swarmTool(),
    computerTool({
      enterMini: (id) => enterMini(id),
      overlay: cursorOverlay.overlay,
      trusted: (prompt) => systemPreferences.isTrustedAccessibilityClient(prompt),
      capture: (file, opts) => captureScreen(file, opts),
      displays: () => {
        const primary = screen.getPrimaryDisplay().id
        return screen.getAllDisplays().map((x) => ({ id: x.id, bounds: x.bounds, scaleFactor: x.scaleFactor, primary: x.id === primary }))
      },
      // SahilBot's own processes and windows: computer use never clicks or types into them.
      self: () => {
        const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible() && !cursorOverlay.windows()?.owns(w))
        return {
          pids: [process.pid, ...app.getAppMetrics().map((m) => m.pid)],
          names: [...new Set([app.getName(), 'SahilBot', ...(app.isPackaged ? [] : ['Electron'])])],
          bundleIds: ['app.sahilbot.desktop', ...(app.isPackaged ? [] : ['com.github.Electron'])],
          titles: wins.map((w) => w.getTitle()).filter(Boolean),
          rects: wins.map((w) => w.getBounds())
        }
      }
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
    updateBotTool(db, spaces, () => emit({ threadId: '', type: 'spaces' })),
    // FRC robot software: logs, vendordeps, project scan, scouting (found with find_tools).
    frcCodeTool({ workspace: () => settings.get().workspaceDir, tbaKey: () => secrets.get('tbaKey') ?? undefined }),
    // FRC mechanical design math: motors, mechanisms, ratios, belt/chain centers, beams, weight (found with find_tools).
    frcMechTool(),
    // CAD: Onshape through the user's API keys (reads free; CAD changes ask, workspaces only), found with find_tools("onshape"/"cad").
    // cad_design: the design workflow (brief → concepts → plan → build → verify) on Onshape, else FreeCAD.
    ...(() => {
      const onshape = onshapeTool({ keys: onshapeKeys, workspace: () => settings.get().workspaceDir, testOrigin: onshapeTestOrigin })
      return [onshape, cadDesignTool({ onshapeKeys, freecadBin: () => findFreecadCmd(), workspace: () => settings.get().workspaceDir, onshape, testOrigin: onshapeTestOrigin })]
    })(),
    // Local CAD files through FreeCAD's command line, only when FreeCAD is installed.
    ...(findFreecadCmd() ? [freecadTool({ workspace: () => settings.get().workspaceDir })] : [])
  )

  const registerQuickKeyRef = { current: (): void => undefined }
  /** Applies Always-on settings changes (menu bar icon, login item, keep awake, paused routines); set further down. */
  const alwaysOnChanged = { current: (_patch: SettingsPatch): void => undefined }
  // Every model server that's on; the last list tells the agent how much context each model can hold.
  const endpoints = new Endpoints(settings)
  // Auto skips cloud models this month's remaining budget couldn't pay for.
  // Unlimited and None leave it undefined: no cap to skip models for (None keeps Auto off pay-per-use models in routing).
  endpoints.budgetLeft = () => { const b = budget.summary(); return b.mode === 'amount' ? budgetLeftFor(b.mode, b.cap, b.spent) : undefined }
  const fitWindow =(model: string, window: number): number => {
    const m = endpoints.last?.models.find((x) => x.id === model)
    if (!m || m.note === 'remote') return window
    // Never below 16k; otherwise the largest window this Mac's memory allows with this model. On Auto
    // (context window 0) at most 64k on 48 GB+ Macs and 32k on smaller ones: bigger costs memory and speed.
    const cap = settings.get().contextWindow ? window : Math.min(window, autoWindow(machine().budgetGB))
    return Math.max(16384, Math.min(cap, m.maxFittingWindow || 32768))
  }

  const connectors = new Connectors(db, secrets, registry, () => toWin('connectors:changed'))
  // Emailed sign-in codes: the Gmail connector when it's connected, else Mail.app (read in main, never shown to the model).
  setEmailCodeSource(gmailCodeSource((tool, args, signal) => connectors.callPresetTool('gmail', tool, args, signal)), () => connectors.presetConnected('gmail'))

  /** Goals (set up further down): an unattended goal wake-up's call that needs approval is queued for the user. */
  const goalHooks: { ask?: (threadId: string, info: { tool: string; label: string; summary?: string; reason?: string }) => string | undefined } = {}
  // The knowledge vault (set up with the knowledge base below): each run's context gets its most relevant
  // notes, sized to the model's window (a cloud model's own window, else what fits on this Mac).
  const notesVaultRef: { current?: VaultService } = {}
  const notesVaultWindow = (model?: string): number => {
    if (!model) return 32_768
    const m = endpoints.last?.models.find((x) => x.id === model)
    let remote = m?.note === 'remote'
    try { remote ||= !isLocal(endpoints.for(model).baseUrl) } catch { /* unknown: local */ }
    return remote ? m?.contextTokens ?? 200_000 : fitWindow(model, settings.get().contextWindow || 131072)
  }
  // Computer use as Planner + executor (agent/cua): the planner plans and checks, the run's model executes.
  const cua = createCua({ db, emit, settings: () => settings.get(), endpoints })
  registry.register(checkpointTool(() => cua))
  // ---------------------------------------------------------------- always-on bots: the question queue (agent/questions)
  // A bot's questions and approvals don't stop it: they wait in Needs you (persisted), the user hears on the
  // Mac and paired devices, and a later answer resumes the bot. Deadlines go ahead with safe defaults only.
  const questionStore = new QuestionStore(db)
  const learner = new Learner(questionStore, memory)
  const chatRef: { current: Agent | null } = { current: null }
  let needsYouTimer: ReturnType<typeof setTimeout> | null = null
  const questions = new QuestionQueue({
    store: questionStore, learner,
    botName: (id) => botName(id),
    threadExists: (id) => !!db.getThread(id),
    notify: (item, o) => {
      const r: PendingRequest = item.kind === 'approval'
        ? { id: item.id, threadId: item.threadId, kind: 'approval', tool: item.approval?.tool, label: item.approval?.label, summary: item.approval?.summary }
        : { id: item.id, threadId: item.threadId, kind: item.questions.length > 1 ? 'questions' : 'question', question: item.questions[0]?.question, questions: item.questions }
      const body = needsYouText(r)
      notifyQuestionDevices({ kind: item.kind, title: o.title, body, botId: item.botId, threadId: item.threadId, itemId: item.id })
      const space = db.getSpace(item.botId)
      if (!space || space.notify === false || QUIET || !Notification.isSupported() || (mainFocused() && viewingThread === item.threadId)) return
      showNote(new Notification({ title: o.title, body, silent: false }), item.threadId)
    },
    resume: async (item, msg) => {
      const c = chatRef.current
      if (!c) throw new Error('SahilBot is still starting')
      const meta = { ...msg.meta, ...(msg.hidden ? { hidden: true } : {}) }
      // The bot is working: the answer joins its run at the next step. Otherwise it starts a run to pick it up.
      if (c.isRunning(item.threadId)) { await c.steer(item.threadId, msg.text, { ...meta, note: msg.note }); return }
      if (msg.unattended) scheduledRuns.add(item.threadId)
      try {
        const { done } = await c.send({ threadId: item.threadId, text: msg.text, note: msg.note, meta }, { unattended: msg.unattended })
        void done.finally(() => { if (msg.unattended) scheduledRuns.delete(item.threadId) })
      } catch (e) { if (msg.unattended) scheduledRuns.delete(item.threadId); throw e }
    },
    // Over the monthly limit with nothing local to run on: the answer is kept and picked up later.
    held: () => {
      const b = budget.summary()
      if (b.mode !== 'amount' || b.spent < b.cap) return null
      return endpoints.usable().some((m) => { try { return isLocal(endpoints.for(m.id).baseUrl) } catch { return false } }) ? null : 'the monthly spending limit is used up'
    },
    notice: (threadId, text, meta) => {
      const m = db.insertMessage({ threadId, role: 'assistant', content: text, kind: 'notice', status: 'done', ...(meta ? { meta } : {}) })
      emit({ threadId, type: 'message', message: m })
    },
    changed: () => {
      refreshBadge()
      if (needsYouTimer) return
      needsYouTimer = setTimeout(() => { needsYouTimer = null; toWin('needsYou:changed') }, 150)
    }
  })
  openQuestionThreads.current = () => questionStore.list({ status: ['open'] }).map((x) => x.threadId).filter((id) => !!db.getThread(id))
  // The card shows for a while when you're looking at the bot's chat; otherwise it goes to Needs you at once.
  const questionHost = createQuestionHost({ db, settings, queue: questions, learner, grace: (threadId) => (mainFocused() && viewingThread === threadId ? ATTENDED_GRACE_MS : 0) })
  const chat = new Agent({
    questions: questionHost,
    cua,
    connectors,
    db, settings, endpoints, spaces, memory, skills, rules, registry, results, docsDir, emit, fitWindow,
    // Saved passwords and cards, plus one-time codes typed in the last 10 minutes: no tool call may carry them.
    secretValues: () => [...vault.secretValues(), ...browser.hiddenValues()],
    // Any saved value that still shows up in a tool result or error is masked before the model reads it.
    redact: (text) => vault.redact(text),
    onUnattendedAsk: (threadId, info) => goalHooks.ask?.(threadId, info),
    vaultContext: (o) => notesVaultRef.current?.context({ spaceId: o.spaceId, query: o.query, local: o.local, window: notesVaultWindow(o.model) }) ?? null,
    // One "About the user and their world" section: memories + vault notes + people/places cards (src/main/context-engine).
    worldContext: (o) => worldRef.current?.context({ threadId: o.threadId, spaceId: o.spaceId, query: o.query, window: notesVaultWindow(o.model), local: o.local, memories: o.memories, vault: o.vault, openerId: o.openerId }) ?? null
  })
  chatRef.current = chat
  // Bot-to-bot handoffs need the agent itself (to start or steer the other bot's run).
  registry.register(handoffTool(() => chat.handoffHost()))
  // Bots asking bots for information (read-only answers, loop-protected).
  registry.register(askBotTool({ bots: () => db.listSpaces() }))
  // Local models: load the one we expect to use (and read its prompt prefix) in the background, so the
  // first reply after launch or a model switch doesn't wait for it.
  const warmup = new Warmup({ endpoints, settings, fitWindow, recentModel: () => lastUsedModel(db), prefix: (window) => chat.warmPrefix(window), busy: () => chat.busy() })
  if (warmupAllowed()) setTimeout(() => warmup.soon(), 4000)
  // Paid requests made during a run are recorded against that run's bot.

  if (db.listSpaces().length === 0) db.createSpace('SahilBot', '#1F1F1F', { isMain: true, shape: 'mascot' })
  const attachments = new Attachments(() => win, () => settings.get().workspaceDir, docsDir)
  attachments.registerProtocol()
  // Pages run only in their own session (the side-panel view, their window, PDF/thumbnail renderers).
  const pagePanel = new PagePanel(() => win, pagesDir)
  // ---- Docs (live documents the bot and the user both edit; src/main/docspace) ----
  const docs = new DocStore(db.sql)
  docs.onChange((e) => toWin('docs:event', e))
  // Before the bot reads or edits a document, unsaved edits in the editor are saved first (briefly waited for).
  const docsDirty = new Set<string>()
  const docsFlushWaits = new Map<string, () => void>()
  docs.beforeBotAccess = (id) => !docsDirty.has(id) || !win || win.isDestroyed() ? Promise.resolve() : new Promise<void>((done) => {
    const finish = (): void => { docsFlushWaits.delete(id); done() }
    docsFlushWaits.set(id, finish)
    toWin('docs:flush', id)
    setTimeout(finish, 1500)
  })
  registry.register(...docTools({ store: docs, workspace: () => settings.get().workspaceDir, spaceOf: (threadId) => db.getThread(threadId)?.spaceId }))
  applyTheme(settings.get().theme)

  /** Calls that change what's unread refresh the Dock badge. */
  const BADGE_IPC = new Set(['threads:update', 'threads:remove', 'spaces:markUnread', 'spaces:update', 'spaces:remove'])
  const handle = <A extends unknown[], R>(ch: string, fn: (...args: A) => R | Promise<R>): void => {
    if (BADGE_IPC.has(ch)) registerHandler(ch, async (_ctx, ...args) => { try { return await fn(...(args as A)) } finally { refreshBadge() } })
    else registerHandler(ch, (_ctx, ...args) => fn(...(args as A)))
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
    const wasLocal = localOn(settings.get())
    const s = settings.set(patch)
    // Local models switched on or off: the model list (and Auto) follow at once.
    if (patch.local !== undefined && wasLocal !== localOn(s)) {
      // Turned on: an Ollama that's already installed starts (nothing is downloaded or installed here).
      if (localOn(s) && !process.env.FOREMAN_BASE_URL) void startOllama(settings.providers().ollama.baseUrl).catch(() => undefined)
      void endpoints.list().catch(() => undefined)
    }
    if (warmupAllowed() && (patch.defaultModel !== undefined || patch.contextWindow !== undefined || patch.localKeepAlive !== undefined)) warmup.soon()
    if (patch.quickKey !== undefined) registerQuickKeyRef.current()
    if (patch.theme) applyTheme(s.theme)
    alwaysOnChanged.current(patch)
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

  // ---------------------------------------------------------------- ChatGPT plan (via Codex)
  // The user's own Codex (OpenAI's CLI) signs in with ChatGPT; SahilBot checks its status with Codex's
  // documented commands and runs plan models through it (llm/codex, docs/chatgpt-plan.md).
  chatgptPlan.configure({
    dir: sub('chatgpt-plan'),
    version: (() => { try { return (JSON.parse(readFileSync(join(appRoot(), 'package.json'), 'utf8')) as { version: string }).version } catch { return app.getVersion() } })(),
    hooks: {
      openExternal: (url) => { if (/^https:\/\//i.test(url)) void shell.openExternal(url) },
      changed: () => toWin('chatgptPlan:changed')
    }
  })
  const planChanged = async (): Promise<ReturnType<typeof chatgptPlan.status>> => { await endpoints.list().catch(() => undefined); return chatgptPlan.status() }
  handle('chatgptPlan:status', async (refresh?: boolean) => (refresh ? chatgptPlan.refresh() : chatgptPlan.refreshIfStale()))
  handle('chatgptPlan:connect', async (o?: { signIn?: boolean }) => { await chatgptPlan.connect({ signIn: o?.signIn === true }); return planChanged() })
  handle('chatgptPlan:loginInTerminal', () => chatgptPlan.loginInTerminal())
  handle('chatgptPlan:disconnect', async () => { chatgptPlan.disconnect(); return planChanged() })
  handle('chatgptPlan:setPrefs', async (patch: { preferPlan?: boolean; codexPath?: string | null }) => {
    const p = patch && typeof patch === 'object' ? patch : {}
    chatgptPlan.setPrefs({
      ...(typeof p.preferPlan === 'boolean' ? { preferPlan: p.preferPlan } : {}),
      // Only an absolute path to something named codex.
      ...(p.codexPath === null || (typeof p.codexPath === 'string' && /^\/.*\/codex$/.test(p.codexPath)) ? { codexPath: p.codexPath } : {})
    })
    if (p.codexPath !== undefined) await chatgptPlan.refresh()
    return planChanged()
  })
  handle('chatgptPlan:openInstallGuide', () => { void shell.openExternal(CODEX_INSTALL_URL) })
  app.on('before-quit', () => { void closeCodexRuns() })
  // Check in the background at start when it's switched on (the model list waits for a stale check anyway).
  if (chatgptPlan.prefs().enabled) void chatgptPlan.refresh().then(() => endpoints.list()).catch(() => undefined)
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
    const variant = autoVariant(model)
    const id = variant ? autoPool(variant, endpoints.usable()).sort((a, b) => b.tier - a.tier || (b.rank ?? 0) - (a.rank ?? 0))[0]?.id : model
    return teamCapacity(endpoints.last?.models.find((m) => m.id === id))
  })

  // Settings → Onshape → Test: the saved key pair against GET /users/sessioninfo (keys never leave main).
  handle('onshape:test', () => testOnshapeKeys({ keys: onshapeKeys, testOrigin: onshapeTestOrigin }))

  handle('models:test', async (baseUrl: string, apiKey?: string) => {
    const r = await providerModels('custom', 'Test', baseUrl, apiKey || settings.keyFor(baseUrl), settings.get().contextWindow || 32768)
    return r.ok ? { ok: true, count: r.models.length } : { ok: false, count: 0, error: r.error }
  })

  // One-click downloads of recommended models through Ollama, with progress.
  const pulling = new Set<string>()
  // One click: install Ollama if needed (verified, no admin password) and run it in the background.
  // Local models are opt-in: nothing installs or downloads while they're off (Settings → Models → Turn on).
  const needLocal = (): void => { if (localOff(settings.get())) throw new Error('Local models are off. Turn them on in Settings → Models first.') }
  handle('ollama:setup', () => { needLocal(); return setupOllama(settings.providers().ollama.baseUrl, (e) => toWin('ollama:setup', e)) })
  handle('ollama:installed', () => !!findOllamaBinary())

  handle('models:pull', async (tag: string) => {
    needLocal()
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

  // Deletes a downloaded model from Ollama (Settings → Models asks first). Only models Ollama listed.
  handle('models:delete', async (tag: string) => {
    if (typeof tag !== 'string' || !/^[\w.\-/]+(:[\w.\-]+)?$/.test(tag) || pulling.has(tag)) return { ok: false, error: 'That model can\'t be deleted right now.' }
    if (!endpoints.last?.models.some((m) => m.id === tag && m.provider === 'ollama' && m.installed)) await endpoints.list().catch(() => undefined)
    if (!endpoints.last?.models.some((m) => m.id === tag && m.provider === 'ollama' && m.installed)) return { ok: false, error: `${tag} isn't downloaded in Ollama.` }
    try {
      const res = await fetch(`${root(settings.providers().ollama.baseUrl)}/api/delete`, { method: 'DELETE', body: JSON.stringify({ model: tag }), signal: AbortSignal.timeout(30_000) })
      if (!res.ok) return { ok: false, error: `Ollama answered ${res.status}${res.status === 404 ? ': it was already deleted' : ''}` }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message.includes('fetch failed') ? 'Ollama isn\'t running.' : (e as Error).message }
    } finally {
      void endpoints.list().catch(() => undefined)
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
    // A new bot works at Autonomous (its Bot details level); groups and projects keep the app default.
    const thread = db.createThread(space.id, kind === 'bot' ? botLevel(settings.get(), space) : 'auto', null)
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
  handle('spaces:update', (id: string, patch: Partial<Pick<Space, 'name' | 'color' | 'shape' | 'pinned' | 'hidden' | 'members' | 'model' | 'label' | 'notify' | 'effort'>>) => {
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
    // Background jobs belong to the bot's chats: they stop with it.
    void jobs.stopThreads(db.listThreads(id).map((t) => t.id))
    db.deleteSpace(id)
    for (const g of db.listSpaces().filter((x) => x.kind === 'group' && x.members.includes(id))) db.updateSpace(g.id, { members: g.members.filter((m) => m !== id) })
  })
  handle('spaces:getPrompt', (id: string) => spaces.getPrompt(id))
  handle('spaces:setPrompt', (id: string, text: string) => spaces.setPrompt(id, text))
  handle('spaces:promptPath', (id: string) => spaces.path(id))
  // Bot details → Library: files this bot made (that still exist) and links from its chats.
  handle('spaces:library', (id: string) => [...db.spaceLibrary(id).filter((x) => x.kind !== 'file' || (!!x.path && existsSync(x.path))), ...docs.libraryItems(id)].sort((a, b) => b.at - a.at))

  handle('threads:list', (spaceId?: string) => db.listThreads(spaceId))
  handle('threads:search', (q: string) => db.searchThreads(q))
  // New chats start at the bot's autonomy level, else the app default (never Bypass).
  handle('threads:create', (spaceId: string) => {
    const s = settings.get()
    const space = db.getSpace(spaceId)
    // An always-on bot without its own pick works at Autonomous; everything else keeps the app default.
    const m = space && isAlwaysOnBot(space) ? botLevel(s, space) : s.botModes?.[spaceId] ?? s.defaultMode
    return db.createThread(spaceId, isPermissionMode(m) && m !== 'bypass' ? m : 'auto', null)
  })
  handle('threads:update', (id: string, patch: Parameters<Db['updateThread']>[1]) => {
    // Bypass only when Settings offers it (advanced.allowBypass); a chat already in Bypass may stay there.
    if (patch && 'permissionMode' in patch && !modeChangeAllowed(patch.permissionMode, { allowBypass: settings.get().advanced.allowBypass, current: db.getThread(id)?.permissionMode })) {
      throw new Error(patch.permissionMode === 'bypass' ? 'Bypass is turned off in Settings → Advanced.' : `Unknown autonomy level "${String(patch.permissionMode)}".`)
    }
    // A local model picked for this chat: load it while the user types.
    if (patch.model && warmupAllowed()) warmup.soon(patch.model)
    return db.updateThread(id, patch)
  })
  handle('threads:remove', (id: string) => {
    chat.stop(id)
    void jobs.stopThreads([id])
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
    // A working folder chosen before the chat existed: only one the user picked this session.
    if (typeof input.workingFolder === 'string' && !attachments.accept([input.workingFolder]).length) input = { ...input, workingFolder: undefined }
    // Attached folders (and the working folder) become searchable in the knowledge base, for this chat's bot.
    const sid = db.getThread(input.threadId)?.spaceId ?? null
    for (const f of [...(input.attachments ?? []).filter((a) => a.kind === 'folder' && ok.has(a.path)).map((a) => a.path), ...(typeof input.workingFolder === 'string' ? [input.workingFolder] : [])]) {
      try { if (!knowledge.sources().some((x) => !x.problem && (x.path === f || f.startsWith(`${x.path}/`)))) knowledge.addFolder(f, 'attached', sid) } catch { /* refused (home, ~/Library…): readable, not indexed */ }
    }
    // The chat was cut off by SahilBot closing: "continue" picks the task up where it stopped.
    const resumed = !chat.isRunning(input.threadId) && work.isInterrupted(input.threadId)
    const note = resumed ? [input.note, RESUME_NEXT_NOTE].filter(Boolean).join('\n') : input.note
    await chat.send({ ...input, ...(note ? { note } : {}), attachments: (input.attachments ?? []).filter((a) => ok.has(a.path)) })
    if (resumed) { const m = work.clearNotice(input.threadId); if (m) emit({ threadId: input.threadId, type: 'message', message: m }) }
  })
  handle('files:pick', (kind: 'files' | 'folder') => attachments.pick(kind))
  handle('files:register', async (paths: string[]) => (await attachments.add(paths)).added)
  // ---- Attachments: drops, pastes, screenshots, folder scans and working folders (attachments.ts) ----
  handle('attach:add', async (input: { paths?: string[]; blobs?: Array<{ name: string; type: string; data: Uint8Array }> }) => {
    const r = await attachments.add(Array.isArray(input?.paths) ? input.paths.map(String) : [])
    for (const b of (Array.isArray(input?.blobs) ? input.blobs : []).slice(0, 20)) {
      const x = await attachments.addBlob(String(b.name ?? ''), String(b.type ?? ''), b.data instanceof Uint8Array ? b.data : new Uint8Array(b.data as ArrayLike<number>))
      r.added.push(...x.added)
      r.rejected.push(...x.rejected)
    }
    return r
  })
  handle('attach:pick', (kind: 'files' | 'folder') => attachments.pickAll(kind === 'folder' ? 'folder' : 'files'))
  // Only from the user's click in the composer (never a tool): macOS's own region picker.
  handle('attach:screenshot', () => (HIDDEN ? null : attachments.screenshot()))
  handle('attach:scanFolder', async (path: string) => {
    const p = String(path ?? '')
    if (!attachments.wasPicked(p)) throw new Error('Attach that folder first.')
    return scanFolder(p, { onProgress: (e) => toWin('attach:scan', e) })
  })
  /** The chat's working folder: its own choice, else its bot's or project's folder. */
  const workingFolder = (threadId: string): import('@shared/types').WorkingFolder => {
    const t = db.getThread(String(threadId ?? ''))
    if (!t) return { path: null, source: null }
    const st = db.getState(t.id)
    if (st.workFolder && existsSync(st.workFolder)) return { path: st.workFolder, source: 'chat' }
    const sp = db.getSpace(t.spaceId)
    if (sp?.folder && existsSync(sp.folder)) return { path: sp.folder, source: sp.kind === 'project' ? 'project' : 'bot' }
    return { path: null, source: null }
  }
  const setWorkingFolder = (threadId: string, path: string | null): import('@shared/types').WorkingFolder => {
    const st = db.getState(threadId)
    st.workFolder = path ?? undefined
    if (path && !(st.roots ?? []).includes(path)) st.roots = [...(st.roots ?? []), path]
    db.setState(threadId, st)
    if (path) { try { if (!knowledge.sources().some((x) => !x.problem && (x.path === path || path.startsWith(`${x.path}/`)))) knowledge.addFolder(path, 'attached', db.getThread(threadId)?.spaceId ?? null) } catch { /* not indexable */ } }
    return workingFolder(threadId)
  }
  handle('attach:folder', (threadId: string) => workingFolder(threadId))
  handle('attach:pickFolder', async (threadId: string) => {
    if (!db.getThread(String(threadId ?? ''))) throw new Error('That chat is gone.')
    const r = await attachments.pickAll('folder')
    const f = r.added.find((a) => a.kind === 'folder')
    if (!f) return null
    attachments.accept([f.path])
    return setWorkingFolder(String(threadId), f.path)
  })
  handle('attach:clearFolder', (threadId: string) => { if (!db.getThread(String(threadId ?? ''))) throw new Error('That chat is gone.'); return setWorkingFolder(String(threadId), null) })
  // A bot's "Works in folder": its chats work there unless a chat picks its own.
  handle('attach:pickBotFolder', async (spaceId: string) => {
    const sp = db.getSpace(String(spaceId ?? ''))
    if (!sp || sp.kind === 'group') throw new Error('Only a bot can have a working folder.')
    const r = await attachments.pickAll('folder')
    const f = r.added.find((a) => a.kind === 'folder')
    if (!f) return null
    attachments.accept([f.path])
    attachments.allow(f.path)
    const updated = db.updateSpace(sp.id, { folder: f.path })
    // Searchable right away (the bot's folder is one of the knowledge base's sources).
    void knowledge.refresh(false).catch(() => undefined)
    return updated
  })
  handle('attach:clearBotFolder', (spaceId: string) => {
    const sp = db.getSpace(String(spaceId ?? ''))
    if (!sp || sp.kind !== 'bot') throw new Error('Only a bot\'s working folder can be cleared here.')
    const updated = db.updateSpace(sp.id, { folder: null })
    void knowledge.refresh(false).catch(() => undefined)
    return updated
  })
  // ---- Local models opt-in (Settings → Models, onboarding) ----
  handle('local:status', () => ({ enabled: localOn(settings.get()), installed: !!findOllamaBinary() || hasLocalModels() }))
  handle('local:set', async (enabled: boolean) => {
    const s = settings.set({ local: { enabled: !!enabled } })
    // Turned on: an Ollama that's already installed starts (nothing is downloaded here).
    if (enabled && !process.env.FOREMAN_BASE_URL) void startOllama(settings.providers().ollama.baseUrl).catch(() => undefined)
    void endpoints.list().catch(() => undefined)
    return s
  })
  handle('files:preview', (path: string) => attachments.preview(path))
  // Pages open in their own locked-down window, never in the default browser.
  handle('files:open', async (path: string) => { if (isPagePath(pagesDir(), path)) openPageWindow(pagesDir, path, { show: !HIDDEN }); else await attachments.open(path) })
  handle('pages:info', (path: string) => pageInfo(pagesDir(), path))
  handle('pages:openWindow', (path: string) => { openPageWindow(pagesDir, path, { show: !HIDDEN }) })
  handle('pages:exportPdf', (path: string) => exportPagePdf(pagesDir, path))
  handle('pages:show', (path: string | null, rev?: string, bounds?: PanelBounds | null) => { if (path) return pagePanel.show(path, String(rev ?? ''), bounds ?? null); pagePanel.close(); return null })
  handle('pages:thumbnail', (path: string) => pageThumbnail(pagesDir, path))
  // ---- Docs IPC (the Document tab) ----
  handle('docs:list', (threadId: string) => docs.list(threadId))
  handle('docs:get', (id: string) => docs.get(id))
  handle('docs:create', (threadId: string, title: string, type?: 'doc' | 'sheet') => {
    const t = db.getThread(threadId)
    if (!t) throw new Error('Thread not found')
    return docs.create({ threadId, spaceId: t.spaceId, title: title || 'Untitled', type, content: { blocks: type === 'sheet' ? [] : [{ id: 'b000', type: 'p', text: '' }] }, author: 'user' })
  })
  handle('docs:save', (id: string, base: number, content: import('@shared/types').DocContent) => {
    const snap = docs.saveUser(id, Number(base), content)
    docsDirty.delete(id)
    docsFlushWaits.get(id)?.()
    return snap
  })
  handle('docs:versions', (id: string) => docs.versions(id))
  handle('docs:version', (id: string, n: number) => docs.version(id, Number(n)))
  handle('docs:diff', (id: string, from: number, to: number) => docs.diff(id, Number(from), Number(to)))
  handle('docs:restore', (id: string, n: number) => docs.restore(id, Number(n)))
  handle('docs:export', async (id: string, format: import('@shared/types').DocExportFormat) => {
    const path = await exportDoc(docs.get(id), format, join(settings.get().workspaceDir, 'exports'))
    attachments.allow(path)
    if (!HIDDEN) shell.showItemInFolder(path)
    return path
  })
  handle('docs:addImage', async () => {
    const opts: Electron.OpenDialogOptions = { title: 'Add an image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    // Copied into the workspace so the editor may show it (and exports can find it).
    const dir = join(settings.get().workspaceDir, 'doc-images')
    mkdirSync(dir, { recursive: true })
    const dest = join(dir, `${Date.now().toString(36)}-${basename(r.filePaths[0]).replace(/[^\w.-]+/g, '-')}`)
    copyFileSync(r.filePaths[0], dest)
    return dest
  })
  handle('docs:dirty', (id: string, dirty: boolean) => { if (dirty) docsDirty.add(id); else { docsDirty.delete(id); docsFlushWaits.get(id)?.() } })
  handle('docs:flushed', (id: string) => { docsDirty.delete(id); docsFlushWaits.get(id)?.() })
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
  handle('connectors:list', () => ({ configs: connectors.list(), statuses: connectors.statuses(), keys: connectors.keyIds() }))
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
  handle('connectors:test', (id: string) => connectors.test(id))
  handle('connectors:googleClient', () => connectors.googleClient())
  handle('connectors:setGoogleClient', (clientId: string, clientSecret: string) => connectors.setGoogleClient(clientId, clientSecret))
  handle('connectors:clearGoogleClient', () => connectors.clearGoogleClient())
  // The key goes straight to the Keychain; only a status comes back (errors are redacted in connectors.ts).
  handle('connectors:setApiKey', (presetId: string, key: string) => connectors.setApiKey(presetId, key))
  handle('connectors:checkAll', () => connectors.checkEvery())
  void connectors.connectAll()
  // Health: a tools/list check every few minutes; dropped connections reconnect with backoff.
  connectors.startHealth()

  // ---------------------------------------------------------------- markets (read-only stock data; never trades)
  const markets = new Markets(new MarketData({
    cacheDir: sub('markets-cache'),
    keys: () => settings.marketKeys(),
    quoteProvider: () => settings.get().markets?.quoteProvider ?? 'auto',
    // SEC asks for an app name and contact; a generic one unless the user sets their own in Settings → Markets.
    secUserAgent: () => `SahilBot/0.1 (${settings.get().markets?.secContact || 'contact@example.com'})`
  }))
  /** A live (intraday) quote source is set: alerts check every 15 minutes in market hours, not once a day. */
  const liveQuotes = (): boolean => (settings.get().markets?.quoteProvider ?? 'auto') !== 'none' && Object.keys(settings.marketKeys()).length > 0

  // ---------------------------------------------------------------- scheduled tasks
  const scheduler = new Scheduler(db, async (task, info) => {
    const space = db.getSpace(task.spaceId)
    if (!space) return 'error: its bot was deleted'
    // Price alerts (price_alert tool): a plain data check, no model call; the chat hears only when one fires.
    const priceAlert = alertFromPrompt(task.prompt)
    let alertHit: Awaited<ReturnType<typeof markets.checkAlert>> | null = null
    if (priceAlert) {
      if (!info.test && liveQuotes() && !usMarketOpen(new Date())) return 'done'
      const key = `priceAlert:${task.id}`
      alertHit = await markets.checkAlert(priceAlert, db.getSetting<AlertState>(key))
      db.setSetting(key, alertHit.state)
      if (!alertHit.fired && !info.test) return 'done'
    }
    // Bots get reminders in their one conversation; SahilBot and projects keep a thread per task.
    let threadId = space.isMain || space.kind === 'project' ? task.threadId : db.listThreads(space.id)[0]?.id ?? null
    if (!threadId || !db.getThread(threadId)) {
      const t = db.createThread(space.id, isAlwaysOnBot(space) ? botLevel(settings.get(), space) : 'auto', null)
      db.updateThread(t.id, { title: space.isMain || space.kind === 'project' ? `⏰ ${task.title}` : space.name })
      threadId = t.id
      scheduler.setThread(task.id, threadId)
    }
    if (priceAlert && alertHit) {
      const text = alertHit.text ?? `Price alert check (test): ${alertHit.observed}; "${task.title.replace(/^Price alert:\s*/, '')}" is not met, so nothing fired.`
      const m = db.insertMessage({ threadId, role: 'assistant', content: text, kind: 'normal', status: 'done', meta: { scheduled: task.id, priceAlert: true, ...(alertHit.card ? { stock: alertHit.card } : {}) } })
      emit({ threadId, type: 'message', message: m })
      if (alertHit.fired && space.notify !== false && !QUIET && Notification.isSupported() && !(mainFocused() && viewingThread === threadId)) {
        showNote(new Notification({ title: `${space.isMain ? 'SahilBot' : space.name}: ${task.title}`, body: alertHit.observed }), threadId)
      }
      // Fires once unless it repeats.
      if (alertHit.fired && !priceAlert.repeat && !info.test) scheduler.update(task.id, { enabled: false })
      return { status: 'done', threadId }
    }
    if (chat.isRunning(threadId)) return { status: 'skipped: the chat was busy', threadId }
    const startedAt = Date.now()
    scheduledRuns.add(threadId)
    let status: Awaited<Awaited<ReturnType<typeof chat.send>>['done']>
    try {
      // A missed run catching up: the bot knows it's late (time-sensitive steps may need adjusting).
      const late = info.late !== undefined ? { note: `[This routine was due at ${new Date(info.late).toLocaleString()} but SahilBot was closed or the Mac was asleep, so it is running late now. Adjust anything time-sensitive.]` } : {}
      const { done } = await chat.send({ threadId, text: `⏰ ${task.title}\n\n${task.prompt}`, ...late, meta: { scheduled: task.id, ...(info.late !== undefined ? { late: info.late } : {}) } }, { unattended: true })
      status = await done
    } finally { scheduledRuns.delete(threadId) }
    const after = db.listMessages(threadId).filter((m) => m.createdAt >= startedAt)
    const last = [...after].reverse().find((m) => m.role === 'assistant' && m.content && m.kind === 'normal')
    // The routine's own notification (the generic "done" one is skipped for routine runs). Click opens the chat.
    if (space.notify !== false && !QUIET && Notification.isSupported() && !(mainFocused() && viewingThread === threadId)) {
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
    const verb = { created: 'Created', paused: 'Paused', resumed: 'Resumed', deleted: 'Deleted', changed: 'Changed', failed: 'Routine failed', late: 'Ran late', missed: 'Missed' }[ev.type]
    const when = (ms: number): string => new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    const text = ev.type === 'failed' ? `Routine failed · ${ev.task.title}${ev.reason ? `: ${ev.reason}` : ''}`
      : ev.type === 'late' ? `Ran late · ${ev.task.title}: was due at ${when(ev.dueAt ?? Date.now())}`
        : ev.type === 'missed' ? `Missed routine · ${ev.task.title}: was due at ${when(ev.dueAt ?? Date.now())} while SahilBot was closed${ev.task.enabled && ev.task.nextRun ? `. Next run ${when(ev.task.nextRun)}` : ''}`
          : `${verb} routine · ${ev.task.title}`
    const m = db.insertMessage({ threadId, role: 'assistant', content: text, kind: 'notice', status: 'done', meta: { routineNotice: ev.type, routine: ev.task.id } })
    emit({ threadId, type: 'message', message: m })
  }
  registry.register({ ...scheduleTool(scheduler, db), core: true })
  // Stock tools (found with find_tools "stock"): quotes, analysis, forecasts, compare, backtests, price alerts.
  registry.register(...stockTools(markets, { scheduler, db, liveQuotes }))
  // Missed runs (closed or asleep) catch up once within Settings → General → "Catch up on missed routines".
  scheduler.catchUpHours = () => settings.get().catchUpHours ?? 12
  scheduler.paused = () => !!settings.get().routinesPaused
  scheduler.start()
  // Waking from sleep: check for due (missed) routines now rather than at the next tick, once the network is back.
  powerMonitor.on('resume', () => { setTimeout(() => void scheduler.tick().catch(() => undefined), 5000) })
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
  /** How a template, an imported file or a duplicate becomes a bot. */
  const templateDeps: TemplateDeps = {
    createBot: (name, color, shape) => {
      const space = db.createSpace(name, color, { kind: 'bot', shape })
      const thread = db.createThread(space.id, botLevel(settings.get(), space), null)
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
  }
  handle('templates:list', () => loadTemplates(templatesDir))
  handle('templates:add', (id: string) => {
    const t = loadTemplates(templatesDir).find((x) => x.id === id)
    if (!t) throw new Error('That template is no longer available.')
    return addTemplate(t, templateDeps)
  })

  // ---------------------------------------------------------------- share, import and duplicate bots
  /** Every saved secret (API keys, passwords, connector tokens), so an exported bot never carries one. */
  const secretValues = (): string[] => {
    const keys = db.sql.prepare(`SELECT key FROM settings WHERE key LIKE 'secret:%'`).all() as Array<{ key: string }>
    // Plus the vault's values (they live in the envelope vault now, not in secret:* rows).
    return [...keys.map((k) => secrets.get(k.key.slice('secret:'.length))).filter((v): v is string => !!v), ...vault.secretValues()]
  }
  const skillNames = (): string[] => skills.list().map((sk) => sk.name)
  const pendingImports = new PendingImports()
  handle('bots:export', async (id: string) => {
    const space = db.getSpace(id)
    if (!space || space.kind !== 'bot') throw new Error('Only bots can be shared.')
    const { file, redacted } = botFileFor({ space, prompt: spaces.getPrompt(id), routines: scheduler.list().filter((t) => t.spaceId === id), skillNames: skillNames(), secrets: secretValues() })
    const safe = file.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/^\.+/, '').slice(0, 60) || 'bot'
    const r = win ? await dialog.showSaveDialog(win, { defaultPath: `${safe}${BOT_FILE_EXT}`, filters: [{ name: 'SahilBot bot', extensions: ['json'] }] }) : { canceled: true }
    if (r.canceled || !('filePath' in r) || !r.filePath) return null
    writeFileSync(r.filePath, JSON.stringify(file, null, 2) + '\n')
    return { path: r.filePath, redacted }
  })
  handle('bots:importPick', async () => {
    const r = win ? await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'SahilBot bot', extensions: ['json'] }] }) : { canceled: true, filePaths: [] }
    const path = r.canceled ? undefined : r.filePaths[0]
    if (!path) return null
    const size = statSync(path).size
    // Checked before reading, so a huge file is never loaded.
    const file = parseBotFile(size > BOT_FILE_MAX_BYTES ? '' : readFileSync(path, 'utf8'), size)
    const preview = importPreview(file, basename(path), skillNames())
    pendingImports.put(preview)
    return preview
  })
  handle('bots:importConfirm', (token: string) => {
    const p = pendingImports.take(token)
    const made = addTemplate(importTemplate(p), templateDeps)
    if (p.label) db.updateSpace(made.spaceId, { label: p.label })
    emit({ threadId: '', type: 'spaces' })
    openThread(made.threadId)
    return made
  })
  handle('bots:duplicate', (id: string) => {
    const made = duplicateBot(id, {
      ...templateDeps,
      getSpace: (x) => db.getSpace(x),
      getPrompt: (x) => spaces.getPrompt(x),
      routines: (x) => scheduler.list().filter((t) => t.spaceId === x),
      updateSpace: (x, patch) => { db.updateSpace(x, patch) }
    })
    openThread(made.threadId)
    return made
  })

  // ---------------------------------------------------------------- morning check-in and usage
  handle('checkin:get', () => getCheckin(db, scheduler))
  handle('checkin:set', (c: CheckinSettings) => setCheckin(db, scheduler, c))
  // Stock watchlist (renderer-owned list; values cached from stock cards or a refresh).
  handle('watchlist:get', () => getWatchlist(db))
  handle('watchlist:set', (items: unknown) => setWatchlist(db, items))
  // Market data for the watchlist and stock cards (cached daily data; no model calls).
  handle('markets:quotes', (symbols: unknown) => markets.quotes(Array.isArray(symbols) ? symbols.filter((x): x is string => typeof x === 'string') : []))
  handle('markets:card', (symbol: string, o?: { forecast?: boolean; horizonDays?: number }) => markets.card(String(symbol), { forecast: !!o?.forecast, horizonDays: o?.horizonDays }))
  handle('markets:search', (q: string) => markets.data.search(String(q ?? '')))
  registry.register(overviewTool({
    db,
    pending: () => Object.keys(chat.allPending()).flatMap((tid) => chat.pending(tid)),
    routines: () => scheduler.list()
  }))

  // ---------------------------------------------------------------- long-running goals (goals/)
  // A bot pursues a goal over hours or days: one-time wake-ups (fired by the scheduler's tick, never while
  // routines are paused) run unattended in the goal's chat, inside its spend cap, daily run cap and end date.
  let goalsTimer: ReturnType<typeof setTimeout> | null = null
  const goals = new GoalManager({
    db,
    run: async ({ threadId, text, note, goalId, unattended, untrusted }) => {
      // Wake-ups end with the goal's own lines and notifications, not the generic "done" one.
      if (unattended) scheduledRuns.add(threadId)
      try {
        // goalUntrusted: journal lines and the wake note written after reading outside content (loop.ts seeds them as untrusted).
        const { done } = await chat.send({ threadId, text, note, meta: { goalRun: goalId, ...(unattended ? { scheduled: `goal:${goalId}` } : {}), ...(untrusted?.length ? { goalUntrusted: untrusted } : {}) } }, { unattended })
        return await done
      } finally { if (unattended) scheduledRuns.delete(threadId) }
    },
    isRunning: (threadId) => chat.isRunning(threadId),
    posted: (threadId, message) => emit({ threadId, type: 'message', message }),
    notify: (g, headline, body, ask) => {
      const space = db.getSpace(g.botId)
      if (!space || space.notify === false || QUIET || !Notification.isSupported()) return
      const threadId = g.threadId ?? db.listThreads(g.botId)[0]?.id ?? ''
      if (mainFocused() && viewingThread === threadId) return
      // A queued approval's line is built like any "needs you" notification (safe for the lock screen).
      const text = ask ? needsYouText({ id: ask.id, threadId, kind: 'approval', tool: ask.tool, label: ask.label, summary: ask.summary }) : body
      showNote(new Notification({ title: `${botName(g.botId)}: ${headline}`, body: text.replace(/\s+/g, ' ').slice(0, 160) }), threadId)
    },
    changed: () => {
      if (goalsTimer) return
      goalsTimer = setTimeout(() => { goalsTimer = null; toWin('goals:changed') }, 250)
    },
    paused: () => !!settings.get().routinesPaused
  })
  goalHooks.ask = (threadId, info) => goals.onUnattendedAsk(threadId, info)
  // goal and follow_up are found with find_tools("goal"); wake-ups load them into their chat.
  registry.register(goalTool(db, goals), followUpTool(db, goals))
  // The morning check-in's bots_overview also lists goals.
  const overviewDef = registry.get('bots_overview')
  if (overviewDef) registry.register(withGoalsOverview(overviewDef, goals, (id) => botName(id)))
  // Goal spend: a wake-up stops before a request that could pass its goal's cap; every paid request
  // made while a chat works on a goal counts toward it.
  const spendBeforeGoals = spendHooks.before
  spendHooks.before = (req, est, maxOutput, pricedAs) => {
    spendBeforeGoals?.(req, est, maxOutput, pricedAs)
    const t = usageScope.getStore()?.threadId
    if (t) goals.checkSpend(t, pricedAs, est, maxOutput)
  }
  const spendAfterGoals = spendHooks.after
  spendHooks.after = (req, input, output, served) => {
    spendAfterGoals?.(req, input, output, served)
    const t = usageScope.getStore()?.threadId
    if (t) { try { goals.addSpend(t, served, input, output) } catch { /* never fails the request */ } }
  }
  listeners.add((e) => { if (e.type === 'run' && e.status !== 'started') goals.runEnded(e.threadId) })
  scheduler.wakeups = () => goals.tick()
  handle('goals:list', () => goals.list())
  handle('goals:update', (id: string, patch: GoalPatch) => goals.patch(String(id), patch && typeof patch === 'object' ? patch : {}))
  handle('goals:runNow', (id: string) => goals.runNow(String(id)))

  // ---------------------------------------------------------------- always-on bots: Needs you, autonomy levels, digest
  // Bots' own chats still at the old default (Auto) move to Autonomous once; levels the user picked stay.
  try { migrateBotAutonomy(db, settings.get()) } catch (e) { console.error('[autonomy]', (e as Error).message) }
  /** Cards open in running chats right now, as inbox items (answered through chat:respond). */
  const liveNeedsYou = (): NeedsYouItem[] => {
    const out: NeedsYouItem[] = []
    for (const [threadId, ids] of Object.entries(chat.allPending())) {
      const t = db.getThread(threadId)
      if (!t || quickRuns.has(threadId)) continue
      for (const r of chat.pending(threadId)) {
        if (!ids.includes(r.id)) continue
        const base = { id: `live:${threadId}:${r.id}`, source: 'live' as const, botId: t.spaceId, botName: botName(t.spaceId), threadId, status: 'open' as const, createdAt: t.updatedAt ?? Date.now() }
        if (r.kind === 'approval' && !r.spend) out.push({ ...base, kind: 'approval', approval: { tool: r.tool ?? '', label: r.label ?? r.tool ?? 'Action', ...(r.summary ? { summary: needsYouText(r) } : {}), ...(r.reason ? { reason: r.reason } : {}) } })
        else if (r.kind === 'question') out.push({ ...base, kind: 'question', questions: [{ question: r.question ?? '', ...(r.options?.length ? { options: r.options } : {}) }] })
        else if (r.kind === 'questions') out.push({ ...base, kind: 'question', questions: (r.questions ?? []).map((q) => ({ question: q.question, ...(q.options?.length ? { options: q.options } : {}) })) })
        else out.push({ ...base, kind: 'other', approval: { tool: r.tool ?? r.kind, label: r.label ?? (r.kind === 'plan' ? 'Plan' : r.kind === 'connect' ? 'Connect an app' : 'Waiting for you'), summary: needsYouText(r) } })
      }
    }
    return out
  }
  handle('needsYou:list', () => [...liveNeedsYou(), ...questions.inbox()])
  handle('needsYou:answer', async (id: string, answer: string[] | 'approve' | 'deny') => {
    const ref = String(id ?? '')
    if (ref.startsWith('live:')) {
      const [, threadId, reqId] = ref.split(':')
      const r = chat.pending(threadId).find((x) => x.id === reqId)
      if (!r) return null
      const list = Array.isArray(answer) ? answer.map((a) => String(a ?? '')) : []
      if (r.kind === 'approval' && !r.spend) chat.respond(threadId, reqId, answer === 'approve' ? 'once' : 'deny')
      else if (r.kind === 'question') chat.respond(threadId, reqId, list[0] ?? (answer === 'approve' ? 'Yes' : 'No'))
      else if (r.kind === 'questions') chat.respond(threadId, reqId, JSON.stringify(list))
      else throw new Error('Open the chat to answer this one.')
      return null
    }
    const item = await questions.answer(ref, Array.isArray(answer) ? answer.map((a) => String(a ?? '')) : answer === 'approve' ? 'approve' : 'deny')
    return item ? toNeedsYou(item, botName(item.botId)) : null
  })
  handle('needsYou:reviewed', (id: string) => questions.reviewed(String(id)))
  // Bot details → Autonomy: saved for the bot's new chats, and applied to its own conversations now.
  handle('botAutonomy:setLevel', (spaceId: string, level: PermissionMode) => {
    if (level !== 'ask' && level !== 'auto' && level !== 'autonomous') throw new Error(`Unknown autonomy level "${String(level)}".`)
    const space = db.getSpace(spaceId)
    if (!space) throw new Error('That bot no longer exists.')
    settings.set({ botModes: { ...(settings.get().botModes ?? {}), [spaceId]: level } })
    for (const t of db.listThreads(spaceId)) {
      if (t.parentId || t.permissionMode === 'bypass' || t.permissionMode === level) continue
      emit({ threadId: t.id, type: 'thread', thread: db.updateThread(t.id, { permissionMode: level }) })
    }
  })
  const digests = new DigestRunner({
    db,
    bots: () => db.listSpaces().filter((x) => isAlwaysOnBot(x)),
    config: (id) => botAutonomyConfig(settings.get(), id).digest,
    goals: (id) => goals.list().filter((g) => g.botId === id),
    routines: (id) => scheduler.list().filter((t) => t.spaceId === id),
    runs: (taskId) => scheduler.runs(taskId),
    pending: (id) => [...liveNeedsYou(), ...questions.inbox()].filter((x) => x.botId === id && x.status === 'open'),
    review: (id) => questions.inbox().filter((x) => x.botId === id && x.review),
    budget: () => { const b = budget.summary(); return { monthUsd: b.spent, capUsd: b.mode === 'amount' ? b.cap : null, over: b.mode === 'amount' && b.spent >= b.cap } },
    busy: (id) => db.listThreads(id).some((t) => chat.isRunning(t.id)),
    deliver: (bot, d) => {
      const threadId = db.listThreads(bot.id).find((t) => !t.parentId)?.id
      if (threadId) {
        const m = db.insertMessage({ threadId, role: 'assistant', content: d.text, kind: 'normal', status: 'done', meta: { digest: true } })
        emit({ threadId, type: 'message', message: m })
        emit({ threadId, type: 'thread', thread: db.updateThread(threadId, { unread: true }) })
      }
      notifyQuestionDevices({ kind: 'digest', title: d.title, body: d.body, botId: bot.id, threadId })
      if (threadId && bot.notify !== false && !QUIET && Notification.isSupported()) showNote(new Notification({ title: d.title, body: d.body }), threadId)
    }
  })
  // Every scheduler check: goal wake-ups, question deadlines (and answers held back by the budget), digests.
  const goalWakeups = scheduler.wakeups
  scheduler.wakeups = async () => {
    await Promise.all([
      goalWakeups?.().catch(() => undefined),
      questions.tick().catch((e) => console.error('[questions]', (e as Error).message)),
      Promise.resolve().then(() => digests.tick()).catch((e) => console.error('[digest]', (e as Error).message))
    ])
  }
  // Answers that arrived while SahilBot was closed (or couldn't be handed over) are picked up after launch.
  setTimeout(() => void questions.resumeWaiting().catch(() => undefined), 3000)
  /** A model is cloud when the endpoint that serves it isn't on this Mac (Claude and GPT always are). */
  const isCloudModel = (model: string): boolean => {
    if (/^(claude-|gpt-|chatgpt-|grok-)/i.test(model)) return true
    try { return !isLocal(endpoints.for(model).baseUrl) } catch { return /^o\d|\//i.test(model) }
  }
  const usageWindow = (): UsageRow[] => usageRows(db, windowStart(Date.now(), 30), isCloudModel)
  handle('usage:report', () => {
    const b = budget.summary()
    return aggregateUsage(usageWindow(), db.listSpaces(), { now: Date.now(), days: 30, month: b.month, spent: b.spent, cap: b.cap, monthRequests: b.requests })
  })
  // The usage dashboard (Settings → Usage) and its compact card (profile menu, ⌘K "Usage").
  const dashboard = () => {
    const b = budget.summary()
    return usageDashboard(db, { now: Date.now(), month: b.month, spent: b.spent, monthRequests: b.requests, cap: b.cap, mode: b.mode, spaces: db.listSpaces(), isCloud: isCloudModel })
  }
  handle('usage:dashboard', () => dashboard())
  // Settings → Models → Fast mode: every supported model the user has (on or off), with its trade-off.
  handle('fast:catalog', () => (endpoints.last?.models ?? []).filter((m) => m.installed && m.note === 'remote').flatMap((m) => {
    const sup = fastSupport(m.id)
    if (!sup || sup.id !== m.id.toLowerCase()) return []
    return [{ id: m.id, label: m.label || m.id, provider: sup.provider, factor: sup.factor, ...(sup.ultrafast ? { ultrafast: sup.ultrafast } : {}), tradeoff: fastTradeoff(m.id) ?? '', ...(sup.note ? { note: sup.note } : {}) }]
  }))
  handle('usage:glance', () => usageGlance(dashboard()))
  // The end-of-run line under the last reply: tokens (and cloud cost) of one run, helpers included.
  handle('usage:forRun', (threadId: string, since: number, until?: number) => runUsage(db, String(threadId), Number(since) || 0, typeof until === 'number' ? until : undefined, isCloudModel))
  handle('usage:exportCsv', async () => {
    const names = new Map(db.listSpaces().map((sp) => [sp.id, sp.name]))
    // Every cloud request ever recorded, with cached / cache-write / reasoning tokens and the tier.
    const csv = usageDetailCsv(db, (id) => (id ? names.get(id) ?? 'Deleted bot' : ''))
    const r = win ? await dialog.showSaveDialog(win, { defaultPath: `SahilBot usage ${new Date().toISOString().slice(0, 10)}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] }) : { canceled: true }
    if (r.canceled || !('filePath' in r) || !r.filePath) return null
    writeFileSync(r.filePath, csv)
    return r.filePath
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

  // ---------------------------------------------------------------- knowledge base (search over the user's own files)
  // Sources: the workspace, every project's folder, folders added in Settings → Knowledge, and attached
  // folders the user opts in. Indexing starts a few seconds after launch (not in hidden test runs unless
  // SAHILBOT_KNOWLEDGE=1); embeddings run only while no chat is running.
  let knowledgeNotify: ReturnType<typeof setTimeout> | null = null
  const knowledge = new KnowledgeService({
    sql: db.sql,
    workspace: () => settings.get().workspaceDir,
    // Projects and bots with a working folder ("Works in folder"): their folders are searchable.
    projects: () => db.listSpaces().filter((x) => x.kind === 'project' || (x.kind === 'bot' && !!x.folder)).map((x) => ({ id: x.id, name: x.name, folder: x.folder })),
    // Local models off: no Ollama embeddings (OpenAI's only when the user turned that on), else keyword search.
    ollamaUrl: () => (localOn(settings.get()) && settings.providers().ollama.enabled ? settings.providers().ollama.baseUrl : settings.get().openaiEmbeddings && apiAccess(settings).openai() ? OPENAI_URL : null),
    localOff: () => localOff(settings.get()),
    busy: () => chat.busy(),
    onChange: () => { if (!knowledgeNotify) knowledgeNotify = setTimeout(() => { knowledgeNotify = null; toWin('knowledge:changed') }, 1000) }
  })
  registry.register(...knowledgeTools({
    kb: knowledge,
    spaceOf: (threadId) => db.getThread(threadId)?.spaceId,
    // Scope "chat": folders attached to the chat, its working folder, and its bot's or project's folder.
    foldersOf: (threadId) => {
      const st = db.getState(threadId)
      const sp = db.getSpace(db.getThread(threadId)?.spaceId ?? '')
      return [...new Set([...(st.roots ?? []), ...(st.folder ? [st.folder] : []), ...(sp?.folder ? [sp.folder] : [])])].filter((p) => { try { return statSync(p).isDirectory() } catch { return false } })
    }
  }))
  if (process.env.SAHILBOT_KNOWLEDGE !== '0' && (!HIDDEN || process.env.SAHILBOT_KNOWLEDGE === '1')) knowledge.start(HIDDEN ? 500 : 8000)
  app.on('before-quit', () => knowledge.dispose())

  // ---------------------------------------------------------------- learning while the app is open and idle
  // Runs only while SahilBot is running and idle (no chat for 2 minutes, nobody using the window); it stops
  // the moment a run starts or the user does something, and never after quit. Not in hidden test runs
  // unless SAHILBOT_LEARNING=1. Everything it learns is in Settings → Memory → What I learned, with Undo.
  const appThreadRef: { current?: (id: string) => boolean } = {}

  // ---------------------------------------------------------------- the knowledge vault (src/main/vault, docs/vault.md)
  // Obsidian-compatible notes in "<workspace>/SahilBot Vault" (configurable). Compiled by the learning pass
  // below (same idle rules and model budget), searched through the knowledge index plus its own ranking.
  let vaultNotify: ReturnType<typeof setTimeout> | null = null
  const notesVault = new VaultService({
    db,
    workspace: () => settings.get().workspaceDir,
    keyword: (q, root, limit) => {
      const ids = knowledge.store.keyword(q, [root], limit).map((x) => x.id)
      return [...new Set(knowledge.store.hits(ids).map((h) => h.path))]
    },
    docs: { enabled: () => true, recent: (o) => knowledge.store.recentDocs(o), text: (p, n) => knowledge.store.docText(p, n) },
    activity: { enabled: () => activityLearningAllowed(), timeline: () => activityTimelineForLearning() },
    isRunning: (id) => chat.isRunning(id),
    isAppThread: (id) => appThreadRef.current?.(id) ?? false,
    secretValues: () => [...vault.secretValues(), ...browser.hiddenValues()],
    // A vault outside every knowledge folder gets indexed too.
    onRootChange: (root) => {
      const covered = knowledge.sources().some((x) => !x.problem && (root === x.path || root.startsWith(`${x.path}/`)))
      if (!covered) { try { knowledge.addFolder(root, 'folder') } catch { /* refused (e.g. inside ~/Library): own ranking only */ } }
    },
    onChange: () => { if (!vaultNotify) vaultNotify = setTimeout(() => { vaultNotify = null; toWin('notesVault:changed') }, 400) }
  })
  notesVaultRef.current = notesVault
  registry.register(vaultTool({ vault: notesVault, db, secretValues: () => [...vault.secretValues(), ...browser.hiddenValues()] }))

  // ---------------------------------------------------------------- the context engine (src/main/context-engine, docs/context.md)
  // An entity graph of the user's world (people, places, organizations, events, dates, things…) built by
  // the idle learning pass from chats, files, connector results and (opt-in) connector metadata and
  // activity; each run gets the cards its request is about, merged with memories and vault notes.
  let worldNotify: ReturnType<typeof setTimeout> | null = null
  const world = new ContextEngine({
    db, memory, vault: () => notesVault,
    userName: () => settings.get().userName,
    workspace: () => settings.get().workspaceDir,
    docs: { recent: (o) => knowledge.store.recentDocs(o), text: (p, n) => knowledge.store.docText(p, n) },
    activity: { allowed: () => activityLearningAllowed(), timeline: () => activityTimelineForLearning() },
    connectors: { connected: (id) => connectors.presetConnected(id), call: (id, tool, args, signal) => connectors.callPresetTool(id, tool, args, signal) },
    isRunning: (id) => chat.isRunning(id),
    isAppThread: (id) => appThreadRef.current?.(id) ?? false,
    secretValues: () => [...vault.secretValues(), ...browser.hiddenValues()],
    onChange: () => { if (!worldNotify) worldNotify = setTimeout(() => { worldNotify = null; toWin('people:changed') }, 400) }
  })
  worldRef.current = world
  registry.register(aboutTool({ engine: world, db }))
  handle('people:status', () => world.status())
  handle('people:setSettings', (patch: Record<string, unknown>) => { world.setSettings((patch ?? {}) as never); return world.status() })
  handle('people:list', (o?: { query?: string; type?: string }) => world.list({ query: typeof o?.query === 'string' ? o.query.slice(0, 200) : undefined, type: typeof o?.type === 'string' ? o.type as never : undefined }))
  handle('people:card', (id: string) => world.card(String(id ?? '')))
  handle('people:update', (id: string, patch: Record<string, unknown>) => world.update(String(id ?? ''), (patch ?? {}) as never))
  handle('people:merge', (into: string, from: string) => world.merge(String(into ?? ''), String(from ?? '')))
  handle('people:forget', (id: string) => world.forget(String(id ?? '')))
  handle('people:undo', (trashId: string) => world.undo(String(trashId ?? '')))
  handle('people:exportData', () => {
    const out = world.exportData(join(settings.get().workspaceDir, 'exports'))
    if (!HIDDEN) shell.showItemInFolder(out)
    return out
  })
  handle('notesVault:status', () => notesVault.status())
  handle('notesVault:setSettings', (patch: Record<string, unknown>) => { notesVault.setSettings((patch ?? {}) as never); return notesVault.status() })
  handle('notesVault:setBot', (spaceId: string, patch: { enabled?: boolean | null; level?: 'normal' | 'aggressive' | null }) => {
    if (!db.getSpace(String(spaceId ?? ''))) throw new Error('That bot is gone.')
    notesVault.setBot(String(spaceId), patch ?? {})
    return notesVault.status()
  })
  handle('notesVault:list', () => notesVault.list())
  handle('notesVault:read', (path: string) => notesVault.read(String(path ?? '')))
  handle('notesVault:resolve', (ref: string, from?: string) => notesVault.resolve(String(ref ?? ''), typeof from === 'string' ? from : undefined))
  handle('notesVault:search', (q: string) => notesVault.search(String(q ?? '').slice(0, 500)))
  handle('notesVault:save', (path: string, text: string) => notesVault.save(String(path ?? ''), String(text ?? '')))
  handle('notesVault:create', (o: { title: string; type?: string; section?: string }) => notesVault.create({ title: String(o?.title ?? '').slice(0, 120), type: o?.type, section: o?.section }))
  handle('notesVault:trash', (path: string) => notesVault.trash(String(path ?? '')))
  handle('notesVault:graph', () => notesVault.store.graph())
  handle('notesVault:changes', (limit?: number) => notesVault.changes(Math.min(1000, Number(limit) || 200)))
  handle('notesVault:undo', (id: string) => notesVault.undo(String(id ?? '')))
  handle('notesVault:openInObsidian', async (path?: string) => {
    notesVault.store.ensure()
    const rel = typeof path === 'string' && path ? path : undefined
    if (notesVault.obsidianInstalled()) {
      if (!HIDDEN) await shell.openExternal(notesVault.obsidianUrl(rel))
      return 'obsidian'
    }
    if (!HIDDEN) shell.showItemInFolder(rel ? notesVault.store.abs(rel) : notesVault.store.root)
    return 'finder'
  })
  handle('notesVault:reveal', (path?: string) => {
    notesVault.store.ensure()
    if (!HIDDEN) shell.showItemInFolder(typeof path === 'string' && path ? notesVault.store.abs(path) : notesVault.store.root)
  })
  handle('notesVault:exportZip', () => {
    const out = notesVault.exportZip(join(settings.get().workspaceDir, 'exports'))
    if (!HIDDEN) shell.showItemInFolder(out)
    return out
  })

  let learningNotify: ReturnType<typeof setTimeout> | null = null
  const learning = new LearningService({
    db, memory, skills, settings, endpoints, fitWindow,
    vault: {
      wants: (now) => notesVault.compiler.wants(now) || world.wants(now),
      // The vault's compile, then People & Places (the context engine) in the same pass, model and budget.
      run: async (h) => {
        let n = 0
        try { n = await notesVault.compiler.run(h) } finally { notesVault.changed() }
        const c = learning.choose()
        return n + await world.learn({ ...h, cloud: 'cloud' in c && c.cloud })
      },
      passEvery: () => notesVault.passEvery()
    },
    busy: () => chat.busy(),
    isRunning: (id) => chat.isRunning(id),
    secretValues: () => [...vault.secretValues(), ...browser.hiddenValues()],
    isAppThread: (id) => appThreadRef.current?.(id) ?? false,
    onBattery: () => { try { return powerMonitor.isOnBatteryPower() } catch { return false } },
    onChange: () => { if (!learningNotify) learningNotify = setTimeout(() => { learningNotify = null; toWin('learning:changed') }, 300) }
  })
  if (process.env.SAHILBOT_LEARNING !== '0' && (!HIDDEN || process.env.SAHILBOT_LEARNING === '1')) learning.start()
  // A run starting (any chat, routine or helper) stops a pass at once; so does the user typing or clicking.
  listeners.add((e) => { if (e.type === 'run' && e.status === 'started') learning.activity('run') })
  const watchInput = (w: BrowserWindow): void => {
    w.webContents.on('before-input-event', () => learning.activity('input'))
    w.on('focus', () => learning.activity('input'))
  }
  for (const w of BrowserWindow.getAllWindows()) watchInput(w)
  app.on('browser-window-created', (_e, w) => watchInput(w))
  powerMonitor.on('suspend', () => learning.activity('run'))
  app.on('before-quit', () => learning.dispose())
  handle('learning:status', () => learning.status())
  handle('learning:list', (limit?: number) => learning.list(typeof limit === 'number' ? limit : 200))
  handle('learning:undo', (id: string) => learning.undo(String(id ?? '')))
  handle('learning:approve', (id: string) => learning.approve(String(id ?? '')))
  handle('learning:dismiss', (id: string) => learning.dismiss(String(id ?? '')))
  handle('learning:runNow', () => learning.runNow())
  handle('notesVault:compileNow', async () => { await learning.runNow({ vaultOnly: true }); return notesVault.status() })
  // People & Places → "Learn now": the same pass (its vault job runs the context engine too).
  handle('people:learnNow', async () => { await learning.runNow({ vaultOnly: true }); return world.status() })
  handle('learning:openChat', (threadId: string) => { if (db.getThread(String(threadId ?? ''))) openThread(String(threadId)) })
  handle('knowledge:status', () => knowledge.status())
  // Folders are added only through the picker here, or from folders already attached to a chat.
  handle('knowledge:addFolder', async () => {
    const r = win ? await dialog.showOpenDialog(win, { title: 'Add a folder to your knowledge base', properties: ['openDirectory'] }) : { canceled: true, filePaths: [] }
    if (r.canceled || !r.filePaths[0]) return null
    knowledge.addFolder(r.filePaths[0], 'folder')
    return knowledge.status()
  })
  handle('knowledge:addAttached', (path: string) => {
    const p = String(path ?? '')
    if (!knowledge.attachedCandidates().includes(p) && !attachments.accept([p]).length) throw new Error('Attach that folder to a chat first.')
    knowledge.addFolder(p, 'attached')
    return knowledge.status()
  })
  handle('knowledge:removeFolder', (path: string) => {
    if (!knowledge.store.userSources().some((x) => x.path === path)) throw new Error('The workspace and project folders are always in the knowledge base.')
    knowledge.removeFolder(path)
    return knowledge.status()
  })
  handle('knowledge:setPaused', (on: boolean) => { knowledge.setPaused(!!on); return knowledge.status() })
  handle('knowledge:rebuild', () => { void knowledge.rebuild(); return knowledge.status() })
  handle('knowledge:search', (query: string, opts?: { folder?: string; k?: number }) => {
    const sc = resolveScope(knowledge, opts?.folder ? String(opts.folder) : 'all', undefined)
    if ('error' in sc) throw new Error(sc.error)
    return knowledge.search(String(query ?? '').slice(0, 500), { scope: sc.folders, k: Math.min(20, Number(opts?.k) || 8) })
  })
  // Only files in the index can be opened or revealed from search results.
  handle('knowledge:reveal', (path: string) => { if (knowledge.isIndexed(String(path))) shell.showItemInFolder(String(path)) })
  handle('knowledge:open', async (path: string) => {
    const p = String(path)
    if (!knowledge.isIndexed(p)) return
    // Only documents open in their app; code, scripts, web pages and anything else are shown in Finder
    // (a .py, .js, .html or .command file's default app could run it).
    if (opensDirectly(p)) await shell.openPath(p)
    else shell.showItemInFolder(p)
  })

  // ---------------------------------------------------------------- voice
  let voiceThread: string | null = null
  // Spoken replies: Kokoro only with local models on; OpenAI's voice when allowed (Settings → Voice) with a key; else the Mac's voice.
  const openaiVoice = new OpenAITtsEngine({
    baseUrl: OPENAI_URL,
    apiKey: () => apiAccess(settings).openai()?.apiKey,
    guard: (chars) => hookSpend.beforeUsd(OPENAI_URL, 'gpt-4o-mini-tts', speechUsd('gpt-4o-mini-tts', chars)),
    charged: (chars) => hookSpend.afterUsd(OPENAI_URL, 'gpt-4o-mini-tts', speechUsd('gpt-4o-mini-tts', chars))
  })
  // Voice input with local models off: OpenAI transcription (same switch, same monthly limit); never a Whisper download.
  const openaiEars = new OpenAISttEngine({
    transcribe: (file, prompt, signal) => {
      const c = apiAccess(settings).openai()
      if (!c) throw new Error('No OpenAI key is saved for voice input.')
      return openaiTranscribe(c, { model: DEFAULT_TRANSCRIBE_MODEL, file, prompt }, signal)
    },
    guard: (seconds) => hookSpend.beforeUsd(OPENAI_URL, DEFAULT_TRANSCRIBE_MODEL, transcribeUsd(DEFAULT_TRANSCRIBE_MODEL, undefined, seconds) * 1.5),
    charged: (seconds, t) => hookSpend.afterUsd(OPENAI_URL, DEFAULT_TRANSCRIBE_MODEL, transcribeUsd(DEFAULT_TRANSCRIBE_MODEL, t as never, seconds))
  })
  const voice = new VoiceService({
    output: () => {
      const s = settings.get()
      const openaiOk = !!s.voiceOutput?.openai && !!apiAccess(settings).openai()
      return { localOn: localOn(s), openai: openaiOk ? openaiVoice : null, openaiStt: openaiOk ? openaiEars : null, spendingNone: spendingMode(s) === 'none' }
    },
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

  // ---------------------------------------------------------------- media, vision and batch tools (the user's OpenAI / Anthropic keys)
  // Found with find_tools ("image", "speech", "transcribe", "ocr", "batch"); listed only while cloud models are
  // on and the needed key is saved. Every call is priced first and recorded through spendHooks (cap + Usage).
  const apiKeys = apiAccess(settings)
  registry.register(
    ...mediaTools({
      access: apiKeys,
      workspace: () => settings.get().workspaceDir,
      vision: (model) => !!model && (/^claude-/i.test(model) || !!endpoints.last?.models.find((m) => m.id === model)?.vision),
      // WAV plays through the app's own audio output (like spoken replies); other formats with afplay.
      play: (file, format) => {
        if (format === 'wav' && win && !win.isDestroyed()) {
          const { samples, rate } = fromWav(readFileSync(file))
          toWin('voice:event', { type: 'stop-audio' })
          toWin('voice:event', { type: 'audio', audio: samples, rate })
          return
        }
        execFile('afplay', [file], { timeout: 60 * 60_000 }, () => undefined)
      }
    }),
    readDocumentImageTool({ access: apiKeys, workspace: () => settings.get().workspaceDir })
  )
  const batches = new BatchManager({
    access: apiKeys,
    workspace: () => settings.get().workspaceDir,
    stateFile: join(sub('batches'), 'batches.json'),
    spaceOf: (threadId) => db.getThread(threadId)?.spaceId ?? null,
    notify: (threadId, text) => {
      if (!db.getThread(threadId)) return
      const m = db.insertMessage({ threadId, role: 'assistant', content: text, kind: 'notice', status: 'done' })
      emit({ threadId, type: 'message', message: m })
    }
  })
  registry.register(batchTool(batches, { access: apiKeys, workspace: () => settings.get().workspaceDir }))
  if (!HIDDEN || process.env.SAHILBOT_BATCHES === '1') batches.resume()
  app.on('before-quit', () => batches.dispose())
  // Knowledge search embeddings through OpenAI, only when the user turned it on (sends document text to OpenAI).
  embeddingProvider.openai = { creds: () => (settings.get().openaiEmbeddings ? apiKeys.openai() ?? null : null) }
  const setSettings = settings.set.bind(settings)
  settings.set = (patch) => {
    const s = setSettings(patch)
    // Switching the option (or cloud / keys) takes effect now, not at the next periodic re-check.
    if (patch.openaiEmbeddings !== undefined || patch.cloud !== undefined || patch.setKeys !== undefined) void knowledge.embedModel(true).catch(() => undefined)
    // Open windows pick up the change wherever it came from (a bot, the menu bar, another window).
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('settings:changed')
    return s
  }
  // Runs still going at quit were cut off: their rows stay so the next launch offers Continue.
  app.on('before-quit', () => { work.quitting(); menuBar?.dispose(); voice.dispose(); scheduler.stop(); browser.dispose(); stopOllama() })
  // Local models just work after a restart: start Ollama in the background if it's installed and not running.
  // (Only when local models are on: a cloud-only setup never starts or installs anything local.)
  if (!process.env.FOREMAN_BASE_URL && localOn(settings.get())) void startOllama(settings.providers().ollama.baseUrl).catch(() => undefined)

  // The app's own window may use the microphone (voice); websites in the browser panel may not.
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'media' && wc === win?.webContents))
  session.defaultSession.setPermissionCheckHandler((wc, perm) => perm === 'media' && wc === win?.webContents)
  handle('chat:stop', (threadId: string) => chat.stop(threadId))
  handle('chat:steer', (threadId: string, text: string) => chat.steer(threadId, String(text).slice(0, 20_000)))
  handle('chat:respond', (threadId: string, id: string, answer: string) => chat.respond(threadId, id, answer))
  // The main window asks for a chat's open requests whenever it opens that chat: that's how main knows what you're reading.
  handle('chat:allPending', () => {
    const all = chat.allPending()
    for (const t of purchases.threads()) all[t] = [...(all[t] ?? []), ...purchases.pending(t).map((r) => r.id)]
    return all
  })
  ipcMain.handle('chat:pending', (ev, threadId: string) => {
    if (win && !win.isDestroyed() && ev.sender === win.webContents) { viewingThread = threadId; refreshBadge() }
    return [...chat.pending(threadId), ...purchases.pending(threadId)]
  })
  handle('chat:retry', (threadId: string) => chat.retry(threadId))
  // Continue a chat cut off by SahilBot closing: a hidden note, then a normal run from the current history.
  handle('chat:resume', (threadId: string) => {
    if (!db.getThread(threadId)) throw new Error('That chat no longer exists.')
    if (chat.isRunning(threadId)) throw new Error('SahilBot is already working in this chat.')
    const m = work.clearNotice(threadId)
    if (m) emit({ threadId, type: 'message', message: m })
    chat.intro(threadId, RESUME_NOTE)
  })
  handle('chat:interrupted', () => work.interrupted())
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

  // Settings → Vault: metadata-only replies (src/main/secure/ipc.ts), from the main window only.
  registerVaultIpc(vaultHandlers({
    vault, auth: vault.auth!, purchases,
    touchIdAvailable: () => electronTouchId(HIDDEN).available(),
    keychainAvailable: () => secrets.available(),
    files: electronVaultFiles(() => win),
    protect: protectSender
  }), (wc) => !!win && !win.isDestroyed() && wc.id === win.webContents.id)
  // Only a click in the main window's own page approves a purchase or a one-time code (not the Quick
  // bar, not a Page, not a bot or a message relayed from anywhere else).
  ipcMain.handle('purchase:respond', (ev, threadId: string, id: string, nonce: string, answer: string) => {
    if (!win || win.isDestroyed() || ev.sender !== win.webContents || (ev.senderFrame && ev.senderFrame !== win.webContents.mainFrame)) {
      return { ok: false, error: 'This can only be approved in the main SahilBot window.' }
    }
    return purchases.respond(String(threadId), String(id), String(nonce), String(answer))
  })

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
  handle('sites:list', () => sites.list())
  handle('sites:get', (domain: string) => sites.get(String(domain ?? '')) ?? null)
  handle('sites:forget', (domain: string) => sites.forget(String(domain ?? '')))

  handle('memory:list', () => memory.list())
  handle('memory:remove', (id: string) => void memory.remove(id))
  handle('memory:add', (content: string, spaceId: string | null, category?: string) => memory.add(content, spaceId ?? null, category))
  handle('memory:update', (id: string, content: string, patch?: { category?: string; spaceId?: string | null }) => void memory.update(id, content, patch ?? {}))
  // Import memory to SahilBot (src/main/memory-import.ts): Instructions become rules (Settings → Rules).
  const importRule = (text: string): boolean => {
    const all = rules.list()
    if (all.some((r) => similar(r.text, text))) return false
    rules.save({ name: ruleName(text, (n) => all.some((r) => r.name === n)), text, scope: 'everywhere', category: 'Imported' })
    return true
  }
  const importItems = (items: unknown): ImportItemIn[] => (Array.isArray(items) ? items : []).filter((x): x is ImportItemIn => !!x && typeof x === 'object' && typeof (x as ImportItemIn).content === 'string').map((x) => ({
    content: String(x.content).slice(0, 1000), category: typeof x.category === 'string' ? x.category : undefined,
    date: typeof x.date === 'string' ? x.date.slice(0, 10) : null, asRule: x.asRule === true
  }))
  handle('memory:importPreview', (text: string) => memory.importPreview(String(text ?? '').slice(0, IMPORT_MAX_CHARS + 1), rules.list().map((r) => r.text)))
  handle('memory:importCommit', (items: unknown) => memory.importCommit(importItems(items), importRule))
  handle('memory:importSave', (items: unknown) => memory.importSave(importItems(items), importRule))
  handle('memory:copyImportPrompt', () => { clipboard.writeText(MEMORY_IMPORT_PROMPT); return true })
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

  mark('services, tools and handlers set up')
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
  // Opened by logging in (Settings → General → Open at login): stay in the menu bar and Dock, window hidden.
  const openedAtLogin = !HIDDEN && process.platform === 'darwin' && (() => { try { return app.getLoginItemSettings().wasOpenedAtLogin } catch { return false } })()
  if (!openedAtLogin) win = open()
  buildMenu((action) => toWin('menu', action))

  // ---------------------------------------------------------------- always on: menu bar icon, login, keep awake
  /** A menu command for the main window, reopening it first if it was closed. */
  const sendMenu = (action: MenuAction): void => {
    const w = showMain()
    if (w?.webContents.isLoading()) w.webContents.once('did-finish-load', () => toWin('menu', action))
    else toWin('menu', action)
  }
  const chatLabel = (threadId: string): string => {
    const t = db.getThread(threadId)
    const sp = t ? db.getSpace(t.spaceId) : undefined
    if (!t || !sp) return 'SahilBot'
    // Bots have one conversation named after them; SahilBot and projects keep a chat per task.
    return sp.kind === 'bot' && !sp.isMain ? sp.name : `${botName(sp.id)} — ${t.title}`
  }
  const setRoutinesPaused = (paused: boolean): void => {
    settings.set({ routinesPaused: paused })
    alwaysOnChanged.current({ routinesPaused: paused })
  }
  const awake = new KeepAwake(powerSaveBlocker)
  const refreshAwake = (): void => { awake.set(!HIDDEN && wantAwake(settings.get().keepAwakeWhileWorking, work.working().length)) }
  work.onChange = () => { refreshAwake(); menuBar?.refresh() }
  menuBar = new MenuBarIcon(() => ({
    working: work.working().filter((id) => db.getThread(id)).map((id): TrayItem => ({ threadId: id, label: chatLabel(id) })),
    needsYou: [...waiting].filter(([id, ids]) => ids.size && db.getThread(id)).map(([id]): TrayItem => ({ threadId: id, label: chatLabel(id) })),
    routinesPaused: !!settings.get().routinesPaused,
    quickKey: settings.get().quickKey
  }), {
    open: (id) => openThread(id),
    quickAsk: () => showQuick(),
    newChat: () => sendMenu('new-chat'),
    setRoutinesPaused,
    showMain: () => { showMain() },
    settings: () => sendMenu('settings'),
    quit: () => app.quit()
  })
  // Hidden (test) runs never put anything on the user's screen: no menu bar icon.
  if (!HIDDEN) menuBar.setEnabled(settings.get().menuBarIcon !== false)
  /** Login items only for the installed app: in development it would register Electron itself. */
  const applyLoginItem = (on: boolean): void => {
    if (HIDDEN || process.platform !== 'darwin' || !app.isPackaged) return
    try { app.setLoginItemSettings({ openAtLogin: on }) } catch { /* not allowed here */ }
  }
  alwaysOnChanged.current = (patch) => {
    const s = settings.get()
    if (patch.menuBarIcon !== undefined && !HIDDEN) menuBar?.setEnabled(s.menuBarIcon !== false)
    if (patch.openAtLogin !== undefined) applyLoginItem(!!s.openAtLogin)
    if (patch.keepAwakeWhileWorking !== undefined) refreshAwake()
    if (patch.routinesPaused !== undefined) {
      // Resuming: due routines follow the catch-up rules right away.
      if (!s.routinesPaused) void scheduler.tick().catch(() => undefined)
      toWin('schedules:changed')
    }
    if (patch.quickKey !== undefined || patch.routinesPaused !== undefined) menuBar?.refresh()
  }
  const alwaysOnStatus = (): AlwaysOnStatus => {
    const s = settings.get()
    let loginItem: AlwaysOnStatus['loginItem'] = 'unsupported'
    if (process.platform === 'darwin' && app.isPackaged) { try { loginItem = app.getLoginItemSettings().status } catch { /* unknown */ } }
    return { loginItem, openedAtLogin, working: work.working().length, keepingAwake: awake.on, menuBarIcon: !!menuBar?.shown, routinesPaused: !!s.routinesPaused }
  }
  handle('alwaysOn:status', () => alwaysOnStatus())
  // Settings → Privacy & Permissions: status (no prompts) and the exact System Settings pane; nothing is granted here.
  handle('permissions:status', () => permissionsStatus({
    accessibility: () => systemPreferences.isTrustedAccessibilityClient(false),
    media: (kind) => systemPreferences.getMediaAccessStatus(kind),
    notificationsSupported: () => Notification.isSupported(),
    open: fileProbe,
    home: homedir()
  }))
  handle('permissions:open', async (kind: string) => { await shell.openExternal(settingsUrl(kind)) })
  handle('permissions:automation', (appName: string) => automationStatus(String(appName).slice(0, 80)))
  handle('alwaysOn:pauseRoutines', (paused: boolean) => { setRoutinesPaused(!!paused); return alwaysOnStatus() })
  // One notification for chats cut off last time (each also has a Continue notice in the chat).
  if (recovered.length) {
    refreshBadge()
    if (!QUIET && Notification.isSupported()) {
      const n = recovered.length
      showNote(new Notification({ title: 'SahilBot was closed while working', body: n === 1 ? `${chatLabel(recovered[0].threadId)}: open the chat and press Continue.` : `${n} chats were cut off. Open them and press Continue.` }), recovered[0].threadId)
    }
  }
  // ---------------------------------------------------------------- connected apps (MCP server) and sahilbot:// links
  // Off by default. An app's messages are untrusted (like another bot's handoff): Ask mode, tainted.
  const mcp = setupMcpServer({
    db, settings, dir: sub('mcp-server'), hidden: HIDDEN, mainWindow: () => win,
    host: {
      db, memory, emit, secretValues: () => [...vault.secretValues(), ...browser.hiddenValues()],
      agent: {
        isRunning: (t) => chat.isRunning(t),
        pending: (t) => [...chat.pending(t), ...purchases.pending(t)],
        send: (input, opts) => chat.send(input, opts),
        steer: (t, text, meta) => chat.steer(t, text, meta),
        whenIdle: (t, signal, ms) => chat.whenIdle(t, signal, ms)
      }
    }
  })
  app.on('before-quit', () => { void mcp.dispose() })
  // ---------------------------------------------------------------- know what I'm working on (opt-in, off by default)
  // Only while SahilBot runs; local only; stops on quit. See activity/ for what is (and is never) collected.
  setupActivity({ db, mainWindow: () => win, hidden: HIDDEN })
  // Chats a connected app started: anything learned from them is tagged.
  appThreadRef.current = (id) => mcp.isAppThread(id)
  // Background jobs (Jobs tab): live updates to the window, IPC, and a quit that asks while any still run.
  jobs.onEvent((e) => toWin('jobs:event', e))
  handle('jobs:list', (threadId?: string) => jobs.list(typeof threadId === 'string' ? threadId : undefined))
  handle('jobs:output', (id: string, o?: { tail?: number; grep?: string }) => {
    try { const r = jobs.output(String(id), { tail: Math.min(Number(o?.tail) || 400, 2000), grep: typeof o?.grep === 'string' ? o.grep.slice(0, 200) : undefined }); return { lines: r.lines, total: r.total } } catch { return { lines: [], total: 0 } }
  })
  handle('jobs:stop', async (id: string) => (await jobs.stop(String(id))) ?? null)
  handle('jobs:restart', async (id: string) => (await jobs.restart(String(id))) ?? null)
  handle('jobs:remove', (id: string) => jobs.remove(String(id)))
  installQuitGuard(app, { jobs, silent: HIDDEN, window: () => win, showMessageBox: (w, opts) => (w ? dialog.showMessageBox(w, opts) : dialog.showMessageBox(opts)) })
  registerProtocolClient(HIDDEN)
  // Settings → Always-on server: this Mac's link to a SahilBot Server (src/main/remote-server.ts).
  setupRemoteServer({ db, secrets, openExternal: (u) => { if (/^https?:\/\//.test(u)) void shell.openExternal(u) } })
  openUrls.attach(urlHandler({ db, emit, openThread, newChat: () => sendMenu('new-chat'), mainWindow: () => showMain(), isAppThread: (id) => mcp.isAppThread(id) }))

  // ---------------------------------------------------------------- swarms and Heavy runs
  // Paid requests made inside a swarm (a big cloud team, a Heavy run) count toward its own cap: one that
  // could pass it is refused before it is sent. Chained after the monthly and goal checks.
  const spendBeforeSwarm = spendHooks.before
  spendHooks.before = (req, est, maxOutput, pricedAs) => {
    spendBeforeSwarm?.(req, est, maxOutput, pricedAs)
    swarmSpend.before(pricedAs, est, maxOutput)
  }
  const spendAfterSwarm = spendHooks.after
  spendHooks.after = (req, input, output, served) => {
    spendAfterSwarm?.(req, input, output, served)
    try { swarmSpend.after(served, input, output) } catch { /* never fails the request */ }
  }
  // Team board and Heavy card buttons: cancel one helper, or stop the ones that haven't finished.
  handle('agents:cancelHelper', (memberId: string) => chat.cancelHelper(String(memberId)))
  handle('agents:stopRemaining', (groupId: string) => chat.stopRemaining(String(groupId)))

  app.on('activate', () => {
    // The browser's hidden parking window doesn't count as an open window.
    if (!win || win.isDestroyed()) reopen()
  })
  mark('main startup finished')
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
