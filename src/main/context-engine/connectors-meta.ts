import { calendarFacts, parseAddressList, parseCalendarJson, type ExtractedFact } from '../learning/extract-entities'
import { parseGmailSearch } from '../mail/gmail'

// The periodic read of connected apps (on for each connected app unless turned off in the Privacy panel),
// budgeted (a few dozen items, every few hours, inside the idle learning pass). Only metadata is read:
// who emailed the user (sender name and address, subject, date) and calendar events (title, time,
// place, attendees). Email bodies are never fetched here, and nothing read here goes to a model.

export type ToolCall = (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>

export interface MetaSource {
  /** The connector preset (connectors.ts PRESETS id). */
  id: string
  name: string
  /** What the Privacy panel says it reads. */
  what: string
  /** Minimum time between reads. */
  everyMs: number
  read(call: ToolCall, o: { since: number; now: number; limit: number; signal?: AbortSignal }): Promise<ExtractedFact[]>
}

const HOUR = 3_600_000
const iso = (t: number): string => new Date(t).toISOString()

export const META_SOURCES: MetaSource[] = [
  {
    id: 'gmail', name: 'Gmail', what: 'Senders and subjects of recent email (never the message text). Senders become people; each email is an interaction.', everyMs: 6 * HOUR,
    async read(call, o) {
      const days = Math.max(1, Math.min(14, Math.ceil((o.now - o.since) / (24 * HOUR))))
      const text = await call('search_threads', { query: `newer_than:${days}d -in:drafts -in:spam -category:promotions -category:social`, pageSize: Math.min(25, o.limit), view: 'THREAD_VIEW_SUMMARY' }, o.signal)
      const out: ExtractedFact[] = []
      for (const h of parseGmailSearch(text).slice(0, o.limit)) {
        for (const p of parseAddressList(h.from)) {
          out.push({ subject: p, kind: 'attr', key: 'email', value: p.emails![0], trust: 'observed', confidence: 0.75, at: h.at || o.now })
          out.push({ subject: p, kind: 'mention', snippet: `Emailed you${h.subject ? `: “${h.subject.slice(0, 140)}”` : ''}`, trust: 'observed', confidence: 0.7, at: h.at || o.now })
        }
      }
      return out
    }
  },
  {
    id: 'gcal', name: 'Google Calendar', what: 'Upcoming and recent events: title, time, place and attendees. Meetings become events with the people in them.', everyMs: 3 * HOUR,
    async read(call, o) {
      const args = { timeMin: iso(o.now - 7 * 24 * HOUR), timeMax: iso(o.now + 30 * 24 * HOUR), maxResults: Math.min(50, o.limit), singleEvents: true, orderBy: 'startTime' }
      let text = ''
      try { text = await call('list_events', args, o.signal) } catch (e) {
        if (!/no list_events tool/i.test((e as Error).message)) throw e
        text = await call('search_events', { ...args, query: '' }, o.signal)
      }
      return calendarFacts(parseCalendarJson(text).slice(0, o.limit))
    }
  }
]
