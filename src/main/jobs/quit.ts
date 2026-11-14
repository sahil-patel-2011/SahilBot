import type { BrowserWindow, MessageBoxOptions } from 'electron'
import { join } from 'node:path'
import { jobLine, type JobManager } from './manager'

// Quitting with background jobs running asks first (listing them), then stops them all before the app
// goes. The question has to come before any other before-quit listener runs (they dispose the browser,
// the scheduler, voice…), and Node's emitter has no stopPropagation, so the guard sits in front of the
// app's own emit: a quit that the user cancels never reaches the other listeners.

interface AppLike {
  emit(event: string | symbol, ...args: unknown[]): boolean
  quit(): void
  on(event: 'will-quit', fn: () => void): unknown
  /** Electron's app.getPath: the jobs' process groups are kept in userData so a crash can't orphan them. */
  getPath?(name: 'userData'): string
}

export function installQuitGuard(app: AppLike, o: {
  jobs: JobManager
  /** No dialog (tests, hidden runs): jobs are just stopped. */
  silent?: boolean
  window: () => BrowserWindow | null
  showMessageBox: (win: BrowserWindow | null, opts: MessageBoxOptions) => Promise<{ response: number }>
  /** Where the running jobs' process groups are kept (default: <userData>/job-groups.json). */
  pidFile?: string
}): void {
  // Jobs a previous launch left running (it crashed or was force-quit) are stopped now.
  let pidFile = o.pidFile
  try { if (!pidFile && app.getPath) pidFile = join(app.getPath('userData'), 'job-groups.json') } catch { /* no userData */ }
  if (pidFile) o.jobs.trackPids(pidFile)
  let confirmed = false
  let asking = false
  const original = app.emit.bind(app)
  app.emit = (event: string | symbol, ...args: unknown[]): boolean => {
    if (event !== 'before-quit' || confirmed) return original(event, ...args)
    const running = o.jobs.running()
    if (!running.length) return original(event, ...args)
    const e = args[0] as { preventDefault?: () => void } | undefined
    e?.preventDefault?.()
    if (asking) return true
    asking = true
    void (async () => {
      let quit = true
      if (!o.silent) {
        const list = running.slice(0, 8).map((j) => `• ${jobLine(j).split('\n')[0]}\n   ${j.command.slice(0, 90)}`).join('\n')
        const r = await o.showMessageBox(o.window(), {
          type: 'warning',
          buttons: ['Stop jobs and quit', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          message: `${running.length} background job${running.length === 1 ? ' is' : 's are'} still running`,
          detail: `Quitting stops ${running.length === 1 ? 'it' : 'them'}:\n\n${list}`
        }).catch(() => ({ response: 0 }))
        quit = r.response === 0
      }
      asking = false
      if (!quit) return
      await o.jobs.stopAll(1500).catch(() => undefined)
      confirmed = true
      app.quit()
    })()
    return true
  }
  // Whatever happens, nothing a chat started outlives the app.
  app.on('will-quit', () => o.jobs.killAllSync())
  process.once('exit', () => o.jobs.killAllSync())
}
