import { execFile } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PermissionKind, PermissionRow, PermissionState } from '@shared/types'

// Settings → Privacy & Security: which macOS permissions SahilBot has, what each one enables, and a
// button that opens the exact System Settings pane. Nothing here grants anything (only the user can, in
// System Settings) and the status checks never show a macOS prompt, except the Automation check, which
// runs only when the user asks about one app.

const PANE = 'x-apple.systempreferences:com.apple.preference.security?'

export const SETTINGS_URL: Record<PermissionKind, string> = {
  accessibility: `${PANE}Privacy_Accessibility`,
  screen: `${PANE}Privacy_ScreenCapture`,
  microphone: `${PANE}Privacy_Microphone`,
  fullDisk: `${PANE}Privacy_AllFiles`,
  automation: `${PANE}Privacy_Automation`,
  notifications: 'x-apple.systempreferences:com.apple.preference.notifications'
}

const INFO: Record<PermissionKind, { title: string; enables: string; how: string }> = {
  accessibility: {
    title: 'Accessibility',
    enables: 'Lets SahilBot read other apps\' buttons and fields and use the mouse and keyboard for you (computer use, app menus, typing into apps).',
    how: 'System Settings → Privacy & Security → Accessibility → turn on SahilBot.'
  },
  screen: {
    title: 'Screen Recording',
    enables: 'Lets SahilBot take screenshots so it can see what\'s on screen while it works, and attach a screenshot to Quick Ask.',
    how: 'System Settings → Privacy & Security → Screen & System Audio Recording → turn on SahilBot, then quit and reopen SahilBot.'
  },
  microphone: {
    title: 'Microphone',
    enables: 'Lets you talk to SahilBot (voice conversations and dictation).',
    how: 'System Settings → Privacy & Security → Microphone → turn on SahilBot.'
  },
  fullDisk: {
    title: 'Full Disk Access',
    enables: 'Lets SahilBot read files macOS protects, like Messages history, Safari bookmarks and Mail, when you ask it to. Optional.',
    how: 'System Settings → Privacy & Security → Full Disk Access → add SahilBot (the + button) and turn it on, then reopen SahilBot.'
  },
  automation: {
    title: 'Automation',
    enables: 'Lets SahilBot control specific apps (Notes, Calendar, Mail, Finder…) through their scripting. macOS asks once per app the first time.',
    how: 'System Settings → Privacy & Security → Automation → under SahilBot, turn on the apps it may control.'
  },
  notifications: {
    title: 'Notifications',
    enables: 'Lets SahilBot tell you when a task finishes or needs you while its window is in the background.',
    how: 'System Settings → Notifications → SahilBot → Allow notifications.'
  }
}

export interface Probes {
  /** systemPreferences.isTrustedAccessibilityClient(false): never prompts. */
  accessibility(): boolean
  /** systemPreferences.getMediaAccessStatus: never prompts. */
  media(kind: 'screen' | 'microphone'): string
  /** Notification.isSupported(). */
  notificationsSupported(): boolean
  /** What macOS last did with one of SahilBot's notifications (NotificationPermission.get): apps can't read the setting itself. */
  notifications?(): PermissionState
  /** Mac apps (Apple events): what SahilBot last learned by asking (requestAutomation), if it has asked. */
  automation?(): PermissionState
  /** Opens a file read-only without reading it: 'ok', 'denied' (EPERM/EACCES), or 'missing'. */
  open(path: string): 'ok' | 'denied' | 'missing'
  home: string
}

/** Files only Full Disk Access can open (the first one that exists decides; none exist → unknown). */
export const FULL_DISK_PROBES = ['Library/Application Support/com.apple.TCC/TCC.db', 'Library/Safari/Bookmarks.plist', 'Library/Messages/chat.db', 'Library/Mail']

export function fileProbe(path: string): 'ok' | 'denied' | 'missing' {
  try {
    closeSync(openSync(path, 'r'))
    return 'ok'
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'EPERM' || code === 'EACCES' ? 'denied' : code === 'EISDIR' ? 'ok' : 'missing'
  }
}

const media = (s: string): PermissionState => (s === 'granted' || s === 'denied' || s === 'not-determined' || s === 'restricted' ? s : 'unknown')

export function fullDiskState(p: Pick<Probes, 'open' | 'home'>): PermissionState {
  for (const rel of FULL_DISK_PROBES) {
    const r = p.open(join(p.home, rel))
    if (r === 'ok') return 'granted'
    if (r === 'denied') return 'denied'
  }
  return 'unknown'
}

const row = (kind: PermissionKind, state: PermissionState, detail?: string): PermissionRow => ({ kind, ...INFO[kind], state, settingsUrl: SETTINGS_URL[kind], ...(detail ? { detail } : {}) })

/** Every permission's status (no prompts). Automation is per app: see automationStatus. */
export function permissionsStatus(p: Probes): PermissionRow[] {
  let notes: PermissionState = 'unknown'
  try { notes = p.notificationsSupported() ? (p.notifications?.() ?? 'unknown') : 'restricted' } catch { /* stays unknown */ }
  return [
    row('accessibility', safe(() => (p.accessibility() ? 'granted' : 'denied'))),
    row('screen', safe(() => media(p.media('screen'))), 'macOS only applies a change after SahilBot is reopened.'),
    row('microphone', safe(() => media(p.media('microphone')))),
    row('fullDisk', safe(() => fullDiskState(p))),
    row('automation', p.automation?.() ?? 'unknown', 'macOS asks once per app the first time SahilBot controls it.'),
    row('notifications', notes, notes === 'unknown' ? 'macOS doesn\'t let apps read this setting: Turn on sends one notification and macOS asks.'
      : notes === 'denied' ? 'macOS didn\'t show SahilBot\'s last notification: turn SahilBot on in System Settings → Notifications.' : undefined)
  ]
}

function safe(f: () => PermissionState): PermissionState {
  try { return f() } catch { return 'unknown' }
}

/** osascript's error for an Apple event the user hasn't allowed (or that's still undecided). */
export function automationError(stderr: string): PermissionState {
  if (/-1743|not authori[sz]ed to send apple events/i.test(stderr)) return 'denied'
  if (/-1744|user interaction (is )?required|would need to be asked/i.test(stderr)) return 'not-determined'
  return 'unknown'
}

/**
 * Whether SahilBot may control one app. Only runs when the user asks (macOS may show its one-time
 * "SahilBot wants to control …" prompt then). An app that isn't running is not launched: 'unknown'.
 */
export function automationStatus(app: string, run: (args: string[]) => Promise<{ out: string; err: string }> = osascript): Promise<{ app: string; state: PermissionState; detail?: string }> {
  const name = JSON.stringify(app)
  const script = `const a = Application(${name}); if (!a.running()) { 'not running' } else { a.name(); 'ok' }`
  return run(['-l', 'JavaScript', '-e', script]).then(({ out, err }) => {
    if (out.trim() === 'ok') return { app, state: 'granted' as PermissionState }
    if (out.trim() === 'not running') return { app, state: 'unknown' as PermissionState, detail: `${app} isn't running; open it and check again.` }
    const state = automationError(err)
    return { app, state, ...(state === 'unknown' ? { detail: err.trim().slice(0, 200) || 'No answer from the app.' } : {}) }
  })
}

/**
 * Mac apps: macOS only lists SahilBot under Privacy & Security → Automation once it has tried to control an
 * app, so opening System Settings first shows nothing to turn on. This asks for real: one harmless Apple event
 * each to System Events and Finder (always running), which makes macOS show its "SahilBot wants to control…"
 * prompt and adds SahilBot to that list. 'granted' when both answer; 'denied' when one was refused (System
 * Settings is where that's changed); 'prompted' while macOS's question is still open.
 */
export async function requestAutomation(run: (args: string[]) => Promise<{ out: string; err: string }> = osascript): Promise<'granted' | 'denied' | 'prompted'> {
  const states: PermissionState[] = []
  for (const app of ['System Events', 'Finder']) {
    const { out, err } = await run(['-l', 'JavaScript', '-e', `Application(${JSON.stringify(app)}).name()`])
    states.push(out.trim() ? 'granted' : automationError(err))
  }
  if (states.every((s) => s === 'granted')) return 'granted'
  if (states.includes('denied')) return 'denied'
  return 'prompted'
}

function osascript(args: string[]): Promise<{ out: string; err: string }> {
  return new Promise((ok) => execFile('osascript', args, { timeout: 15_000 }, (e, out, err) => ok({ out: e ? '' : String(out), err: e ? String(err || e.message) : '' })))
}

/** The parts of Electron's Notification this needs (a fake in tests). */
export interface NoteLike {
  on(event: 'show', listener: () => void): unknown
  on(event: 'failed', listener: (event: unknown, error: string) => void): unknown
  show(): void
}

/**
 * Whether macOS shows SahilBot's notifications. macOS has no way for an app to read the setting, so this
 * remembers what macOS last did with a notification: shown ("granted") or refused ("denied"). The
 * first notification is what makes macOS ask. A notification is kept referenced until macOS answers:
 * Electron removes an unreferenced one from Notification Center when it's garbage collected.
 */
export class NotificationPermission {
  private state: PermissionState = 'unknown'
  private pending = new Set<NoteLike>()

  constructor(private file?: string) {
    try {
      const saved = file ? JSON.parse(readFileSync(file, 'utf8')).state : undefined
      if (saved === 'granted' || saved === 'denied') this.state = saved
    } catch { /* never asked yet */ }
  }

  get(): PermissionState { return this.state }

  private set(state: 'granted' | 'denied'): void {
    if (state === this.state) return
    this.state = state
    if (!this.file) return
    try { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify({ state, at: Date.now() })) } catch { /* kept in memory */ }
  }

  /** Every notification SahilBot shows keeps this up to date (a user can change the setting any time). */
  observe(n: NoteLike): void {
    n.on('show', () => this.set('granted'))
    n.on('failed', () => this.set('denied'))
  }

  /**
   * Shows one notification and waits for macOS: 'granted' once it's shown, 'denied' if macOS refuses
   * it, 'prompted' while macOS's question is still open after `waitMs` (the answer is recorded later).
   */
  request(n: NoteLike, waitMs = 20_000): Promise<'granted' | 'denied' | 'prompted'> {
    this.pending.add(n)
    return new Promise((done) => {
      const timer = setTimeout(() => done('prompted'), waitMs)
      const finish = (state: 'granted' | 'denied'): void => {
        this.set(state)
        clearTimeout(timer)
        // Keep it a little longer so it stays in Notification Center for the user to see.
        setTimeout(() => this.pending.delete(n), 60_000).unref?.()
        done(state)
      }
      n.on('show', () => finish('granted'))
      n.on('failed', () => finish('denied'))
      try { n.show() } catch { finish('denied') }
    })
  }
}

/** The System Settings pane for a permission (only these exact URLs are ever opened). */
export function settingsUrl(kind: string): string {
  const url = SETTINGS_URL[kind as PermissionKind]
  if (!url) throw new Error(`Unknown permission "${kind}".`)
  return url
}
