// The Electron side of the vault: Touch ID, auto-lock on idle / sleep / lock screen, file dialogs,
// screen-capture protection while a value is shown, and IPC registration.

import { BrowserWindow, dialog, ipcMain, powerMonitor, systemPreferences, type WebContents } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import type { Vault } from '../vault'
import type { TouchId } from './auth'
import type { VaultFiles, VaultHandler } from './ipc'

/** Touch ID through systemPreferences. Never in hidden test runs (a system sheet would hang them). */
export function electronTouchId(hidden: boolean): TouchId {
  const off = hidden || process.env.SAHILBOT_NO_TOUCHID === '1' || process.platform !== 'darwin'
  return {
    available: () => {
      if (off) return false
      try { return systemPreferences.canPromptTouchID() } catch { return false }
    },
    prompt: async (reason) => {
      if (off) return false
      try { await systemPreferences.promptTouchID(reason); return true } catch { return false }
    }
  }
}

/** Locks after the idle limit (checked every 15 s), on sleep and on the lock screen. Returns a stop function. */
export function startAutoLock(vault: Vault): () => void {
  const tick = (): void => {
    let idle = 0
    try { idle = powerMonitor.getSystemIdleTime() } catch { idle = 0 }
    try { vault.core.tick(idle) } catch { /* never crash the timer */ }
  }
  const timer = setInterval(tick, 15_000)
  timer.unref?.()
  const sleep = (why: string) => (): void => { if (vault.prefs().lockOnSleep) vault.lock(why) }
  const onSuspend = sleep('Mac went to sleep')
  const onLock = sleep('screen locked')
  powerMonitor.on('suspend', onSuspend)
  powerMonitor.on('lock-screen', onLock)
  return () => {
    clearInterval(timer)
    powerMonitor.removeListener('suspend', onSuspend)
    powerMonitor.removeListener('lock-screen', onLock)
  }
}

export function electronVaultFiles(win: () => BrowserWindow | null): VaultFiles {
  const parent = (): BrowserWindow | undefined => { const w = win(); return w && !w.isDestroyed() ? w : undefined }
  const pick = async (o: Electron.OpenDialogOptions): Promise<string | null> => {
    const w = parent()
    const r = w ? await dialog.showOpenDialog(w, o) : await dialog.showOpenDialog(o)
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  }
  return {
    saveBackup: async (defaultPath) => {
      const o: Electron.SaveDialogOptions = { title: 'Save encrypted vault backup', defaultPath, filters: [{ name: 'SahilBot vault backup', extensions: ['sbvault'] }] }
      const w = parent()
      const r = w ? await dialog.showSaveDialog(w, o) : await dialog.showSaveDialog(o)
      return r.canceled || !r.filePath ? null : r.filePath
    },
    openBackup: () => pick({ title: 'Choose a SahilBot vault backup', properties: ['openFile'], filters: [{ name: 'SahilBot vault backup', extensions: ['sbvault', 'json'] }] }),
    openCsv: () => pick({ title: 'Choose a password manager CSV export', properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }] }),
    // Owner-only file permissions: the backup is encrypted, but nobody else needs to read it.
    write: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
    read: (path) => readFileSync(path, 'utf8')
  }
}

const protectedUntil = new Map<number, ReturnType<typeof setTimeout>>()

/** While a value is on screen, the window can't be captured (screenshots, screen recording, computer use). */
export function protectSender(sender: unknown, ms: number): void {
  const wc = sender as WebContents | undefined
  const w = wc && typeof wc.id === 'number' ? BrowserWindow.fromWebContents(wc) : null
  if (!w || w.isDestroyed()) return
  w.setContentProtection(true)
  const prev = protectedUntil.get(w.id)
  if (prev) clearTimeout(prev)
  const id = w.id
  protectedUntil.set(id, setTimeout(() => {
    protectedUntil.delete(id)
    const still = BrowserWindow.fromId(id)
    if (still && !still.isDestroyed()) still.setContentProtection(false)
  }, ms))
}

/** Registers the handlers; only the app's own windows (not browser tabs or Pages) may call them. */
export function registerVaultIpc(handlers: Record<string, VaultHandler>, allowed: (wc: WebContents) => boolean): void {
  for (const [ch, fn] of Object.entries(handlers)) {
    ipcMain.removeHandler(ch)
    ipcMain.handle(ch, (e, ...args) => {
      if (!allowed(e.sender)) throw new Error('Not allowed.')
      return fn(e.sender, ...args)
    })
  }
}

