import { AX_TEXT, axTextInput, formatAxText, type AxTextResult } from './ax-text'
import type { AppAdapter } from './types'

// System Settings: open a pane straight from its address (x-apple.systempreferences:) and read what it
// shows. There is deliberately no action that changes a setting: changes go through computer use, where
// every click, key or value on a security or privacy pane is a hard stop the user approves (computer.ts
// settingsStop), and SahilBot never grants permissions to itself.

const P = 'x-apple.systempreferences:'
const PRIV = `${P}com.apple.preference.security?`

/** Pane names (and common ways people say them) → their address. */
export const PANES: Record<string, string> = {
  'wi-fi': `${P}com.apple.wifi-settings-extension`,
  bluetooth: `${P}com.apple.BluetoothSettings`,
  network: `${P}com.apple.Network-Settings.extension`,
  vpn: `${P}com.apple.NetworkExtensionSettingsUI.NESettingsUIExtension`,
  notifications: `${P}com.apple.Notifications-Settings.extension`,
  sound: `${P}com.apple.Sound-Settings.extension`,
  focus: `${P}com.apple.Focus-Settings.extension`,
  'screen time': `${P}com.apple.Screen-Time-Settings.extension`,
  general: `${P}com.apple.systempreferences.GeneralSettings`,
  about: `${P}com.apple.SystemProfiler.AboutExtension`,
  'software update': `${P}com.apple.Software-Update-Settings.extension`,
  storage: `${P}com.apple.settings.Storage`,
  'airdrop & handoff': `${P}com.apple.AirDrop-Handoff-Settings.extension`,
  'login items': `${P}com.apple.LoginItems-Settings.extension`,
  'language & region': `${P}com.apple.Localization-Settings.extension`,
  'date & time': `${P}com.apple.Date-Time-Settings.extension`,
  sharing: `${P}com.apple.Sharing-Settings.extension`,
  'time machine': `${P}com.apple.Time-Machine-Settings.extension`,
  'startup disk': `${P}com.apple.Startup-Disk-Settings.extension`,
  appearance: `${P}com.apple.Appearance-Settings.extension`,
  accessibility: `${P}com.apple.Accessibility-Settings.extension`,
  'control center': `${P}com.apple.ControlCenter-Settings.extension`,
  siri: `${P}com.apple.Siri-Settings.extension`,
  'desktop & dock': `${P}com.apple.Desktop-Settings.extension`,
  displays: `${P}com.apple.Displays-Settings.extension`,
  wallpaper: `${P}com.apple.Wallpaper-Settings.extension`,
  'screen saver': `${P}com.apple.ScreenSaver-Settings.extension`,
  battery: `${P}com.apple.Battery-Settings.extension`,
  'lock screen': `${P}com.apple.Lock-Screen-Settings.extension`,
  'touch id & password': `${P}com.apple.Touch-ID-Settings.extension`,
  'users & groups': `${P}com.apple.Users-Groups-Settings.extension`,
  passwords: `${P}com.apple.Passwords-Settings.extension`,
  'internet accounts': `${P}com.apple.Internet-Accounts-Settings.extension`,
  keyboard: `${P}com.apple.Keyboard-Settings.extension`,
  trackpad: `${P}com.apple.Trackpad-Settings.extension`,
  mouse: `${P}com.apple.Mouse-Settings.extension`,
  'printers & scanners': `${P}com.apple.Print-Scan-Settings.extension`,
  'privacy & security': `${P}com.apple.settings.PrivacySecurity.extension`,
  'privacy: accessibility': `${PRIV}Privacy_Accessibility`,
  'privacy: screen recording': `${PRIV}Privacy_ScreenCapture`,
  'privacy: automation': `${PRIV}Privacy_Automation`,
  'privacy: full disk access': `${PRIV}Privacy_AllFiles`,
  'privacy: microphone': `${PRIV}Privacy_Microphone`,
  'privacy: camera': `${PRIV}Privacy_Camera`,
  'privacy: location services': `${PRIV}Privacy_LocationServices`,
  'privacy: contacts': `${PRIV}Privacy_Contacts`,
  'privacy: calendars': `${PRIV}Privacy_Calendars`,
  'privacy: reminders': `${PRIV}Privacy_Reminders`,
  'privacy: photos': `${PRIV}Privacy_Photos`,
  'privacy: input monitoring': `${PRIV}Privacy_ListenEvent`,
  'privacy: files and folders': `${PRIV}Privacy_FilesAndFolders`,
  'privacy: developer tools': `${PRIV}Privacy_DevTools`,
  'privacy: app management': `${PRIV}Privacy_AppBundles`,
  firewall: `${PRIV}Firewall`,
  filevault: `${PRIV}FileVault`
}

const ALIASES: Record<string, string> = {
  wifi: 'wi-fi', 'wi fi': 'wi-fi', 'screen recording': 'privacy: screen recording', 'screen capture': 'privacy: screen recording', automation: 'privacy: automation',
  'full disk access': 'privacy: full disk access', microphone: 'privacy: microphone', camera: 'privacy: camera', location: 'privacy: location services',
  'location services': 'privacy: location services', 'input monitoring': 'privacy: input monitoring', 'accessibility permissions': 'privacy: accessibility',
  'accessibility permission': 'privacy: accessibility', privacy: 'privacy & security', security: 'privacy & security', 'touch id': 'touch id & password',
  users: 'users & groups', dock: 'desktop & dock', desktop: 'desktop & dock', printers: 'printers & scanners', language: 'language & region',
  'date and time': 'date & time', time: 'date & time', updates: 'software update', update: 'software update', 'dark mode': 'appearance', display: 'displays',
  monitor: 'displays', volume: 'sound', 'do not disturb': 'focus', airdrop: 'airdrop & handoff', handoff: 'airdrop & handoff', 'startup items': 'login items'
}

/** A pane by name ("Screen Recording", "wifi", "privacy: camera") → its name and address. */
export function paneUrl(name: string): { pane: string; url: string } {
  const k = String(name).trim().toLowerCase().replace(/\s+/g, ' ').replace(/ and /g, ' & ')
  const key = PANES[k] ? k : ALIASES[k] ?? ALIASES[k.replace(/ & /g, ' and ')] ?? Object.keys(PANES).find((p) => p.replace(/^privacy: /, '') === k) ?? Object.keys(PANES).find((p) => p.includes(k))
  if (!key || !PANES[key]) throw new Error(`No System Settings pane "${name}". Panes: ${Object.keys(PANES).join(', ')}.`)
  return { pane: key, url: PANES[key] }
}

export const systemSettings: AppAdapter = {
  id: 'system_settings',
  name: 'System Settings',
  aliases: ['system preferences', 'settings', 'preferences', 'system settings'],
  bundleIds: ['com.apple.systempreferences'],
  paths: ['/System/Applications/System Settings.app', '/System/Applications/System Preferences.app'],
  blurb: 'open a pane, read what it shows (changes: computer use; security panes always ask)',
  skill: 'app-system-settings',
  notes: 'Opens panes by address and reads them through Accessibility. Changing a setting is done with computer use (ui refs, then click_ref / set_value); on security and privacy panes every change is a hard stop the user approves. Never grant SahilBot (or any app) a permission: open the pane and let the user flip it.',
  actions: {
    open_pane: {
      summary: 'Open a pane by name (e.g. "Displays", "Wi-Fi", "privacy: screen recording")',
      args: { pane: { type: 'string', required: true, description: 'pane name; list_panes lists them' } },
      effect: 'write_local',
      describe: (a) => `Open System Settings → ${a.pane}`,
      async run(a, env) {
        const p = paneUrl(a.pane)
        await env.sh('open', [p.url])
        return { text: `Opened System Settings → ${p.pane}. Read it with read_pane (or computer ui {app:"System Settings"}).${/privacy|security|filevault|firewall|password|touch id|users/.test(p.pane) ? ' This is a security pane: any change there is the user\'s to approve.' : ''}`, display: `opened ${p.pane}` }
      }
    },
    read_pane: {
      summary: 'The text and controls of the pane that is open',
      effect: 'read',
      needsRunning: true,
      describe: () => 'Read the open System Settings pane',
      async run(_a, env) {
        const r = await env.jxa<AxTextResult>(AX_TEXT, axTextInput('System Settings', { max: 700 }), 45_000)
        if (r.error) throw new Error(r.error === 'not running' ? 'System Settings isn\'t open. Open a pane first (open_pane).' : r.error)
        return { text: formatAxText(r), display: 'read System Settings' }
      }
    },
    list_panes: {
      summary: 'The panes open_pane knows',
      effect: 'read',
      describe: () => 'List System Settings panes',
      async run() {
        return { text: Object.keys(PANES).join(', '), display: `${Object.keys(PANES).length} panes` }
      }
    }
  }
}
