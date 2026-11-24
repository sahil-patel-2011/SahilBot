import { app, BrowserWindow, Menu, nativeImage, screen, type MenuItemConstructorOptions, type Rectangle } from 'electron'
import { join } from 'node:path'
import type { Db } from './db'
import { appRoot, isPackaged } from './paths'

// The app around the window: name, icon, About panel, menu bar, and remembered window size.

export type MenuAction = 'new-chat' | 'new-bot' | 'new-project' | 'settings' | 'scheduled' | 'connect' | 'toggle-panel' | 'export' | 'search' | 'import-bot' | 'shortcuts'

export function setupApp(): void {
  app.setName('SahilBot')
  app.setAboutPanelOptions({
    applicationName: 'SahilBot',
    applicationVersion: app.getVersion(),
    copyright: `© ${new Date().getFullYear()} SahilBot`,
    credits: 'Your assistant that runs on your Mac. Chats, files, memory, passwords and voice stay on this computer.'
  })
  // In development the bundle is Electron's; show SahilBot's icon in the Dock anyway.
  if (!isPackaged() && process.platform === 'darwin') {
    const icon = nativeImage.createFromPath(join(appRoot(), 'resources', 'icon.png'))
    if (!icon.isEmpty() && !process.env.SAHILBOT_HIDDEN) app.dock?.setIcon(icon)
  }
}

export function buildMenu(send: (a: MenuAction) => void): void {
  const mac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{
      label: 'SahilBot',
      submenu: [
        { role: 'about' as const, label: 'About SahilBot' },
        { type: 'separator' as const },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('settings') },
        { label: 'Connect Apps…', click: () => send('connect') },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const, label: 'Hide SahilBot' },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const, label: 'Quit SahilBot' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => send('new-chat') },
        { label: 'New Bot', accelerator: 'CmdOrCtrl+Shift+B', click: () => send('new-bot') },
        { label: 'New Project', accelerator: 'CmdOrCtrl+Shift+P', click: () => send('new-project') },
        { label: 'Import Bot…', click: () => send('import-bot') },
        { type: 'separator' },
        { label: 'Scheduled Tasks', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('scheduled') },
        { label: 'Export Chat as Markdown…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('export') },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    // Standard edit roles keep copy, paste, undo and spell check working everywhere.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Search Chats', accelerator: 'CmdOrCtrl+K', click: () => send('search') },
        { label: 'Toggle Side Panel', accelerator: 'CmdOrCtrl+\\', click: () => send('toggle-panel') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'reload' as const },
        ...(isPackaged() ? [] : [{ role: 'toggleDevTools' as const }])
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: () => send('shortcuts') },
        { label: 'Connect Apps…', click: () => send('connect') },
        { label: 'Settings…', click: () => send('settings') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Restores the last window size and position (if it's still on a connected screen) and saves changes. */
export function windowState(db: Db): { bounds: Partial<Rectangle>; track(w: BrowserWindow): void } {
  const saved = db.getSetting<Rectangle & { maximized?: boolean }>('window')
  const onScreen = saved && screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return saved.x >= a.x - 50 && saved.y >= a.y - 50 && saved.x + 200 <= a.x + a.width && saved.y + 100 <= a.y + a.height
  })
  return {
    bounds: onScreen ? saved : {},
    track(w) {
      let t: NodeJS.Timeout | null = null
      const save = (): void => {
        if (t) clearTimeout(t)
        t = setTimeout(() => {
          if (w.isDestroyed() || w.isMinimized() || w.isFullScreen()) return
          db.setSetting('window', { ...w.getNormalBounds(), maximized: w.isMaximized() })
        }, 400)
      }
      w.on('resize', save)
      w.on('move', save)
      if (onScreen && saved?.maximized) w.maximize()
    }
  }
}
