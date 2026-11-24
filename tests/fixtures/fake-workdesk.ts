import { execSync } from 'node:child_process'
import type { ToolDef } from '../../src/main/agent/types'

// A desk of work for the real-work eval (tests/eval): an inbox, drafts and sent mail, a calendar, contacts,
// the web (canned search results and pages) and a ticket list. Everything is in memory and every action is
// recorded, so a job is graded on what actually changed, not on what the agent says it did.

export interface Email { id: string; from: string; to: string; subject: string; body: string; date: string }
export interface Draft { to: string; subject: string; body: string }
export interface CalEvent { id: string; title: string; start: string; end: string; attendees?: string[] }
export interface Contact { name: string; email: string }
export interface Page { url: string; title: string; text: string; date?: string }

export interface Desk {
  emails: Email[]
  drafts: Draft[]
  sent: Draft[]
  events: CalEvent[]
  deleted: CalEvent[]
  contacts: Contact[]
  /** Search results by keyword: a query matching a key (case-insensitive substring) returns its pages. */
  search: Record<string, Page[]>
  pages: Page[]
  /** Paged list (cursor pagination): each page of ticket ids. */
  tickets?: string[][]
  log: string[]
}

export function newDesk(seed: Partial<Desk> = {}): Desk {
  return { emails: [], drafts: [], sent: [], events: [], deleted: [], contacts: [], search: {}, pages: [], log: [], ...seed }
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const str = (description: string) => ({ type: 'string', description })

/** The desk as tools, described the way a real app's tools are, so a real model can use them unprompted. */
export function deskTools(desk: Desk, opts: { commandsIn?: string } = {}): ToolDef[] {
  const tools: ToolDef[] = [
    {
      name: 'mail_search', label: 'Search mail', effect: 'read', core: true,
      description: 'Search the user\'s email inbox. Returns matching messages (id, from, subject, date, first line). Empty query lists the newest.',
      parameters: obj({ query: str('Words to match in sender, subject or body') }),
      async run(a: { query?: string }) {
        const q = (a.query ?? '').toLowerCase()
        const hits = desk.emails.filter((e) => !q || `${e.from} ${e.subject} ${e.body}`.toLowerCase().includes(q))
        desk.log.push(`mail_search:${q}`)
        return { text: hits.length ? hits.map((e) => `${e.id} | ${e.date} | from ${e.from} | ${e.subject} | ${e.body.split('\n')[0].slice(0, 100)}`).join('\n') : 'No messages match.' }
      }
    } as ToolDef,
    {
      name: 'mail_read', label: 'Read email', effect: 'read', core: true,
      description: 'Read one email in full by its id (from mail_search).',
      parameters: obj({ id: str('The message id') }, ['id']),
      async run(a: { id: string }) {
        const e = desk.emails.find((x) => x.id === a.id)
        desk.log.push(`mail_read:${a.id}`)
        return { text: e ? `From: ${e.from}\nTo: ${e.to}\nDate: ${e.date}\nSubject: ${e.subject}\n\n${e.body}` : `No message ${a.id}.` }
      }
    } as ToolDef,
    {
      name: 'create_draft', label: 'Draft email', effect: 'write_local', core: true,
      description: 'Save an email draft in the user\'s Drafts (not sent). Use this unless the user explicitly asked you to send.',
      parameters: obj({ to: str('Recipient email address'), subject: str('Subject'), body: str('Body text') }, ['to', 'subject', 'body']),
      async run(a: Draft) {
        desk.drafts.push({ to: a.to, subject: a.subject, body: a.body })
        desk.log.push(`create_draft:${a.to}`)
        return { text: `Draft saved to Drafts: "${a.subject}" to ${a.to}.` }
      }
    } as ToolDef,
    {
      name: 'send_email', label: 'Send email', effect: 'write_external', core: true,
      description: 'Send an email now as the user. Only when the user asked to send.',
      parameters: obj({ to: str('Recipient email address'), subject: str('Subject'), body: str('Body text') }, ['to', 'subject', 'body']),
      async run(a: Draft) {
        desk.sent.push({ to: a.to, subject: a.subject, body: a.body })
        desk.log.push(`send_email:${a.to}`)
        return { text: `Sent "${a.subject}" to ${a.to}.` }
      }
    } as ToolDef,
    {
      name: 'calendar_list', label: 'Calendar', effect: 'read', core: true,
      description: 'List the user\'s calendar events between two ISO dates (inclusive). Times are local, ISO format.',
      parameters: obj({ from: str('Start date, YYYY-MM-DD'), to: str('End date, YYYY-MM-DD') }),
      async run(a: { from?: string; to?: string }) {
        const ev = desk.events.filter((e) => (!a.from || e.start.slice(0, 10) >= a.from) && (!a.to || e.start.slice(0, 10) <= a.to)).sort((x, y) => x.start.localeCompare(y.start))
        desk.log.push(`calendar_list:${a.from ?? ''}..${a.to ?? ''}`)
        return { text: ev.length ? ev.map((e) => `${e.id} | ${e.start} – ${e.end} | ${e.title}${e.attendees?.length ? ` | with ${e.attendees.join(', ')}` : ''}`).join('\n') : 'No events.' }
      }
    } as ToolDef,
    {
      name: 'create_event', label: 'Add event', effect: 'write_local', core: true,
      description: 'Add an event to the user\'s own calendar. start and end are local ISO date-times (YYYY-MM-DDTHH:MM).',
      parameters: obj({ title: str('Event title'), start: str('Start, YYYY-MM-DDTHH:MM'), end: str('End, YYYY-MM-DDTHH:MM'), attendees: { type: 'array', items: { type: 'string' } } }, ['title', 'start', 'end']),
      async run(a: { title: string; start: string; end: string; attendees?: string[] }) {
        const e = { id: `ev${desk.events.length + desk.deleted.length + 1}`, title: a.title, start: a.start, end: a.end, ...(a.attendees ? { attendees: a.attendees } : {}) }
        desk.events.push(e)
        desk.log.push(`create_event:${a.start}`)
        return { text: `Added "${a.title}" ${a.start} – ${a.end} (${e.id}).` }
      }
    } as ToolDef,
    {
      name: 'delete_event', label: 'Delete event', effect: 'destructive', core: true,
      description: 'Delete an event from the user\'s calendar by id.',
      parameters: obj({ id: str('Event id from calendar_list') }, ['id']),
      async run(a: { id: string }) {
        const i = desk.events.findIndex((e) => e.id === a.id)
        if (i < 0) return { text: `No event ${a.id}.` }
        desk.deleted.push(...desk.events.splice(i, 1))
        desk.log.push(`delete_event:${a.id}`)
        return { text: `Deleted ${a.id}.` }
      }
    } as ToolDef,
    {
      name: 'contacts_lookup', label: 'Contacts', effect: 'read', core: true,
      description: 'Look up a person in the user\'s contacts by name. Returns their email address.',
      parameters: obj({ name: str('Name or part of it') }, ['name']),
      async run(a: { name: string }) {
        const hits = desk.contacts.filter((c) => c.name.toLowerCase().includes(a.name.toLowerCase()))
        desk.log.push(`contacts_lookup:${a.name}`)
        return { text: hits.length ? hits.map((c) => `${c.name} <${c.email}>`).join('\n') : `No contact matches "${a.name}".` }
      }
    } as ToolDef,
    {
      name: 'web_search', label: 'Web search', effect: 'read', core: true,
      description: 'Search the web. Returns results with title, URL, date and a snippet. Open a result with fetch_page for details.',
      parameters: obj({ query: str('Search query') }, ['query']),
      async run(a: { query: string }) {
        const q = a.query.toLowerCase()
        const key = Object.keys(desk.search).find((k) => q.includes(k.toLowerCase()) || k.toLowerCase().split(/\s+/).every((w) => q.includes(w)))
        const hits = key ? desk.search[key] : []
        desk.log.push(`web_search:${a.query}`)
        return { text: hits.length ? hits.map((p, i) => `[${i + 1}] ${p.title}\n${p.url}${p.date ? ` (${p.date})` : ''}\n${p.text.slice(0, 160)}`).join('\n\n') : 'No results.' }
      }
    } as ToolDef,
    {
      name: 'fetch_page', label: 'Open page', effect: 'read', core: true,
      description: 'Open a web page by URL and return its text.',
      parameters: obj({ url: str('Full URL') }, ['url']),
      async run(a: { url: string }) {
        const p = desk.pages.find((x) => x.url === a.url) ?? Object.values(desk.search).flat().find((x) => x.url === a.url)
        desk.log.push(`fetch_page:${a.url}`)
        return { text: p ? `${p.title}${p.date ? ` (${p.date})` : ''}\n\n${p.text}` : `Could not open ${a.url} (404).` }
      }
    } as ToolDef
  ]
  if (desk.tickets) {
    tools.push({
      name: 'list_tickets', label: 'Support tickets', effect: 'read', core: true,
      description: 'List open support tickets, one page at a time. A page ends with next_cursor=… when there are more; pass it as cursor.',
      parameters: obj({ cursor: str('Cursor from the previous page') }),
      async run(a: { cursor?: string }) {
        const i = a.cursor ? Number(a.cursor.replace('p', '')) : 0
        const page = desk.tickets![i] ?? []
        desk.log.push(`list_tickets:${i}`)
        return { text: `${page.join(', ')}\n${i + 1 < desk.tickets!.length ? `next_cursor=p${i + 1}` : 'No more pages.'}` }
      }
    } as ToolDef)
  }
  if (opts.commandsIn) {
    const cwd = opts.commandsIn
    tools.push({
      name: 'run_command', label: 'Run command', effect: 'write_local', core: true,
      description: 'Run a shell command in the project folder (for example npm test) and return its output and exit code.',
      parameters: obj({ command: str('The command line') }, ['command']),
      async run(a: { command: string }) {
        desk.log.push(`run_command:${a.command}`)
        try {
          const out = execSync(a.command, { cwd, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] })
          return { text: `exit 0\n${out.slice(-3000)}` }
        } catch (e) {
          const x = e as { status?: number; stdout?: string; stderr?: string }
          return { text: `exit ${x.status ?? 1}\n${(x.stdout ?? '').slice(-1500)}\n${(x.stderr ?? '').slice(-1500)}` }
        }
      }
    } as ToolDef)
  }
  return tools
}
