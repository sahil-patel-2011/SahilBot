import { execFile } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { join } from 'node:path'
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
  try { notes = p.notificationsSupported() ? 'unknown' : 'restricted' } catch { /* stays unknown */ }
  return [
    row('accessibility', safe(() => (p.accessibility() ? 'granted' : 'denied'))),
    row('screen', safe(() => media(p.media('screen'))), 'macOS only applies a change after SahilBot is reopened.'),
    row('microphone', safe(() => media(p.media('microphone')))),
    row('fullDisk', safe(() => fullDiskState(p))),
    row('automation', 'unknown', 'Checked per app: use "Check" next to an app.'),
    row('notifications', notes, notes === 'unknown' ? 'macOS doesn\'t let apps read this setting; open Notifications settings to check.' : undefined)
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

function osascript(args: string[]): Promise<{ out: string; err: string }> {
  return new Promise((ok) => execFile('osascript', args, { timeout: 15_000 }, (e, out, err) => ok({ out: e ? '' : String(out), err: e ? String(err || e.message) : '' })))
}

/** The System Settings pane for a permission (only these exact URLs are ever opened). */
export function settingsUrl(kind: string): string {
  const url = SETTINGS_URL[kind as PermissionKind]
  if (!url) throw new Error(`Unknown permission "${kind}".`)
  return url
}
