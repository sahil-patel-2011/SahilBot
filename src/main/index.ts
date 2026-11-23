import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, Notification, powerMonitor, powerSaveBlocker, screen, session, shell, systemPreferences } from 'electron'
import { autoPool, autoVariant } from './llm/router'
import { execFileSync } from 'node:child_process'
import { homedir, hostname, tmpdir, totalmem, userInfo } from 'node:os'
import { statfsSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { homeIdeas } from './ideas'
import { classifyTask, type TaskCategory } from './llm/task-classifier'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { copyFileSync, mkdirSync } from 'node:fs'
import type { AlwaysOnStatus, BotShape, ChatEvent, CheckinSettings, NeedsYouItem, PendingRequest, PermissionKind, PermissionMode, PermissionState, SendInput, Settings, Space, UsageRow } from '@shared/types'
import type { GoalPatch, MemoryItem, VoiceBarOptions, VoiceSession, VoiceStyle } from '@shared/types'
import { Attachments, registerScheme } from './attachments'
// Cloud first, local opt-in (shared/local-mode.ts); attached folders are counted and indexed (knowledge/folder-scan.ts).
import { localOff, localOn } from '@shared/local-mode'
import { botState, runPhase, runsOnLabel, type BotStatus, type BotStatusMap } from '@shared/bot-status'
import { hasLocalModels } from './local-detect'
import { scanFolder } from './knowledge/folder-scan'
import { OpenAITtsEngine } from './voice/tts'
import { DEFAULT_TRANSCRIBE_MODEL, speechUsd, transcribe as openaiTranscribe, transcribeUsd } from './apis/openai'
import { OpenAISttEngine } from './voice/stt'
import { hookSpend } from './apis/spend'
import { INTRO, autoMemoryOn, setAutoMemory } from './agent/prompt'
import { createBotTool, finishSetupTool, manageBotTool, SETUP_GREETING, SETUP_PROMPT, updateBotTool } from './agent/tools/bots'
import { PROVIDERS } from './llm/providers'
import { Budget, budgetLeftFor, spendingMode } from './llm/budget'
import { SPEED_SENSITIVE, fastHooks, fastSupport, fastTierFor, fastTradeoff, speedOptions } from './llm/fast-mode'
import { isAuto } from './llm/router'
import { NotificationPermission, automationStatus, fileProbe, permissionsStatus, requestAutomation, settingsUrl } from './permissions-center'
import { collectText, isLocal, spendHooks, streamChat, usageDetails } from './llm/client'
import { ConnectorIcons, Connectors, PRESETS } from './connectors'
import { OAUTH_CLIENTS_FILE, readBuiltinClients } from './oauth-clients'
import { addTemplate, loadTemplates, type TemplateDeps } from './templates'
import { BOT_FILE_EXT, BOT_FILE_MAX_BYTES, botFileFor, duplicateBot, importPreview, importTemplate, parseBotFile, PendingImports } from './bot-share'
import { getCheckin, overviewTool, setCheckin } from './checkin'
import { aggregateUsage, providerOf, usageDashboard, usageDetailCsv, usageGlance, usageRows, usageScope, windowStart } from './usage'
import { VoiceService } from './voice/service'
import { Scheduler } from './scheduler'
import { buildMenu, setupApp, windowState } from './shell'
import { scheduleTool } from './agent/tools/schedule'
import { ResultStore } from './agent/context'
import { Agent, isRelayed } from './agent/loop'
import { ToolRegistry } from './agent/registry'
import { browserTool } from './agent/tools/browser'
import { workerBrowserTool } from './agent/tools/worker-browser'
import { DEFAULT_MAC_TOOLS, MAC_TOOLS, MacLinkClient, MacLinkHub, macEffect, macTool } from './mac-link'
import { linkedServerCall } from './remote-server'
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
import { importFile, isEditable, saveFormat } from './docspace/import'
import { docTools } from './agent/tools/docspace'
import { memoryTool } from './agent/tools/memory'
import { webTools } from './agent/tools/web'
import { Db } from './db'
import { machine, providerModels, root, teamCapacity, wiredLimitMB } from './llm/models'
import { Endpoints } from './llm/endpoints'
import { chatgptPlan, closeAll as closeCodexRuns, CODEX_INSTALL_URL, CODEX_URL, PLAN_DEFAULT } from './llm/codex'
import { grokPlan } from './llm/grok/plan'
import { GROK_INSTALL_GUIDE, GROK_PLAN_MODEL, GROK_PLAN_URL } from '@shared/grok-plan'
import { autoWindow, samplingFor } from './llm/catalog'
import { Warmup, lastUsedModel, warmupAllowed } from './llm/warmup'
import { MemoryStore, similar, type ImportItemIn } from './memory'
import { IMPORT_MAX_CHARS, ruleName } from './memory-import'
import { MEMORY_IMPORT_PROMPT } from '@shared/memory-import'
import { appRoot, dataDir, isPackaged, sub } from './paths'
import { Updater, backupBeforeUpgrade, backupData, backupsDir, bundleBuild, bundleOf, mirrorBackupsDir } from './updater'
import { BackupService, RecoveryError, secretNames } from './backup'
/** The version this Mac ran before this start, when this is the first start of a new version. */
let upgradedFrom: string | undefined
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
import { mapsTool } from './agent/tools/maps'
import { phiTool } from './agent/tools/phi'
import { agentsTool, swarmTool } from './agent/tools/agents'
import { maxTool } from './agent/tools/max'
import { askBotTool } from './agent/tools/ask-bot'
import { findBot, handoffTool } from './agent/tools/handoff'
import { startWorkTool, voiceTitle, VoiceWork } from './voice/work'
import { LANGUAGES, clampSpeed } from './voice/voices'
import { computerTool } from './agent/tools/computer'
import { createOverlay } from './computer/overlay-window'
import { consultTool } from './agent/tools/consult'
import { askOnMacTool } from './agent/tools/ask-on-mac'
import { PiiTracer, DOWNLOAD_BYTES as PII_TRACER_BYTES } from './privacy/tracer'
import { HYBRID_BEST, HYBRID_MIN } from '@shared/privacy'
import { checkpointTool, createCua } from './agent/cua'
import { frcCodeTool } from './agent/tools/frc_code'
import { frcMechTool } from './agent/tools/frc_mech'
import { onshapeTool, testOnshapeKeys } from './agent/tools/onshape'
import { freecadTool } from './agent/tools/freecad'
import { findFreecadCmd } from './cad/freecad'
import { cadDesignTool } from './cad/design-tool'
import { macKeyStore, Secrets } from './secrets'
import { SettingsStore, type SettingsPatch } from './settings'
import { requestedModel } from './agent/choices'
import { SpaceFiles, botAutonomyConfig, botLevel, isAlwaysOnBot, migrateBotAutonomy, migrateBotMax, migrateBotModelEffort, migratePermissionLevels } from './spaces'
import { ATTENDED_GRACE_MS, Learner, QuestionQueue, QuestionStore, createQuestionHost, notifyDevices as notifyQuestionDevices, toNeedsYou } from './agent/questions'
import { DigestRunner } from './goals/digest'
import { BrowserManager } from './browser/manager'
import { Vault } from './vault'
import { VaultAuth } from './secure/auth'
import { vaultHandlers } from './secure/ipc'
import { SaveOffers, savesWithoutAsking } from './secure/offers'
import { findSecrets, redactFound, replacePlaceholder, savedPlaceholder } from './secure/detect'
import { electronTouchId, electronVaultFiles, protectSender, registerVaultIpc, startAutoLock } from './secure/electron'
import { PurchaseGate } from './browser/checkout'
import { recentEmail, recentTexts, setEmailCodeSource } from './otp'
import { mailTool } from './agent/tools/mail'
import { resendTool, RESEND_KEY_SECRET } from './agent/tools/resend'
import { gmailImapTool } from './agent/tools/gmail-imap'
import { GoogleConnect } from './mail/google-connect'
import { mailRunner } from './mail/runner'
import { TrustedSends } from './agent/trusted'
import { chatParticipants, withChatDb } from './messages/chatdb'
import { gmailCodeSource } from './mail/gmail'
import { findOllamaBinary, setupOllama, startOllama, stopOllama } from './ollama-setup'
import { needsYouBody } from './needs-you'
import { MenuBarIcon, type TrayItem } from './tray'
import { KeepAwake, RESUME_NEXT_NOTE, RESUME_NOTE, WorkTracker, wantAwake } from './resume'
import { LidAwake, LOW_BATTERY, parseBattery, run as runPmset } from './lid-awake'
import type { MenuAction } from './shell'
import { getWatchlist, setWatchlist } from './watchlist'
import { MarketData } from './markets/data'
import { Markets, type AlertState } from './markets/service'
import { alertFromPrompt, usMarketOpen } from './markets/alerts'
import { stockTools } from './agent/tools/stocks'
import { KnowledgeService } from './knowledge/service'
import { LearningService } from './learning/service'
import { DecisionRecorder } from './learning/decisions'
import { knowledgeTools, resolveScope } from './agent/tools/knowledge'
import { vaultTool } from './agent/tools/vault'
import { apiRequestTool } from './agent/tools/api-request'
import { chatHistoryTool } from './agent/tools/chat-history'
import { manualTool } from './agent/tools/manual'
import { VaultService } from './vault/service'
import { workingMemoryPage } from './vault/working-memory'
import { MemoryMirror } from './vault/memory-mirror'
import { ContextEngine } from './context-engine/service'
import { BrainService } from './brain/service'
import { liveIO } from './brain/io'
import { fixtureConnectors } from './brain/fixture'
import { readPower, type PowerState } from './brain/power'
import { aboutTool } from './agent/tools/about'
import { activityLearningAllowed, activityTimelineForLearning } from './activity'
import { GoalManager, withGoalsOverview } from './goals'
import { opensDirectly } from './knowledge/ignore'
import { followUpTool, goalTool } from './agent/tools/goals'
import { captureOpenUrls, registerProtocolClient, setupMcpServer, urlHandler } from './mcp-server/app'
import { brainReader } from './brain-access/wire'
import { TeamAsk } from './brain-access/team-ask'
import { setupActivity } from './activity/app'
// Media, vision and batch tools on the user's own OpenAI / Anthropic keys (src/main/apis).
import { apiAccess } from './apis/keys'
import { mediaTools } from './agent/tools/media'
import { readDocumentImageTool, readReceipt } from './agent/tools/vision'
import { BatchManager, batchTool } from './agent/tools/batch'
import { VideoManager, publicHttps, videoTool, type VideoApp, type VideoLink } from './agent/tools/video'
import { canNotifyDevices, notifyDevices } from './notify'
import { PhoneAccess } from './phone'
import { isServer } from './runtime'
import { phoneNote } from './phone/notes'
import type { ToolContext } from './agent/types'
import { embeddingProvider } from './knowledge/embeddings'
import { grokSpeech } from './voice/grok'
import { GROK_VOICE_MODEL, GROK_VOICE_USD_PER_MIN, grokVoiceInstructions } from './voice/grok-realtime'
import { connectedVoice, nativeVoiceSite, voicePreference } from '@shared/voice-provider'
import { OPENAI_URL, XAI_URL } from './llm/providers'
import { fromWav } from './voice/audio'
import { swarmSpend } from './agent/swarm/ledger'
import { mark, TIMING } from './timing'
// Channels and events go through a transport-agnostic registry (src/main/rpc.ts): Electron IPC here, a WebSocket on SahilBot Server.
import { addAdapter, broadcast, registerHandler } from './rpc'
import { electronAdapter } from './rpc-electron'
import { setupRemoteServer } from './remote-server'
import { placementBlock, placementOf, setupWorkerFleet, setupWorkerHost } from './workers'

// Linux test runs only: Playwright launches Electron with --password-store=basic (plain text, which the
// secret store refuses), so a test on a machine with a keyring can switch back to it before the app is ready.
if (process.platform === 'linux' && process.env.SAHILBOT_TEST_PASSWORD_STORE) app.commandLine.appendSwitch('password-store', process.env.SAHILBOT_TEST_PASSWORD_STORE)

// SAHILBOT_TIMING=1: launch phases in the log (src/main/timing.ts).
mark('main module loaded')

// A promise that fails with nobody listening is a bug: log it with a clear marker (tests/accept/no-errors
// fails on it) rather than crash the app or stay silent.
process.on('unhandledRejection', (reason) => {
  console.error('[sahilbot] unhandledRejection:', reason instanceof Error ? reason.stack ?? reason.message : reason)
})

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
/** Source code and config an agent edited while coding: not deliverables, so not on the Artifacts page. */
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|scala|vue|svelte|json|ya?ml|toml|lock|sh|css|scss|env|ini|cfg|gradle|xml|plist)$/i

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
  // A new version's first start: a copy of the database before its migrations run (main/updater.ts). Only the
  // instance that holds the lock (a second one is quitting).
  if (isPackaged() && app.hasSingleInstanceLock()) {
    // The version this Mac ran before, when this start is the first of a new one (What's new shows once).
    try {
      const was = readFileSync(join(dataDir(), '.sahilbot-version'), 'utf8').trim()
      if (was && was !== `${app.getVersion()}-${bundleBuild(bundleOf(process.execPath))}`) upgradedFrom = was
    } catch { /* first install: nothing to announce */ }
    try { backupBeforeUpgrade(dataDir(), app.getVersion(), bundleBuild(bundleOf(process.execPath))) }
    catch (e) {
      dialog.showErrorBox('Your data has been kept safe', `SahilBot could not make its required backup before opening this version. Your data has not been migrated or removed. Free some space or check folder permissions, then reopen SahilBot.\n\n${(e as Error).message}`)
      app.quit()
      return
    }
  }
  const db = new Db(join(dataDir(), 'foreman.db'))
  mark('database open')
  db.sweepStreaming()
  // ---------------------------------------------------------------- always on: runs cut off last time
  // Before anything can run: chats whose run was cut off by a quit or crash get a notice with Continue.
  const work = new WorkTracker(db)
  const recovered = work.recover()
  /** The menu bar icon (created once the window and Quick Ask exist; never in hidden test runs). */
  let menuBar: MenuBarIcon | null = null
  // On the Mac, keys are sealed with a Keychain key that survives updates (secrets.ts); test runs and the
  // server keep safeStorage and never touch the Keychain.
  const secrets = new Secrets(db, process.platform === 'darwin' && !isServer() && !HIDDEN && !process.env.VITEST ? macKeyStore(app.getName()) : null)
  const settings = new SettingsStore(db, secrets)
  // "Remember things automatically" (default on) shapes the prompts' memory guidance (agent/prompt.ts).
  setAutoMemory(settings.get().learning?.enabled !== false)
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
    const chosen = requestedModel({ thread, space: thread ? db.getSpace(thread.spaceId) : undefined, settings: s })
    const state = db.getState(threadId)
    return fastTierFor(model, s, { auto: isAuto(chosen), speedSensitive: !!state.voice || SPEED_SENSITIVE.has(state.lastCategory ?? '') })
  }

  const memory = new MemoryStore(db)
  // Every bot, chat and agent reads what the other bots learned (labeled; never their rules) unless the user turned it off.
  memory.nameOf = (id) => db.getSpace(id)?.name
  memory.shareAcrossBots = settings.get().memorySharing !== false
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
  /** What macOS last did with a SahilBot notification (setup's "Turn on" and every notification since). */
  const notePermission = new NotificationPermission(join(dataDir(), 'notification-permission.json'))
  const showNote = (n: Notification, threadId: string): void => {
    n.on('click', () => openThread(threadId))
    notes.push(n)
    if (notes.length > 30) notes.shift()
    notePermission.observe(n)
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
  /**
   * Dock badge: chats waiting on you + unread chats (top-level, not hidden bots, not the one you're reading).
   * Unread includes bots' chats with replies you haven't seen (Db: flag or replies after last_read_at); it is
   * one set of chat ids, so a bot that needs you and has unread replies still counts once.
   */
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

  /** Phone access: when each chat's run started, so a long task's end reaches the phone. */
  const runStarts = new Map<string, number>()
  /** Paired phones hear about approvals and questions waiting in a chat, and long tasks finishing (phone/notes.ts). */
  const toPhones = (e: ChatEvent, ownNote: boolean): void => {
    if (e.type === 'run' && e.status === 'started') { runStarts.set(e.threadId, Date.now()); return }
    if (e.type !== 'pending' && e.type !== 'run') return
    const startedAt = e.type === 'run' ? runStarts.get(e.threadId) : undefined
    if (e.type === 'run') runStarts.delete(e.threadId)
    // SahilBot Server sends its notifications itself (its Notification goes to devices).
    if (isServer() || !canNotifyDevices()) return
    const thread = db.getThread(e.threadId)
    if (!thread || thread.parentId || quickRuns.has(e.threadId) || db.getSpace(thread.spaceId)?.hidden) return
    const n = phoneNote(e, {
      botName: botName(thread.spaceId),
      title: thread.title,
      requestLine: e.type === 'pending' ? needsYouText(e.request) : undefined,
      notify: botNotifies(thread.spaceId),
      watchingOnMac: mainFocused() && viewingThread === e.threadId,
      startedAt, now: Date.now(), ownNote,
      longRunMs: HIDDEN ? Number(process.env.SAHILBOT_PHONE_LONG_RUN_MS) || undefined : undefined
    })
    if (n) notifyDevices('all', n)
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
    try { toPhones(e, fromQuick || fromRoutine) } catch { /* notifications are best-effort */ }
    // A chat finished while you were in another app: a quiet notification.
    if (e.type === 'run' && (e.status === 'finished' || e.status === 'error') && !fromQuick && !fromRoutine && !(quick && !quick.isDestroyed() && quick.isVisible()) &&
      !(win && !win.isDestroyed() && win.isFocused()) && !QUIET && Notification.isSupported() && botNotifies(e.spaceId ?? db.getThread(e.threadId)?.spaceId)) {
      const who = botName(e.spaceId ?? db.getThread(e.threadId)?.spaceId)
      // Held (showNote) so it isn't garbage-collected before macOS shows it, and it keeps the permission record current.
      showNote(new Notification({ title: e.status === 'error' ? `${who} needs help` : `${who} is done`, body: (e.title ?? 'Your task').slice(0, 120), silent: false }), e.threadId)
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
    () => toWin('browser:open'),
    () => settings.get().advanced.animateBrowser === true
  )
  // A saved password typed while teaching a task is never recorded, whichever field it went into.
  browser.teach.secretValues = () => vault.secretValues()
  // Saved card numbers never leave the browser unless the user approved that purchase step.
  browser.cardNumbers = () => { try { return vault.cardNumbers() } catch { return [] } }
  // "Save to Vault?" (src/main/secure/offers.ts): a sign-in or card the user typed by hand in the browser
  // panel, or a secret typed into the composer. Held in memory here until the user clicks Save; masked
  // everywhere meanwhile; the window only sees the site, a masked username, brand and last 4.
  const saveOffers = new SaveOffers({
    vault,
    never: { get: () => db.getSetting<string[]>('vault:neverSave') ?? [], set: (list) => db.setSetting('vault:neverSave', list) },
    onBrowserChange: () => browser.refreshOffers()
  })
  vault.pendingSecrets = () => saveOffers.values()
  browser.saveOffers = saveOffers
  /** A chat message's offer was saved or dismissed: the model now sees [saved to vault: name] there. */
  const offerOnMessage = (e: { id: string; status: 'saved' | 'dismissed'; name?: string; messageId?: string }): void => {
    const m = e.messageId ? db.getMessage(e.messageId) : undefined
    const offers = Array.isArray(m?.meta?.vaultOffers) ? (m!.meta!.vaultOffers as import('@shared/types').VaultSaveOffer[]) : null
    const o = offers?.find((x) => x.id === e.id)
    if (!m || m.role !== 'user' || !offers || !o) return
    const content = e.status === 'saved' && e.name && typeof o.ordinal === 'number' ? replacePlaceholder(m.content, o.ordinal, savedPlaceholder(e.name)) : m.content
    const next = { ...m, content, meta: { ...m.meta, vaultOffers: offers.map((x) => (x.id === e.id ? { ...x, status: e.status, ...(e.name ? { savedAs: e.name } : {}) } : x)) } }
    db.updateMessage(next)
    emit({ threadId: m.threadId, type: 'message', message: next })
  }
  /**
   * Text the user typed, before it's stored or reaches a model: passwords, API keys, card and ID numbers
   * become [redacted] (secure/detect.ts) and get a "Save to Vault?" card next to the message.
   */
  const guardUserText = (threadId: string, text: string): { text: string; offers: import('@shared/types').VaultSaveOffer[] } => {
    let out: { text: string; offers: import('@shared/types').VaultSaveOffer[] }
    try { out = saveOffers.scanChat(String(text ?? ''), threadId) } catch { return { text: String(text ?? ''), offers: [] } }
    if (out.offers.length && settings.get().advanced.autoSaveSecrets !== false) autoSaveOffers(threadId, out.offers)
    return out
  }
  /**
   * A password, API key or card pasted into the chat is saved to the vault by itself (Touch ID or the master
   * password unlocks it if needed): the message then shows [saved to vault: name], and the model can use it
   * through the vault without ever seeing the value. Offers that still need an answer (which site a password
   * is for) keep their "Save to Vault?" card. Settings → Advanced → autoSaveSecrets: false turns this off.
   */
  const autoSaveOffers = (threadId: string, offers: import('@shared/types').VaultSaveOffer[]): void => {
    // After the message is stored, so the saved name lands on it.
    setTimeout(() => void (async () => {
      for (const o of offers.filter(savesWithoutAsking)) {
        try {
          const r = await saveOffers.save(o.id)
          const m = [...db.listMessages(threadId)].reverse().find((x) => x.role === 'user' && Array.isArray(x.meta?.vaultOffers) && (x.meta!.vaultOffers as Array<{ id: string }>).some((v) => v.id === o.id))
          offerOnMessage({ id: o.id, status: 'saved', name: r.name, ...(m ? { messageId: m.id } : {}) })
        } catch { /* locked and not unlocked, or already handled: the card stays */ }
      }
    })(), 400)
  }
  /** Offers for a message sent another way (steer, edit): attached to the newest user message with that text. */
  const attachOffers = (threadId: string, text: string, offers: import('@shared/types').VaultSaveOffer[]): void => {
    if (!offers.length) return
    const m = [...db.listMessages(threadId)].reverse().find((x) => x.role === 'user' && x.content === text && !x.meta?.vaultOffers)
    if (!m) { for (const o of offers) saveOffers.dismiss(o.id); return }
    const next = { ...m, meta: { ...m.meta, vaultOffers: offers } }
    db.updateMessage(next)
    emit({ threadId, type: 'message', message: next })
  }
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
  // Privacy Gate (src/main/privacy): PII-Tracer on this Mac checks what a cloud model would see when a chat
  // uses local and cloud models together. On once PII-Tracer is downloaded, unless switched off.
  const piiTracer = new PiiTracer(join(dataDir(), 'pii-tracer'))
  let hybridAt = 0
  let hybridNow = false
  const privacyHybrid = (): boolean => {
    if (Date.now() - hybridAt < 5000) return hybridNow
    hybridAt = Date.now()
    try {
      const usable = endpoints.usable()
      const local = (id: string): boolean => isLocal(endpoints.for(id).baseUrl)
      hybridNow = usable.some((m) => local(m.id)) && usable.some((m) => !local(m.id))
    } catch { hybridNow = false }
    return hybridNow
  }
  /** What hybrid compute needs: Apple Silicon, 32 GB memory and 50 GB free disk (64 GB and 150 GB for the top local models). */
  const hybridRequirements = (): import('@shared/privacy').HybridRequirements => {
    const ramGB = Math.round((Number(process.env.FOREMAN_RAM_GB) || totalmem() / 1024 ** 3))
    let freeDiskGB = 0
    try { const f = statfsSync(dataDir()); freeDiskGB = Math.floor((f.bavail * f.bsize) / 1e9) } catch { /* unknown: reads as 0 */ }
    const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64'
    const problem = !appleSilicon ? 'Hybrid compute needs a Mac with Apple Silicon.'
      : ramGB < HYBRID_MIN.ramGB ? `This Mac has ${ramGB} GB of memory; hybrid compute needs at least ${HYBRID_MIN.ramGB} GB.`
      : freeDiskGB < HYBRID_MIN.diskGB ? `${freeDiskGB} GB of disk space is free; hybrid compute needs at least ${HYBRID_MIN.diskGB} GB for the local models and PII-Tracer.`
      : undefined
    return { ramGB, freeDiskGB, appleSilicon, meetsMinimum: !problem, meetsBest: !problem && ramGB >= HYBRID_BEST.ramGB && freeDiskGB >= HYBRID_BEST.diskGB, ...(problem ? { problem } : {}) }
  }
  // Memory doesn't change while the app runs; disk is checked when the user turns hybrid compute on.
  const hybridRamOk = (): boolean => process.arch === 'arm64' && (Number(process.env.FOREMAN_RAM_GB) || totalmem() / 1024 ** 3) >= HYBRID_MIN.ramGB - 0.5
  const privacyActive = (): boolean => settings.get().hybridCompute?.enabled === true && hybridRamOk() && piiTracer.installed() && privacyHybrid()
  /** Today's Privacy Gate numbers (kept in the database, a new day starts at zero). */
  const privacyToday = (): import('@shared/privacy').PrivacyDayStats => {
    const now = new Date()
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const s = db.getSetting<import('@shared/privacy').PrivacyDayStats>('privacy:today')
    return s && s.day === day ? s : { day, requests: 0, checked: 0, asked: 0, protected: 0, cleared: 0, errors: 0 }
  }
  const privacyCount = (what: 'requests' | 'checked' | 'asked' | 'protected' | 'cleared' | 'errors', n = 1): void => {
    const s = privacyToday()
    s[what] += n
    db.setSetting('privacy:today', s)
  }
  const hybridSettings = (): NonNullable<import('@shared/types').Settings['hybridCompute']> => settings.get().hybridCompute ?? { enabled: false }
  /** Details the user said aren't personal, as "label:value" (lowercased, spaces collapsed), newest last, at most 500. */
  const notPersonalList = (): string[] => db.getSetting<string[]>('privacy:notPersonal') ?? []
  const privacyStatus = (): import('@shared/privacy').PrivacyStatus => {
    hybridAt = 0
    const h = hybridSettings()
    return { installed: piiTracer.installed(), installing: piiTracer.installingNow(), enabled: h.enabled === true, mode: h.mode === 'auto' ? 'auto' : 'ask', remembered: notPersonalList().length, today: privacyToday(), requirements: hybridRequirements(), hybrid: privacyHybrid(), active: privacyActive(), downloadBytes: PII_TRACER_BYTES }
  }
  // The context engine (People & Places), set up with the knowledge vault below; the memory tool's "about" uses it.
  const worldRef: { current?: ContextEngine } = {}
  /** Your brain (src/main/brain), set up after the context engine; Needs you lists its prompts. */
  const brainRef: { current?: BrainService } = {}
  const brainPowerTimer: { current?: ReturnType<typeof setInterval> } = {}
  /** Gets speech recognition ready in the background (set once the voice service exists). */
  const voicePrepRef: { current: (why: 'auto' | 'mic' | 'user') => void } = { current: () => undefined }
  registry.register(
    ...coreTools(results),
    apiRequestTool(vault),
    chatHistoryTool(db),
    // The app's own manual (docs/*.md), searchable: the agent looks things up instead of guessing.
    manualTool(docsDir),
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
    isServer() ? workerBrowserTool() : { ...browserTool(browser, vault, { gate: purchases, email: (min, site) => recentEmail(min, site), sms: (since) => recentTexts(since), sites }), core: true },
    sitesTool(sites),
    { ...cursorTool(() => secrets.get('cursorKey'), () => settings.get().workspaceDir, () => !!settings.get().cursorLocalAgent), core: true },
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
    researchTool({ ncbiKey: () => secrets.get('ncbiKey') }),
    // Maps and travel: Google Maps with the user's key, else OpenStreetMap; every result links to Google Maps.
    mapsTool({ googleKey: () => secrets.get('googleMapsKey') }),
    // Patient data: find and redact the 18 HIPAA identifiers before text goes anywhere (local, read-only).
    phiTool(),
    maxTool(),
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
    askOnMacTool({
      active: privacyActive,
      localModel: () => {
        try {
          return endpoints.usable().filter((m) => isLocal(endpoints.for(m.id).baseUrl) && m.tools !== false).sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0) || (b.requiredGB ?? 0) - (a.requiredGB ?? 0))[0]?.id
        } catch { return undefined }
      },
      isCloud: (m) => !isLocal(endpoints.for(m).baseUrl),
      transcript: (threadId) => db.listMessages(threadId).filter((m) => !m.meta?.hidden && m.content && (m.role === 'user' || m.role === 'assistant' || m.role === 'tool'))
        .map((m) => `${m.role === 'user' ? 'User' : m.role === 'tool' ? `Tool result (${m.toolName ?? 'tool'})` : 'Assistant'}: ${m.content}`).join('\n\n'),
      ask: async (model, system, user, signal) => {
        const ep = endpoints.for(model)
        return collectText(streamChat({ baseUrl: ep.baseUrl, apiKey: ep.apiKey, model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], sampling: samplingFor(model, settings.get().sampling), maxTokens: 2000, effort: 'medium', signal }))
      },
      detect: (text, signal) => piiTracer.detect(text, signal)
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
    // "Make me a … bot" and "delete the … bot" by asking, from any chat.
    createBotTool({
      create: (name, color, shape, icon) => { const r = templateDeps.createBot(name, color, shape as BotShape); if (icon) db.updateSpace(r.spaceId, { icon }); return r },
      setPrompt: (spaceId, text) => spaces.setPrompt(spaceId, text),
      setLabel: (spaceId, label) => db.updateSpace(spaceId, { label }),
      greet: (threadId, text) => { const m = db.insertMessage({ threadId, role: 'assistant', content: text, kind: 'normal', status: 'done' }); emit({ threadId, type: 'message', message: m }); emit({ threadId, type: 'thread', thread: db.markUnread(threadId) }) }
    }, db, () => emit({ threadId: '', type: 'spaces' })),
    manageBotTool({
      remove: (id) => removeBot(id),
      pin: (id, on) => { const cur = settings.get().pinnedBots ?? []; settings.set({ pinnedBots: on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id) } as never) }
    }, db, () => emit({ threadId: '', type: 'spaces' })),
    finishSetupTool(db, spaces, () => emit({ threadId: '', type: 'spaces' })),
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

  // SahilBot's own OAuth app registrations (resources/oauth-clients.json; docs/oauth-registration.md):
  // apps without self-registration then connect in one click. The env var is honoured only in
  // development and hidden test runs; a release build reads the file CI wrote from its secret.
  const oauthClients = readBuiltinClients({
    presets: PRESETS,
    allowEnv: !isPackaged() || HIDDEN,
    // The app bundle (asar: files include resources/**), else next to the project or server root.
    files: [
      join(appRoot(), 'resources', OAUTH_CLIENTS_FILE),
      ...(() => { try { const p = app.getAppPath(); return typeof p === 'string' && p ? [join(p, 'resources', OAUTH_CLIENTS_FILE)] : [] } catch { return [] } })(),
      join(appRoot(), OAUTH_CLIENTS_FILE)
    ]
  })
  for (const p of oauthClients.problems) console.warn(`[connectors] ${p}`)
  const connectors = new Connectors(db, secrets, registry, () => toWin('connectors:changed'), {
    oauthClients: oauthClients.clients,
    // The provider sent the browser back: SahilBot comes to the front so the chat (or Connect apps) carries on.
    onSignedIn: () => {
      if (HIDDEN) return
      try { app.focus({ steal: true }) } catch { /* not on every platform */ }
      showMain()
    }
  })
  // Connect apps → Google: Sign in with Google (the Gmail connector), the Mac's Mail app, or an app password
  // (Gmail over IMAP/SMTP: the gmail_imap tool). The app password stays in the Keychain (mail/google-connect.ts).
  const googleConnect = new GoogleConnect({
    db, secrets, runner: mailRunner(), changed: () => toWin('connectors:changed'),
    oauth: () => {
      const cfg = connectors.list().find((c) => c.preset === 'gmail')
      return { builtin: !!connectors.builtin('gmail'), ownClient: !!connectors.googleClient() || !!cfg?.clientId, connected: connectors.presetConnected('gmail'), ...(cfg ? { configId: cfg.id } : {}) }
    }
  })
  registry.register(
    // Resend: transactional email with the user's own key (Connect apps → Resend), sent only to api.resend.com.
    { ...resendTool({ key: () => secrets.get(RESEND_KEY_SECRET), workspace: () => settings.get().workspaceDir }), core: false },
    { ...gmailImapTool({ creds: () => googleConnect.credentials() }), core: false }
  )
  // Emailed sign-in codes: the Gmail connector when it's connected, else Mail.app (read in main, never shown to the model).
  setEmailCodeSource(gmailCodeSource((tool, args, signal) => connectors.callPresetTool('gmail', tool, args, signal)), () => connectors.presetConnected('gmail'))

  /** Goals (set up further down): an unattended goal wake-up's call that needs approval is queued for the user. */
  const goalHooks: { ask?: (threadId: string, info: { tool: string; label: string; summary?: string; reason?: string }) => string | undefined } = {}
  // The knowledge vault (set up with the knowledge base below): each run's context gets its most relevant
  // notes, sized to the model's window (a cloud model's own window, else what fits on this Mac).
  const notesVaultRef: { current?: VaultService } = {}
  const workingMemoryRef: { current?: ReturnType<typeof workingMemoryPage> } = {}
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
  /** Team access: the owner answered a routed teammate question (set once Phone access is set up). */
  const teamOwnerRef: { current?: (questionId: string, text: string) => void } = {}
  const questionStore = new QuestionStore(db)
  const learner = new Learner(questionStore, memory)
  // The user's decisions (answers, picks, corrections, approval patterns) as memories the agent acts on.
  // Memories only: the permission engine never reads them (learning/decisions.ts).
  const decisions = new DecisionRecorder({ db, memory, auto: autoMemoryOn, secretValues: () => vault.secretValues(), isAppThread: (id) => appThreadRef.current?.(id) ?? false })
  const chatRef: { current: Agent | null } = { current: null }
  let needsYouTimer: ReturnType<typeof setTimeout> | null = null
  const questions = new QuestionQueue({
    store: questionStore, learner,
    botName: (id) => botName(id),
    onApproval: (item, a) => {
      let args: Record<string, unknown> = {}
      try { const v = JSON.parse(item.approval?.args ?? '{}') as unknown; if (v && typeof v === 'object' && !Array.isArray(v)) args = v as Record<string, unknown> } catch { /* pretty text only */ }
      if (item.approval) decisions.approval(item.threadId, { tool: item.approval.tool, label: item.approval.label, summary: item.approval.summary, args, answer: a, tainted: item.tainted })
    },
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
      // A teammate's question the brain couldn't answer (Team access): the owner's answer goes back to the
      // teammate, and no bot run starts. A deadline's default never answers for the owner.
      const teamQ = (db.getSetting<Record<string, string>>('team:items') ?? {})[item.id]
      if (teamQ) {
        if (item.answeredBy === 'user' && item.answers[0]?.trim()) {
          teamOwnerRef.current?.(teamQ, item.answers[0])
          const m = db.insertMessage({ threadId: item.threadId, role: 'assistant', content: 'Sent your answer to your teammate.', kind: 'notice', status: 'done' })
          emit({ threadId: item.threadId, type: 'message', message: m })
        }
        return
      }
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
    privacy: {
      active: privacyActive,
      detect: (text, signal) => piiTracer.detect(text, signal),
      warm: () => piiTracer.warm(),
      mode: () => (hybridSettings().mode === 'auto' ? 'auto' : 'ask'),
      notPersonal: () => new Set(notPersonalList()),
      rememberNotPersonal: (keys) => {
        // Re-confirming an old one moves it to the end, so the newest 500 are kept.
        const add = keys.filter((k) => k.length >= 4 && k.length <= 220)
        const next = [...notPersonalList().filter((k) => !add.includes(k)), ...add].slice(-500)
        db.setSetting('privacy:notPersonal', next)
      },
      count: privacyCount,
      judge: async (items, context, signal) => {
        // The strongest local model that fits: never a cloud model, the finds stay on this Mac.
        const model = (() => { try { return endpoints.usable().filter((m) => isLocal(endpoints.for(m.id).baseUrl)).sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0) || (b.requiredGB ?? 0) - (a.requiredGB ?? 0))[0]?.id } catch { return undefined } })()
        if (!model) return undefined
        const ep = endpoints.for(model)
        const system = 'You check a privacy filter\'s uncertain finds. Personal information means details about a private individual: their name, contact details, home address, account or ID numbers, personal dates (birthdays, appointments), secrets. Not personal: public figures, companies and brands, countries, cities or regions on their own, product names, generic dates ("tomorrow", "Q3"), examples and placeholders. Use the conversation to decide. Reply with only JSON: {"personal": ["id", ...]} listing the finds that are personal.'
        const user = `Conversation:\n${context}\n\nFinds:\n${items.map((i) => `${i.id}: ${i.label} "${i.value}"`).join('\n')}`
        const reply = await collectText(streamChat({ baseUrl: ep.baseUrl, apiKey: ep.apiKey, model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], sampling: samplingFor(model, settings.get().sampling), maxTokens: 400, effort: 'low', signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) }))
        const json = /\{[\s\S]*\}/.exec(reply)?.[0]
        const ids = json ? (JSON.parse(json) as { personal?: unknown }).personal : undefined
        return Array.isArray(ids) ? new Set(ids.filter((x): x is string => typeof x === 'string')) : undefined
      }
    },
    memoryEmbedder: () => knowledge.recallEmbedder(),
    recallFiles: async (query, threadId, signal) => {
      const state = db.getState(threadId), spaceId = db.getThread(threadId)?.spaceId ?? null
      const folders = [...new Set([...(state.roots ?? []), ...(state.folder ? [state.folder] : [])])]
      const files = folders.length ? await knowledge.search(query, { scope: folders, k: 8, signal }).catch(() => null) : null
      const vault = notesVaultRef.current
      const notes = vault?.search(query, vault.sectionsFor(spaceId), 6) ?? []
      return [
        ...(files?.hits ?? []).map((h) => ({ id: `file:${h.citation}`, kind: 'file' as const, text: h.snippet, score: h.score, at: h.modified, source: { path: h.path }, quoted: true })),
        ...notes.map((n) => ({ id: `vault:${n.path}`, kind: 'vault' as const, text: n.snippet, score: n.score, at: Date.now(), source: { path: n.path }, quoted: true }))
      ]
    },
    questions: questionHost,
    // Trusted recipients: a bot's "Can message without asking" list plus the user's own email and phone.
    trustedSends: new TrustedSends({
      config: (botId) => ({ bot: botAutonomyConfig(settings.get(), botId).trustedRecipients ?? [], me: [...(settings.get().me?.emails ?? []), ...(settings.get().me?.phones ?? [])] }),
      lookup: { chatParticipants: (guid) => { try { return withChatDb((d) => chatParticipants(d, guid)) } catch { return null } } }
    }),
    decisions,
    cua,
    connectors,
    db, settings, endpoints, spaces, memory, skills, rules, registry, results, docsDir, emit, fitWindow,
    // Saved passwords and cards, plus one-time codes typed in the last 10 minutes: no tool call may carry them.
    secretValues: () => [...vault.secretValues(), ...browser.hiddenValues()],
    // Any saved value that still shows up in a tool result or error is masked before the model reads it.
    redact: (text) => vault.redact(text),
    onUnattendedAsk: (threadId, info) => goalHooks.ask?.(threadId, info),
    // A project's durable task memory is also a page in its vault area (vault/working-memory.ts), editable there.
    workingMemoryPage: () => { const v = notesVaultRef.current; if (!v) return undefined; return (workingMemoryRef.current ??= workingMemoryPage(v, db)) },
    medical: { apiKey: () => secrets.get('ncbiKey') },
    vaultContext: (o) => notesVaultRef.current?.context({ spaceId: o.spaceId, query: o.query, local: o.local, window: notesVaultWindow(o.model) }) ?? null,
    // One "About the user and their world" section: memories + vault notes + people/places cards (src/main/context-engine).
    worldContext: (o) => worldRef.current?.context({ threadId: o.threadId, spaceId: o.spaceId, query: o.query, window: notesVaultWindow(o.model), local: o.local, memories: o.memories, vault: o.vault, openerId: o.openerId }) ?? null,
    // What the two above size their sections by: context prepared while Auto's brain reads is reused when it matches.
    contextWindow: notesVaultWindow
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

  if (db.listSpaces().length === 0) db.createSpace('New bot', '#1F1F1F', { isMain: true, shape: 'mascot' })
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
  const BADGE_IPC = new Set(['threads:update', 'threads:markRead', 'threads:remove', 'spaces:markUnread', 'spaces:update', 'spaces:remove'])
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
    memory.shareAcrossBots = s.memorySharing !== false
    // Local models switched on or off: the model list (and Auto) follow at once.
    if (patch.local !== undefined && wasLocal !== localOn(s)) {
      // Turned on: an Ollama that's already installed starts (nothing is downloaded or installed here).
      if (localOn(s) && !process.env.FOREMAN_BASE_URL) void startOllama(settings.providers().ollama.baseUrl).catch(() => undefined)
      void endpoints.list().catch(() => undefined)
    }
    if (warmupAllowed() && (patch.defaultModel !== undefined || patch.contextWindow !== undefined || patch.localKeepAlive !== undefined)) warmup.soon()
    if (patch.quickKey !== undefined) registerQuickKeyRef.current()
    if (patch.theme) applyTheme(s.theme)
    // "Remember things automatically" (Settings → Memory): the prompts' memory guidance follows it.
    if (patch.learning !== undefined) setAutoMemory(s.learning?.enabled !== false)
    // Set up (onboarding just finished) or the speech model changed: get speech recognition ready.
    if (patch.local || patch.voiceInput || patch.voiceOutput || patch.cloud || patch.disabledProviders || patch.setKeys) voice.resetEngines()
    if (patch.onboarded === true || patch.voiceInput !== undefined || patch.local !== undefined) voicePrepRef.current('auto')
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
    // Secrets typed into the bar or sitting on the clipboard never reach the model as they are.
    const qg = guardUserText(t.id, String(text ?? ''))
    const qclip = clip ? redactFound(clip, findSecrets(clip)) : ''
    await chat.send({ threadId: t.id, text: qg.text, images, note: `[Asked from Quick Ask, a small floating bar: answer briefly and directly; the user can open the full chat for more.]${qclip ? `\n[The user's clipboard:\n${qclip}]` : ''}`, meta: { quick: true, ...(qg.offers.length ? { vaultOffers: qg.offers } : {}) } })
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
  handle('chatgptPlan:installInTerminal', () => chatgptPlan.installInTerminal())
  // Setup's last check: one real chat through the subscription, so "Connected" means a message works.
  const testSubscription = async (baseUrl: string, model: string): Promise<{ ok: boolean; reply?: string; error?: string }> => {
    try {
      const reply = (await collectText(streamChat({
        baseUrl, model, maxTokens: 256, sampling: samplingFor(model, {}), signal: AbortSignal.timeout(180_000),
        messages: [{ role: 'system', content: 'You are SahilBot. This is a one-message connection check during setup.' },
          { role: 'user', content: 'Say hello in one short sentence so I know you are connected.' }]
      }))).trim()
      return reply ? { ok: true, reply: reply.slice(0, 400) } : { ok: false, error: 'The model sent back an empty reply.' }
    } catch (e) {
      return { ok: false, error: (e as Error).name === 'TimeoutError' ? 'No reply after 3 minutes.' : (e as Error).message }
    }
  }
  handle('chatgptPlan:testChat', () => testSubscription(CODEX_URL, PLAN_DEFAULT))
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
  app.on('before-quit', () => piiTracer.stop())
  // Notifications on by default: once, after setup, ask macOS (its prompt comes with SahilBot's first notification).
  setTimeout(() => {
    if (QUIET || !Notification.isSupported() || !settings.get().onboarded || db.getSetting<boolean>('notifications:asked') || notePermission.get() !== 'unknown') return
    db.setSetting('notifications:asked', true)
    void notePermission.request(new Notification({ title: 'SahilBot', body: 'Notifications are on: SahilBot tells you when a task is done, needs help or has a question.' }), 60_000)
  }, 15_000)
  handle('privacy:status', () => privacyStatus())
  handle('privacy:install', async () => {
    await piiTracer.install((e) => toWin('privacy:install', e))
    // Proves it works right after the download: a made-up sample must come back with its details found (a cold
    // start can take a while on a slow disk, so the wait is generous).
    try {
      const { spans } = await piiTracer.detect('Hi, I\'m Jordan Ellis, jordan.ellis@example.com, (404) 555-0182.', AbortSignal.timeout(150_000))
      if (!spans.length) toWin('privacy:install', { phase: 'error', error: 'PII-Tracer downloaded, but its self-test found nothing in a sample with a name, email and phone. Remove the download and try again.' })
    } catch (e) { toWin('privacy:install', { phase: 'error', error: `PII-Tracer downloaded, but it didn't start: ${(e as Error).message}` }) }
    return privacyStatus()
  })
  handle('privacy:setMode', (mode: 'ask' | 'auto') => {
    settings.set({ hybridCompute: { ...hybridSettings(), mode: mode === 'auto' ? 'auto' : 'ask' } })
    return privacyStatus()
  })
  handle('privacy:forgetNotPersonal', () => {
    db.setSetting('privacy:notPersonal', [])
    return privacyStatus()
  })
  handle('privacy:setEnabled', (enabled: boolean) => {
    if (enabled === true) {
      const req = hybridRequirements()
      if (!req.meetsMinimum) throw new Error(req.problem ?? 'This Mac doesn\'t meet hybrid compute\'s requirements.')
    }
    settings.set({ hybridCompute: { ...hybridSettings(), enabled: enabled === true } })
    if (enabled === true) piiTracer.warm(); else piiTracer.halt()
    return privacyStatus()
  })
  handle('privacy:remove', () => { piiTracer.halt(); piiTracer.remove(); return privacyStatus() })
  /** Settings → Hybrid compute → Test: a made-up sample through PII-Tracer on this Mac, and what it caught. */
  handle('privacy:selfTest', async () => {
    const sample = 'Hi, I\'m Jordan Ellis. Email me at jordan.ellis@example.com or call (404) 555-0182. My card ends 4242 4242 4242 4242 and I live at 18 Peachtree St, Atlanta.'
    const t0 = Date.now()
    const { spans } = await piiTracer.detect(sample, AbortSignal.timeout(60_000))
    return { sample, ms: Date.now() - t0, found: spans.map((s) => ({ label: s.label, text: sample.slice(s.start, s.end) })) }
  })
  // Check in the background at start when it's switched on (the model list waits for a stale check anyway).
  if (chatgptPlan.prefs().enabled) void chatgptPlan.refresh().then(() => endpoints.list()).catch(() => undefined)

  const grokPreferences = () => settings.get().grokPlan ?? { enabled: false, preferSubscriptions: true }
  grokPlan.configure(sub('grok-plan'), grokPreferences)
  const refreshGrok = async (force: boolean) => {
    const status = await grokPlan.refresh(force)
    if (force) await endpoints.list().catch(() => undefined)
    return status
  }
  handle('grokPlan:status', (refresh?: boolean) => refreshGrok(refresh === true))
  handle('grokPlan:configure', async (patch?: { enabled?: boolean; preferSubscriptions?: boolean }) => {
    const prefs = grokPreferences()
    settings.set({ grokPlan: {
      enabled: typeof patch?.enabled === 'boolean' ? patch.enabled : prefs.enabled,
      preferSubscriptions: typeof patch?.preferSubscriptions === 'boolean' ? patch.preferSubscriptions : prefs.preferSubscriptions
    } })
    return refreshGrok(true)
  })
  handle('grokPlan:signIn', () => grokPlan.signIn())
  handle('grokPlan:installInTerminal', async () => {
    const prefs = grokPreferences()
    if (!prefs.enabled) settings.set({ grokPlan: { ...prefs, enabled: true } })
    return grokPlan.installInTerminal()
  })
  handle('grokPlan:testChat', async () => { await grokPlan.refresh(true); return testSubscription(GROK_PLAN_URL, GROK_PLAN_MODEL) })
  handle('grokPlan:openInstallGuide', () => shell.openExternal(GROK_INSTALL_GUIDE))
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
    // FOREMAN_ANTHROPIC_URL: a local stand-in for Anthropic's API in hidden test runs (like FOREMAN_OPENAI_URL),
    // so first-run's "Connect Claude" check never reaches the real API.
    const alt = process.env.FOREMAN_ANTHROPIC_URL
    const url = alt && /(^|\.)anthropic\.com$/.test((() => { try { return new URL(baseUrl).hostname } catch { return '' } })()) ? alt : baseUrl
    const r = await providerModels('custom', 'Test', url, apiKey || settings.keyFor(baseUrl), settings.get().contextWindow || 32768)
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

  handle('spaces:list', () => db.listSpaces().map((space) => {
    const placement = placementOf(db, space.id)
    return placement ? { ...space, placement } : space
  }))
  handle('spaces:create', (input: { name?: string; color?: string; shape?: BotShape; kind?: 'bot' | 'group' | 'project'; members?: string[]; intro?: boolean; folder?: string }) => {
    const kind = input.kind ?? 'bot'
    const name = input.name?.trim() || (kind === 'group' ? 'Group chat' : kind === 'project' ? 'New project' : 'New Bot')
    if (kind === 'project') {
      // Only folders the user picked in this session can become project folders.
      if (!input.folder || !attachments.accept([input.folder]).length) throw new Error('Choose the project folder with the folder picker.')
      attachments.allow(input.folder)
    }
    const space = db.createSpace(name, input.color ?? pick(SPACE_COLORS.slice(2)), { kind, shape: input.shape ?? pick(SHAPES), members: input.members ?? [], folder: input.folder })
    // A new bot works at its Bot details level (Auto unless the user picked Ask); groups and projects keep the app default.
    const thread = db.createThread(space.id, kind === 'bot' ? botLevel(settings.get(), space) : 'auto', null)
    db.updateThread(thread.id, { title: name })
    if (kind === 'bot' && input.intro !== false) {
      // The new bot greets the user and asks what to focus on, then saves instructions for it (never a new name).
      const state = db.getState(thread.id)
      state.loaded = ['update_bot']
      db.setState(thread.id, state)
      chat.intro(thread.id, INTRO)
    }
    return { space, threadId: thread.id }
  })
  // A "New bot" that sets itself up with you in its chat (agent/tools/bots.ts SETUP_PROMPT, finish_setup). One at a
  // time: a bot still being set up is reopened instead of making another.
  handle('spaces:startSetup', () => {
    const waiting = db.listSpaces().find((x) => x.kind === 'bot' && !x.isMain && db.getSetting<boolean>(`setup:${x.id}`))
    if (waiting) {
      const t = [...db.listThreads(waiting.id)].sort((x, y) => y.updatedAt - x.updatedAt)[0] ?? db.createThread(waiting.id, botLevel(settings.get(), waiting), null)
      return { space: waiting, threadId: t.id }
    }
    const space = db.createSpace('New bot', pick(SPACE_COLORS.slice(2)), { kind: 'bot', shape: pick(SHAPES), members: [] })
    spaces.setPrompt(space.id, SETUP_PROMPT + '\n')
    db.setSetting(`setup:${space.id}`, true)
    const thread = db.createThread(space.id, botLevel(settings.get(), space), null)
    db.updateThread(thread.id, { title: 'New bot' })
    const hello = db.insertMessage({ threadId: thread.id, role: 'assistant', kind: 'normal', status: 'done', content: SETUP_GREETING })
    emit({ threadId: thread.id, type: 'message', message: hello })
    emit({ threadId: '', type: 'spaces' })
    return { space, threadId: thread.id }
  })
  handle('spaces:update', (id: string, patch: Partial<Pick<Space, 'name' | 'color' | 'shape' | 'pinned' | 'hidden' | 'members' | 'model' | 'label' | 'notify' | 'effort' | 'icon'>>) => {
    // A bot's model and thinking are never set per bot: it chooses by itself for each request (agent/choices.ts).
    const { model: _m, effort: _e, ...rest } = patch
    const s = db.updateSpace(id, rest)
    // Renamed by the user: a New bot being set up counts as set up.
    if (patch.name && db.getSetting<boolean>(`setup:${id}`)) db.setSetting(`setup:${id}`, false)
    // Keep a bot's one conversation titled after it.
    if (patch.name && s.kind === 'bot' && !s.isMain) for (const t of db.listThreads(id)) db.updateThread(t.id, { title: s.name })
    return s
  })
  handle('spaces:markUnread', (id: string) => {
    const t = db.listThreads(id)[0]
    if (t) emit({ threadId: t.id, type: 'thread', thread: db.markUnread(t.id) })
  })
  handle('spaces:remove', (id: string) => removeBot(id))
  handle('spaces:getPrompt', (id: string) => spaces.getPrompt(id))
  handle('spaces:setPrompt', (id: string, text: string) => {
    spaces.setPrompt(id, text)
    // Instructions written by the user: a New bot being set up counts as set up.
    if (db.getSetting<boolean>(`setup:${id}`)) db.setSetting(`setup:${id}`, false)
  })
  handle('spaces:promptPath', (id: string) => spaces.path(id))
  // Bot details → Library: files this bot made (that still exist) and links from its chats.
  handle('spaces:library', (id: string) => [...db.spaceLibrary(id).filter((x) => x.kind !== 'file' || (!!x.path && existsSync(x.path))), ...docs.libraryItems(id)].sort((a, b) => b.at - a.at))

  handle('threads:list', (spaceId?: string) => db.listThreads(spaceId))
  handle('threads:search', (q: string) => db.searchThreads(q))
  // New chats start at the bot's autonomy level, else the app default (never Bypass).
  handle('threads:create', (spaceId: string) => {
    const s = settings.get()
    const space = db.getSpace(spaceId)
    // An always-on bot without its own pick works at Auto; everything else keeps the app default.
    const m = space && isAlwaysOnBot(space) ? botLevel(s, space) : s.botModes?.[spaceId] ?? s.defaultMode
    return db.createThread(spaceId, isPermissionMode(m) && m !== 'bypass' ? m : 'auto', null)
  })
  handle('threads:update', (id: string, patch: Parameters<Db['updateThread']>[1]) => {
    // Bypass only once the user confirmed it (the one-time dialog saves advanced.allowBypass); a chat already in Bypass may stay there.
    if (patch && 'permissionMode' in patch && !modeChangeAllowed(patch.permissionMode, { allowBypass: settings.get().advanced.allowBypass, current: db.getThread(id)?.permissionMode })) {
      throw new Error(patch.permissionMode === 'bypass' ? 'Turn on Bypass from the Permissions menu first (it asks you to confirm once).' : `Unknown permission level "${String(patch.permissionMode)}".`)
    }
    // 'autonomous' is the old name of Auto.
    if (patch?.permissionMode === 'autonomous') patch = { ...patch, permissionMode: 'auto' }
    // Keep explicit Auto distinct from an unset effort, which inherits the app default.
    // A local model picked for this chat: load it while the user types.
    if (patch.model && warmupAllowed()) warmup.soon(patch.model)
    // "Mark as Unread" opens on a NEW divider at the bot's latest reply (Db.markUnread).
    if (patch?.unread === true) {
      const { unread: _u, ...rest } = patch
      db.markUnread(id)
      const t = Object.keys(rest).length ? db.updateThread(id, rest) : db.getThread(id)!
      emit({ threadId: id, type: 'thread', thread: t })
      return t
    }
    return db.updateThread(id, patch)
  })
  // Read state lives in the database, so the Mac app and the web UI agree: every window and paired browser
  // hears about it (a 'thread' event) and refreshes its sidebar.
  handle('threads:markRead', (id: string, upTo?: number) => {
    const before = db.getThread(id)
    if (!before) throw new Error('That chat no longer exists.')
    const t = db.markRead(id, typeof upTo === 'number' ? upTo : undefined)
    if (before.unread !== t.unread || before.lastReadAt !== t.lastReadAt) emit({ threadId: id, type: 'thread', thread: t })
    return t
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
    // A thumbs-down or thumbs-up on an Auto answer teaches Auto about that model on that kind of task (outcome-router.ts).
    chat.feedback(messageId, emoji)
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
    // Secrets typed into the composer never reach the model, the database or the logs as they are.
    {
      const g = guardUserText(input.threadId, input.text)
      if (g.offers.length) input = { ...input, text: g.text, meta: { ...(input.meta ?? {}), vaultOffers: g.offers } }
    }
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
  // A folder the user picked earlier this session (and only such a folder): the Folder chip's recent list.
  handle('attach:useFolder', (threadId: string, path: string) => {
    if (!db.getThread(String(threadId ?? ''))) throw new Error('That chat is gone.')
    const ok = attachments.accept([String(path ?? '')])
    if (!ok.length) throw new Error('Choose that folder again with "Work in a folder…".')
    return setWorkingFolder(String(threadId), ok[0])
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
  /** A new blank document, deck (a document of slides) or sheet. */
  const blankDoc = (kind: 'doc' | 'slides' | 'sheet' | 'dashboard'): { type: 'doc' | 'sheet'; content: Omit<import('@shared/types').DocContent, 'title'> } =>
    kind === 'sheet' ? { type: 'sheet', content: { blocks: [] } }
      : kind === 'slides' ? { type: 'doc', content: { kind: 'slides', blocks: [{ id: 'b000', type: 'h2', text: '' }, { id: 'b001', type: 'bullet', text: '' }] } }
        : kind === 'dashboard' ? { type: 'doc', content: { kind: 'dashboard', blocks: [{ id: 'b000', type: 'h2', text: 'Overview' }, { id: 'b001', type: 'bullet', text: '**$0** Revenue' }, { id: 'b002', type: 'bullet', text: '**0** Customers' }, { id: 'b003', type: 'h2', text: 'By month' }, { id: 'b004', type: 'table', header: true, rows: [['Month', 'Revenue'], ['Jan', '0'], ['Feb', '0'], ['Mar', '0']] }] } }
        : { type: 'doc', content: { blocks: [{ id: 'b000', type: 'p', text: '' }] } }
  handle('docs:create', (threadId: string, title: string, type?: 'doc' | 'sheet' | 'slides' | 'dashboard') => {
    const t = db.getThread(threadId)
    if (!t) throw new Error('Thread not found')
    const b = blankDoc(type ?? 'doc')
    return docs.create({ threadId, spaceId: t.spaceId, title: title || 'Untitled', type: b.type, content: b.content, author: 'user' })
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
  // Opening a file agents made (Artifacts, the preview) in the Document tab, and saving the edits back to it.
  const docSources = (): Record<string, string> => db.getSetting<Record<string, string>>('docs:sources') ?? {}
  handle('docs:importFile', async (path: string, threadId?: string) => {
    const p = String(path ?? '')
    // Only files SahilBot made or showed (never an arbitrary path from the window).
    const known = db.artifactFiles(1000).find((f) => f.path === p) ?? db.recentFiles(500).find((f) => f.path === p)
    if (!known || !existsSync(p)) throw new Error('Only files SahilBot made can be opened in the editor.')
    if (!isEditable(p)) throw new Error('This kind of file doesn\'t open in the editor yet.')
    const t = db.getThread(typeof threadId === 'string' && db.getThread(threadId) ? threadId : known.threadId)
    if (!t) throw new Error('The chat this file came from is gone.')
    const existing = Object.entries(docSources()).find(([id, src]) => src === p && (() => { try { return docs.get(id).threadId === t.id } catch { return false } })())
    if (existing) return { docId: existing[0], threadId: t.id }
    const imported = await importFile(p)
    const snap = docs.create({ threadId: t.id, spaceId: t.spaceId, title: imported.title, type: imported.type, content: imported.content, author: 'user' })
    db.setSetting('docs:sources', { ...docSources(), [snap.id]: p })
    return { docId: snap.id, threadId: t.id }
  })
  handle('docs:source', (id: string) => docSources()[String(id)] ?? null)
  handle('docs:recent', (limit?: number) => docs.recent(Number(limit) || 24))
  /** Make something new (Artifacts): a blank document, deck or sheet in its own new chat with SahilBot. */
  handle('docs:createNew', (kind: 'doc' | 'slides' | 'sheet' | 'dashboard') => {
    const main = db.listSpaces().find((s) => s.isMain)
    if (!main) throw new Error('SahilBot\'s main chat space is missing.')
    const title = kind === 'slides' ? 'Untitled deck' : kind === 'sheet' ? 'Untitled sheet' : kind === 'dashboard' ? 'Untitled dashboard' : 'Untitled document'
    const t = db.updateThread(db.createThread(main.id, 'auto', null).id, { title })
    const b = blankDoc(kind)
    const snap = docs.create({ threadId: t.id, spaceId: main.id, title, type: b.type, content: b.content, author: 'user' })
    emit({ threadId: t.id, type: 'thread' } as never)
    return { docId: snap.id, threadId: t.id }
  })
  /** Writes the document back over its file (a copy of the original goes to <folder>/.sahilbot-backups first), or next to it. */
  handle('docs:saveBack', async (id: string, mode: 'replace' | 'copy') => {
    const src = docSources()[String(id)]
    if (!src) throw new Error('This document wasn\'t opened from a file.')
    const format = saveFormat(src)
    const out = await exportDoc(docs.get(id), format, join(settings.get().workspaceDir, 'exports'), { name: basename(src) })
    let path = out
    if (mode === 'replace' && extname(src).toLowerCase() === `.${format}`) {
      if (existsSync(src)) {
        const backups = join(dirname(src), '.sahilbot-backups')
        mkdirSync(backups, { recursive: true })
        copyFileSync(src, join(backups, `${basename(src, extname(src))}-${new Date().toISOString().replace(/[:.]/g, '-')}${extname(src)}`))
      }
      copyFileSync(out, src)
      rmSync(out, { force: true })
      path = src
    }
    attachments.allow(path)
    return { path, replaced: path === src }
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
  // Home's starter tiles, from the user's own habits (request kinds, connected apps, files made, projects).
  handle('ideas:home', () => {
    const recent: TaskCategory[] = []
    for (const t of db.listThreads().slice(0, 30)) {
      const first = db.listMessages(t.id).find((m) => m.role === 'user' && !m.meta?.hidden && !m.meta?.scheduled && !m.meta?.fromApp && !m.meta?.mcpClientId && !m.meta?.handoff)
      if (first?.content.trim()) recent.push(classifyTask(first.content.slice(0, 2000)).category)
    }
    const st = new Map(connectors.statuses().map((x) => [x.id, x.state]))
    const apps = connectors.list().filter((c) => c.preset && st.get(c.id) === 'connected').map((c) => c.preset!)
    const made = db.recentFiles(20).map((f) => extname(f.path))
    const projects = memory.list().filter((m) => m.category === 'project' && m.provenance !== 'untrusted').sort((a, b) => b.updatedAt - a.updatedAt)
      .map((m) => m.content.replace(/^(?:the user(?:'s)?\s+|i(?:'m| am)\s+|currently\s+)?(?:is\s+)?(?:working on|building|project:?)\s+/i, '').split(/[,.;:(\u2014\u2013]|\s-\s/)[0].trim())
      .filter((p) => p.length <= 40)
    return homeIdeas({ recent, apps, made, projects }, 5)
  })
  handle('files:recent', (limit?: number) => db.recentFiles(limit ?? 60).filter((f) => existsSync(f.path)).map((f) => ({ ...f, name: basename(f.path), size: statSync(f.path).size })))
  // Artifacts (sidebar): everything agents made, including images and audio, that still exists.
  handle('files:artifacts', (limit?: number) => db.artifactFiles(Math.min(1000, limit ?? 300)).filter((f) => !SOURCE_FILE.test(f.path) && !/\/(node_modules|\.git|dist|build|out)\//.test(f.path)).filter((f) => { try { return statSync(f.path).isFile() } catch { return false } }).map((f) => ({ ...f, name: basename(f.path), size: statSync(f.path).size })))
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
  handle('connectors:presets', () => connectors.presets())
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
  handle('connectors:useBuiltinClient', (id: string) => connectors.useBuiltinClient(id))
  handle('connectors:clearApiKey', (id: string) => connectors.clearApiKey(id))
  // "Paste key": the clipboard is read here, only when the user clicks; its text never goes back to the window.
  handle('connectors:pasteApiKey', (presetId: string) => connectors.pasteApiKey(presetId, () => clipboard.readText()))
  // Connect apps → Google (three ways); the app password goes straight to the Keychain, only the link comes back.
  // Mail is asked about its accounts only from the Google panel, and never in hidden (test) runs: no Automation prompt on screen.
  handle('google:status', (withMail?: boolean) => googleConnect.status({ mail: !!withMail && !HIDDEN }))
  handle('google:useMail', (address: string) => googleConnect.useMail(address))
  handle('google:useAppPassword', (address: string, password: string) => googleConnect.useAppPassword(address, password))
  handle('google:useOauth', () => googleConnect.useOauth())
  handle('google:disconnect', () => googleConnect.disconnect())
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
    // The bot is busy (you're working with it, or another routine is running): the routine waits its turn instead of
    // being skipped, then runs as itself (unattended, with a routine's permissions), never mixed into your live run.
    // It stops waiting if you pause routines or this one, delete it, or after two hours.
    const until = Date.now() + (info.test ? 60_000 : 2 * 3600_000)
    while ((chat.isRunning(threadId) || scheduledRuns.has(threadId)) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 5000))
      const cur = scheduler.get(task.id)
      // A one-time reminder is switched off the moment it fires (it won't come again), so only deleting it or
      // pausing routines stops it waiting; a busy chat never drops it.
      if (!info.test && (!cur || (!cur.enabled && cur.schedule.type !== 'once') || scheduler.paused())) return { status: 'skipped: paused or removed while it waited for the chat', threadId }
    }
    if (chat.isRunning(threadId) || scheduledRuns.has(threadId)) return { status: 'skipped: the chat stayed busy for two hours', threadId }
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
    // What the routine did goes in the bot's work log (memory), so its next run, the bot's chats and the other bots
    // can build on it without being told again. The work log keeps only the most recent entries per bot.
    const gist = (last?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 220)
    // (A bare "Done." says nothing worth keeping.)
    if (status === 'finished' && gist.length >= 24 && !/^(done|ok(ay)?|finished|all set|nothing (new|to report))\b[.!]?$/i.test(gist) && !info.test) {
      try {
        // Built from web pages, email or another app's output: kept as outside content, never a trusted fact.
        const tainted = after.some((m) => m.role === 'tool' && m.meta?.untrusted)
        memory.save(`${new Date().toISOString().slice(0, 10)}: routine "${task.title.replace(/^⏰\s*/, '')}" ran → ${gist}`, 'worklog', space.isMain ? null : space.id, 'chat', tainted ? 'untrusted' : 'trusted')
      } catch { /* the routine's result stands without the log entry */ }
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
  scheduler.available = (id) => !placementBlock(db, id)
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
    const routine = scheduler.get(id)
    if (!routine) throw new Error('That routine no longer exists.')
    const location = placementBlock(db, routine.spaceId)
    if (location) throw new Error(location)
    scheduler.test(id)
  })

  /** Deletes a bot: its chats stop, its jobs stop, and groups drop it (the sidebar menu, its profile, or asking). */
  function removeBot(id: string): void {
    if (db.getSpace(id)?.isMain) throw new Error("The main bot can't be deleted.")
    if (!isServer() && placementOf(db, id)) throw new Error('Move this bot back to this Mac before deleting its local profile.')
    for (const t of db.listThreads(id)) chat.stop(t.id)
    // Background jobs belong to the bot's chats: they stop with it.
    void jobs.stopThreads(db.listThreads(id).map((t) => t.id))
    db.deleteSpace(id)
    for (const g of db.listSpaces().filter((x) => x.kind === 'group' && x.members.includes(id))) db.updateSpace(g.id, { members: g.members.filter((m) => m !== id) })
  }

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
    postAssistant: (threadId, text, meta) => { db.insertMessage({ threadId, role: 'assistant', content: text, kind: 'normal', status: 'done', ...(meta ? { meta } : {}) }) },
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

  // Each bot's status for its row and card (shared/bot-status.ts): running → Pulling context / Working (from
  // the turn's tool calls so far), an unread reply → Done, else Idle; plus the model its last reply ran on.
  handle('bots:status', () => {
    const out: BotStatusMap = {}
    const running = new Set(chat.runningThreads())
    const recent = db.sql.prepare(`SELECT data, created_at AS at FROM messages WHERE thread_id = ? AND role = 'assistant' AND kind = 'normal' ORDER BY seq DESC LIMIT 25`)
    for (const s of db.listSpaces()) {
      if (s.kind === 'project') continue
      const threads = db.listThreads(s.id)
      const live = threads.filter((t) => running.has(t.id))
      const phase = live.length ? (live.some((t) => runPhase(db.listMessages(t.id).slice(-80)) === 'working') ? 'working' : 'context') : undefined
      const st: BotStatus = { state: botState({ running: live.length > 0, phase, unread: !!s.unread }) }
      // The newest reply that names its model, from the bot's most recently active chats.
      let found: { model: string; label?: string; at: number } | null = null
      for (const t of [...threads].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4)) {
        for (const r of recent.all(t.id) as Array<{ data: string; at: number }>) {
          try {
            const d = JSON.parse(r.data) as { model?: string; meta?: { routed?: { label?: string } } }
            if (d.model && (!found || r.at > found.at)) { found = { model: d.model, label: d.meta?.routed?.label, at: r.at }; break }
            if (d.model) break
          } catch { /* skip */ }
        }
      }
      if (found) {
        let provider: string | undefined
        try { provider = endpoints.for(found.model).provider } catch { provider = undefined }
        Object.assign(st, { model: found.model, provider, runsOn: runsOnLabel(provider, found.model, found.label), at: found.at })
      }
      out[s.id] = st
    }
    return out
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
    paused: () => !!settings.get().routinesPaused,
    available: (id) => !placementBlock(db, id)
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
  try { migrateBotAutonomy(db, settings.get()) } catch (e) { console.error('[autonomy]', (e as Error).message) }
  // Three permission levels (Ask / Auto / Bypass): 'autonomous' becomes Auto, and Auto chats lose a stale thinking level, once.
  try { migratePermissionLevels(db, settings.get(), (p) => settings.set(p)) } catch (e) { console.error('[levels]', (e as Error).message) }
  // Bots choose their own model and thinking (Auto for every request): stored overrides are cleared once.
  try { migrateBotModelEffort(db) } catch (e) { console.error('[bot-auto]', (e as Error).message) }
  // Each bot's Swarm setting became its Max setting (Off / Auto / Always, Max helpers).
  try { const next = migrateBotMax(settings.get()); if (next) settings.set({ botMax: next }) } catch (e) { console.error('[bot-max]', (e as Error).message) }
  // Strategy is now inferred per request. Preserve resource caps while retiring old per-bot modes.
  if (!db.getSetting('agent:automatic-strategy-v1')) {
    const current = settings.get()
    const automatic = (all: typeof current.botMax) => Object.fromEntries(Object.entries(all ?? {}).map(([id, cfg]) => [id, { ...cfg, mode: 'auto' as const }]))
    settings.set({ botMax: automatic(current.botMax), botSwarm: automatic(current.botSwarm) })
    db.setSetting('agent:automatic-strategy-v1', true)
  }
  /** Cards open in running chats right now, as inbox items (answered through chat:respond). */
  const liveNeedsYou = (): NeedsYouItem[] => {
    const out: NeedsYouItem[] = []
    for (const [threadId, ids] of Object.entries(chat.allPending())) {
      const t = db.getThread(threadId)
      if (!t || quickRuns.has(threadId)) continue
      for (const r of chat.pending(threadId)) {
        if (!ids.includes(r.id)) continue
        const base = { id: `live:${threadId}:${r.id}`, source: 'live' as const, botId: t.spaceId, botName: botName(t.spaceId), threadId, status: 'open' as const, createdAt: t.updatedAt ?? Date.now() }
        if (r.kind === 'approval' && !r.spend) out.push({ ...base, kind: 'approval', approval: { tool: r.tool ?? '', label: r.label ?? r.tool ?? 'Action', ...(r.summary ? { summary: needsYouText(r) } : {}), ...(r.reason ? { reason: r.reason } : {}), ...(r.folder ? { folder: r.folder } : {}) } })
        else if (r.kind === 'question') out.push({ ...base, kind: 'question', questions: [{ question: r.question ?? '', ...(r.options?.length ? { options: r.options } : {}) }] })
        else if (r.kind === 'questions') out.push({ ...base, kind: 'question', questions: (r.questions ?? []).map((q) => ({ question: q.question, ...(q.options?.length ? { options: q.options } : {}) })) })
        else out.push({ ...base, kind: 'other', approval: { tool: r.tool ?? r.kind, label: r.label ?? (r.kind === 'plan' ? 'Plan' : r.kind === 'connect' ? 'Connect an app' : 'Waiting for you'), summary: needsYouText(r) } })
      }
    }
    return out
  }
  /** The main bot, which Agent mode's prompts belong to. */
  const mainBot = (): { id: string; name: string } => { const m = db.listSpaces().find((x) => x.isMain); return { id: m?.id ?? '', name: m?.name ?? 'SahilBot' } }
  handle('needsYou:list', () => [...liveNeedsYou(), ...(brainRef.current?.needsYou(mainBot()) ?? []), ...questions.inbox()])
  handle('needsYou:answer', async (id: string, answer: string[] | 'approve' | 'always' | 'deny') => {
    const ref = String(id ?? '')
    // Agent mode's prompts: [action, typed answer?] (Draft it starts a normal chat run; nothing is ever sent on its own).
    if (ref.startsWith('brain:')) {
      const b = brainRef.current
      if (!b) throw new Error('SahilBot is still starting.')
      const [action, text] = Array.isArray(answer) ? answer.map((a) => String(a ?? '')) : [answer === 'deny' ? 'dismiss' : 'draft']
      if (!['draft', 'remind', 'dismiss', 'answer', 'open'].includes(action)) throw new Error('Unknown action.')
      const r = await b.act(ref.slice('brain:'.length), action as 'draft', text)
      if (r.threadId && (action === 'draft' || action === 'open')) openThread(r.threadId)
      return null
    }
    if (ref.startsWith('live:')) {
      const [, threadId, reqId] = ref.split(':')
      const r = chat.pending(threadId).find((x) => x.id === reqId)
      if (!r) return null
      const list = Array.isArray(answer) ? answer.map((a) => String(a ?? '')) : []
      if (r.kind === 'approval' && !r.spend) chat.respond(threadId, reqId, answer === 'approve' ? 'once' : answer === 'always' ? 'always' : 'deny')
      else if (r.kind === 'question') chat.respond(threadId, reqId, list[0] ?? (answer === 'approve' ? 'Yes' : 'No'))
      else if (r.kind === 'questions') chat.respond(threadId, reqId, JSON.stringify(list))
      else throw new Error('Open the chat to answer this one.')
      return null
    }
    // "Always allow in <folder>" on a queued approval: the folder joins that chat's folders, then it runs.
    if (answer === 'always') {
      const queued = questions.inbox().find((x) => x.id === ref)
      if (queued?.approval?.folder) {
        const st = db.getState(queued.threadId)
        st.roots = [...new Set([...(st.roots ?? []), queued.approval.folder])]
        db.setState(queued.threadId, st)
      }
    }
    const item = await questions.answer(ref, Array.isArray(answer) ? answer.map((a) => String(a ?? '')) : answer === 'approve' || answer === 'always' ? 'approve' : 'deny')
    return item ? toNeedsYou(item, botName(item.botId)) : null
  })
  handle('needsYou:reviewed', (id: string) => questions.reviewed(String(id)))
  // Bot details → Autonomy: saved for the bot's new chats, and applied to its own conversations now.
  handle('botAutonomy:setLevel', (spaceId: string, picked: PermissionMode) => {
    // A bot's own level is Ask or Auto ('autonomous' is Auto's old name); Bypass is per chat only.
    const level: PermissionMode | null = picked === 'autonomous' ? 'auto' : picked === 'ask' || picked === 'auto' ? picked : null
    if (!level) throw new Error(`Unknown permission level "${String(picked)}".`)
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
    return [{ id: m.id, label: m.label || m.id, provider: sup.provider, factor: sup.factor, ...(sup.ultrafast ? { ultrafast: sup.ultrafast } : {}), tradeoff: fastTradeoff(m.id) ?? '', options: speedOptions(m.id) ?? [], enabled: m.enabled !== false, ...(sup.note ? { note: sup.note } : {}) }]
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
  // Sources: the workspace, every project's folder, folders added in Settings → Advanced → Knowledge folders, and attached
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
  // unless SAHILBOT_LEARNING=1. Everything it learns is in Settings → Memory → Learned, with Undo.
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
  registry.register(vaultTool({ vault: notesVault, db, exportDir: () => join(homedir(), 'Downloads'), secretValues: () => [...vault.secretValues(), ...browser.hiddenValues()] }))

  // ---------------------------------------------------------------- the context engine (src/main/context-engine, docs/context.md)
  // An entity graph of the user's world (people, places, organizations, events, dates, things…) built by
  // the idle learning pass from chats, files, connector results and connected apps' metadata and
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
    onChange: () => { if (!worldNotify) worldNotify = setTimeout(() => { worldNotify = null; toWin('people:changed') }, 400) },
    metaCovered: (preset) => brainRef.current?.covers(preset) ?? false
  })
  worldRef.current = world
  registry.register(aboutTool({ engine: world, db }))

  // Memories and the user's decisions, mirrored into the knowledge vault (Shared/Memory, Shared/Decisions/Decision
  // log; src/main/vault/memory-mirror.ts): after every change (debounced), once at startup, and every few minutes.
  const memoryMirror = new MemoryMirror({
    vault: notesVault, memory, db,
    screen: (text) => world.screenMemory(text),
    secretValues: () => { try { return [...vault.secretValues(), ...browser.hiddenValues()] } catch { return [] } }
  })
  memory.onChange(() => memoryMirror.schedule())
  memoryMirror.schedule(HIDDEN ? 500 : 15_000)
  const memoryMirrorTimer = setInterval(() => memoryMirror.schedule(0), 5 * 60_000)
  memoryMirrorTimer.unref?.()
  app.on('before-quit', () => { memoryMirror.stop(); clearInterval(memoryMirrorTimer) })
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
  handle('notesVault:setSettings', (patch: Record<string, unknown>) => { notesVault.setSettings((patch ?? {}) as never); memoryMirror.schedule(0); return notesVault.status() })
  handle('notesVault:setBot', (spaceId: string, patch: { enabled?: boolean | null; level?: 'normal' | 'aggressive' | null }) => {
    if (!db.getSpace(String(spaceId ?? ''))) throw new Error('That bot is gone.')
    notesVault.setBot(String(spaceId), patch ?? {})
    memoryMirror.schedule(0)
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
    if (!HIDDEN) shell.showItemInFolder(rel ? notesVault.absOf(rel) : notesVault.store.root)
    return 'finder'
  })
  handle('notesVault:reveal', (path?: string) => {
    notesVault.store.ensure()
    if (!HIDDEN) shell.showItemInFolder(typeof path === 'string' && path ? notesVault.absOf(path) : notesVault.store.root)
  })
  // "Use my Obsidian vault" (src/main/vault/obsidian.ts): pick the vault, read the user's own notes, copy SahilBot's notes in.
  handle('notesVault:obsidianDetect', () => notesVault.detectObsidian())
  handle('notesVault:obsidianPick', async () => {
    const r = win ? await dialog.showOpenDialog(win, { title: 'Choose your Obsidian vault', properties: ['openDirectory'] }) : { canceled: true, filePaths: [] }
    if (r.canceled || !r.filePaths[0]) return null
    return notesVault.allowObsidianFolder(r.filePaths[0])
  })
  handle('notesVault:obsidianNotes', () => notesVault.obsidianNotes())
  handle('notesVault:obsidianCopyExisting', () => notesVault.copyExisting())
  handle('notesVault:obsidianRescan', () => { notesVault.obsidianSync.rescan(); return notesVault.status() })
  // Edits made in Obsidian: a watcher, a timer, and a look whenever SahilBot's window gets focus.
  notesVault.startSync()
  app.on('browser-window-focus', () => notesVault.obsidianSync.poke())
  app.on('before-quit', () => notesVault.stopSync())
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
  // (The brain, set up below, stops with it: one listener for both.)
  app.on('before-quit', () => { learning.dispose(); brainRef.current?.dispose(); clearInterval(brainPowerTimer.current) })
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

  // ---------------------------------------------------------------- your brain (src/main/brain)
  // Reads new items from the user's connected accounts on a schedule (only while SahilBot is open and the
  // Mac awake, ~15 min while active, hourly when idle, paused on a low battery / Low Power Mode / a tight
  // budget), extracts facts on the cheapest capable model into the entity graph, writes "Written for you"
  // briefs, and in Agent mode reaches out with a few prompts in Needs you. Tests (dev builds) can stand in
  // fake connected apps with SAHILBOT_BRAIN_FIXTURE.
  const brainFixture = !isPackaged() && process.env.SAHILBOT_BRAIN_FIXTURE ? fixtureConnectors(process.env.SAHILBOT_BRAIN_FIXTURE) : null
  const brainIO = brainFixture ? { connectors: brainFixture } : liveIO({
    connectors,
    gmailCreds: () => { try { return googleConnect.credentials() } catch { return null } },
    mail: mailRunner(),
    mailConfigured: () => connectors.list().some((c) => c.preset === 'apple-mail')
  })
  let brainNotify: ReturnType<typeof setTimeout> | null = null
  let power: PowerState = { onBattery: false }
  const refreshPower = (): void => { void readPower(() => { try { return powerMonitor.isOnBatteryPower() } catch { return false } }).then((p) => { power = p }).catch(() => undefined) }
  refreshPower()
  brainPowerTimer.current = setInterval(refreshPower, 5 * 60_000)
  brainPowerTimer.current.unref?.()
  const brain = new BrainService({
    db, world, memory, vault: () => notesVault,
    io: () => brainIO,
    models: () => endpoints.usable(),
    endpoint: (m) => endpoints.for(m),
    isLocal: (m) => isLocal(endpoints.for(m).baseUrl),
    app: () => { const s = settings.get(); const b = budget.summary(); return { localAllowed: localOn(s), me: [...(s.me?.emails ?? [])], mode: b.mode, cap: b.cap, spent: b.spent } },
    power: () => power,
    // Test runs can fix how long the Mac has been idle (otherwise it depends on whoever is at the keyboard).
    idleMs: () => { if (HIDDEN && process.env.FOREMAN_IDLE_MS) return Number(process.env.FOREMAN_IDLE_MS); try { return powerMonitor.getSystemIdleTime() * 1000 } catch { return 0 } },
    secretValues: () => [...vault.secretValues(), ...browser.hiddenValues()],
    // Draft it: a new chat with the main bot at its usual level (Auto by default), the user's click as the request.
    startRun: async (o) => {
      const main = db.listSpaces().find((x) => x.isMain)
      if (!main) throw new Error('No main bot.')
      const s = settings.get()
      const m = s.botModes?.[main.id] ?? s.defaultMode
      const t = db.createThread(main.id, isPermissionMode(m) && m !== 'bypass' ? m : 'auto', null)
      emit({ threadId: t.id, type: 'thread', thread: db.updateThread(t.id, { title: o.title }) })
      await chat.send({ threadId: t.id, text: o.text, note: o.note, meta: { brainPrompt: o.promptId } })
      return { threadId: t.id }
    },
    notify: (p) => {
      const title = p.kind === 'gap' ? 'SahilBot has a question' : 'SahilBot can help'
      const body = p.text.replace(/\s+/g, ' ').slice(0, 160)
      notifyQuestionDevices({ kind: 'question', title, body, botId: mainBot().id, itemId: `brain:${p.id}` })
      if (QUIET || !Notification.isSupported() || mainFocused()) return
      const n = new Notification({ title, body, silent: false })
      n.on('click', () => { showMain(); toWin('menu', 'needs-you') })
      notes.push(n)
      if (notes.length > 30) notes.shift()
      n.show()
    },
    openLink: (link) => {
      if (HIDDEN) return
      const t = /^sahilbot:\/\/thread\/([\w-]+)$/.exec(link)
      if (t) { if (db.getThread(t[1])) openThread(t[1]); return }
      void shell.openExternal(link)
    },
    onChange: () => {
      if (brainNotify) return
      brainNotify = setTimeout(() => { brainNotify = null; toWin('brain:changed'); toWin('needsYou:changed') }, 250)
    }
  })
  brainRef.current = brain
  if (process.env.SAHILBOT_BRAIN !== '0' && (!HIDDEN || process.env.SAHILBOT_BRAIN === '1')) brain.start()
  powerMonitor.on('suspend', () => brain.sleep(true))
  powerMonitor.on('resume', () => brain.sleep(false))
  handle('brain:status', () => brain.status())
  handle('brain:setSettings', (patch: Record<string, unknown>) => { brain.setSettings((patch ?? {}) as never); return brain.status() })
  handle('brain:refresh', () => brain.refresh())
  handle('brain:briefs', (o?: { query?: string; filter?: string }) => brain.briefs({ query: typeof o?.query === 'string' ? o.query.slice(0, 200) : undefined, filter: o?.filter === 'clients' || o?.filter === 'people' || o?.filter === 'projects' ? o.filter : 'all' }))
  handle('brain:correct', (id: string, text: string) => brain.correct(String(id ?? ''), String(text ?? '')))
  handle('brain:forget', (id: string) => brain.forget(String(id ?? '')))
  handle('brain:undo', (trashId: string) => brain.undo(String(trashId ?? '')))
  handle('brain:backfill', (id: string, ok: boolean) => brain.backfill(String(id ?? ''), ok === true))
  handle('brain:forgetSource', (id: string) => brain.forgetSource(String(id ?? '')))
  handle('brain:openChip', (chip: { link?: string }) => brain.openChip(chip as never))
  handle('brain:prompts', () => brain.prompts())
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
    transcribe: (file, prompt, signal, language) => {
      const c = apiAccess(settings).openai()
      if (!c) throw new Error('No OpenAI key is saved for voice input.')
      return openaiTranscribe(c, { model: DEFAULT_TRANSCRIBE_MODEL, file, prompt, language }, signal)
    },
    guard: (seconds) => hookSpend.beforeUsd(OPENAI_URL, DEFAULT_TRANSCRIBE_MODEL, transcribeUsd(DEFAULT_TRANSCRIBE_MODEL, undefined, seconds) * 1.5),
    charged: (seconds, t) => hookSpend.afterUsd(OPENAI_URL, DEFAULT_TRANSCRIBE_MODEL, transcribeUsd(DEFAULT_TRANSCRIBE_MODEL, t as never, seconds))
  })
  const grokAudio = grokSpeech({
    credentials: () => apiAccess(settings).xai(),
    before: (model, usd) => hookSpend.beforeUsd(XAI_URL, model, usd),
    after: (model, usd) => hookSpend.afterUsd(XAI_URL, model, usd)
  })
  const voice = new VoiceService({
    output: () => {
      const s = settings.get()
      const keys = apiAccess(settings)
      const selected = connectedVoice(voicePreference(s), { openai: !!keys.openai(), xai: !!keys.xai() })
      const openaiOk = selected === 'openai'
      return { localOn: localOn(s) && !selected, xai: selected === 'xai' ? grokAudio : undefined, openai: openaiOk ? openaiVoice : null, openaiStt: openaiOk ? openaiEars : null, spendingNone: spendingMode(s) === 'none' }
    },
    // Local speech needs both switches. A selected cloud voice never starts Whisper.
    input: () => {
      const v = settings.get().voiceInput
      return { local: localOn(settings.get()) && v?.local === true && voicePreference(settings.get()) === 'off', choice: v?.model ?? 'auto', bench: (v?.bench as never) ?? null, hw: { ramGB: Number(process.env.FOREMAN_RAM_GB) || totalmem() / 1024 ** 3, appleSilicon: process.arch === 'arm64' } }
    },
    saveBench: (b) => { settings.set({ voiceInput: { ...settings.get().voiceInput, bench: b } }) },
    // The one-time benchmark's sentence, in the Mac's own voice (no download).
    speechSample: () => new Promise((resolve) => {
      const dir = mkdtempSync(join(tmpdir(), 'sahilbot-bench-'))
      execFile('say', ['-o', join(dir, 'a.aiff'), 'Remind me to call Priya tomorrow at noon about the quarterly report.'], (e1) => {
        if (e1) { rmSync(dir, { recursive: true, force: true }); return resolve(null) }
        execFile('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', join(dir, 'a.aiff'), join(dir, 'a.wav')], (e2) => {
          try { resolve(e2 ? null : fromWav(readFileSync(join(dir, 'a.wav'))).samples) } catch { resolve(null) } finally { rmSync(dir, { recursive: true, force: true }) }
        })
      })
    }),
    // Grok Voice 3.0, live: when the voice is Grok and an xAI key is saved, and spending is allowed. Test runs use it
    // only against a stand-in server (SAHILBOT_GROK_LIVE_URL), never the real one.
    live: () => {
      const s = settings.get()
      const keys = apiAccess(settings)
      if (connectedVoice(voicePreference(s), { openai: !!keys.openai(), xai: !!keys.xai() }) !== 'xai' || spendingMode(s) === 'none') return null
      if (HIDDEN && !process.env.SAHILBOT_GROK_LIVE_URL) return null
      const creds = keys.xai()
      if (!creds) return null
      try { hookSpend.beforeUsd(XAI_URL, GROK_VOICE_MODEL, GROK_VOICE_USD_PER_MIN * 5) } catch { return null }
      const thread = voiceThread ? db.getThread(voiceThread) : undefined
      const bot = thread ? db.getSpace(thread.spaceId) : undefined
      return {
        apiKey: creds.apiKey,
        baseUrl: process.env.SAHILBOT_GROK_LIVE_URL || creds.baseUrl,
        instructions: grokVoiceInstructions({ botName: bot?.name ?? 'SahilBot', userName: s.profile?.firstName || s.userName }),
        voice: s.voiceStyle?.voices?.xai
      }
    },
    liveCharged: (usd) => hookSpend.afterUsd(XAI_URL, GROK_VOICE_MODEL, usd),
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
      chat.send({ threadId: tid, text, voice: true, meta: { voice: true } }).catch((err: Error) => { off(); reject(err) })
    })
  }, { download: HIDDEN ? 'stub' : 'real' })
  // Speech recognition downloads itself in the background once set up (never in test runs: 'stub').
  voicePrepRef.current = (why) => void voice.prepare(why)
  if (settings.get().onboarded) setTimeout(() => voicePrepRef.current('auto'), HIDDEN ? 300 : 20_000).unref?.()
  handle('voice:openNative', async () => {
    const site = nativeVoiceSite(voicePreference(settings.get()))
    if (!site) return false
    await shell.openExternal(site)
    return true
  })
  handle('voice:status', () => voice.status())
  handle('voice:download', (kind: 'whisper' | 'vad' | 'kokoro') => voice.download(kind))
  handle('voice:setVoice', (v: string) => voice.setVoice(v))
  // The voice bar's voice, speed and language (Settings.voiceStyle), applied to the conversation in progress too.
  voice.setStyle(settings.get().voiceStyle ?? {})
  const voiceBarOptions = (): VoiceBarOptions => {
    const keys = apiAccess(settings)
    const ready = { openai: !!keys.openai(), xai: !!keys.xai() }
    const provider = connectedVoice(voicePreference(settings.get()), ready) ?? null
    return { ...voice.options(), providers: [{ id: 'xai', label: 'Grok', ready: ready.xai }, { id: 'openai', label: 'ChatGPT', ready: ready.openai }], provider }
  }
  handle('voice:options', () => voiceBarOptions())
  handle('voice:setStyle', (patch: { voice?: string; speed?: number; language?: string; provider?: 'openai' | 'xai' }) => {
    // ChatGPT's or Grok's voice: kept as the Voice choice in Settings, used from the next sentence.
    if (patch?.provider === 'openai' || patch?.provider === 'xai') {
      const keys = apiAccess(settings)
      if (!(patch.provider === 'openai' ? keys.openai() : keys.xai())) throw new Error(`Add your ${patch.provider === 'openai' ? 'OpenAI' : 'xAI'} key in Settings → Models & Keys to use ${patch.provider === 'openai' ? 'ChatGPT' : 'Grok'}'s voice.`)
      settings.set({ voiceOutput: { ...settings.get().voiceOutput, provider: patch.provider } })
      voice.useEngineNow()
    }
    const cur = settings.get().voiceStyle ?? {}
    const o = voice.options()
    const next: VoiceStyle = {
      ...cur,
      ...(typeof patch?.speed === 'number' ? { speed: clampSpeed(patch.speed) } : {}),
      ...(typeof patch?.language === 'string' && LANGUAGES.some((l) => l.id === patch.language) ? { language: patch.language } : {}),
      ...(typeof patch?.voice === 'string' && o.voices.some((v) => v.id === patch.voice) ? { voices: { ...cur.voices, [o.engine]: patch.voice } } : {})
    }
    settings.set({ voiceStyle: next })
    voice.setStyle(next)
    return voiceBarOptions()
  })
  handle('voice:preview', (id: string) => voice.preview(String(id ?? '')))
  // A voice conversation happens in the chat you're in. When it ends it's folded into one named line
  // ("Find the cheapest flight to Lisbon · 0:51"), and what you said goes to memory like anything you type.
  let voiceSession: { threadId: string; startedAt: number; created: boolean } | null = null
  const endVoiceSession = async (): Promise<void> => {
    const s = voiceSession
    voiceSession = null
    if (!s || !db.getThread(s.threadId)) return
    voiceWork.prune(s.threadId)
    // The reply that was cut off lands first, so the folded line comes after the whole conversation.
    await chat.handoffHost().whenIdle(s.threadId, AbortSignal.timeout(6000), 5000).catch(() => undefined)
    const said = db.listMessages(s.threadId).filter((m) => m.createdAt >= s.startedAt && m.role === 'user' && m.kind === 'normal' && !m.meta?.hidden && !isRelayed(m) && !!m.content.trim()).map((m) => m.content)
    if (!said.length) return
    const endedAt = Date.now()
    const title = voiceTitle(said)
    const session: VoiceSession = { startedAt: s.startedAt, endedAt, title, seconds: Math.max(1, Math.round((endedAt - s.startedAt) / 1000)) }
    const n = db.insertMessage({ threadId: s.threadId, role: 'assistant', kind: 'notice', status: 'done', content: `Voice chat: ${title}`, meta: { voiceSession: session } })
    emit({ threadId: s.threadId, type: 'message', message: n })
    const t = db.getThread(s.threadId)
    if (t && (s.created || /^Voice chat · /.test(t.title) || t.title === 'New thread')) emit({ threadId: t.id, type: 'thread', thread: db.updateThread(t.id, { title }) })
    try { if (learning.enabled()) void learning.extractMemories().catch(() => undefined) } catch { /* learning is off or busy: the next pass reads it */ }
  }
  handle('voice:start', async (threadId: string | null, spaceId: string) => {
    await voice.startVoice()
    const created = !threadId
    if (!threadId) {
      const t = db.createThread(spaceId, 'auto', null)
      db.updateThread(t.id, { title: `Voice chat · ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` })
      threadId = t.id
    }
    if (voiceSession && voiceSession.threadId !== threadId) void endVoiceSession()
    if (!voiceSession) voiceSession = { threadId, startedAt: Date.now(), created }
    voiceThread = threadId
    return threadId
  })
  handle('voice:stop', () => { voice.stop(); voiceThread = null; void endVoiceSession() })
  // Work started from a voice chat (voice/work.ts): a full run in its own chat while the conversation goes
  // on; said aloud in the next pause when it finishes or needs you, if the voice chat is still open.
  const voiceWork = new VoiceWork({
    announce: (text) => voice.announce(text),
    voiceThread: () => voiceThread,
    lastReply: (threadId, since) => [...db.listMessages(threadId)].reverse().find((m) => m.role === 'assistant' && m.kind === 'normal' && !!m.content && !m.meta?.superseded && !m.meta?.hidden && m.createdAt >= since)?.content,
    files: (threadId, since) => [...new Set(db.listMessages(threadId).filter((m) => m.role === 'tool' && m.createdAt >= since && (m.toolName === 'file_write' || m.toolName === 'file_edit' || m.toolName === 'create_document') && m.meta?.status === 'ok' && typeof m.meta?.path === 'string' && !/\.html?$/i.test(m.meta.path as string)).map((m) => m.meta!.path as string))],
    record: (vt, line, context, result) => {
      if (!db.getThread(vt)) return
      // Done: the result itself, with its files, from that bot (a notice: kept out of the model's history, which
      // gets the hidden context below instead).
      const m = result
        ? db.insertMessage({ threadId: vt, role: 'assistant', content: result.text, kind: 'notice', status: 'done', meta: { voiceResult: { bot: result.bot, title: result.title, threadId: result.threadId, files: result.files } } })
        : db.insertMessage({ threadId: vt, role: 'assistant', content: line, kind: 'notice', status: 'done' })
      emit({ threadId: vt, type: 'message', message: m })
      // The result as context for follow-ups; while the voice chat is answering, it waits for that turn to end
      // (never between a tool call and its result).
      const note = `[From the app] ${context}`
      if (chat.handoffHost().isRunning(vt)) voiceNotes.set(vt, [...(voiceNotes.get(vt) ?? []), note])
      else db.insertMessage({ threadId: vt, role: 'user', kind: 'normal', status: 'done', content: note, meta: voiceNoteMeta(result?.bot) })
    },
    changed: (tasks) => toWin('voice:event', { type: 'tasks', tasks })
  })
  const voiceNotes = new Map<string, string[]>()
  // Another run's work (it may have read web pages or email): relayed, so it's untrusted text in the voice chat,
  // never the user's words.
  function voiceNoteMeta(bot?: string): Record<string, unknown> { return { hidden: true, handoff: true, from: `${bot ?? 'A bot'} (background work)` } }
  listeners.add((e) => {
    voiceWork.onEvent(e)
    if (e.type === 'run' && e.status !== 'started' && voiceNotes.has(e.threadId)) {
      for (const note of voiceNotes.get(e.threadId) ?? []) db.insertMessage({ threadId: e.threadId, role: 'user', kind: 'normal', status: 'done', content: note, meta: voiceNoteMeta() })
      voiceNotes.delete(e.threadId)
    }
  })
  registry.register(startWorkTool(() => ({
    running: () => voiceWork.running(),
    start: async ({ fromThreadId, task, title, bot }) => {
      const from = db.getThread(fromThreadId)
      if (!from) throw new Error('The voice chat is gone.')
      const home = db.getSpace(from.spaceId)
      const bots = db.listSpaces().filter((s) => s.kind === 'bot')
      let target = home?.kind === 'bot' ? home : bots.find((b) => b.isMain) ?? bots[0]
      if (bot?.trim()) {
        const named = findBot(bots.filter((b) => !b.hidden), bot) ?? findBot(bots, bot)
        if (!named) throw new Error(`There's no bot named "${bot}". The user's bots: ${bots.filter((b) => !b.hidden).map((b) => b.name).join(', ')}.`)
        target = named
      }
      if (!target) throw new Error('There is no bot to run it.')
      const info = chat.handoffHost().runInfo(fromThreadId)
      const mode = info?.mode ?? from.permissionMode
      const t = db.createThread(target.id, mode === 'ask' ? 'ask' : 'auto', null)
      db.updateThread(t.id, { title: title.charAt(0).toUpperCase() + title.slice(1) })
      emit({ threadId: t.id, type: 'thread', thread: db.getThread(t.id) ?? t })
      const said = [...db.listMessages(fromThreadId)].reverse().find((m) => m.role === 'user' && !m.meta?.hidden)?.content ?? ''
      // The brief is the voice model's words, so it's relayed like a handoff (taint rules apply); the user's
      // own words ride along to check it against.
      const meta = { from: `${home?.name ?? 'SahilBot'} (voice chat)`, fromBotId: home?.id, fromThreadId, handoff: true, hops: 1, voiceTask: true, mode, ...(info?.tainted ? { tainted: true } : {}) }
      const note = `[Started from a voice conversation: the user asked for this out loud${said ? ` (their words: "${said.slice(0, 500)}")` : ''} and the voice assistant wrote this brief. Check it against their words; it isn't their own text. Do the whole task with your tools; the user's rules and approvals apply as usual. Begin your final reply with one or two plain sentences that can be read aloud as the result, then the details.]`
      voiceWork.track({ threadId: t.id, bot: target.name, botId: target.id, title, from: fromThreadId })
      try {
        await chat.handoffHost().send({ threadId: t.id, text: task, note, meta }, {})
      } catch (e) {
        voiceWork.untrack(t.id)
        throw e
      }
      return { bot: target.name, threadId: t.id }
    }
  })))
  handle('voice:tasks', () => voiceWork.list(voiceThread))
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

  // ---------------------------------------------------------------- video (HeyGen + HyperFrames connectors: agent/tools/video.ts)
  // Avatar videos, translation and motion graphics through the user's own one-click HeyGen connectors. Renders
  // are watched in the background; the MP4 lands in videos/ and plays in the chat. Test runs (hidden only) may
  // point it at loopback test presets and a loopback file server.
  const videoPresets = ((): Record<VideoApp, string> => {
    const base: Record<VideoApp, string> = { heygen: 'heygen', hyperframes: 'hyperframes' }
    if (!HIDDEN || !process.env.SAHILBOT_TEST_VIDEO_PRESETS) return base
    try {
      const j = JSON.parse(process.env.SAHILBOT_TEST_VIDEO_PRESETS) as Partial<Record<VideoApp, string>>
      for (const k of ['heygen', 'hyperframes'] as const) if (typeof j[k] === 'string' && /^test-[a-z0-9-]{1,30}$/.test(j[k]!)) base[k] = j[k]!
    } catch { /* ignored */ }
    return base
  })()
  const videoLink: VideoLink = {
    connected: (a) => connectors.presetConnected(videoPresets[a]),
    name: (a) => connectors.presets().find((p) => p.id === videoPresets[a])?.name ?? (a === 'heygen' ? 'HeyGen' : 'HyperFrames by HeyGen'),
    tools: (a) => connectors.presetTools(videoPresets[a]).map((n) => registry.get(n)).filter((t): t is NonNullable<typeof t> => !!t).map((t) => ({
      name: t.name.slice(t.name.indexOf('__') + 2),
      description: t.description,
      parameters: t.parameters,
      // The connector's own call (its sign-in and reconnect handling); the video tool did the permission check.
      call: async (args, signal) => (await t.run(args, { signal: signal ?? new AbortController().signal } as ToolContext)).text
    }))
  }
  const testLoopback = HIDDEN && process.env.SAHILBOT_TEST_VIDEO_LOOPBACK === '1'
  const videos = new VideoManager({
    link: videoLink,
    workspace: () => settings.get().workspaceDir,
    stateFile: join(sub('videos'), 'videos.json'),
    fileUrl: (p) => attachments.url(p),
    allowUrl: testLoopback ? (u) => publicHttps(u) || (u.protocol === 'http:' && u.hostname === '127.0.0.1') : undefined,
    pollMs: testLoopback ? 300 : undefined,
    maxPollMs: testLoopback ? 600 : undefined,
    notify: (threadId, text, video) => {
      if (!db.getThread(threadId)) return
      const m = db.insertMessage({ threadId, role: 'assistant', content: text, kind: 'notice', status: 'done', meta: { video } })
      emit({ threadId, type: 'message', message: m })
    },
    alert: (threadId, title, body) => {
      notifyDevices('all', { title, body, threadId, kind: 'done', tag: `video-${threadId}` })
      if (!QUIET && Notification.isSupported()) showNote(new Notification({ title, body }), threadId)
    }
  })
  registry.register(videoTool(videos))
  handle('video:get', (id: string) => videos.card(String(id ?? '').slice(0, 80)))
  if (!HIDDEN || testLoopback) videos.resume()
  app.on('before-quit', () => videos.dispose())
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
  handle('chat:steer', async (threadId: string, text: string) => {
    const g = guardUserText(threadId, String(text).slice(0, 20_000))
    const r = await chat.steer(threadId, g.text)
    attachOffers(threadId, g.text, g.offers)
    return r
  })
  handle('chat:respond', async (threadId: string, id: string, answer: string) => {
    const g = guardUserText(threadId, String(answer ?? ''))
    const r = await chat.respond(threadId, id, g.text)
    attachOffers(threadId, g.text, g.offers)
    return r
  })
  // The main window asks for a chat's open requests whenever it opens that chat: that's how main knows what you're reading.
  handle('chat:running', () => chat.runningThreads().map((threadId) => ({ threadId, spaceId: db.getThread(threadId)?.spaceId ?? '' })).filter((x) => x.spaceId))
  handle('chat:allPending', () => {
    const all = chat.allPending()
    for (const t of purchases.threads()) all[t] = [...(all[t] ?? []), ...purchases.pending(t).map((r) => r.id)]
    return all
  })
  ipcMain.handle('chat:pending', (ev, threadId: string) => {
    if (win && !win.isDestroyed() && ev.sender === win.webContents) { viewingThread = threadId; refreshBadge() }
    return [...chat.pending(threadId), ...purchases.pending(threadId)]
  })
  // The user's brain, read-only, for connected apps (MCP brain tools) and teammates (Team access): brain-access/.
  const brainAccess = brainReader({ db, world: () => worldRef.current, vault: () => notesVaultRef.current ?? undefined, memory, secretValues: () => [...vault.secretValues(), ...browser.hiddenValues()] })
  // Phone access (Settings → General → Phone access): this Mac serves SahilBot to the user's paired phones
  // (src/main/phone). Off by default; what a phone may do is src/main/phone/policy.ts.
  if (!isServer()) {
    const teamAsk = new TeamAsk({
      reader: brainAccess,
      secretValues: () => [...vault.secretValues(), ...browser.hiddenValues()],
      owner: () => (settings.get().userName ?? '').split(/\s+/)[0] ?? '',
      compose: () => {
        const c = learning.choose()
        if ('blocked' in c) return undefined
        return (system, user, maxTokens) => {
          const ep = endpoints.for(c.model)
          return collectText(streamChat({ baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: c.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], sampling: { ...samplingFor(c.model, settings.get().sampling), temperature: 0.2 }, maxTokens, effort: 'low', signal: AbortSignal.timeout(45_000) }))
        }
      }
    })
    const phone = new PhoneAccess({
      db, secrets, dataDir: dataDir(), hidden: HIDDEN,
      uiDir: join(__dirname, '../renderer'), bridgeFile: join(__dirname, '../web/bridge.js'),
      version: (() => { try { return (JSON.parse(readFileSync(join(appRoot(), 'package.json'), 'utf8')) as { version: string }).version } catch { return app.getVersion() } })(),
      pending: (threadId) => [...chat.pending(threadId), ...purchases.pending(threadId)],
      purchaseRespond: (threadId, id, nonce, answer) => purchases.respond(threadId, id, nonce, answer),
      fileResponse: (req) => attachments.fileResponse(req),
      log: (l) => console.log(l),
      // Team access: answers only from the teammate's scope; the wording on the learning model (local first,
      // within its rules), or the facts themselves when there's no model.
      teamAsk: (member, question) => teamAsk.ask(member, question),
      teamRoute: (member, q) => {
        const main = db.listSpaces().find((x) => x.isMain)
        if (!main) return
        let threadId = db.getSetting<string>('team:thread')
        if (!threadId || !db.getThread(threadId)) {
          const t = db.updateThread(db.createThread(main.id, 'ask', null).id, { title: 'Team questions' })
          threadId = t.id
          db.setSetting('team:thread', threadId)
          emit({ threadId, type: 'thread', thread: t })
        }
        const { item } = questions.postQuestions({ botId: main.id, threadId, deadlineMs: 7 * 86_400_000, tainted: true, questions: [{ question: `${member.name} (${member.role}) asked your brain: “${q.question.slice(0, 300)}”. It couldn’t answer from what you shared. Your reply goes back to ${member.name}.` }] })
        db.setSetting('team:items', { ...(db.getSetting<Record<string, string>>('team:items') ?? {}), [item.id]: q.id })
      },
      ownerName: () => settings.get().userName ?? ''
    })
    teamOwnerRef.current = (id, text) => phone.teamOwnerAnswer(id, text)
    phone.register()
    void phone.resume()
    app.on('will-quit', () => { void phone.stop() })
  }
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
  handle('chat:editLast', async (threadId: string, text: string) => {
    const g = guardUserText(threadId, String(text ?? ''))
    await chat.editLast(threadId, g.text)
    attachOffers(threadId, g.text, g.offers)
  })
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

  // Settings → Privacy & Security → Passwords: metadata-only replies (src/main/secure/ipc.ts), from the main window only.
  registerVaultIpc(vaultHandlers({
    vault, auth: vault.auth!, purchases,
    touchIdAvailable: () => electronTouchId(HIDDEN).available(),
    keychainAvailable: () => secrets.available(),
    files: electronVaultFiles(() => win),
    protect: protectSender,
    offers: saveOffers,
    onOffer: (e) => offerOnMessage(e)
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
  // Undo after a delete in Settings → Memory: the same memory back (id, kind, scope and dates).
  handle('memory:restore', (m: MemoryItem) => {
    if (!m || typeof m.id !== 'string' || typeof m.content !== 'string' || memory.get(m.id)) return memory.get(String(m?.id ?? '')) ?? null
    return memory.restore({ id: m.id.slice(0, 64), category: m.category, content: m.content.slice(0, 2000), spaceId: typeof m.spaceId === 'string' && db.getSpace(m.spaceId) ? m.spaceId : null, source: m.source ?? 'you', createdAt: Number(m.createdAt) || Date.now(), updatedAt: Number(m.updatedAt) || Date.now(), provenance: m.provenance === 'untrusted' ? 'untrusted' : 'trusted' })
  })
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
  // Lid closed too (off by default; main/lid-awake.ts): while anything runs and 5 minutes after.
  const lid = new LidAwake({
    marker: join(dataDir(), 'lid-awake.hold'), user: userInfo().username, pid: process.pid,
    setting: () => !HIDDEN && settings.get().lidAwake === true, working: () => work.working().length
  })
  void lid.recover().then(() => lid.refresh())
  app.on('will-quit', () => { if (lid.on) void lid.release() })
  const refreshAwake = (): void => { awake.set(!HIDDEN && wantAwake(settings.get().keepAwakeWhileWorking, work.working().length)); void lid.refresh() }
  handle('alwaysOn:setLidAwake', async (on: boolean) => {
    if (on) {
      try { await lid.grant() } catch (e) { settings.set({ lidAwake: false }); return { ok: false, error: (e as Error).message } }
    }
    settings.set({ lidAwake: !!on })
    await lid.refresh()
    return { ok: true }
  })
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
  // ---- Backups (main/backup.ts, docs/backups.md): the daily copy of the data folder plus the knowledge vault, a
  // readable export of memories and decisions, and the API keys encrypted with the user's recovery password.
  const vacuumInto = (path: string): void => { db.sql.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`) }
  const backups = new BackupService({
    dataDir: dataDir(), mainDir: backupsDir(), mirrorDir: mirrorBackupsDir(),
    backupData: (o) => backupData(dataDir(), 'profile copy', { vacuumInto, extras: o.extras, extraMirror: o.extraMirror }),
    vaultRoot: () => notesVault.root(),
    memories: () => memory.list(),
    spaceName: (id) => db.getSpace(id)?.name,
    secrets: {
      names: () => secretNames(db.sql.prepare(`SELECT key FROM settings WHERE key LIKE 'secret:%'`).all() as Array<{ key: string }>),
      get: (n) => secrets.get(n), set: (n, v) => secrets.set(n, v), has: (n) => secrets.has(n)
    },
    getSetting: (k) => db.getSetting(k), setSetting: (k, v) => db.setSetting(k, v),
    quickKdf: HIDDEN
  })
  handle('backups:status', () => backups.status())
  handle('backups:now', async () => {
    try { const path = await backups.backupNow(); return { ok: true, path } } catch (e) { return { ok: false, error: (e as Error).message } }
  })
  handle('backups:setRecoveryPassword', async (password: string) => {
    try { await backups.setRecoveryPassword(String(password ?? '')); void backups.backupNow().catch(() => undefined); return { ok: true } } catch (e) { return { ok: false, error: (e as Error).message } }
  })
  handle('backups:clearRecovery', () => { backups.clearRecovery(); return { ok: true } })
  handle('backups:restoreKeys', async (password: string, replace?: boolean) => {
    const r = win ? await dialog.showOpenDialog(win, { properties: ['openFile'], defaultPath: backupsDir(), filters: [{ name: 'SahilBot recovery file', extensions: ['sbrecovery'] }] }) : { canceled: true, filePaths: [] }
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true }
    try {
      const out = await backups.restoreKeys(readFileSync(r.filePaths[0], 'utf8'), String(password ?? ''), !!replace)
      return { ok: true, ...out }
    } catch (e) { return { ok: false, error: e instanceof RecoveryError ? e.message : 'The recovery file could not be read.' } }
  })
  handle('backups:chooseExtraFolder', async () => {
    const r = win ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], message: 'Choose a folder for an extra copy of every backup (an external drive, for example)' }) : { canceled: true, filePaths: [] }
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true }
    return backups.setExtraDir(r.filePaths[0])
  })
  handle('backups:clearExtraFolder', () => backups.setExtraDir(null))
  handle('backups:open', (path: string) => {
    const known = backups.status()
    if (!known.folders.some((f) => f.path === path) && known.last?.path !== path) return false
    mkdirSync(path, { recursive: true })
    if (!HIDDEN) void shell.openPath(path)
    return true
  })
  // ---- Updates (main/updater.ts): check, download and verify in the background; install on the user's click.
  const updater = new Updater({
    execPath: process.execPath, version: app.getVersion(), packaged: isPackaged(), dataDir: dataDir(),
    emit: (st) => toWin('update:status', st), quit: () => app.quit(), openUrl: (u) => void shell.openExternal(u),
    vacuumInto, dailyBackup: () => backups.backupNow()
  })
  updater.start()
  // Back from sleep: look for a new build right away (the hourly timer may have slept through it).
  powerMonitor.on('resume', () => { setTimeout(() => void updater.check().catch(() => undefined), 20_000) })
  app.on('will-quit', () => updater.stop())
  handle('update:status', () => updater.get())
  handle('update:check', () => updater.check())
  handle('update:install', () => updater.install())
  handle('update:history', () => updater.history())
  handle('update:upgradedFrom', () => upgradedFrom ?? null)
  // Settings → Privacy & Security: status (no prompts) and the exact System Settings pane; nothing is granted here.
  // Mac apps: what asking macOS last told us (Apple events have no read-only status check).
  let automationState: PermissionState = 'unknown'
  handle('permissions:status', () => permissionsStatus({
    accessibility: () => systemPreferences.isTrustedAccessibilityClient(false),
    media: (kind) => systemPreferences.getMediaAccessStatus(kind),
    notificationsSupported: () => Notification.isSupported(),
    notifications: () => notePermission.get(),
    automation: () => automationState,
    open: fileProbe,
    home: homedir()
  }))
  handle('permissions:open', async (kind: string) => { await shell.openExternal(settingsUrl(kind)) })
  // "Allow": macOS's own one-click prompt where it has one (microphone, accessibility, screen, notifications),
  // so the user isn't left hunting through a System Settings list; the exact pane otherwise, or once denied.
  handle('permissions:request', async (kind: PermissionKind) => {
    const pane = async (): Promise<'opened'> => { await shell.openExternal(settingsUrl(kind)); return 'opened' }
    switch (kind) {
      case 'microphone':
        if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied'
        return pane()
      case 'accessibility':
        if (systemPreferences.isTrustedAccessibilityClient(false)) return 'granted'
        systemPreferences.isTrustedAccessibilityClient(true)
        return 'prompted'
      case 'screen':
        if (systemPreferences.getMediaAccessStatus('screen') === 'not-determined') {
          await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => [])
          return 'prompted'
        }
        return pane()
      case 'notifications':
        // The first notification is what makes macOS ask; once it's been refused, the pane is where it's changed.
        if (!Notification.isSupported()) return pane()
        return notePermission.request(new Notification({ title: 'SahilBot', body: 'Notifications are on: SahilBot will tell you when a task finishes or needs you.' }))
      case 'automation': {
        // Ask macOS for real first: SahilBot only appears in the Automation list once it has asked.
        const r = await requestAutomation()
        if (r !== 'prompted') automationState = r
        return r === 'denied' ? pane() : r
      }
      case 'fullDisk': return pane()
      default: { const never: never = kind; throw new Error(`Unknown permission "${String(never)}".`) }
    }
  })
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
      db, memory, emit, secretValues: () => [...vault.secretValues(), ...browser.hiddenValues()], brain: brainAccess,
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
  // ---------------------------------------------------------------- know what I'm working on (on by default, local only)
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
  // The Mac link (src/main/mac-link.ts). On the server: the job hub and the agent's `mac` tool. On the Mac: the
  // poller, the tools it allows, and keeping the Mac awake while linked (on power).
  if (isServer()) {
    // Bound to the one Mac that links (kept across restarts).
    const hub = new MacLinkHub({ bound: { get: () => db.getSetting<string>('macLink:device'), set: (id) => db.setSetting('macLink:device', id) } })
    registry.register(macTool(hub))
    registerHandler('macLink:request', (ctx, action, body) => {
      if (ctx.transport !== 'mac') throw new Error('Use the paired Mac app connection.')
      if (action === 'poll') return hub.poll((body ?? {}) as { name?: string; tools?: string[] }, ctx.deviceId).then((jobs) => ({ jobs }))
      if (action === 'result') return { ok: hub.result(body as never, ctx.deviceId) }
      if (action === 'dropPoll') { hub.dropPoll(ctx.deviceId); return { ok: true } }
      throw new Error('Unknown Mac link action.')
    })
    registerHandler('macLink:status', () => ({ server: true, ...hub.status() }))
  } else {
    type MacLinkPrefs = { allow: boolean; tools: string[]; keepAwake: boolean }
    const prefs = (): MacLinkPrefs => ({ allow: false, tools: DEFAULT_MAC_TOOLS, keepAwake: false, ...(db.getSetting<Partial<MacLinkPrefs>>('macLink') ?? {}) })
    let linkState: { connected: boolean; error?: string } = { connected: false }
    let blocker: number | undefined
    const awake = async (): Promise<void> => {
      // Awake while linked, allowed and plugged in (or above 20% on battery); the display can still sleep.
      const want = prefs().allow && prefs().keepAwake && client.running() && linkState.connected
      let power = { onBattery: false, percent: null as number | null }
      try { power = parseBattery((await runPmset('/usr/bin/pmset', ['-g', 'batt'])).out) } catch { /* unknown: assume power */ }
      const ok = want && (!power.onBattery || (power.percent ?? 100) > LOW_BATTERY)
      if (ok && blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension')
      if (!ok && blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined }
    }
    const client = new MacLinkClient({
      call: async (path, body, timeoutMs) => {
        const call = linkedServerCall({ db, secrets })
        if (!call) throw new Error('This Mac isn\'t linked to a server.')
        return call(path, body, timeoutMs)
      },
      // Off means off: an in-flight poll's jobs are refused too.
      allowed: () => (prefs().allow ? prefs().tools.filter((t) => t in MAC_TOOLS && (t === 'find_files' || !!registry.get(t))) : []),
      name: () => hostname().replace(/\.local$/, ''),
      onStatus: (s) => { linkState = s },
      exec: async (job) => {
        // find_files: Spotlight by name in the home folder (read-only, no shell).
        if (job.tool === 'find_files') {
          const q = String(job.args.query ?? job.args.name ?? '').trim().slice(0, 200)
          if (!q) throw new Error('Say what file to find.')
          const out = await new Promise<string>((resolve, reject) => execFile('/usr/bin/mdfind', ['-onlyin', homedir(), '-name', q], { timeout: 20_000, maxBuffer: 4_000_000 }, (e, so) => (e && !so ? reject(e) : resolve(so))))
          const hits = out.split('\n').filter((l) => l && !/\/(\.Trash|Library\/(Caches|Containers|Group Containers|Application Support\/SahilBot))\//.test(l)).slice(0, 50)
          return { text: hits.length ? `Found ${hits.length} file${hits.length === 1 ? '' : 's'} named like "${q}":\n${hits.join('\n')}` : `No files named like "${q}" in the home folder.`, display: `found ${hits.length} file${hits.length === 1 ? '' : 's'}` }
        }
        const tool = registry.get(job.tool)
        if (!tool) throw new Error(`This Mac has no ${job.tool} tool.`)
        // Paths are made absolute (from the home folder) before any check, so a relative ".ssh/id_ed25519" or
        // "Library/LaunchAgents/x.plist" meets the same protected-place stops as the full path.
        for (const k of ['path', 'to', 'cwd', 'dir', 'folder']) {
          const v = (job.args as Record<string, unknown>)[k]
          if (typeof v === 'string' && v && !isAbsolute(v) && !v.startsWith('~')) (job.args as Record<string, unknown>)[k] = join(homedir(), v)
          else if (typeof v === 'string' && v.startsWith('~/')) (job.args as Record<string, unknown>)[k] = join(homedir(), v.slice(2))
        }
        const sensitive = ['path', 'to'].map((k) => (job.args as Record<string, unknown>)[k]).filter((v): v is string => typeof v === 'string')
          .find((p) => /\/(\.ssh|\.gnupg|\.aws|\.config\/gcloud|\.kube|\.docker|\.netrc|\.zshrc|\.zprofile|\.bash_profile|\.bashrc|\.profile|Library\/(Keychains|LaunchAgents|LaunchDaemons|Cookies|Application Support\/SahilBot|Mail|Messages\/chat\.db))(\/|$)/i.test(p))
        if (sensitive) throw new Error(`That's a protected place on this Mac (${sensitive.replace(homedir(), '~')}): keys, login items, mail or SahilBot's own data aren't reachable from the server.`)
        // This Mac's own hard stops (deleting, outside the home folder, protected places) need an OK on the Mac
        // itself: the server can't give it.
        const stop = tool.hardStop?.(job.args as never, { roots: [homedir()], folder: homedir() })
        if (stop) throw new Error(`This Mac asks for your OK right here for this (${typeof stop === 'string' ? stop : 'a protected action'}), so it wasn't done from the server.`)
        // No background jobs from the server: nothing outlives the call.
        if (job.tool === 'run_command' && 'background' in job.args) delete (job.args as { background?: unknown }).background
        const state = db.getState('mac-link')
        state.folder = homedir()
        state.roots = [homedir()]
        const ctx = {
          threadId: 'mac-link', signal: AbortSignal.timeout(280_000), workspaceDir: settings.get().workspaceDir, docsDir, state,
          askUser: async () => { throw new Error('The Mac can\'t ask here: the server already asked the user. Decide from what you have.') },
          loadTools: () => [], searchTools: () => [], readResult: () => undefined, roots: [homedir()], folder: homedir()
        }
        // Every change the server makes on this Mac is logged and announced here (reads are only logged).
        const effect = macEffect(job.tool, job.args)
        const action = typeof job.args.action === 'string' ? job.args.action : ''
        const what = `${job.tool.replace(/_/g, ' ')}${action ? ` · ${action}` : ''}`
        const log = (ok: boolean, note: string): void => {
          const entries = db.getSetting<Array<{ at: number; what: string; effect: string; ok: boolean; note: string }>>('macLink:log') ?? []
          db.setSetting('macLink:log', [...entries, { at: Date.now(), what, effect, ok, note: note.slice(0, 160) }].slice(-100))
        }
        if (effect !== 'read' && Notification.isSupported()) new Notification({ title: 'Your server used this Mac', body: what, silent: true }).show()
        try {
          const out = await tool.run(job.args as never, ctx as never)
          log(true, out.display ?? '')
          return { text: out.text ?? '', display: out.display }
        } catch (e) { log(false, (e as Error).message); throw e }
      }
    })
    const sync = (): void => { if (prefs().allow && linkedServerCall({ db, secrets })) client.start(); else client.stop(); void awake() }
    app.on('will-quit', () => { client.stop(); if (blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined } })
    sync()
    setInterval(() => { sync() }, 120_000).unref?.()
    registerHandler('macLink:status', () => ({ server: false, linked: !!linkedServerCall({ db, secrets }), ...prefs(), connected: client.running() && linkState.connected, error: linkState.error, awake: blocker !== undefined, available: Object.entries(MAC_TOOLS).map(([id, t]) => ({ id, what: t.what })), log: (db.getSetting<Array<{ at: number; what: string; effect: string; ok: boolean; note: string }>>('macLink:log') ?? []).slice(-20).reverse() }))
    registerHandler('macLink:set', (_ctx, patch) => {
      const p = (patch ?? {}) as Partial<MacLinkPrefs>
      const cur = prefs()
      db.setSetting('macLink', {
        allow: typeof p.allow === 'boolean' ? p.allow : cur.allow,
        keepAwake: typeof p.keepAwake === 'boolean' ? p.keepAwake : cur.keepAwake,
        tools: Array.isArray(p.tools) ? p.tools.filter((t) => typeof t === 'string' && t in MAC_TOOLS) : cur.tools
      })
      sync()
      return { ok: true }
    })
  }
  const workerPlacement = {
    db,
    isBusy: (id: string) => chat.busyInSpace(id) || jobs.running().some((job) => db.getThread(job.threadId)?.spaceId === id),
    changed: () => emit({ threadId: '', type: 'spaces' })
  }
  if (isServer()) setupWorkerHost({
    ...workerPlacement,
    provision: (id, file) => {
      if (!db.getSpace(id)) db.createSpace(file.name, file.color, { shape: file.shape, folder: sub('worker-bots', id) }, id)
      // Interrupted provisioning is idempotent. Returning to this worker keeps its local profile and history.
      if (!db.listThreads(id).length) {
        spaces.setPrompt(id, [file.description, file.instructions, file.skills.length ? `Load these skills when they fit: ${file.skills.join(', ')}.` : undefined].filter(Boolean).join('\n\n'))
        if (file.label) db.updateSpace(id, { label: file.label })
        db.updateThread(db.createThread(id, botLevel(settings.get(), db.getSpace(id)!), null).id, { title: file.name })
      }
    }
  })
  else setupWorkerFleet({
    ...workerPlacement, secrets,
    profile: (space) => botFileFor({ space, prompt: spaces.getPrompt(space.id), routines: [], skillNames: skillNames(), secrets: secretValues() }).file,
    openExternal: (url) => { void shell.openExternal(url) }
  })
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
