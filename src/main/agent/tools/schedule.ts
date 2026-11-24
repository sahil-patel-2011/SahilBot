import type { Schedule } from '@shared/types'
import type { Db } from '../../db'
import { nextLabel } from '@shared/when'
import { describeSchedule, validTz, type Scheduler } from '../../scheduler'
import { reminderPrompt } from '../../triggers'
import type { ToolDef } from '../types'

/** `when` as the model sends it: a schedule, where a one-off may say how far away it is instead of a clock time. */
type When = Schedule & { in_minutes?: number }
type Args = { action: 'create' | 'list' | 'update' | 'delete' | 'pause' | 'resume'; title?: string; prompt?: string; remind?: string; when?: When; id?: string }

/** Reminders and recurring tasks. Runs happen unattended: anything needing approval is skipped and reported. */
/** Connected sources by kind, for "when …" routines (only what SahilBot reads can set one off). */
export type SourceKinds = () => { kind: string; name: string; on: boolean }[]
/** The reading behind "when …" routines is off (the Brain is paused). */
export type ReadsPaused = () => boolean

export function scheduleTool(scheduler: Scheduler, db: Db, sources?: SourceKinds, readsPaused?: ReadsPaused): ToolDef<Args> {
  return {
    name: 'schedule',
    label: 'Schedule',
    group: 'Schedule',
    effect: (a) => (a.action === 'list' ? 'read' : a.action === 'create' ? 'write_external' : 'write_local'),
    // Creating a schedule is routine, but if its instructions came from a web page or email, Auto asks.
    consequential: () => false,
    // Setting a routine up spends nothing and deletes nothing ("Pay rent" is a reminder); its run is checked when it acts.
    deferred: true,
    describe: (a) => (a.action === 'create' && a.when ? `Schedule "${a.title}" ${(() => { try { return describeSchedule(resolveWhen(a.when)) } catch { return '' } })()}`.trim() : `${a.action} scheduled task ${a.id ?? ''}`),
    description: `Reminders and recurring tasks that run on their own later (in this bot's chat).
- create {title, remind, when} for a plain reminder that needs no work from you ("remind me in 3 minutes to stretch" → title "Stretch", remind "Stretch"): it is posted to the user as it is, exactly on time, even while you're busy.
- create {title, prompt, when} for work: prompt is the instruction you will receive when it runs, written so it stands alone ("Check my inbox for invoices and summarize them").
  when is one of: {type:"once", in_minutes:3} for "in N minutes/hours" (never work out the clock time yourself), {type:"once", at:"2026-11-12T09:00"} (local time), {type:"daily", time:"09:00"}, {type:"weekly", days:["mon","thu"], time:"08:30"}, {type:"every", minutes:60}, {type:"cron", expr:"0 9 * * 1-5"},
  or an event: {type:"when", kind:"email"|"chat"|"calendar"|"any", from?:"vendor.com", contains?:"invoice, receipt"} runs it each time something new arrives that matches (from = sender name or address part; contains = any of these words in the subject or body). The item is handed to you as outside content when it runs.
  Times are the user's clock unless they tie it to a place: "every weekday at 7:30 send me the Atlanta weather" is 7:30 in Atlanta, so add tz:"America/New_York" (the IANA zone of that place). Moving it later keeps that zone.
- update {id, and any of title, prompt, remind, when}: change a routine in place ("move it to 9:10 and add Saturdays", "snooze it 10 minutes" → when {type:"once", in_minutes:10}); its history is kept.
- list, delete {id}, pause {id}, resume {id}.
Scheduled runs can't ask for approval: actions that would need it are skipped and reported.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'update', 'delete', 'pause', 'resume'] },
        title: { type: 'string', maxLength: 80 },
        prompt: { type: 'string', maxLength: 8000 },
        remind: { type: 'string', maxLength: 200, description: 'The words of a plain reminder to the user ("Stretch"); use it instead of prompt when it needs no work from you' },
        id: { type: 'string' },
        when: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['once', 'daily', 'weekly', 'every', 'cron', 'when'] },
            kind: { type: 'string', enum: ['email', 'chat', 'calendar', 'meetings', 'crm', 'docs', 'accounting', 'any'] },
            from: { type: 'string', maxLength: 200 }, contains: { type: 'string', maxLength: 200 },
            at: { type: 'string' }, in_minutes: { type: 'integer', minimum: 1, maximum: 525600, description: 'For a one-off "in N minutes": how many minutes from now' }, time: { type: 'string', pattern: '^\\d{1,2}:\\d{2}$' },
            days: { type: 'array', items: { type: 'string' } }, minutes: { type: 'integer', minimum: 1 }, expr: { type: 'string' },
            tz: { type: 'string', description: 'IANA time zone of the place the user named ("Atlanta weather at 7:30" → "America/New_York"); omit for the Mac\'s own clock' }
          },
          required: ['type']
        }
      },
      required: ['action'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { action: { const: 'create' } } }, then: { required: ['title', 'when'] } },
        { if: { properties: { action: { enum: ['update', 'delete', 'pause', 'resume'] } } }, then: { required: ['id'] } }
      ]
    },
    async run(a, ctx) {
      const thread = db.getThread(ctx.threadId)
      if (a.action === 'create') {
        // SahilBot's routines run in the chat that made them; other bots have one conversation anyway.
        const prompt = a.remind?.trim() ? reminderPrompt(a.remind) : a.prompt?.trim() ? a.prompt : undefined
        if (!prompt) throw new Error('create needs remind (a plain reminder to the user) or prompt (work you will do when it runs).')
        const asked = resolveWhen(a.when!)
        const when = asked.type === 'when' ? cleanWhen(asked) : withZone(placeZone(asked, `${a.title ?? ''}\n${prompt}`), undefined)
        // An event routine needs a source SahilBot reads (Gmail for email…); without one it would never run.
        let reads = ''
        if (when.type === 'when' && sources) {
          const on = sources().filter((x) => x.on && (when.kind === 'any' || x.kind === when.kind))
          if (!on.length) throw new Error(`Nothing SahilBot reads can set this off: connect ${when.kind === 'email' ? 'your email (Gmail or Outlook)' : when.kind === 'calendar' ? 'your calendar' : when.kind === 'chat' ? 'Slack or your messages' : 'an app'} first (connect_app), then create it again.`)
          if (readsPaused?.()) throw new Error('SahilBot isn\'t reading your apps right now ("Pause the brain" is on), so this would never run. Ask the user to turn the brain back on first.')
          reads = ` It runs each time SahilBot reads ${on.map((x) => x.name).join(', ')} and finds a match (about every 5 minutes while SahilBot is open; at most 20 times a day).`
        }
        const t = scheduler.create({ title: a.title!, prompt, schedule: when, spaceId: thread?.spaceId ?? '', threadId: thread && db.getSpace(thread.spaceId)?.isMain ? thread.id : null })
        if (t.schedule.type === 'when') return { text: `Set up "${t.title}" (${describeSchedule(t.schedule)}), id ${t.id}.${reads}`, display: `"${t.title}" ${describeSchedule(t.schedule)}` }
        return { text: `Scheduled "${t.title}" (${describeSchedule(t.schedule)}), id ${t.id}. Next run: ${runsAt(t.schedule, t.nextRun)}.`, display: `"${t.title}" ${describeSchedule(t.schedule)}` }
      }
      if (a.action === 'list') {
        const ts = scheduler.list()
        if (!ts.length) return { text: 'No scheduled tasks.', display: 'none scheduled' }
        return { text: ts.map((t) => `- [${t.id}] ${t.title}: ${describeSchedule(t.schedule)}${t.enabled ? (t.schedule.type === 'when' ? ', runs when one arrives' : `, next ${t.nextRun ? nextLabel(t.schedule, t.nextRun) : 'never'}`) : ' (paused)'}${t.lastStatus ? `, last: ${t.lastStatus}` : ''}`).join('\n'), display: `${ts.length} scheduled` }
      }
      if (a.action === 'update') {
        if (a.title === undefined && a.prompt === undefined && !a.remind?.trim() && !a.when) throw new Error('update needs at least one of title, prompt, remind or when.')
        // Moving a routine keeps the place's time zone it was set in ("move it to 7" stays Eastern).
        const prevTz = (() => { const c = scheduler.get(a.id!)?.schedule; return c && 'tz' in c ? c.tz : undefined })()
        const asked = a.when ? resolveWhen(a.when) : undefined
        const when = asked ? (asked.type === 'when' ? cleanWhen(asked) : withZone(asked, prevTz)) : undefined
        const prompt = a.remind?.trim() ? reminderPrompt(a.remind) : a.prompt
        // A new time for a one-off that already went off ("snooze it 10 minutes") turns it back on.
        const t = scheduler.update(a.id!, { ...(a.title !== undefined ? { title: a.title } : {}), ...(prompt !== undefined ? { prompt } : {}), ...(when ? { schedule: when } : {}), ...(when?.type === 'once' ? { enabled: true } : {}) })
        return { text: `Updated "${t.title}" (${describeSchedule(t.schedule)}).${t.nextRun ? ` Next run: ${runsAt(t.schedule, t.nextRun)}.` : ''}`, display: `"${t.title}" ${describeSchedule(t.schedule)}` }
      }
      if (a.action === 'delete') {
        scheduler.remove(a.id!)
        return { text: `Deleted scheduled task ${a.id}.`, display: `deleted ${a.id}` }
      }
      const t = scheduler.update(a.id!, { enabled: a.action === 'resume' })
      return { text: `${a.action === 'resume' ? 'Resumed' : 'Paused'} "${t.title}".`, display: `${a.action}d ${t.title}` }
    }
  }
}

/** A "when" schedule as stored: a known kind, short trimmed filters. */
function cleanWhen(w: Extract<Schedule, { type: 'when' }>): Schedule {
  const kinds = ['email', 'chat', 'calendar', 'meetings', 'crm', 'docs', 'accounting', 'any'] as const
  // A missing or unknown kind is an error, never "anything" (that would run on every item).
  if (!(kinds as readonly string[]).includes(w.kind)) throw new Error(`when.kind must be one of ${kinds.join(', ')} ("chat" covers Slack and texts).`)
  const kind = w.kind
  const t = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 200) : undefined)
  const from = t(w.from), contains = t(w.contains)
  return { type: 'when', kind, ...(from ? { from } : {}), ...(contains ? { contains } : {}) }
}

/** A time schedule with a valid place time zone (kept from before when a move doesn't name one); 'every' has none. */
function withZone(w: Schedule, prev: string | undefined): Schedule {
  if (w.type === 'every' || w.type === 'when') return w
  const tz = 'tz' in w && w.tz !== undefined ? w.tz : prev
  const { tz: _drop, ...rest } = w as Schedule & { tz?: string }
  return validTz(tz) ? ({ ...rest, tz } as Schedule) : (rest as Schedule)
}

/**
 * A one-off "in N minutes" (when.in_minutes, or at:"in 3 minutes") as a real moment from now: the model never has to
 * work out the clock time itself (a guess is late, or already past).
 */
export function resolveWhen(w: When, now = Date.now()): Schedule {
  if (w.type !== 'once') { const { in_minutes: _drop, ...other } = w; return other as Schedule }
  const { in_minutes: mins, ...rest } = w
  const rel = typeof rest.at === 'string' ? /^\s*in\s+(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?)\s*$/i.exec(rest.at) : null
  const n = typeof mins === 'number' && mins > 0 ? mins : rel ? Number(rel[1]) * (/^h/i.test(rel[2]) ? 60 : 1) : null
  if (n !== null) return { ...rest, at: new Date(now + Math.round(n * 60_000)).toISOString() }
  if (typeof rest.at !== 'string' || !rest.at.trim()) throw new Error('A one-time reminder needs when.at (a clock time) or when.in_minutes (how far from now).')
  return rest
}

/** "Wed, Nov 25 at 7:30 AM ET", and how far away when it is soon ("Tue, Nov 24 at 3:05 PM, in 3 minutes"). */
function runsAt(s: Schedule, next: number | null): string {
  const label = nextLabel(s, next)
  if (next === null) return label
  const mins = Math.round((next - Date.now()) / 60_000)
  return mins >= 0 && mins < 120 ? `${label}, in ${mins === 0 ? 'under a minute' : `${mins} minute${mins === 1 ? '' : 's'}`}` : label
}

/** Places whose weather, news or traffic a routine sends, by IANA zone ("Atlanta weather at 7:30" is 7:30 Eastern). */
const PLACE_ZONES: Array<[RegExp, string]> = [
  [/\b(atlanta|new york|nyc|manhattan|brooklyn|boston|miami|orlando|tampa|washington,? d\.?c\.?|philadelphia|pittsburgh|detroit|charlotte|raleigh|baltimore)\b/i, 'America/New_York'],
  [/\b(chicago|dallas|houston|austin|san antonio|minneapolis|nashville|new orleans|st\.? louis|kansas city|milwaukee)\b/i, 'America/Chicago'],
  [/\b(denver|salt lake city|boise|albuquerque)\b/i, 'America/Denver'],
  [/\b(phoenix|tucson)\b/i, 'America/Phoenix'],
  [/\b(los angeles|san francisco|seattle|portland|san diego|san jose|las vegas|sacramento)\b/i, 'America/Los_Angeles'],
  [/\b(anchorage)\b/i, 'America/Anchorage'], [/\b(honolulu|hawaii)\b/i, 'Pacific/Honolulu'],
  [/\b(toronto|montreal|ottawa)\b/i, 'America/Toronto'], [/\b(vancouver)\b/i, 'America/Vancouver'],
  [/\b(london)\b/i, 'Europe/London'], [/\b(paris)\b/i, 'Europe/Paris'], [/\b(berlin)\b/i, 'Europe/Berlin'], [/\b(madrid)\b/i, 'Europe/Madrid'], [/\b(rome)\b/i, 'Europe/Rome'],
  [/\b(dubai)\b/i, 'Asia/Dubai'], [/\b(mumbai|delhi|bangalore|bengaluru)\b/i, 'Asia/Kolkata'], [/\b(singapore)\b/i, 'Asia/Singapore'],
  [/\b(tokyo)\b/i, 'Asia/Tokyo'], [/\b(seoul)\b/i, 'Asia/Seoul'], [/\b(sydney|melbourne)\b/i, 'Australia/Sydney']
]

/**
 * A recurring routine about a place's day ("send me the Atlanta weather every weekday at 7:30") that came without a
 * time zone runs on that place's clock. Only for what is clearly about the place (weather, forecast, news, traffic,
 * sunrise), never a reminder or a routine set "my time": "at 9 remind me to call mom in Chicago" stays on the Mac's clock.
 */
export function placeZone(w: Schedule, text: string): Schedule {
  if (w.type !== 'daily' && w.type !== 'weekly' && w.type !== 'cron') return w
  if (w.tz !== undefined) return w
  if (!/\b(weather|forecast|temperature|news|headlines|traffic|sunrise|sunset)\b/i.test(text) || /\b(my (own )?time|local time|my clock|here)\b/i.test(text) || /^⏰\s*Reminder:/im.test(text)) return w
  const hits = PLACE_ZONES.filter(([re]) => re.test(text)).map(([, tz]) => tz)
  // Two places in different zones: no guess.
  return hits.length && hits.every((z) => z === hits[0]) ? { ...w, tz: hits[0] } : w
}
