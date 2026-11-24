// What a step is doing, in plain words for the one working line ("Reading a file", "Searching the web"), the
// stall note and side answers. Never a path, a command, an id or an internal tool name ("Sb mac apps"): those
// stay in Show work and Developer mode.

type Args = Record<string, unknown>

const APPS: Record<string, string> = {
  gmail: 'Gmail', google: 'Google', gcal: 'Google Calendar', calendar: 'Calendar', drive: 'Google Drive', slack: 'Slack', notion: 'Notion',
  github: 'GitHub', linear: 'Linear', outlook: 'Outlook', dropbox: 'Dropbox', figma: 'Figma', spotify: 'Spotify', todoist: 'Todoist',
  shopify: 'Shopify', stripe: 'Stripe', jira: 'Jira', asana: 'Asana', trello: 'Trello', zoom: 'Zoom', discord: 'Discord', obsidian: 'Obsidian'
}

/** A connected app's name from its MCP server id ("mcp__gmail__search" → "Gmail"); a plain title for others. */
export function appName(server: string): string {
  const s = server.toLowerCase().replace(/^sb[-_ ]?/, '').replace(/[-_]+/g, ' ').trim()
  const known = Object.keys(APPS).find((k) => s === k || s.startsWith(`${k} `) || s.endsWith(` ${k}`))
  if (known) return APPS[known]
  const words = s.split(' ').filter((w) => w && !/^(mcp|server|tools?|api|app|apps|mac|local|sb)$/.test(w))
  return words.length ? words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : 'a connected app'
}

const MAC_APP: Record<string, string> = { reminder: 'Reminders', calendar: 'Calendar', event: 'Calendar', note: 'Notes', contact: 'Contacts', music: 'Music', mail: 'Mail', message: 'Messages' }

/** The step a tool call is doing right now, in plain words. */
export function plainStep(name: string, args: Args = {}): string {
  const a = args
  const s = (k: string): string => String(a[k] ?? '')
  if (name.startsWith('mcp__')) return `Working in ${appName(name.split('__')[1] ?? '')}`
  switch (name) {
    case 'run_command': {
      const c = s('command')
      if (/\b(test|tests|pytest|vitest|jest|mocha|unittest)\b/.test(c)) return 'Testing the work'
      if (/\b(install|pip|brew|npm i|npm ci|yarn add)\b/.test(c)) return 'Installing what it needs'
      if (/^\s*(python3?|node|ruby|bash|sh|zsh|swift|deno|bun)\b/.test(c)) return 'Running the script'
      return 'Running a command'
    }
    case 'code': return s('action') === 'run_tests' ? 'Testing the work' : /edit|patch/.test(s('action')) ? 'Editing the code' : 'Working on the code'
    case 'git': return 'Saving the code changes'
    case 'jobs': return 'Checking on a background job'
    case 'cursor': return 'Working with Cursor'
    case 'freecad': case 'onshape': case 'frc_mech': return 'Working on the design'
    case 'frc_code': return 'Working on the robot code'
    case 'browser': {
      const act = s('action')
      if (act === 'navigate') return 'Opening a page'
      if (act === 'click' || act === 'select') return 'Clicking on the page'
      if (act === 'type' || act === 'fill_form' || act === 'fill_secret') return 'Filling in the page'
      return 'Using the browser'
    }
    case 'computer': return s('action') === 'open_app' && s('app') ? `Opening ${s('app').slice(0, 30)}` : 'Using your Mac'
    case 'mac_apps': { const k = Object.keys(MAC_APP).find((x) => s('action').includes(x)); return k ? `Checking ${MAC_APP[k]}` : 'Using a Mac app' }
    case 'web_search': return 'Searching the web'
    case 'fetch_page': return 'Reading a page'
    case 'research': return 'Searching trusted sources'
    case 'consult': return 'Asking an expert model'
    case 'agents': case 'swarm': case 'max': return 'Working with a team of helpers'
    case 'file_read': case 'read_result': return 'Reading a file'
    case 'file_list': case 'file_search': case 'find_files': return 'Looking through your files'
    case 'file_write': return 'Writing a file'
    case 'file_edit': return 'Editing a file'
    case 'file_manage': return s('op') === 'delete' ? 'Removing a file' : s('op') === 'mkdir' ? 'Making a folder' : 'Organizing files'
    case 'create_document': case 'doc_create': return 'Making the document'
    case 'doc_edit': return 'Editing the document'
    case 'doc_export': return 'Exporting the document'
    case 'create_page': case 'update_page': return 'Building the page'
    case 'generate_image': case 'image': case 'images': return 'Making the image'
    case 'video': case 'generate_video': return 'Making the video'
    case 'memory': return 'Checking what it remembers'
    case 'knowledge_search': return 'Searching your notes and documents'
    case 'todo': return 'Planning'
    case 'verify': return 'Double-checking the work'
    case 'ask_user': return 'Waiting for your answer'
    case 'find_tools': return 'Looking for the right tool'
    case 'schedule': return 'Setting up a routine'
    case 'manage_bot': case 'create_bot': case 'update_bot': return 'Setting up the bot'
    case 'outlook': return /^calendar/.test(s('action')) ? 'Checking your calendar' : 'Checking your email'
    case 'mail': case 'gmail': case 'gmail_imap': case 'email': return 'Checking your email'
    case 'calendar': return 'Checking your calendar'
    case 'api_request': case 'http': return 'Contacting a service'
    case 'undo_changes': return 'Undoing changes'
    case 'chat_history': return 'Looking back at earlier chats'
    case 'message_bot': case 'ask_bot': return 'Asking another bot'
    case 'weather': return 'Checking the weather'
    case 'stocks': case 'stock': return 'Checking the market'
    case 'sites': return 'Checking a site'
    case 'office': return 'Working on the spreadsheet'
    case 'doc_read': case 'review_document': case 'read_document_image': return 'Reading the document'
    case 'transcribe': return 'Transcribing the audio'
    case 'speech': return 'Making the audio'
    case 'maps': return 'Checking the map'
    case 'vault': return 'Using your saved logins'
    case 'batch': return 'Doing several steps'
    case 'connect_app': return 'Connecting the app'
    case 'price_alert': return 'Setting up a price alert'
    case 'propose_plan': return 'Planning'
  }
  if (/^stock_/.test(name)) return 'Checking the market'
  if (/mail/.test(name)) return 'Checking your email'
  if (/calendar/.test(name)) return 'Checking your calendar'
  return 'Working on it'
}

/** A progress line a tool sent that is fine to show as is: no commands, paths, ids or raw output. */
export function plainProgress(text: string, tool?: string): boolean {
  if (tool && /^(run_command|code|git|jobs|cursor|freecad|onshape|frc_code|frc_mech|watchdog)$/.test(tool)) return false
  const t = text.trim()
  if (!t || t.length > 120) return false
  if (/^\$ |[/~][\w.-]+\/|\\[\w.-]+\\|\b[a-f0-9]{8,}\b|\bmcp__|\w+_\w+\(|[{}[\]<>=]|https?:\/\//i.test(t)) return false
  return true
}
