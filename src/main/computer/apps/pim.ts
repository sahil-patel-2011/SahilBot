import type { AppAction, AppAdapter } from './types'

// Notes, Reminders and Calendar: the same actions the mac_apps tool has (apps.ts), reachable from the app
// tool too so app_help lists every app in one place. Each call is passed straight to mac_apps.

const via = (action: string, summary: string, args: AppAction['args'], effect: 'read' | 'write_local', describe: AppAction['describe']): AppAction => ({
  summary,
  args,
  effect,
  describe,
  async run(a, env) {
    const out = await env.macApps({ action, ...a })
    return { text: out.text, display: out.display }
  }
})

export const notes: AppAdapter = {
  id: 'notes',
  name: 'Notes',
  aliases: ['apple notes'],
  bundleIds: ['com.apple.Notes'],
  paths: ['/System/Applications/Notes.app'],
  blurb: 'search notes, create a note',
  skill: 'computer-use-playbook',
  notes: 'Same as the mac_apps tool (Notes\' scripting). Editing an existing note: computer use.',
  actions: {
    search: via('notes_search', 'Notes whose title or text contains a query', { query: { type: 'string', required: true, description: 'words to find' } }, 'read', (a) => `Search notes for "${a.query}"`),
    create: via('notes_create', 'Create a note', { title: { type: 'string', required: true, description: 'title' }, body: { type: 'string', required: true, description: 'text' } }, 'write_local', (a) => `Create the note "${a.title}"`)
  }
}

export const reminders: AppAdapter = {
  id: 'reminders',
  name: 'Reminders',
  aliases: [],
  bundleIds: ['com.apple.reminders'],
  paths: ['/System/Applications/Reminders.app'],
  blurb: 'list open reminders, add a reminder',
  skill: 'computer-use-playbook',
  notes: 'Same as the mac_apps tool (Reminders\' scripting).',
  actions: {
    list: via('reminders_list', 'Open reminders (in one list, or all)', { list: { type: 'string', description: 'list name' } }, 'read', () => 'List reminders'),
    add: via('reminders_add', 'Add a reminder', { title: { type: 'string', required: true, description: 'what' }, due: { type: 'string', description: 'ISO date-time' }, list: { type: 'string', description: 'list name' }, body: { type: 'string', description: 'notes' } }, 'write_local', (a) => `Add the reminder "${a.title}"${a.due ? ` due ${a.due}` : ''}`)
  }
}

export const calendar: AppAdapter = {
  id: 'calendar',
  name: 'Calendar',
  aliases: ['ical', 'apple calendar'],
  bundleIds: ['com.apple.iCal'],
  paths: ['/System/Applications/Calendar.app'],
  blurb: 'upcoming events, add an event (no invitees)',
  skill: 'computer-use-playbook',
  notes: 'Same as the mac_apps tool (Calendar\'s scripting). Inviting people sends email: do that with computer use only after the user says yes.',
  actions: {
    events: via('calendar_events', 'Upcoming events', { days: { type: 'number', description: 'how many days ahead (default 7)' } }, 'read', () => 'List upcoming events'),
    add: via('calendar_add', 'Add an event to the user\'s own calendar', { title: { type: 'string', required: true, description: 'what' }, start: { type: 'string', required: true, description: 'ISO date-time' }, end: { type: 'string', description: 'ISO date-time' }, calendar: { type: 'string', description: 'calendar name' } }, 'write_local', (a) => `Add "${a.title}" at ${a.start} to Calendar`)
  }
}
