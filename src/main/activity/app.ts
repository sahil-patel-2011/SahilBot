import { execFile } from 'node:child_process'
import { app, BrowserWindow, ipcMain, powerMonitor, systemPreferences, type IpcMainInvokeEvent } from 'electron'
import type { ActivitySettings } from '@shared/types'
import { wrap } from '../computer/scripts'
import { automationStatus } from '../permissions-center'
import { setActivitySource } from './context'
import { registerActivityService } from './index'
import { ActivityService, type ActivityDeps } from './service'

// Electron wiring for "Know what I'm working on": Settings IPC (main window only), the minute timer
// while SahilBot runs, a look right after the user switches away from SahilBot, and stop on quit.
// Hidden test runs never look at the screen's apps (the service never starts there).

export interface ActivityAppDeps {
  db: ActivityDeps['db']
  mainWindow(): BrowserWindow | null
  hidden: boolean
}

function fromMainWindow(ev: IpcMainInvokeEvent, w: BrowserWindow | null): boolean {
  return !!w && !w.isDestroyed() && ev.sender === w.webContents && (!ev.senderFrame || ev.senderFrame === w.webContents.mainFrame)
}

const osascriptJxa = (fn: string, input: unknown, timeoutMs: number): Promise<unknown> => new Promise((ok, fail) => {
  execFile('osascript', ['-l', 'JavaScript', '-e', wrap(fn), JSON.stringify(input ?? {})], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (e, out, err) => {
    if (e) { fail(new Error(String(err || e.message))); return }
    try { ok(JSON.parse(String(out).trim() || 'null')) } catch { ok(null) }
  })
})

/** Which scriptable browsers are running (checked without Automation: the bundle's process list via lsappinfo). */
function runningBundles(): Promise<Set<string>> {
  return new Promise((ok) => execFile('lsappinfo', ['list'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (e, out) => {
    const s = new Set<string>()
    if (!e) for (const m of String(out).matchAll(/bundleID="([^"]+)"/g)) s.add(m[1].toLowerCase())
    ok(s)
  }))
}

export function setupActivity(d: ActivityAppDeps): ActivityService {
  let changeTimer: ReturnType<typeof setTimeout> | null = null
  const changed = (): void => {
    if (changeTimer) return
    changeTimer = setTimeout(() => {
      changeTimer = null
      const w = d.mainWindow()
      if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('activity:changed')
    }, 300)
  }
  const service = new ActivityService({
    db: d.db,
    jxa: osascriptJxa,
    accessibility: () => systemPreferences.isTrustedAccessibilityClient(false),
    idleState: (limit) => powerMonitor.getSystemIdleState(limit),
    automation: (name) => automationStatus(name),
    self: { pid: process.pid, names: [app.getName(), 'SahilBot', 'Electron'] },
    onChange: changed,
    noSampling: d.hidden
  })
  registerActivityService(service)
  setActivitySource(service)

  const refuse = (): never => { throw new Error('This can only be changed in the main SahilBot window.') }
  const guard = <A extends unknown[], R>(ch: string, fn: (...a: A) => R | Promise<R>): void => {
    ipcMain.handle(ch, (ev, ...args) => {
      if (!fromMainWindow(ev, d.mainWindow())) refuse()
      return fn(...(args as A))
    })
  }
  guard('activity:status', () => service.status())
  guard('activity:set', (patch: unknown) => {
    const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<ActivitySettings>
    return service.set(p)
  })
  guard('activity:pause', (minutes: unknown) => service.pause(typeof minutes === 'number' ? minutes : 60))
  guard('activity:clear', () => service.clear())
  guard('activity:checkPermissions', async () => {
    if (d.hidden) return service.status()
    const running = await runningBundles()
    return service.checkPermissions((bundleId) => running.has(bundleId.toLowerCase()))
  })

  // A look right after the user leaves SahilBot for another app (its windows lost focus).
  app.on('browser-window-blur', () => {
    setTimeout(() => { if (!BrowserWindow.getFocusedWindow()) service.soon(1000) }, 300)
  })
  // Asleep, idle (5 min) or locked: the minute's look is skipped (getSystemIdleState), so nothing to do here.
  app.on('before-quit', () => service.stop())
  // Only while SahilBot runs (nothing at login unless SahilBot itself opens), and never in hidden test runs.
  service.start()
  return service
}
