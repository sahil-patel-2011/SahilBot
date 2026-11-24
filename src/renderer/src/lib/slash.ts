// Slash commands in the message box: type "/" for the list, keep typing to filter, ↑↓ to choose, Enter or
// Tab to run, Esc to close. Each one runs something the app can already do (App.tsx handles the
// "sahilbot:command" event; the composer handles its own modes).

export interface SlashCommand { id: string; name: string; hint: string; keys: string; /** Text it leaves in the box (e.g. "/plan " stays as a mode). */ keepsText?: boolean }

export const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'new', name: '/new', hint: 'Start a new chat', keys: 'new chat clear fresh reset' },
  { id: 'doc', name: '/doc', hint: 'A document you and SahilBot edit together', keys: 'doc document report letter write' },
  { id: 'deck', name: '/deck', hint: 'A slide deck in the slide editor', keys: 'deck slides presentation pptx powerpoint keynote' },
  { id: 'dashboard', name: '/dashboard', hint: 'A dashboard with numbers and charts', keys: 'dashboard kpi chart metrics scorecard' },
  { id: 'sheet', name: '/sheet', hint: 'A spreadsheet with formulas', keys: 'sheet spreadsheet table excel budget' },
  { id: 'research', name: '/research', hint: 'Deep research for the next message', keys: 'research deep sources search' },
  { id: 'max', name: '/max', hint: 'Max: several agents for the next message', keys: 'max swarm team agents' },
  { id: 'plan', name: '/plan', hint: 'Plan first, then ask before doing it', keys: 'plan think steps', keepsText: true },
  { id: 'voice', name: '/voice', hint: 'Talk with your bot', keys: 'voice talk speak call' },
  { id: 'artifacts', name: '/artifacts', hint: 'Open Artifacts: documents, decks, files', keys: 'artifacts files documents' },
  { id: 'settings', name: '/settings', hint: 'Open Settings', keys: 'settings preferences options config' },
  { id: 'whatsnew', name: '/whatsnew', hint: "What's new in this version", keys: 'whats new release notes changelog update version' }
]

/** The commands matching what's typed ("/de" → /deck…), or [] when the box isn't a bare "/word". */
export function slashMatches(text: string): SlashCommand[] {
  const m = /^\/([a-z]*)$/i.exec(text)
  if (!m) return []
  const q = m[1].toLowerCase()
  if (!q) return SLASH_COMMANDS
  const starts = SLASH_COMMANDS.filter((c) => c.name.slice(1).startsWith(q))
  const rest = SLASH_COMMANDS.filter((c) => !starts.includes(c) && c.keys.split(' ').some((k) => k.startsWith(q)))
  return [...starts, ...rest]
}
