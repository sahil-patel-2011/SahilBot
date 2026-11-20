// Where this main process runs: the Mac app (Electron) or SahilBot Server (headless Node, src/server).

export type Runtime = 'electron' | 'server'

export const runtime = (): Runtime => (process.env.SAHILBOT_RUNTIME === 'server' ? 'server' : 'electron')
export const isServer = (): boolean => runtime() === 'server'

/**
 * Tools that need a Mac with a screen (or Electron's browser engine): not registered on SahilBot Server.
 * The text is what the model is told when it looks for one.
 */
export const SERVER_UNAVAILABLE_TOOLS: Record<string, string> = {
  computer: 'computer use (seeing and controlling a screen)',
  checkpoint: 'computer use (seeing and controlling a screen)',
  mac_apps: 'Mac apps (Notes, Reminders, Calendar, Contacts through AppleScript)',
  app: 'Mac apps (Finder, Office, iWork, Messages and others through their scripting)',
  app_help: 'Mac apps (Finder, Office, iWork, Messages and others through their scripting)',
  mail: 'Apple Mail'
}

/** Whether a tool is left out here. */
export const toolUnavailable = (name: string): boolean => isServer() && name in SERVER_UNAVAILABLE_TOOLS

/** What find_tools adds when nothing matched on the server: what isn't available here, and what to use. */
export function serverToolsNote(): string {
  if (!isServer()) return ''
  const missing = [...new Set(Object.values(SERVER_UNAVAILABLE_TOOLS))].join('; ')
  return ` This is SahilBot Server (always on, no screen): not available here: ${missing}. The browser tool only reads public text pages. Use connected apps (Gmail, Calendar, Drive and others) for accounts, and files and run_command for local work. Visual or signed-in browser interactions need the Mac app.`
}
