import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ChatEvent, McpNewClient, McpStatus, Thread } from '@shared/types'
import type { Db } from '../db'
import { appRoot } from '../paths'
import type { SettingsStore } from '../settings'
import { McpHttpServer } from './server'
import { writeShim } from './shim'
import { snippets } from './snippets'
import { McpClientStore, publicClient } from './store'
import type { McpHost } from './tools'
import { MAX_TEXT_CHARS, parseSahilbotUrl, prefillScript, resolveUrlBot, SCHEME } from './url-scheme'

// Electron wiring for Connected apps: the MCP server's lifecycle and Settings IPC, and sahilbot:// links.

export interface McpAppDeps {
  db: Db
  settings: SettingsStore
  host: McpHost
  /** Folder for the stdio bridge and server.json. */
  dir: string
  mainWindow(): BrowserWindow | null
  hidden: boolean
}

export interface McpApp {
  server: McpHttpServer
  store: McpClientStore
  /** A chat a connected app started (now or before it was revoked). */
  isAppThread(threadId: string): boolean
  dispose(): Promise<void>
}

function version(): string {
  try { return (JSON.parse(readFileSync(join(appRoot(), 'package.json'), 'utf8')) as { version: string }).version } catch { return app.getVersion() }
}

/** Only the main window's own page may change who can connect (not the Quick bar, a Page or anything else). */
function fromMainWindow(ev: IpcMainInvokeEvent, w: BrowserWindow | null): boolean {
  return !!w && !w.isDestroyed() && ev.sender === w.webContents && (!ev.senderFrame || ev.senderFrame === w.webContents.mainFrame)
}

export function setupMcpServer(d: McpAppDeps): McpApp {
  const store = new McpClientStore(d.db)
  let shimPath: string | null = null
  let changeTimer: ReturnType<typeof setTimeout> | null = null
  const changed = (): void => {
    if (changeTimer) return
    changeTimer = setTimeout(() => {
      changeTimer = null
      const w = d.mainWindow()
      if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('mcp:changed')
    }, 250)
  }
  const server = new McpHttpServer({
    host: d.host, store, version: version(), dir: d.dir,
    savedPort: () => d.settings.get().mcpServer?.port ?? 0,
    savePort: (port) => { d.settings.set({ mcpServer: { enabled: d.settings.get().mcpServer?.enabled ?? false, port } }) },
    onActivity: changed
  })

  const start = async (o: { newPort?: boolean } = {}): Promise<void> => {
    try {
      await server.start(o)
      try { shimPath = writeShim(d.dir, process.execPath) } catch { shimPath = null }
    } catch (e) {
      server.lastError = (e as Error).message
    }
    changed()
  }

  const status = (): McpStatus => {
    const s = d.settings.get().mcpServer ?? { enabled: false, port: 0 }
    return {
      enabled: s.enabled, running: server.running, port: server.running ? server.port : s.port, url: server.url,
      error: s.enabled && !server.running ? server.lastError ?? 'Not running.' : null,
      ...(s.enabled && !server.running && server.portInUse ? { portInUse: server.portInUse } : {}),
      clients: store.list().map(publicClient), activity: store.activity(100), shimPath
    }
  }

  const refuse = (): never => { throw new Error('Connected apps can only be changed in the main SahilBot window.') }

  ipcMain.handle('mcp:status', () => status())
  ipcMain.handle('mcp:setEnabled', async (ev, on: unknown, opts?: unknown) => {
    if (!fromMainWindow(ev, d.mainWindow())) refuse()
    const cur = d.settings.get().mcpServer ?? { enabled: false, port: 0 }
    d.settings.set({ mcpServer: { ...cur, enabled: on === true } })
    // "Use a new port": only after the saved one turned out to be taken, and only when the user asks.
    const newPort = !!(opts && typeof opts === 'object' && (opts as { newPort?: unknown }).newPort === true)
    if (on === true) await start({ newPort })
    else { await server.stop(); changed() }
    return status()
  })
  ipcMain.handle('mcp:createClient', (ev, name: unknown): McpNewClient => {
    if (!fromMainWindow(ev, d.mainWindow())) refuse()
    if (!server.running || !server.url) throw new Error('Turn on the server first.')
    const { client, token } = store.create(name)
    store.log({ clientId: client.id, client: client.name, tool: 'connected', ok: true })
    changed()
    return { client: publicClient(client), token, snippets: snippets(server.url, token, shimPath) }
  })
  ipcMain.handle('mcp:setScope', (ev, id: unknown, scope: unknown) => {
    if (!fromMainWindow(ev, d.mainWindow())) refuse()
    const c = typeof id === 'string' ? store.setScope(id, scope) : undefined
    if (c) store.log({ clientId: c.id, client: c.name, tool: 'scope changed', ok: true })
    changed()
    return status()
  })
  // Names for the scope picker (the window shows these anyway in People & Places).
  ipcMain.handle('mcp:brainNames', () => d.host.brain?.names({ sources: ['email'], entities: 'shared', topics: [], sensitive: [], bots: [] }, 300) ?? [])
  ipcMain.handle('mcp:revokeClient', (ev, id: unknown) => {
    if (!fromMainWindow(ev, d.mainWindow())) refuse()
    const c = typeof id === 'string' ? store.get(id) : undefined
    if (c && store.revoke(c.id)) store.log({ clientId: c.id, client: c.name, tool: 'revoked', ok: true })
    changed()
    return status()
  })

  // Off by default; on only once the user turned it on. Hidden test runs never open a port unless asked.
  if (d.settings.get().mcpServer?.enabled && (!d.hidden || process.env.SAHILBOT_TEST_MCP === '1')) void start()

  return {
    server, store,
    isAppThread: (id) => store.list().some((c) => Object.values(c.threads).includes(id)) ||
      d.db.listMessages(id).some((m) => m.role === 'user' && typeof m.meta?.mcpClientId === 'string'),
    async dispose() { await server.stop().catch(() => undefined) }
  }
}

// ---------------------------------------------------------------- sahilbot:// links

/**
 * Catches links from launch on: macOS sends open-url before the app is ready (a link that launched
 * SahilBot), so this registers at startup and hands queued links over once the window exists.
 */
export function captureOpenUrls(): { attach(fn: (url: string) => void): void } {
  const queue: string[] = []
  let handler: ((url: string) => void) | null = null
  app.on('open-url', (e, url) => {
    e.preventDefault()
    if (handler) handler(url)
    else if (queue.length < 5) queue.push(url)
  })
  return { attach(fn) { handler = fn; for (const u of queue.splice(0)) fn(u) } }
}

/** Makes SahilBot the app for sahilbot:// links (the packaged app also declares it in Info.plist). */
export function registerProtocolClient(hidden: boolean): void {
  if (hidden) return
  try {
    if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient(SCHEME, process.execPath, [resolve(process.argv[1])])
    else app.setAsDefaultProtocolClient(SCHEME)
  } catch { /* not allowed in this build */ }
}

export interface UrlDeps {
  db: Db
  emit(e: ChatEvent): void
  /** Shows a chat in the main window (creating the window if needed). */
  openThread(threadId: string): void
  /** Opens a new SahilBot chat (Home) in the main window. */
  newChat(): void
  mainWindow(): BrowserWindow | null
  /** Chats that belong to connected apps: a link never opens one of those. */
  isAppThread(threadId: string): boolean
}

/** Handles one sahilbot:// link: opens the right chat and fills the composer. It never sends. */
export function urlHandler(d: UrlDeps): (url: string) => void {
  const recent: number[] = []
  const prefill = (text: string): void => {
    const w = d.mainWindow()
    if (!w || w.isDestroyed()) return
    // The renderer switches chats asynchronously; fill the composer once it's there (only if empty).
    const run = (): void => {
      for (const ms of [700, 1500, 3000]) {
        setTimeout(() => {
          if (!w.isDestroyed() && !w.webContents.isDestroyed()) void w.webContents.executeJavaScript(prefillScript(text)).catch(() => undefined)
        }, ms)
      }
    }
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', run)
    else run()
  }
  const newThread = (botId: string, title: string): Thread => {
    const created = d.db.createThread(botId, 'auto', null)
    const t = d.db.updateThread(created.id, { title })
    d.emit({ threadId: t.id, type: 'thread', thread: t })
    return t
  }
  return (url: string): void => {
    // A burst of links (a script gone wrong, a page spamming them) can't keep stealing focus.
    const now = Date.now()
    while (recent.length && now - recent[0] > 10_000) recent.shift()
    if (recent.length >= 5) return
    recent.push(now)

    const p = parseSahilbotUrl(url)
    if (!p.ok) {
      d.newChat()
      const w = d.mainWindow()
      if (w) void dialog.showMessageBox(w, { type: 'warning', message: 'SahilBot couldn\'t open that link', detail: p.error }).catch(() => undefined)
      return
    }
    const { action } = p
    const target = resolveUrlBot(action, d.db.listSpaces())
    if (target.botId === null) {
      d.newChat()
    } else {
      const bot = d.db.listSpaces().find((s) => s.id === target.botId)!
      const existing = d.db.listThreads(bot.id).find((t) => !d.isAppThread(t.id))
      const t = action.kind === 'new' || !existing ? newThread(bot.id, bot.name) : existing
      d.openThread(t.id)
    }
    if (action.text) prefill(action.text)
    const w = d.mainWindow()
    if (w && target.unknownBot) {
      void dialog.showMessageBox(w, { type: 'info', message: `No bot named "${target.unknownBot.slice(0, 80)}"`, detail: 'Opened a new SahilBot chat instead. Nothing was sent.' }).catch(() => undefined)
    } else if (w && action.truncated) {
      void dialog.showMessageBox(w, { type: 'info', message: 'The text from that link was shortened', detail: `Only the first ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters were put in the message box. Nothing was sent.` }).catch(() => undefined)
    }
  }
}
